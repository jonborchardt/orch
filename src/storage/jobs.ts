/**
 * Every job mutation goes through here: one immediate transaction that loads the job, checks
 * ownership and revision, applies a pure domain decision, bumps the revision, renews the lease,
 * and appends events. Concurrent CLI processes serialize on SQLite's write lock.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { assertStageOwns } from '../core/artifact-rules.ts';
import { NotFoundError, OwnershipError, UsageError, ValidationError } from '../core/errors.ts';
import {
  assertOwner,
  decideClaim,
  DEFAULT_LEASE_MINUTES,
  leaseExpired,
  leaseUntil,
  newToken,
} from '../core/ownership.ts';
import { stripControl } from '../core/flake.ts';
import { jobArtifactDir } from '../core/paths.ts';
import { DEFAULT_CONFIG } from '../core/roles.ts';
import { SESSION_EVENT, type SessionRef } from '../core/session.ts';
import {
  type Action,
  challengeSpecHash,
  type CiStatus,
  isSpecChallenge,
  looksLikeSpecChallenge,
  now,
  type PrState,
  requiredArtifact,
  RESUMABLE_STATUSES,
  reviewArtifact,
  type Stage,
  type Status,
  TERMINAL_STATUSES,
  transition,
  type Verdict,
  VERDICTS,
} from '../core/workflow.ts';
import { findArtifact, listArtifacts, upsertArtifact, validateArtifact } from './artifacts.ts';
import type { Db, Store } from './client.ts';
import { appendEvent, eventsOfTypes, latestEventsByJob, listEvents } from './events.ts';
import { type Artifact, type Event, type Job, jobs, type Review, reviews } from './schema.ts';

export interface CreateJobInput {
  title: string;
  /** Required and non-blank; optional in the type only so `createJob` can reject it as a usage error. */
  description?: string | null | undefined;
  repo: string;
  repoPath: string;
  issueRef?: string | undefined;
  baseBranch: string;
  maxRounds?: number | undefined;
  maxCiRepairs?: number | undefined;
  actor?: string | undefined;
}

export interface Auth {
  token: string | undefined;
  /** Optimistic concurrency: reject if the job's revision differs. */
  expectRevision?: number | undefined;
  /**
   * Keep the lease through a write that finishes the job, because the same operation writes once
   * more (`orch gh ci` recording `pr.ready`); that last write releases it.
   */
  holdLease?: boolean | undefined;
}

const RELEASED = { ownerSession: null, ownerToken: null, leaseExpiresAt: null } as const;

export function createJob(store: Store, input: CreateJobInput): Job {
  // No job row without a request: checked before the insert and the artifact directory.
  if (!input.description?.trim()) {
    throw new UsageError(
      'A job needs a non-empty description: pass --description "<request>" (or --issue so it can be fetched). Nothing was created.',
    );
  }
  const ts = now();
  const id = `job-${randomBytes(4).toString('hex')}`;
  const job = store.db.transaction(
    (tx) => {
      const row = tx
        .insert(jobs)
        .values({
          id,
          title: input.title,
          description: input.description ?? null,
          repo: input.repo,
          repoPath: input.repoPath,
          issueRef: input.issueRef ?? null,
          baseBranch: input.baseBranch,
          stage: 'spec',
          status: 'pending',
          maxRounds: input.maxRounds ?? DEFAULT_CONFIG.maxRounds,
          maxCiRepairs: input.maxCiRepairs ?? DEFAULT_CONFIG.maxCiRepairs,
          createdAt: ts,
          updatedAt: ts,
        })
        .returning()
        .get();
      appendEvent(
        tx,
        id,
        'job.created',
        { title: input.title, repo: input.repo },
        input.actor ?? null,
        ts,
      );
      return row;
    },
    { behavior: 'immediate' },
  );
  mkdirSync(jobArtifactDir(id, store.paths), { recursive: true });
  return job;
}

export function getJob(db: Db, id: string): Job {
  const job = db.select().from(jobs).where(eq(jobs.id, id)).get();
  if (!job) throw new NotFoundError(`No job with id ${id}`);
  return job;
}

export interface JobFilter {
  repo?: string | undefined;
  status?: Status | undefined;
  stage?: Stage | undefined;
}

