/**
 * `orch start | do | stop | status | resume`: the foreground factory controller (decision
 * 2026-11-21-foreground-factory-runner). start, do, and resume run until the session ends;
 * stop and status are one-shot.
 */
import { UsageError } from '../core/errors.ts';
import { findProjectRoot } from '../core/paths.ts';
import { parseTicketId, ticketKey } from '../core/tickets.ts';
import { choiceLine } from '../ops/actions.ts';
import {
  resumeSession,
  type RunnerStatus,
  runnerStatus,
  type RunSummary,
  startSession,
  stopSession,
} from '../ops/run.ts';
import { formatSummary } from '../ops/run-report.ts';
import { openStore } from '../storage/client.ts';

export const RUN_COMMANDS = ['start', 'do', 'stop', 'status', 'resume'] as const;

export const RUN_HELP = `Usage: orch start [repo] | do <ticket-id> [--fast] | stop [next] | status | resume [--force]

The factory controller: a foreground process that takes ready tickets from the global queue, runs
each one's job with the /factory skill in a headless Claude Code session (claude -p), reads CI,
merges through orch job merge's operation, and goes on to the next ticket. It runs only while this
command runs; nothing is left behind when it exits.

  start           Work the whole queue, best ready ticket first, one at a time. A ticket whose job
                  needs a person, or whose merge only a person can unblock, is released, passed
                  over for the session, and reported at the end with its next step. Ends when no ready ticket is left, a stop was requested, or a ticket could
                  not be finished (blocked, a retry budget spent): it reports that ticket and
                  stops rather than start unrelated work
  start repo      The same, only for the repository containing the current directory
  do <ticket-id>  One ticket, to its outcome: start its job, or continue the unfinished one, or
                  merge the completed one. A cancelled job is never replaced
  do <ticket-id> --fast
                  The same, but a job it creates is a fast job: one agent builds, then PR, CI,
                  merge; no spec, simplify, review, or approval. For small, low-risk tickets you
                  pick; a change to factory.json, CI, test configuration, dependencies, or tests
                  it disables is refused and escalates. An unfinished job keeps its own mode
  stop next       Ask the controller to exit once the current ticket has reached its outcome; no
                  further ticket is started. Kept across an interruption
  stop            End the current execution now: the Claude session is terminated and the job is
                  kept as it is (never cancelled) for orch resume. With no controller alive,
                  discards an interrupted session instead
  status          Whether a controller is running or was interrupted, its ticket and job, what it
                  waits on, pending stop requests, and what happens next; first, each of the
                  session's jobs waiting for a person, with a dashboard link per choice
  resume          Continue an interrupted session: same scope, same ticket and job, same stop
                  request. Refused while the Claude process of the dead controller may still be
                  running (--force: that PID is another program now)

A ticket is started only when merging is enabled for its repository
(orch factory config merge enable --repo <path>); tickets of other repositories are reported and
passed over. Only a merge of the CI-verified head that closes the ticket counts as done.
Exit status: 0 unless a ticket ended blocked, refused, or waiting for a person.
`;

export interface RunCliOptions {
  json?: boolean | undefined;
  force?: boolean | undefined;
  /** `orch do --fast` only. */
  fast?: boolean | undefined;
}

