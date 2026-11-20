/**
 * Session notices (todo 0069): `plan.notices` derived from state (base moved, PR merged,
 * cancelled, fetch failed) and posted messages shown until the owner acknowledges them. Local bare
 * origins only; nothing reaches the network.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { JOB_HELP } from '../src/cli/job.ts';
import { type Notice, type Plan, planJob, planJobFresh } from '../src/ops/factory.ts';
import { integrateBase } from '../src/ops/worktree.ts';
import { listEvents } from '../src/storage/events.ts';
import { createJob, getJob } from '../src/storage/jobs.ts';
import { jobs } from '../src/storage/schema.ts';
import { type Ctx, start, toReview } from './drive.ts';
import {
  cleanupTempDirs,
  commitFile,
  gitIn,
  json,
  makeRepoWithOrigin,
  orch,
  tempDir,
  type TempStore,
  tempStore,
} from './helpers.ts';

let store: TempStore;
let repo: { clone: string; bare: string };
beforeEach(() => {
  store = tempStore();
  repo = makeRepoWithOrigin();
});
afterEach(() => {
  store.cleanup();
});
afterAll(() => {
  cleanupTempDirs();
});

const cli = (...args: string[]) => orch(store.home, tmpdir(), args);
const next = (id: string) => json<Plan>(cli('factory', 'next', id, '--json'));
const kinds = (p: Plan) => p.notices.map((n) => n.kind);
const of = (p: Plan, kind: Notice['kind']) => p.notices.filter((n) => n.kind === kind);

/** A commit on origin's main made from another clone; the job's repository has not fetched it. */
function pushFromElsewhere(file: string): string {
  const other = join(tempDir('orch-other-'), 'c');
  gitIn(tmpdir(), 'clone', '-q', repo.bare, other);
  gitIn(other, 'config', 'user.email', 't@t');
  gitIn(other, 'config', 'user.name', 't');
  const sha = commitFile(other, file, 'x\n');
  gitIn(other, 'push', '-q', 'origin', 'main');
  return sha;
}

describe('base-moved', () => {
  it('names the base, count, and SHA, says to integrate, and clears after integrating', () => {
    const c = start(store, repo.clone);
    expect(kinds(planJob(store, c.id))).toEqual([]);
    const sha = commitFile(repo.clone, 'base.txt', 'b\n');
    gitIn(repo.clone, 'push', '-q', 'origin', 'main');
    const [moved] = of(planJob(store, c.id), 'base-moved');
    expect(moved).toMatchObject({ at: null, by: null, eventId: null });
    expect(moved?.text).toContain(`orch worktree integrate ${c.id} --token <token>`);
    expect(moved?.text).toContain(sha.slice(0, 7));
    expect(moved?.text).toContain('1 commit(s)');
    expect(moved?.text).toContain('before the next `orch verify`');
    integrateBase(store, c.id, { token: c.token });
    expect(of(planJob(store, c.id), 'base-moved')).toEqual([]);
  });

  it('waits for the review round to complete', () => {
    const c = start(store, repo.clone);
    toReview(store, c);
    commitFile(repo.clone, 'base.txt', 'b\n');
    gitIn(repo.clone, 'push', '-q', 'origin', 'main');
    const plan = planJob(store, c.id);
    expect(plan.stage).toBe('review');
    expect(of(plan, 'base-moved')[0]?.text).toContain('after this round');
  });

  it('is seen from origin only by the session path, which fetches', () => {
    const c = start(store, repo.clone);
    const sha = pushFromElsewhere('elsewhere.txt');
    // Dashboard and mail path: no fetch, so no notice yet.
    expect(of(planJob(store, c.id), 'base-moved')).toEqual([]);
    const plan = next(c.id);
    expect(of(plan, 'base-moved')[0]?.text).toContain(sha.slice(0, 7));
    const sha2 = pushFromElsewhere('elsewhere2.txt');
    const fresh = planJobFresh(store, c.id);
    expect(of(fresh, 'base-moved')[0]?.text).toContain(sha2.slice(0, 7));
    expect(of(fresh, 'fetch-failed')).toEqual([]);

    // An unreachable origin is reported, not fatal.
    gitIn(repo.clone, 'remote', 'set-url', 'origin', join(tempDir('orch-gone-'), 'missing.git'));
    const r = cli('factory', 'next', c.id, '--json');
    expect(r.code, r.err).toBe(0);
    const [failed] = of(json<Plan>(r), 'fetch-failed');
    expect(failed?.text).toContain('Could not fetch origin/main (');
    expect(failed?.text).toContain('base-moved uses the last fetched ref');

    // No origin: nothing is fetched and nothing reported.
    gitIn(repo.clone, 'remote', 'remove', 'origin');
    const none = cli('factory', 'next', c.id, '--json');
    expect(none.code, none.err).toBe(0);
    expect(of(json<Plan>(none), 'fetch-failed')).toEqual([]);
  });
});

