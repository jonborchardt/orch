/**
 * Every job mutation goes through here: one immediate transaction that loads the job, checks
 * ownership and revision, applies a pure domain decision, bumps the revision, renews the lease,
 * and appends events. Concurrent CLI processes serialize on SQLite's write lock.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import { and, desc, eq, inArray } from 'drizzle-orm';

import { assertStageOwns } from '../core/artifact-rules.ts';
import { NotFoundError, OwnershipError, ValidationError } from '../core/errors.ts';
import {
  assertOwner,
  decideClaim,
  DEFAULT_LEASE_MINUTES,
  leaseExpired,
  leaseUntil,
  newToken,
} from '../core/ownership.ts';
import { jobArtifactDir } from '../core/paths.ts';
import { DEFAULT_CONFIG } from '../core/roles.ts';
import {
  type Action,
  type CiStatus,
  now,
  type PrState,
  requiredArtifact,
  reviewArtifact,
  type Stage,
  type Status,
  transition,
  type Verdict,
  VERDICTS,
} from '../core/workflow.ts';
import { findArtifact, listArtifacts, upsertArtifact, validateArtifact } from './artifacts.ts';
import type { Db, Store } from './client.ts';
import { appendEvent, listEvents } from './events.ts';
import { type Artifact, type Event, type Job, jobs, type Review, reviews } from './schema.ts';

export interface CreateJobInput {
  title: string;
  description?: string | undefined;
  repo: string;
  repoPath: string;
  issueRef?: string | undefined;
  baseBranch: string;
  maxRounds?: number | undefined;
  actor?: string | undefined;
}

export interface Auth {
  token: string | undefined;
  /** Optimistic concurrency: reject if the job's revision differs. */
  expectRevision?: number | undefined;
}

export function createJob(store: Store, input: CreateJobInput): Job {
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
  return db
    .select()
    .from(jobs)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(jobs.createdAt))
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
}

export function jobDetail(store: Store, id: string, eventLimit = 20): JobDetail {
  const job = getJob(store.db, id);
  return {
    job,
    artifacts: listArtifacts(store.db, id),
    reviews: listReviews(store.db, id),
    events: listEvents(store.db, id, eventLimit),
    artifactDir: jobArtifactDir(id, store.paths),
  };
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
    patch: { ownerSession: null, ownerToken: null, leaseExpiresAt: null },
    events: [{ type: 'job.released', payload: { session: job.ownerSession } }],
  }));
}

export interface TransitionOptions extends Auth {
  to?: Stage | undefined;
  reason?: string | undefined;
}

export function transitionJob(
  store: Store,
  id: string,
  action: Action,
  opts: TransitionOptions,
): Job {
  return mutate(store, id, opts, (job, tx) => {
    const artifacts = listArtifacts(tx, id);
    if (action === 'complete') verifyOnDisk(jobArtifactDir(id, store.paths), job, artifacts);
    return transition(job, action, {
      artifacts,
      reviews: listReviews(tx, id),
      to: opts.to,
      reason: opts.reason,
    });
  });
}

/**
 * A registered row is only evidence while the file still matches it: the stage's required
 * artifact and, in review, the round's files are re-read before completion counts them.
 */
function verifyOnDisk(dir: string, job: Job, artifacts: Artifact[]): void {
  const required = requiredArtifact(job.stage, job.round);
  const prefix = `round-${String(job.round)}/`;
  for (const a of artifacts) {
    const relevant =
      a.path === required ||
      (job.stage === 'review' && a.path.startsWith(prefix)) ||
      (job.stage === 'pr' && a.path === 'decision.md');
    if (!relevant) continue;
    let checked;
    try {
      checked = validateArtifact(dir, a.path);
    } catch (err) {
      throw new ValidationError(`${a.path} no longer verifies: ${(err as Error).message}`);
    }
    if (a.sha256 !== null && checked.sha256 !== a.sha256) {
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
  const resumable =
    job.stage === 'needs-human' || ['interrupted', 'failed', 'blocked'].includes(job.status);
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
    if (existing && existing.sha256 !== null && existing.sha256 !== checked.sha256) {
      if (!opts.replace) {
        throw new ValidationError(
          `${checked.path} is already registered with different content; pass --replace to replace it.`,
        );
      }
    }
    const replaced = existing !== undefined && existing.sha256 !== checked.sha256;
    const artifact = upsertArtifact(tx, {
      jobId: id,
      stage: job.stage,
      round: job.stage === 'review' ? job.round : null,
      path: checked.path,
      bytes: checked.bytes,
      sha256: checked.sha256,
      marker: checked.marker,
      head: opts.head ?? null,
      createdAt: ts,
    });
    const payload = { path: checked.path, stage: job.stage, sha256: checked.sha256 };
    return {
      patch: {},
      events: [
        replaced
          ? { type: 'artifact.replaced', payload: { ...payload, previousSha256: existing.sha256 } }
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

/** Record the latest observed PR state and CI rollup (from `orch gh pr status`). */
export function recordCi(
  store: Store,
  id: string,
  input: Auth & { ciStatus: CiStatus; prState?: PrState | undefined },
): Job {
  return mutate(store, id, input, (job, _tx, ts) => {
    if (!job.prUrl) throw new ValidationError('No PR recorded for this job.');
    const patch: Partial<Job> = { ciStatus: input.ciStatus, ciCheckedAt: ts };
    if (input.prState) patch.prState = input.prState;
    return {
      patch,
      events: [
        { type: 'ci.observed', payload: { ciStatus: input.ciStatus, prState: input.prState } },
      ],
    };
  });
}

export interface ReviewInput extends Auth {
  reviewer: string;
  verdict?: Verdict | undefined;
  /** Relative artifact path; defaults to round-N/review-<reviewer>.md when a verdict is given. */
  artifact?: string | undefined;
  summary?: string | undefined;
  /** Worktree HEAD the verdict was given against (ops/gates.ts supplies it). */
  head?: string | null | undefined;
}

/** Upsert a reviewer's row for the current round. Without a verdict the reviewer is pending. */
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
      const rel = input.artifact ?? reviewArtifact(job.round, input.reviewer);
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
      const { patch, events } = decide(job, tx, ts);
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
