/**
 * Status mail leads with what the job needs: the dashboard's blocker summary, the recorded reason,
 * and the next command or decision, before the Job/Stages/Events blocks. Seeds the dashboard
 * fixture and mails every job once through the fake SMTPS server.
 */
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reportJobMail } from '../src/ops/mail.ts';
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

describe('status mail says what each state needs', () => {
  it('a needs-human job from approve: summary, reason, decisions, dashboard; no resume', () => {
    const lines = block(ids.blocked);
    expect(lines[0]).toBe('Approver escalated: a human must decide');
    expect(lines[1]).toBe('Reason: AC2 needs deployment verification; unrequested logging change');
    expect(lines[2]).toBe(
      'Decide on the dashboard: approve, request-review, request-rework, cancel',
    );
    expect(lines[3]).toBe(
      `Dashboard: run orch ui, then open http://127.0.0.1:4777/#/jobs/${ids.blocked}`,
    );
    expect(lines.slice(4)).toEqual(['']);
    const top = lines.join('\n');
    for (const word of ['merge', 'refresh-pr', 'archive', 'remove-worktree'])
      expect(top).not.toContain(word);
    expect(bodies.get(ids.blocked)).not.toContain('Resume:');
  });

  it('a ci escalation adds the CI guidance after the decisions', () => {
    const lines = block(ids.ciExhausted);
    expect(lines[0]).toMatch(/^CI still failing after 1 of 1 repair cycles$/);
    expect(lines.some((l) => l.startsWith('Decide on the dashboard: '))).toBe(true);
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