export function listJobs(db: Db, filter: JobFilter = {}): Job[] {
  const where = [
    filter.repo ? eq(jobs.repo, filter.repo) : undefined,
    filter.status ? eq(jobs.status, filter.status) : undefined,
    filter.stage ? eq(jobs.stage, filter.stage) : undefined,
  ].filter((c) => c !== undefined);
  // createdAt has millisecond resolution; the implicit rowid breaks ties by insertion order.
  return db
    .select()
    .from(jobs)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(jobs.createdAt), sql`rowid desc`)
    .all();
}

export function listReviews(db: Db, jobId: string): Review[] {
  return db.select().from(reviews).where(eq(reviews.jobId, jobId)).orderBy(reviews.id).all();
}

/** Reviews of several jobs in one query (the dashboard board), grouped by job id. */
export function reviewsByJob(db: Db, jobIds: readonly string[]): Map<string, Review[]> {
  const out = new Map<string, Review[]>(jobIds.map((id) => [id, []]));
  if (jobIds.length === 0) return out;
  const rows = db
    .select()
    .from(reviews)
    .where(inArray(reviews.jobId, [...jobIds]))
    .orderBy(reviews.id)
    .all();
  for (const r of rows) out.get(r.jobId)?.push(r);
  return out;
}

export interface JobDetail {
  job: Job;
  artifacts: Artifact[];
  reviews: Review[];
  events: Event[];
  artifactDir: string;
  /** Ids of the jobs this one replaced. */
  supersedes: string[];
}

export function jobDetail(store: Store, id: string, eventLimit = 20): JobDetail {
  const job = getJob(store.db, id);
  return {
    job,
    artifacts: listArtifacts(store.db, id),
    reviews: listReviews(store.db, id),
    events: listEvents(store.db, id, eventLimit),
    artifactDir: jobArtifactDir(id, store.paths),
    supersedes: predecessorsOf(store.db, id).map((j) => j.id),
  };
}

/** Jobs that record `id` as their replacement. */
export function predecessorsOf(db: Db, id: string): Job[] {
  return db.select().from(jobs).where(eq(jobs.supersededBy, id)).all();
}

/**
 * Record that `by` replaced job `id`. Nothing is deleted or merged: both jobs keep their rows,
 * events, and artifacts. The two must belong to the same repository and must not form a loop.
 */
export function supersedeJob(store: Store, id: string, auth: Auth, by: string): Job {
  return mutate(store, id, auth, (job, tx) => {
    if (by === id) throw new ValidationError('A job cannot supersede itself.');
    const next = getJob(tx, by);
    if (next.repo !== job.repo) {
      throw new ValidationError(`${by} belongs to ${next.repo}; ${id} belongs to ${job.repo}.`);
    }
    for (let cur: Job | undefined = next; cur?.supersededBy;) {
      if (cur.supersededBy === id) {
        throw new ValidationError(`${by} is already superseded by ${id}; refusing a loop.`);
      }
      cur = tx.select().from(jobs).where(eq(jobs.id, cur.supersededBy)).get();
    }
    return {
      patch: { supersededBy: by },
      events: [{ type: 'job.superseded', payload: { by, previous: job.supersededBy } }],
    };
  });
}

/**
 * Archive (or unarchive) a finished job: it only hides the job from the dashboard's default views.
 * Workflow state is untouched; only completed or cancelled jobs qualify.
 */
export function setArchived(
  store: Store,
  id: string,
  auth: Auth,
  archived: boolean,
  reason?: string,
): Job {
  return mutate(store, id, auth, (job, _tx, ts) => {
    if (!TERMINAL_STATUSES.includes(job.status)) {
      throw new ValidationError(`Only a finished job can be archived; ${id} is ${job.status}.`);
    }
    if (archived && job.archivedAt !== null) {
      throw new ValidationError(`${id} is already archived.`);
    }
    if (!archived && job.archivedAt === null) throw new ValidationError(`${id} is not archived.`);
    return archived
      ? { patch: { archivedAt: ts }, events: [{ type: 'job.archived', payload: { reason } }] }
      : {
          patch: { archivedAt: null },
          events: [{ type: 'job.unarchived', payload: { reason, archivedAt: job.archivedAt } }],
        };
  });
}

export interface ClaimOptions {
  session: string;
  leaseMinutes?: number | undefined;
  force?: boolean | undefined;
}

