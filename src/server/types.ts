/** Shapes shared by the API (src/server/api.ts) and the web client (web/src). Types only. */
import type { Flake } from '../core/flake.ts';
import type { SessionLinks, SessionRef } from '../core/session.ts';
import type { Completion, PrPhase } from '../core/workflow.ts';
import type { DashboardAction } from '../ops/actions.ts';
import type { Plan } from '../ops/factory.ts';
import type { MergeView } from '../ops/merge-view.ts';
import type { Artifact, Event, Job, Review } from '../storage/schema.ts';

export type SafeJob = Omit<Job, 'ownerToken'>;
export type { Flake };
// The ticket and controller views the dashboard reads; web/ imports them from here only.
export type { Area, BlockReason, Priority, TicketStatus, TicketType } from '../core/tickets.ts';
export type { RunnerStatus } from '../ops/run.ts';
export type {
  TicketDetail,
  TicketJob,
  TicketList,
  TicketSummary,
  TicketView,
} from '../ops/tickets.ts';
export type { TicketEvent } from '../storage/schema.ts';

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
  /** Newest reconciliation outcome for `head` (pending, passing, failing, infrastructure, none, outdated, closed, merged). */
  outcome: string | null;
  /** GitHub's reason from that reconciliation, verbatim. */
  reason: string | null;
  /** Required checks that failed in that reconciliation, with GitHub's URL and the saved log path. */
  failures: { name: string; conclusion: string; url: string | null; log: string | null }[];
  /**
   * How a completed job finished: GitHub's verdict for `head`, a human merge of the PR at `head`
   * before CI finished (`merged`), a human close-out (recorded with its reason), or a job
   * completed before the ci stage existed, which carries no verdict at all.
   */
  completion: Completion;
  /** What the CI state means for the reader, and what happens or may be done next. */
  line: string;
  guidance: string;
}

/**
 * The eight presentation steps, in workflow order; `needs-human` and `completed` are never steps.
 * A fast job's progress has only build, pr, ci, and done.
 */
export type StepId = 'spec' | 'build' | 'simplify' | 'review' | 'approve' | 'pr' | 'ci' | 'done';
export type StepState = 'done' | 'current' | 'stopped' | 'not-started';

/**
 * Where a job is in the workflow, for people who do not know orch's stage names. At most one step
 * is current or stopped; steps before it are done and steps after it not started, even when an
 * earlier pass reached them (the timeline shows that pass).
 */
export interface Progress {
  steps: { id: StepId; label: string; state: StepState }[];
  /** Index of the current or stopped step; -1 when none is known; `steps.length` when completed. */
  position: number;
  /** Short text for the position, e.g. "Build", "CI, needs human", "Done", "Needs human". */
  label: string;
}

/** One stage entry or exit from the job's events, oldest first; going back is a new entry. */
export interface TimelineEntry {
  at: string;
  step: StepId | null;
  kind: 'started' | 'completed' | 'back' | 'stopped' | 'resumed';
  label: string;
}

export interface Timeline {
  entries: TimelineEntry[];
  /** The events cap was reached, so earlier history is not shown. */
  truncated: boolean;
}

/**
 * How a completed job ended, from recorded fields only: a merged PR (recorded `prState`), a ready
 * PR on a passing CI verdict, a human close-out, or plain `completed` when the record is not enough.
 * Workflow completion is not a merge: only `merged` says the PR was merged.
 */
export type OutcomeKind = 'merged' | 'ready' | 'human' | 'completed';
export interface Outcome {
  kind: OutcomeKind;
  /** Status chip text after the glyph, e.g. "completed: merged". */
  label: string;
}

