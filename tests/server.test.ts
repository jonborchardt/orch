/** Dashboard API: read models, security guards, actions through the domain layer. */
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { installRoot, jobArtifactDir } from '../src/core/paths.ts';
import {
  MAX_CI_REPAIRS_REASON,
  MAX_ROUNDS_REASON,
  SCOPE_GAP_REASON,
} from '../src/core/workflow.ts';
import { dashboardAction } from '../src/ops/actions.ts';
import { board, detail, isLogPath } from '../src/server/api.ts';
import { liveness, TIMELINE_EVENTS } from '../src/server/status.ts';
import { blockerOf, ciView, type Evidence, resumeOf } from '../src/server/status.ts';
import type { Artifact, Event, VerificationRun } from '../src/storage/schema.ts';
import { type RunningServer, startServer } from '../src/server/http.ts';
import type {
  ActionResponse,
  BoardRow,
  JobDetailView,
  SessionInfo,
  SessionLogView,
  UsageView,
} from '../src/server/types.ts';
import { upsertArtifact } from '../src/storage/artifacts.ts';
import { listEvents } from '../src/storage/events.ts';
import {
  attachSession,
  claimJob,
  createJob,
  getJob,
  recordEvent,
  setWorktree,
  transitionJob,
} from '../src/storage/jobs.ts';
import { jobs } from '../src/storage/schema.ts';
import { finishRun, recordCheck, startRun } from '../src/storage/verification.ts';
import { seedDashboard, type SeededJobs } from './fixtures/dashboard.ts';
import { orchAsync, tempDir, type TempStore, tempStore } from './helpers.ts';
import { mainTranscript, U, user, writeAgent, writeSession } from './transcript-fixture.ts';

let store: TempStore;
let server: RunningServer;
let webRoot: string;
let ids: SeededJobs;
const dirs: string[] = [];

