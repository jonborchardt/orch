/** Shapes shared by the API (src/server/api.ts) and the web client (web/src). Types only. */
import type { DashboardAction } from '../ops/actions.ts';
import type { Plan } from '../ops/factory.ts';
import type { Artifact, Event, Job, Review } from '../storage/schema.ts';

export type SafeJob = Omit<Job, 'ownerToken'>;

/**
 * What the lease tells us, honestly: `running` means the status is running AND the lease is
 * live, which still only proves a session touched the job recently, not that it is alive now.
 */
export type Liveness = 'running' | 'stale' | 'idle' | 'blocked' | 'finished';

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
  links: { vscode: string | null; pr: string | null };
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