/** Atomically take or renew ownership. A running job whose lease lapsed becomes `interrupted`. */
export function claimJob(
  store: Store,
  id: string,
  opts: ClaimOptions,
): { job: Job; token: string } {
  const minutes = opts.leaseMinutes ?? DEFAULT_LEASE_MINUTES;
  return store.db.transaction(
    (tx) => {
      const ts = now();
      const job = getJob(tx, id);
      const kind = decideClaim(job, opts.session, ts, opts.force);
      // Every claim issues a fresh token, so a second process resuming under the same session
      // name takes the job over instead of sharing it; the earlier holder fails with exit 4.
      const token = newToken();
      const patch: Partial<Job> = {
        ownerSession: opts.session,
        ownerToken: token,
        leaseExpiresAt: leaseUntil(ts, minutes),
        leaseMinutes: minutes,
      };
      const extra: { type: string; payload: Record<string, unknown> }[] = [];
      if (kind === 'reclaim' && job.status === 'running') {
        patch.status = 'interrupted';
        extra.push({
          type: 'job.interrupted',
          payload: { previousSession: job.ownerSession, expired: leaseExpired(job, ts) },
        });
      }
      const updated = apply(
        tx,
        job,
        patch,
        ts,
        [{ type: 'job.claimed', payload: { kind, previousSession: job.ownerSession } }, ...extra],
        opts.session,
      );
      return { job: updated, token };
    },
    { behavior: 'immediate' },
  );
}

export function releaseJob(store: Store, id: string, auth: Auth): Job {
  return mutate(store, id, auth, (job) => ({
    patch: RELEASED,
    events: [{ type: 'job.released', payload: { session: job.ownerSession } }],
  }));
}

export interface TransitionOptions extends Auth {
  to?: Stage | undefined;
  reason?: string | undefined;
  /** See `TransitionContext.mergedByHuman`; only `completeCi` sets it. */
  mergedByHuman?: boolean | undefined;
  /** See `TransitionContext.integration`; only `integrateBase` sets it. */
  integration?: boolean | undefined;
}

export function transitionJob(
  store: Store,
  id: string,
  action: Action,
  opts: TransitionOptions,
): Job {
  return mutate(store, id, opts, (job, tx) => {
    const artifacts = listArtifacts(tx, id);
    const dir = jobArtifactDir(id, store.paths);
    if (action === 'complete') verifyOnDisk(dir, job.stage, job.round, artifacts);
    // Leaving a spec escalation for a later stage relies on the challenge as much as completion.
    const target = opts.to ?? job.returnStage;
    if (
      action === 'resume' &&
      job.stage === 'needs-human' &&
      job.returnStage === 'spec' &&
      target !== 'spec'
    ) {
      verifyOnDisk(dir, 'spec', job.round, artifacts);
    }
    return transition(job, action, {
      artifacts,
      reviews: listReviews(tx, id),
      to: opts.to,
      reason: opts.reason,
      mergedByHuman: opts.mergedByHuman,
      integration: opts.integration,
    });
  });
}

/**
 * A registered row is only evidence while the file still matches it: the stage's required
 * artifact and, in review, the round's files (in spec, the challenges) are re-read before
 * completion counts them.
 */
function verifyOnDisk(dir: string, stage: Stage, round: number, artifacts: Artifact[]): void {
  const required = requiredArtifact(stage, round);
  const prefix = `round-${String(round)}/`;
  for (const a of artifacts) {
    const relevant =
      a.path === required ||
      ((stage === 'review' || stage === 'simplify') && a.path.startsWith(prefix)) ||
      (stage === 'spec' && isSpecChallenge(a.path)) ||
      (stage === 'pr' && a.path === 'decision.md');
    if (!relevant) continue;
    let checked;
    try {
      checked = validateArtifact(dir, a.path);
    } catch (err) {
      throw new ValidationError(`${a.path} no longer verifies: ${(err as Error).message}`);
    }
    if (checked.sha256 !== a.sha256) {
      throw new ValidationError(
        `${a.path} changed on disk since it was registered; register it again (--replace) first.`,
      );
    }
  }
}

/** Claim and, if the job was interrupted/failed/blocked, put it back to `pending`. */
export function resumeJob(
  store: Store,
  id: string,
  opts: ClaimOptions & { to?: Stage | undefined },
): { token: string; detail: JobDetail } {
  const { job, token } = claimJob(store, id, opts);
  const resumable = job.stage === 'needs-human' || RESUMABLE_STATUSES.includes(job.status);
  if (resumable) transitionJob(store, id, 'resume', { token, to: opts.to });
  return { token, detail: jobDetail(store, id) };
}

export interface RegisterOptions extends Auth {
  /** Required to replace an already registered artifact whose content changed. */
  replace?: boolean | undefined;
  /** Worktree HEAD the artifact describes (ops/gates.ts supplies it). */
  head?: string | null | undefined;
}

