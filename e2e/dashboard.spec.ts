import { readFileSync } from 'node:fs';

import { expect, type Locator, type Page, test } from '@playwright/test';

import { type E2eState, STATE_ENV } from './global-setup.ts';

/** This run's seeded ids and server URL, written by global-setup under its own scratch home. */
const state = (): E2eState => {
  const file = process.env[STATE_ENV];
  if (!file) throw new Error('global-setup did not run: no ' + STATE_ENV + ' in the environment');
  return JSON.parse(readFileSync(file, 'utf8')) as E2eState;
};

// The server picked its port at startup; every page in this file talks to that server only.
test.use({ baseURL: state().url });

test('job board shows every repository and job with honest liveness', async ({ page }) => {
  await page.goto('/');
  const table = page.getByRole('table', { name: 'Factory jobs' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(11); // header + 10 jobs
  // Repository, Session, and Branch / worktree are hidden until chosen from the Columns menu.
  await expect(table.getByRole('columnheader', { name: 'Repository' })).toHaveCount(0);
  await expect(table.getByRole('columnheader', { name: 'Session' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Columns' }).click();
  await page.getByRole('checkbox', { name: 'Repository column' }).check();
  await page.keyboard.press('Escape');
  await expect(table.getByText('github.com/acme/alpha').first()).toBeVisible();
  await expect(table.getByText('github.com/acme/beta').first()).toBeVisible();
  await expect(table.locator('[data-state="stale"]')).toHaveText('◌ stale');
  await expect(table.locator('[data-state="running"]').first()).toHaveText('● running');
  await expect(table.getByText('running (lease live)')).toHaveCount(0);
  await expect(table.getByText('last reported running')).toHaveCount(0);
  await expect(table.getByText('needs human').first()).toBeVisible();
  await expect(page.getByText('2 running')).toBeVisible();
  await expect(page.getByText('1 stale')).toBeVisible();
  // One verdict rollup per row; reviewers are in its tooltip. The blocking chip is the current
  // round's only, so round 2 under review does not wear round 1's `2 blocking`.
  await expect(table.getByText('1/3, 2 pending')).toBeVisible();
  await expect(table.getByText('2 blocking')).toHaveCount(0);
  // CI chips always name the commit the verdict was read for; the repairs budget is a round count,
  // so it sits in the Round column, never in PR / CI.
  await expect(table.getByText('CI failing @f1e2d3c')).toBeVisible();
  await expect(table.getByText('CI pending @a1b2c3d')).toBeVisible();
  await expect(table.getByText('CI none @b2c3d4e')).toBeVisible();
  const headers = await table.getByRole('columnheader').allTextContents();
  const repaired = table.getByRole('row').filter({ hasText: 'repairs 1/1' });
  await expect(repaired).toHaveCount(1);
  const cell = (label: string) =>
    repaired.getByRole('cell').nth(headers.findIndex((h) => h.startsWith(label)));
  await expect(cell('Round')).toContainText('repairs 1/1');
  await expect(cell('PR / CI')).toContainText('CI failing @d4e5f60');
  await expect(cell('PR / CI')).not.toContainText('repairs');
  await expect(table.getByText(/CI still failing after 1 of 1 repair cycles/)).toBeVisible();
  await expect(table.getByText(/GitHub reports no checks for the PR head/)).toBeVisible();
  // Why a job stopped is on the board, and cancelled is never dressed as a success.
  await expect(table.getByText(/Approver escalated: a human must decide/)).toBeVisible();
  await expect(table.getByText(/decided against it/)).toBeVisible();
  await expect(table.getByText(/required check "test" failed twice/)).toBeVisible();
  await expect(table.locator('[data-state="cancelled"]')).toHaveText(/cancelled/);
  await expect(table.locator('[data-state="cancelled"]')).not.toHaveClass(/colorSuccess/);
  await expect(table.locator('[data-state="completed"]')).toHaveClass(/colorSuccess/);
  // Completed on GitHub's verdict, CI later failing: the label claims no outcome beyond completed.
  await expect(table.locator('[data-state="completed"]')).toHaveAttribute(
    'data-outcome',
    'completed',
  );
  await expect(table.locator('[data-state="completed"]')).toHaveText('✓ completed');
  // Resume is offered for the stale (lapsed lease), failed (released), and unowned jobs only; the
  // blocked job's session still holds a live lease, so the board says so instead.
  await expect(table.getByRole('button', { name: /Copy resume command/ })).toHaveCount(5);
  await expect(
    table.getByText(/Resume unavailable: session claude-20261113-0800-1d2e/),
  ).toBeVisible();
});

test('filters by repository and status', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Repository').click();
  await page.getByRole('option', { name: 'github.com/acme/beta' }).click();
  const table = page.getByRole('table', { name: 'Factory jobs' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await page.getByLabel('Show').click();
  await page.getByRole('option', { name: 'needs human' }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByText('Rate limiting for public API')).toBeVisible();
  await page.getByLabel('Repository').click();
  await page.getByRole('option', { name: 'All repositories' }).click();
  await page.getByLabel('Show').click();
  await page.getByRole('option', { name: 'cancelled' }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByText('Migrate to pnpm')).toBeVisible();
});

test('job detail exposes spec, reviews, long findings, decision, events, and links', async ({
  page,
}) => {
  const { ids } = state();
  await page.goto(`/#/jobs/${ids.completed}`);
  await expect(page.getByRole('heading', { name: 'Export reports as CSV' })).toBeVisible();
  // Not at needs-human: no approver decision or blocking-findings block.
  await expect(page.getByTestId('decision-summary')).toHaveCount(0);
  await expect(page.getByTestId('blocking-findings')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open PR on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/acme/alpha/pull/41',
  );
  // Counts with one meaning each: two review rounds; round 2's consolidation recorded BLOCKING: 0.
  await expect(page.getByRole('tab', { name: 'Reviews (2 rounds)', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Findings (0 blocking)', exact: true })).toBeVisible();
  await expect(page.getByTestId('tab-unavailable')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Spec' }).click();
  await expect(page.getByText('Users can download any report as a CSV file.')).toBeVisible();
  await page.getByRole('tab', { name: 'Reviews' }).click();
  // The heading's text content includes its blocking chip ("Round 1blocking 2"): prefix match.
  await expect(page.getByText(/^Round 1/)).toBeVisible();
  await expect(page.getByText(/^Round 2 \(current\)/)).toBeVisible();
  // Reviewers are collapsed: the header shows the verdict, the body only once expanded.
  await expect(page.locator('[data-marker="VERDICT"]')).toHaveCount(0);
  const reviewer = page.getByRole('button', { name: /^security/ }).first();
  await expect(reviewer).toHaveAttribute('aria-expanded', 'false');
  await reviewer.click();
  await expect(reviewer).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-marker="VERDICT"]').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Findings' }).click();
  await expect(page.getByText('finding 24 of round 2')).toBeVisible();
  await expect(page.locator('[data-marker="BLOCKING"]').first()).toBeVisible();
  await page.getByRole('tab', { name: 'Decision' }).click();
  await expect(page.locator('[data-marker="DECISION"]')).toContainText('APPROVE');
  await page.getByRole('tab', { name: 'Events' }).click();
  await expect(
    page.getByRole('table', { name: 'Events' }).getByText('job.completed'),
  ).toBeVisible();
  // The attached claude-code session's synthetic transcript, its subagent merged in by time.
  await page.getByRole('tab', { name: 'Session', exact: true }).click();
  const timeline = page.getByRole('list', { name: 'Session timeline' });
  await expect(timeline.getByRole('listitem')).toHaveCount(3);
  await expect(timeline.getByRole('listitem').first()).toContainText('Launching the builder.');
  await expect(timeline.getByRole('listitem').nth(1)).toContainText('builder: Build round 1');
  await expect(timeline.getByRole('listitem').nth(1)).toContainText('Edit src/export.ts');
  await expect(page.getByTestId('session-subagents')).toContainText('running');
  await page.getByRole('tab', { name: 'Verification' }).click();
  // Seeded jobs have no worktree, so the evidence panel says so instead of inventing a run.
  await expect(page.getByText('No worktree; nothing verified.')).toBeVisible();
  await page.getByRole('tab', { name: 'PR' }).click();
  // Delivered on GitHub's verdict for f1e2d3c; the later failing observation is shown for that
  // same commit, never dressed up as the completion.
  await expect(page.getByTestId('ci-panel')).toContainText('CI failing @f1e2d3c');
  await expect(page.getByTestId('completion')).toHaveText(
    'Completed: required checks passed for f1e2d3c.',
  );
  // Finished jobs have no live controls and nothing to resume; they can only be archived.
  await expect(page.getByRole('button', { name: 'Archive' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel job' })).toHaveCount(0);
  await expect(page.getByTestId('resume')).toHaveCount(0);
});

test('a fresh job explains its unavailable tabs, and the keyboard cannot open them', async ({
  page,
}) => {
  const { ids } = state();
  await page.goto(`/#/jobs/${ids.fresh}`);
  await expect(page.getByRole('heading', { name: 'Add health endpoint' })).toBeVisible();
  const block = page.getByTestId('tab-unavailable');
  await expect(block).toBeVisible();
  await expect(block).toHaveText(
    'Not available yet: Spec needs spec.md (spec stage). Build needs build.md (build stage). ' +
      'Decision needs decision.md (approve stage). PR needs an opened PR or pr.md (pr stage).',
  );
  const overview = page.getByRole('tab', { name: 'Overview' });
  const spec = page.getByRole('tab', { name: 'Spec', exact: true });
  await expect(spec).toHaveAttribute('aria-disabled', 'true');
  await expect(spec).toHaveAccessibleDescription('Spec needs spec.md (spec stage).');
  await expect(page.getByRole('tab', { name: 'Reviews (0 rounds)', exact: true })).toBeVisible();
  // Playwright will not click an aria-disabled element unless forced; a user still can.
  await spec.click({ force: true });
  await expect(overview).toHaveAttribute('aria-selected', 'true');
  await spec.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  await expect(overview).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('id', 'panel-Overview');
  // Arrow keys skip Spec and Build.
  await overview.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Reviews (0 rounds)', exact: true })).toBeFocused();
});

test('a finished job can be archived, found under Show: archived, and unarchived', async ({
  page,
}) => {
  const { ids } = state();
  const title = 'Export reports as CSV';
  await page.goto(`/#/jobs/${ids.completed}`);
  await page.getByRole('button', { name: 'Archive' }).click();
  // A session that claimed it again to observe CI holds its lease; a plain confirm takes it over.
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Archive' }).click();
  await expect(page.getByRole('status')).toContainText('Job archived');
  await expect(page.getByRole('button', { name: 'Unarchive' })).toBeVisible();

  await page.goto('/');
  const table = page.getByRole('table', { name: 'Factory jobs' });
  await expect(table.getByRole('row')).toHaveCount(10); // header + 9 unarchived jobs
  await expect(table.getByText(title)).toHaveCount(0);
  await page.getByLabel('Show').click();
  await page.getByRole('option', { name: 'archived' }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByText(title)).toBeVisible();
  await expect(table.getByText('archived', { exact: true })).toBeVisible();

  // Unarchive so later tests see the seeded board.
  await table.getByRole('link', { name: title }).click();
  await page.getByRole('button', { name: 'Unarchive' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unarchive' }).click();
  await expect(page.getByRole('status')).toContainText('Job unarchived');
  await page.goto('/');
  await expect(table.getByRole('row')).toHaveCount(11);
  await expect(table.getByText(title)).toBeVisible();
});

/** Archive a finished job from its board row, find it under Show: archived, and unarchive it. */
async function archiveFromRow(page: Page): Promise<void> {
  // A plain Cancel / Archive confirm; the board always takes over a finished job's lease.
  const title = 'Migrate to pnpm';
  await page.goto('/');
  const table = page.getByRole('table', { name: 'Factory jobs' });
  const rowOf = (t: string) => table.getByRole('row').filter({ hasText: t });
  // Only finished rows offer Archive: the completed and the cancelled job.
  await expect(table.getByRole('button', { name: /^Archive / })).toHaveCount(2);
  await expect(rowOf('Fix login redirect loop').getByRole('button')).toHaveCount(0);
  // The row's button names its job: "Archive <title> (<id>)".
  await rowOf(title)
    .getByRole('button', { name: new RegExp(`^Archive ${title} [(]job-[0-9a-f]{8}[)]$`) })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Archive' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(table.getByText(title)).toHaveCount(0);
  await expect(table.getByRole('row')).toHaveCount(10);

  await page.getByRole('combobox', { name: 'Show' }).click();
  await page.getByRole('option', { name: 'archived' }).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await rowOf(title)
    .getByRole('button', { name: new RegExp(`^Unarchive ${title} [(]job-[0-9a-f]{8}[)]$`) })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Unarchive' }).click();
  // Nothing is archived any more: the archived view is empty.
  await expect(table).toHaveCount(0);
  await expect(page.getByText('No jobs match these filters.')).toBeVisible();
  await page.getByRole('combobox', { name: 'Show' }).click();
  await page.getByRole('option', { name: /^current/ }).click();
  await expect(table.getByRole('row')).toHaveCount(11);
  await expect(table.getByText(title)).toBeVisible();
}

test('archives and unarchives from the board row', async ({ page }) => {
  await archiveFromRow(page);
});

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const must = (b: Box | null): Box => {
  if (!b) throw new Error('element has no bounding box');
  return b;
};
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
};
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const overlapsVertically = (a: Box, b: Box) => a.y < b.y + b.height && b.y < a.y + a.height;
/** Fully inside the viewport horizontally (the page may scroll vertically). */
async function withinWidth(page: Page, l: Locator): Promise<void> {
  await l.scrollIntoViewIfNeeded();
  const b = must(await l.boundingBox());
  const width = page.viewportSize()?.width ?? 0;
  expect(b.x, 'left edge inside the viewport').toBeGreaterThanOrEqual(0);
  expect(b.x + b.width, 'right edge inside the viewport').toBeLessThanOrEqual(width);
}

const WIDTHS = [800, 1000, 1440];

for (const width of WIDTHS) {
  test(`app bar at ${String(width)}px: labels inside, controls apart`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('table', { name: 'Factory jobs' })).toBeVisible();
    const bar = must(await page.locator('header').boundingBox());
    // Field roots, in toolbar order, each with its shrunk label (which sits above the field).
    const names = ['Filter', 'Repository', 'Show'];
    const controls: Box[] = [];
    for (const [i, name] of names.entries()) {
      const label = must(
        await page
          .locator('header label')
          .filter({ hasText: new RegExp(`^${name}$`) })
          .boundingBox(),
      );
      expect(label.y, `${name} label top`).toBeGreaterThanOrEqual(Math.max(bar.y, 0));
      expect(label.y + label.height, `${name} label bottom`).toBeLessThanOrEqual(
        bar.y + bar.height,
      );
      expect(label.x + label.width, `${name} label right`).toBeLessThanOrEqual(width);
      const field = must(await page.locator('header .MuiFormControl-root').nth(i).boundingBox());
      controls.push(union(field, label));
    }
    const others = [
      must(await page.getByRole('link', { name: 'orch factory' }).boundingBox()),
      must(await page.getByLabel('Summary').boundingBox()),
    ];
    for (const [i, a] of controls.entries()) {
      for (const b of [...controls.slice(i + 1), ...others]) {
        expect(overlaps(a, b), `${String(names[i])} overlaps another app-bar element`).toBe(false);
      }
    }
    if (width === 800) {
      const show = must(await page.getByRole('combobox', { name: 'Show' }).boundingBox());
      const filter = must(await page.getByRole('searchbox', { name: 'Filter' }).boundingBox());
      const repo = must(await page.getByRole('combobox', { name: 'Repository' }).boundingBox());
      expect(overlapsVertically(show, filter) || overlapsVertically(show, repo)).toBe(true);
    }
  });
}

for (const width of [800, 1000]) {
  for (const optIn of [false, true]) {
    test(`board at ${String(width)}px${optIn ? ' with opt-in columns' : ''} keeps PR / CI and Actions on screen`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      // Repository, Session, and Branch / worktree switched on: nothing hidden from the menu.
      if (optIn)
        await page.addInitScript({
          content: `localStorage.setItem('orch.board.hiddenColumns', '[]');`,
        });
      await page.goto('/');
      const table = page.getByRole('table', { name: 'Factory jobs' });
      await expect(table.getByRole('row')).toHaveCount(11);
      for (const name of ['Job', 'Status'])
        await expect(table.getByRole('columnheader', { name })).toBeVisible();
      for (const name of ['PR / CI', 'Actions']) {
        const h = table.getByRole('columnheader', { name });
        await expect(h).toBeVisible();
        await withinWidth(page, h);
      }
      // The table's container (no DOM lib here, so the check is passed as an expression).
      const overflow: unknown = await page.evaluate(
        `(() => { const c = document.querySelector('table[aria-label="Factory jobs"]').parentElement;
          return c.scrollWidth - c.clientWidth; })()`,
      );
      expect(overflow).toBe(0);
    });
  }
}

for (const width of [390, 800]) {
  test(`detail header at ${String(width)}px keeps its summary inside the viewport`, async ({
    page,
  }) => {
    const { ids } = state();
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/#/jobs/${ids.completed}`);
    const header = page.getByTestId('job-header');
    await expect(header.getByRole('heading', { name: 'Export reports as CSV' })).toBeVisible();
    const branch = header.getByRole('link', {
      name: `factory/${ids.completed}-export-reports-as-csv`,
    });
    await expect(branch).toHaveAttribute(
      'href',
      `https://github.com/acme/alpha/tree/factory/${ids.completed}-export-reports-as-csv`,
    );
    for (const l of [
      header.getByRole('heading', { name: 'Export reports as CSV' }),
      header.locator('[data-state]'),
      header.getByRole('img', { name: /^Progress:/ }),
      branch,
      header.getByRole('link', { name: 'PR #41' }),
    ])
      await withinWidth(page, l);
  });
}

test('board at 1440px renders every default column', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const table = page.getByRole('table', { name: 'Factory jobs' });
  for (const name of [
    'Job',
    'Stage',
    'Status',
    'Round',
    'Reviews',
    'Elapsed',
    'Updated',
    'PR / CI',
    'Actions',
  ])
    await expect(table.getByRole('columnheader', { name })).toBeVisible();
  await withinWidth(page, table.getByRole('columnheader', { name: 'Actions' }));
});

test('every board action is reachable at 800px', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/');
  const table = page.getByRole('table', { name: 'Factory jobs' });
  await expect(table.getByRole('row')).toHaveCount(11);
  await withinWidth(page, page.getByRole('button', { name: 'Columns' }));
  const groups = [
    table.getByRole('button', { name: /^(Archive|Unarchive) / }),
    table.getByRole('button', { name: /Copy resume command/ }),
    table.getByRole('link', { name: /^PR \(/ }),
  ];
  for (const group of groups) {
    const n = await group.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      await expect(group.nth(i)).toBeVisible();
      await withinWidth(page, group.nth(i));
    }
  }
  await archiveFromRow(page);
});

test('board controls appear only on the board', async ({ page }) => {
  const { ids } = state();
  await page.goto('/');
  const filter = page.getByRole('searchbox', { name: 'Filter' });
  await filter.fill('pnpm');
  // A hash change, not a reload: the filter state lives in the page.
  const go = (hash: string) => page.evaluate(`location.hash = ${JSON.stringify(hash)}`);
  await go(`#/jobs/${ids.completed}`);
  await expect(page.getByRole('heading', { name: 'Export reports as CSV' })).toBeVisible();
  await expect(filter).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Repository' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Show' })).toHaveCount(0);
  await go('#/');
  await expect(filter).toHaveValue('pnpm');
  await expect(page.getByRole('combobox', { name: 'Show' })).toBeVisible();
});

test('filters by text and sorts by a header', async ({ page }) => {
  await page.goto('/');
  const table = page.getByRole('table', { name: 'Factory jobs' });
  await expect(table.getByRole('row')).toHaveCount(11);
  const filter = page.getByRole('searchbox', { name: 'Filter' });
  await filter.fill('pnpm');
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByText('Migrate to pnpm')).toBeVisible();
  // Combines with Show: no cancelled job matches "csv".
  await filter.fill('csv');
  await expect(table.getByRole('row')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Show' }).click();
  await page.getByRole('option', { name: 'cancelled' }).click();
  await expect(table).toHaveCount(0);
  await filter.fill('');
  await expect(table.getByRole('row')).toHaveCount(2);
  await page.getByRole('combobox', { name: 'Show' }).click();
  await page.getByRole('option', { name: /^current/ }).click();
  await expect(table.getByRole('row')).toHaveCount(11);

  const job = table.getByRole('columnheader', { name: 'Job' });
  await job.getByRole('button').click();
  await expect(job).toHaveAttribute('aria-sort', 'ascending');
  await expect(table.getByRole('row').nth(1)).toContainText('Add health endpoint');
  await job.getByRole('button').click();
  await expect(job).toHaveAttribute('aria-sort', 'descending');
  await expect(table.getByRole('row').last()).toContainText('Add health endpoint');
});

test('a stopped job explains itself and offers recovery, not approval', async ({ page }) => {
  const { ids } = state();
  await page.goto(`/#/jobs/${ids.failed}`);
  await expect(page.getByRole('heading', { name: 'Retry flaky uploads' })).toBeVisible();
  await expect(page.getByText('Stage failed.')).toBeVisible();
  const summary = page.getByTestId('status-summary');
  await expect(summary).toContainText('Stage failed.');
  await expect(summary).toContainText('required check "test" failed twice');
  await expect(page.getByTestId('status-next')).toContainText(
    "Resume from a Claude Code session in the job's checkout.",
  );
  await expect(page.getByRole('button', { name: /^Resume at / })).toHaveCount(0);
  // The copy button is beside the summary, once; the command's particulars wait in Details.
  const copy = page.getByRole('button', { name: /Copy resume command/ });
  await expect(copy).toHaveCount(1);
  await expect(copy).toBeVisible();
  const resume = page.getByTestId('resume');
  await expect(resume).toBeHidden();
  await page.getByRole('button', { name: 'Details' }).click();
  await expect(resume).toBeVisible();
  await expect(resume).toContainText(`/factory resume ${ids.failed}`);
  await expect(resume).toContainText('Copying does not resume anything');
  await expect(resume.getByRole('link', { name: 'Open checkout in VS Code' })).toHaveAttribute(
    'href',
    /^vscode:\/\/file\//,
  );
  // The approver's escalation is a real decision gate: Resume is the primary control there.
  await page.goto(`/#/jobs/${ids.blocked}`);
  await expect(page.getByText('Decision needed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Resume at approve' })).toHaveClass(
    /MuiButton-contained/,
  );
  await expect(page.getByTestId('status-next')).toContainText(
    'Resume at approve or Request rework',
  );
  // The approver's decision is above the Controls: marker and Rationale only.
  const decision = page.getByTestId('decision-summary');
  await expect(decision).toContainText('ESCALATE');
  await expect(decision).toContainText('AC2 needs a deployment to verify');
  await expect(decision).not.toContainText('Examined');
  await expect(decision).not.toContainText('Scope changes');
  const decisionBox = await decision.boundingBox();
  const controlsBox = await page.getByText('Controls', { exact: true }).boundingBox();
  expect(decisionBox && controlsBox && decisionBox.y < controlsBox.y).toBe(true);
  // Its newest consolidation records BLOCKING: 0; the marker is trusted over tagged lines.
  await expect(page.getByTestId('blocking-findings')).toContainText('no blocking findings');
  // Its session holds a live lease, so no resume command is advertised; the holder is named.
  await page.getByRole('button', { name: 'Details' }).click();
  await expect(page.getByTestId('resume')).toHaveCount(0);
  await expect(page.getByTestId('resume-unavailable')).toContainText('claude-20261113-0800-1d2e');
});

test('controls cannot bypass workflow rules, and never claim to wake a session', async ({
  page,
}) => {
  const { ids } = state();
  // The reviewing job has a live lease: an action without a forced takeover is refused.
  await page.goto(`/#/jobs/${ids.reviewing}`);
  await expect(page.getByText(/Actions will be refused/)).toBeVisible();
  await expect(page.getByTestId('status-next')).toContainText(
    'Continue from, or wait for, session claude-20261113-0900-ab12.',
  );
  await expect(page.getByTestId('decision-summary')).toHaveCount(0);
  await expect(page.getByTestId('blocking-findings')).toHaveCount(0);
  // A live lease also means no resume command is advertised; the holder is named instead.
  await page.getByRole('button', { name: 'Details' }).click();
  await expect(page.getByTestId('resume-unavailable')).toContainText('claude-20261113-0900-ab12');
  await page.getByRole('button', { name: 'Request rework' }).click();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('dialog').getByText(/live lease/)).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();

  // The human-blocked job can be resumed at its stage; the result says to resume a session.
  await page.goto(`/#/jobs/${ids.blocked}`);
  await page.getByRole('button', { name: 'Resume at approve' }).click();
  await page.getByLabel(/Reason/).fill('Deployment check done by hand');
  await page.getByRole('button', { name: 'Confirm' }).click();
  const status = page.getByRole('status');
  await expect(status).toContainText('No session is running it');
  await expect(status).toContainText(`orch factory resume ${ids.blocked}`);
  await expect(page.locator('[data-state="idle"]')).toBeVisible();
  await expect(page.getByText('Waiting for a session.')).toBeVisible();

  // Board reflects the change on refresh.
  await page.goto('/');
});

test('CI escalations: close-out is offered only where the workflow allows it', async ({ page }) => {
  const { ids } = state();
  // Repairs exhausted on a failing check: the state and the budget are explained, but completing
  // the job by hand is not on offer, and rework is not promoted either.
  await page.goto(`/#/jobs/${ids.ciExhausted}`);
  await expect(page.getByText('CI stopped.')).toBeVisible();
  const summary = page.getByTestId('status-summary');
  await expect(summary).toContainText('CI stopped.');
  await expect(summary).toContainText('CI still failing for d4e5f60; 1 of 1 repairs used.');
  await expect(page.getByTestId('status-next')).toContainText('repair budget is spent');
  await expect(page.getByTestId('ci-guidance')).toHaveCount(0);
  // Details is collapsed: the CLI form, the checkout, and the session line appear only on expand.
  const details = page.getByRole('button', { name: 'Details' });
  await expect(details).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText(/Equivalent CLI/)).toBeHidden();
  await expect(page.getByText(/the checkout this job was started from/)).toBeHidden();
  await expect(page.getByTestId('session').or(page.getByTestId('session-none'))).toBeHidden();
  await details.click();
  await expect(details).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(/Equivalent CLI/)).toBeVisible();
  await expect(page.getByText(/the checkout this job was started from/)).toBeVisible();
  await expect(page.getByTestId('session').or(page.getByTestId('session-none'))).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept delivery' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request rework' })).toHaveClass(
    /MuiButton-outlined/,
  );
  await page.getByRole('tab', { name: 'PR' }).click();
  const panel = page.getByTestId('ci-panel');
  await expect(panel).toContainText('CI failing @d4e5f60');
  // The budget is stated once, in the CI line; the CI chip carries no round count.
  await expect(panel).not.toContainText('Repairs used:');
  await expect(panel).not.toContainText('repairs 1/1');
  await expect(panel).toContainText('CI still failing for d4e5f60; 1 of 1 repairs used.');
  await expect(panel.getByRole('link', { name: 'GitHub log' })).toHaveAttribute(
    'href',
    'https://github.com/acme/alpha/actions/runs/9/job/901',
  );
  await expect(panel).toContainText('ci/d4e5f60/test.log');
  // The saved log opens through the artifact route, in a new tab that passes the Host guard.
  const saved = panel.getByRole('link', { name: 'Saved log ci/d4e5f60/test.log' });
  await expect(saved).toHaveAttribute(
    'href',
    `/api/jobs/${ids.ciExhausted}/artifacts/ci/d4e5f60/test.log`,
  );
  await expect(saved).toHaveAttribute('target', '_blank');
  await expect(saved).toHaveAttribute('rel', 'noreferrer noopener');
  const [logTab] = await Promise.all([page.context().waitForEvent('page'), saved.click()]);
  await logTab.waitForLoadState();
  await expect(logTab.locator('body')).toContainText('FAIL tests/export.test.ts for d4e5f60');
  await logTab.close();
  // The PR head is a commit link on the github.com repository.
  await expect(panel.getByRole('link', { name: 'Commit d4e5f607 on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/acme/alpha/commit/d4e5f60718293041',
  );

  // No checks at all: a human may close it out, with a reason, and the result says so.
  await page.goto(`/#/jobs/${ids.ciNone}`);
  await expect(page.getByText(/GitHub reports no checks for the PR head/).first()).toBeVisible();
  await expect(page.getByTestId('close-out-caution')).toContainText('human close-out');
  await page.getByRole('button', { name: 'Accept delivery' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Confirm' })).toBeDisabled();
  await dialog.getByLabel(/Reason/).fill('Repository has no CI; reviewed the PR by hand');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  const status = page.getByRole('status');
  await expect(status).toContainText('Delivery accepted by a human');
  await expect(status).toContainText('Nothing was merged or marked ready');
  await expect(page.locator('[data-state="completed"]')).toBeVisible();
  await expect(page.locator('[data-state="completed"]')).toHaveAttribute('data-outcome', 'human');
  await expect(page.getByTestId('completion')).toContainText('Completed by human close-out');
  await expect(page.getByText('human close-out').first()).toBeVisible();
  await page.goto('/');
});

test('keyboard: job links are reachable with Tab and open with Enter', async ({ page }) => {
  const { ids } = state();
  await page.goto('/');
  const link = page.getByRole('link', { name: 'Add health endpoint' });
  await link.focus();
  await expect(link).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`#/jobs/${ids.fresh}$`));
  await expect(page.getByRole('heading', { name: 'Add health endpoint' })).toBeVisible();
});

test('API refuses cross-origin mutations even from the browser', async ({ page }) => {
  const { ids } = state();
  await page.goto('/');
  const result = await page.evaluate(async (id) => {
    const r = await fetch(`/api/jobs/${id}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel' }),
    });
    return { status: r.status, body: (await r.json()) as { error: { message: string } } };
  }, ids.fresh);
  expect(result.status).toBe(403);
  expect(result.body.error.message).toContain('CSRF');
});
