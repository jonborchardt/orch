/** `orch factory` commands generate an owner session id when neither --session nor $ORCH_SESSION is given. */
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { listEvents } from '../src/storage/events.ts';
import { json, orch } from './helpers.ts';
import { clone, store } from './factory-fixture.ts';

const NAME = /^[\w.:-]{1,64}$/;
const START = ['factory', 'start', '--title', 't', '--description', 'd'];

interface Started {
  session: string;
  token: string;
  job: { id: string; ownerSession: string | null };
}

describe('orch factory session ids', () => {
  it('start, resume, dispatch, and cancel generate, honour, and return the session', () => {
    const home = store.home;
    const start = (env = {}, args: string[] = []) =>
      json<Started>(orch(home, clone, ['--json', ...START, ...args], env));

    // Generated when absent (an empty variable counts as absent), unique, and the job's owner.
    const a = start({ ORCH_SESSION: '' });
    expect(a.session).toMatch(NAME);
    expect(a.job.ownerSession).toBe(a.session);
    const b = start();
    expect(b.session).toMatch(NAME);
    expect(b.session).not.toBe(a.session);

    // $ORCH_SESSION, then --session, take precedence.
    expect(start({ ORCH_SESSION: 'env-s' }).session).toBe('env-s');
    expect(start({ ORCH_SESSION: 'env-s' }, ['--session', 'flag-s']).session).toBe('flag-s');
    expect(orch(home, clone, [...START, '--session', 'bad session!']).code).toBe(2);

    // Human output names the session.
    const human = orch(home, clone, START);
    expect(human.code, human.err).toBe(0);
    expect(human.out).toMatch(/^session\s+orch-[0-9a-f]{16}$/m);

    // Passing the returned id back renews the lease; a fresh generated id meets it and exits 4.
    const resumed = json<{ session: string; tookOver: boolean }>(
      orch(home, tmpdir(), ['--json', 'factory', 'resume', a.job.id, '--session', a.session]),
    );
    expect([resumed.session, resumed.tookOver]).toEqual([a.session, false]);
    expect(orch(home, tmpdir(), ['factory', 'resume', a.job.id]).code).toBe(4);

    // Dispatch records the generated session as the creator.
    const d = json<{ session: string; job: { id: string } }>(
      orch(home, clone, ['--json', 'factory', 'dispatch', '--title', 'x', '--description', 'y']),
    );
    expect(d.session).toMatch(NAME);
    const created = listEvents(store.db, d.job.id).find((e) => e.type === 'job.created');
    expect(created?.actor).toBe(d.session);

    // Cancel of the unowned dispatched job works without --session and returns it.
    const c = json<{ session: string }>(
      orch(home, tmpdir(), ['--json', 'factory', 'cancel', d.job.id, '--reason', 'done']),
    );
    expect(c.session).toMatch(NAME);
  });
});