/**
 * Validate and register an artifact. Re-registering identical content is a no-op; changed
 * content is refused unless `replace` is set, and then recorded as `artifact.replaced` with the
 * previous hash so the history of what was accepted is preserved in the event log.
 */
export function registerArtifact(
  store: Store,
  id: string,
  relPath: string,
  opts: RegisterOptions,
): Artifact {
  return mutateReturning(store, id, opts, (job, tx, ts) => {
    const checked = validateArtifact(jobArtifactDir(id, store.paths), relPath);
    assertStageOwns(checked.path, job.stage, job.round);
    const existing = findArtifact(tx, id, checked.path);
    const head = opts.head ?? null;
    // A spec challenge is bound to the spec.md registered now (core/workflow.ts).
    const specSha256 = looksLikeSpecChallenge(checked.path)
      ? challengeSpecHash(checked.path, listArtifacts(tx, id))
      : null;
    // The commit (or spec) an artifact describes is part of what was registered: re-binding
    // unchanged text to a new one is a replacement too, and leaves the same audit trail.
    const replaced =
      existing !== undefined &&
      (existing.sha256 !== checked.sha256 ||
        existing.head !== head ||
        existing.specSha256 !== specSha256);
    if (replaced && !opts.replace) {
      const what =
        existing.sha256 !== checked.sha256
          ? 'different content'
          : existing.head !== head
            ? 'a different commit'
            : 'a different spec.md';
      throw new ValidationError(
        `${checked.path} is already registered for ${what}; pass --replace to replace it.`,
      );
    }
    const artifact = upsertArtifact(tx, {
      jobId: id,
      stage: job.stage,
      round: job.stage === 'review' || job.stage === 'simplify' ? job.round : null,
      path: checked.path,
      bytes: checked.bytes,
      sha256: checked.sha256,
      marker: checked.marker,
      head,
      specSha256,
      createdAt: ts,
    });
    const payload = {
      path: checked.path,
      stage: job.stage,
      sha256: checked.sha256,
      head,
      ...(specSha256 ? { specSha256 } : {}),
    };
    return {
      patch: {},
      events: [
        replaced
          ? {
              type: 'artifact.replaced',
              payload: { ...payload, previousSha256: existing.sha256, previousHead: existing.head },
            }
          : { type: 'artifact.registered', payload },
      ],
      value: artifact,
    };
  });
}

export interface WorktreeInput extends Auth {
  path: string;
  branch: string;
  /** `created` for a managed worktree, `adopted` for an existing directory. */
  how: 'created' | 'adopted';
  /** Current clone the worktree was made from, when it differs from the recorded one. */
  repoPath?: string | undefined;
}

/** Record a job's worktree and branch. The unique indexes refuse a path or branch in use. */
export function setWorktree(store: Store, id: string, input: WorktreeInput): Job {
  return mutate(store, id, input, (job, tx) => {
    const other = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.worktreePath, input.path), eq(jobs.repo, job.repo)))
      .get();
    if (other && other.id !== id) {
      throw new ValidationError(`Worktree ${input.path} is already assigned to job ${other.id}.`);
    }
    const branchOwner = tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.repo, job.repo), eq(jobs.branch, input.branch)))
      .get();
    if (branchOwner && branchOwner.id !== id) {
      throw new ValidationError(
        `Branch ${input.branch} already belongs to job ${branchOwner.id} in ${job.repo}.`,
      );
    }
    const patch: Partial<Job> = { worktreePath: input.path, branch: input.branch };
    if (input.repoPath) patch.repoPath = input.repoPath;
    return {
      patch,
      events: [
        { type: `worktree.${input.how}`, payload: { path: input.path, branch: input.branch } },
      ],
    };
  });
}

/**
 * Move a job to a new repository identity (the checkout gained or changed its `origin`). The
 * caller has already proven `repoPath` is the directory the job records.
 */
export function setRepo(
  store: Store,
  id: string,
  auth: Auth,
  input: { repo: string; repoPath: string },
): Job {
  return mutate(store, id, auth, (job, tx) => {
    if (job.repo === input.repo) return { patch: {}, events: [] };
    const branchOwner = job.branch
      ? tx
          .select({ id: jobs.id })
          .from(jobs)
          .where(and(eq(jobs.repo, input.repo), eq(jobs.branch, job.branch)))
          .get()
      : undefined;
    if (branchOwner && branchOwner.id !== id) {
      throw new ValidationError(
        `Branch ${job.branch ?? ''} already belongs to job ${branchOwner.id} in ${input.repo}.`,
      );
    }
    return {
      patch: { repo: input.repo, repoPath: input.repoPath },
      events: [{ type: 'repo.repointed', payload: { from: job.repo, to: input.repo } }],
    };
  });
}