export function formatStatus(s: RunnerStatus): string {
  const lines = [`controller  ${s.state}${s.pid === null ? '' : ` (PID ${String(s.pid)})`}`];
  if (s.mode !== null) {
    lines.push(
      `session     ${s.mode === 'ticket' ? 'one ticket' : `queue, ${s.repo ?? 'every repository'}`}, ` +
        `started ${s.startedAt ?? '?'}`,
    );
  }
  if (s.current !== null) {
    const c = s.current;
    lines.push(`ticket      ${c.ticket}${c.pick === null ? '' : ` (pick ${c.pick})`}`);
    if (c.job !== null) {
      lines.push(`job         ${c.job} ${c.stage ?? '?'}/${c.status ?? '?'} (${c.repo ?? '?'})`);
    }
    if (c.waiting !== null) lines.push(`waiting on  ${c.waiting}`);
    if (c.childPid !== null) {
      lines.push(`claude      PID ${String(c.childPid)}${c.childAlive ? '' : ' (exited)'}`);
    }
  }
  const stops = [s.stop.next ? 'after the current ticket' : '', s.stop.now ? 'now' : ''];
  lines.push(`stop        ${stops.filter(Boolean).join(', ') || 'not requested'}`);
  if (s.last !== null) {
    lines.push(
      `last ended  ${s.last.at}: ${s.last.reason} ` +
        `(${String(s.last.completed)} of ${String(s.last.attempted)} completed)`,
    );
  }
  lines.push(`next        ${s.next}`);
  if (s.build?.stale) lines.push(`build       ${s.build.message}`);
  // What waits for a person comes first, with a link per choice; the internal detail follows.
  const waiting = s.waiting.flatMap((w) => [
    `needs you   ${ticketKey(w.ticketId)}: ${w.needed}`,
    ...w.choices.map((c) => `              ${choiceLine(c)}`),
    `              job ${w.jobId}`,
  ]);
  return [...waiting, ...lines].join('\n');
}

/**
 * Exit 1 when the session left a ticket that needs a person or was interrupted run-wide; a
 * requested stop is not a failure.
 */
export function summaryExitCode(s: RunSummary): number {
  return s.blocked > 0 || s.interrupted ? 1 : 0;
}

export async function runRunner(
  command: (typeof RUN_COMMANDS)[number],
  args: string[],
  o: RunCliOptions,
): Promise<{ text: string; data: unknown; exitCode: number }> {
  const [arg, extra] = args;
  const noMore = (unexpected: string | undefined) => {
    if (unexpected !== undefined) {
      throw new UsageError(`Unexpected argument: ${unexpected}\n\n${RUN_HELP}`);
    }
  };
  if (o.fast && command !== 'do') {
    throw new UsageError(`--fast belongs to orch do <ticket-id> only\n\n${RUN_HELP}`);
  }
  const store = openStore();
  try {
    if (command === 'status') {
      noMore(arg);
      const status = runnerStatus(store);
      return { text: formatStatus(status), data: status, exitCode: 0 };
    }
    if (command === 'stop') {
      noMore(extra);
      if (arg !== undefined && arg !== 'next') {
        throw new UsageError(`Usage: orch stop [next]\n\n${RUN_HELP}`);
      }
      const stopped = stopSession(store, arg === 'next' ? 'next' : 'now');
      return { text: stopped.message, data: stopped, exitCode: 0 };
    }

    // The long-running commands. Progress goes to stderr under --json, so stdout stays one object.
    const log = (line: string) => {
      if (o.json) process.stderr.write(line + '\n');
      else console.log(line);
    };
    const stop = new AbortController();
    const abort = () => {
      stop.abort();
    };
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    try {
      const opts = { log, signal: stop.signal };
      let summary: RunSummary;
      if (command === 'resume') {
        noMore(arg);
        summary = await resumeSession(store, { force: o.force }, opts);
      } else if (command === 'do') {
        noMore(extra);
        if (arg === undefined) {
          throw new UsageError(`Usage: orch do <ticket-id> [--fast]\n\n${RUN_HELP}`);
        }
        summary = await startSession(
          store,
          { mode: 'ticket', ticket: parseTicketId(arg), fast: o.fast },
          opts,
        );
      } else {
        noMore(extra);
        if (arg !== undefined && arg !== 'repo') {
          throw new UsageError(`Usage: orch start [repo]\n\n${RUN_HELP}`);
        }
        const repo = arg === 'repo' ? findProjectRoot(process.cwd()) : null;
        if (repo === undefined) {
          throw new UsageError('orch start repo must be run inside a Git repository.');
        }
        summary = await startSession(store, { mode: 'queue', repo }, opts);
      }
      return { text: formatSummary(summary), data: summary, exitCode: summaryExitCode(summary) };
    } finally {
      process.off('SIGINT', abort);
      process.off('SIGTERM', abort);
    }
  } finally {
    store.close();
  }
}