describe('derived notices', () => {
  it('reports who cancelled the job and why', () => {
    const c = start(store, repo.clone);
    const r = cli('factory', 'cancel', c.id, '--reason', 'dup', '--session', 'other', '--force');
    expect(r.code, r.err).toBe(0);
    const plan = next(c.id);
    expect(plan.step).toBe('cancelled');
    const [n] = of(plan, 'cancelled');
    expect(n).toMatchObject({ by: 'other', text: 'Cancelled by other: dup' });
    expect(n?.at).toBeTruthy();
    expect(n?.eventId).toBe(
      listEvents(store.db, c.id, 100).find((e) => e.type === 'job.cancelled')?.id,
    );
  });

  it('reports a merged PR with its URL', () => {
    const j = createJob(store, {
      title: 'Merged',
      description: 'd',
      repo: 'github.com/acme/alpha',
      repoPath: repo.clone,
      baseBranch: 'main',
    });
    const url = 'https://github.com/acme/alpha/pull/7';
    store.db.update(jobs).set({ prUrl: url, prState: 'merged' }).where(eq(jobs.id, j.id)).run();
    const [n] = of(planJob(store, j.id), 'pr-merged');
    expect(n?.text).toContain(url);
    expect(n).toMatchObject({ at: null, by: null, eventId: null });
  });
});

describe('posted notices', () => {
  const post = (id: string, text: string) => cli('job', 'notice', 'post', id, '--message', text);
  const ack = (c: Ctx, through: number | undefined, token = c.token) =>
    cli('job', 'notice', 'ack', c.id, '--through', String(through), '--token', token);

  it('shows a message until the owner acknowledges it, leaving commands alone', () => {
    const c = start(store, repo.clone);
    const before = planJob(store, c.id);
    const revision = getJob(store.db, c.id).revision;
    const r = post(c.id, 'main has the verify fix');
    expect(r.code, r.err).toBe(0);
    expect(getJob(store.db, c.id).revision).toBe(revision);

    const plan = next(c.id);
    const [m] = of(plan, 'message');
    const id = listEvents(store.db, c.id, 100).find((e) => e.type === 'notice.posted')?.id;
    expect(m).toMatchObject({ text: 'main has the verify fix', by: 'human', eventId: id });
    // The post reports the id of the event it appended.
    expect(r.out).toMatch(new RegExp(`eventId\\s+${String(id)}\\b`));
    expect(m?.at).toBeTruthy();
    expect(plan.noticeAck).toBe(
      `orch job notice ack ${c.id} --through ${String(id)} --token <token>`,
    );
    expect(plan.commands).toEqual(before.commands);
    expect(before.noticeAck).toBeNull();

    expect(ack(c, id).code).toBe(0);
    const acked = next(c.id);
    expect(of(acked, 'message')).toEqual([]);
    expect(acked.noticeAck).toBeNull();

    // A newer message shows; acking an older id after it never brings either back.
    expect(post(c.id, 'second').code).toBe(0);
    const second = of(next(c.id), 'message');
    expect(second.map((n) => n.text)).toEqual(['second']);
    expect(ack(c, second[0]?.eventId ?? undefined).code).toBe(0);
    expect(ack(c, id).code).toBe(0);
    const after = next(c.id);
    expect(of(after, 'message')).toEqual([]);
    expect(after.noticeAck).toBeNull();
  });

  it('refuses blank text, finished jobs, the wrong token, and foreign or non-notice ids', () => {
    const c = start(store, repo.clone);
    expect(post(c.id, '   ').code).toBe(2);
    expect(post(c.id, 'x'.repeat(2001)).code).toBe(1);
    expect(post(c.id, 'hello').code).toBe(0);
    const posted = listEvents(store.db, c.id, 100);
    const notice = posted.find((e) => e.type === 'notice.posted')?.id;
    const created = posted.find((e) => e.type === 'job.created')?.id;
    expect(ack(c, notice, 'wrong-token').code).toBe(4);
    expect(ack(c, created).code).toBe(1);

    const other = start(store, repo.clone, 'Other job');
    expect(post(other.id, 'for the other job').code).toBe(0);
    const foreign = listEvents(store.db, other.id, 100).find((e) => e.type === 'notice.posted')?.id;
    expect(ack(c, foreign).code).toBe(1);
    expect(of(next(c.id), 'message').map((n) => n.text)).toEqual(['hello']);

    expect(
      cli('factory', 'cancel', other.id, '--reason', 'r', '--session', 's', '--force').code,
    ).toBe(0);
    expect(post(other.id, 'too late').code).toBe(1);
    store.db
      .update(jobs)
      .set({ stage: 'completed', status: 'completed' })
      .where(eq(jobs.id, c.id))
      .run();
    expect(post(c.id, 'too late').code).toBe(1);
    // Unacked messages still show on a finished job, with nothing to acknowledge.
    const done = planJob(store, c.id);
    expect(of(done, 'message')).toHaveLength(1);
    expect(done.noticeAck).toBeNull();
  });

  it('is listed in orch job --help', () => {
    expect(JOB_HELP).toContain('notice post <id> --message <m> [--by <name>]');
    expect(JOB_HELP).toContain('notice ack <id> --through <event-id> --token <t>');
    const r = cli('job', '--help');
    expect(r.out + r.err).toContain('notice post');
    expect(r.out + r.err).toContain('notice ack');
  });
});