// One connection per request. The server shares this process's event loop, and seeding blocks it
// for seconds; fetch's keep-alive clock counts timer ticks, not wall time, so it can reuse a
// pooled socket the server's (wall-clock) keep-alive timeout has just closed: ECONNRESET.
const api = (path: string, init: RequestInit = {}) =>
  fetch(new URL(path, server.url), {
    ...init,
    headers: {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
      Connection: 'close',
    },
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
    // Every row carries its mode; jobs created without one are full jobs.
    expect(rows.map((r) => r.mode)).toEqual(rows.map(() => 'full'));
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
    // Current round only: round 1's blocking count is history while round 2 is unconsolidated.
    expect(by(ids.reviewing).blocking).toBeNull();
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
      // Completed on GitHub's verdict while the PR stayed a draft.
      phase: 'ready-mark-failed',
      refreshable: true,
    });
    expect(by(ids.completed).ci.status).toBe('failing');
    // A ci completion whose CI was later observed failing claims nothing beyond completed.
    expect(by(ids.completed).outcome).toEqual({ kind: 'completed', label: 'completed' });
    expect(by(ids.blocked).outcome).toBeNull();
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
    expect(rows.every((r) => (r.elapsedMs ?? -1) >= 0)).toBe(true);
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
      'refresh-pr',
      'approve',
      'answer',
      'request-review',
      'request-rework',
      'accept-delivery',
      'cancel',
    ]);
    expect(none.ci.current).toBe(null); // no worktree on disk for the fixture
    const exhausted = (await (await api(`/api/jobs/${ids.ciExhausted}`)).json()) as JobDetailView;
    expect(exhausted.actions).toEqual([
      'refresh-pr',
      'approve',
      'answer',
      'request-review',
      'request-rework',
      'cancel',
    ]);
    const pending = (await (await api(`/api/jobs/${ids.ciPending}`)).json()) as JobDetailView;
    expect(pending.actions).not.toContain('accept-delivery');
  });

  it('carries workflow progress on board rows and the detail, and a timeline on the detail', async () => {
    const rows = (await (await api('/api/jobs')).json()) as BoardRow[];
    const by = (id: string) => rows.find((r) => r.id === id) ?? ({} as BoardRow);
    const states = (p: BoardRow['progress']) => p.steps.map((s) => s.state);
    // Escalated after the repair budget was spent: stopped at CI, though it would return to build.
    expect(by(ids.ciExhausted).progress.label).toBe('CI, needs human');
    expect(states(by(ids.ciExhausted).progress)).toEqual([
      ...Array<string>(6).fill('done'),
      'stopped',
      'not-started',
    ]);
    expect(by(ids.blocked).progress.label).toBe('Approve, needs human');
    expect(by(ids.completed).progress.label).toBe('Done');
    expect(states(by(ids.completed).progress).every((s) => s === 'done')).toBe(true);
    expect(by(ids.failed).progress.label).toBe('Build, failed');
    expect(by(ids.reviewing).progress.label).toBe('Review');
    for (const r of rows) {
      expect(r.progress.steps.map((s) => s.id)).toEqual([
        'spec',
        'build',
        'simplify',
        'review',
        'approve',
        'pr',
        'ci',
        'done',
      ]);
    }
    const d = (await (await api(`/api/jobs/${ids.ciExhausted}`)).json()) as JobDetailView;
    // The detail's step states equal the board's.
    expect(d.progress).toEqual(by(ids.ciExhausted).progress);
    expect(d.timeline.truncated).toBe(false);
    const labels = d.timeline.entries.map((e) => e.label);
    const rework = labels.indexOf('Rework from CI: back to Build');
    expect(rework).toBeGreaterThan(labels.indexOf('CI started'));
    expect(labels.indexOf('Build started', rework)).toBeGreaterThan(rework);
    expect(labels.at(-1)).toBe('CI: needs human');
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
    // A recorded PR proves the branch is on GitHub.
    expect(d.links.branch).toBe(
      `https://github.com/acme/alpha/tree/factory/${ids.completed}-export-reports-as-csv`,
    );
    expect(d.resumeCommand).toContain(ids.completed);
    expect(d.liveness).toBe('completed');
    expect(d.outcome).toEqual({ kind: 'completed', label: 'completed' });
    // A finished job can only be archived and have its PR re-read; merge needs a passing verdict.
    expect(d.actions).toEqual(['refresh-pr', 'archive']);
    expect(d.resume).toBeNull();
    const blocked = (await (await api(`/api/jobs/${ids.blocked}`)).json()) as JobDetailView;
    expect(blocked.plan?.step).toBe('needs-human');
    expect(blocked.plan?.blockedReason).toContain('deployment');
    expect(blocked.blocker?.kind).toBe('decision');
    expect(blocked.actions).toEqual([
      'approve',
      'answer',
      'request-review',
      'request-rework',
      'cancel',
    ]);
    // An escalation that recorded no choices offers the default ones (ticket 0132).
    expect(blocked.choices?.[0]).toMatchObject({
      kind: 'resume',
      to: 'approve',
      label: 'Retry approve',
      available: true,
    });
    expect(blocked.afterAction).toBe(
      `no session is running it; resume it from a Claude Code session with: orch factory resume ${ids.blocked} --session <name>`,
    );
    expect(blocked.resume?.command).toBeNull();
    expect(blocked.resume?.heldBy?.session).toBe('claude-20261113-0800-1d2e');
    const failed = (await (await api(`/api/jobs/${ids.failed}`)).json()) as JobDetailView;
    expect(failed.actions).toEqual(['request-rework', 'cancel']); // no approve: not a gate
    const cancelled = (await (await api(`/api/jobs/${ids.cancelled}`)).json()) as JobDetailView;
    expect(cancelled.actions).toEqual(['archive']);
    expect(cancelled.resume).toBeNull();
  });

  it('links the branch only once it is known to be pushed, without asking GitHub', () => {
    const own = tempStore();
    const repoPath = tempDir('links-');
    dirs.push(repoPath);
    try {
      const mk = (title: string, branch: string | null, repo = 'github.com/acme/alpha') => {
        const job = createJob(own, {
          title,
          description: title,
          repo,
          repoPath,
          baseBranch: 'main',
        });
        const { token } = claimJob(own, job.id, { session: 'claude-links' });
        if (branch)
          setWorktree(own, job.id, { token, path: `/wt/${job.id}`, branch, how: 'created' });
        return { id: job.id, token };
      };
      const pushed = mk('pushed', 'factory/pushed');
      recordEvent(own, pushed.id, { token: pushed.token }, 'branch.pushed', {
        branch: 'factory/pushed',
        head: 'abc',
      });
      expect(detail(own, pushed.id).links.branch).toBe(
        'https://github.com/acme/alpha/tree/factory/pushed',
      );
      expect(detail(own, pushed.id).links.branchUnpushed).toBe(false);
      const unpushed = detail(own, mk('unpushed', 'factory/unpushed').id).links;
      expect(unpushed.branch).toBeNull();
      // github.com, a branch, no PR, no branch.pushed event: the dashboard says "not pushed yet".
      expect(unpushed.branchUnpushed).toBe(true);
      // Another host gives no push claim either way.
      expect(
        detail(own, mk('elsewhere', 'factory/elsewhere', 'git.example/acme/alpha').id).links
          .branchUnpushed,
      ).toBe(false);
      expect(detail(own, mk('no branch', null).id).links.branch).toBeNull();

      // Each branch path segment is URI-encoded.
      const odd = mk('odd', 'factory/a#b?c');
      recordEvent(own, odd.id, { token: odd.token }, 'branch.pushed', { branch: 'x', head: 'a' });
      expect(detail(own, odd.id).links.branch).toBe(
        'https://github.com/acme/alpha/tree/factory/a%23b%3Fc',
      );

      // Another host: the base comes from an http(s) PR URL only. Set directly, as a read model
      // must not trust that every stored URL went through recordPr's check.
      const withPr = (title: string, prUrl: string) => {
        const { id } = mk(title, `factory/${title}`, 'git.example/acme/alpha');
        own.db.update(jobs).set({ prUrl }).where(eq(jobs.id, id)).run();
        return detail(own, id).links.branch;
      };
      expect(withPr('fallback', 'https://git.example/acme/alpha/pull/3')).toBe(
        'https://git.example/acme/alpha/tree/factory/fallback',
      );
      expect(withPr('script', 'javascript:alert(1)//x/acme/alpha/pull/3')).toBeNull();
    } finally {
      own.cleanup();
    }
  });

  it('keeps pushed heads and the branch link beyond the timeline cap (ticket 0079)', () => {
    const own = tempStore();
    const repoPath = tempDir('pushed-heads-');
    dirs.push(repoPath);
    try {
      const mk = (title: string) => {
        const job = createJob(own, {
          title,
          description: title,
          repo: 'github.com/acme/alpha',
          repoPath,
          baseBranch: 'main',
        });
        const { token } = claimJob(own, job.id, { session: 'claude-heads' });
        setWorktree(own, job.id, {
          token,
          path: `/wt/${job.id}`,
          branch: `factory/${title}`,
          how: 'created',
        });
        return { id: job.id, token };
      };
      const long = mk('long');
      recordEvent(own, long.id, { token: long.token }, 'branch.pushed', {
        branch: 'factory/long',
        head: 'abc123',
      });
      for (let i = 0; i < TIMELINE_EVENTS; i++)
        recordEvent(own, long.id, { token: long.token }, 'test.noise', { i });
      const d = detail(own, long.id);
      expect(d.events.some((e) => e.type === 'branch.pushed')).toBe(false); // fell out of the cap
      expect(d.links.pushedHeads).toEqual(['abc123']);
      expect(d.links.branch).toBe('https://github.com/acme/alpha/tree/factory/long');
      expect(d.links.branchUnpushed).toBe(false);

      const never = detail(own, mk('never').id).links;
      expect(never.branch).toBeNull();
      expect(never.pushedHeads).toEqual([]);

      // A malformed head is not a pushed commit, though the event still says the branch is pushed.
      const odd = mk('odd');
      recordEvent(own, odd.id, { token: odd.token }, 'branch.pushed', {
        branch: 'factory/odd',
        head: 42,
      });
      expect(detail(own, odd.id).links.pushedHeads).toEqual([]);
    } finally {
      own.cleanup();
    }
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

  it('measures Elapsed to the terminal transition for finished jobs and to now for active ones', async () => {
    const span = (j: { createdAt: string; completedAt: string | null }) =>
      Date.parse(j.completedAt ?? '') - Date.parse(j.createdAt);
    const elapsedOf = (id: string) => board(store).find((r) => r.id === id)?.elapsedMs;
    const first = [ids.completed, ids.cancelled].map(elapsedOf);
    const before = Date.now();
    await new Promise((r) => setTimeout(r, 30));
    expect([ids.completed, ids.cancelled].map(elapsedOf)).toEqual(first);
    for (const id of [ids.completed, ids.cancelled]) {
      const job = getJob(store.db, id);
      expect(job.completedAt).not.toBeNull();
      expect(elapsedOf(id)).toBe(span(job));
    }
    const active = getJob(store.db, ids.fresh);
    expect(active.completedAt).toBeNull();
    expect(elapsedOf(ids.fresh)).toBeGreaterThanOrEqual(before + 30 - Date.parse(active.createdAt));
  });
});

