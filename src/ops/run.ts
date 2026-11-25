/**
 * The foreground factory controller behind `orch start`, `orch do`, and `orch resume` (decision
 * 2026-11-21-foreground-factory-runner): take a ticket from the queue, run its job with the
 * existing /factory skill in a `claude -p` child, read GitHub's CI verdict where no agent is
 * needed, merge through `mergeJob`, and go on to the next ticket. It sequences what exists and
 * decides nothing about a job's stages: every step re-reads the job row, so calling `runTicket`
 * again after any interruption continues from wherever the durable state is.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import {
  LostLockError,
  OrchError,
  OwnershipError,
  ToolError,
  ValidationError,
} from '../core/errors.ts';
import { claudeLimit } from '../core/claude-limit.ts';
import { jobArtifactDir } from '../core/paths.ts';
import { leaseExpired } from '../core/ownership.ts';
import { orderTickets, ticketKey } from '../core/tickets.ts';
import { endsRun, now, personMergeStep, TERMINAL_STATUSES } from '../core/workflow.ts';
import {
  type ChildExit,
  type ClaudeChild,
  launchClaude,
  type LaunchInput,
} from '../integrations/claude-session.ts';
import type { TokenCounts } from '../server/types.ts';
import { listArtifacts } from '../storage/artifacts.ts';
import type { Store } from '../storage/client.ts';
import { eventsOfTypes, latestEventsByJob, listEvents } from '../storage/events.ts';
import {
  attachSession,
  claimJob,
  getJob,
  mergeEvidence,
  recordEvent,
  releaseJob,
} from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import { ticketJobs } from '../storage/tickets.ts';
import { dispatchJob } from './dispatch.ts';
import { loadConfig, resumeFactoryJob, specResumeSteps } from './factory.ts';
import { transitionGuarded } from './gates.ts';
import { reconcileCi } from './github.ts';
import { type InstallBuild, installBuild } from './install-build.ts';
import { mailWatermark, reportJobMail, reportRunMail } from './mail.ts';
import { mergeAuthorized, mergeJob } from './merge.ts';
import { mergedHead } from './merge-view.ts';
import {
  acquireRunnerLock,
  awaitsPerson,
  childIdentity,
  childMayBeAlive,
  clearStop,
  controllerPid,
  readSession,
  requestStop,
  type RunnerLock,
  type RunnerSession,
  type StopRequests,
  stopRequests,
  type TicketOutcome,
  type TicketResult,
  writeSession,
} from './runner-state.ts';
import { listTickets, showTicket } from './tickets.ts';
import { jobTokens, recordSession } from './token-usage.ts';
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
const POLL_MS = 2000;
const BEAT_MS = 30_000;
/** The stop code of a child that hit a Claude usage or rate limit; the run stays resumable. */
const USAGE_LIMIT = 'usage-limit';

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
}

