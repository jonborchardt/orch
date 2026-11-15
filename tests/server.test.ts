/** Dashboard API: read models, security guards, actions through the domain layer. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MAX_CI_REPAIRS_REASON, MAX_ROUNDS_REASON } from '../src/core/workflow.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { board, detail } from '../src/server/api.ts';
import { liveness } from '../src/server/status.ts';
import { blockerOf, ciView, type Evidence, resumeOf } from '../src/server/status.ts';
import type { Artifact, Event, VerificationRun } from '../src/storage/schema.ts';
import { type RunningServer, startServer } from '../src/server/http.ts';
import type { ActionResponse, BoardRow, JobDetailView, SessionInfo } from '../src/server/types.ts';
import { getJob } from '../src/storage/jobs.ts';
import { seedDashboard, type SeededJobs } from './fixtures/dashboard.ts';
import { orchAsync, tempDir, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
let server: RunningServer;
let webRoot: string;
let ids: SeededJobs;
const dirs: string[] = [];

const api = (path: string, init: RequestInit = {}) =>
  fetch(new URL(path, server.url), {
    ...init,
    headers: { ...((init.headers as Record<string, string> | undefined) ?? {}) },
  });
const same = () => ({
  Origin: `http://127.0.0.1:${String(server.port)}`,
  'Content-Type': 'application/json',
});

beforeAll(async () => {
  store = tempStore();
  webRoot = tempDir('orch-web-');
  mkdirSync(join(webRoot, 'assets'));
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
  dirs.push(webRoot);
  server = await startServer({ store, port: 0, webRoot });
});
afterAll(async () => {
  await server.close();
  store.cleanup();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('empty database', () => {
  it('serves an empty board, no repos, and a 404 for unknown jobs', async () => {
    expect(await (await api('/api/jobs')).json()).toEqual([]);
    expect(await (await api('/api/repos')).json()).toEqual([]);
    const r = await api('/api/jobs/job-00000000');
    expect(r.status).toBe(404);
    expect(await api('/api/jobs/not-an-id').then((x) => x.status)).toBe(422);
    expect(await api('/api/nope').then((x) => x.status)).toBe(404);
    expect(await api('/api/jobs', { method: 'DELETE' }).then((x) => x.status)).toBe(405);
  });
});

describe('seeded board and detail', () => {
  beforeAll(() => {
    const repos = { alpha: tempDir('alpha-'), beta: tempDir('beta-'), gamma: tempDir('gamma-') };
    dirs.push(...Object.values(repos));
    ids = seedDashboard(store, repos);
  });

  it('lists every job across repositories with honest liveness and review state', async () => {
    const rows = (await (await api('/api/jobs')).json()) as BoardRow[];
    expect(rows).toHaveLength(10);
    const by = (id: string) => rows.find((r) => r.id === id) ?? ({} as BoardRow);
    expect(by(ids.reviewing).liveness).toBe('running');
    expect(by(ids.reviewing).blocker).toBeNull();
    // A live session is working on it: no command, and the holder is named.
    expect(by(ids.reviewing).resume).toEqual({
      command: null,
      heldBy: {
        session: 'claude-20261113-0900-ab12',
        leaseExpiresAt: expect.any(String) as string,
      },
    });
    expect(by(ids.reviewing).owner?.live).toBe(true);
    expect(by(ids.reviewing).reviews.map((v) => `${v.reviewer}:${v.verdict ?? 'pending'}`)).toEqual(
      ['security:pass', 'correctness:pending', 'code-quality:pending'],
    );
    expect(by(ids.reviewing).blocking).toBe(2); // from round 1 while round 2 is open
    expect(by(ids.stale).liveness).toBe('stale');
    expect(by(ids.stale).owner?.live).toBe(false);
    expect(by(ids.stale).blocker?.kind).toBe('interrupted');
    expect(by(ids.stale).resume).toEqual({ command: `/factory resume ${ids.stale}`, heldBy: null });
    expect(by(ids.blocked).liveness).toBe('blocked');
    // The approver's escalation is a decision gate; its recorded reason is shown verbatim.
    expect(by(ids.blocked).blocker).toEqual({
      kind: 'decision',
      summary: 'Approver escalated: a human must decide',
      detail: 'AC2 needs deployment verification; unrequested logging change',
    });
    // Escalated but its session never released it: the lease is live, so no resume command.
    expect(by(ids.blocked).resume?.command).toBeNull();
    expect(by(ids.blocked).resume?.heldBy?.session).toBe('claude-20261113-0800-1d2e');
    expect(by(ids.completed).liveness).toBe('completed');
    expect(by(ids.completed).blocker).toBeNull();
    expect(by(ids.completed).resume).toBeNull();
    expect(by(ids.completed).pr).toEqual({
      url: 'https://github.com/acme/alpha/pull/41',
      state: 'draft',
    });
    expect(by(ids.completed).ci.status).toBe('failing');
    // Cancelled is its own state, never "finished" like a success, and carries its reason.
    expect(by(ids.cancelled).status).toBe('cancelled');
    expect(by(ids.cancelled).liveness).toBe('cancelled');
    expect(by(ids.cancelled).blocker).toMatchObject({
      kind: 'cancelled',
      detail: 'decided against it',
    });
    expect(by(ids.cancelled).blocker?.summary).toContain('by claude-20261110-1200-0000');
    expect(by(ids.cancelled).resume).toBeNull();
    expect(by(ids.fresh).owner).toBeNull();
    expect(by(ids.fresh).liveness).toBe('idle');
    expect(by(ids.fresh).blocker).toEqual({
      kind: 'waiting',
      summary: 'No session owns this job',
      detail: null,
    });
    expect(by(ids.fresh).resume).toEqual({ command: `/factory resume ${ids.fresh}`, heldBy: null });
    expect(by(ids.failed).liveness).toBe('failed');
    expect(by(ids.failed).stage).toBe('build'); // stage and execution state stay distinct
    expect(by(ids.failed).blocker).toEqual({
      kind: 'failed',
      summary: 'Stage build failed',
      detail: 'required check "test" failed twice',
    });
    expect(by(ids.failed).resume).toEqual({
      command: `/factory resume ${ids.failed}`,
      heldBy: null,
    });
    expect(rows.every((r) => r.elapsedMs >= 0)).toBe(true);
    expect(await (await api('/api/repos')).json()).toEqual([
      'gamma',
      'github.com/acme/alpha',
      'github.com/acme/beta',
    ]);
    const beta = (await (
      await api('/api/jobs?repo=github.com%2Facme%2Fbeta')
    ).json()) as BoardRow[];
    expect(beta.map((r) => r.id).sort()).toEqual([ids.blocked, ids.stale].sort());
  });

  it('shows CI with the commit it was read for, the repair budget, and close-out only where allowed', async () => {
    const rows = (await (await api('/api/jobs')).json()) as BoardRow[];
    const by = (id: string) => rows.find((r) => r.id === id) ?? ({} as BoardRow);
    // Delivered on GitHub's verdict for f1e2d3c; the later failing observation is for the same head.
    expect(by(ids.completed).ci).toMatchObject({
      head: 'f1e2d3c4b5a69788',
      status: 'failing',
      current: null, // the board never inspects worktrees
      completion: 'ci',
      repairs: 0,
      maxRepairs: 2,
      outcome: null, // pr-status style observations carry no reconciliation outcome
    });
    expect(by(ids.ciPending).ci).toMatchObject({
      head: 'a1b2c3d4e5f60718',
      status: 'pending',
      outcome: 'pending',
      reason: 'waiting for: test',
      completion: null,
    });
    expect(by(ids.ciPending).blocker).toBeNull();
    expect(by(ids.ciNone).ci).toMatchObject({ status: 'none', outcome: 'none' });
    expect(by(ids.ciNone).blocker).toMatchObject({
      kind: 'ci',
      summary: 'GitHub reports no checks for the PR head',
    });
    expect(by(ids.ciNone).blocker?.detail).toContain('no required checks are configured');
    expect(by(ids.ciExhausted).ci).toMatchObject({
      head: 'd4e5f60718293041',
      status: 'failing',
      outcome: 'failing',
      repairs: 1,
      maxRepairs: 1,
    });
    expect(by(ids.ciExhausted).ci.failures).toEqual([
      {
        name: 'test',
        conclusion: 'failure',
        url: 'https://github.com/acme/alpha/actions/runs/9/job/901',
        log: 'ci/d4e5f60/test.log',
      },
    ]);
    expect(by(ids.ciExhausted).blocker).toEqual({
      kind: 'ci',
      summary: 'CI still failing after 1 of 1 repair cycles',
      detail: 'CI failed for d4e5f60: test',
    });
    // Both escalated jobs were released: a session may resume either.
    expect(by(ids.ciNone).resume?.command).toBe(`/factory resume ${ids.ciNone}`);
    // Close-out is listed by the same rule the transition applies: no checks yes, failing no.
    const none = (await (await api(`/api/jobs/${ids.ciNone}`)).json()) as JobDetailView;
    expect(none.actions).toEqual([
      'approve',
      'request-review',
      'request-rework',
      'accept-delivery',
      'cancel',
    ]);
    expect(none.ci.current).toBe(null); // no worktree on disk for the fixture
    const exhausted = (await (await api(`/api/jobs/${ids.ciExhausted}`)).json()) as JobDetailView;
    expect(exhausted.actions).toEqual(['approve', 'request-review', 'request-rework', 'cancel']);
    const pending = (await (await api(`/api/jobs/${ids.ciPending}`)).json()) as JobDetailView;
    expect(pending.actions).not.toContain('accept-delivery');
  });

  it('reading the board or a detail never mutates a job', async () => {
    const snapshot = () => JSON.stringify(board(store).map((r) => [r.id, r.status, r.updatedAt]));
    const before = snapshot();
    await api('/api/jobs');
    await api(`/api/jobs/${ids.stale}`);
    expect(snapshot()).toBe(before);
  });

  it('never exposes owner tokens anywhere', async () => {
    for (const path of ['/api/jobs', `/api/jobs/${ids.reviewing}`, `/api/jobs/${ids.completed}`]) {
      const text = await (await api(path)).text();
      expect(text).not.toContain('ownerToken');
      expect(text).not.toMatch(/"[0-9a-f]{32}"/);
    }
    const real = getJob(store.db, ids.reviewing).ownerToken ?? '';
    expect(real).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(detail(store, ids.reviewing))).not.toContain(real);
    expect(JSON.stringify(board(store))).not.toContain(real);
  });

  it('detail carries artifacts with content, rounds, events, plan, and links', async () => {
    const d = (await (await api(`/api/jobs/${ids.completed}`)).json()) as JobDetailView;
    expect(d.job.id).toBe(ids.completed);
    expect(d.rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(d.rounds[0]?.blocking).toBe(2);
    expect(d.rounds[1]?.blocking).toBe(0);
    expect(d.rounds[0]?.reviews.map((r) => r.verdict)).toEqual(['changes', 'changes', 'pass']);
    expect(d.contents['spec.md']).toContain('## Acceptance criteria');
    expect(d.contents['round-1/consolidated.md']).toContain('finding 24 of round 1');
    expect(d.contents['decision.md']).toContain('DECISION: APPROVE');
    expect(d.events.map((e) => e.type)).toContain('job.completed');
    expect(d.plan?.step).toBe('done');
    expect(d.links.pr).toBe('https://github.com/acme/alpha/pull/41');
    expect(d.links.vscode).toBeNull(); // no worktree recorded for the fixture
    expect(d.links.checkout).toMatch(/^vscode:\/\/file\/.*alpha/);
    expect(d.resumeCommand).toContain(ids.completed);
    expect(d.liveness).toBe('completed');
    expect(d.actions).toEqual([]);
    expect(d.resume).toBeNull();
    const blocked = (await (await api(`/api/jobs/${ids.blocked}`)).json()) as JobDetailView;
    expect(blocked.plan?.step).toBe('needs-human');
    expect(blocked.plan?.blockedReason).toContain('deployment');
    expect(blocked.blocker?.kind).toBe('decision');
    expect(blocked.actions).toEqual(['approve', 'request-review', 'request-rework', 'cancel']);
    expect(blocked.resume?.command).toBeNull();
    expect(blocked.resume?.heldBy?.session).toBe('claude-20261113-0800-1d2e');
    const failed = (await (await api(`/api/jobs/${ids.failed}`)).json()) as JobDetailView;
    expect(failed.actions).toEqual(['request-rework', 'cancel']); // no approve: not a gate
    const cancelled = (await (await api(`/api/jobs/${ids.cancelled}`)).json()) as JobDetailView;
    expect(cancelled.actions).toEqual([]);
    expect(cancelled.resume).toBeNull();
  });

  it('serves only registered artifacts and rejects traversal', async () => {
    const ok = await api(`/api/jobs/${ids.completed}/artifacts/round-1/review-security.md`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/markdown');
    expect(await ok.text()).toContain('VERDICT: CHANGES');
    expect((await api(`/api/jobs/${ids.completed}/artifacts/notes.md`)).status).toBe(422);
    expect((await api(`/api/jobs/${ids.completed}/artifacts/..%2F..%2Fpackage.json`)).status).toBe(
      400,
    );
    // The URL parser normalizes `..` segments; the result is still limited to registered files.
    expect((await api(`/api/jobs/${ids.completed}/artifacts/round-1/../spec.md`)).status).toBe(200);
    expect((await api(`/api/jobs/${ids.completed}/artifacts/round-1/..%2F..%2Fx.md`)).status).toBe(
      400,
    );
    expect((await api(`/api/jobs/${ids.fresh}/artifacts/spec.md`)).status).toBe(422);
  });

  it('serves the built app from web/dist only, with security headers', async () => {
    const index = await api('/');
    expect(index.status).toBe(200);
    expect(index.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(index.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await index.text()).toContain('shell');
    expect((await api('/assets/app.js')).headers.get('content-type')).toContain('javascript');
    expect((await api('/#/jobs/x')).status).toBe(200);
    expect((await api('/jobs/some/route')).status).toBe(200); // SPA fallback
    expect((await api('/missing.js')).status).toBe(404);
    expect((await api('/..%2Fpackage.json')).status).toBe(404);
    expect((await api('/assets/..%2F..%2Fpackage.json')).status).toBe(404);
    // Malformed percent-encoding is a client error, not an internal one.
    expect((await api('/%E0%A4%A')).status).toBe(400);
    expect((await api(`/api/jobs/${ids.completed}/artifacts/%zz.md`)).status).toBe(400);
    expect((await api('/', { method: 'POST' })).status).toBe(405);
  });
});

describe('mutations', () => {
  const post = (id: string, body: unknown, headers: Record<string, string> = same()) =>
    api(`/api/jobs/${id}/actions`, { method: 'POST', headers, body: JSON.stringify(body) });
  let csrf: string;

  beforeAll(async () => {
    const s = (await (await api('/api/session', { headers: same() })).json()) as SessionInfo;
    csrf = s.csrf;
    expect(csrf).toMatch(/^[0-9a-f]{48}$/);
  });

  it('requires a same-origin Origin, JSON content type, and the CSRF token', async () => {
    const body = { action: 'cancel' };
    expect((await post(ids.fresh, body, { 'Content-Type': 'application/json' })).status).toBe(403);
    expect(
      (
        await post(ids.fresh, body, {
          Origin: 'http://evil.example',
          'Content-Type': 'application/json',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await post(ids.fresh, body, {
          ...same(),
          'Content-Type': 'text/plain',
          'X-Orch-Csrf': csrf,
        })
      ).status,
    ).toBe(415);
    expect((await post(ids.fresh, body, { ...same(), 'X-Orch-Csrf': 'nope' })).status).toBe(403);
    expect((await api('/api/session', { headers: { Origin: 'http://evil.example' } })).status).toBe(
      403,
    );
    // fetch() refuses to override Host, so use a raw request for the DNS-rebinding guard.
    const { request } = await import('node:http');
    const hostStatus = await new Promise<number>((resolve) => {
      request(
        {
          host: '127.0.0.1',
          port: server.port,
          path: '/api/jobs',
          headers: { Host: 'evil.example' },
        },
        (res) => {
          resolve(res.statusCode ?? 0);
          res.resume();
        },
      ).end();
    });
    expect(hostStatus).toBe(400);
    expect((await api('/api/jobs', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(
      403,
    );
    expect(getJob(store.db, ids.fresh).status).toBe('pending');
  });

  it('validates the body and refuses unknown or impossible actions', async () => {
    const h = { ...same(), 'X-Orch-Csrf': csrf };
    const bad = async (body: unknown) => (await post(ids.fresh, body, h)).status;
    expect(await bad({ action: 'merge' })).toBe(422);
    expect(await bad({ action: 'cancel', extra: 1 })).toBe(422);
    expect(await bad({ action: 'cancel', reason: 'x'.repeat(501) })).toBe(422);
    expect(await bad({ action: 'cancel', force: 'yes' })).toBe(422);
    expect(await bad({ action: 'approve', to: 'nowhere' })).toBe(422);
    expect(await bad([1])).toBe(422);
    const raw = await api(`/api/jobs/${ids.fresh}/actions`, {
      method: 'POST',
      headers: h,
      body: '{',
    });
    expect(raw.status).toBe(400);
    const big = await api(`/api/jobs/${ids.fresh}/actions`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ action: 'cancel', reason: 'x'.repeat(70_000) }),
    });
    expect(big.status).toBe(413);
    // Approve only applies to a human-blocked job; review needs a build to exist.
    expect(await bad({ action: 'approve' })).toBe(422);
    expect(await bad({ action: 'request-review' })).toBe(422);
    expect((await post(ids.cancelled, { action: 'cancel' }, h)).status).toBe(422);
    expect((await post(ids.completed, { action: 'request-rework' }, h)).status).toBe(422);
  });

  it('refuses to act on a job whose session holds a live lease unless forced', async () => {
    const h = { ...same(), 'X-Orch-Csrf': csrf };
    const refused = await post(ids.reviewing, { action: 'request-rework' }, h);
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
      'live lease',
    );
    expect(getJob(store.db, ids.reviewing).stage).toBe('review');
    const forced = await post(
      ids.reviewing,
      { action: 'request-rework', force: true, reason: 'stuck' },
      h,
    );
    expect(forced.status).toBe(200);
    const r = (await forced.json()) as ActionResponse;
    expect(r.job.stage).toBe('build');
    expect(r.job.status).toBe('pending');
    expect(r.job.ownerSession).toBeNull(); // released: a session must resume
    expect(r.message).toContain('No session is running it');
    expect(r.resumeCommand).toBe(`orch factory resume ${ids.reviewing} --session <name>`);
    expect(JSON.stringify(r)).not.toContain('ownerToken');
  });

  it('approves a human-blocked job back to its stage, requests review, and cancels', async () => {
    const h = { ...same(), 'X-Orch-Csrf': csrf };
    const approved = (await (
      await post(ids.blocked, { action: 'approve', reason: 'checked' }, h)
    ).json()) as ActionResponse;
    expect([approved.job.stage, approved.job.status]).toEqual(['approve', 'pending']);
    // Released and pending: the board now says a session must resume it.
    const row = board(store).find((r) => r.id === ids.blocked);
    expect(row?.liveness).toBe('idle');
    expect(row?.blocker?.kind).toBe('waiting');
    expect(row?.resume).toEqual({ command: `/factory resume ${ids.blocked}`, heldBy: null });
    // Stale job (lapsed lease): no force needed; request another review round.
    const stale = (await (
      await post(ids.stale, { action: 'request-rework' }, h)
    ).json()) as ActionResponse;
    expect(stale.job.stage).toBe('build');
    const review = await post(ids.stale, { action: 'request-review' }, h);
    expect(review.status).toBe(422); // round 0: nothing built yet
    const cancelled = (await (
      await post(ids.fresh, { action: 'cancel', reason: 'nope' }, h)
    ).json()) as ActionResponse;
    expect(cancelled.job.status).toBe('cancelled');
    expect(cancelled.resumeCommand).toBeUndefined();
    const events = detail(store, ids.fresh).events.map((e) => `${e.type}:${e.actor ?? ''}`);
    expect(events).toContain('job.cancelled:dashboard');
    expect(events.at(-1)).toBe('job.released:dashboard');
  });

  it('accept-delivery closes out a no-checks escalation with a reason, never a failing one', async () => {
    const h = { ...same(), 'X-Orch-Csrf': csrf };
    // Repairs exhausted on a failing check: refused by the rule, nothing changes.
    const refused = await post(
      ids.ciExhausted,
      { action: 'accept-delivery', reason: 'ship it' },
      h,
    );
    expect(refused.status).toBe(422);
    // The budget-spent escalation returns to build, so it is not a ci close-out candidate at all.
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(
      /only a job escalated from the ci stage/,
    );
    expect(getJob(store.db, ids.ciExhausted)).toMatchObject({
      stage: 'needs-human',
      status: 'blocked',
    });
    // No checks at all: allowed, but only with a recorded reason.
    const noReason = await post(ids.ciNone, { action: 'accept-delivery' }, h);
    expect(noReason.status).toBe(422);
    expect(((await noReason.json()) as { error: { message: string } }).error.message).toMatch(
      /needs a reason/,
    );
    expect(getJob(store.db, ids.ciNone).stage).toBe('needs-human');
    const done = (await (
      await post(ids.ciNone, { action: 'accept-delivery', reason: 'no CI in this repo' }, h)
    ).json()) as ActionResponse;
    expect([done.job.stage, done.job.status]).toEqual(['completed', 'completed']);
    expect(done.message).toContain('Delivery accepted by a human (dashboard: no CI in this repo)');
    expect(done.message).toContain('CI was none for b2c3d4e');
    expect(done.message).toContain('Nothing was merged or marked ready');
    expect(done.resumeCommand).toBeUndefined();
    const d = detail(store, ids.ciNone);
    expect(d.ci.completion).toBe('human');
    expect(d.actions).toEqual([]);
    expect(d.plan?.reason).toContain('manual close-out, not a CI verdict');
    const completed = d.events.find((e) => e.type === 'job.completed');
    expect(completed?.payload).toMatchObject({
      acceptedByHuman: true,
      ciStatus: 'none',
      head: 'b2c3d4e5f6071829',
      reason: 'dashboard: no CI in this repo',
    });
    expect(completed?.actor).toBe('dashboard');
    expect(board(store).find((r) => r.id === ids.ciNone)?.ci.completion).toBe('human');
    // Accepting twice, or on a job that was never escalated from ci, is refused.
    expect((await post(ids.ciNone, { action: 'accept-delivery', reason: 'again' }, h)).status).toBe(
      422,
    );
    expect((await post(ids.blocked, { action: 'accept-delivery', reason: 'x' }, h)).status).toBe(
      422,
    );
  });

  it('dashboardAction enforces the same rules in-process', () => {
    expect(() => dashboardAction(store, ids.cancelled, { action: 'cancel' })).toThrow(
      /already cancelled/,
    );
    expect(() => dashboardAction(store, ids.completed, { action: 'approve' })).toThrow(
      /already completed/,
    );
  });
});

describe('liveness', () => {
  it('maps status and lease to an honest label', () => {
    const past = '2000-01-01T00:00:00.000Z';
    const future = '2999-01-01T00:00:00.000Z';
    const j = (status: string, stage = 'build', leaseExpiresAt: string | null = future) =>
      ({ status, stage, leaseExpiresAt, ownerSession: 's' }) as Parameters<typeof liveness>[0];
    expect(liveness(j('running'))).toBe('running');
    expect(liveness(j('running', 'build', past))).toBe('stale');
    expect(liveness(j('running', 'build', null))).toBe('stale');
    expect(liveness(j('pending'))).toBe('idle');
    expect(liveness(j('blocked', 'needs-human'))).toBe('blocked');
    expect(liveness(j('failed'))).toBe('failed');
    expect(liveness(j('interrupted'))).toBe('interrupted');
    expect(liveness(j('completed', 'completed'))).toBe('completed');
    expect(liveness(j('cancelled'))).toBe('cancelled');
  });
});

describe('blocker and resume derivation', () => {
  const future = '2999-01-01T00:00:00.000Z';
  const past = '2000-01-01T00:00:00.000Z';
  const job = (over: Partial<Parameters<typeof blockerOf>[0]> = {}) => ({
    status: 'blocked' as const,
    stage: 'needs-human' as const,
    round: 2,
    leaseExpiresAt: null,
    ownerSession: null,
    ciRepairs: 0,
    maxCiRepairs: 2,
    ...over,
  });
  const event = (type: string, payload: Record<string, unknown>, actor = 's'): Event => ({
    id: 1,
    jobId: 'job-00000001',
    type,
    payload,
    actor,
    createdAt: past,
  });
  const artifact = (path: string, marker: string | null): Artifact => ({
    id: 1,
    jobId: 'job-00000001',
    stage: 'review',
    round: null,
    path,
    bytes: 1,
    sha256: null,
    marker,
    head: null,
    createdAt: past,
  });
  const evidence = (over: Partial<Evidence> = {}): Evidence => ({
    events: new Map(),
    artifacts: [],
    latestRun: null,
    ...over,
  });
  const failedRun = { status: 'failed', head: 'abcdef0123456789' } as VerificationRun;

  it('does not invent a reason when none is recorded', () => {
    expect(blockerOf(job(), 'blocked', evidence())).toEqual({
      kind: 'escalated',
      summary: 'Escalated',
      detail: null,
    });
    const blank = new Map([['job.blocked', event('job.blocked', { from: 'build', reason: '  ' })]]);
    expect(blockerOf(job(), 'blocked', evidence({ events: blank }))).toEqual({
      kind: 'escalated',
      summary: 'Escalated from build',
      detail: null,
    });
    expect(blockerOf(job({ status: 'failed', stage: 'build' }), 'failed', evidence())).toEqual({
      kind: 'failed',
      summary: 'Stage build failed',
      detail: null,
    });
  });

  it('classifies from structured fields only: max rounds, decision marker, failed run', () => {
    const maxRounds = new Map([
      ['job.blocked', event('job.blocked', { from: 'review', reason: MAX_ROUNDS_REASON })],
    ]);
    expect(
      blockerOf(
        job(),
        'blocked',
        evidence({ events: maxRounds, artifacts: [artifact('round-2/consolidated.md', '3')] }),
      ),
    ).toMatchObject({ kind: 'findings', detail: null });
    expect(
      blockerOf(
        job(),
        'blocked',
        evidence({ events: maxRounds, artifacts: [artifact('round-2/consolidated.md', '3')] }),
      )?.summary,
    ).toContain('3 blocking');
    expect(blockerOf(job(), 'blocked', evidence({ events: maxRounds }))?.summary).toContain(
      'still request changes',
    );
    // The same `from: review` without the code-generated reason is just an escalation.
    const other = new Map([['job.blocked', event('job.blocked', { from: 'review', reason: 'x' })]]);
    expect(blockerOf(job(), 'blocked', evidence({ events: other }))?.kind).toBe('escalated');

    const fromApprove = new Map([
      ['job.blocked', event('job.blocked', { from: 'approve', reason: 'needs a product call' })],
    ]);
    expect(
      blockerOf(
        job(),
        'blocked',
        evidence({ events: fromApprove, artifacts: [artifact('decision.md', 'escalate')] }),
      ),
    ).toEqual({
      kind: 'decision',
      summary: 'Approver escalated: a human must decide',
      detail: 'needs a product call',
    });
    // From approve but decision.md says APPROVE (or is absent): not a decision gate.
    expect(
      blockerOf(
        job(),
        'blocked',
        evidence({ events: fromApprove, artifacts: [artifact('decision.md', 'approve')] }),
      )?.kind,
    ).toBe('escalated');

    expect(blockerOf(job(), 'blocked', evidence({ latestRun: failedRun }))).toEqual({
      kind: 'verification',
      summary: 'Verification failed at abcdef0',
      detail: null,
    });
    const failedJob = job({ status: 'failed', stage: 'build' });
    expect(blockerOf(failedJob, 'failed', evidence({ latestRun: failedRun }))?.kind).toBe(
      'verification',
    );
  });

  it('classifies ci escalations from the reason code and the last observation', () => {
    const blocked = (payload: Record<string, unknown>) =>
      event('job.blocked', { from: 'ci', ...payload });
    const observed = (outcome: string) => event('ci.observed', { head: 'h', outcome });
    const ev = (b: Event, o?: Event) =>
      evidence({
        events: new Map([['job.blocked', b], ...(o ? [['ci.observed', o] as const] : [])]),
      });
    const budget = job({ ciRepairs: 2, maxCiRepairs: 2 });
    expect(
      blockerOf(
        budget,
        'blocked',
        ev(blocked({ reason: MAX_CI_REPAIRS_REASON, detail: 'CI failed: test' })),
      ),
    ).toEqual({
      kind: 'ci',
      summary: 'CI still failing after 2 of 2 repair cycles',
      detail: 'CI failed: test',
    });
    for (const [outcome, summary] of [
      ['closed', 'PR was closed without merging'],
      ['outdated', 'PR head moved outside the job'],
      ['none', 'GitHub reports no checks for the PR head'],
      ['infrastructure', 'Required checks did not reach a verdict'],
    ] as const) {
      expect(
        blockerOf(job(), 'blocked', ev(blocked({ reason: 'why' }), observed(outcome))),
      ).toEqual({
        kind: 'ci',
        summary,
        detail: 'why',
      });
    }
    // An unknown outcome, or no reconciliation at all, is labelled as exactly that.
    expect(blockerOf(job(), 'blocked', ev(blocked({ reason: 'why' })))).toEqual({
      kind: 'ci',
      summary: 'Escalated from ci',
      detail: 'why',
    });
  });

  it('ciView binds the verdict to its commit and names how a job completed', () => {
    const row = {
      id: 'job-00000001',
      stage: 'ci' as const,
      prUrl: 'https://github.com/x/y/pull/1',
      prState: 'draft' as const,
      ciHead: 'aaaa111',
      ciStatus: 'passing' as const,
      ciCheckedAt: past,
      ciRepairs: 1,
      maxCiRepairs: 2,
    };
    const obs = (head: string, extra: Record<string, unknown> = {}) =>
      new Map([
        ['ci.observed', event('ci.observed', { head, outcome: 'passing', reason: 'ok', ...extra })],
      ]);
    // Current when the worktree HEAD is the observed commit; stale when HEAD moved; unknown on the board.
    expect(ciView(row, obs('aaaa111'), 'aaaa111')).toMatchObject({
      current: true,
      outcome: 'passing',
      reason: 'ok',
    });
    expect(ciView(row, obs('aaaa111'), 'bbbb222').current).toBe(false);
    expect(ciView(row, obs('aaaa111'), undefined).current).toBeNull();
    expect(ciView(row, obs('aaaa111'), null).current).toBeNull(); // unreadable HEAD: unknown
    // An observation of another commit says nothing about this head.
    expect(ciView(row, obs('old0000'), 'aaaa111')).toMatchObject({
      outcome: null,
      reason: null,
      failures: [],
    });
    expect(ciView({ ...row, ciHead: null, ciStatus: null }, new Map(), 'aaaa111')).toMatchObject({
      head: null,
      current: false,
      status: null,
      completion: null,
    });
    const done = (payload: Record<string, unknown>) =>
      new Map([['job.completed', event('job.completed', payload)]]);
    const finished = { ...row, stage: 'completed' as const };
    expect(ciView(finished, done({ head: 'aaaa111' }), undefined).completion).toBe('ci');
    expect(
      ciView(finished, done({ head: 'aaaa111', acceptedByHuman: true }), undefined).completion,
    ).toBe('human');
    // A job completed before the ci stage existed recorded no head with its completion.
    expect(ciView(finished, done({ prUrl: 'u' }), undefined).completion).toBe('legacy');
    expect(ciView(finished, new Map(), undefined).completion).toBe('legacy');
  });

  it('explains interruptions, waiting, and cancellation; nothing for running or completed', () => {
    const running = { status: 'running', stage: 'build', ownerSession: 'c1' } as const;
    const stale = blockerOf(job({ ...running, leaseExpiresAt: past }), 'stale', evidence());
    expect(stale?.kind).toBe('interrupted');
    expect(stale?.summary).toContain('c1');
    const interrupted = evidence({
      events: new Map([['job.interrupted', event('job.interrupted', { previousSession: 'c0' })]]),
    });
    expect(
      blockerOf(job({ status: 'interrupted', stage: 'build' }), 'interrupted', interrupted)
        ?.summary,
    ).toContain('under session c0');
    const pending = { status: 'pending', stage: 'build' } as const;
    expect(blockerOf(job(pending), 'idle', evidence())?.kind).toBe('waiting');
    const owned = job({ ...pending, ownerSession: 'c1', leaseExpiresAt: future });
    expect(blockerOf(owned, 'idle', evidence())).toBeNull();
    const lapsed = job({ ...pending, ownerSession: 'c1', leaseExpiresAt: past });
    expect(blockerOf(lapsed, 'idle', evidence())?.summary).toContain('lapsed');
    const cancelled = evidence({
      events: new Map([
        [
          'job.cancelled',
          event('job.cancelled', { stage: 'pr', reason: 'superseded' }, 'dashboard'),
        ],
      ]),
    });
    expect(blockerOf(job({ status: 'cancelled', stage: 'pr' }), 'cancelled', cancelled)).toEqual({
      kind: 'cancelled',
      summary: 'Cancelled during pr by dashboard',
      detail: 'superseded',
    });
    expect(blockerOf(job(running), 'running', evidence())).toBeNull();
    expect(
      blockerOf(job({ status: 'completed', stage: 'completed' }), 'completed', evidence()),
    ).toBeNull();
  });

  it('offers the resume command only when no live lease is held, and names the holder', () => {
    const id = 'job-00000001';
    const j = (over: Partial<Parameters<typeof resumeOf>[0]>) => ({
      id,
      status: 'pending' as const,
      stage: 'build' as const,
      leaseExpiresAt: null,
      ownerSession: null,
      ...over,
    });
    const open = { command: `/factory resume ${id}`, heldBy: null };
    const held = { command: null, heldBy: { session: 'c1', leaseExpiresAt: future } };
    expect(resumeOf(j({}), 'idle')).toEqual(open);
    // Active ownership withholds the command; a lapsed lease is the normal resume case.
    expect(resumeOf(j({ ownerSession: 'c1', leaseExpiresAt: future }), 'idle')).toEqual(held);
    expect(resumeOf(j({ ownerSession: 'c1', leaseExpiresAt: past }), 'idle')).toEqual(open);
    const live = { ownerSession: 'c1', leaseExpiresAt: future } as const;
    expect(resumeOf(j({ status: 'running', ...live }), 'running')).toEqual(held);
    expect(
      resumeOf(j({ status: 'running', ownerSession: 'c1', leaseExpiresAt: past }), 'stale'),
    ).toEqual(open);
    for (const s of ['interrupted', 'failed', 'blocked'] as const) {
      expect(resumeOf(j({ status: s }), s)).toEqual(open);
      expect(resumeOf(j({ status: s, ...live }), s)).toEqual(held);
    }
    // Even the dashboard's own one-minute lease is reported, never silently taken over.
    expect(resumeOf(j({ ownerSession: 'dashboard', leaseExpiresAt: future }), 'idle')).toEqual({
      command: null,
      heldBy: { session: 'dashboard', leaseExpiresAt: future },
    });
    expect(resumeOf(j({ status: 'completed' }), 'completed')).toBeNull();
    expect(resumeOf(j({ status: 'cancelled' }), 'cancelled')).toBeNull();
  });
});

describe('orch ui command', () => {
  it('starts on a free port, answers on loopback, and stops when its stdin closes', async () => {
    const home = tempDir('orch-ui-cli-');
    dirs.push(home);
    const { spawn } = await import('node:child_process');
    const { installRoot } = await import('../src/core/paths.ts');
    const child = spawn(
      process.execPath,
      [join(installRoot(), 'src', 'cli', 'main.ts'), 'ui', '--port', '0'],
      { env: { ...process.env, ORCH_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d: Buffer) => {
        out += d.toString();
        const m = /orch dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
        if (m?.[1]) resolve(m[1]);
      });
      child.once('exit', (code) => {
        reject(new Error(`exited ${String(code)}`));
      });
    });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const r = await fetch(new URL('/api/jobs', url));
    expect(await r.json()).toEqual([]);
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(0);
    await expect(fetch(new URL('/api/jobs', url))).rejects.toThrow();
    // Factory commands keep working with no dashboard running.
    const list = await orchAsync(home, home, ['--json', 'job', 'list']);
    expect(list.code).toBe(0);
    expect((await orchAsync(home, home, ['ui', '--port', 'abc'])).code).toBe(2);
  });
});
