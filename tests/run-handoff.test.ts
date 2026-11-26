/**
 * A controller that halts on a rebuilt `orch` hands its session to the new build's `orch resume`
 * as one foreground child (decision 2026-11-26-rebuilt-controller-hands-off). The child is a fake
 * launcher here; where it matters it runs `resumeSession` in-process the way the real child would.
 * Uses tests/run-fixture.ts.
 */
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { summaryExitCode } from '../src/cli/run.ts';
import { installRoot } from '../src/core/paths.ts';
import { runnerScope } from '../src/ops/repo.ts';
import {
  handOff,
  type HandoffLaunch,
  HANDOFF_REFUSAL_MS,
  resumeSession,
  type RunSummary,
  startSession,
} from '../src/ops/run.ts';
import { requestStop, runnerSlots, writeSession } from '../src/ops/runner-state.ts';
import { getJob } from '../src/storage/jobs.ts';
import {
  type Act,
  beta,
  clone,
  DEAD_PID,
  done,
  hanging,
  jobsOf,
  lastSession,
  launcher,
  quick,
  store,
  ticket,
} from './run-fixture.ts';

/** A build identity that reads `v1` the first `n` times and `v2` after. */
function rebuiltAfter(n: number): () => string {
  let reads = 0;
  return () => (++reads > n ? 'v2' : 'v1');
}

/** Drive start, the queue's pre-ticket check, then the launch check sees the rebuild. */
const rebuilt = (repo: string | null = null): Promise<RunSummary> =>
  startSession(
    store,
    { mode: 'queue', repo },
    { launch: launcher(done).launch, ...quick, build: rebuiltAfter(2) },
  );

/** A fake child launcher: records each call and answers with `child`. */
function child(run: (args: readonly string[]) => Promise<number | null>) {
  const calls: { exe: string; args: readonly string[] }[] = [];
  const launch: HandoffLaunch = (exe, args) => {
    calls.push({ exe, args });
    return run(args);
  };
  return { calls, launch };
}

function handoffOf(s: RunSummary): NonNullable<RunSummary['handoff']> {
  if (s.handoff === undefined) throw new Error('no handoff');
  return s.handoff;
}

/** The new build's `orch resume`, in-process: the slot `--repo` names, else the only one. */
const resumeAs = (args: readonly string[], opts: Parameters<typeof resumeSession>[2]) => {
  const at = args.indexOf('--repo');
  return resumeSession(store, at < 0 ? {} : { repo: args[at + 1] }, opts);
};

/** A fake child running `resumeAs`; `r` is its summary once it ran. */
function resuming(opts: Parameters<typeof resumeSession>[2]) {
  const out: { r: RunSummary | null } & ReturnType<typeof child> = {
    r: null,
    ...child(async (args) => {
      out.r = await resumeAs(args, opts);
      return summaryExitCode(out.r);
    }),
  };
  return out;
}

describe('a rebuilt controller hands its session to the new build', () => {
  it('leaves the session resumable and unlocked, then launches exactly one orch resume', async () => {
    const id = ticket('In flight');
    const s = await rebuilt();
    const [job] = jobsOf(id);
    let atLaunch: unknown = null;
    const c = child(() => {
      atLaunch = {
        session: lastSession(),
        owner: getJob(store.db, job?.id ?? '').ownerSession,
        live: runnerSlots(store.paths).filter((x) => x.pid !== null).length,
      };
      return Promise.resolve(0);
    });

    expect(s.handoff).toEqual({ repo: null });
    const code = await handOff(handoffOf(s), { log: () => undefined, launch: c.launch });

    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]?.exe).toBe(process.execPath);
    expect(c.calls[0]?.args).toEqual([join(installRoot(), 'dist', 'cli', 'main.js'), 'resume']);
    expect(atLaunch).toMatchObject({
      session: { finished: null, ticketId: id, jobId: job?.id },
      owner: null,
      live: 0,
    });
    expect(code).toBe(0);
  });

  it("exits with the child's code: a late failure as it is, a signal as 1, --json passed on", async () => {
    ticket('In flight');
    const h = handoffOf(await rebuilt());
    let t = 0;
    const clock = () => (t += HANDOFF_REFUSAL_MS); // every child "ran" past the refusal window
    const lines: string[] = [];
    const log = (l: string) => lines.push(l);
    const late = child(() => Promise.resolve(3));
    const killed = child(() => Promise.resolve(null));

    expect(await handOff(h, { log, clock, launch: late.launch, json: true })).toBe(3);
    expect(late.calls[0]?.args.slice(1)).toEqual(['resume', '--json']);
    expect(await handOff(h, { log, clock, launch: killed.launch })).toBe(1);
    expect(lines.some((l) => l.includes('refused'))).toBe(false);
  });

  it('a child that fails at once is reported and not retried; the session stays resumable', async () => {
    const id = ticket('In flight');
    const s = await rebuilt();
    const lines: string[] = [];
    const c = child(() => Promise.resolve(1));

    const code = await handOff(handoffOf(s), { log: (l) => lines.push(l), launch: c.launch });

    expect(c.calls).toHaveLength(1);
    expect(code).toBe(1);
    expect(lines.find((l) => l.includes('Handoff refused'))).toContain('orch resume');
    expect(lastSession()).toMatchObject({ finished: null, ticketId: id });
  });

  it('a child whose own run halts on a rebuild is its own decision: the parent hands off once', async () => {
    const id = ticket('In flight');
    const s = await rebuilt();
    const c = resuming({ launch: launcher(done).launch, ...quick, build: rebuiltAfter(1) });

    const code = await handOff(handoffOf(s), { log: () => undefined, launch: c.launch });

    expect(c.calls).toHaveLength(1);
    expect(code).toBe(1);
    expect(lastSession()).toMatchObject({ finished: null, ticketId: id });
  });
});