export interface RunSummary {
  /** Why the session ended. */
  reason: string;
  /** Ended by `orch stop` (or Ctrl+C): the session is left for `orch resume`. */
  stopped: boolean;
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
  launch: (input: LaunchInput) => ClaudeChild;
  log: (line: string) => void;
  pollMs: number;
  ciMaxPolls: number;
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
  let failures = 0;
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
        run.log(`  ci: ${r.action}: ${r.reason}`);
        if (r.action !== 'wait') return null;
        waitSeconds = r.waitSeconds ?? RETRY_SECONDS;
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        failures += 1;
        run.log(`  ci: could not read GitHub (${err.message})`);
        if (failures >= TRANSIENT_ATTEMPTS) {
          return {
            kind: 'blocked',
            code: 'github-unreadable',
            reason: `GitHub could not be read ${String(failures)} times in a row: ${err.message}`,
          };
        }
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
 * Drive one job until it is finished (completed, cancelled, or waiting in needs-human), a stop
 * was requested, or a budget is spent. Agent stages run in a Claude child; the ci stage is read
 * here. The caller reads the job row for what "finished" means.
 */
export async function runJob(run: Run, jobId: string): Promise<JobRun> {
  const { store } = run;
  let idle = 0;
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
    // A spent account would fail every ticket the same way: end the run, resumably, before the
    // exit counts as idle (decision 2026-11-24-usage-limit-ends-run-resumably).
    const limit = claudeLimit(exit.stderrTail, exit.result);
    if (limit !== null) {
      const resets = limit.resetsAt === null ? '' : ` (resets ${limit.resetsAt})`;
      return {
        kind: 'blocked',
        code: USAGE_LIMIT,
        reason: `Claude ${limit.limit} reached${resets}; orch resume continues the session`,
      };
    }
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

/** `mergeJob` until it gives an answer that is not "try again", within a small budget. */
async function merge(run: Run, jobId: string): Promise<MergeRun> {
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
        return { kind: 'blocked', code, reason: `${code}: ${m.reason}` };
      }
      case 'waiting':
      case 'error':
        if (attempt >= TRANSIENT_ATTEMPTS) {
          return {
            kind: 'blocked',
            code: 'merge-no-answer',
            reason: `merge gave no answer in ${String(attempt)} attempts: ${m.reason}`,
          };
        }
        await run.wait(RETRY_SECONDS);
        if (run.stopNow()) return { kind: 'stopped' };
    }
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
    run.log(`  ticket ${key}: ${outcome}: ${reason}`);
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
      // Losing the claim to another process is an ordinary outcome: its job is the ticket's job.
      const other = showTicket(store, ticketId).ticket.activeJob;
      if (other !== null) return out('claimed', `job ${other} was created for it meanwhile`, other);
      return out('refused', err.message, null);
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
        const next = r.code === USAGE_LIMIT ? 'orch resume' : retry;
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
            ? `tick the remaining boxes (orch ticket edit ${key} --body-file -) or move them to a follow-up ticket, then orch ticket done ${key}`
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
    const code = err instanceof OwnershipError ? 'ownership' : 'error';
    return out('blocked', err.message, jobId, retry, code);
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
  for (;;) {
    if (run.stopNow()) return null;
    if (stopRequests(store.paths).next) return 'stopped after the current ticket (orch stop next)';
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
      if (r.outcome === 'done') continue;
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
    if (r.outcome === 'done') continue;
    if (!passesOver(r)) return `ticket ${next.key} is ${r.outcome}: ${r.reason}`;
    run.log(`ticket ${next.key} passed over: ${r.code ?? r.outcome}`);
    passed.add(next.id);
  }
}

/** What a merged ticket's result job has on record: never estimated, never a second head lookup. */
function mergedTicket(store: Store, r: TicketResult & { jobId: string }): MergedTicket {
  const secs = eventsOfTypes(store.db, r.jobId, ['runner.session'])
    .map((e) => e.payload['seconds'])
    .filter((v): v is number => typeof v === 'number');
  const commit = mergeEvidence(store.db, r.jobId)?.['mergeCommit'];
  return {
    ticketId: r.ticketId,
    title: r.title,
    jobId: r.jobId,
    head: mergedHead(store, r.jobId),
    mergeCommit: typeof commit === 'string' ? commit : null,
    prUrl: getJob(store.db, r.jobId).prUrl,
    seconds: secs.length === 0 ? null : secs.reduce((a, b) => a + b, 0),
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
  };
}

