/**
 * A recorded per-model fallback (ticket 0179, decision 2026-11-26-per-model-limit-falls-back): the
 * plan, review rows, the Agents read model, and `orch job usage` follow the model that ran, the
 * draw is never rewritten, and `orch job limit` records what a session reports. The controller's
 * side is in tests/run-model-fallback.test.ts.
 */
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { JOB_HELP } from '../src/cli/job.ts';
import { jobUsage } from '../src/ops/usage.ts';
import { agents } from '../src/server/api.ts';
import { eventsOfTypes } from '../src/storage/events.ts';
import { listReviews, recordEvent } from '../src/storage/jobs.ts';
import * as drive from './drive.ts';
import { next, start, store } from './factory-fixture.ts';
import { commitFile, orch } from './helpers.ts';

const config = (models: Record<string, unknown>) => {
  writeFileSync(join(store.paths.config, 'factory.json'), JSON.stringify({ models }));
};
const drawnText = (id: string) =>
  JSON.stringify(eventsOfTypes(store.db, id, ['models.drawn']).map((e) => e.payload));
const modelsOf = (id: string) => Object.fromEntries(next(id).agents.map((a) => [a.role, a.model]));
const FELL = ['spec-writer', 'builder', 'security'];

describe('a recorded fallback', () => {
  it('changes the plan and the attribution, never the draw (AC3, AC10)', async () => {
    config(Object.fromEntries(FELL.map((r) => [r, 'fable'])));
    const c = start();
    config(Object.fromEntries(FELL.map((r) => [r, ['fable', 'opus']])));
    const drawn = drawnText(c.id);
    expect(modelsOf(c.id)).toEqual({ 'spec-writer': 'fable' });

    // The spec is written on fable; then fable runs out and every fable role falls back.
    drive.passSpec(store, c);
    await delay(5);
    for (const role of FELL) {
      recordEvent(store, c.id, { token: c.token }, 'models.fallback', {
        role,
        from: 'fable',
        to: 'opus',
        text: 'Fable limit reached',
        until: null,
      });
    }
    expect(drawnText(c.id)).toBe(drawn);
    expect(modelsOf(c.id)).toEqual({ builder: 'opus' });

    drive.go(store, c, 'start');
    commitFile(c.wt, 'src/export.ts', '// export\n');
    drive.verify(store, c);
    drive.add(store, c, 'build.md');
    drive.go(store, c, 'complete');
    drive.simplify(store, c);
    expect(modelsOf(c.id)['security']).toBe('opus');
    drive.go(store, c, 'start');
    drive.verdict(store, c, 'security');
    drive.verdict(store, c, 'correctness');

    // Review rows: the model that ran, compared with the builder's model then.
    const rows = Object.fromEntries(listReviews(store.db, c.id).map((r) => [r.reviewer, r]));
    expect(rows['security']).toMatchObject({ model: 'opus', sameAsAuthor: true });
    expect(rows['correctness']).toMatchObject({ model: 'sonnet', sameAsAuthor: false });

    const { byModel } = agents(store);
    const key = (r: { role: string; model: string | null; fellBack: boolean }) =>
      [r.role, r.model, r.fellBack].join(' ');
    // The spec writer finished on fable before the fallback; the builder ran opus.
    expect(byModel.builders.map(key)).toEqual(['spec-writer fable true', 'builder opus true']);
    expect(byModel.reviewers.map(key)).toEqual(['security opus true', 'correctness sonnet true']);
    expect(byModel.challengers.map(key)).toEqual(['spec-challenger sonnet true']);

    const usage = jobUsage(store, c.id);
    expect(usage.models).toMatchObject({ builder: 'opus', security: 'opus', simplifier: 'sonnet' });
    expect(usage.fallbacks.map((f) => [f.role, f.from, f.to])).toEqual(
      FELL.map((r) => [r, 'fable', 'opus']),
    );
    expect(usage.reviews.find((r) => r.reviewer === 'security')?.configuredModel).toBe('opus');
    expect(drawnText(c.id)).toBe(drawn);

    // A job that never fell back is keyed apart.
    config({});
    const plain = start('Plain');
    drive.passSpec(store, plain);
    expect(agents(store).byModel.builders.map(key)).toContain('builder opus false');
    expect(jobUsage(store, plain.id).fallbacks).toEqual([]);
  });
});

describe('orch job limit (AC4)', () => {
  const cli = (...args: string[]) => orch(store.home, tmpdir(), ['job', 'limit', ...args]);

  it('records models.limit for the owner and refuses everything else', () => {
    const c = start();
    const epoch = Math.floor(Date.now() / 1000) + 3600;
    const ok = cli(
      c.id,
      '--model',
      'fable',
      '--text',
      `  Fable limit reached|${String(epoch)}\u001b[0m `,
      '--token',
      c.token,
    );
    expect(ok.err).toBe('');
    expect(ok.code).toBe(0);
    expect(cli(c.id, '--model', 'fable', '--text', 'Fable limit', '--token', c.token).code).toBe(0);
    expect(eventsOfTypes(store.db, c.id, ['models.limit']).map((e) => e.payload)).toEqual([
      { model: 'fable', text: 'Fable limit', until: null },
      {
        model: 'fable',
        text: `Fable limit reached|${String(epoch)}`,
        until: new Date(epoch * 1000).toISOString(),
      },
    ]);

    expect(cli(c.id, '--model', 'gpt', '--text', 'x', '--token', c.token).code).toBe(2);
    expect(cli(c.id, '--text', 'x', '--token', c.token).code).toBe(2);
    expect(cli(c.id, '--model', 'fable', '--text', '  ', '--token', c.token).code).toBe(2);
    expect(cli(c.id, '--model', 'fable', '--token', c.token).code).toBe(2);
    expect(cli('job-00000000', '--model', 'fable', '--text', 'x', '--token', c.token).code).toBe(3);
    expect(cli(c.id, '--model', 'fable', '--text', 'x', '--token', 'wrong').code).toBe(4);
    expect(eventsOfTypes(store.db, c.id, ['models.limit'])).toHaveLength(2);
    expect(JOB_HELP).toContain('limit <id> --model <');
  });
});
