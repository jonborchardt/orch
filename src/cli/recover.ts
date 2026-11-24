/** `orch recover ...`: the opt-in recovery worker (decision 2026-11-16-opt-in-recovery-worker). */
import { UsageError } from '../core/errors.ts';
import { runtimePaths } from '../core/paths.ts';
import {
  holdPidFile,
  refuseIfRunning,
  runWorker,
  startWorker,
  stopWorker,
  workerStatus,
} from '../ops/recover.ts';
import { openStore } from '../storage/client.ts';

export const RECOVER_HELP = `Usage: orch recover start|stop|status|run [--once]

Opt-in recovery after network outages. Never required for jobs to run.

  start           Launch the worker as a detached local process (PID file in the data directory).
                  Refused while a live worker exists.
  stop            Stop the worker and remove its PID file.
  status          Whether a worker is running, and the last pass: connectivity, what it did per
                  job, and the jobs that need a session or a human, with the resume command.
  run [--once]    Run the worker in the foreground until interrupted (or one pass with --once).

Each pass probes GitHub first and does nothing while it is unreachable (backing off from 30 s to
10 min). It continues only ci-stage jobs with a PR and no live owner, as session orch-recovery:
resume (never --force), start, one orch gh ci, release. Five failed attempts for the same head
escalate the job to needs-human. Jobs in spec, build, review, approve, or pr are reported as
needing a session; the worker never launches, resumes, or messages a Claude session.
`;

export async function runRecover(
  args: string[],
  o: { once?: boolean | undefined },
  entry: string,
): Promise<unknown> {
  const [sub, extra] = args;
  if (extra !== undefined) throw new UsageError(`Unexpected argument: ${extra}\n\n${RECOVER_HELP}`);
  const paths = runtimePaths();
  switch (sub) {
    case 'start':
      return startWorker(paths, entry);
    case 'stop':
      return stopWorker(paths);
    case 'status':
      return workerStatus(paths);
    case 'run': {
      // `--once` never takes the PID file, but must not act alongside a live worker either.
      if (o.once) refuseIfRunning(paths);
      const hold = o.once ? undefined : holdPidFile(paths);
      const store = openStore();
      const stop = new AbortController();
      const abort = () => {
        stop.abort();
      };
      process.on('SIGINT', abort);
      process.on('SIGTERM', abort);
      try {
        return await runWorker(store, {
          once: o.once,
          signal: stop.signal,
          beat: hold?.beat,
          owned: hold?.owned,
        });
      } finally {
        process.off('SIGINT', abort);
        process.off('SIGTERM', abort);
        hold?.release();
        store.close();
      }
    }
    default:
      throw new UsageError(RECOVER_HELP);
  }
}