export interface BoardRow {
  id: string;
  title: string;
  repo: string;
  repoPath: string;
  stage: Job['stage'];
  status: Job['status'];
  /** `fast`: build, pr, ci only (the board shows a chip); `full` otherwise. */
  mode: Job['mode'];
  liveness: Liveness;
  /** Null unless the job completed. */
  outcome: Outcome | null;
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
  /** The job's first stage start (not its creation); null until then. */
  startedAt: string | null;
  updatedAt: string;
  /**
   * Wall-clock time from creation to completion or cancellation (to now while active), blocked
   * and waiting time included. Null when a finished job's end time cannot be established.
   */
  elapsedMs: number | null;
  /**
   * `phase` is orch's recorded view (`prPhase`); GitHub is asked again only on Merge or Refresh PR.
   * `refreshable`: the server allows Refresh PR now (`cannotRefreshPr` is null).
   */
  pr: { url: string | null; state: string | null; phase: PrPhase; refreshable: boolean };
  /** Job that replaced this one, and jobs this one replaced (`orch job supersede`). */
  supersededBy: string | null;
  supersedes: string[];
  /** The ticket this job works on; null for a job started without one. */
  ticketId: number | null;
  /** When a human archived this finished job; archived rows are hidden from the default views. */
  archivedAt: string | null;
  ci: CiView;
  progress: Progress;
  /**
   * Newest likely-flaky verification failure; null for finished jobs and once a newer run passed.
   * `sharedWith` names other jobs failing the same test. A label, never a blocker.
   */
  flake: Flake | null;
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
  /** Null unless the job completed. */
  outcome: Outcome | null;
  artifacts: Artifact[];
  /** Markdown content of registered artifacts, keyed by relative path (size-capped). */
  contents: Record<string, string>;
  rounds: RoundView[];
  events: Event[];
  plan: Plan | null;
  planError: string | null;
  blocker: Blocker | null;
  ci: CiView;
  progress: Progress;
  timeline: Timeline;
  /**
   * Newest likely-flaky verification failure; null for finished jobs and once a newer run passed.
   * `sharedWith` names other jobs failing the same test. A label, never a blocker.
   */
  flake: Flake | null;
  /** Where the PR stands in delivery, from recorded fields (`prPhase`). */
  prPhase: PrPhase;
  /** Dashboard actions the workflow allows in this state (the server re-checks on POST). */
  actions: DashboardAction[];
  /**
   * What reports merge conflicts with the base (approve, pr, ci, or a completed job with an open
   * PR not yet superseded): files from the local base ref probe and/or GitHub's last recorded
   * CONFLICTING; null when neither does or the action does not apply. Backs Fix merge conflicts.
   */
  conflicts: { files: string[]; github: boolean } | null;
  /**
   * `vscode://file/...` for the worktree (when recorded) and for the initiating checkout; the
   * branch's GitHub tree URL once a recorded PR or `branch.pushed` event shows it is on the remote.
   * `pr` is the recorded PR URL only when it parses with an http(s) scheme; every PR href in the
   * detail view uses it. `repo` is `https://github.com/<owner>/<repo>` for a github.com identity and
   * null for any other remote; commit links are built from it alone.
   */
  links: {
    vscode: string | null;
    checkout: string;
    pr: string | null;
    repo: string | null;
    branch: string | null;
  };
  /** Current execution session, or null when none was ever attached. */
  session: SessionView | null;
  /**
   * Every claude-code session ever attached (all `session.attached` events, not the timeline
   * cap), newest first, one per ref. The first is the one the Session tab reads.
   */
  claudeSessions: ClaudeSession[];
  /** Null for finished jobs; otherwise whether and how a session may resume it. */
  resume: Resume | null;
  resumeCommand: string;
  /** Ids of the jobs this one replaced (`job.supersededBy` names its own replacement). */
  supersedes: string[];
  /** Set exactly when the PR is recorded merged: the Git tab's merged summary and history. */
  merge: MergeView | null;
}

export interface ClaudeSession {
  /** The Claude Code session UUID (`claude --resume <ref>`). */
  ref: string;
  attachedAt: string;
}

/** A subagent of the tied session, from its `agent-<id>.meta.json`; null where the meta is missing. */
export interface SessionAgent {
  id: string;
  type: string | null;
  description: string | null;
}

export type SessionEntryKind = 'user' | 'assistant' | 'tool' | 'result' | 'error';

/** One normalized transcript record: plain text, capped at `ENTRY_TEXT_MAX`. */
export interface SessionEntry {
  at: string;
  kind: SessionEntryKind;
  text: string;
  /** The text was cut at `ENTRY_TEXT_MAX`. */
  truncated: boolean;
  /** Null for the main session. */
  agent: SessionAgent | null;
}

/** One file read: `main` or `agent-<id>`, with how much of it was read from its end. */
export interface SessionFile {
  source: string;
  size: number;
  bytesRead: number;
  truncated: boolean;
  modifiedAt: string;
}

export interface SubagentSummary extends SessionAgent {
  /** The meta file's `finished`; null when absent or not a boolean. */
  finished: boolean | null;
  modifiedAt: string;
}

/**
 * The Session tab: a bounded, read-only tail of the job's Claude Code transcript and its
 * subagents' transcripts (src/server/transcript.ts). `found: false` carries the reason.
 */
export interface SessionLogView {
  found: boolean;
  reason: string | null;
  /** The claude-code session UUID read, or null when the job has none attached. */
  ref: string | null;
  /**
   * The command the job's own session runs (through /factory) to tie itself to the job; named for
   * reference only, never as something the dashboard user runs (it needs the owner's token).
   */
  attach: string;
  /** How many project directories hold `<ref>.jsonl`; the newest-modified one is read. */
  matches: number;
  /** Every file read (`main` and each subagent), newest-modified first, the order the budget took. */
  files: SessionFile[];
  subagents: SubagentSummary[];
  /** Subagent files not read because of `MAX_SUBAGENT_FILES`. */
  subagentsNotRead: number;
  /** Main and subagent entries merged by timestamp, newest first. */
  entries: SessionEntry[];
  /** A file was cut, or a cap (files, bytes, entries, response size) was hit. */
  truncated: boolean;
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