describe('elapsed time without completedAt', () => {
  let own: TempStore;
  beforeAll(() => {
    own = tempStore();
  });
  afterAll(() => {
    own.cleanup();
  });

  it('falls back to the terminal event, then to null, never to the poll time', () => {
    const repoPath = tempDir('elapsed-');
    dirs.push(repoPath);
    const mk = (title: string) =>
      createJob(own, { title, description: title, repo: 'r', repoPath, baseBranch: 'main' });
    const unset = (id: string, set: Partial<typeof jobs.$inferInsert>) =>
      own.db
        .update(jobs)
        .set({ completedAt: null, ...set })
        .where(eq(jobs.id, id))
        .run();
    const cancelled = mk('Cancelled, completedAt lost');
    const { token } = claimJob(own, cancelled.id, { session: 'claude-elapsed' });
    transitionJob(own, cancelled.id, 'cancel', { token, reason: 'test' });
    unset(cancelled.id, {});
    const event = listEvents(own.db, cancelled.id).find((e) => e.type === 'job.cancelled');
    expect(event).toBeDefined();
    const bare = mk('Completed with no record of when');
    unset(bare.id, { status: 'completed' });
    const elapsedOf = (id: string) => board(own).find((r) => r.id === id)?.elapsedMs;
    const expected = Date.parse(event?.createdAt ?? '') - Date.parse(cancelled.createdAt);
    expect(elapsedOf(cancelled.id)).toBe(expected);
    expect(elapsedOf(bare.id)).toBeNull();
  });
});

describe('board startedAt (ticket 0109)', () => {
  let own: TempStore;
  beforeAll(() => {
    own = tempStore();
  });
  afterAll(() => {
    own.cleanup();
  });

  it('is null until the first start, then the stored first-start time', () => {
    const repoPath = tempDir('started-');
    dirs.push(repoPath);
    const { id } = createJob(own, {
      title: 'Started',
      description: 'Started',
      repo: 'r',
      repoPath,
      baseBranch: 'main',
    });
    const startedOf = () => board(own).find((r) => r.id === id)?.startedAt;
    expect(startedOf()).toBeNull();
    const { token } = claimJob(own, id, { session: 'claude-started' });
    transitionJob(own, id, 'start', { token });
    const stored = own.db.select().from(jobs).where(eq(jobs.id, id)).get()?.startedAt;
    expect(stored).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(startedOf()).toBe(stored);
    transitionJob(own, id, 'fail', { token, reason: 'test' });
    transitionJob(own, id, 'start', { token });
    expect(startedOf()).toBe(stored);
  });
});