/** Forget a worktree after it was removed from disk. The branch stays recorded. */
export function clearWorktree(store: Store, id: string, auth: Auth, reason: string): Job {
  return mutate(store, id, auth, (job) => ({
    patch: { worktreePath: null },
    events: [{ type: 'worktree.removed', payload: { path: job.worktreePath, reason } }],
  }));
}

export interface CiInput extends Auth {
  ciStatus: CiStatus;
  prState?: PrState | undefined;
  /** Commit the verdict was read for. Only `orch gh ci` supplies one; `pr create` and `pr status` pass null. */
  head: string | null;
  /** Further detail for the `ci.observed` event (outcome, checks, diagnostics). */
  detail?: Record<string, unknown> | undefined;
}

/** Record the latest observed PR state and CI rollup (from `orch gh pr status` or `orch gh ci`). */
export function recordCi(store: Store, id: string, input: CiInput): Job {
  return mutate(store, id, input, (job, _tx, ts) => {
    if (!job.prUrl) throw new ValidationError('No PR recorded for this job.');
    const patch: Partial<Job> = { ciStatus: input.ciStatus, ciCheckedAt: ts };
    if (input.prState) patch.prState = input.prState;
    patch.ciHead = input.head;
    return {
      patch,
      events: [
        {
          type: 'ci.observed',
          payload: {
            ciStatus: input.ciStatus,
            prState: input.prState,
            head: input.head,
            ...input.detail,
          },
        },
      ],
    };
  });
}

export interface ReviewInput extends Auth {
  reviewer: string;
  verdict?: Verdict | undefined;
  summary?: string | undefined;
  /** Worktree HEAD the verdict was given against (ops/gates.ts supplies it). */
  head?: string | null | undefined;
}

/**
 * Upsert a reviewer's row for the current round. Without a verdict the reviewer is pending; with
 * one it is read from that reviewer's own file, round-N/review-<reviewer>.md, and must agree.
 */
export function recordReview(store: Store, id: string, input: ReviewInput): Review {
  if (!/^[a-z0-9-]+$/.test(input.reviewer)) {
    throw new ValidationError('Reviewer name must be lowercase letters, digits, or hyphens.');
  }
  if (input.verdict !== undefined && !VERDICTS.includes(input.verdict)) {
    throw new ValidationError(`Verdict must be one of ${VERDICTS.join(', ')}.`);
  }
  return mutateReturning(store, id, input, (job, tx, ts) => {
    if (job.stage !== 'review' || job.status !== 'running') {
      throw new ValidationError('Reviews can only be recorded while the review stage is running.');
    }
    let artifactId: number | null = null;
    if (input.verdict) {
      const rel = reviewArtifact(job.round, input.reviewer);
      const checked = validateArtifact(jobArtifactDir(id, store.paths), rel);
      assertStageOwns(checked.path, job.stage, job.round);
      if (checked.marker !== null && checked.marker !== input.verdict) {
        throw new ValidationError(
          `Verdict ${input.verdict} does not match ${checked.path}, which says VERDICT: ${checked.marker.toUpperCase()}.`,
        );
      }
      artifactId = upsertArtifact(tx, {
        jobId: id,
        stage: 'review',
        round: job.round,
        path: checked.path,
        bytes: checked.bytes,
        sha256: checked.sha256,
        marker: checked.marker,
        head: input.head ?? null,
        specSha256: null,
        createdAt: ts,
      }).id;
    }
    const head = input.verdict ? (input.head ?? null) : null;
    const review = tx
      .insert(reviews)
      .values({
        jobId: id,
        round: job.round,
        reviewer: input.reviewer,
        verdict: input.verdict ?? null,
        artifactId,
        head,
        summary: input.summary ?? null,
        createdAt: ts,
        completedAt: input.verdict ? ts : null,
      })
      .onConflictDoUpdate({
        target: [reviews.jobId, reviews.round, reviews.reviewer],
        set: {
          verdict: input.verdict ?? null,
          artifactId,
          head,
          summary: input.summary ?? null,
          completedAt: input.verdict ? ts : null,
        },
      })
      .returning()
      .get();
    return {
      patch: {},
      events: [
        {
          type: 'review.recorded',
          payload: { round: job.round, reviewer: input.reviewer, verdict: input.verdict ?? null },
        },
      ],
      value: review,
    };
  });
}

