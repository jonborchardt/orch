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

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** ` FAIL  <file> > <suite> > <test>` and ` FAIL  <file>` lines, de-duplicated, in log order. */
export function parseFailures(log: string): FailedTest[] {
  const out: FailedTest[] = [];
  const seen = new Set<string>();
  for (const line of log.replace(ANSI, '').split(/\r?\n/)) {
    const m = /^\s*FAIL\s+(.+?)\s*$/.exec(line);
    if (!m?.[1]) continue;
    // A suite that failed to load prints ` FAIL  <file> [ <file> ]`.
    const [file = '', ...rest] = m[1].replace(/\s+\[.*\]$/, '').split(' > ');
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
  const joined = `${cwd}/${file}`.replace(/\\/g, '/');
  const abs = (p: string) => /^([A-Za-z]:)?\//.test(p.replace(/\\/g, '/'));
  if (abs(cwd) || abs(file)) return null;
  const parts: string[] = [];
  for (const seg of joined.split('/')) {
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
    tests: Array.isArray(p['tests']) ? (p['tests'] as FailedTest[]) : [],
    rule: p['rule'] === 'passed-on-rerun' ? 'passed-on-rerun' : 'unchanged-file',
    reason: str('reason'),
    at: e.createdAt,
  };
}
