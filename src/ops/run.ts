/**
 * The foreground factory controller behind `orch start`, `orch do`, and `orch resume` (decision
 * 2026-11-21-foreground-factory-runner): take a ticket from the queue, run its job with the
 * existing /factory skill in a `claude -p` child, read GitHub's CI verdict where no agent is
 * needed, merge through `mergeJob`, and go on to the next ticket. It sequences what exists and
 * decides nothing about a job's stages: every step re-reads the job row, so calling `runTicket`
 * again after any interruption continues from wherever the durable state is.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  CheckoutTimeoutError,
  LostLockError,
  OrchError,
  OwnershipError,
  ToolError,
  UsageError,
  ValidationError,
} from '../core/errors.ts';
import { apiUnreachable, claudeLimit, limitUntil } from '../core/claude-limit.ts';
import { runForeground } from '../core/exec.ts';
import { installRoot, jobArtifactDir } from '../core/paths.ts';
import { leaseExpired } from '../core/ownership.ts';
import { OWN_ALLOWANCE_MODELS } from '../core/roles.ts';
import { orderTickets, ticketKey } from '../core/tickets.ts';
import {
  endsRun,
  now,
  personMergeStep,
  TERMINAL_STATUSES,
  transientGitHubError,
} from '../core/workflow.ts';
import {
  type ChildExit,
  type ClaudeChild,
  launchClaude,
  type LaunchInput,
} from '../integrations/claude-session.ts';
import type { TokenCounts } from '../server/types.ts';
import { listArtifacts } from '../storage/artifacts.ts';
import type { Store } from '../storage/client.ts';
import { eventsAfter, latestEventsByJob, listEvents, maxEventId } from '../storage/events.ts';
import {
  attachSession,
  claimJob,
  getJob,
  mergeEvidence,
  recordEvent,
  releaseJob,
  renewLease,
} from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import { ticketJobs } from '../storage/tickets.ts';
import { type ChoiceLink, choiceLinks, needsHuman } from './actions.ts';
import { BASE_FAILING, needsHumanLines } from './run-report.ts';
import { dispatchJob } from './dispatch.ts';
import { loadConfig, resumeFactoryJob, specResumeSteps } from './factory.ts';
import { transitionGuarded } from './gates.ts';
import { reconcileCi } from './github.ts';
import { buildStamp, type InstallBuild, installBuild, REBUILD_STEPS } from './install-build.ts';
import { mailWatermark, reportJobMail, reportRunMail } from './mail.ts';
import { mergeAuthorized, mergeJob } from './merge.ts';
import { mergedHead } from './merge-view.ts';
import { type LimitRecord, limitRecord, neededFallbacks } from './model-limit.ts';
import { runnerScope, scopesOverlap, ticketRunnerScope } from './repo.ts';
import {
  acquireRunnerLock,
  awaitsPerson,
  childIdentity,
  childMayBeAlive,
  clearStop,
  interruptedRefusal,
  readSession,
  requestStop,
  type RunnerLock,
  type RunnerSession,
  type RunnerSlot,
  runnerSlots,
  slotName,
  slotOpen,
  slotPid,
  type StopRequests,
  stopRequests,
  type TicketOutcome,
  type TicketResult,
  writeSession,
} from './runner-state.ts';
import { finishLines, listTickets, showTicket } from './tickets.ts';
import { jobSeconds, jobTokens, recordSession } from './token-usage.ts';
import { sleep } from './verify-lock.ts';

/** The controller's owner identity on every job it runs; its Claude child claims under it too. */
export const RUNNER_SESSION = 'orch-runner';
/** A Claude session that ends this many times in a row without moving the job stops the ticket. */
export const MAX_IDLE_LAUNCHES = 2;
/** CI observations of one job by the controller itself before it gives the ticket up. */
export const CI_MAX_POLLS = 60;
/** Attempts at a step that failed for a passing reason (GitHub unreadable, mergeability unknown). */
export const TRANSIENT_ATTEMPTS = 5;
export const RETRY_SECONDS = 30;
/**
 * Waits before each retry of a GitHub call that failed transiently (`transientGitHubError`):
 * 1, 2, 4, 8, 16 minutes, so at most six attempts at one step (decision
 * 2026-11-25-bounded-github-retry).
 */
export const GITHUB_BACKOFF_SECONDS: readonly number[] = [60, 120, 240, 480, 960];
/**
 * How the controller waits out an account usage limit, a rate limit, or an unreachable API before
 * relaunching the same job (decision 2026-11-26-controller-waits-for-limits).
 */
export interface LimitWaits {
  /** Waiting in a row, over every kind, before the run stops resumably; also the farthest reset waited for. */
  boundSeconds: number;
  /** Added to a parsed reset time. */
  marginSeconds: number;
  /** Between relaunches when a usage limit gave no parsed reset. */
  probeSeconds: number;
  /** A rate limit or an unreachable API: the n-th wait in a row; the last one repeats. */
  backoffSeconds: readonly number[];
}
export const LIMIT_WAITS: LimitWaits = {
  boundSeconds: 12 * 3600,
  marginSeconds: 60,
  probeSeconds: 30 * 60,
  backoffSeconds: [60, 120, 240, 480, 900],
};
/**
 * How the controller waits for a ticket's checkout that did not answer Git at dispatch
 * (`CheckoutTimeoutError`) before dispatching the same ticket again: the n-th wait in a row (the
 * last one repeats), at most `boundSeconds` in total, then the run stops resumably (decision
 * 2026-11-27-controller-waits-for-slow-git).
 */
export const CHECKOUT_WAITS = {
  boundSeconds: 30 * 60,
  backoffSeconds: [15, 30, 60, 120] as readonly number[],
};
export type CheckoutWaits = typeof CHECKOUT_WAITS;
const POLL_MS = 2000;
const BEAT_MS = 30_000;
/** The stop code of a child that hit a Claude usage or rate limit; the run stays resumable. */
const USAGE_LIMIT = 'usage-limit';
/** The stop code of a child that could not reach the Claude API past the wait's bound. */
const API_UNREACHABLE = 'api-unreachable';
/** The stop code of a ticket whose checkout did not answer Git past the checkout wait's bound. */
const CHECKOUT_TIMEOUT = 'checkout-timeout';
export const REBUILT_REASON = 'orch was rebuilt since this controller started; run orch resume';
/**
 * Run-wide stops that leave the session unfinished with its ticket in flight, for `orch resume`
 * (decisions 2026-11-24-usage-limit-ends-run-resumably, 2026-11-25-environment-stops-are-resumable,
 * 2026-11-26-controller-waits-for-limits, 2026-11-27-controller-waits-for-slow-git).
 */
const RESUMABLE_CODES: readonly string[] = [
  USAGE_LIMIT,
  API_UNREACHABLE,
  CHECKOUT_TIMEOUT,
  'orch-rebuilt',
  'bad-config',
];
const resumable = (code: string | undefined): boolean =>
  code !== undefined && RESUMABLE_CODES.includes(code);

/** The validation message of a `factory.json` that `loadConfig` rejects, or null when it loads. */
function configProblem(store: Store): string | null {
  try {
    loadConfig(store);
    return null;
  } catch (err) {
    if (err instanceof ValidationError) return err.message;
    throw err;
  }
}

export interface RunOptions {
  /** Starts the Claude child; tests replace it. */
  launch?: ((input: LaunchInput) => ClaudeChild) | undefined;
  /** Resolves after `ms`; tests replace it to skip the waits. */
  sleep?: ((ms: number) => Promise<unknown>) | undefined;
  log?: ((line: string) => void) | undefined;
  /** Aborting it is `orch stop`: Ctrl+C in the controller's terminal. */
  signal?: AbortSignal | undefined;
  /** How often the stop request and the child are looked at. */
  pollMs?: number | undefined;
  /** When the process at a PID started (`processStartMs`); tests replace it. */
  startTime?: ((pid: number) => number | null) | undefined;
  /** CI observations before giving the ticket up; tests lower it. Defaults to `CI_MAX_POLLS`. */
  ciMaxPolls?: number | undefined;
  /** Waits before retrying a transient GitHub failure; tests shorten it. Defaults to `GITHUB_BACKOFF_SECONDS`. */
  githubBackoff?: readonly number[] | undefined;
  /** The limit and outage waits; tests shorten them. Defaults to `LIMIT_WAITS`. */
  limitWaits?: Partial<LimitWaits> | undefined;
  /** The slow-checkout waits at dispatch; tests shorten them. Defaults to `CHECKOUT_WAITS`. */
  checkoutWaits?: Partial<CheckoutWaits> | undefined;
  /** The installed build's identity (`buildStamp`); tests replace it. */
  build?: (() => string | null) | undefined;
  /** How often the session heartbeat runs; tests shorten it. Defaults to `BEAT_MS`. */
  beatMs?: number | undefined;
}

export interface RunSummary {
  /** Why the session ended. */
  reason: string;
  /** Ended by `orch stop` (or Ctrl+C): the session is left for `orch resume`. */
  stopped: boolean;
  /** Ended run-wide by a rebuilt `orch` or a bad `factory.json`; left for `orch resume`. */
  interrupted: boolean;
  attempted: number;
  /** Tickets whose merge was verified and whose lifecycle says done. */
  completed: number;
  blocked: number;
  relands: number;
  elapsedSeconds: number;
  tickets: TicketResult[];
  skipped: RunnerSession['skipped'];
  /** The `done` tickets with the evidence of their result job: display only, nothing decides from it. */
  merged: MergedTicket[];
  /** Tickets whose job still waits in needs-human, with its choices: display only, like `merged`. */
  waiting: WaitingJob[];
  /**
   * Set only when the run halted on `orch-rebuilt`: the session is handed to the new build's
   * `orch resume` (`handOff`). `repo` names the slot to resume (`--repo`); null is the unscoped one.
   */
  handoff?: { repo: string | null };
}

