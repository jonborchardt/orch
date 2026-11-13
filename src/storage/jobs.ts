/**
 * Every job mutation goes through here: one immediate transaction that loads the job, checks
 * ownership and revision, applies a pure domain decision, bumps the revision, renews the lease,
 * and appends events. Concurrent CLI processes serialize on SQLite's write lock.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';

import { and, desc, eq } from 'drizzle-orm';

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
import {
  type Action,
  now,
  type PrState,
  reviewArtifact,
  type Stage,
  type Status,
  transition,
  type Verdict,
  VERDICTS,
} from '../core/workflow.ts';
import { listArtifacts, upsertArtifact, validateArtifact } from './artifacts.ts';
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
          maxRounds: input.maxRounds ?? 3,
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
      const token = kind === 'renew' && job.ownerToken ? job.ownerToken : newToken();
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
  return mutate(store, id, opts, (job, tx) =>
    transition(job, action, {
      artifacts: listArtifacts(tx, id),
      reviews: listReviews(tx, id),
      to: opts.to,
      reason: opts.reason,
    }),
  );
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

export function registerArtifact(store: Store, id: string, relPath: string, auth: Auth): Artifact {
  let artifact!: Artifact;
  mutate(store, id, auth, (job, tx, ts) => {
    const checked = validateArtifact(jobArtifactDir(id, store.paths), relPath);
    artifact = upsertArtifact(tx, {
      jobId: id,
      stage: job.stage,
      round: job.stage === 'review' ? job.round : null,
      path: checked.path,
      bytes: checked.bytes,
      createdAt: ts,
    });
    return {
      patch: {},
      events: [{ type: 'artifact.registered', payload: { path: checked.path, stage: job.stage } }],
    };
  });
  return artifact;
}

export interface ReviewInput extends Auth {
  reviewer: string;
  verdict?: Verdict | undefined;
  /** Relative artifact path; defaults to round-N/review-<reviewer>.md when a verdict is given. */
  artifact?: string | undefined;
  summary?: string | undefined;
}

/** Upsert a reviewer's row for the current round. Without a verdict the reviewer is pending. */
export function recordReview(store: Store, id: string, input: ReviewInput): Review {
  if (!/^[a-z0-9-]+$/.test(input.reviewer)) {
    throw new ValidationError('Reviewer name must be lowercase letters, digits, or hyphens.');
  }
  if (input.verdict !== undefined && !VERDICTS.includes(input.verdict)) {
    throw new ValidationError(`Verdict must be one of ${VERDICTS.join(', ')}.`);
  }
  let review!: Review;
  mutate(store, id, input, (job, tx, ts) => {
    if (job.stage !== 'review' || job.status !== 'running') {
      throw new ValidationError('Reviews can only be recorded while the review stage is running.');
    }
    let artifactId: number | null = null;
    if (input.verdict) {
      const rel = input.artifact ?? reviewArtifact(job.round, input.reviewer);
      const checked = validateArtifact(jobArtifactDir(id, store.paths), rel);
      artifactId = upsertArtifact(tx, {
        jobId: id,
        stage: 'review',
        round: job.round,
        path: checked.path,
        bytes: checked.bytes,
        createdAt: ts,
      }).id;
    }
    review = tx
      .insert(reviews)
      .values({
        jobId: id,
        round: job.round,
        reviewer: input.reviewer,
        verdict: input.verdict ?? null,
        artifactId,
        summary: input.summary ?? null,
        createdAt: ts,
        completedAt: input.verdict ? ts : null,
      })
      .onConflictDoUpdate({
        target: [reviews.jobId, reviews.round, reviews.reviewer],
        set: {
          verdict: input.verdict ?? null,
          artifactId,
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
    };
  });
  return review;
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

// ---------------------------------------------------------------------------------------------

interface Decision {
  patch: Partial<Job>;
  events: { type: string; payload: Record<string, unknown> }[];
}

function mutate(
  store: Store,
  id: string,
  auth: Auth,
  decide: (job: Job, tx: Db, ts: string) => Decision,
): Job {
  return store.db.transaction(
    (tx) => {
      const ts = now();
      const job = getJob(tx, id);
      assertOwner(job, auth.token);
      if (auth.expectRevision !== undefined && auth.expectRevision !== job.revision) {
        throw new OwnershipError(
          `Stale revision: expected ${String(auth.expectRevision)}, job is at ${String(job.revision)}.`,
        );
      }
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
