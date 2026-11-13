import { readFileSync } from 'node:fs';

import { expect, test } from '@playwright/test';

import type { SeededJobs } from '../tests/fixtures/dashboard.ts';
import { STATE_FILE } from './global-setup.ts';

const state = () => JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { ids: SeededJobs };

test('job board shows every repository and job with honest liveness', async ({ page }) => {
  await page.goto('/');
  const table = page.getByRole('table', { name: 'Factory jobs' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(7); // header + 6 jobs
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
  // Finished jobs have no live controls.
  await expect(page.getByRole('button', { name: 'Cancel job' })).toBeDisabled();
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
  await expect(page.getByText(/holds a live lease/)).toBeVisible();
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
  await expect(page.getByText('idle', { exact: true })).toBeVisible();

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