/** Run the session to its end as the lock holder; `resuming` continues the ticket in flight. */
async function drive(
  store: Store,
  lock: RunnerLock,
  session: RunnerSession,
  resuming: boolean,
  opts: RunOptions,
): Promise<RunSummary> {
  const paths = store.paths;
  const pause = opts.sleep ?? ((ms: number) => delay(ms, undefined, { ref: true }));
  const write = () => {
    session.beatAt = now();
    writeSession(paths, session);
  };
  // ponytail: a starter can take the next generation between a check and the write after it;
  // the next check stops this controller. Closing that gap needs a real mutex (a lock redesign).
  const run: Run = {
    store,
    session,
    launch: opts.launch ?? launchClaude,
    log: opts.log ?? (() => undefined),
    pollMs: opts.pollMs ?? POLL_MS,
    ciMaxPolls: opts.ciMaxPolls ?? CI_MAX_POLLS,
    owned: () => lock.owned(),
    assertOwned: () => {
      if (!lock.owned()) throw new LostLockError(controllerPid(paths));
    },
    save: () => {
      run.assertOwned();
      write();
    },
    stopNow: () => {
      run.assertOwned();
      return opts.signal?.aborted === true || stopRequests(paths).now;
    },
    pause,
    wait: async (seconds) => {
      for (let left = seconds * 1000; left > 0 && !run.stopNow(); left -= run.pollMs) {
        await pause(Math.min(left, run.pollMs));
      }
    },
  };
  // A stop-now request was for the controller alive when it was made.
  clearStop(paths, 'now');
  session.pid = process.pid;
  session.child = null;
  run.save();
  // Never throws: after a lost lock it writes nothing, and the main flow stops at its next check.
  const beat = setInterval(() => {
    if (lock.owned()) write();
  }, BEAT_MS);
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
    // A stopped or limit-hit ticket stays the one in flight, for `orch resume`.
    if (result.outcome !== 'stopped' && result.code !== USAGE_LIMIT) {
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
    if (first !== null) {
      // `orch resume` keeps how the ticket in flight was taken.
      const r = await attempt(first, session.mode === 'ticket' ? null : session.pick);
      if (r.outcome === 'stopped') stopped = true;
      else if (session.mode === 'ticket' || (r.outcome !== 'done' && !passesOver(r))) {
        reason = `ticket ${ticketKey(first)} is ${r.outcome}: ${r.reason}`;
      }
    }
    if (!stopped && reason === null) {
      reason = await runQueue(run, attempt);
      stopped = reason === null;
    }
    if (stopped || reason === null) {
      run.save(); // first: a lost lock leaves the stop request to the controller that has it
      clearStop(paths, 'now');
      return summarize(
        store,
        session,
        'stopped on request; orch resume continues the session',
        true,
      );
    }
    // Only a limit-hit ticket is still in flight here (`attempt`): the run ended on it, and the
    // session stays unfinished with it, so `orch resume` continues it.
    const limited = session.results.find(
      (r) => r.ticketId === session.ticketId && r.code === USAGE_LIMIT,
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
    clearStop(paths, 'next');
    return summarize(store, session, reason, false);
  } finally {
    clearInterval(beat);
  }
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

/** `orch start` and `orch do`: a new session. Refused while one is running or left interrupted. */
export async function startSession(
  store: Store,
  input: StartInput,
  opts: RunOptions = {},
): Promise<RunSummary> {
  if (input.ticket !== undefined) showTicket(store, input.ticket); // exit 3 before anything is taken
  const release = acquireRunnerLock(store.paths);
  try {
    const previous = readSession(store.paths);
    if (previous !== null && previous.finished === null) {
      throw new ValidationError(
        `A factory session started ${previous.startedAt} was interrupted` +
          (previous.ticketId === null ? '' : ` at ticket ${ticketKey(previous.ticketId)}`) +
          '. Continue it with orch resume, or discard it with orch stop; then start again.',
      );
    }
    clearStop(store.paths, 'next');
    const ts = now();
    const session: RunnerSession = {
      pid: process.pid,
      startedAt: ts,
      beatAt: ts,
      mode: input.mode,
      repo: input.repo ?? null,
      ticket: input.ticket ?? null,
      ...(input.fast === true && input.mode === 'ticket' ? { fast: true } : {}),
      ticketId: null,
      jobId: null,
      child: null,
      results: [],
      skipped: [],
      finished: null,
    };
    return await ended(store, await drive(store, release, session, false, opts), opts);
  } finally {
    release();
  }
}

/**
 * `orch resume`: continue the interrupted session with its own scope, ticket, and stop request.
 * Refused when nothing was interrupted, and while the Claude process the dead controller started
 * may still be running: two agents must never work one job.
 */
export async function resumeSession(
  store: Store,
  input: { force?: boolean | undefined } = {},
  opts: RunOptions = {},
): Promise<RunSummary> {
  const release = acquireRunnerLock(store.paths);
  try {
    const session = readSession(store.paths);
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
    return await ended(store, await drive(store, release, session, true, opts), opts);
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
 * `orch stop next` and `orch stop`. Against a live controller both only leave a request, which
 * the controller honours; `now` then waits briefly for it. Against an interrupted session `next`
 * is kept for `orch resume`, and `now` discards the session, handing its job back as it is.
 * Nothing is cancelled, and a PID read from a file is never signalled.
 */
export function stopSession(
  store: Store,
  which: keyof StopRequests,
  waitMs = 30_000,
  startTime?: (pid: number) => number | null,
): StopResult {
  const paths = store.paths;
  const pid = controllerPid(paths);
  const session = readSession(paths);
  const open = session !== null && session.finished === null;
  if (pid === null && !open) {
    throw new ValidationError('No factory session is running or interrupted; nothing to stop.');
  }
  if (which === 'next') {
    requestStop(paths, 'next');
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
    requestStop(paths, 'now');
    for (let waited = 0; waited < waitMs && controllerPid(paths) !== null; waited += 250)
      sleep(250);
    return {
      requested: 'now',
      pid,
      message:
        controllerPid(paths) === null
          ? 'The controller stopped. Its job is kept as it was; orch resume continues the session.'
          : 'Stop requested; the controller has not exited yet (see orch status).',
    };
  }
  if (session === null) throw new Error('unreachable: an open session exists');
  const identity = childIdentity(session, startTime);
  if (identity === 'original' || identity === 'unknown')
    throw new ValidationError(orphanRefusal(session, identity, 'orch stop'));
  const release = acquireRunnerLock(paths);
  let kept: string | null = null;
  try {
    if (!release.owned()) throw new LostLockError(controllerPid(paths));
    if (session.jobId !== null) kept = leave(store, session.jobId);
    writeSession(paths, {
      ...session,
      child: null,
      finished: { at: now(), reason: 'discarded by orch stop after an interruption' },
    });
    clearStop(paths, 'next');
    clearStop(paths, 'now');
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

export interface RunnerStatus {
  /** `running`: a live controller. `interrupted`: a session nobody is running; resumable. */
  state: 'running' | 'interrupted' | 'idle';
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
  /** What happens next, in one sentence. */
  next: string;
  /** How the last session that ran to its end finished. */
  last: { at: string; reason: string; completed: number; attempted: number } | null;
  /** The installed build against its checkout; null without a build stamp. */
  build: InstallBuild | null;
}

/** `orch status`: the controller's own state plus the job row of the ticket in flight. Read-only. */
export function runnerStatus(store: Store): RunnerStatus {
  const paths = store.paths;
  const session = readSession(paths);
  const pid = controllerPid(paths);
  const stop = stopRequests(paths);
  const open = session !== null && session.finished === null;
  const state = pid !== null ? 'running' : open ? 'interrupted' : 'idle';
  let current: RunnerStatus['current'] = null;
  if (session !== null && open && session.ticketId !== null) {
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
  const after =
    stop.next || session?.mode === 'ticket' ? 'then exit' : 'then take the next ready ticket';
  let next: string;
  if (state === 'idle') {
    next =
      'Nothing is running. orch start resumes a stranded in-progress ticket first, then takes the next ready one.';
  } else if (state === 'interrupted') {
    next = current?.childAlive
      ? `The controller is gone but its Claude process (PID ${String(current.childPid)}) may still be running; ` +
        'orch resume checks whether that PID is still the same process, and continues once it is not.'
      : 'The controller is gone. orch resume continues the session; orch stop discards it.';
  } else if (stop.now) next = 'Stopping now: the current job is kept as it is.';
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
    state,
    pid,
    mode: open ? session.mode : null,
    repo: open ? session.repo : null,
    startedAt: open ? session.startedAt : null,
    stop,
    current,
    next,
    last:
      session?.finished == null
        ? null
        : {
            at: session.finished.at,
            reason: session.finished.reason,
            completed: session.results.filter((r) => r.outcome === 'done').length,
            attempted: session.results.length,
          },
    build: installBuild(),
  };
}
