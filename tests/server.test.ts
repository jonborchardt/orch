/** Dashboard API: read models, security guards, actions through the domain layer. */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { dashboardAction } from '../src/ops/actions.ts';
import { board, detail, liveness } from '../src/server/api.ts';
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
    expect(rows).toHaveLength(6);
    const by = (id: string) => rows.find((r) => r.id === id) ?? ({} as BoardRow);
    expect(by(ids.reviewing).liveness).toBe('running');
    expect(by(ids.reviewing).owner?.live).toBe(true);
    expect(by(ids.reviewing).reviews.map((v) => `${v.reviewer}:${v.verdict ?? 'pending'}`)).toEqual(
      ['security:pass', 'correctness:pending', 'code-quality:pending'],
    );
    expect(by(ids.reviewing).blocking).toBe(2); // from round 1 while round 2 is open
    expect(by(ids.stale).liveness).toBe('stale');
    expect(by(ids.stale).owner?.live).toBe(false);
    expect(by(ids.blocked).liveness).toBe('blocked');
    expect(by(ids.completed).liveness).toBe('finished');
    expect(by(ids.completed).pr).toMatchObject({
      url: 'https://github.com/acme/alpha/pull/41',
      state: 'draft',
      ciStatus: 'failing',
    });
    expect(by(ids.cancelled).status).toBe('cancelled');
    expect(by(ids.fresh).owner).toBeNull();
    expect(by(ids.fresh).liveness).toBe('idle');
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
    expect(d.resumeCommand).toContain(ids.completed);
    expect(d.liveness).toBe('finished');
    const blocked = (await (await api(`/api/jobs/${ids.blocked}`)).json()) as JobDetailView;
    expect(blocked.plan?.step).toBe('needs-human');
    expect(blocked.plan?.blockedReason).toContain('deployment');
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
    expect(s.actions).toEqual([
      'approve',
      'request-review',
      'request-rework',
      'accept-policy',
      'cancel',
    ]);
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
    expect(liveness(j('completed', 'completed'))).toBe('finished');
    expect(liveness(j('cancelled'))).toBe('finished');
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
