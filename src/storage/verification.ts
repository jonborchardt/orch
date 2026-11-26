/**
 * Verification runs, their checks, base integrations, and the authorized policy snapshot. Every
 * write is an owner mutation through `mutate` in jobs.ts, so a revoked token stops the record
 * mid-run and the run stays `running` (which never counts as evidence).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';

import { NotFoundError, ValidationError } from '../core/errors.ts';
import { type Flake, FLAKY_EVENT } from '../core/flake.ts';

import type {
  CheckStatus,
  IntegrationStatus,
  PolicySource,
  RunStatus,
  VerificationCheckSpec,
  VerificationPolicy,
} from '../core/verification.ts';
import type { Db, Store } from './client.ts';
import { type Auth, mutate, mutateReturning } from './jobs.ts';
import {
  events,
  type Integration,
  integrations,
  type Job,
  type RegressionRun,
  regressionRuns,
  type VerificationCheck,
  type VerificationRun,
  verificationChecks,
  verificationRuns,
} from './schema.ts';

function must<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new NotFoundError(`${what} not found`);
  return row;
}

export interface StartRunInput extends Auth {
  head: string;
  tree: string;
  dirty: string[];
  configFingerprint: string;
  policySource: PolicySource;
  policyHead: string | null;
  checks: VerificationCheckSpec[];
}

export interface RunDetail {
  run: VerificationRun;
  checks: VerificationCheck[];
}

/** Row up the run and every expected check (pending) before anything executes. */
export function startRun(store: Store, id: string, input: StartRunInput): RunDetail {
  return mutateReturning(store, id, input, (job, tx, ts) => {
    // A previous run that never finished is now known to be interrupted.
    tx.update(verificationRuns)
      .set({ status: 'interrupted', completedAt: ts })
      .where(and(eq(verificationRuns.jobId, id), eq(verificationRuns.status, 'running')))
      .run();
    const run = tx
      .insert(verificationRuns)
      .values({
        jobId: id,
        head: input.head,
        tree: input.tree,
        dirty: input.dirty,
        configFingerprint: input.configFingerprint,
        policySource: input.policySource,
        policyHead: input.policyHead,
        status: 'running',
        actor: job.ownerSession,
        startedAt: ts,
      })
      .returning()
      .get();
    const checks = input.checks.map((c) =>
      tx
        .insert(verificationChecks)
        .values({
          runId: run.id,
          checkId: c.id,
          command: c.command,
          args: c.args,
          cwd: c.cwd,
          required: c.required,
          timeoutMs: c.timeoutMs,
          status: 'pending',
        })
        .returning()
        .get(),
    );
    return {
      patch: {},
      events: [
        {
          type: 'verification.started',
          payload: {
            runId: run.id,
            head: input.head,
            configFingerprint: input.configFingerprint,
            checks: input.checks.map((c) => c.id),
          },
        },
      ],
      value: { run, checks },
    };
  });
}

export interface CheckResult {
  status: CheckStatus;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  outputPath: string | null;
  outputSha256: string | null;
  truncated: boolean;
  error: string | null;
}

export function recordCheck(
  store: Store,
  id: string,
  auth: Auth,
  checkRowId: number,
  result: CheckResult,
): VerificationCheck {
  return mutateReturning(store, id, auth, (_job, tx) => {
    const run = tx
      .select({ id: verificationRuns.id, status: verificationRuns.status })
      .from(verificationChecks)
      .innerJoin(verificationRuns, eq(verificationRuns.id, verificationChecks.runId))
      .where(eq(verificationChecks.id, checkRowId))
      .get();
    if (run && run.status !== 'running') throw superseded(run.id, run.status);
    return {
      patch: {},
      events: [],
      value: must(
        tx
          .update(verificationChecks)
          .set(result)
          .where(eq(verificationChecks.id, checkRowId))
          .returning()
          .get(),
        `verification check ${String(checkRowId)}`,
      ),
    };
  });
}

/**
 * A run that is no longer `running` keeps its record: a newer `orch verify` marked it
 * interrupted, and the late process must not rewrite that history (its log is already saved).
 */
function superseded(runId: number, status: RunStatus): ValidationError {
  return new ValidationError(
    `Verification run ${String(runId)} is ${status}, not running (a newer orch verify superseded it); ` +
      'its result is not recorded. The newest run is the one that counts.',
  );
}

export function finishRun(
  store: Store,
  id: string,
  auth: Auth,
  runId: number,
  status: Exclude<RunStatus, 'running'>,
): VerificationRun {
  return mutateReturning(store, id, auth, (_job, tx, ts) => {
    const run = must(
      tx.select().from(verificationRuns).where(eq(verificationRuns.id, runId)).get(),
      `verification run ${String(runId)}`,
    );
    if (run.status !== 'running') throw superseded(runId, run.status);
    return {
      patch: {},
      events: [{ type: 'verification.completed', payload: { runId, status } }],
      value: must(
        tx
          .update(verificationRuns)
          .set({ status, completedAt: ts })
          .where(and(eq(verificationRuns.id, runId), eq(verificationRuns.status, 'running')))
          .returning()
          .get(),
        `verification run ${String(runId)}`,
      ),
    };
  });
}

/**
 * Label a failed run as a likely flake. A label only: the run row is untouched. A run is flagged
 * at most once; the job's existing `verification.flaky` events decide, read in this transaction.
 */
