/**
 * Shared setup for the factory controller test files (run.test.ts, run-evidence.test.ts): a
 * stateful `gh` shim, two policy repositories, a temporary store per test, and a stand-in for the
 * Claude child that puts the job in the state a session would leave it in. Vitest loads this
 * module once per test file, so files running in parallel never share it.
 */
import { rmSync } from 'node:fs';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import type { ClaudeChild, LaunchInput } from '../src/integrations/claude-session.ts';
import { setMergeAuthorization } from '../src/ops/merge.ts';
import { type RunSummary, startSession } from '../src/ops/run.ts';
import { requestStop } from '../src/ops/runner-state.ts';
import { addTicket, showTicket } from '../src/ops/tickets.ts';
import { appendEvent, listEvents } from '../src/storage/events.ts';
import { getJob } from '../src/storage/jobs.ts';
import { type Event, type Job, jobs } from '../src/storage/schema.ts';
import { ticketJobs } from '../src/storage/tickets.ts';
import { type GhShim, gitIn, makePolicyRepo, type TempStore, useJobRepo } from './helpers.ts';

/** The verified head: a real commit (the clone's main), so the merge's workflow check reads it. */
export let SHA = '';
export const OTHER = 'b'.repeat(40);
export const DEAD_PID = 2 ** 31 - 1;

export let store: TempStore;
export let clone: string;
export let beta: { clone: string; bare: string };
export let shim: GhShim;
let n = 0;

useJobRepo(
  { shim: 'acme/alpha', policy: true, perFile: true },
  (s) => ({ store, clone, shim } = s),
);
beforeAll(() => {
  SHA = gitIn(clone, 'rev-parse', 'HEAD');
  beta = makePolicyRepo('git@github.com:acme/beta.git');
});
afterAll(() => {
  for (const d of [beta.clone, beta.bare]) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  n = 0;
  setMergeAuthorization(store, clone, true);
});

export const ticket = (title: string, o: Record<string, unknown> = {}) =>
  addTicket(store, { title, repo: clone, ...o }).id;
export const status = (id: number) => showTicket(store, id).ticket.status;
export const jobsOf = (id: number) => ticketJobs(store.db, id);
export const merges = () => shim.read().calls.filter((c) => c[0] === 'pr' && c[1] === 'merge');
export const editPr = (job: Job, patch: Record<string, unknown>) => {
  shim.write({
    prs: shim.read().prs.map((p) => (p['url'] === job.prUrl ? { ...p, ...patch } : p)),
  });
};
/** The job's events of one type, oldest first. */
export const eventsOf = (jobId: string, type: string): Event[] =>
  listEvents(store.db, jobId, 1000).filter((e) => e.type === type);

/** What a session that ran the job to the end leaves: completed on a passing verdict, PR open. */
export function finish(job: Job, pr: Record<string, unknown> = {}, head = SHA): Job {
  n += 1;
  const url = `https://github.com/acme/alpha/pull/${String(n)}`;
  const branch = job.branch ?? `factory/${job.id}`;
  const ts = new Date().toISOString();
  store.db
    .update(jobs)
    .set({
      stage: 'completed',
      status: 'completed',
      branch,
      prUrl: url,
      prState: 'ready',
      ciStatus: 'passing',
      ciHead: head,
      completedAt: ts,
      ownerSession: null,
      ownerToken: null,
      leaseExpiresAt: null,
    })
    .where(eq(jobs.id, job.id))
    .run();
  appendEvent(store.db, job.id, 'job.completed', { prUrl: url, head }, null, ts);
  shim.write({
    prs: [
      ...shim.read().prs,
      {
        number: n,
        url,
        state: 'OPEN',
        isDraft: false,
        baseRefName: 'main',
        headRefName: branch,
        headRefOid: head,
        mergeable: 'MERGEABLE',
        title: job.title,
        statusCheckRollup: [],
        isCrossRepository: false,
        ...pr,
      },
    ],
  });
  return getJob(store.db, job.id);
}

export type Act = (job: Job, input: LaunchInput) => void;
export const idle: Act = () => undefined;
export const done: Act = (job) => {
  finish(job);
};

export interface Launcher {
  launch: (input: LaunchInput) => ClaudeChild;
  calls: (LaunchInput & { jobId: string })[];
}

const jobIdOf = (input: LaunchInput) => /job-[0-9a-f]{8}/.exec(input.prompt)?.[0] ?? '';

/** A stand-in for the Claude child: the n-th launch runs the n-th act (the last one repeats). */
export function launcher(...acts: Act[]): Launcher {
  const calls: Launcher['calls'] = [];
  return {
    calls,
    launch: (input) => {
      const jobId = jobIdOf(input);
      calls.push({ ...input, jobId });
      (acts[Math.min(calls.length, acts.length) - 1] ?? idle)(getJob(store.db, jobId), input);
      return {
        pid: DEAD_PID,
        startedAt: new Date().toISOString(),
        done: Promise.resolve({ code: 0, signal: null, error: null }),
        kill: () => undefined,
      };
    },
  };
}

/**
 * The first launches run `before`, one act each, and exit; the next one is a child that runs
 * until it is killed, and launching it asks the controller to stop now.
 */
export function hanging(...before: Act[]): Launcher & { killed: number } {
  const l = launcher(...before) as Launcher & { killed: number };
  const exiting = l.launch;
  l.killed = 0;
  l.launch = (input) => {
    if (l.calls.length < before.length) return exiting(input);
    l.calls.push({ ...input, jobId: jobIdOf(input) });
    let end: (e: { code: null; signal: string; error: null }) => void = () => undefined;
    const exited = new Promise<{ code: null; signal: string; error: null }>((r) => (end = r));
    requestStop(store.paths, 'now');
    return {
      pid: DEAD_PID,
      startedAt: new Date().toISOString(),
      done: exited,
      kill: () => {
        l.killed += 1;
        end({ code: null, signal: 'SIGTERM', error: null });
      },
    };
  };
  return l;
}

/** No real waits: a stubbed sleep, a 1 ms poll, and a zero-second GitHub backoff of production length. */
export const quick = {
  sleep: () => Promise.resolve(),
  pollMs: 1,
  githubBackoff: [0, 0, 0, 0, 0],
};
export const queue = (l: Launcher, repo: string | null = null): Promise<RunSummary> =>
  startSession(store, { mode: 'queue', repo }, { launch: l.launch, ...quick });
export const one = (l: Launcher, id: number): Promise<RunSummary> =>
  startSession(store, { mode: 'ticket', ticket: id }, { launch: l.launch, ...quick });
