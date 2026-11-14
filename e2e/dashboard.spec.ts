import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { SeededJobs } from '../tests/fixtures/dashboard.ts';
import { STATE_FILE } from './global-setup.ts';

const state = () => JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { ids: SeededJobs };

test('job board shows every repository and job with honest liveness', async ({ page }) => {
  await page.goto('/');
  const table = page.getByRole('table', { name: 'Factory jobs' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(8); // header + 7 jobs
  await expect(table.getByText('github.com/acme/alpha').first()).toBeVisible();
  await expect(table.getByText('github.com/acme/beta').first()).toBeVisible();
  await expect(table.getByText('last reported running')).toBeVisible();
  await expect(table.getByText('running (lease live)')).toBeVisible();
  await expect(table.getByText('needs human')).toBeVisible();
  await expect(page.getByText('1 running')).toBeVisible();
  await expect(page.getByText('1 stale')).toBeVisible();
  await expect(page.getByText('1 need human')).toBeVisible();
  // Per-reviewer verdicts and blocking counts are visible on the board.
  await expect(table.getByText('correctness: pending')).toBeVisible();
  await expect(table.getByText('CI failing')).toBeVisible();
  // Why a job stopped is on the board, and cancelled is never dressed as a success.
  await expect(table.getByText(/Approver escalated: a human must decide/)).toBeVisible();
  await expect(table.getByText(/decided against it/)).toBeVisible();
  await expect(table.getByText(/required check "test" failed twice/)).toBeVisible();
  await expect(table.locator('[data-state="cancelled"]')).toHaveText(/cancelled/);
  await expect(table.locator('[data-state="cancelled"]')).not.toHaveClass(/colorSuccess/);
  await expect(table.locator('[data-state="completed"]')).toHaveClass(/colorSuccess/);
  // Resume is offered for the stale (lapsed lease), failed (released), and unowned jobs only; the
  // blocked job's session still holds a live lease, so the board says so instead.
  await expect(table.getByRole('button', { name: /Copy resume command/ })).toHaveCount(3);
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
  await expect(page.getByText('CI failing')).toBeVisible();
  // Finished jobs have no live controls and nothing to resume.
  await expect(page.getByText('No actions: the job is completed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel job' })).toHaveCount(0);
  await expect(page.getByTestId('resume')).toHaveCount(0);
});

test('a stopped job explains itself and offers recovery, not approval', async ({ page }) => {
  const { ids } = state();
  await page.goto(`/#/jobs/${ids.failed}`);
  await expect(page.getByRole('heading', { name: 'Retry flaky uploads' })).toBeVisible();
  await expect(page.getByText('Stage failed.')).toBeVisible();
  await expect(page.getByText(/Recorded reason: required check "test" failed twice/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  const resume = page.getByTestId('resume');
  await expect(resume).toContainText(`/factory resume ${ids.failed}`);
  await expect(resume).toContainText('Copying does not resume anything');
  await expect(resume.getByRole('link', { name: 'Open checkout in VS Code' })).toHaveAttribute(
    'href',
    /^vscode:\/\/file\//,
  );
  // The approver's escalation is a real decision gate: Approve is the primary control there.
  await page.goto(`/#/jobs/${ids.blocked}`);
  await expect(page.getByText('Decision needed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve' })).toHaveClass(/MuiButton-contained/);
  // Its session holds a live lease, so no resume command is advertised; the holder is named.
  await expect(page.getByTestId('resume')).toHaveCount(0);
  await expect(page.getByTestId('resume-unavailable')).toContainText('claude-20261113-0800-1d2e');
});

test('dark mode toggles and persists across reload', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  // MUI's `data` color-scheme selector marks <html> with data-dark / data-light.
  await page.getByRole('button', { name: /Switch to dark mode/ }).click();
  await expect(html).toHaveAttribute('data-dark', '');
  await page.reload();
  await expect(html).toHaveAttribute('data-dark', '');
  await page.getByRole('button', { name: /Switch to light mode/ }).click();
  await expect(html).toHaveAttribute('data-light', '');
  await expect(html).not.toHaveAttribute('data-dark');
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

  // The human-blocked job can be approved back to its stage; the result says to resume.
  await page.goto(`/#/jobs/${ids.blocked}`);
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.getByLabel(/Reason/).fill('Deployment check done by hand');
  await page.getByRole('button', { name: 'Confirm' }).click();
  const status = page.getByRole('status');
  await expect(status).toContainText('No session is running it');
  await expect(status).toContainText(`orch factory resume ${ids.blocked}`);
  await expect(page.locator('[data-state="idle"]')).toBeVisible();
  await expect(page.getByText('Waiting for a session.')).toBeVisible();

  // Board reflects the change on refresh.
  await page.goto('/');
  await expect(page.getByText('0 need human')).toBeVisible();
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