/** A job waiting in needs-human as the terminal shows it (`needsHuman`), derived when rendered. */
export interface WaitingJob {
  ticketId: number;
  jobId: string;
  needed: string;
  choices: ChoiceLink[];
}

/** The job's needs-human view, or null; never throws, so it never stops the controller. */
export function waitingJob(store: Store, ticketId: number, jobId: string): WaitingJob | null {
  try {
    const view = needsHuman(store, getJob(store.db, jobId));
    if (view === null) return null;
    return { ticketId, jobId, needed: view.needed, choices: choiceLinks(jobId, view) };
  } catch {
    return null;
  }
}

/** A merged ticket's head, receipt link, and recorded cost, all of its result job only. */
export interface MergedTicket {
  ticketId: number;
  title: string;
  jobId: string;
  /** GitHub's PR head at merge time (`mergedHead`); null if unknown. */
  head: string | null;
  mergeCommit: string | null;
  /** The receipt: the PR body carries the merge receipt (`writeReceipt`). */
  prUrl: string | null;
  /** Summed `runner.session` seconds; null when none is recorded. */
  seconds: number | null;
  tokens: TokenCounts | null;
}

interface Run {
  store: Store;
  session: RunnerSession;
  /** The key of the controller slot this run holds; none is the unscoped slot. */
  slot: string | undefined;
  launch: (input: LaunchInput) => ClaudeChild;
  log: (line: string) => void;
  pollMs: number;
  ciMaxPolls: number;
  githubBackoff: readonly number[];
  limitWaits: LimitWaits;
  checkoutWaits: CheckoutWaits;
  /**
   * Own-allowance limits with no known reset, remembered for this controller process only
   * (decision 2026-11-26-per-model-limit-falls-back); ones with a reset time are read from events.
   */
  limits: LimitRecord[];
  /** Whether this controller still holds the lock it took. */
  owned(): boolean;
  /**
   * Throws `LostLockError` once another controller took the lock. Every write and every job step
   * passes it first; nothing turns the error into a ticket result.
   */
  assertOwned(): void;
  save(): void;
  stopNow(): boolean;
  /** Wait `seconds`, returning early once a stop-now request is seen. */
  wait(seconds: number): Promise<void>;
  pause(ms: number): Promise<unknown>;
  /**
   * Checked before each ticket and each child launch: a rebuilt `orch` or a `factory.json` that
   * fails validation, as the run-wide stop it is; null when neither.
   */
  environment(): Blocked | null;
}

/** `code` says which budget or refusal stopped the job; it goes on `runner.stopped`. */
interface Blocked {
  kind: 'blocked';
  code: string;
  reason: string;
}
type JobRun = { kind: 'finished' } | { kind: 'stopped' } | Blocked;

/**
 * What the controller itself did to a job, on the job's own event log: `runner.session` (one
 * Claude child, from start to exit) and `runner.stopped` (the controller gave the ticket up
 * without completing it). They describe the controller, never the job's stage or status.
 */
interface Note {
  type: 'runner.session' | 'runner.stopped';
  payload: Record<string, unknown>;
}

/**
 * Leave a job as it is for whoever continues it: as its owner, record `note` when there is one,
 * then release. Only a job the controller holds or nobody holds is touched; one another session
 * holds is theirs, and nothing is written to it. Returns why it could not be done, or null:
 * never throws, so evidence cannot change what happened to the ticket.
 */
