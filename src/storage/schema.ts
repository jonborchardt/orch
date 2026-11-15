/**
 * Database schema. The single source of truth; `npm run db:generate` turns changes into
 * versioned SQL migrations under `drizzle/`. Never edit generated SQL by hand.
 */
import {
  type AnySQLiteColumn,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import type {
  CheckStatus,
  IntegrationStatus,
  PolicySource,
  RunStatus,
  VerificationPolicy,
} from '../core/verification.ts';
import type { CiStatus, PrState, Stage, Status, Verdict } from '../core/workflow.ts';

export const jobs = sqliteTable(
  'jobs',
  {
    id: text().primaryKey(),
    title: text().notNull(),
    description: text(),
    /** Repository identity (normalized remote URL or directory name), shared across clones. */
    repo: text().notNull(),
    repoPath: text().notNull(),
    /** Original issue/request reference, e.g. "#42" or a URL. Jobs need not have one. */
    issueRef: text(),
    baseBranch: text().notNull(),
    branch: text(),
    worktreePath: text(),
    stage: text().$type<Stage>().notNull(),
    status: text().$type<Status>().notNull(),
    /** Current review round; 0 until the first review starts. */
    round: integer().notNull().default(0),
    maxRounds: integer().notNull().default(3),
    /** Stage to return to when a job blocked in needs-human is resumed. */
    returnStage: text().$type<Stage>(),
    ownerSession: text(),
    ownerToken: text(),
    leaseExpiresAt: text(),
    /** Lease length chosen at claim time; every owner mutation renews by this much. */
    leaseMinutes: integer().notNull().default(30),
    prUrl: text(),
    prState: text().$type<PrState>(),
    /** Last observed CI rollup for the PR; null until `orch gh pr status` or `orch gh ci` has run. */
    ciStatus: text().$type<CiStatus>(),
    ciCheckedAt: text(),
    /** PR head commit the rollup was read for; a result counts only while HEAD is this commit. */
    ciHead: text(),
    /** CI repair cycles taken (`rework` from the ci stage); bounded by `maxCiRepairs`. */
    ciRepairs: integer().notNull().default(0),
    maxCiRepairs: integer().notNull().default(2),
    /**
     * Verification policy a human authorized for this job (dashboard `accept-policy`), replacing
     * the baseline read from the merge base. Null means the baseline applies.
     */
    policy: text({ mode: 'json' }).$type<VerificationPolicy>(),
    /** Commit whose factory.json was authorized. */
    policyHead: text(),
    /** Job that replaced this one (`orch job supersede`); both histories are kept. */
    supersededBy: text().references((): AnySQLiteColumn => jobs.id),
    /** When a human archived this finished job (dashboard); null when it is not archived. */
    archivedAt: text(),
    /** Incremented on every mutation; optimistic concurrency check for callers. */
    revision: integer().notNull().default(1),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
    completedAt: text(),
  },
  (t) => [
    index('jobs_repo_idx').on(t.repo),
    index('jobs_status_idx').on(t.status),
    // A managed worktree and a branch within a repository belong to at most one job.
    uniqueIndex('jobs_worktree_idx').on(t.worktreePath),
    uniqueIndex('jobs_repo_branch_idx').on(t.repo, t.branch),
  ],
);

export const events = sqliteTable(
  'events',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    jobId: text()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    type: text().notNull(),
    payload: text({ mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    actor: text(),
    createdAt: text().notNull(),
  },
  (t) => [index('events_job_idx').on(t.jobId, t.id)],
);

export const artifacts = sqliteTable(
  'artifacts',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    jobId: text()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    stage: text().$type<Stage>().notNull(),
    round: integer(),
    /** Path relative to the job's artifact directory, forward slashes. */
    path: text().notNull(),
    bytes: integer().notNull(),
    /** Content hash; replacing a registered artifact with different content needs --replace. */
    sha256: text(),
    /** Value parsed from the content by core/artifact-rules.ts (e.g. review verdict, decision). */
    marker: text(),
    /** Worktree HEAD when the artifact was registered; null when the job had no worktree. */
    head: text(),
    createdAt: text().notNull(),
  },
  (t) => [uniqueIndex('artifacts_job_path_idx').on(t.jobId, t.path)],
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    jobId: text()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    round: integer().notNull(),
    reviewer: text().notNull(),
    /** Null while the reviewer is still running. */
    verdict: text().$type<Verdict>(),
    artifactId: integer().references(() => artifacts.id),
    /** Worktree HEAD the verdict was recorded against; every reviewer in a round must match. */
    head: text(),
    summary: text(),
    createdAt: text().notNull(),
    completedAt: text(),
  },
  (t) => [uniqueIndex('reviews_job_round_reviewer_idx').on(t.jobId, t.round, t.reviewer)],
);

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type Artifact = typeof artifacts.$inferSelect;
export type Review = typeof reviews.$inferSelect;

