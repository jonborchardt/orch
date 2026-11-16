/**
 * The dashboard's human Merge and Refresh PR: merge only the verified head of a PR orch marked
 * ready, after GitHub confirms it; refresh records only the PR's state. Nothing changes stage,
 * status, or the CI verdict, and nothing merges unless asked.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/core/errors.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { resumeFactoryJob } from '../src/ops/factory.ts';
import { prStatus } from '../src/ops/github.ts';
import { detail } from '../src/server/api.ts';
import { listEvents } from '../src/storage/events.ts';
import { recordCi, transitionJob } from '../src/storage/jobs.ts';
import { type Ctx, head, start, toCi } from './drive.ts';
import { checks, clone, ghCalls, job, reconcile, run, shim, store } from './ci-fixture.ts';

const URL = 'https://github.com/acme/alpha/pull/1';
const events = (c: Ctx, type: string) =>
  listEvents(store.db, c.id, 1000)
    .filter((e) => e.type === type)
    .map((e) => e.payload);
const editPr = (patch: Record<string, unknown>) => {
  const st = shim.read();
  st.prs[0] = { ...st.prs[0], ...patch };
  shim.write({ prs: st.prs });
};
const merge = (c: Ctx) => dashboardAction(store, c.id, { action: 'merge', force: true });
const refresh = (c: Ctx) => dashboardAction(store, c.id, { action: 'refresh-pr', force: true });
const verdict = (c: Ctx) => {
  const j = job(c);
  return { stage: j.stage, status: j.status, ciHead: j.ciHead, ciStatus: j.ciStatus };
};

/** Driven through `orch gh ci` to completion on a passing verdict, with the PR marked ready. */
function completed(): { c: Ctx; sha: string } {
  const c = start(store, clone);
  toCi(store, c);
  const sha = head(c.wt);
  checks(sha, [run('test', 'success')]);
  expect(reconcile(c)).toMatchObject({ action: 'complete', ready: 'marked' });
  return { c, sha };
}

describe('dashboard merge', () => {
  it('merges the verified head of a ready PR, recording pr.merged and nothing else', () => {
    const { c, sha } = completed();
    expect(detail(store, c.id).actions).toEqual(['merge', 'refresh-pr', 'archive']);
    expect(detail(store, c.id).prPhase).toBe('ready-to-merge');
    const before = verdict(c);
    const r = merge(c);
    expect(r.message).toContain(`Merged ${URL}`);
    expect(ghCalls('merge')).toEqual([['pr', 'merge', URL, '--merge', '--match-head-commit', sha]]);
    expect(job(c).prState).toBe('merged');
    expect(verdict(c)).toEqual(before);
    expect(before).toEqual({
      stage: 'completed',
      status: 'completed',
      ciHead: sha,
      ciStatus: 'passing',
    });
    expect(events(c, 'pr.merged')).toEqual([{ head: sha, ok: true, error: null }]);
    expect(detail(store, c.id).prPhase).toBe('merged');
    expect(detail(store, c.id).actions).toEqual(['archive']);
  });

  it('refuses without merging when GitHub or the record does not back the verified head', () => {
    const { c, sha } = completed();
    const refused = () => {
      expect(() => merge(c)).toThrow(ValidationError);
      expect(ghCalls('merge')).toHaveLength(0);
      expect(job(c).prState).toBe('ready');
    };
    // The recorded verdict is not passing (refused before GitHub is asked).
    recordCi(store, c.id, { token: c.token, ciStatus: 'pending', head: sha });
    expect(detail(store, c.id).actions).not.toContain('merge');
    refused();
    recordCi(store, c.id, { token: c.token, ciStatus: 'passing', head: sha });
    // GitHub says draft, then not mergeable, then a different head.
    editPr({ isDraft: true });
    refused();
    editPr({ isDraft: false, mergeable: 'CONFLICTING' });
    refused();
    editPr({ mergeable: 'MERGEABLE', headRefOid: '0'.repeat(40) });
    const { bare } = shim.read();
    shim.write({ bare: undefined });
    refused();
    shim.write({ bare });
    expect(events(c, 'pr.merged')).toEqual([]);

    // Not completed, then completed by a human close-out.
    const d = start(store, clone);
    toCi(store, d);
    checks('*', []);
    expect(() => merge(d)).toThrow(ValidationError);
    for (let i = 0; i < 10 && job(d).stage === 'ci'; i++) reconcile(d);
    expect(job(d).stage).toBe('needs-human');
    resumeFactoryJob(store, d.id, { session: 'human-decided', to: 'completed', force: true });
    expect(job(d).stage).toBe('completed');
    expect(detail(store, d.id).actions).not.toContain('merge');
    expect(() => merge(d)).toThrow(ValidationError);
    expect(ghCalls('merge')).toHaveLength(0);
  });

  it('a merge GitHub refuses is recorded with its message and leaves the PR ready', () => {
    const { c, sha } = completed();
    shim.write({ fail: 'pr merge' });
    expect(() => merge(c)).toThrow(/gh pr merge failed: shim: simulated failure/);
    expect(ghCalls('merge')).toHaveLength(1);
    expect(job(c).prState).toBe('ready');
    expect(events(c, 'pr.merged')).toEqual([
      { head: sha, ok: false, error: 'shim: simulated failure' },
    ]);
  });
});

describe('refresh PR', () => {
  it('records only the PR state on a completed job, from pr status or the dashboard', () => {
    const { c, sha } = completed();
    const completedAt = job(c).completedAt;
    // orch gh pr status --token on a completed job keeps the verdict (fix 5a).
    editPr({ state: 'CLOSED' });
    const s = prStatus(store, c.id, { token: c.token });
    expect(s.recorded).toBe(true);
    expect(job(c)).toMatchObject({ prState: 'closed', ciHead: sha, ciStatus: 'passing' });
    // Merged on GitHub by hand: Refresh PR records it.
    editPr({ state: 'MERGED' });
    expect(detail(store, c.id).actions).toContain('refresh-pr');
    refresh(c);
    expect(job(c)).toMatchObject({
      prState: 'merged',
      ciHead: sha,
      ciStatus: 'passing',
      completedAt,
    });
    expect(events(c, 'pr.observed').at(-1)).toEqual({ state: 'merged', head: sha });
    expect(detail(store, c.id).actions).not.toContain('refresh-pr');
    expect(ghCalls('merge')).toHaveLength(0);
  });

  it('on a ci escalation, a refresh that observes the merge makes accept-delivery available', () => {
    const e = start(store, clone);
    toCi(store, e);
    const sha = head(e.wt);
    checks(sha, [run('test', null, 'queued')]);
    expect(reconcile(e)).toMatchObject({ action: 'wait' });
    transitionJob(store, e.id, 'escalate', { token: e.token, reason: 'a human looks at it' });
    expect(job(e)).toMatchObject({ stage: 'needs-human', returnStage: 'ci', ciStatus: 'pending' });
    expect(detail(store, e.id).actions).not.toContain('accept-delivery');
    expect(detail(store, e.id).actions).toContain('refresh-pr');
    editPr({ state: 'CLOSED' });
    dashboardAction(store, e.id, { action: 'refresh-pr' });
    expect(job(e).prState).toBe('closed');
    editPr({ state: 'MERGED' });
    dashboardAction(store, e.id, { action: 'refresh-pr' });
    expect(job(e)).toMatchObject({ prState: 'merged', stage: 'needs-human', ciStatus: 'pending' });
    expect(detail(store, e.id).actions).toContain('accept-delivery');
  });
});