export function markFlaky(
  store: Store,
  id: string,
  auth: Auth,
  flake: Omit<Flake, 'at' | 'sharedWith'> & { tree: string },
): boolean {
  return mutateReturning(store, id, auth, (_job, tx) => {
    const done = tx
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.jobId, id), eq(events.type, FLAKY_EVENT)))
      .all()
      .some((e) => e.payload['runId'] === flake.runId);
    return {
      patch: {},
      events: done ? [] : [{ type: FLAKY_EVENT, payload: { ...flake } }],
      value: !done,
    };
  });
}

export function listRuns(db: Db, jobId: string): VerificationRun[] {
  return db
    .select()
    .from(verificationRuns)
    .where(eq(verificationRuns.jobId, jobId))
    .orderBy(desc(verificationRuns.id))
    .all();
}

/** Newest run per job, optionally of one status (checks not loaded); one query for the whole board. */
export function latestRunsByJob(
  db: Db,
  jobIds: readonly string[],
  status?: VerificationRun['status'],
): Map<string, VerificationRun> {
  const out = new Map<string, VerificationRun>();
  if (jobIds.length === 0) return out;
  const rows = db
    .select()
    .from(verificationRuns)
    .where(
      and(
        inArray(verificationRuns.jobId, [...jobIds]),
        status ? eq(verificationRuns.status, status) : undefined,
      ),
    )
    .orderBy(verificationRuns.id)
    .all();
  for (const r of rows) out.set(r.jobId, r);
  return out;
}

export function listChecks(db: Db, runId: number): VerificationCheck[] {
  return db
    .select()
    .from(verificationChecks)
    .where(eq(verificationChecks.runId, runId))
    .orderBy(verificationChecks.id)
    .all();
}

export function runDetail(db: Db, runId: number): RunDetail | undefined {
  const run = db.select().from(verificationRuns).where(eq(verificationRuns.id, runId)).get();
  return run ? { run, checks: listChecks(db, runId) } : undefined;
}

export function latestRun(db: Db, jobId: string): RunDetail | undefined {
  const run = listRuns(db, jobId)[0];
  return run ? { run, checks: listChecks(db, run.id) } : undefined;
}

/** A human accepted the worktree's factory.json at `head` as this job's policy. */
export function authorizePolicy(
  store: Store,
  id: string,
  auth: Auth,
  policy: VerificationPolicy,
  head: string,
  fingerprint: string,
): Job {
  return mutate(store, id, auth, () => ({
    patch: { policy, policyHead: head },
    events: [{ type: 'policy.authorized', payload: { head, fingerprint } }],
  }));
}

export interface StartIntegrationInput extends Auth {
  fromHead: string;
  baseRef: string;
  baseSha: string;
  mergeBase: string | null;
  decisionHead: string | null;
  verificationRunId: number | null;
}

export function startIntegration(
  store: Store,
  id: string,
  input: StartIntegrationInput,
): Integration {
  return mutateReturning(store, id, input, (_job, tx, ts) => {
    const row = tx
      .insert(integrations)
      .values({
        jobId: id,
        status: 'started',
        fromHead: input.fromHead,
        baseRef: input.baseRef,
        baseSha: input.baseSha,
        mergeBase: input.mergeBase,
        decisionHead: input.decisionHead,
        verificationRunId: input.verificationRunId,
        startedAt: ts,
      })
      .returning()
      .get();
    return {
      patch: {},
      events: [
        {
          type: 'integration.started',
          payload: { integrationId: row.id, fromHead: input.fromHead, baseSha: input.baseSha },
        },
      ],
      value: row,
    };
  });
}

export interface FinishIntegrationInput {
  status: Exclude<IntegrationStatus, 'started'>;
  resultHead: string | null;
  conflicts: string[];
  changedFiles: string[];
  material: string[];
}

export function finishIntegration(
  store: Store,
  id: string,
  auth: Auth,
  integrationId: number,
  input: FinishIntegrationInput,
): Integration {
  return mutateReturning(store, id, auth, (_job, tx, ts) => ({
    patch: {},
    events: [{ type: 'integration.completed', payload: { integrationId, ...input } }],
    value: must(
      tx
        .update(integrations)
        .set({ ...input, completedAt: ts })
        .where(eq(integrations.id, integrationId))
        .returning()
        .get(),
      `integration ${String(integrationId)}`,
    ),
  }));
}

export function listIntegrations(db: Db, jobId: string): Integration[] {
  return db
    .select()
    .from(integrations)
    .where(eq(integrations.jobId, jobId))
    .orderBy(desc(integrations.id))
    .all();
}

export type RegressionInput = Omit<RegressionRun, 'id' | 'jobId' | 'completedAt'>;

/** One bug-fix regression attempt, recorded once it finished; `verificationStatus` gates on it. */
export function recordRegression(
  store: Store,
  id: string,
  auth: Auth,
  input: RegressionInput,
): RegressionRun {
  return mutateReturning(store, id, auth, (_job, tx, ts) => {
    const row = tx
      .insert(regressionRuns)
      .values({ ...input, jobId: id, completedAt: ts })
      .returning()
      .get();
    return {
      patch: {},
      events: [
        {
          type: 'verification.regression',
          payload: { regressionId: row.id, runId: row.runId, status: row.status },
        },
      ],
      value: row,
    };
  });
}

/** The newest regression attempt recorded for this job at `head` under policy `fingerprint`. */
export function latestRegression(
  db: Db,
  jobId: string,
  head: string,
  fingerprint: string,
): RegressionRun | undefined {
  return db
    .select()
    .from(regressionRuns)
    .where(
      and(
        eq(regressionRuns.jobId, jobId),
        eq(regressionRuns.head, head),
        eq(regressionRuns.configFingerprint, fingerprint),
      ),
    )
    .orderBy(desc(regressionRuns.id))
    .get();
}