/** One `orch verify` invocation: the expected checks are rowed up front, then run in order. */
export const verificationRuns = sqliteTable(
  'verification_runs',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    jobId: text()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    /** Commit and tree the checks ran against; the worktree was clean (see `dirty`). */
    head: text().notNull(),
    tree: text().notNull(),
    dirty: text({ mode: 'json' }).$type<string[]>().notNull(),
    /** Hash of the effective verification policy (core/verification.ts fingerprint). */
    configFingerprint: text().notNull(),
    policySource: text().$type<PolicySource>().notNull(),
    /** Commit the policy was read from (merge base, or the authorized head). */
    policyHead: text(),
    status: text().$type<RunStatus>().notNull(),
    actor: text(),
    startedAt: text().notNull(),
    completedAt: text(),
  },
  (t) => [index('verification_runs_job_idx').on(t.jobId, t.id)],
);

export const verificationChecks = sqliteTable(
  'verification_checks',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    runId: integer()
      .notNull()
      .references(() => verificationRuns.id, { onDelete: 'cascade' }),
    checkId: text().notNull(),
    command: text().notNull(),
    args: text({ mode: 'json' }).$type<string[]>().notNull(),
    /** Working directory relative to the worktree ('.' for the root). */
    cwd: text().notNull(),
    required: integer({ mode: 'boolean' }).notNull(),
    timeoutMs: integer().notNull(),
    status: text().$type<CheckStatus>().notNull(),
    startedAt: text(),
    completedAt: text(),
    durationMs: integer(),
    exitCode: integer(),
    signal: text(),
    /** Captured output, relative to the job artifact directory, and its hash. */
    outputPath: text(),
    outputSha256: text(),
    truncated: integer({ mode: 'boolean' }).notNull().default(false),
    /** Launch or capture problem, when status is `error`. */
    error: text(),
  },
  (t) => [uniqueIndex('verification_checks_run_check_idx').on(t.runId, t.checkId)],
);

/** One base-branch integration attempt, recorded before Git runs so a crash leaves a trace. */
export const integrations = sqliteTable(
  'integrations',
  {
    id: integer().primaryKey({ autoIncrement: true }),
    jobId: text()
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    status: text().$type<IntegrationStatus>().notNull(),
    /** Inputs: job HEAD, base tip, their merge base, approval commit, valid pre-run. */
    fromHead: text().notNull(),
    baseRef: text().notNull(),
    baseSha: text().notNull(),
    mergeBase: text(),
    decisionHead: text(),
    verificationRunId: integer(),
    /** Outcome. */
    resultHead: text(),
    conflicts: text({ mode: 'json' }).$type<string[]>(),
    /** Files that differ between fromHead and resultHead (what taking the base changed). */
    changedFiles: text({ mode: 'json' }).$type<string[]>(),
    /** Files whose merge result matches neither parent: conflict resolution or manual edits. */
    material: text({ mode: 'json' }).$type<string[]>(),
    startedAt: text().notNull(),
    completedAt: text(),
  },
  (t) => [index('integrations_job_idx').on(t.jobId, t.id)],
);

export type VerificationRun = typeof verificationRuns.$inferSelect;
export type VerificationCheck = typeof verificationChecks.$inferSelect;
export type Integration = typeof integrations.$inferSelect;
