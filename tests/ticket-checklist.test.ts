/**
 * Approval accounts for the linked ticket's checklist (ticket 0114): the pure matching rule, the
 * gate on completing approve, and the approve plan.
 */
import { rmSync } from 'node:fs';

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';

import { ValidationError } from '../src/core/errors.ts';
import { deferredItems, ticketKey, unaccountedItems } from '../src/core/tickets.ts';
import { planJob, startJob } from '../src/ops/factory.ts';
import { addTicket, ticketAction } from '../src/ops/tickets.ts';
import { getJob } from '../src/storage/jobs.ts';
import { add, type Ctx, go, makePolicyRepo, passRound, SESSION, start, toReview } from './drive.ts';
import { fixture, type TempStore, tempStore } from './helpers.ts';

const section = (lines: string) =>
  `# Decision\n\n## Rationale\nok\n\n## Ticket checklist\n\n${lines}\n\nDECISION: APPROVE\n`;

describe('unaccountedItems', () => {
  it('returns [] when nothing is unchecked or every item is recorded as not delivered', () => {
    expect(unaccountedItems('## What\n\n- [x] done\nprose', section(''))).toEqual([]);
    expect(
      unaccountedItems(
        '- [ ] a\n- [ ] b c\n',
        section('- [ ] a — later\n- [ ]  b c  —  out of scope'),
      ),
    ).toEqual([]);
    // A duplicated item is accounted for by one line.
    expect(unaccountedItems('- [ ] a\n- [ ] a\n', section('- [ ] a — r'))).toEqual([]);
  });

  it('returns the item for a missing, ticked, reasonless, undelimited, or prefix line', () => {
    const one = (lines: string) => unaccountedItems('- [ ] a\n', section(lines));
    expect(one('')).toEqual(['a']);
    expect(one('- [x] a — delivered')).toEqual(['a']);
    expect(one('- [ ] a — ')).toEqual(['a']);
    expect(one('- [ ] a')).toEqual(['a']);
    expect(one('- [ ] a - reason')).toEqual(['a']);
    expect(one('- [ ] ab — reason')).toEqual(['a']);
    expect(one('- [ ] A — reason')).toEqual(['a']);
    expect(unaccountedItems('- [ ] a\n- [ ] a\n', '')).toEqual(['a']);
  });

  it('reads only the Ticket checklist section', () => {
    const before = '# Decision\n\n- [ ] a — r\n\n## Ticket checklist\n\nnone\n';
    const after = '# Decision\n\n## Ticket checklist\n\nnone\n\n## Notes\n\n- [ ] a — r\n';
    const sub = '# Decision\n\n## Ticket checklist\n\n### Out\n\n- [ ] a — r\n';
    expect(unaccountedItems('- [ ] a', before)).toEqual(['a']);
    expect(unaccountedItems('- [ ] a', after)).toEqual(['a']);
    expect(unaccountedItems('- [ ] a', sub)).toEqual([]);
  });
});

describe('deferredItems', () => {
  it('reads the follow-up id in any form a ticket id takes, with or without a why', () => {
    expect(
      deferredItems(
        section(
          '- [ ] a — deferred to 0116\n- [ ] b — deferred to #116\n- [ ] c — deferred to 116: needs a rebuild',
        ),
      ),
    ).toEqual([
      { item: 'a', to: 116 },
      { item: 'b', to: 116 },
      { item: 'c', to: 116 },
    ]);
    // A deferral is still a not-delivered line.
    expect(unaccountedItems('- [ ] a', section('- [ ] a — deferred to 0116'))).toEqual([]);
  });

  it('ignores lines outside the section, ticked lines, and other reasons', () => {
    expect(deferredItems('# Decision\n\n- [ ] a — deferred to 0116\n')).toEqual([]);
    expect(deferredItems(section('- [x] a — deferred to 0116'))).toEqual([]);
    for (const reason of [
      'needs a rebuild, deferred to 0116',
      'moved to 0116',
      'deferred to later',
      'deferred to 0116x',
      'deferred to 0',
      'Deferred to 0116',
    ]) {
      expect(deferredItems(section(`- [ ] a — ${reason}`))).toEqual([]);
    }
  });
});

