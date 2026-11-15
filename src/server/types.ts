/** Shapes shared by the API (src/server/api.ts) and the web client (web/src). Types only. */
import type { SessionLinks, SessionRef } from '../core/session.ts';
import type { DashboardAction } from '../ops/actions.ts';
import type { Plan } from '../ops/factory.ts';
import type { Artifact, Event, Job, Review } from '../storage/schema.ts';

export type SafeJob = Omit<Job, 'ownerToken'>;

/**
 * Execution state, distinct from the workflow stage. `running` means the status is running AND
 * the lease is live, which still only proves a session touched the job recently, not that it is
 * alive now; `stale` is running with a lapsed lease. `completed` and `cancelled` are never merged:
 * a cancelled job is not a success.
 */
export type Liveness =
  'running' | 'stale' | 'idle' | 'interrupted' | 'failed' | 'blocked' | 'completed' | 'cancelled';

/** Why a job is not progressing, derived from persisted state only (never from prose). */
export type BlockerKind =
  | 'interrupted' // execution stopped: the lease lapsed or another session took the job over
  | 'failed' // a stage was marked failed
  | 'verification' // the latest verification run failed
  | 'findings' // reviewers still requested changes at the last allowed round
  | 'decision' // the approver escalated: a human product or policy decision
  | 'escalated' // escalated for a reason the persisted state does not classify
  | 'ci' // the ci stage stopped: repairs exhausted, no checks, checks that never ran, PR closed or moved
  | 'waiting' // no live session owns it; a session must resume it
  | 'cancelled';

export interface Blocker {
  kind: BlockerKind;
  /** One line for the board, built from structured fields. */
  summary: string;
  /** The recorded free-text reason, verbatim, when one exists. */
  detail: string | null;
}

/**
 * Resume availability. `command` is `/factory resume <id>` when a session may take the job now;
 * null while a live lease is held, with the holder named so the UI can say why. The dashboard
 * never forces ownership.
 */
export interface Resume {
  command: string | null;
  heldBy: { session: string; leaseExpiresAt: string | null } | null;
}

export interface Verdict {
  reviewer: string;
  verdict: Review['verdict'];
}

/**
 * The CI reconciliation state of a job, from persisted fields only: the rollup columns on the job
 * row, the newest `ci.observed` event (an `orch gh ci` reconciliation carries an outcome, a
 * `pr status` observation does not), and the `job.completed` event. A verdict is only ever shown
 * with the commit it was read for.
 */
export interface CiView {
  /** PR head commit the recorded rollup describes; null until something observed the PR. */
  head: string | null;
  /** Whether that commit is the worktree HEAD; null when the worktree was not inspected (board). */
  current: boolean | null;
  status: Job['ciStatus'];
  checkedAt: string | null;
  repairs: number;
  maxRepairs: number;
  /** Newest reconciliation outcome for `head` (pending, passing, failing, infrastructure, none, outdated, closed). */
  outcome: string | null;
  /** GitHub's reason from that reconciliation, verbatim. */
  reason: string | null;
  /** Required checks that failed in that reconciliation, with GitHub's URL and the saved log path. */
  failures: { name: string; conclusion: string; url: string | null; log: string | null }[];
  /**
   * How a completed job finished: GitHub's verdict for `head`, a human close-out (recorded with
   * its reason), or a job completed before the ci stage existed, which carries no verdict at all.
   */
  completion: 'ci' | 'human' | 'legacy' | null;
  /** What the CI state means for the reader, and what happens or may be done next. */
  line: string;
  guidance: string;
}

export interface BoardRow {
  id: string;
  title: string;
  repo: string;
  repoPath: string;
  stage: Job['stage'];
  status: Job['status'];
  liveness: Liveness;
  round: number;
  maxRounds: number;
  owner: { session: string; leaseExpiresAt: string | null; live: boolean } | null;
  worktreePath: string | null;
  branch: string | null;
  reviews: Verdict[];
  /** BLOCKING count from the newest consolidated.md, or null when there is none. */
  blocking: number | null;
  blocker: Blocker | null;
  /** Null for finished jobs; otherwise whether and how a session may resume it. */
  resume: Resume | null;
  updatedAt: string;
  elapsedMs: number;
  pr: { url: string | null; state: string | null };
  /** Job that replaced this one, and jobs this one replaced (`orch job supersede`). */
  supersededBy: string | null;
  supersedes: string[];
  /** When a human archived this finished job; archived rows are hidden from the default views. */
  archivedAt: string | null;
  ci: CiView;
}

/**
 * The execution session last attached to the job: metadata, so the dashboard can point at it. It
 * never implies the session is alive (the lease does that), and it is not needed to resume.
 */
export interface SessionView extends SessionRef {
  attachedAt: string;
  /** Who recorded it (the launching session or the owner). */
  by: string | null;
  links: SessionLinks;
  /** Earlier attachments (the job was resumed or adopted by other sessions). */
  previous: number;
}

export interface RoundView {
  round: number;
  reviews: (Review & { path: string | null })[];
  consolidated: string | null;
  blocking: number | null;
}

export interface JobDetailView {
  job: SafeJob;
  liveness: Liveness;
  artifacts: Artifact[];
  /** Markdown content of registered artifacts, keyed by relative path (size-capped). */
  contents: Record<string, string>;
  rounds: RoundView[];
  events: Event[];
  plan: Plan | null;
  planError: string | null;
  blocker: Blocker | null;
  ci: CiView;
  /** Dashboard actions the workflow allows in this state (the server re-checks on POST). */
  actions: DashboardAction[];
  /** `vscode://file/...` for the worktree (when recorded) and for the initiating checkout. */
  links: { vscode: string | null; checkout: string; pr: string | null };
  /** Current execution session, or null when none was ever attached. */
  session: SessionView | null;
  /** Null for finished jobs; otherwise whether and how a session may resume it. */
  resume: Resume | null;
  resumeCommand: string;
  /** Ids of the jobs this one replaced (`job.supersededBy` names its own replacement). */
  supersedes: string[];
}

export interface ActionRequest {
  action: DashboardAction;
  reason?: string;
  force?: boolean;
  to?: string;
}

export interface ActionResponse {
  job: SafeJob;
  message: string;
  resumeCommand?: string;
}

export interface SessionInfo {
  csrf: string;
}

export interface ApiError {
  error: { type: string; message: string };
}
