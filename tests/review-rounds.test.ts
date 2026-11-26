/**
 * The dashboard shows the current review round's verdicts; earlier rounds stay as history in the
 * detail view, both after a rework and after a human requests another review round.
 */
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dashboardAction } from '../src/ops/actions.ts';
import { board, detail } from '../src/server/api.ts';
import { getJob } from '../src/storage/jobs.ts';
import {
  add,
  consolidated,
  type Ctx,
  go,
  makePolicyRepo,
  passRound,
  simplify,
  start,
  toReview,
  verdict,
  verify,
} from './drive.ts';
import { answeredBuild, commitFile, type TempStore, tempStore } from './helpers.ts';

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

const row = (c: Ctx) => board(store).find((r) => r.id === c.id);
const verdicts = (c: Ctx, round: number) =>
  detail(store, c.id)
    .rounds.find((r) => r.round === round)
    ?.reviews.map((r) => `${r.reviewer}:${r.verdict ?? 'pending'}`)
    .sort();

describe('review rounds on the dashboard', () => {
  it('CHANGES, rework, PASS: the board shows round 2 only, the detail keeps round 1', () => {
    const c = start(store, clone);
    toReview(store, c);
    go(store, c, 'start');
    verdict(store, c, 'security');
    verdict(store, c, 'correctness', 'CHANGES');
    verdict(store, c, 'code-quality');
    add(store, c, 'round-1/consolidated.md', consolidated(store, c, '2'));
    go(store, c, 'complete');
    // Rework: during build the rejected round is still current, with its blocking count.
    expect(row(c)?.blocking).toBe(2);
    go(store, c, 'start');
    commitFile(c.wt, 'src/r2.ts', '// r2\n', 'r2');
    verify(store, c);
    add(store, c, 'build.md', answeredBuild('1.1', '1.2'), true);
    go(store, c, 'complete');
    simplify(store, c);

    // Round 2 is open and nobody has recorded: no round-1 verdicts, no round-1 blocking chip.
    expect(getJob(store.db, c.id).round).toBe(2);
    expect(row(c)?.reviews).toEqual([]);
    expect(row(c)?.blocking).toBeNull();

    go(store, c, 'start');
    for (const r of ['security', 'correctness', 'code-quality']) verdict(store, c, r);
    expect(row(c)?.reviews.map((r) => r.verdict)).toEqual(['pass', 'pass', 'pass']);
    expect(row(c)?.blocking).toBeNull(); // not consolidated yet
    add(store, c, 'round-2/consolidated.md', consolidated(store, c, '0'));
    expect(row(c)?.blocking).toBe(0);
    go(store, c, 'complete');
    expect(getJob(store.db, c.id).stage).toBe('approve');

    expect(verdicts(c, 1)).toEqual(['code-quality:pass', 'correctness:changes', 'security:pass']);
    expect(verdicts(c, 2)).toEqual(['code-quality:pass', 'correctness:pass', 'security:pass']);
  });

  it('Request review round opens a new round; the old verdicts stay as history', () => {
    const c = start(store, clone);
    toReview(store, c);
    passRound(store, c);
    expect(getJob(store.db, c.id)).toMatchObject({ stage: 'approve', round: 1 });

    const r = dashboardAction(store, c.id, { action: 'request-review', force: true });
    expect(r.job).toMatchObject({ stage: 'review', status: 'pending', round: 2 });
    expect(row(c)?.reviews).toEqual([]);
    expect(row(c)?.blocking).toBeNull();
    expect(verdicts(c, 1)).toEqual(['code-quality:pass', 'correctness:pass', 'security:pass']);
  });
});
