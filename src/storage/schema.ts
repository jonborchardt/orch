/**
 * Database schema. The single source of truth; `npm run db:generate` turns changes into
 * versioned SQL migrations under `drizzle/`. Never edit generated SQL by hand.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import type { PrState, Stage, Status, Verdict } from '../core/workflow.ts';

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
    /** Incremented on every mutation; optimistic concurrency check for callers. */
    revision: integer().notNull().default(1),
    createdAt: text().notNull(),
    updatedAt: text().notNull(),
    completedAt: text(),
  },
  (t) => [index('jobs_repo_idx').on(t.repo), index('jobs_status_idx').on(t.status)],
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