function leave(store: Store, jobId: string, note?: (job: Job) => Note | null): string | null {
  try {
    const job = getJob(store.db, jobId);
    if (job.ownerSession !== null && job.ownerSession !== RUNNER_SESSION) return null;
    const n = note?.(job) ?? null;
    if (n === null && job.ownerSession === null) return null;
    const { token } = claimJob(store, jobId, { session: RUNNER_SESSION });
    try {
      if (n !== null) recordEvent(store, jobId, { token }, n.type, n.payload);
    } finally {
      releaseJob(store, jobId, { token });
    }
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

/** How the queue took the ticket, for a `runner.*` payload; absent for `orch do`. */
const pickOf = (session: RunnerSession) => (session.pick ? { pick: session.pick } : {});

function leaveJob(run: Run, jobId: string, note?: (job: Job) => Note | null): void {
  run.assertOwned();
  const problem = leave(run.store, jobId, note);
  if (problem !== null) run.log(`  job ${jobId}: could not be recorded and released: ${problem}`);
}

/**
 * Record `models.*` events on a job as its owner, in one claim, then release it. False when it
 * could not be done (another session holds the job): the caller then changes nothing.
 */
function recordModelEvents(
  run: Run,
  jobId: string,
  events: { type: string; payload: Record<string, unknown> }[],
): boolean {
  run.assertOwned();
  try {
    const { token } = claimJob(run.store, jobId, { session: RUNNER_SESSION });
    try {
      for (const e of events) recordEvent(run.store, jobId, { token }, e.type, e.payload);
    } finally {
      releaseJob(run.store, jobId, { token });
    }
    return true;
  } catch (err) {
    if (!(err instanceof OrchError)) throw err;
    run.log(`  job ${jobId}: model events not recorded: ${err.message}`);
    return false;
  }
}

/**
 * Record `models.fallback` for every role of the job whose model is exhausted. True when at least
 * one was recorded; false when none is needed, when a role has no other model in its pool (all or
 * nothing: the account-wide path), or when the job could not be written.
 */
function fallBack(run: Run, jobId: string): boolean {
  const needed = neededFallbacks(run.store, jobId, run.limits);
  if (needed === null || needed.length === 0) return false;
  if (
    !recordModelEvents(
      run,
      jobId,
      needed.map((payload) => ({ type: 'models.fallback', payload })),
    )
  ) {
    return false;
  }
  for (const f of needed) {
    run.log(
      `  job ${jobId}: ${String(f['role'])} falls back from ${String(f['from'])} to ${String(f['to'])}`,
    );
  }
  return true;
}

/** The line of what the child left that `claudeLimit` reads as a limit. */
function limitLine(exit: ChildExit): string {
  const lines = [exit.stderrTail ?? '', exit.result?.result ?? ''].flatMap((t) => t.split(/\r?\n/));
  return lines.find((l) => claudeLimit(l, null) !== null) ?? '';
}

/** Events that follow a stop without anything having happened to the job. */
const AFTER_STOP = /^(job\.(claimed|released)|mail\.)/;

/** The same stop is already the last thing on record: `orch do` again changed nothing. */
function sameStop(store: Store, jobId: string, code: string, reason: string): boolean {
  const events = listEvents(store.db, jobId, 20).reverse();
  const i = events.findIndex((e) => e.type === 'runner.stopped');
  const last = events[i];
  if (last === undefined) return false;
  return (
    last.payload['code'] === code &&
    last.payload['reason'] === reason &&
    events.slice(0, i).every((e) => AFTER_STOP.test(e.type))
  );
}

/** What a Claude session must change for its run to count as progress. */
function progressOf(store: Store, job: Job): string {
  const artifacts = listArtifacts(store.db, job.id).length;
  return [job.stage, job.round, job.ciRepairs, artifacts].join(':');
}

function promptFor(job: Job): string {
  return (
    `/factory ${job.id}\n\n` +
    `Factory job ${job.id} for ${job.repo}: ${job.title}. This session was started by orch start ` +
    `and nobody can answer it: pass --session ${RUNNER_SESSION} to every orch command that takes ` +
    'one, run every subagent and orch verify in the foreground, and do not end your turn while ' +
    'the plan still has a step for you. End it when the job is completed, waits in needs-human, ' +
    'is cancelled, or the plan tells you to release it. Never merge; orch does that afterwards.'
  );
}

interface ChildRun {
  exit: ChildExit;
  /** Ended by a stop request, not on its own. */
  stopped: boolean;
  /** 0 when the process never started. */
  pid: number;
  /** The `--session-id` it was started with, attached to the job. */
  sessionId: string;
}

/** One Claude session on the job, from claim to exit. Throws when another session holds the job. */
async function runChild(run: Run, job: Job): Promise<ChildRun> {
  const { store, session } = run;
  run.assertOwned();
  // Claim under the controller's name and make sure the worktree exists: the child's own
  // `orch factory resume` then renews this claim instead of meeting a foreign lease.
  const resumed = resumeFactoryJob(store, job.id, { session: RUNNER_SESSION });
  const cwd = resumed.job.worktreePath ?? job.repoPath;
  const env: NodeJS.ProcessEnv = { ...process.env, ORCH_SESSION: RUNNER_SESSION };
  delete env['ORCH_TOKEN'];
  const args = loadConfig(store).runnerClaudeArgs;
  // The conversation's id is fixed up front and tied to the job before the child starts, so the
  // Session tab reads its transcript from the first minute.
  const sessionId = randomUUID();
  attachSession(store, job.id, {
    session: { provider: 'claude-code', ref: sessionId, cwd },
    token: resumed.token,
  });
  run.assertOwned();
  const child = run.launch({
    cwd,
    prompt: promptFor(job),
    args,
    name: `factory ${job.id}`,
    sessionId,
    env,
    onLine: (line) => {
      run.log(`  claude: ${line}`);
    },
  });
  session.child = { pid: child.pid, startedAt: child.startedAt };
  let exit: ChildExit | undefined;
  let stopped = false;
  let lost: LostLockError | null = null;
  void child.done.then((e) => (exit = e));
  try {
    run.save();
  } catch (err) {
    if (err instanceof LostLockError) {
      child.kill();
      await child.done;
    }
    throw err;
  }
  run.log(`  claude: started (pid ${String(child.pid)}) in ${cwd}`);
  // Only the process ending ends the wait: a quiet session is a working one. A lost lock ends
  // the child the way a stop request does, and the error goes up once it has exited.
  while (exit === undefined) {
    if (!stopped && lost === null) {
      try {
        if (run.stopNow()) {
          stopped = true;
          run.log('  claude: stopping on request');
          child.kill();
        }
      } catch (err) {
        if (!(err instanceof LostLockError)) throw err;
        lost = err;
        run.log('  claude: stopping: another controller took the lock');
        child.kill();
      }
    }
    await Promise.race([child.done, run.pause(run.pollMs)]);
  }
  if (lost !== null) throw lost;
  session.child = null;
  run.save();
  return { exit, stopped, pid: child.pid, sessionId };
}

/**
 * The ci stage needs no agent: read GitHub as the job's owner until the verdict acts (complete,
 * rework to build, escalate), the way the recovery worker does. Null when the stage moved on.
 */
async function pollCi(run: Run, jobId: string): Promise<JobRun | null> {
  const { store } = run;
  run.assertOwned();
  const { token } = resumeFactoryJob(store, jobId, { session: RUNNER_SESSION });
  const auth = { token };
  // Failures in a row: transient ones back off on `githubBackoff`, others retry on `RETRY_SECONDS`.
  let failures = 0;
  let transient = 0;
  try {
    for (let polls = 0; polls < run.ciMaxPolls; polls++) {
      if (run.stopNow()) return { kind: 'stopped' };
      const job = getJob(store.db, jobId);
      if (job.stage !== 'ci') return null;
      if (job.status !== 'running') transitionGuarded(store, jobId, 'start', auth);
      let waitSeconds = RETRY_SECONDS;
      try {
        const r = reconcileCi(store, jobId, auth);
        failures = 0;
        transient = 0;
        run.log(`  ci: ${r.action}: ${r.reason}`);
        if (r.action !== 'wait') return null;
        // The base fails the same checks: no wait here; the job is released and taken again
        // after another ticket lands (`runQueue`), or by orch start or orch do later.
        if (r.outcome === 'base-failing') {
          return { kind: 'blocked', code: BASE_FAILING, reason: r.reason };
        }
        waitSeconds = r.waitSeconds ?? RETRY_SECONDS;
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        const passing = transientGitHubError(err.message);
        if (passing) transient += 1;
        else failures += 1;
        run.log(`  ci: could not read GitHub (${err.message})`);
        if (passing ? transient > run.githubBackoff.length : failures >= TRANSIENT_ATTEMPTS) {
          return {
            kind: 'blocked',
            code: 'github-unreadable',
            reason: `GitHub could not be read ${String(failures + transient)} times in a row: ${err.message}`,
          };
        }
        if (passing) waitSeconds = run.githubBackoff[transient - 1] ?? RETRY_SECONDS;
      }
      await run.wait(waitSeconds);
    }
    return {
      kind: 'blocked',
      code: 'ci-pending',
      reason: `CI was still pending after ${String(run.ciMaxPolls)} observations by the controller`,
    };
  } finally {
    // Completing released it already; anything else goes back for whoever continues the job.
    // After a lost lock the lease is left for the controller that took over (same name).
    if (run.owned() && getJob(store.db, jobId).ownerToken === token) {
      releaseJob(store, jobId, auth);
    }
  }
}

/**
 * Wait `seconds` for a limit or an outage with `wait` on the session record, checking every
 * `pollMs` for `orch stop`, `orch stop next`, and Ctrl+C. True when one ended it. The record is
 * cleared however it ends.
 */
async function waitOut(
  run: Run,
  wait: NonNullable<RunnerSession['wait']>,
  seconds: number,
): Promise<boolean> {
  const stop = () => run.stopNow() || stopRequests(run.store.paths, run.slot).next;
  run.session.wait = wait;
  run.save();
  try {
    for (let left = seconds * 1000; left > 0; left -= run.pollMs) {
      if (stop()) return true;
      await run.pause(Math.min(left, run.pollMs));
    }
    return stop();
  } finally {
    run.session.wait = null;
    if (run.owned()) run.save();
  }
}

/**
 * Drive one job until it is finished (completed, cancelled, or waiting in needs-human), a stop
 * was requested, or a budget is spent. Agent stages run in a Claude child; the ci stage is read
 * here. The caller reads the job row for what "finished" means.
 */
export async function runJob(run: Run, jobId: string): Promise<JobRun> {
  const { store } = run;
  let idle = 0;
  // Seconds waited in a row on limits and outages, and how many waits; a launch that moves the
  // job or ends any other way resets both.
  let waited = 0;
  let waits = 0;
  const reset = () => {
    waited = 0;
    waits = 0;
  };
  for (;;) {
    if (run.stopNow()) return { kind: 'stopped' };
    const job = getJob(store.db, jobId);
    if (TERMINAL_STATUSES.includes(job.status) || job.stage === 'needs-human') {
      return { kind: 'finished' };
    }
    if (job.stage === 'ci' && job.prUrl !== null) {
      const ci = await pollCi(run, jobId);
      if (ci !== null) return ci;
      continue;
    }
    if (idle >= MAX_IDLE_LAUNCHES) {
      return {
        kind: 'blocked',
        code: 'no-progress',
        reason:
          `the Claude session ended ${String(idle)} times without moving the job ` +
          `(still ${job.stage}/${job.status})`,
      };
    }
    const env = run.environment();
    if (env !== null) return env;
    // A role drawn as a model whose own allowance is spent runs the next one in its pool.
    fallBack(run, jobId);
    const mark = maxEventId(store.db);
    const before = progressOf(store, job);
    const startedMs = Date.now();
    const { exit, stopped, pid, sessionId } = await runChild(run, job);
    const after = getJob(store.db, jobId);
    const moved = progressOf(store, after) !== before;
    // The exit code is a hint; the job row is the outcome. `exited` says only that the process
    // ended on its own, and `moved` only that the job is somewhere else than before.
    leaveJob(run, jobId, () => ({
      type: 'runner.session',
      payload: {
        outcome: stopped ? 'stopped' : exit.error !== null ? 'failed' : 'exited',
        exitCode: exit.code,
        signal: exit.signal,
        error: exit.error,
        pid: pid === 0 ? null : pid,
        seconds: Math.round((Date.now() - startedMs) / 1000),
        moved,
        stage: after.stage,
        status: after.status,
        // What the child left behind, for when it failed: evidence, never decided on.
        sessionId,
        stderrTail: exit.stderrTail ?? null,
        result: exit.result ?? null,
        ...pickOf(run.session),
      },
    }));
    // The session ended: record its token counts once. Evidence only, like the note above.
    try {
      const problem = recordSession(store, jobId, sessionId, 'runner');
      if (problem !== null) run.log(`  usage: session ${sessionId} not recorded: ${problem}`);
    } catch (err) {
      run.log(`  usage: session ${sessionId} not recorded: ${(err as Error).message}`);
    }
    if (stopped) return { kind: 'stopped' };
    if (moved) reset();
    // A spent account or an unreachable API would fail every ticket the same way: wait it out
    // here and relaunch the same job, never counting the exit as idle; past the bound, end the run
    // resumably (decision 2026-11-26-controller-waits-for-limits).
    const limit = claudeLimit(exit.stderrTail, exit.result);
    // Limits the session reported for a subagent (`orch job limit`) while this child ran, and the
    // child's own when it names a model: recorded here, since the child could not.
    const hits = eventsAfter(store.db, jobId, mark, ['models.limit']).map(
      (e) => e.payload as unknown as LimitRecord,
    );
    if (limit !== null && limit.model !== null) {
      const own = limitRecord(limit.model, limitLine(exit));
      recordModelEvents(run, jobId, [{ type: 'models.limit', payload: { ...own } }]);
      hits.push(own);
    }
    const limited = limit !== null || hits.length > 0;
    const unreachable = limited ? null : apiUnreachable(exit.stderrTail, exit.result);
    if (limited || unreachable !== null) {
      // Only a model with an allowance of its own falls back, and only when every affected role
      // has another model (decision 2026-11-26-per-model-limit-falls-back); else the run waits.
      // (`limit?.model` is undefined when only the session reported one.)
      if (
        limited &&
        limit?.model !== null &&
        hits.every((h) => OWN_ALLOWANCE_MODELS.includes(h.model))
      ) {
        run.limits.push(...hits.filter((h) => h.until === null));
        if (fallBack(run, jobId)) continue;
      }
      const ws = run.limitWaits;
      const rate = limit?.limit === 'rate limit';
      // The earliest known reset of the limit and the hits; ISO times sort as text.
      const until = rate
        ? null
        : ([limitUntil(limit?.resetsAt), ...hits.map((h) => h.until)]
            .filter((u): u is string => u !== null)
            .sort()[0] ?? null);
      const backoff = ws.backoffSeconds[Math.min(waits, ws.backoffSeconds.length - 1)] ?? 0;
      const toReset =
        until === null ? null : Math.max(0, Math.ceil((Date.parse(until) - Date.now()) / 1000));
      const probe = limited && !rate;
      const seconds =
        toReset === null ? (probe ? ws.probeSeconds : backoff) : toReset + ws.marginSeconds;
      if (waited + (toReset ?? seconds) > ws.boundSeconds) {
        if (unreachable !== null) {
          return {
            kind: 'blocked',
            code: API_UNREACHABLE,
            reason: `the Claude API could not be reached (${unreachable.slice(0, 200)}); orch resume continues the session`,
          };
        }
        const resets = until ?? limit?.resetsAt ?? null;
        return {
          kind: 'blocked',
          code: USAGE_LIMIT,
          reason: `Claude ${limit?.limit ?? 'usage limit'} reached${resets === null ? '' : ` (resets ${resets})`}; orch resume continues the session`,
        };
      }
      const wait = {
        reason:
          unreachable !== null
            ? 'the next try at reaching the Claude API'
            : rate
              ? 'the next try after a rate limit'
              : until !== null
                ? 'the usage limit to reset'
                : 'the next usage limit probe',
        until: new Date(
          (until === null ? Date.now() : Date.parse(until)) +
            (until === null ? seconds : ws.marginSeconds) * 1000,
        ).toISOString(),
      };
      run.log(
        `  claude: ${unreachable ?? limitLine(exit)}; waiting for ${wait.reason} at ${wait.until}`,
      );
      if (await waitOut(run, wait, seconds)) return { kind: 'stopped' };
      waited += seconds;
      waits += 1;
      continue;
    }
    reset();
    run.log(
      `  claude: exited (${exit.error ?? `code ${String(exit.code ?? exit.signal)}`}); ` +
        `job is ${after.stage}/${after.status}`,
    );
    if (exit.error !== null) {
      return { kind: 'blocked', code: 'claude-failed', reason: `claude: ${exit.error}` };
    }
    idle = moved ? 0 : idle + 1;
  }
}

/** Why `orch` may not merge in the ticket's repository without a click, or null when it may. */
export function mergeNotEnabled(
  store: Store,
  t: { repo: string; repoPath: string },
): string | null {
  if (mergeAuthorized(store, t.repo)) return null;
  return (
    `merging without a human click is not enabled for ${t.repo}, so the ticket is not started; ` +
    `enable it with: orch factory config merge enable --repo "${t.repoPath}"`
  );
}

type MergeRun =
  | { kind: 'done' }
  | { kind: 'reland'; jobId: string }
  | { kind: 'continue' }
  | { kind: 'stopped' }
  | Blocked;

/**
 * `mergeJob` until it gives an answer that is not "try again", within a small budget: an unknown
 * mergeability waits `RETRY_SECONDS` up to `TRANSIENT_ATTEMPTS` times; an `error` or a
 * `github-refused` the rule calls transient backs off on `githubBackoff`.
 */
async function merge(run: Run, jobId: string): Promise<MergeRun> {
  let waits = 0;
  let retries = 0;
  for (let attempt = 1; ; attempt++) {
    run.assertOwned();
    const m = mergeJob(run.store, jobId, { session: RUNNER_SESSION });
    run.log(`  merge: ${m.outcome}${m.code ? ` (${m.code})` : ''}: ${m.reason}`);
    switch (m.outcome) {
      case 'merged':
      case 'already_merged':
        // Merged is not enough: only the head CI passed on counts, and only the ticket's own
        // lifecycle says it is done.
        if (!m.verified) {
          return {
            kind: 'blocked',
            code: 'unverified-merge',
            reason: `unverified merge: ${m.reason}`,
          };
        }
        if (m.ticket?.completed) return { kind: 'done' };
        return {
          kind: 'blocked',
          code: 'ticket-open',
          reason: `merged, but the ticket stays ${m.ticket?.status ?? 'open'}: ${m.ticket?.reason ?? 'not closed'}`,
        };
      case 'base-moved':
        // The job is back in pr (or build) on a merge commit: runJob takes it from there.
        return { kind: 'continue' };
      case 'reland':
        if (m.relandJob !== null) return { kind: 'reland', jobId: m.relandJob };
        return { kind: 'blocked', code: 'reland-refused', reason: m.reason };
      case 'blocked': {
        const code = m.code ?? 'merge-blocked';
        if (code !== 'github-refused' || !transientGitHubError(m.reason)) {
          return { kind: 'blocked', code, reason: `${code}: ${m.reason}` };
        }
        if (retries >= run.githubBackoff.length) {
          return {
            kind: 'blocked',
            code,
            reason: `${code} in ${String(attempt)} attempts: ${m.reason}`,
          };
        }
        break;
      }
      case 'waiting':
        waits += 1;
        if (waits >= TRANSIENT_ATTEMPTS) {
          return {
            kind: 'blocked',
            code: 'merge-no-answer',
            reason: `merge gave no answer in ${String(attempt)} attempts: ${m.reason}`,
          };
        }
        await run.wait(RETRY_SECONDS);
        if (run.stopNow()) return { kind: 'stopped' };
        continue;
      case 'error':
        if (retries >= run.githubBackoff.length) {
          return {
            kind: 'blocked',
            code: 'merge-no-answer',
            reason: `merge gave no answer in ${String(attempt)} attempts: ${m.reason}`,
          };
        }
        break;
    }
    // A transient failure: back off, then ask mergeJob again.
    await run.wait(run.githubBackoff[retries] ?? 0);
    retries += 1;
    if (run.stopNow()) return { kind: 'stopped' };
  }
}

function blockedReason(store: Store, jobId: string): string {
  const reason = latestEventsByJob(store.db, [jobId], ['job.blocked'])
    .get(jobId)
    ?.get('job.blocked')?.payload['reason'];
  return typeof reason === 'string' ? reason : 'no reason recorded';
}

/**
 * Take one ticket as far as it goes: dispatch its job or pick up the one it has, run it, merge,
 * run the re-land a conflict asks for, and report where it ended. Idempotent: it looks at the
 * ticket's jobs first, so a second call never creates a second job for work already under way,
 * never replaces a cancelled job, and merges nothing twice.
 */
export async function runTicket(run: Run, ticketId: number): Promise<TicketResult> {
  const { store, session } = run;
  const { ticket } = showTicket(store, ticketId);
  const key = ticket.key;
  let relands = 0;
  // Every way out of the ticket passes here, so this is where a job the controller gives up is
  // handed back: with a `runner.stopped` event when it was not completed and not stopped on
  // request. A cancelled job already says why it ended.
  const out = (
    outcome: TicketOutcome,
    reason: string,
    jobId: string | null,
    next: string | null = null,
    code: string = outcome,
  ): TicketResult => {
    // A job waiting in needs-human leads with what is needed and a link per choice; the recorded
    // reason (returned and on `runner.stopped`) is unchanged and printed below.
    const waiting =
      outcome === 'needs-human' && jobId !== null ? waitingJob(store, ticketId, jobId) : null;
    if (waiting === null) run.log(`  ticket ${key}: ${outcome}: ${reason}`);
    else {
      const [head, ...rest] = needsHumanLines(waiting, reason);
      run.log(`  ticket ${key}: ${head ?? ''}`);
      for (const l of rest) run.log(`    ${l}`);
    }
    if (jobId !== null && outcome === 'stopped') leaveJob(run, jobId);
    if (jobId !== null && (outcome === 'blocked' || outcome === 'needs-human')) {
      leaveJob(run, jobId, (job) =>
        job.status === 'cancelled' || sameStop(store, jobId, code, reason)
          ? null
          : {
              type: 'runner.stopped',
              payload: {
                outcome,
                code,
                reason,
                stage: job.stage,
                status: job.status,
                next,
                ...pickOf(session),
              },
            },
      );
    }
    return {
      ticketId,
      title: ticket.title,
      repo: ticket.repo,
      jobId,
      outcome,
      code,
      reason,
      relands,
      next,
    };
  };
  run.log(`ticket ${key} [${ticket.repo}] ${ticket.title}`);
  if (ticket.status === 'done') return out('done', 'the ticket is already done', null);
  if (ticket.status !== 'open' && ticket.status !== 'in-progress') {
    return out('refused', `the ticket is ${ticket.status}`, null);
  }

  // The unfinished job if there is one; else, for a ticket still in progress, its last job. An
  // open ticket (never started, reopened by a person or by cancelling its job) gets a new job
  // whatever its history.
  const jobs = ticketJobs(store.db, ticketId);
  let job =
    jobs.find((j) => !TERMINAL_STATUSES.includes(j.status)) ??
    (ticket.status === 'in-progress' ? jobs.at(-1) : undefined);
  if (job?.status === 'cancelled') {
    return out(
      'blocked',
      `job ${job.id} was cancelled; a cancelled job is not replaced automatically`,
      job.id,
      `orch ticket reopen ${key} queues the ticket for a new job`,
    );
  }
  // `orch do --fast` decides the mode of a job created for its own ticket, and nothing else.
  const fast = session.fast === true && session.ticket === ticketId;
  if (job === undefined) {
    const refused = mergeNotEnabled(store, ticket);
    if (refused !== null) return out('refused', refused, null);
    // Seconds waited in a row for a checkout that did not answer Git, and how many waits.
    let waited = 0;
    let waits = 0;
    while (job === undefined) {
      run.assertOwned();
      try {
        job = dispatchJob(store, {
          ticket: ticketId,
          session: RUNNER_SESSION,
          cwd: ticket.repoPath,
          mode: fast ? 'fast' : 'full',
        }).job;
      } catch (err) {
        if (!(err instanceof OrchError)) throw err;
        // A slow Git answer is the machine's state, not the ticket's: keep the ticket, wait, and
        // dispatch it again (decision 2026-11-27-controller-waits-for-slow-git).
        if (err instanceof CheckoutTimeoutError) {
          const cw = run.checkoutWaits;
          const seconds = cw.backoffSeconds[Math.min(waits, cw.backoffSeconds.length - 1)] ?? 0;
          if (waited + seconds > cw.boundSeconds) {
            return out(
              'blocked',
              `${err.message} orch resume continues the session`,
              null,
              'orch resume',
              CHECKOUT_TIMEOUT,
            );
          }
          const wait = {
            reason: 'the repository checkout to answer Git',
            until: new Date(Date.now() + seconds * 1000).toISOString(),
          };
          run.log(`  ticket ${key}: ${err.message} Waiting until ${wait.until}`);
          if (await waitOut(run, wait, seconds)) {
            return out(
              'stopped',
              'stopped on request; nothing was dispatched',
              null,
              'orch resume',
            );
          }
          waited += seconds;
          waits += 1;
          const env = run.environment();
          if (env !== null) return out('blocked', env.reason, null, 'orch resume', env.code);
          continue;
        }
        // Losing the claim to another process is an ordinary outcome: its job is the ticket's job.
        const other = showTicket(store, ticketId).ticket.activeJob;
        if (other !== null)
          return out('claimed', `job ${other} was created for it meanwhile`, other);
        const bad = configProblem(store);
        if (bad !== null) return out('blocked', bad, null, 'orch resume', 'bad-config');
        return out('refused', err.message, null);
      }
    }
    run.log(`  job ${job.id}: dispatched${job.mode === 'fast' ? ' (fast)' : ''}`);
  } else {
    run.log(`  job ${job.id}: found in ${job.stage}/${job.status}`);
    if (fast) {
      run.log(
        `  job ${job.id}: --fast applies only to a new job; this one continues in its recorded mode, ${job.mode}`,
      );
    }
  }

  let jobId = job.id;
  const retry = `orch do ${key} tries again; /factory ${jobId} continues the job by hand`;
  try {
    for (;;) {
      session.jobId = jobId;
      run.save();
      const r = await runJob(run, jobId);
      if (r.kind === 'stopped') {
        return out('stopped', 'stopped on request; the job is kept as it is', jobId, 'orch resume');
      }
      if (r.kind === 'blocked') {
        const next = resumable(r.code)
          ? 'orch resume'
          : r.code === BASE_FAILING
            ? `nothing for a person: this session takes it again after another ticket lands, else orch do ${key} once the base is green`
            : retry;
        return out('blocked', r.reason, jobId, next, r.code);
      }
      const after = getJob(store.db, jobId);
      if (after.status === 'cancelled') {
        return out(
          'blocked',
          `job ${jobId} was cancelled; its ticket was reopened`,
          jobId,
          `orch do ${key} runs it with a new job; orch ticket drop ${key} stops it for good`,
        );
      }
      if (after.stage === 'needs-human') {
        return out(
          'needs-human',
          `job ${jobId} waits for a person at ${after.returnStage ?? 'an unknown stage'}: ${blockedReason(store, jobId)}`,
          jobId,
          after.returnStage === 'spec'
            ? specResumeSteps(jobId, jobArtifactDir(jobId, store.paths), ticketId)
            : session.mode === 'queue'
              ? `decide it on the dashboard (orch ui): this orch start session takes it again; once it has ended, orch do ${key}`
              : `decide it on the dashboard (orch ui), then orch do ${key}`,
        );
      }
      const m = await merge(run, jobId);
      if (m.kind === 'done') return out('done', `merged and verified (job ${jobId})`, jobId);
      if (m.kind === 'stopped') return out('stopped', 'stopped on request', jobId, 'orch resume');
      if (m.kind === 'blocked') {
        // A refusal only a person can lift waits for that person, like an escalation (decision
        // 2026-11-23-queue-passes-over-person-merge-blocks).
        const person = personMergeStep(m.code, jobId, key);
        if (person !== null) return out('needs-human', m.reason, jobId, person, m.code);
        // Merged and verified: nothing is left to retry, only the boxes the merge left open.
        const step =
          m.code === 'ticket-open'
            ? `finish the ticket on the dashboard (orch ui), one of: ${finishLines(ticketId).join('; ')}`
            : `orch do ${key} tries again`;
        return out('blocked', m.reason, jobId, step, m.code);
      }
      if (m.kind === 'continue') {
        run.log(`  job ${jobId}: reopened for a moved base`);
        continue;
      }
      relands += 1;
      jobId = m.jobId;
      run.log(`  job ${jobId}: re-land`);
    }
  } catch (err) {
    // A lost lock is never a ticket result: it goes up to the command, which exits.
    if (err instanceof LostLockError || !(err instanceof OrchError)) throw err;
    // A job another session holds is left alone: `leave` writes nothing to it.
    if (err instanceof OwnershipError)
      return out('blocked', err.message, jobId, retry, 'ownership');
    // A config read deeper in the ticket failed: that is the run's problem, not the ticket's.
    const bad = configProblem(store);
    if (bad !== null) return out('blocked', bad, jobId, 'orch resume', 'bad-config');
    return out('blocked', err.message, jobId, retry, 'error');
  }
}

/**
 * Whether the queue passes this ticket over for the rest of the session and goes on: every
 * outcome but done and stopped, unless its code would hit every ticket (`endsRun`, decision
 * 2026-11-23-queue-ends-only-on-run-wide-outcomes).
 */
const passesOver = (r: TicketResult): boolean =>
  r.outcome !== 'done' && r.outcome !== 'stopped' && !endsRun(r.code);

/**
 * Whether the queue continues this in-progress ticket's job (decision
 * 2026-11-24-queue-resumes-stranded-tickets): active, pending or running, not waiting for a
 * person, and nobody holds a live lease on it. Read from the job row, never from events.
 */
function stranded(store: Store, jobId: string | null): boolean {
  if (jobId === null) return false;
  const job = getJob(store.db, jobId);
  return (
    (job.status === 'pending' || job.status === 'running') &&
    job.stage !== 'needs-human' &&
    job.stage !== 'completed' &&
    (job.ownerSession === null || leaseExpired(job, now()))
  );
}

/**
 * Whether a person moved the job on from needs-human: it left that stage, was not cancelled, and
 * no live lease holds it.
 */
function movedOn(store: Store, jobId: string | null): boolean {
  if (jobId === null) return false;
  try {
    const job = getJob(store.db, jobId);
    return (
      job.stage !== 'needs-human' &&
      job.status !== 'cancelled' &&
      (job.ownerSession === null || leaseExpired(job, now()))
    );
  } catch {
    return false;
  }
}

/**
 * One ticket at a time, until none is left, a stop was requested, or one ended with a run-wide
 * outcome. First an escalation a person has since decided (`awaitsPerson`, `movedOn`), taken
 * again; else a stranded in-progress ticket (`stranded`); else the best ready one. Any other
 * ticket that could not be finished is passed over for the rest of the session (`passesOver`);
 * its dependents are not ready until it is done. Returns why it ended, or null when `orch stop`
 * interrupted it.
 */
async function runQueue(
  run: Run,
  attempt: (ticketId: number, pick: RunnerSession['pick']) => Promise<TicketResult>,
): Promise<string | null> {
  const { store, session } = run;
  // Passed-over tickets stay passed over for the session, across `orch resume` too (only a
  // decided escalation is taken again, from `session.results`).
  const isHuman = (r: TicketResult): boolean => r.outcome === 'needs-human';
  const passed = new Set([
    ...session.skipped.map((s) => s.ticketId),
    ...session.results.filter(passesOver).map((r) => r.ticketId),
  ]);
  // A ticket passed over because its base fails the same checks is taken again once another
  // ticket ended done after it (that merge may be the base's fix); results are in the order
  // they ended.
  const retakeForBase = () => {
    const done = session.results.findLastIndex((r) => r.outcome === 'done');
    session.results.forEach((r, i) => {
      if (i < done && r.code === BASE_FAILING) passed.delete(r.ticketId);
    });
  };
  retakeForBase();
  for (;;) {
    if (run.stopNow()) return null;
    if (stopRequests(store.paths, run.slot).next)
      return 'stopped after the current ticket (orch stop next)';
    // Before any ticket is taken, and before `mergeNotEnabled` reads the config.
    const env = run.environment();
    if (env !== null) return env.reason;
    // A ticket passed over for a person whose job a person has since moved on is taken again
    // before anything else (decision 2026-11-24-default-needs-human-choices).
    const again = session.results.find((r) => awaitsPerson(r) && movedOn(store, r.jobId));
    if (again !== undefined) {
      run.log(
        `ticket ${ticketKey(again.ticketId)} taken again: a person moved job ${again.jobId ?? ''} on`,
      );
      passed.delete(again.ticketId);
      const r = await attempt(again.ticketId, 'resume');
      if (r.outcome === 'stopped') return null;
      if (r.outcome === 'done') {
        retakeForBase();
        continue;
      }
      if (!passesOver(r)) return `ticket ${ticketKey(again.ticketId)} is ${r.outcome}: ${r.reason}`;
      passed.add(again.ticketId);
      continue;
    }
    const scope = session.repo === null ? {} : { repo: session.repo };
    // `orderTickets` ranks open tickets only, so the in-progress ones are ranked as if open.
    const inProgress = listTickets(store, { view: 'all', status: 'in-progress', ...scope }).tickets;
    const resume = orderTickets(inProgress.map((t) => ({ ...t, status: 'open' as const }))).find(
      (t) => !passed.has(t.id) && stranded(store, t.activeJob),
    );
    const next =
      resume ??
      listTickets(store, { view: 'ready', ...scope }).tickets.find((t) => !passed.has(t.id));
    if (next === undefined) {
      const human = session.results.filter(isHuman).length;
      const over = passed.size - human;
      const end =
        over > 0
          ? `no ready ticket is left that can be started (${String(over)} passed over)`
          : 'no ready ticket is left';
      return human > 0 ? `${end} (${String(human)} waits for a person)` : end;
    }
    // Reported and passed over, never started: an opt-in is per repository.
    const refused = mergeNotEnabled(store, next);
    if (refused !== null) {
      run.log(`ticket ${next.key} [${next.repo}] passed over: ${refused}`);
      passed.add(next.id);
      session.skipped.push({ ticketId: next.id, reason: refused });
      run.save();
      continue;
    }
    run.log(
      resume === undefined
        ? `ticket ${next.key}: new from ready`
        : `ticket ${next.key}: resuming in-progress job ${resume.activeJob ?? '?'}`,
    );
    const r = await attempt(next.id, resume === undefined ? 'ready' : 'resume');
    if (r.outcome === 'stopped') return null;
    if (r.outcome === 'done') {
      retakeForBase();
      continue;
    }
    if (!passesOver(r)) return `ticket ${next.key} is ${r.outcome}: ${r.reason}`;
    run.log(`ticket ${next.key} passed over: ${r.code ?? r.outcome}`);
    passed.add(next.id);
  }
}

/** What a merged ticket's result job has on record: never estimated, never a second head lookup. */
function mergedTicket(store: Store, r: TicketResult & { jobId: string }): MergedTicket {
  const commit = mergeEvidence(store.db, r.jobId)?.['mergeCommit'];
  return {
    ticketId: r.ticketId,
    title: r.title,
    jobId: r.jobId,
    head: mergedHead(store, r.jobId),
    mergeCommit: typeof commit === 'string' ? commit : null,
    prUrl: getJob(store.db, r.jobId).prUrl,
    seconds: jobSeconds(store, r.jobId),
    tokens: jobTokens(store, r.jobId),
  };
}

function summarize(
  store: Store,
  session: RunnerSession,
  reason: string,
  stopped: boolean,
): RunSummary {
  const count = (...o: TicketOutcome[]) =>
    session.results.filter((r) => o.includes(r.outcome)).length;
  return {
    reason,
    stopped,
    interrupted: false,
    attempted: session.results.length,
    completed: count('done'),
    blocked: count('blocked', 'needs-human', 'refused'),
    relands: session.results.reduce((n, r) => n + r.relands, 0),
    elapsedSeconds: Math.round((Date.now() - Date.parse(session.startedAt)) / 1000),
    tickets: session.results,
    skipped: session.skipped,
    merged: session.results
      .filter(
        (r): r is TicketResult & { jobId: string } => r.outcome === 'done' && r.jobId !== null,
      )
      .map((r) => mergedTicket(store, r)),
    waiting: waitingOf(store, session.results),
  };
}

/** The waiting jobs among `results`, once per job. */
function waitingOf(
  store: Store,
  results: readonly Pick<TicketResult, 'ticketId' | 'jobId'>[],
): WaitingJob[] {
  const seen = new Set<string>();
  const out: WaitingJob[] = [];
  for (const r of results) {
    if (r.jobId === null || seen.has(r.jobId)) continue;
    seen.add(r.jobId);
    const w = waitingJob(store, r.ticketId, r.jobId);
    if (w !== null) out.push(w);
  }
  return out;
}

/** At most one lease renewal attempt per job in this long (ticket 0177). */
export const LEASE_RENEW_EVERY_MS = 3 * 60_000;

/** The heartbeat's memory of its last renewal attempt and of the child that was refused one. */
export interface LeaseKeep {
  jobId: string | null;
  at: number;
  refused: RunnerSession['child'];
}

/**
 * While the controller's child runs, keep its job's lease live (ticket 0177): a long foreground
 * subagent runs no `orch` command, so nothing else renews it. Only a job `orch-runner` holds,
 * renewed as the row's current owner at its revision, so a claim landing in between fails with
 * exit 4 instead of being overwritten; that refusal ends renewals for this child. Never throws.
 */
export function keepChildLease(
  store: Store,
  session: RunnerSession,
  keep: LeaseKeep,
  log: (line: string) => void,
  at = Date.now(),
): void {
  const { child, jobId } = session;
  if (child === null || jobId === null || keep.refused === child) return;
  if (keep.jobId === jobId && at - keep.at < LEASE_RENEW_EVERY_MS) return;
  try {
    const job = getJob(store.db, jobId);
    if (job.ownerSession !== RUNNER_SESSION || job.leaseExpiresAt === null) return;
    if (Date.parse(job.leaseExpiresAt) - at > (job.leaseMinutes * 60_000) / 2) return;
    keep.jobId = jobId;
    keep.at = at;
    renewLease(store, jobId, { token: job.ownerToken ?? undefined, expectRevision: job.revision });
  } catch (err) {
    keep.jobId = jobId;
    keep.at = at;
    if (err instanceof OwnershipError) keep.refused = child;
    try {
      log(`  job ${jobId}: lease not renewed: ${err instanceof Error ? err.message : String(err)}`);
    } catch {
      // the heartbeat never throws
    }
  }
}

/** Run the session to its end as the lock holder; `resuming` continues the ticket in flight. */
async function drive(
  store: Store,
  lock: RunnerLock,
  session: RunnerSession,
  resuming: boolean,
  opts: RunOptions,
  slot: string | undefined,
): Promise<RunSummary> {
  const paths = store.paths;
  const pause = opts.sleep ?? ((ms: number) => delay(ms, undefined, { ref: true }));
  const write = () => {
    session.beatAt = now();
    writeSession(paths, session, slot);
  };
  // The build this process's code came from; null (no stamp) turns the check off.
  const build = opts.build ?? buildStamp;
  const builtAt = build();
  // The run-wide stop an `environment` check found; it ends the session unfinished.
  let halted = null as Blocked | null; // set from a closure: no narrowing to null
  // ponytail: a starter can take the next generation between a check and the write after it;
  // the next check stops this controller. Closing that gap needs a real mutex (a lock redesign).
  const run: Run = {
    store,
    session,
    slot,
    launch: opts.launch ?? launchClaude,
    log: opts.log ?? (() => undefined),
    pollMs: opts.pollMs ?? POLL_MS,
    ciMaxPolls: opts.ciMaxPolls ?? CI_MAX_POLLS,
    githubBackoff: opts.githubBackoff ?? GITHUB_BACKOFF_SECONDS,
    limitWaits: { ...LIMIT_WAITS, ...opts.limitWaits },
    checkoutWaits: { ...CHECKOUT_WAITS, ...opts.checkoutWaits },
    limits: [],
    owned: () => lock.owned(),
    assertOwned: () => {
      if (!lock.owned()) throw new LostLockError(slotPid(paths, slot));
    },
    save: () => {
      run.assertOwned();
      write();
    },
    stopNow: () => {
      run.assertOwned();
      return opts.signal?.aborted === true || stopRequests(paths, slot).now;
    },
    pause,
    wait: async (seconds) => {
      for (let left = seconds * 1000; left > 0 && !run.stopNow(); left -= run.pollMs) {
        await pause(Math.min(left, run.pollMs));
      }
    },
    environment: () => {
      const rebuilt = builtAt !== null && build() !== builtAt;
      const reason = rebuilt ? REBUILT_REASON : configProblem(store);
      halted =
        reason === null
          ? null
          : { kind: 'blocked', code: rebuilt ? 'orch-rebuilt' : 'bad-config', reason };
      return halted;
    },
  };
  // A stop-now request was for the controller alive when it was made.
  clearStop(paths, 'now', slot);
  session.pid = process.pid;
  session.child = null;
  session.wait = null;
  run.save();
  // Never throws: after a lost lock it writes nothing, and the main flow stops at its next check.
  const keep: LeaseKeep = { jobId: null, at: 0, refused: null };
  const beat = setInterval(() => {
    if (!lock.owned()) return;
    write();
    keepChildLease(store, session, keep, run.log);
  }, opts.beatMs ?? BEAT_MS);
  beat.unref();

  const attempt = async (ticketId: number, pick: RunnerSession['pick']): Promise<TicketResult> => {
    session.ticketId = ticketId;
    session.pick = pick ?? null;
    session.jobId = null;
    run.save();
    const mark = mailWatermark(store);
    const result = await runTicket(run, ticketId);
    run.assertOwned();
    await reportJobMail(store, mark);
    session.results = [...session.results.filter((r) => r.ticketId !== ticketId), result];
    // A stopped or resumably ended ticket stays the one in flight, for `orch resume`.
    if (result.outcome !== 'stopped' && !resumable(result.code)) {
      session.ticketId = null;
      session.pick = null;
      session.jobId = null;
    }
    run.save();
    return result;
  };

  try {
    let reason: string | null = null;
    let stopped = false;
    const first = session.mode === 'ticket' ? session.ticket : resuming ? session.ticketId : null;
    if (first !== null && run.environment() === null) {
      // `orch resume` keeps how the ticket in flight was taken.
      const r = await attempt(first, session.mode === 'ticket' ? null : session.pick);
      if (r.outcome === 'stopped') stopped = true;
      else if (session.mode === 'ticket' || (r.outcome !== 'done' && !passesOver(r))) {
        reason = `ticket ${ticketKey(first)} is ${r.outcome}: ${r.reason}`;
      }
    }
    if (!stopped && reason === null && halted === null) {
      reason = await runQueue(run, attempt);
      stopped = reason === null;
    }
    // Rebuilt or bad config: unfinished, so `orch resume` continues once the cause is gone. A stop
    // before a ticket has none in flight, so the reason comes from here, not from a result.
    if (halted !== null) {
      run.save();
      const s = { ...summarize(store, session, halted.reason, false), interrupted: true };
      return halted.code === 'orch-rebuilt'
        ? { ...s, handoff: { repo: slotRepo(store, session, slot) } }
        : s;
    }
    if (stopped || reason === null) {
      run.save(); // first: a lost lock leaves the stop request to the controller that has it
      clearStop(paths, 'now', slot);
      return summarize(
        store,
        session,
        'stopped on request; orch resume continues the session',
        true,
      );
    }
    // Only a resumably ended ticket is still in flight here (`attempt`): the run ended on it, and
    // the session stays unfinished with it, so `orch resume` continues it.
    const limited = session.results.find(
      (r) => r.ticketId === session.ticketId && resumable(r.code),
    );
    if (limited !== undefined) {
      run.save();
      return summarize(store, session, limited.reason, false);
    }
    session.finished = { at: now(), reason };
    session.ticketId = null;
    session.pick = null;
    session.jobId = null;
    run.save();
    clearStop(paths, 'next', slot);
    return summarize(store, session, reason, false);
  } finally {
    clearInterval(beat);
  }
}

/**
 * A path inside the repository of a scoped slot, for `orch resume --repo`: the queue's own, or
 * `orch do`'s ticket checkout. Null for the unscoped slot, which a bare `orch resume` finds.
 */
function slotRepo(store: Store, session: RunnerSession, slot: string | undefined): string | null {
  if (slot === undefined) return null;
  if (session.mode === 'ticket' && session.ticket !== null) {
    return showTicket(store, session.ticket).ticket.repoPath;
  }
  return session.repo;
}

/** A handoff child that exits non-zero within this long refused the session: reported, not retried. */
export const HANDOFF_REFUSAL_MS = 10_000;

/** Runs the handoff child in the foreground and resolves with its exit code; tests replace it. */
export type HandoffLaunch = (exe: string, args: readonly string[]) => Promise<number | null>;

/**
 * Hand a session that halted on `orch-rebuilt` to the new build (decision
 * 2026-11-26-rebuilt-controller-hands-off): the installed `dist/` entry's `orch resume` for the
 * same slot, run as a foreground child of this process in this terminal, once. Called after the
 * session returned, so its lock is released and the session left resumable; the child takes both.
 * Resolves with the exit code this process should end with: the child's, and 1 when a signal
 * ended it. Nothing here retries: a refusal leaves the session for a person's `orch resume`.
 */
export async function handOff(
  handoff: NonNullable<RunSummary['handoff']>,
  o: {
    json?: boolean | undefined;
    log: (line: string) => void;
    launch?: HandoffLaunch | undefined;
    clock?: (() => number) | undefined;
  },
): Promise<number> {
  const clock = o.clock ?? Date.now;
  const args = [
    join(installRoot(), 'dist', 'cli', 'main.js'),
    'resume',
    ...(handoff.repo === null ? [] : ['--repo', handoff.repo]),
    ...(o.json ? ['--json'] : []),
  ];
  o.log('Handing this session to the new build: orch resume');
  const started = clock();
  const code = await (o.launch ?? runForeground)(process.execPath, args);
  if (code !== 0 && clock() - started < HANDOFF_REFUSAL_MS) {
    o.log(
      `Handoff refused: the new build's orch resume exited ${code === null ? 'on a signal' : String(code)} ` +
        'at once. The session is left as it was; run orch resume.',
    );
  }
  return code ?? 1;
}

/** The session's end: mail its report when mail is configured (never throws), then return it. */
async function ended(store: Store, s: RunSummary, opts: RunOptions): Promise<RunSummary> {
  await reportRunMail(store, s, opts.log ?? (() => undefined));
  return s;
}

export interface StartInput {
  mode: RunnerSession['mode'];
  /** Queue scope: a path inside the one repository to work on; null for all. */
  repo?: string | null | undefined;
  /** The ticket of `orch do`. */
  ticket?: number | undefined;
  /** `orch do --fast`: a job created for that ticket is a fast job (never for `orch start`). */
  fast?: boolean | undefined;
}

/**
 * `orch start` and `orch do`: a new session in the slot of its repository (`runnerScope`; the
 * ticket's repository for `orch do`), or in the unscoped slot for the whole queue. Refused while
 * a controller is running or a session is left interrupted there or in an overlapping slot.
 */
export async function startSession(
  store: Store,
  input: StartInput,
  opts: RunOptions = {},
): Promise<RunSummary> {
  const scope =
    input.ticket !== undefined
      ? ticketRunnerScope(showTicket(store, input.ticket).ticket) // exit 3 before anything is taken
      : input.repo == null
        ? undefined
        : runnerScope(input.repo);
  const slot = scope?.key;
  const release = acquireRunnerLock(store.paths, slot, scope);
  try {
    const previous = readSession(store.paths, slot);
    if (previous !== null && previous.finished === null) {
      throw new ValidationError(interruptedRefusal(slot, previous));
    }
    clearStop(store.paths, 'next', slot);
    const ts = now();
    const session: RunnerSession = {
      pid: process.pid,
      startedAt: ts,
      beatAt: ts,
      mode: input.mode,
      repo: input.repo ?? null,
      ...(scope === undefined ? {} : { scope: scope.name }),
      ticket: input.ticket ?? null,
      ...(input.fast === true && input.mode === 'ticket' ? { fast: true } : {}),
      ticketId: null,
      jobId: null,
      child: null,
      results: [],
      skipped: [],
      finished: null,
    };
    return await ended(store, await drive(store, release, session, false, opts, slot), opts);
  } finally {
    release();
  }
}

const interruptedSlot = (s: RunnerSlot): boolean => s.pid === null && slotOpen(s);

/** The open slot `--repo <path>` names: the repository's own, under whichever key it was started. */
function namedSlot(open: RunnerSlot[], repo: string): RunnerSlot {
  const scope = runnerScope(repo);
  const found = open.find(
    (s) => s.key !== undefined && scopesOverlap(scope, { key: s.key, commonDir: s.commonDir }),
  );
  if (found !== undefined) return found;
  throw new ValidationError(
    `No factory session is running or interrupted for ${scope.name}` +
      (open.length === 0 ? '.' : `; there is one for: ${open.map(slotName).join(', ')}.`),
  );
}

const several = (what: string, slots: RunnerSlot[]): UsageError =>
  new UsageError(
    `Several factory ${what}: ${slots.map(slotName).join(', ')}. ` +
      'Name one with --repo <path> (a path inside its repository).',
  );

/** The slot whose session ended last, over every slot. */
function lastFinished(slots: RunnerSlot[]): RunnerSlot | undefined {
  const at = (s: RunnerSlot) => s.session?.finished?.at ?? '';
  return slots.filter((s) => at(s) !== '').sort((a, b) => at(b).localeCompare(at(a)))[0];
}

/**
 * `orch resume`: continue an interrupted session with its own scope, ticket, and stop request,
 * under the lock of the slot that holds it: the one `repo` names, else the only one interrupted.
 * Refused when nothing was interrupted, and while the Claude process the dead controller started
 * may still be running: two agents must never work one job.
 */
export async function resumeSession(
  store: Store,
  input: { force?: boolean | undefined; repo?: string | undefined } = {},
  opts: RunOptions = {},
): Promise<RunSummary> {
  const all = runnerSlots(store.paths);
  const interrupted = all.filter(interruptedSlot);
  if (input.repo === undefined && interrupted.length > 1) {
    throw several('sessions were interrupted', interrupted);
  }
  // With nothing interrupted the slot only decides which refusal is given below.
  const target =
    input.repo !== undefined
      ? namedSlot(all.filter(slotOpen), input.repo)
      : (interrupted[0] ?? all.find((s) => s.pid !== null) ?? lastFinished(all));
  const slot = target?.key;
  const release = acquireRunnerLock(store.paths, slot);
  try {
    const session = readSession(store.paths, slot);
    if (session === null) {
      throw new ValidationError(
        'There is no factory session to resume. Start one with orch start.',
      );
    }
    if (session.finished !== null) {
      throw new ValidationError(
        `The last factory session ended on its own (${session.finished.reason}); ` +
          'there is nothing to resume. Start a new one with orch start.',
      );
    }
    if (!input.force) {
      const identity = childIdentity(session, opts.startTime);
      if (identity === 'original' || identity === 'unknown')
        throw new ValidationError(orphanRefusal(session, identity, 'orch resume'));
    }
    return await ended(store, await drive(store, release, session, true, opts, slot), opts);
  } finally {
    release();
  }
}

/** Why resume or stop refuses while the dead controller's child may still run, and what to do. */
function orphanRefusal(
  session: RunnerSession,
  identity: 'original' | 'unknown',
  rerun: string,
): string {
  const pid = String(session.child?.pid ?? '?');
  const inspect =
    process.platform === 'win32'
      ? `Get-Process -Id ${pid} | Select-Object Id,StartTime,Path`
      : `ps -o pid,lstart,command -p ${pid}`;
  return (
    `The Claude process the interrupted controller started on job ${session.jobId ?? '?'} ` +
    `(PID ${pid}, recorded start ${session.child?.startedAt ?? '?'}) ` +
    (identity === 'original'
      ? 'is still running: the process at that PID started then (identity confirmed). '
      : 'may still be running: the start time of the process at that PID could not be read ' +
        '(identity unknown). ') +
    `orch does not signal a PID it only read from a file. Inspect it with: ${inspect}. ` +
    `If it is that Claude process, wait for it to exit or end it yourself, then run ${rerun} ` +
    'again. Only if it is another program, run orch resume --force.'
  );
}

export interface StopResult {
  requested: keyof StopRequests;
  /** The live controller's PID; null when the session was already interrupted. */
  pid: number | null;
  message: string;
}

/**
 * `orch stop next` and `orch stop`, for one controller: the one `repo` names, else the only live
 * one, else the only interrupted session. Against a live controller both only leave a request,
 * which the controller honours; `now` then waits briefly for it. Against an interrupted session
 * `next` is kept for `orch resume`, and `now` discards the session, handing its job back as it
 * is. Nothing is cancelled, and a PID read from a file is never signalled.
 */
export function stopSession(
  store: Store,
  which: keyof StopRequests,
  waitMs = 30_000,
  startTime?: (pid: number) => number | null,
  repo?: string,
): StopResult {
  const paths = store.paths;
  const open = runnerSlots(paths).filter(slotOpen);
  let target: RunnerSlot | undefined;
  if (repo !== undefined) target = namedSlot(open, repo);
  else {
    const live = open.filter((s) => s.pid !== null);
    const candidates = live.length > 0 ? live : open;
    if (candidates.length > 1) {
      throw several(
        live.length > 0 ? 'controllers are running' : 'sessions were interrupted',
        candidates,
      );
    }
    target = candidates[0];
  }
  if (target === undefined) {
    throw new ValidationError('No factory session is running or interrupted; nothing to stop.');
  }
  const { key: slot, pid, session } = target;
  if (which === 'next') {
    requestStop(paths, 'next', slot);
    return {
      requested: 'next',
      pid,
      message:
        pid === null
          ? 'Recorded for the interrupted session: orch resume finishes its current ticket, then exits.'
          : 'The controller finishes its current ticket (re-land included), then exits.',
    };
  }
  if (pid !== null) {
    requestStop(paths, 'now', slot);
    for (let waited = 0; waited < waitMs && slotPid(paths, slot) !== null; waited += 250)
      sleep(250);
    return {
      requested: 'now',
      pid,
      message:
        slotPid(paths, slot) === null
          ? 'The controller stopped. Its job is kept as it was; orch resume continues the session.'
          : 'Stop requested; the controller has not exited yet (see orch status).',
    };
  }
  if (session === null) throw new Error('unreachable: an open session exists');
  const identity = childIdentity(session, startTime);
  if (identity === 'original' || identity === 'unknown')
    throw new ValidationError(orphanRefusal(session, identity, 'orch stop'));
  const release = acquireRunnerLock(paths, slot);
  let kept: string | null = null;
  try {
    if (!release.owned()) throw new LostLockError(slotPid(paths, slot));
    if (session.jobId !== null) kept = leave(store, session.jobId);
    writeSession(
      paths,
      {
        ...session,
        child: null,
        finished: { at: now(), reason: 'discarded by orch stop after an interruption' },
      },
      slot,
    );
    clearStop(paths, 'next', slot);
    clearStop(paths, 'now', slot);
  } finally {
    release();
  }
  return {
    requested: 'now',
    pid: null,
    message:
      'The interrupted session was discarded. Its job is kept as it was' +
      (session.ticketId === null ? '.' : `; orch do ${ticketKey(session.ticketId)} continues it.`) +
      (kept === null ? '' : ` The job's lease could not be released: ${kept}`),
  };
}

/** One open controller slot: a live controller, or a session nobody is running. */
export interface ControllerStatus {
  /** The repository it works on, as shown; `every repository` for the whole queue. */
  scope: string;
  /** `running`: a live controller. `interrupted`: a session nobody is running; resumable. */
  state: 'running' | 'interrupted';
  pid: number | null;
  mode: RunnerSession['mode'] | null;
  /** The repository the queue is restricted to. */
  repo: string | null;
  startedAt: string | null;
  stop: StopRequests;
  current: {
    ticket: string;
    /** How the queue took it (`RunnerSession.pick`); null for `orch do` and older records. */
    pick: 'resume' | 'ready' | null;
    job: string | null;
    repo: string | null;
    stage: Job['stage'] | null;
    status: Job['status'] | null;
    /** What the ticket is waiting on. */
    waiting: 'agent' | 'ci' | 'merge' | 'human' | null;
    childPid: number | null;
    childAlive: boolean;
  } | null;
  /**
   * What a live controller waits for before relaunching its job (`RunnerSession.wait`), and
   * until when; null when it is not waiting out a limit or an outage.
   */
  wait: { reason: string; until: string } | null;
  /** What happens next, in one sentence. */
  next: string;
}

export interface RunnerStatus {
  /** One per open slot, live ones first, then by start; empty when nothing runs or waits. */
  controllers: ControllerStatus[];
  /** How the session that ended last, over every slot, finished. */
  last: { scope: string; at: string; reason: string; completed: number; attempted: number } | null;
  /** The installed build against its checkout; null without a build stamp. */
  build: InstallBuild | null;
  /**
   * The recorded sessions' tickets (current or in their results) whose job waits in needs-human
   * now, with their choices and links: display only, never decided from.
   */
  waiting: WaitingJob[];
}

/** What `orch status` says next when no controller is open. */
export const IDLE_NEXT =
  'Nothing is running. orch start resumes a stranded in-progress ticket first, then takes the next ready one.';

function controllerStatus(store: Store, slot: RunnerSlot): ControllerStatus {
  const { pid } = slot;
  const stop = stopRequests(store.paths, slot.key);
  const session = slot.session?.finished === null ? slot.session : null;
  let current: ControllerStatus['current'] = null;
  if (session !== null && session.ticketId !== null) {
    let job: Job | null = null;
    try {
      if (session.jobId !== null) job = getJob(store.db, session.jobId);
    } catch {
      /* the record names a job this database does not have */
    }
    current = {
      ticket: ticketKey(session.ticketId),
      pick: session.pick ?? null,
      job: session.jobId,
      repo: job?.repo ?? null,
      stage: job?.stage ?? null,
      status: job?.status ?? null,
      waiting:
        job === null
          ? null
          : job.stage === 'needs-human'
            ? 'human'
            : job.stage === 'completed'
              ? 'merge'
              : job.stage === 'ci'
                ? 'ci'
                : 'agent',
      childPid: session.child?.pid ?? null,
      childAlive: childMayBeAlive(session),
    };
  }
  const wait = pid === null ? null : (session?.wait ?? null);
  const after =
    stop.next || session?.mode === 'ticket' ? 'then exit' : 'then take the next ready ticket';
  let next: string;
  if (pid === null) {
    next = current?.childAlive
      ? `The controller is gone but its Claude process (PID ${String(current.childPid)}) may still be running; ` +
        'orch resume checks whether that PID is still the same process, and continues once it is not.'
      : 'The controller is gone. orch resume continues the session; orch stop discards it.';
  } else if (stop.now) next = 'Stopping now: the current job is kept as it is.';
  else if (wait !== null && current !== null)
    next = `Waiting for ${wait.reason} at ${wait.until}, then continue ticket ${current.ticket}.`;
  else if (current === null)
    next = `Resume a stranded in-progress ticket, else select the next ready one${stop.next ? ', unless stopped' : ''}.`;
  else {
    const doing = {
      agent: 'Run the job through the factory',
      ci: 'Wait for the CI verdict on GitHub',
      merge: 'Merge the verified PR',
      human: 'Report that the job waits for a person',
    }[current.waiting ?? 'agent'];
    next = `${doing}, ${after}.`;
  }
  return {
    scope: slotName(slot),
    state: pid !== null ? 'running' : 'interrupted',
    pid,
    mode: session?.mode ?? null,
    repo: session?.repo ?? null,
    startedAt: session?.startedAt ?? null,
    stop,
    current,
    wait,
    next,
  };
}

/**
 * The build line as `orch status` and the dashboard show it: while a controller runs, rebuilding
 * would halt it (`orch-rebuilt`), so a stale build's advice says to stop it first.
 */
export function buildForStatus(
  build: InstallBuild | null,
  controllerRunning: boolean,
): InstallBuild | null {
  if (build === null || !build.stale || !controllerRunning) return build;
  return {
    ...build,
    message: build.message.replace(
      REBUILD_STEPS,
      `run \`orch stop next\`; when the controller exits: ${REBUILD_STEPS}, \`orch start\``,
    ),
  };
}

/**
 * `orch status`: every open controller slot with the job row of its ticket in flight, the
 * session that ended last, and what waits for a person. Read-only.
 */
export function runnerStatus(store: Store): RunnerStatus {
  const slots = runnerSlots(store.paths);
  const last = lastFinished(slots);
  const started = (c: ControllerStatus) => c.startedAt ?? '';
  const controllers = slots
    .filter(slotOpen)
    .map((s) => controllerStatus(store, s))
    .sort(
      (a, b) =>
        Number(b.pid !== null) - Number(a.pid !== null) || started(a).localeCompare(started(b)),
    );
  return {
    controllers,
    last:
      last?.session?.finished == null
        ? null
        : {
            scope: slotName(last),
            at: last.session.finished.at,
            reason: last.session.finished.reason,
            completed: last.session.results.filter((r) => r.outcome === 'done').length,
            attempted: last.session.results.length,
          },
    build: buildForStatus(
      installBuild(),
      controllers.some((c) => c.state === 'running'),
    ),
    waiting: waitingOf(
      store,
      slots.flatMap(({ session }) =>
        session === null
          ? []
          : [
              ...(session.ticketId === null
                ? []
                : [{ ticketId: session.ticketId, jobId: session.jobId }]),
              ...session.results,
            ],
      ),
    ),
  };
}
