import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

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
  await expect(table.getByText('last reported running')).toBeVisible();
  await expect(table.getByText('running (lease live)').first()).toBeVisible();
  await expect(table.getByText('needs human').first()).toBeVisible();
  await expect(page.getByText('2 running')).toBeVisible();
  await expect(page.getByText('1 stale')).toBeVisible();
  // One verdict rollup per row with the blocking count beside it; reviewers are in its tooltip.
  await expect(table.getByText('1/3, 2 pending')).toBeVisible();
  await expect(table.getByText('2 blocking').first()).toBeVisible();
  // CI chips always name the commit the verdict was read for; repairs show their budget.
  await expect(table.getByText('CI failing @f1e2d3c')).toBeVisible();
  await expect(table.getByText('CI pending @a1b2c3d')).toBeVisible();
  await expect(table.getByText('CI none @b2c3d4e')).toBeVisible();
  await expect(table.getByText('repairs 1/1')).toBeVisible();
  await expect(table.getByText(/CI still failing after 1 of 1 repair cycles/)).toBeVisible();
  await expect(table.getByText(/GitHub reports no checks for the PR head/)).toBeVisible();
  // Why a job stopped is on the board, and cancelled is never dressed as a success.
  await expect(table.getByText(/Approver escalated: a human must decide/)).toBeVisible();
  await expect(table.getByText(/decided against it/)).toBeVisible();
  await expect(table.getByText(/required check "test" failed twice/)).toBeVisible();
  await expect(table.locator('[data-state="cancelled"]')).toHaveText(/cancelled/);
  await expect(table.locator('[data-state="cancelled"]')).not.toHaveClass(/colorSuccess/);
  await expect(table.locator('[data-state="completed"]')).toHaveClass(/colorSuccess/);
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
  await expect(page.getByRole('link', { name: 'Open PR on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/acme/alpha/pull/41',
  );
  await page.getByRole('tab', { name: 'Spec' }).click();
  await expect(page.getByText('Users can download any report as a CSV file.')).toBeVisible();
  await page.getByRole('tab', { name: 'Reviews' }).click();
  // The heading's text content includes its blocking chip ("Round 1blocking 2"): prefix match.
  await expect(page.getByText(/^Round 1/)).toBeVisible();
  await expect(page.getByText(/^Round 2/)).toBeVisible();
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

test('archives and unarchives from the board row', async ({ page }) => {
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
  await expect(page.getByText(/Recorded reason: required check "test" failed twice/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^Resume at / })).toHaveCount(0);
  const resume = page.getByTestId('resume');
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
  // Its session holds a live lease, so no resume command is advertised; the holder is named.
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
  // A live lease also means no resume command is advertised; the holder is named instead.
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
  await expect(page.getByText(/CI still failing after 1 of 1 repair cycles/).first()).toBeVisible();
  await expect(page.getByTestId('ci-guidance')).toContainText('repair budget is spent');
  await expect(page.getByRole('button', { name: 'Accept delivery' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Request rework' })).toHaveClass(
    /MuiButton-outlined/,
  );
  await page.getByRole('tab', { name: 'PR' }).click();
  const panel = page.getByTestId('ci-panel');
  await expect(panel).toContainText('CI failing @d4e5f60');
  await expect(panel).toContainText('Repairs used: 1 of 1');
  await expect(panel.getByRole('link', { name: 'GitHub log' })).toHaveAttribute(
    'href',
    'https://github.com/acme/alpha/actions/runs/9/job/901',
  );
  await expect(panel).toContainText('ci/d4e5f60/test.log');

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