describe('after the handoff the child owns the slot', () => {
  it('names a scoped slot with --repo, and orch stop reaches the child', async () => {
    ticket('Hangs until stopped');
    const s = await rebuilt(clone);
    const l = hanging(); // its launch asks the live controller, the child, to stop now
    const c = resuming({ launch: l.launch, ...quick });

    expect(s.handoff).toEqual({ repo: clone });
    const code = await handOff(handoffOf(s), { log: () => undefined, launch: c.launch });

    expect(c.calls[0]?.args.slice(1)).toEqual(['resume', '--repo', clone]);
    expect(l.killed).toBe(1);
    expect(c.r).toMatchObject({ stopped: true });
    expect(code).toBe(0);
    expect(lastSession()).toMatchObject({ finished: null, pid: process.pid });
  });

  it('orch stop next written during the child run ends it after its ticket', async () => {
    const first = ticket('Finishes', { priority: 'P1' });
    const second = ticket('Never started', { priority: 'P2' });
    const key = runnerScope(clone).key;
    const s = await rebuilt(clone);
    const stopNext: Act = (job, input) => {
      requestStop(store.paths, 'next', key);
      done(job, input);
    };
    const c = resuming({ launch: launcher(stopNext).launch, ...quick });

    await handOff(handoffOf(s), { log: () => undefined, launch: c.launch });

    expect(c.r?.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([[first, 'done']]);
    expect(jobsOf(second)).toHaveLength(0);
  });

  it('with two interrupted slots the child resumes the parent one', async () => {
    const id = ticket('Alpha');
    const s = await rebuilt(clone);
    const ts = new Date().toISOString();
    const betaKey = runnerScope(beta.clone).key;
    writeSession(
      store.paths,
      {
        pid: DEAD_PID,
        startedAt: ts,
        beatAt: ts,
        mode: 'queue',
        repo: beta.clone,
        ticket: null,
        ticketId: null,
        jobId: null,
        child: null,
        results: [],
        skipped: [],
        finished: null,
      },
      betaKey,
    );
    const c = resuming({ launch: launcher(done).launch, ...quick });

    const code = await handOff(handoffOf(s), { log: () => undefined, launch: c.launch });

    expect(code).toBe(0);
    expect(c.r?.tickets.map((t) => [t.ticketId, t.outcome])).toEqual([[id, 'done']]);
    const other = runnerSlots(store.paths).find((x) => x.key === betaKey);
    expect(other?.session?.finished).toBeNull();
  });
});

describe('only an orch-rebuilt halt hands off', () => {
  it('a finished run and a requested stop carry no handoff', async () => {
    ticket('Runs');
    const finished = await startSession(
      store,
      { mode: 'queue' },
      { launch: launcher(done).launch, ...quick },
    );
    expect(finished.handoff).toBeUndefined();
    ticket('Stopped');
    const stopped = await startSession(
      store,
      { mode: 'queue' },
      { launch: hanging().launch, ...quick },
    );
    expect(stopped).toMatchObject({ stopped: true });
    expect(stopped.handoff).toBeUndefined();
  });
});
