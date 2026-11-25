/**
 * Model pools per role (ticket 0168): the plan and review rows read the job's `models.drawn` event,
 * so a pool edit never changes a running job; a job without the event stores nulls.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { drawnModelsOf } from '../src/core/roles.ts';
import { resumeFactoryJob } from '../src/ops/factory.ts';
import { eventsOfTypes } from '../src/storage/events.ts';
import { getJob, listReviews } from '../src/storage/jobs.ts';
import { events } from '../src/storage/schema.ts';
import * as drive from './drive.ts';
import { next, start, store } from './factory-fixture.ts';

const config = (models: Record<string, unknown>) => {
  writeFileSync(join(store.paths.config, 'factory.json'), JSON.stringify({ models }));
};
const drawnOf = (id: string) => drawnModelsOf(eventsOfTypes(store.db, id, ['models.drawn']));
const modelsOf = (id: string) => Object.fromEntries(next(id).agents.map((a) => [a.role, a.model]));

describe('model pools', () => {
  it('the plan carries the drawn model, across calls, a rework round, and a pool edit (AC5)', () => {
    config({ builder: ['opus', 'fable'], security: ['opus', 'sonnet', 'haiku'] });
    const c = start();
    const drawn = drawnOf(c.id);
    const model = (role: string) => drawn?.[role]?.model;
    expect(modelsOf(c.id)).toEqual({ 'spec-writer': model('spec-writer') });

    drive.toReview(store, c);
    const review = modelsOf(c.id);
    expect(review).toEqual(modelsOf(c.id));
    for (const role of ['security', 'correctness', 'code-quality']) {
      expect(review[role]).toBe(model(role));
    }

    // The person edits the pools: the running job keeps its draw.
    config({ builder: ['haiku'], security: ['haiku'] });
    expect(modelsOf(c.id)['security']).toBe(model('security'));

    // A CHANGES round sends the job back to build with the same builder model.
    drive.go(store, c, 'start');
    drive.verdict(store, c, 'security', 'CHANGES');
    drive.verdict(store, c, 'correctness');
    drive.verdict(store, c, 'code-quality');
    drive.add(store, c, 'round-1/consolidated.md', drive.consolidated(store, c, '1'));
    drive.go(store, c, 'complete');
    expect(getJob(store.db, c.id).stage).toBe('build');
    expect(modelsOf(c.id)).toEqual({ builder: model('builder') });

    // Resuming the job draws nothing new.
    resumeFactoryJob(store, c.id, { session: 'claude-other', force: true });
    expect(eventsOfTypes(store.db, c.id, ['models.drawn'])).toHaveLength(1);
  });

  it('review rows store the drawn model and whether it matches the builder (AC6)', () => {
    config({ builder: 'opus', security: 'opus', correctness: 'sonnet' });
    const c = start();
    drive.toReview(store, c);
    drive.go(store, c, 'start');
    drive.verdict(store, c, 'security');
    drive.verdict(store, c, 'correctness');
    const rows = Object.fromEntries(listReviews(store.db, c.id).map((r) => [r.reviewer, r]));
    expect(rows['security']).toMatchObject({ model: 'opus', sameAsAuthor: true });
    expect(rows['correctness']).toMatchObject({ model: 'sonnet', sameAsAuthor: false });
  });

  it('a job without a models.drawn event stores null model columns (AC6)', () => {
    const c = start();
    // A job created before pools existed: no event.
    store.db
      .delete(events)
      .where(and(eq(events.jobId, c.id), eq(events.type, 'models.drawn')))
      .run();
    drive.toReview(store, c);
    drive.go(store, c, 'start');
    drive.verdict(store, c, 'security');
    expect(listReviews(store.db, c.id)[0]).toMatchObject({ model: null, sameAsAuthor: null });
  });
});
