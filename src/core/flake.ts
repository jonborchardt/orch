/**
 * Likely flaky verification failures (decision 2026-11-18-flag-likely-flaky-verification-failures).
 * Pure: read failing Vitest tests from a check log, decide whether a failed run looks like a flake,
 * and the view shown for the newest flag. A flag is a label for a human, never a verdict: it never
 * changes a run's status, its validity, or a gate.
 */
import type { Event, Job } from '../storage/schema.ts';
import { TERMINAL_STATUSES } from './workflow.ts';

export const FLAKY_EVENT = 'verification.flaky';

export type FlakeRule = 'passed-on-rerun' | 'unchanged-file';

/** A failing test, or a whole file (`name: null`), as Vitest printed it. */
export interface FailedTest {
  file: string;
  name: string | null;
}

export interface Flake {
  runId: number;
  head: string;
  check: string;
  tests: FailedTest[];
  rule: FlakeRule;
  reason: string;
  at: string;
}

// OSC (`ESC ] ... BEL` or `ESC ] ... ESC \`), CSI, then every other control character except tab
// and newline, so a test name never carries terminal control into status output or mail.
/* eslint-disable no-control-regex */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
/* eslint-enable no-control-regex */

/** ` FAIL  <file> > <suite> > <test>` and ` FAIL  <file>` lines, de-duplicated, in log order. */
export function parseFailures(log: string): FailedTest[] {
  const out: FailedTest[] = [];
  const seen = new Set<string>();
  const clean = log.replace(/\r\n/g, '\n').replace(OSC, '').replace(CSI, '').replace(CONTROL, '');
  for (const line of clean.split('\n')) {
    // trim/startsWith, not a regex: a long run of spaces must not backtrack quadratically.
    const t = line.trim();
    if (!t.startsWith('FAIL') || !/^\s/.test(t.slice(4))) continue;
    let body = t.slice(4).trim();
    // A suite that failed to load prints ` FAIL  <file> [ <file> ]`.
    const open = body.endsWith(']') ? body.indexOf(' [') : -1;
    if (open > 0) body = body.slice(0, open).trimEnd();
    const [file = '', ...rest] = body.split(' > ');
    const name = rest.length > 0 ? rest.join(' > ') : null;
    const key = `${file}\0${name ?? ''}`;
    if (file === '' || seen.has(key)) continue;
    seen.add(key);
    out.push({ file, name });
  }
  return out;
}

/**
 * `file` under `cwd`, as a worktree-root-relative POSIX path; null when it is absolute or leaves
 * the worktree, which the caller must treat as "changed" (when unsure, no flag).
 */
export function normalisePath(cwd: string, file: string): string | null {
  const c = cwd.replace(/\\/g, '/');
  const f = file.replace(/\\/g, '/');
  if (/^([A-Za-z]:)?\//.test(c) || /^([A-Za-z]:)?\//.test(f)) return null;
  const parts: string[] = [];
  for (const seg of `${c}/${f}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') return null;
    parts.push(seg);
  }
  return parts.join('/');
}

/** Rule (b): at least one parsed test, and every test file is outside the job's changed files. */
export function unchangedFile(
  tests: readonly FailedTest[],
  cwd: string,
  changed: readonly string[],
): boolean {
  if (tests.length === 0) return false;
  const changedSet = new Set(changed.map((p) => normalisePath('.', p)));
  return tests.every((t) => {
    const p = normalisePath(cwd, t.file);
    return p !== null && !changedSet.has(p);
  });
}

interface RunRef {
  id: number;
  tree: string;
  status: string;
  configFingerprint: string;
}

/**
 * Rule (a): a failed run followed by a passing run at the same tree. Under another policy (a human
 * accepted the worktree's factory.json in between) the pass proves nothing about the failure.
 */
export function passedOnRerun(failed: RunRef, passed: RunRef): boolean {
  return (
    failed.status === 'failed' &&
    passed.status === 'passed' &&
    failed.id < passed.id &&
    failed.tree === passed.tree &&
    failed.configFingerprint === passed.configFingerprint
  );
}

/** One line naming the first test (or the check), the run, and the short head. */
export function flakeReason(
  run: { id: number; head: string },
  check: string,
  tests: readonly FailedTest[],
  why: string,
): string {
  const t = tests[0];
  const what = t ? (t.name ? `${t.file} > ${t.name}` : t.file) : `check ${check}`;
  const more = tests.length > 1 ? ` (and ${String(tests.length - 1)} more)` : '';
  return `${what}${more} failed in run ${String(run.id)} at ${run.head.slice(0, 7)}; ${why}`;
}

/** The flag to show: the newest `verification.flaky` event, while the job is not finished. */
export function flakeView(job: Pick<Job, 'status'>, e: Event | undefined): Flake | null {
  if (!e || TERMINAL_STATUSES.includes(job.status)) return null;
  const p = e.payload;
  const str = (k: string): string => (typeof p[k] === 'string' ? p[k] : '');
  return {
    runId: Number(p['runId']),
    head: str('head'),
    check: str('check'),
    // Capped: the views render only `reason`, which already counts the rest.
    tests: Array.isArray(p['tests']) ? (p['tests'] as FailedTest[]).slice(0, 5) : [],
    rule: p['rule'] === 'passed-on-rerun' ? 'passed-on-rerun' : 'unchanged-file',
    reason: str('reason'),
    at: e.createdAt,
  };
}