describe('board refresh flag (ticket 0053)', () => {
  let own: TempStore;
  beforeAll(() => {
    own = tempStore();
  });
  afterAll(() => {
    own.cleanup();
  });

  it('is true exactly where Refresh PR is allowed', () => {
    const repoPath = tempDir('refresh-');
    dirs.push(repoPath);
    const pr = 'https://github.com/acme/alpha/pull/7';
    const mk = (title: string, set: Partial<typeof jobs.$inferInsert>) => {
      const { id } = createJob(own, {
        title,
        description: title,
        repo: 'r',
        repoPath,
        baseBranch: 'main',
      });
      own.db.update(jobs).set(set).where(eq(jobs.id, id)).run();
      return id;
    };
    const done = { stage: 'completed', status: 'completed' } as const;
    const cases: [string, boolean][] = [
      [mk('finished, open PR', { ...done, prUrl: pr, prState: 'ready' }), true],
      [
        mk('needs human', { stage: 'needs-human', status: 'blocked', prUrl: pr, prState: 'draft' }),
        true,
      ],
      [mk('no PR', done), false],
      [mk('merged', { ...done, prUrl: pr, prState: 'merged' }), false],
      [mk('in ci', { stage: 'ci', status: 'running', prUrl: pr, prState: 'draft' }), false],
    ];
    const rows = board(own);
    for (const [id, refreshable] of cases) {
      expect(rows.find((r) => r.id === id)?.pr.refreshable).toBe(refreshable);
    }
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

  it('merge, refresh-pr, and fix-conflicts pass the same Origin, CSRF, and content-type guards', async () => {
    const before = getJob(store.db, ids.completed);
    for (const action of ['merge', 'refresh-pr', 'fix-conflicts']) {
      const body = { action, force: true };
      expect((await post(ids.completed, body, { 'Content-Type': 'application/json' })).status).toBe(
        403,
      );
      expect(
        (
          await post(ids.completed, body, {
            Origin: 'http://evil.example',
            'Content-Type': 'application/json',
            'X-Orch-Csrf': csrf,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await post(ids.completed, body, {
            ...same(),
            'Content-Type': 'text/plain',
            'X-Orch-Csrf': csrf,
          })
        ).status,
      ).toBe(415);
      expect((await post(ids.completed, body, { ...same(), 'X-Orch-Csrf': 'nope' })).status).toBe(
        403,
      );
    }
    // With the guards satisfied, merge is still refused: this job's PR was never marked ready.
    const refused = await post(
      ids.completed,
      { action: 'merge', force: true },
      { ...same(), 'X-Orch-Csrf': csrf },
    );
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain(
      'Cannot merge',
    );
    expect(getJob(store.db, ids.completed)).toEqual(before);
    const rows = (await (await api('/api/jobs')).json()) as BoardRow[];
    expect(rows.every((r) => typeof r.pr.phase === 'string')).toBe(true);
  });

  it('validates the body and refuses unknown or impossible actions', async () => {
    const h = { ...same(), 'X-Orch-Csrf': csrf };
    const bad = async (body: unknown) => (await post(ids.fresh, body, h)).status;
    expect(await bad({ action: 'merge' })).toBe(422);
    // Parsed and dispatched; refused because the job has no base conflicts.
    const fix = await post(ids.fresh, { action: 'fix-conflicts' }, h);
    expect(fix.status).toBe(422);
    expect(((await fix.json()) as { error: { message: string } }).error.message).toContain(
      'No merge conflicts',
    );
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
    // The cancel itself releases the job; no separate job.released follows.
    expect(events.at(-1)).toBe('job.cancelled:dashboard');
    expect(getJob(store.db, ids.fresh).ownerToken).toBeNull();
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
    expect(d.actions).toEqual(['refresh-pr', 'archive']);
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

  it('archives a finished job through the API and refuses an active one', async () => {
    const h = { ...same(), 'X-Orch-Csrf': csrf };
    const row = async (id: string) =>
      ((await (await api('/api/jobs')).json()) as BoardRow[]).find((r) => r.id === id);
    // The same guards apply to the new actions.
    expect((await post(ids.completed, { action: 'archive' })).status).toBe(403);
    expect(
      (await post(ids.completed, { action: 'archive' }, { ...h, Origin: 'http://evil.example' }))
        .status,
    ).toBe(403);
    expect((await row(ids.completed))?.archivedAt).toBeNull();

    // A session that claimed it again (to observe CI) holds a live lease: refused unless forced.
    const held = await post(ids.completed, { action: 'archive' }, h);
    expect(held.status).toBe(422);
    expect(((await held.json()) as { error: { message: string } }).error.message).toContain(
      'live lease',
    );
    expect((await row(ids.completed))?.archivedAt).toBeNull();
    const ok = await post(ids.completed, { action: 'archive', reason: 'old', force: true }, h);
    expect(ok.status).toBe(200);
    const r = (await ok.json()) as ActionResponse;
    expect(r.resumeCommand).toBeUndefined();
    expect(r.job.archivedAt).not.toBeNull();
    expect(JSON.stringify(r)).not.toContain('ownerToken');
    const archived = await row(ids.completed);
    expect(archived?.archivedAt).toBe(r.job.archivedAt);
    expect([archived?.stage, archived?.status]).toEqual(['completed', 'completed']);
    expect(detail(store, ids.completed).actions).toEqual(['refresh-pr', 'unarchive']);
    expect((await post(ids.completed, { action: 'archive' }, h)).status).toBe(422);

    // An active job: refused with the validation status, and nothing about the row changes.
    const before = getJob(store.db, ids.stale);
    expect((await post(ids.stale, { action: 'archive' }, h)).status).toBe(422);
    expect((await post(ids.stale, { action: 'unarchive' }, h)).status).toBe(422);
    expect(getJob(store.db, ids.stale)).toEqual(before);

    const back = await post(ids.completed, { action: 'unarchive' }, h);
    expect(back.status).toBe(200);
    expect((await row(ids.completed))?.archivedAt).toBeNull();
  });

  it('shows needs-human choices and answers one; choice is a non-negative integer, only with answer', async () => {
    const h = { ...same(), 'X-Orch-Csrf': csrf };
    const j = createJob(store, {
      title: 'Choose',
      description: 'Pick one',
      repo: 'github.com/acme/alpha',
      repoPath: tempDir('choose-'),
      baseBranch: 'main',
    });
    dirs.push(j.repoPath);
    let { token } = claimJob(store, j.id, { session: 's' });
    transitionJob(store, j.id, 'start', { token });
    transitionJob(store, j.id, 'escalate', {
      token,
      reason: 'which way',
      choices: [
        { kind: 'resume', to: 'spec', label: 'Go on' },
        { kind: 'review', label: 'Review it' },
      ],
    });
    const d = detail(store, j.id);
    expect(d.actions).toContain('answer');
    // Round 0: nothing was built, so a review is not available, as the action list says.
    expect(d.actions).not.toContain('request-review');
    expect(d.choices).toEqual([
      {
        kind: 'resume',
        to: 'spec',
        label: 'Go on',
        action: 'approve',
        available: true,
        effect: 'the job goes back to spec and carries on from there',
      },
      {
        kind: 'review',
        label: 'Review it',
        action: 'request-review',
        available: false,
        effect: 'the reviewers look at the current change again',
      },
    ]);
    // Only the available choice is named in what is needed.
    expect(d.needed).toBe('The spec needs a decision from a person: pick "Go on".');
    expect(detail(store, ids.fresh).choices).toBeNull();
    // Answered (approved) by an earlier test: it no longer waits in needs-human.
    expect(detail(store, ids.blocked).choices).toBeNull();

    const before = getJob(store.db, j.id);
    for (const body of [
      { action: 'answer' },
      { action: 'answer', choice: -1 },
      { action: 'answer', choice: 1.5 },
      { action: 'answer', choice: '0' },
      { action: 'approve', choice: 0 },
      { action: 'answer', choice: 2 },
    ]) {
      expect((await post(j.id, body, h)).status, JSON.stringify(body)).toBe(422);
    }
    const body = { action: 'answer', choice: 0 };
    expect((await post(j.id, body, same())).status).toBe(403);
    expect((await post(j.id, body, { ...h, Origin: 'http://evil.example' })).status).toBe(403);
    expect(getJob(store.db, j.id)).toEqual(before);

    const ok = await post(j.id, { ...body, reason: 'fine' }, h);
    expect(ok.status).toBe(200);
    const r = (await ok.json()) as ActionResponse;
    expect([r.job.stage, r.job.status, r.job.ownerSession]).toEqual(['spec', 'pending', null]);
    expect(r.resumeCommand).toBe(`orch factory resume ${j.id} --session <name>`);
    expect(detail(store, j.id).choices).toBeNull();

    // A later escalation without choices replaces them with the default ones.
    token = claimJob(store, j.id, { session: 's' }).token;
    transitionJob(store, j.id, 'escalate', { token, reason: 'again' });
    expect(detail(store, j.id).choices?.map((c) => c.label)).toEqual([
      'Send back to spec',
      'Cancel',
    ]);
    expect(detail(store, j.id).actions).toContain('answer');
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
    specSha256: null,
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
    expect(blockerOf(job(), 'blocked', evidence({ events: fromApprove }))?.summary).toBe(
      'Escalated from approve',
    );

    // A second scope gap names the gap the approver recorded, still as an escalation.
    const scopeGap = (detail?: string | null) =>
      new Map([
        [
          'job.blocked',
          event('job.blocked', {
            from: 'approve',
            reason: SCOPE_GAP_REASON,
            ...(detail === undefined ? {} : { detail }),
          }),
        ],
      ]);
    const gap = blockerOf(job(), 'blocked', evidence({ events: scopeGap('AC3 still missing') }));
    expect(gap).toMatchObject({ kind: 'escalated', detail: SCOPE_GAP_REASON });
    expect(gap?.summary).toContain('AC3 still missing');
    expect(gap?.summary).toMatch(/scope gap/i);
    expect(gap?.summary).not.toContain('Escalated from approve');
    for (const missing of [undefined, null]) {
      const bare = blockerOf(job(), 'blocked', evidence({ events: scopeGap(missing) }));
      expect(bare?.kind).toBe('escalated');
      expect(bare?.summary).toMatch(/scope gap/i);
      expect(bare?.summary).not.toContain('Escalated from approve');
    }

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
  /** Spawns `orch ui --port 0` and resolves once it prints its URL; rejects if it exits first. */
  async function startUi(home: string, stdin: 'pipe' | 'ignore') {
    const child = spawn(
      process.execPath,
      [join(installRoot(), 'src', 'cli', 'main.ts'), 'ui', '--port', '0'],
      { env: { ...process.env, ORCH_HOME: home }, stdio: [stdin, 'pipe', 'pipe'] },
    );
    const exit = new Promise<number | null>((resolve) => child.once('exit', resolve));
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString();
        const m = /orch dashboard: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(out);
        if (m?.[1]) resolve(m[1]);
      });
      void exit.then((code) => {
        reject(new Error(`exited ${String(code)}`));
      });
    });
    return { child, url, exit };
  }

  it('starts on a free port, answers on loopback, and stops when its stdin closes', async () => {
    const home = tempDir('orch-ui-cli-');
    dirs.push(home);
    const { child, url, exit } = await startUi(home, 'pipe');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    const r = await fetch(new URL('/api/jobs', url));
    expect(await r.json()).toEqual([]);
    child.stdin?.end();
    expect(await exit).toBe(0);
    await expect(fetch(new URL('/api/jobs', url))).rejects.toThrow();
    // Factory commands keep working with no dashboard running.
    const list = await orchAsync(home, home, ['--json', 'job', 'list']);
    expect(list.code).toBe(0);
    expect((await orchAsync(home, home, ['ui', '--port', 'abc'])).code).toBe(2);
  });

  it('keeps serving when started with stdin closed (ticket 0094)', async () => {
    const home = tempDir('orch-ui-null-');
    dirs.push(home);
    const { child, url, exit } = await startUi(home, 'ignore');
    await new Promise((r) => setTimeout(r, 1500));
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    const r = await fetch(new URL('/api/jobs', url), { headers: { Connection: 'close' } });
    expect(await r.json()).toEqual([]);
    child.kill();
    await exit;
  });
});

describe('recorded logs on the artifact route (todo 0019)', () => {
  let own: TempStore;
  let srv: RunningServer;
  let a: { id: string; token: string };
  let b: { id: string; token: string };
  let verifyLog = '';
  const ciLog = 'ci/abcdef0/test.log';
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(new URL(path, srv.url), { headers: { ...headers, Connection: 'close' } });
  /** A raw request: fetch() cannot set Host, and normalizes nothing we need kept. */
  const raw = async (path: string, headers: Record<string, string> = {}) => {
    const { request } = await import('node:http');
    return new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port: srv.port, path, headers }, (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      }).end();
    });
  };
  const put = (id: string, rel: string, body: string) => {
    const abs = join(jobArtifactDir(id, own.paths), ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  };
  const mk = (title: string, repo = 'github.com/acme/alpha') => {
    const job = createJob(own, { title, description: title, repo, repoPath, baseBranch: 'main' });
    const { token } = claimJob(own, job.id, { session: 'claude-logs' });
    return { id: job.id, token };
  };
  let repoPath = '';

  beforeAll(async () => {
    own = tempStore();
    repoPath = tempDir('logs-');
    dirs.push(repoPath);
    srv = await startServer({ store: own, port: 0, webRoot });
    a = mk('logs A');
    b = mk('logs B');
    const run = startRun(own, a.id, {
      token: a.token,
      head: 'abcdef0123456789',
      tree: 't',
      dirty: [],
      configFingerprint: 'fp',
      policySource: 'baseline',
      policyHead: null,
      checks: [
        { id: 'check', command: 'node', args: [], cwd: '.', required: true, timeoutMs: 1000 },
      ],
    });
    verifyLog = `verification/${String(run.run.id)}/check.log`;
    const ts = new Date().toISOString();
    recordCheck(own, a.id, { token: a.token }, (run.checks[0] ?? { id: -1 }).id, {
      status: 'passed',
      startedAt: ts,
      completedAt: ts,
      durationMs: 1,
      exitCode: 0,
      signal: null,
      outputPath: verifyLog,
      outputSha256: null,
      truncated: false,
      error: null,
    });
    put(a.id, verifyLog, 'verify output <script>alert(1)</script>\n');
    put(a.id, ciLog, 'ci output\n');
    put(a.id, 'ci/abcdef0/other.log', 'never recorded\n');
    // Poisoned payload values, each with a file present where it points.
    put(a.id, 'notes.txt', 'notes\n');
    put(a.id, '42', 'number\n');
    // `ci/x/../../secret.log` resolves to <dir>/secret.log, `ci/abcdef0/../../../x.log` to <dir>/../x.log.
    put(a.id, 'secret.log', 'inside, never recorded\n');
    put(a.id, '../x.log', 'outside the artifact directory\n');
    // A recorded log whose directory is a junction to a directory outside the job.
    const outside = tempDir('logs-outside-');
    dirs.push(outside);
    writeFileSync(join(outside, 'test.log'), 'outside via junction\n');
    mkdirSync(join(jobArtifactDir(a.id, own.paths), 'ci'), { recursive: true });
    symlinkSync(outside, join(jobArtifactDir(a.id, own.paths), 'ci', 'fedcba9'), 'junction');
    recordEvent(own, a.id, { token: a.token }, 'ci.observed', {
      head: 'abcdef0123456789',
      failures: [
        { name: 'test', conclusion: 'failure', url: null, log: ciLog },
        { name: 'n', conclusion: 'failure', url: null, log: 'notes.txt' },
        { name: 's', conclusion: 'failure', url: null, log: 'ci/x/../../secret.log' },
        { name: 'num', conclusion: 'failure', url: null, log: 42 },
        { name: 'deep', conclusion: 'failure', url: null, log: 'ci/abcdef0/../../../x.log' },
        { name: 'junction', conclusion: 'failure', url: null, log: 'ci/fedcba9/test.log' },
        { name: 'gone', conclusion: 'failure', url: null, log: 'ci/1234567/gone.log' },
      ],
    });
  });
  afterAll(async () => {
    await srv.close();
    own.cleanup();
  });

  it('serves a recorded verification log and a recorded CI log as plain, unsniffed text', async () => {
    for (const [rel, body] of [
      [verifyLog, 'verify output <script>alert(1)</script>\n'],
      [ciLog, 'ci output\n'],
    ] as const) {
      const r = await get(`/api/jobs/${a.id}/artifacts/${rel}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toContain('text/plain');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
      expect(r.headers.get('cache-control')).toBe('no-store');
      expect(await r.text()).toBe(body);
    }
  });

  it('refuses an unrecorded file under the artifact directory (422)', async () => {
    expect((await get(`/api/jobs/${a.id}/artifacts/ci/abcdef0/other.log`)).status).toBe(422);
  });

  it('refuses encoded traversal, backslashes, and absolute paths', async () => {
    expect((await get(`/api/jobs/${a.id}/artifacts/..%2Fsecret.log`)).status).toBe(400);
    expect((await get(`/api/jobs/${a.id}/artifacts/ci/..%2F..%2Fsecret.log`)).status).toBe(400);
    expect((await get(`/api/jobs/${a.id}/artifacts/..%5C..%5Cx.log`)).status).toBe(400);
    expect((await get(`/api/jobs/${a.id}/artifacts/ci%5Cabcdef0%5Ctest.log`)).status).toBe(400);
    expect((await get(`/api/jobs/${a.id}/artifacts/ci/abcdef0/test.log%00`)).status).toBe(400);
    for (const p of ['%2Fetc%2Fpasswd', 'C%3A%5CWindows%5Cwin.ini', 'C%3A%2FWindows%2Fwin.ini']) {
      const r = await get(`/api/jobs/${a.id}/artifacts/${p}`);
      expect(r.status).not.toBe(200);
      expect(r.status).toBe(400);
    }
  });

  it('ignores ci.observed payload values that are not log-shaped strings', async () => {
    const asIs = ['notes.txt', 'ci/x/../../secret.log', '42', 'ci/abcdef0/../../../x.log'];
    for (const v of asIs) {
      // Unnormalized on the wire, and percent-encoded so no `..` is resolved by the URL parser.
      expect(await raw(`/api/jobs/${a.id}/artifacts/${v}`)).not.toBe(200);
      const enc = encodeURIComponent(v);
      const r = await get(`/api/jobs/${a.id}/artifacts/${enc}`);
      expect(r.status).not.toBe(200);
    }
    expect((await get(`/api/jobs/${a.id}/artifacts/notes.txt`)).status).toBe(422);
    expect((await get(`/api/jobs/${a.id}/artifacts/42`)).status).toBe(422);
  });

  it('refuses a recorded log reached through a junction out of the job directory (422)', async () => {
    const r = await get(`/api/jobs/${a.id}/artifacts/ci/fedcba9/test.log`);
    expect(r.status).toBe(422);
    expect(await r.text()).not.toContain('outside via junction');
  });

  it('refuses a registered artifact reached through a junction out of the job directory (422)', async () => {
    const outside = tempDir('artifact-outside-');
    dirs.push(outside);
    writeFileSync(join(outside, 'linked.md'), 'registered artifact outside via junction\n');
    symlinkSync(outside, join(jobArtifactDir(a.id, own.paths), 'reviews'), 'junction');
    // registerArtifact refuses a link out, so the row is written directly: the read model must
    // not trust a row to point inside the artifact directory.
    upsertArtifact(own.db, {
      jobId: a.id,
      stage: 'spec',
      round: 1,
      path: 'reviews/linked.md',
      bytes: 41,
      sha256: '0'.repeat(64),
      marker: null,
      head: 'abcdef0123456789',
      specSha256: null,
      createdAt: new Date().toISOString(),
    });
    const r = await get(`/api/jobs/${a.id}/artifacts/reviews/linked.md`);
    expect(r.status).toBe(422);
    expect(await r.text()).not.toContain('registered artifact outside via junction');
  });

  it('refuses Windows name variants of a recorded CI log', async () => {
    // On Windows each of these names the same file as `ciLog`; only the exact recorded string is
    // served. Sent raw, so the server receives each one unchanged.
    expect(await raw(`/api/jobs/${a.id}/artifacts/${ciLog}::$DATA`)).toBe(400);
    expect(await raw(`/api/jobs/${a.id}/artifacts/${ciLog}.`)).toBe(422);
    expect(await raw(`/api/jobs/${a.id}/artifacts/${ciLog}%20`)).toBe(422);
    expect(await raw(`/api/jobs/${a.id}/artifacts/CI/abcdef0/test.log`)).toBe(422);
  });

  it('refuses a recorded log that is missing on disk (422)', async () => {
    expect((await get(`/api/jobs/${a.id}/artifacts/ci/1234567/gone.log`)).status).toBe(422);
  });

  it("refuses job A's recorded logs under job B's id (422)", async () => {
    expect((await get(`/api/jobs/${b.id}/artifacts/${verifyLog}`)).status).toBe(422);
    expect((await get(`/api/jobs/${b.id}/artifacts/${ciLog}`)).status).toBe(422);
  });

  it('keeps the Host and Sec-Fetch-Site guards on log requests', async () => {
    expect(await raw(`/api/jobs/${a.id}/artifacts/${ciLog}`, { Host: 'evil.example' })).toBe(400);
    expect(
      (await get(`/api/jobs/${a.id}/artifacts/${ciLog}`, { 'Sec-Fetch-Site': 'cross-site' }))
        .status,
    ).toBe(403);
    // A new tab opened from the page sends same-origin, which passes.
    expect(
      (await get(`/api/jobs/${a.id}/artifacts/${ciLog}`, { 'Sec-Fetch-Site': 'same-origin' }))
        .status,
    ).toBe(200);
  });

  it('links.repo is the github.com repository only; links.pr is an http(s) URL only', () => {
    expect(detail(own, a.id).links.repo).toBe('https://github.com/acme/alpha');
    const withPr = (repo: string, prUrl: string | null) => {
      const { id } = mk(`repo ${repo}`, repo);
      if (prUrl) own.db.update(jobs).set({ prUrl }).where(eq(jobs.id, id)).run();
      return detail(own, id).links;
    };
    expect(withPr('gitlab.com/a/b', 'https://github.com/a/b/pull/1').repo).toBeNull();
    expect(withPr('git.example/acme/alpha', 'https://git.example/acme/alpha/pull/3').repo).toBe(
      null,
    );
    expect(withPr('/local/path/repo', null).repo).toBeNull();
    expect(withPr('github.com/acme/alpha/extra', null).repo).toBeNull();
    const script = withPr('github.com/acme/alpha', 'javascript:alert(1)');
    expect(script.pr).toBeNull();
    expect(script.repo).toBe('https://github.com/acme/alpha');
    expect(withPr('github.com/acme/alpha', 'https://github.com/acme/alpha/pull/9').pr).toBe(
      'https://github.com/acme/alpha/pull/9',
    );
    expect(withPr('github.com/acme/alpha', 'not a url').pr).toBeNull();
  });

  it('board pr.url is the same http(s)-checked URL, so a javascript: PR URL is no link', () => {
    const boardPr = (prUrl: string) => {
      const { id } = mk(`board pr ${prUrl}`, 'github.com/acme/alpha');
      own.db.update(jobs).set({ prUrl }).where(eq(jobs.id, id)).run();
      return board(own).find((r) => r.id === id)?.pr.url;
    };
    expect(boardPr('javascript:alert(1)')).toBeNull();
    expect(boardPr('https://github.com/acme/alpha/pull/9')).toBe(
      'https://github.com/acme/alpha/pull/9',
    );
  });

  it('accepts only the log shapes orch writes (isLogPath)', () => {
    for (const ok of ['verification/3/check.log', 'ci/abcdef0/test.log', 'ci/abcdef0/a_b-c.d.log'])
      expect(isLogPath(ok)).toBe(true);
    for (const bad of [
      '/abs/x.log',
      '..\\x.log',
      'C:\\x.log',
      'notes.txt',
      'ci/x/../../secret.log',
      'ci/abcdef0/../../../x.log',
      'verification/3/../x.log',
      'ci/ABCDEF0/x.log',
      'verification/x/c.log',
      42,
      null,
    ])
      expect(isLogPath(bad)).toBe(false);
  });

  it('sends links.logs: the artifact route of each log-shaped recorded path, nothing else', () => {
    // ci.failures is read only for the recorded CI head.
    own.db.update(jobs).set({ ciHead: 'abcdef0123456789' }).where(eq(jobs.id, a.id)).run();
    const route = (p: string) => `/api/jobs/${a.id}/artifacts/${p}`;
    const logs = detail(own, a.id).links.logs;
    // The recorded verification log needs no plan (ticket 0027): it comes from the run rows.
    expect(logs).toEqual({
      [verifyLog]: route(verifyLog),
      [ciLog]: route(ciLog),
      'ci/fedcba9/test.log': route('ci/fedcba9/test.log'),
      'ci/1234567/gone.log': route('ci/1234567/gone.log'),
    });
    for (const bad of ['notes.txt', 'ci/x/../../secret.log', '42', 'ci/abcdef0/../../../x.log'])
      expect(logs[bad]).toBeUndefined();
  });

  it('sends every verification run with its checks, newest first, and each run log (ticket 0027)', () => {
    const c = mk('logs C');
    expect(detail(own, c.id).verificationRuns).toEqual([]);
    const auth = { token: c.token };
    const ts = new Date().toISOString();
    /** One finished run with one check per `[checkId, outputPath]`; the path may not be log-shaped. */
    const record = (status: 'passed' | 'failed', outputs: (run: number) => [string, string][]) => {
      const started = startRun(own, c.id, {
        ...auth,
        head: 'abcdef0123456789',
        tree: 't',
        dirty: [],
        configFingerprint: 'fp',
        policySource: 'baseline',
        policyHead: null,
        checks: outputs(0).map(([id]) => ({
          id,
          command: 'node',
          args: [],
          cwd: '.',
          required: true,
          timeoutMs: 1000,
        })),
      });
      outputs(started.run.id).forEach(([, outputPath], i) => {
        recordCheck(own, c.id, auth, (started.checks[i] ?? { id: -1 }).id, {
          status,
          startedAt: ts,
          completedAt: ts,
          durationMs: 1,
          exitCode: 0,
          signal: null,
          outputPath,
          outputSha256: null,
          truncated: false,
          error: null,
        });
      });
      finishRun(own, c.id, auth, started.run.id, status);
      return started.run.id;
    };
    const log = (run: number, check: string) => `verification/${String(run)}/${check}.log`;
    const first = record('failed', (n) => [
      ['check', log(n, 'check')],
      ['odd', '/abs/x.log'],
    ]);
    const second = record('passed', (n) => [['check', log(n, 'check')]]);
    expect(second).toBeGreaterThan(first);

    const d = detail(own, c.id);
    expect(d.verificationRuns.map((r) => [r.id, r.status])).toEqual([
      [second, 'passed'],
      [first, 'failed'],
    ]);
    expect(d.verificationRuns.map((r) => r.checks.map((k) => [k.runId, k.checkId]))).toEqual([
      [[second, 'check']],
      [
        [first, 'check'],
        [first, 'odd'],
      ],
    ]);
    // The earlier run's log is linked as well; a path that is not log-shaped never is.
    const route = (p: string) => `/api/jobs/${c.id}/artifacts/${p}`;
    expect(d.links.logs).toEqual({
      [log(second, 'check')]: route(log(second, 'check')),
      [log(first, 'check')]: route(log(first, 'check')),
    });
  });
});

describe('session log route (todo 0074)', () => {
  // tests/setup.ts points CLAUDE_CONFIG_DIR at a scratch directory for this file.
  const claude = process.env['CLAUDE_CONFIG_DIR'] ?? '';
  const OTHER = '22222222-3333-4444-8555-666666666666';
  const OLDER = '33333333-4444-4555-8666-777777777777';
  const LINK = 'agent-host-session://ahp-session/17b6e18f-4046-422b-8336-cb43a130967f';
  let own: TempStore;
  let srv: RunningServer;
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(new URL(path, srv.url), { headers: { ...headers, Connection: 'close' } });
  const raw = async (path: string, headers: Record<string, string> = {}) => {
    const { request } = await import('node:http');
    return new Promise<number>((resolve) => {
      request({ host: '127.0.0.1', port: srv.port, path, headers }, (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
      }).end();
    });
  };
  const mk = (title: string, ...sessions: [string, string][]) => {
    const job = createJob(own, {
      title,
      description: title,
      repo: 'github.com/acme/alpha',
      repoPath: claude,
      baseBranch: 'main',
    });
    for (const [provider, ref] of sessions) {
      attachSession(own, job.id, {
        session: { provider: provider as 'claude-code', ref, cwd: null },
      });
    }
    return job.id;
  };
  const log = async (id: string) => {
    const r = await get(`/api/jobs/${id}/session-log`);
    expect(r.status).toBe(200);
    return (await r.json()) as SessionLogView;
  };

  beforeAll(async () => {
    expect(claude).not.toBe('');
    own = tempStore();
    srv = await startServer({ store: own, port: 0, webRoot });
    const project = writeSession(claude, 'E--repo', mainTranscript());
    writeAgent(project, 'a1', user(4, 'builder starts', { isSidechain: true }), {
      agentType: 'builder',
      description: 'Build round 1',
      finished: false,
    });
    writeSession(claude, 'E--other', user(0, 'other job secret'), OTHER);
  });
  afterAll(async () => {
    await srv.close();
    own.cleanup();
  });

  it('returns the attached session newest first, subagents merged in (AC1, AC2)', async () => {
    // A later vscode-agents attachment is current, yet the newest claude-code one is read.
    const id = mk('main', ['claude-code', OLDER], ['claude-code', U], ['vscode-agents', LINK]);
    const v = await log(id);
    expect(v).toMatchObject({ found: true, ref: U, matches: 1 });
    expect(new Set(v.entries.map((e) => e.kind))).toEqual(
      new Set(['user', 'assistant', 'tool', 'result', 'error']),
    );
    expect(v.entries.find((e) => e.kind === 'tool')?.text).toBe('Read /repo/src/a.ts');
    expect(v.entries.find((e) => e.text === 'builder starts')?.agent).toMatchObject({
      id: 'a1',
      type: 'builder',
    });
    expect(v.subagents).toMatchObject([{ id: 'a1', finished: false }]);
    expect(JSON.stringify(v)).not.toContain('secret reasoning');
    // The detail lists every claude-code session, newest first.
    expect(detail(own, id).claudeSessions.map((s) => s.ref)).toEqual([U, OLDER]);
    expect(detail(own, id).session?.provider).toBe('vscode-agents');
  });

  it('says why when nothing is tied or found (AC3)', async () => {
    const none = await log(mk('none'));
    expect(none).toMatchObject({ found: false, ref: null, entries: [] });
    expect(none.reason).toContain('No Claude Code session is recorded for this job.');
    // Named for reference; nothing in the empty state needs the owner's token.
    expect(none.attach).toMatch(/^orch job session attach job-[0-9a-f]{8} --provider claude-code$/);
    expect(JSON.stringify(none)).not.toContain('--token');
    const vscodeOnly = await log(mk('vscode', ['vscode-agents', LINK]));
    expect(vscodeOnly).toMatchObject({ found: false, ref: null });
    const missing = await log(mk('missing', ['claude-code', OLDER]));
    expect(missing).toMatchObject({ found: false, ref: OLDER });
    expect(missing.reason).toContain(`${OLDER}.jsonl`);
  });

  it("never returns another job's transcript (AC4)", async () => {
    const mine = await log(mk('mine', ['claude-code', U]));
    const other = await log(mk('other', ['claude-code', OTHER]));
    expect(JSON.stringify(mine)).not.toContain('other job secret');
    expect(other.entries.map((e) => e.text)).toEqual(['other job secret']);
    expect(JSON.stringify(await log(mk('none 2')))).not.toContain('secret');
  });

  it('takes no file selector: extra segments 404, queries ignored, POST refused (AC4)', async () => {
    const id = mk('selector', ['claude-code', U]);
    expect((await get(`/api/jobs/${id}/session-log/${OTHER}`)).status).toBe(404);
    expect((await get(`/api/jobs/${id}/session-log/..%2F..%2Fx`)).status).toBe(404);
    const q = (await (
      await get(`/api/jobs/${id}/session-log?ref=${OTHER}&path=../../x`)
    ).json()) as SessionLogView;
    expect(q.ref).toBe(U);
    const { csrf } = (await (
      await get('/api/session', { Origin: `http://127.0.0.1:${String(srv.port)}` })
    ).json()) as SessionInfo;
    const post = await fetch(new URL(`/api/jobs/${id}/session-log`, srv.url), {
      method: 'POST',
      headers: {
        Origin: `http://127.0.0.1:${String(srv.port)}`,
        'Content-Type': 'application/json',
        'X-Orch-Csrf': csrf,
        Connection: 'close',
      },
      body: '{}',
    });
    expect([404, 405]).toContain(post.status);
  });

  it('keeps the detail route guards and sends no-store and nosniff (AC6)', async () => {
    const id = mk('guards', ['claude-code', U]);
    const path = `/api/jobs/${id}/session-log`;
    expect(await raw(path, { Host: 'evil.example' })).toBe(
      await raw(`/api/jobs/${id}`, { Host: 'evil.example' }),
    );
    expect(await raw(path, { Host: 'evil.example' })).toBe(400);
    const cross = { 'Sec-Fetch-Site': 'cross-site' };
    expect((await get(path, cross)).status).toBe((await get(`/api/jobs/${id}`, cross)).status);
    expect((await get(path, cross)).status).toBe(403);
    const ok = await get(path, { 'Sec-Fetch-Site': 'same-origin' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    // A foreign Origin is refused outright; the page's own origin passes.
    const foreign = await get(path, { Origin: 'http://evil.example' });
    expect(foreign.status).toBe(403);
    expect(await foreign.text()).not.toContain('Please build');
    const sameOrigin = { Origin: `http://127.0.0.1:${String(srv.port)}` };
    expect((await get(path, sameOrigin)).status).toBe(200);
    expect((await get('/api/jobs/job-00000000/session-log')).status).toBe(404);
    expect((await get('/api/jobs/not-an-id/session-log')).status).toBe(422);
  });
});

describe('usage route (ticket 0127)', () => {
  const claude = process.env['CLAUDE_CONFIG_DIR'] ?? '';
  const REF = '44444444-5555-4666-8777-888888888888';
  let own: TempStore;
  let srv: RunningServer;
  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(new URL(path, srv.url), { headers: { ...headers, Connection: 'close' } });
  /** Every row of every table, to prove a request writes nothing. */
  const dump = () => {
    const db = new DatabaseSync(own.file, { readOnly: true });
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[];
      return JSON.stringify(
        tables.map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}"`).all()]),
      );
    } finally {
      db.close();
    }
  };

  beforeAll(async () => {
    expect(claude).not.toBe('');
    own = tempStore();
    srv = await startServer({ store: own, port: 0, webRoot });
    const job = createJob(own, {
      title: 'usage job',
      description: 'usage job',
      repo: 'github.com/acme/alpha',
      repoPath: claude,
      baseBranch: 'main',
    });
    attachSession(own, job.id, { session: { provider: 'claude-code', ref: REF, cwd: null } });
    const now = new Date().toISOString();
    writeSession(
      claude,
      'E--usage',
      JSON.stringify({
        type: 'assistant',
        timestamp: now,
        message: { id: 'msg-1', usage: { input_tokens: 3, output_tokens: 4 } },
      }),
      REF,
    );
  });
  afterAll(async () => {
    await srv.close();
    own.cleanup();
  });

  it('returns the typed view for hours=24 and writes nothing (AC6)', async () => {
    const before = dump();
    const r = await get('/api/usage?hours=24');
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const v = (await r.json()) as UsageView;
    expect(v.hours).toBe(24);
    expect(v.buckets).toHaveLength(24);
    expect(v.buckets.at(-1)).toMatchObject({ input: 3, output: 4, missing: [] });
    expect(v.total).toEqual({
      input: 3,
      output: 4,
      cacheRead: 0,
      cacheCreation: 0,
      complete: true,
    });
    expect(v.jobs).toMatchObject([{ title: 'usage job', input: 3, missing: null }]);
    expect(dump()).toBe(before);
  });

  it('refuses other ranges, suffixes, and foreign requests (AC6)', async () => {
    for (const q of ['hours=5', 'hours=abc', '']) {
      expect((await get(`/api/usage?${q}`)).status).toBe(400);
    }
    expect((await get('/api/usage/x')).status).toBe(404);
    expect((await get('/api/usage?hours=24', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await get('/api/usage?hours=24', { Origin: 'http://evil.example' })).status).toBe(403);
    expect((await get('/api/usage?hours=168')).status).toBe(200);
  });
});
