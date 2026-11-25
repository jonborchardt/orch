/**
 * Registration rules for attributed findings (ticket 0169, AC2): round-N/consolidated.md tags each
 * blocking finding with reviewers of that round, and the next build.md answers each one.
 */
import { rmSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { eventsOfTypes } from '../src/storage/events.ts';
import { getJob, registerArtifact } from '../src/storage/jobs.ts';
import {
  add,
  consolidated,
  type Ctx,
  go,
  makePolicyRepo,
  start,
  toReview,
  verdict,
  verify,
} from './drive.ts';
import {
  answeredBuild,
  commitFile,
  fixture,
  orch,
  tempDir,
  type TempStore,
  tempStore,
  writeArtifact,
} from './helpers.ts';

let store: TempStore;
let clone: string;
let bare: string;
beforeEach(() => {
  store = tempStore();
  ({ clone, bare } = makePolicyRepo());
});
afterEach(() => {
  store.cleanup();
  for (const d of [clone, bare]) rmSync(d, { recursive: true, force: true });
});

/** Round 1 with correctness asking for changes, then the given consolidation. */
function changesRound(c: Ctx, body: string): void {
  go(store, c, 'start');
  verdict(store, c, 'security');
  verdict(store, c, 'correctness', 'CHANGES');
  verdict(store, c, 'code-quality');
  add(store, c, 'round-1/consolidated.md', body);
  go(store, c, 'complete');
  expect(getJob(store.db, c.id).stage).toBe('build');
  go(store, c, 'start');
  commitFile(c.wt, 'src/r2.ts', '// r2\n', 'r2');
  verify(store, c);
}

describe('attributed findings at registration', () => {
  it('orch job artifact add refuses a tag naming a reviewer with no review this round', () => {
    const c = start(store, clone);
    toReview(store, c);
    go(store, c, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(store, c, r);
    const body = consolidated(store, c, '1').replace('(reviewers: security)', '(reviewers: ux)');
    writeArtifact(c.dir, 'round-1/consolidated.md', body);
    const r = orch(
      store.home,
      tempDir(),
      ['job', 'artifact', 'add', c.id, 'round-1/consolidated.md'],
      {
        ORCH_TOKEN: c.token,
      },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain('names ux, which recorded no review in round 1');
  });

  it('build.md names unanswered and unknown ids, then registers once all are answered', () => {
    const c = start(store, clone);
    toReview(store, c);
    changesRound(c, consolidated(store, c, '2'));
    expect(() => add(store, c, 'build.md', fixture('build.md'), true)).toThrow(
      /unanswered: 1\.1, 1\.2/,
    );
    expect(() => add(store, c, 'build.md', answeredBuild('1.1', '1.2', '1.3'), true)).toThrow(
      /unknown id\(s\): 1\.3/,
    );
    add(store, c, 'build.md', answeredBuild('1.1', '1.2'), true);
    // --replace is checked the same way, and the event keeps each registration's answers.
    expect(() => add(store, c, 'build.md', answeredBuild('1.1') + '\n', true)).toThrow(
      /unanswered: 1\.2/,
    );
    const declined = answeredBuild('1.1').replace(
      '- 1.1: fixed',
      '- 1.1: fixed\n- 1.2: declined — out of scope',
    );
    add(store, c, 'build.md', declined, true);
    const answers = eventsOfTypes(store.db, c.id, ['artifact.registered', 'artifact.replaced'])
      .filter((e) => e.payload['path'] === 'build.md')
      .map((e) => e.payload['answers'] ?? null)
      .reverse(); // newest first
    expect(answers).toEqual([
      null,
      [
        { id: '1.1', answer: 'fixed' },
        { id: '1.2', answer: 'fixed' },
      ],
      [
        { id: '1.1', answer: 'fixed' },
        { id: '1.2', answer: 'declined' },
      ],
    ]);
  });

  it('build.md needs no Findings addressed after BLOCKING: 0', () => {
    const c = start(store, clone);
    toReview(store, c);
    changesRound(c, consolidated(store, c, '0'));
    expect(add(store, c, 'build.md', fixture('build.md') + '\n', true).path).toBe('build.md');
  });

  it('build.md needs no Findings addressed after a legacy (untagged) consolidation', () => {
    const c = start(store, clone);
    toReview(store, c);
    go(store, c, 'start');
    verdict(store, c, 'security');
    verdict(store, c, 'correctness', 'CHANGES');
    verdict(store, c, 'code-quality');
    // Registered before the rule existed: straight through storage, as an old orch did.
    const legacy = consolidated(store, c, '1').replace(' (reviewers: security)', ' (correctness)');
    writeArtifact(c.dir, 'round-1/consolidated.md', legacy);
    registerArtifact(store, c.id, 'round-1/consolidated.md', { token: c.token });
    go(store, c, 'complete');
    go(store, c, 'start');
    commitFile(c.wt, 'src/r2.ts', '// r2\n', 'r2');
    verify(store, c);
    expect(add(store, c, 'build.md', fixture('build.md') + '\n', true).path).toBe('build.md');
  });
});
