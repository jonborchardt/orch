/**
 * Representative factory state for dashboard tests and manual runs: several repositories,
 * a live running job, a stale one, a needs-human escalation, multiple review rounds with long
 * findings, a completed job with a failing CI PR, a cancelled job, and a fresh unowned job.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { jobArtifactDir } from '../../src/core/paths.ts';
import type { Store } from '../../src/storage/client.ts';
import {
  claimJob,
  createJob,
  recordCi,
  recordPr,
  recordReview,
  registerArtifact,
  transitionJob,
} from '../../src/storage/jobs.ts';

const SPEC = `# Export reports as CSV

## Goal

Users can download any report as a CSV file.

## Scope

In scope:
- Export button on the report page
- Server endpoint streaming CSV

Out of scope:
- Scheduled exports

## Acceptance criteria

- [ ] AC1: Clicking Export downloads a .csv with the visible columns
- [ ] AC2: Non-ASCII values are UTF-8 with BOM
- [ ] AC3: Exports over 10k rows stream without buffering

## Affected surfaces

Web UI, HTTP API

## Risks

- Large exports could tie up a worker
`;

const BUILD = `# Build (round 1)

## Summary

Added \`ExportButton\` and \`GET /api/reports/:id.csv\`.

## Changes

- \`src/reports/ExportButton.tsx\`
- \`server/routes/reports.ts\`

## Validation

- \`npm test\` → 212 passed
- \`npm run lint\` → clean

## Acceptance criteria

- AC1: met (test \`exports visible columns\`)
- AC2: met (BOM test)
- AC3: not verified locally
`;

function longFindings(round: number): string {
  const items = Array.from(
    { length: 24 },
    (_, i) =>
      `${String(i + 1)}. [${i < 2 ? 'BLOCKING' : i < 8 ? 'MAJOR' : 'MINOR'}] server/routes/reports.ts:${String(40 + i * 7)} — ` +
      `finding ${String(i + 1)} of round ${String(round)}: the CSV writer ${i % 2 ? 'buffers the whole result set in memory before responding, which contradicts AC3 for large reports' : 'does not escape embedded quotes and newlines in cell values, so a value containing "," or a line break corrupts the row structure'} → ` +
      `${i % 2 ? 'stream rows with a Transform and backpressure' : 'wrap values in quotes and double embedded quotes'} (correctness${i % 3 ? ', security' : ''})`,
  ).join('\n');
  return `# Consolidated findings (round ${String(round)})

## Verdicts

- security: ${round === 1 ? 'CHANGES' : 'PASS'}
- correctness: CHANGES
- code-quality: PASS

## Findings

${items}

## Dropped

- "Rename ExportButton to CsvExportButton" (code-quality): out of scope, style only.

BLOCKING: 2
`;
}

function review(name: string, verdict: 'PASS' | 'CHANGES', round: number): string {
  return `# Review: ${name} (round ${String(round)})

## Scope checked

Read the diff against origin/main (3 files), ran \`npm test\` in the worktree (212 passed), and
exercised the export endpoint with a 50k-row fixture.

## Findings

${
  verdict === 'CHANGES'
    ? `- [BLOCKING] server/routes/reports.ts:61 — CSV cells are not quoted; values containing commas corrupt rows → quote and escape every field
- [MAJOR] server/routes/reports.ts:88 — whole result set is loaded into memory → stream rows`
    : 'No findings.'
}

VERDICT: ${verdict}
`;
}

const DECISION_ESCALATE = `# Decision: Rate limiting

## Examined

spec.md, build.md, git diff (4 files), round 1 reviews.

## Acceptance criteria

- AC1: verified by test
- AC2: cannot be verified without the production proxy configuration

## Outstanding findings

none

## Scope changes

The builder also changed the logging format, which the spec did not ask for.

## Rationale

AC2 needs a deployment to verify and an unrequested change is in the diff; a human should decide.

DECISION: ESCALATE
`;

const PR = `# Export reports as CSV

## Summary

Adds CSV export for reports.

## Validation

npm run check: pass (212 tests).

## Review

Round 2 of 3: security PASS, correctness PASS, code-quality PASS. Approver: APPROVE.

## Known limitations

AC3 (streaming over 10k rows) was verified with a fixture, not production data.
`;

function write(dir: string, rel: string, body: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

export interface SeededJobs {
  completed: string;
  reviewing: string;
  stale: string;
  blocked: string;
  cancelled: string;
  fresh: string;
}

/**
 * Seed the store. `repos` maps identity -> checkout path; worktrees are only recorded, not
 * created, except that callers may pass `worktreeFor` to attach a real one to the reviewing job.
 */