export function recordPr(
  store: Store,
  id: string,
  input: Auth & { url: string; state: PrState },
): Job {
  if (!/^https?:\/\//.test(input.url)) throw new ValidationError('PR url must be http(s).');
  return mutate(store, id, input, (job) => {
    if (job.stage !== 'pr' && job.stage !== 'completed') {
      throw new ValidationError('A PR can only be recorded in the pr stage.');
    }
    return {
      patch: { prUrl: input.url, prState: input.state },
      events: [{ type: 'pr.recorded', payload: { url: input.url, state: input.state } }],
    };
  });
}

/**
 * Record the outcome of `gh pr ready` after `orch gh ci` completed the job: event `pr.ready`, and
 * `prState` becomes `ready` on success. Never changes stage, status, or the CI verdict. It is the
 * last write of the completing `orch gh ci` (which held the lease for it), so it releases the job.
 */
export function recordPrReady(
  store: Store,
  id: string,
  input: Auth & { head: string; error: string | null },
): Job {
  return mutate(store, id, input, (job) => {
    if (!job.prUrl) throw new ValidationError('No PR recorded for this job.');
    const ok = input.error === null;
    const release = TERMINAL_STATUSES.includes(job.status) ? RELEASED : {};
    return {
      patch: ok ? { prState: 'ready', ...release } : release,
      events: [{ type: 'pr.ready', payload: { head: input.head, ok, error: input.error } }],
    };
  });
}

/** GitHub's answer about the PR (`pr.observed`), or the outcome of a human's merge (`pr.merged`). */
export type PrObservation =
  | {
      event: 'pr.observed';
      state: PrState | undefined;
      head: string | null;
      /** GitHub's `mergeable` (MERGEABLE, CONFLICTING, UNKNOWN), when read. */
      mergeable?: string | null | undefined;
    }
  | { event: 'pr.merged'; head: string; error: string | null };

/**
 * Record what GitHub said about the PR, or a dashboard merge attempt. Patches only `prState`
 * (`merged` only on a successful merge); never the CI verdict, stage, or status.
 */
export function recordPrState(store: Store, id: string, auth: Auth, o: PrObservation): Job {
  return mutate(store, id, auth, (job) => {
    if (!job.prUrl) throw new ValidationError('No PR recorded for this job.');
    if (o.event === 'pr.merged') {
      const ok = o.error === null;
      return {
        patch: ok ? { prState: 'merged' } : {},
        events: [{ type: 'pr.merged', payload: { head: o.head, ok, error: o.error } }],
      };
    }
    return {
      patch: o.state ? { prState: o.state } : {},
      events: [
        {
          type: 'pr.observed',
          payload: { state: o.state ?? null, head: o.head, mergeable: o.mergeable ?? null },
        },
      ],
    };
  });
}

/** The session recorded by a `session.attached` event, or null when the payload is unusable. */
export function sessionOf(e: Event | undefined): SessionRef | null {
  const p = e?.payload;
  if (!p || typeof p['provider'] !== 'string' || typeof p['ref'] !== 'string') return null;
  return {
    provider: p['provider'] as SessionRef['provider'],
    ref: p['ref'],
    cwd: typeof p['cwd'] === 'string' ? p['cwd'] : null,
  };
}

/** Current execution session per job (the newest attachment), null where none was recorded. */
export function sessionsByJob(db: Db, jobIds: readonly string[]): Map<string, SessionRef | null> {
  const latest = latestEventsByJob(db, jobIds, [SESSION_EVENT]);
  return new Map(jobIds.map((id) => [id, sessionOf(latest.get(id)?.get(SESSION_EVENT))]));
}

export interface AttachSessionInput {
  session: SessionRef;
  /** Required while the job is owned; an unowned (just dispatched) job accepts the launcher's record. */
  token?: string | undefined;
  actor?: string | undefined;
}

/**
 * Record which execution session drives the job now. Metadata, never workflow state: the owner
 * records it with its token; a job nobody owns yet (dispatched, not claimed) accepts it from the
 * session that launched it. Re-attaching the current ref changes nothing; a different one is
 * appended and the earlier attachments stay in the event log as history.
 */
export function attachSession(
  store: Store,
  id: string,
  input: AttachSessionInput,
): { job: Job; changed: boolean } {
  return store.db.transaction(
    (tx) => {
      const ts = now();
      const job = getJob(tx, id);
      if (job.ownerToken !== null) checkAuth(job, { token: input.token });
      const current = sessionsByJob(tx, [id]).get(id) ?? null;
      const s = input.session;
      if (current?.provider === s.provider && current.ref === s.ref) {
        return { job, changed: false };
      }
      const renew = job.ownerToken !== null && job.leaseExpiresAt !== null;
      const updated = apply(
        tx,
        job,
        renew ? { leaseExpiresAt: leaseUntil(ts, job.leaseMinutes) } : {},
        ts,
        [
          {
            type: SESSION_EVENT,
            payload: {
              provider: s.provider,
              ref: s.ref,
              cwd: s.cwd,
              previous: current ? { provider: current.provider, ref: current.ref } : null,
            },
          },
        ],
        input.actor ?? job.ownerSession,
      );
      return { job: updated, changed: true };
    },
    { behavior: 'immediate' },
  );
}

/**
 * Claim one status-mail batch: move `mailCursor` from `expected` to `to` only if it still holds
 * `expected`. True when this process won and may send. Mail state is metadata, like a session
 * attachment: no owner check, no revision, updatedAt, or lease change.
 */
export function claimMailCursor(
  store: Store,
  id: string,
  expected: number | null,
  to: number,
): boolean {
  return store.db.transaction(
    (tx) => {
      const won = tx
        .update(jobs)
        .set({ mailCursor: to })
        .where(
          and(
            eq(jobs.id, id),
            expected === null ? isNull(jobs.mailCursor) : eq(jobs.mailCursor, expected),
          ),
        )
        .returning({ id: jobs.id })
        .get();
      return won !== undefined;
    },
    { behavior: 'immediate' },
  );
}

export type MailOutcome =
  | { sent: true; messageId: string; subject: string; inReplyTo: string | null }
  | { sent: false; error: string };

/**
 * Record a claimed batch's outcome: thread ids and subject on success, plus a `mail.sent` or
 * `mail.failed` event. Metadata like `claimMailCursor`: no owner check, revision, or lease change.
 */
export function recordMailOutcome(store: Store, id: string, outcome: MailOutcome): void {
  store.db.transaction(
    (tx) => {
      const ts = now();
      const job = getJob(tx, id);
      if (outcome.sent) {
        tx.update(jobs)
          .set({
            mailThreadId: job.mailThreadId ?? outcome.messageId,
            mailLastId: outcome.messageId,
            mailSubject: outcome.subject,
          })
          .where(eq(jobs.id, id))
          .run();
        appendEvent(
          tx,
          id,
          'mail.sent',
          { messageId: outcome.messageId, inReplyTo: outcome.inReplyTo },
          null,
          ts,
        );
      } else {
        appendEvent(tx, id, 'mail.failed', { error: outcome.error }, null, ts);
      }
    },
    { behavior: 'immediate' },
  );
}

/** Longest posted notice; a note for the session, not a document. */
export const NOTICE_MAX = 2000;
/** Longest poster name (`--by`). */
export const NOTICE_BY_MAX = 100;

/**
 * Post a notice for the job's session (`notice.posted`), shown by `orch factory next` until the
 * owner acknowledges it. The poster is not the owner, so no token; metadata like
 * `recordMailOutcome`: no revision, updatedAt, or lease change. Text and poster are kept to one
 * line without control characters, so a post cannot forge plan lines or drive the terminal.
 */
export function postNotice(
  store: Store,
  id: string,
  input: { text: string; actor: string },
): { jobId: string; eventId: number; text: string; by: string } {
  const text = stripControl(input.text).trim();
  if (text === '') throw new ValidationError('A notice needs a non-blank text.');
  if (text.length > NOTICE_MAX) {
    throw new ValidationError(`A notice is at most ${String(NOTICE_MAX)} characters.`);
  }
  const by = stripControl(input.actor).trim() || 'human';
  if (by.length > NOTICE_BY_MAX) {
    throw new ValidationError(`A poster name is at most ${String(NOTICE_BY_MAX)} characters.`);
  }
  return store.db.transaction(
    (tx) => {
      const job = getJob(tx, id);
      if (TERMINAL_STATUSES.includes(job.status)) {
        throw new ValidationError(`${id} is ${job.status}; nobody would read the notice.`);
      }
      const eventId = appendEvent(tx, id, 'notice.posted', { text }, by, now());
      return { jobId: id, eventId, text, by };
    },
    { behavior: 'immediate' },
  );
}

/**
 * The owner acknowledges every posted notice up to `through` (`notice.acked`): one owner-checked
 * `mutate` that first checks `through` is one of this job's `notice.posted` events.
 */
export function ackNotice(store: Store, id: string, auth: Auth, through: number): Job {
  return mutate(store, id, auth, (_job, tx) => {
    const posted = eventsOfTypes(tx, id, ['notice.posted']).some((e) => e.id === through);
    if (!posted) throw new ValidationError(`Event ${String(through)} is not a notice of ${id}.`);
    return { patch: {}, events: [{ type: 'notice.acked', payload: { through } }] };
  });
}

function checkAuth(job: Job, auth: Auth): void {
  assertOwner(job, auth.token);
  if (auth.expectRevision !== undefined && auth.expectRevision !== job.revision) {
    throw new OwnershipError(
      `Stale revision: expected ${String(auth.expectRevision)}, job is at ${String(job.revision)}.`,
    );
  }
}

/** Ownership and revision check without a write, for operations that act outside the DB first. */
export function authorize(store: Store, id: string, auth: Auth): Job {
  const job = getJob(store.db, id);
  checkAuth(job, auth);
  return job;
}

/**
 * Extend the owner's lease by `job.leaseMinutes` from now, keeping the token: for a command that
 * holds the job a long time without writing (`orch verify` waiting its turn). Owner-checked.
 */
export function renewLease(store: Store, id: string, auth: Auth): Job {
  return mutate(store, id, auth, (job, _tx, ts) => ({
    patch: { leaseExpiresAt: leaseUntil(ts, job.leaseMinutes) },
    events: [],
  }));
}

/** Append an informational event (worktree integrated, branch pushed) as the owner. */
export function recordEvent(
  store: Store,
  id: string,
  auth: Auth,
  type: string,
  payload: Record<string, unknown>,
): Job {
  if (!/^[a-z]+\.[a-z-]+$/.test(type)) throw new ValidationError(`Bad event type: ${type}`);
  return mutate(store, id, auth, () => ({ patch: {}, events: [{ type, payload }] }));
}

// ---------------------------------------------------------------------------------------------

export interface Decision {
  patch: Partial<Job>;
  events: { type: string; payload: Record<string, unknown> }[];
}

/** Owner-checked, revision-bumped, lease-renewing transaction around a pure decision. */
export function mutate(
  store: Store,
  id: string,
  auth: Auth,
  decide: (job: Job, tx: Db, ts: string) => Decision,
): Job {
  return store.db.transaction(
    (tx) => {
      const ts = now();
      const job = getJob(tx, id);
      checkAuth(job, auth);
      const decided = decide(job, tx, ts);
      const { events } = decided;
      // A finished job has no worker: the write that finishes it gives up the lease. Events
      // still name the finishing session as actor.
      const finishes =
        decided.patch.status !== undefined && TERMINAL_STATUSES.includes(decided.patch.status);
      const patch = finishes && !auth.holdLease ? { ...decided.patch, ...RELEASED } : decided.patch;
      const renew = patch.ownerToken === undefined && job.leaseExpiresAt !== null;
      return apply(
        tx,
        job,
        renew ? { ...patch, leaseExpiresAt: leaseUntil(ts, job.leaseMinutes) } : patch,
        ts,
        events,
        job.ownerSession,
      );
    },
    { behavior: 'immediate' },
  );
}

/** `mutate` for decisions that also produce a row (the artifact, review, run) the caller needs. */
export function mutateReturning<T>(
  store: Store,
  id: string,
  auth: Auth,
  decide: (job: Job, tx: Db, ts: string) => Decision & { value: T },
): T {
  let value!: T; // assigned inside the transaction, which either commits or throws
  mutate(store, id, auth, (job, tx, ts) => {
    const d = decide(job, tx, ts);
    value = d.value;
    return d;
  });
  return value;
}

function apply(
  tx: Db,
  job: Job,
  patch: Partial<Job>,
  ts: string,
  events: Decision['events'],
  actor: string | null,
): Job {
  const updated = tx
    .update(jobs)
    .set({ ...patch, revision: job.revision + 1, updatedAt: ts })
    .where(and(eq(jobs.id, job.id), eq(jobs.revision, job.revision)))
    .returning()
    .get();
  // Inside an immediate transaction this cannot happen; kept as a guard against driver bugs.
  if (!updated) throw new OwnershipError(`Concurrent modification of ${job.id}; retry.`);
  for (const e of events) appendEvent(tx, job.id, e.type, e.payload, actor, ts);
  return updated;
}
