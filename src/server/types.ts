/** Shapes shared by the API (src/server/api.ts) and the web client (web/src). Types only. */
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
  | 'waiting' // no live session owns it; a session must resume it
  | 'cancelled';

export interface Blocker {
  kind: BlockerKind;
  /** One line for the board, built from structured fields. */
  summary: string;
  /** The recorded free-text reason, verbatim, when one exists. */
  detail: string | null;
}

export interface Verdict {
  reviewer: string;
  verdict: Review['verdict'];
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
  /** `/factory resume <id>` when a Claude Code session may resume the job; null otherwise. */
  resume: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  elapsedMs: number;
  pr: {
    url: string | null;
    state: string | null;
    ciStatus: string | null;
    ciCheckedAt: string | null;
  };
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
  worktree: Plan['worktree'] | null;
  plan: Plan | null;
  planError: string | null;
  blocker: Blocker | null;
  /** Dashboard actions the workflow allows in this state (the server re-checks on POST). */
  actions: DashboardAction[];
  /** `vscode://file/...` for the worktree (when recorded) and for the initiating checkout. */
  links: { vscode: string | null; checkout: string; pr: string | null };
  /** `/factory resume <id>` when a Claude Code session may resume the job; null otherwise. */
  resume: string | null;
  resumeCommand: string;
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
  version: string;
  database: string;
  actions: readonly DashboardAction[];
}

export interface ApiError {
  error: { type: string; message: string };
}