export function seedDashboard(
  store: Store,
  repos: { alpha: string; beta: string; gamma: string },
): SeededJobs {
  const mk = (title: string, repo: string, repoPath: string, extra: Record<string, unknown> = {}) =>
    createJob(store, { title, repo, repoPath, baseBranch: 'main', ...extra });
  const run = (id: string, token: string, a: Parameters<typeof transitionJob>[2], extra = {}) =>
    transitionJob(store, id, a, { token, ...extra });
  const art = (id: string, token: string, rel: string, body: string, replace = false) => {
    write(jobArtifactDir(id, store.paths), rel, body);
    registerArtifact(store, id, rel, { token, replace });
  };

  // 1. Completed with a draft PR whose CI is failing.
  const completed = mk('Export reports as CSV', 'github.com/acme/alpha', repos.alpha, {
    description: 'Add a feature to export reports as CSV',
    issueRef: '#12',
  });
  {
    const { token } = claimJob(store, completed.id, { session: 'claude-20261112-1500-9f1e' });
    const id = completed.id;
    run(id, token, 'start');
    art(id, token, 'spec.md', SPEC);
    run(id, token, 'complete');
    run(id, token, 'start');
    art(id, token, 'build.md', BUILD);
    run(id, token, 'complete');
    run(id, token, 'start');
    for (const [r, v] of [
      ['security', 'CHANGES'],
      ['correctness', 'CHANGES'],
      ['code-quality', 'PASS'],
    ] as const) {
      art(id, token, `round-1/review-${r}.md`, review(r, v, 1));
      recordReview(store, id, { token, reviewer: r, verdict: v === 'PASS' ? 'pass' : 'changes' });
    }
    art(id, token, 'round-1/consolidated.md', longFindings(1));
    run(id, token, 'complete');
    run(id, token, 'start');
    art(id, token, 'build.md', BUILD.replace('round 1', 'round 2'), true);
    run(id, token, 'complete');
    run(id, token, 'start');
    for (const r of ['security', 'correctness', 'code-quality'] as const) {
      art(id, token, `round-2/review-${r}.md`, review(r, 'PASS', 2));
      recordReview(store, id, { token, reviewer: r, verdict: 'pass' });
    }
    art(
      id,
      token,
      'round-2/consolidated.md',
      longFindings(2).replace('BLOCKING: 2', 'BLOCKING: 0'),
    );
    run(id, token, 'complete');
    run(id, token, 'start');
    art(
      id,
      token,
      'decision.md',
      DECISION_ESCALATE.replace('DECISION: ESCALATE', 'DECISION: APPROVE'),
    );
    run(id, token, 'complete');
    run(id, token, 'start');
    art(id, token, 'pr.md', PR);
    recordPr(store, id, { token, url: 'https://github.com/acme/alpha/pull/41', state: 'draft' });
    run(id, token, 'complete');
    recordCi(store, id, { token, ciStatus: 'failing' });
  }

  // 2. In review round 2 with a live session.
  const reviewing = mk('Fix login redirect loop', 'github.com/acme/alpha', repos.alpha, {
    description: 'After SSO the app redirects forever when the return URL has a hash',
  });
  {
    const { token } = claimJob(store, reviewing.id, { session: 'claude-20261113-0900-ab12' });
    const id = reviewing.id;
    run(id, token, 'start');
    art(id, token, 'spec.md', SPEC.replace('Export reports as CSV', 'Fix login redirect loop'));
    run(id, token, 'complete');
    run(id, token, 'start');
    art(id, token, 'build.md', BUILD);
    run(id, token, 'complete');
    run(id, token, 'start');
    for (const [r, v] of [
      ['security', 'PASS'],
      ['correctness', 'CHANGES'],
      ['code-quality', 'CHANGES'],
    ] as const) {
      art(id, token, `round-1/review-${r}.md`, review(r, v, 1));
      recordReview(store, id, { token, reviewer: r, verdict: v === 'PASS' ? 'pass' : 'changes' });
    }
    art(id, token, 'round-1/consolidated.md', longFindings(1));
    run(id, token, 'complete');
    run(id, token, 'start');
    art(id, token, 'build.md', BUILD.replace('round 1', 'round 2'), true);
    run(id, token, 'complete');
    run(id, token, 'start');
    art(id, token, 'round-2/review-security.md', review('security', 'PASS', 2));
    recordReview(store, id, { token, reviewer: 'security', verdict: 'pass' });
    recordReview(store, id, { token, reviewer: 'correctness' });
    recordReview(store, id, { token, reviewer: 'code-quality' });
  }

  // 3. Building, but the owner's lease lapsed (a zero-minute lease): "last reported running".
  const stale = mk('Dark mode for settings', 'github.com/acme/beta', repos.beta);
  {
    const { token } = claimJob(store, stale.id, {
      session: 'claude-20261113-0710-77c0',
      leaseMinutes: 0,
    });
    run(stale.id, token, 'start');
    art(
      stale.id,
      token,
      'spec.md',
      SPEC.replace('Export reports as CSV', 'Dark mode for settings'),
    );
    run(stale.id, token, 'complete');
    run(stale.id, token, 'start');
  }

  // 4. Escalated by the approver: needs a human.
  const blocked = mk('Rate limiting for public API', 'github.com/acme/beta', repos.beta, {
    maxRounds: 2,
  });
  {
    const { token } = claimJob(store, blocked.id, { session: 'claude-20261113-0800-1d2e' });
    const id = blocked.id;
    run(id, token, 'start');
    art(
      id,
      token,
      'spec.md',
      SPEC.replace('Export reports as CSV', 'Rate limiting for public API'),
    );
    run(id, token, 'complete');
    run(id, token, 'start');
    art(id, token, 'build.md', BUILD);
    run(id, token, 'complete');
    run(id, token, 'start');
    for (const r of ['security', 'correctness', 'code-quality'] as const) {
      art(id, token, `round-1/review-${r}.md`, review(r, 'PASS', 1));
      recordReview(store, id, { token, reviewer: r, verdict: 'pass' });
    }
    art(
      id,
      token,
      'round-1/consolidated.md',
      longFindings(1).replace('BLOCKING: 2', 'BLOCKING: 0'),
    );
    run(id, token, 'complete');
    run(id, token, 'start');
    art(id, token, 'decision.md', DECISION_ESCALATE);
    run(id, token, 'escalate', {
      reason: 'AC2 needs deployment verification; unrequested logging change',
    });
  }

  // 5. Cancelled.
  const cancelled = mk('Migrate to pnpm', 'gamma', repos.gamma);
  {
    const { token } = claimJob(store, cancelled.id, { session: 'claude-20261110-1200-0000' });
    run(cancelled.id, token, 'cancel', { reason: 'decided against it' });
  }

  // 6. Fresh, unowned.
  const fresh = mk('Add health endpoint', 'gamma', repos.gamma, {
    description: 'GET /healthz returning build info',
  });

  return {
    completed: completed.id,
    reviewing: reviewing.id,
    stale: stale.id,
    blocked: blocked.id,
    cancelled: cancelled.id,
    fresh: fresh.id,
  };
}
