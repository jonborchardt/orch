/**
 * Status mail leads with what the job needs: the dashboard's blocker summary, the recorded reason,
 * and the next command or decision, before the Job/Stages/Events blocks. Seeds the dashboard
 * fixture and mails every job once through the fake SMTPS server.
 */
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { currentChoices, needsHuman } from '../src/ops/actions.ts';
import { reportJobMail } from '../src/ops/mail.ts';
import { getJob } from '../src/storage/jobs.ts';
import { seedDashboard, type SeededJobs } from './fixtures/dashboard.ts';
import { tempDir, type TempStore, tempStore } from './helpers.ts';
import { CERT, type FakeSmtp, fakeSmtp } from './mail-server.ts';

let smtp: FakeSmtp;
let store: TempStore;
let ids: SeededJobs;
const bodies = new Map<string, string>();

beforeAll(async () => {
  smtp = await fakeSmtp();
  setDefaultCACertificates([...getCACertificates('default'), CERT]);
  store = tempStore();
  ids = seedDashboard(store, {
    alpha: tempDir('alpha-'),
    beta: tempDir('beta-'),
    gamma: tempDir('gamma-'),
  });
  const out = await reportJobMail(store, 0, smtp.env());
  expect(out.every((o) => o.error === null)).toBe(true);
  for (const m of smtp.messages) {
    const id = /(job-[0-9a-f]+):/.exec(m.headers['subject'] ?? '')?.[1];
    if (id) bodies.set(id, m.body.replace(/\r\n/g, '\n'));
  }
}, 120_000);
afterAll(async () => {
  store.cleanup();
  await smtp.close();
});

/** The lines between the headline's blank line and the `Job:` line. */
function block(id: string): string[] {
  const lines = (bodies.get(id) ?? '').split('\n');
  return lines.slice(
    2,
    lines.findIndex((l) => l.startsWith('Job:')),
  );
}
const beforeStages = (id: string) => {
  const body = bodies.get(id) ?? '';
  return body.slice(0, body.indexOf('Stages:'));
};

/** Each current choice as the mail lists it, by its `currentChoices` index (`?choose=<n>`). */
function options(id: string): string[] {
  const view = needsHuman(store, getJob(store.db, id));
  return (view?.choices ?? []).map(
    (c, n) =>
      `  ${c.label}: ${c.effect}. ` +
      (c.available
        ? `http://127.0.0.1:4777/#/jobs/${id}?choose=${String(n)}`
        : '(not available now)'),
  );
}

describe('status mail says what each state needs', () => {
  it('a needs-human job from approve: what is needed, each choice with its link, then the detail', () => {
    const lines = block(ids.blocked);
    const labels = (currentChoices(store, getJob(store.db, ids.blocked)) ?? []).map((c) => c.label);
    expect(labels).toEqual(['Retry approve', 'Cancel']);
    expect(lines[0]).toBe(
      'The approver asks a person to decide: pick "Retry approve" or "Cancel".',
    );
    expect(lines[1]).toBe('Options:');
    expect(lines.slice(2, 4)).toEqual([
      `  Retry approve: the job goes back to approve and carries on from there. http://127.0.0.1:4777/#/jobs/${ids.blocked}?choose=0`,
      `  Cancel: the job ends for good; its branch and worktree are kept. http://127.0.0.1:4777/#/jobs/${ids.blocked}?choose=1`,
    ]);
    expect(lines.slice(2, 4)).toEqual(options(ids.blocked));
    // The internal detail follows what is needed.
    expect(lines[4]).toBe('Approver escalated: a human must decide');
    expect(lines[5]).toBe('Reason: AC2 needs deployment verification; unrequested logging change');
    expect(lines[6]).toBe(
      `Dashboard: run orch ui, then open http://127.0.0.1:4777/#/jobs/${ids.blocked}`,
    );
    expect(lines.slice(7)).toEqual(['']);
    const body = bodies.get(ids.blocked) ?? '';
    expect(body.split('\n').some((l) => l.startsWith('Decide on the dashboard:'))).toBe(false);
    expect(body).not.toContain('Resume:');
  });

  it('a ci escalation lists its choices with links, then the CI guidance', () => {
    const lines = block(ids.ciExhausted);
    expect(lines[0]).toMatch(/^CI still fails after the allowed repairs: pick /);
    expect(lines[1]).toBe('Options:');
    const opts = options(ids.ciExhausted);
    expect(opts.length).toBeGreaterThan(0);
    expect(lines.slice(2, 2 + opts.length)).toEqual(opts);
    expect(lines[2 + opts.length]).toMatch(/^CI still failing after 1 of 1 repair cycles$/);
    expect(lines.some((l) => l.startsWith('Decide on the dashboard:'))).toBe(false);
    const dash = lines.findIndex((l) => l.startsWith('Dashboard: '));
    expect(lines[dash + 1]).toBeTruthy(); // ciSummary guidance
    expect(lines.at(-1)).toBe('');
  });

  it('a failed job with no live owner says how to resume', () => {
    expect(block(ids.failed)).toEqual([
      'Stage build failed',
      'Reason: required check "test" failed twice',
      `Resume: /factory resume ${ids.failed}`,
      '',
    ]);
  });

  it('running and completed jobs get no block; the PR line stays above Stages:', () => {
    expect(block(ids.reviewing)).toEqual([]);
    expect(block(ids.completed)).toEqual([]);
    expect(beforeStages(ids.completed)).toContain('PR:     https://github.com/acme/alpha/pull/41');
  });

  it('a cancelled job shows the cancel summary and reason only', () => {
    const lines = block(ids.cancelled);
    expect(lines[0]).toMatch(/^Cancelled during spec/);
    expect(lines.slice(1)).toEqual(['Reason: decided against it', '']);
    const top = beforeStages(ids.cancelled);
    for (const s of ['Resume:', 'Decide on', 'Dashboard:']) expect(top).not.toContain(s);
  });
});