describe('completing approve for a ticket job', () => {
  let store: TempStore;
  let clone: string;
  let bare: string;
  beforeAll(() => {
    ({ clone, bare } = makePolicyRepo());
  });
  afterAll(() => {
    for (const d of [clone, bare]) rmSync(d, { recursive: true, force: true });
  });
  beforeEach(() => {
    store = tempStore();
  });
  afterEach(() => {
    store.cleanup();
  });

  const BODY = '## What\n\n- [ ] a\n- [ ] b\n';

  /** A ticket-linked job in approve, running, with `decision` registered. */
  function toApprove(body: string, decision: string): Ctx & { ticket: number } {
    const ticket = addTicket(store, { title: 'Checklist', repo: clone, body }).id;
    const r = startJob(store, { ticket, session: SESSION, cwd: clone });
    const c = {
      id: r.job.id,
      token: r.token,
      dir: r.plan.artifactDir,
      wt: r.job.worktreePath ?? '',
    };
    toReview(store, c);
    passRound(store, c);
    go(store, c, 'start');
    add(store, c, 'decision.md', decision);
    return { ...c, ticket };
  }
  const tick = (ticket: number, body: string) =>
    ticketAction(store, ticket, { action: 'edit', body });

  it('refuses while a box decision.md marks delivered is unticked, and completes once ticked', () => {
    const c = toApprove(BODY, section('- [x] a — test A\n- [x] b — test B'));
    let err: unknown;
    try {
      go(store, c, 'complete');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).exitCode).toBe(1);
    const msg = (err as Error).message;
    expect(msg).toContain('"a", "b"');
    expect(msg).toContain('orch ticket edit 0001 --body-file -');
    expect(msg).toContain('- [ ] a — <reason>');
    expect(getJob(store.db, c.id).stage).toBe('approve');

    tick(c.ticket, BODY.replaceAll('[ ]', '[x]'));
    expect(go(store, c, 'complete').stage).toBe('pr');
  });

  it('a box recorded as not delivered may stay unticked', () => {
    const c = toApprove(BODY, section('- [x] a — test A\n- [ ] b — not delivered: needs a human'));
    expect(() => go(store, c, 'complete')).toThrow(/"a"/);
    tick(c.ticket, BODY.replace('[ ] a', '[x] a'));
    expect(go(store, c, 'complete').stage).toBe('pr');
  });

  it('a ticket without a checklist, and a job without a ticket, complete as before', () => {
    const c = toApprove('## What\n\nNo boxes.\n', fixture('decision.md'));
    expect(planJob(store, c.id).commands.join('\n')).not.toContain('orch ticket');
    expect(go(store, c, 'complete').stage).toBe('pr');

    const plain = start(store, clone);
    toReview(store, plain);
    passRound(store, plain);
    go(store, plain, 'start');
    add(store, plain, 'decision.md', fixture('decision.md'));
    const commands = planJob(store, plain.id).commands;
    expect(commands.join('\n')).not.toContain('orch ticket');
    expect(commands).toHaveLength(4);
    expect(go(store, plain, 'complete').stage).toBe('pr');
  });

  /** The ValidationError (exit 1) completing approve throws; the job stays in approve. */
  const refusal = (c: Ctx): string => {
    let err: unknown;
    try {
      go(store, c, 'complete');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).exitCode).toBe(1);
    expect(getJob(store.db, c.id).stage).toBe('approve');
    return (err as Error).message;
  };
  const note = (ticket: number, text: string) =>
    ticketAction(store, ticket, { action: 'note', text });

  it('a deferred box must leave the body and be noted before approve completes', () => {
    const c = toApprove(BODY, section('- [x] a — A\n- [ ] b — deferred to 0002: needs a rebuild'));
    addTicket(store, { title: 'Follow-up', repo: clone, body: '- [ ] b\n' });
    tick(c.ticket, '## What\n\n- [x] a\n- [ ] b\n');
    const still = refusal(c);
    expect(still).toContain('"b" is deferred to 0002 but is still an unchecked box');
    expect(still).toContain('orch ticket edit 0001 --body-file -');

    tick(c.ticket, '## What\n\n- [x] a\n\nb (deferred to 0002)\n');
    note(c.ticket, 'unrelated');
    expect(refusal(c)).toContain('orch ticket note 0001 "b: deferred to 0002"');

    note(c.ticket, 'b: deferred to 0002');
    expect(go(store, c, 'complete').stage).toBe('pr');
  });

  it('a deferral to a missing, own, or finished ticket is refused with no box left', () => {
    const c = toApprove('- [x] a\n', section('- [ ] a — deferred to 0099'));
    note(c.ticket, 'a: deferred to 0099, 0001, 0002, 0003, 0004');
    expect(refusal(c)).toContain('0099, which does not exist');
    const defer = (to: string) =>
      add(store, c, 'decision.md', section(`- [ ] a — deferred to ${to}`), true);
    defer('#1');
    expect(refusal(c)).toContain('0001, which is this ticket');
    for (const [action, status] of [
      ['done', 'done'],
      ['drop', 'dropped'],
      ['duplicate', 'duplicate'],
    ] as const) {
      const t = addTicket(store, { title: `Follow-up ${status}`, repo: clone }).id;
      ticketAction(store, t, { action, ...(action === 'duplicate' ? { of: c.ticket } : {}) });
      defer(String(t));
      expect(refusal(c)).toContain(`which is ${status}`);
    }
    const open = addTicket(store, { title: 'Open follow-up', repo: clone }).id;
    note(c.ticket, `a: deferred to ${ticketKey(open)}`);
    defer(String(open));
    expect(go(store, c, 'complete').stage).toBe('pr');
  });

  it('the approve plan lists the boxes and ticks or notes them before complete', () => {
    const c = toApprove(BODY, section('- [x] a — A\n- [x] b — B'));
    const plan = planJob(store, c.id);
    expect(plan.reason).toContain('Ticket 0001 has unchecked checklist item(s): "a", "b"');
    expect(plan.reason).toContain('deferred to <key>');
    const at = (s: string) => plan.commands.findIndex((x) => x.includes(s));
    expect(at('orch ticket edit 0001 --body-file -')).toBeGreaterThan(at('decision.md'));
    expect(at('orch ticket note 0001')).toBeGreaterThan(at('orch ticket edit'));
    expect(at(' complete')).toBeGreaterThan(at('orch ticket note'));
  });
});
