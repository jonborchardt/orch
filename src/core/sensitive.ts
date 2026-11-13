/**
 * Which changed paths can alter how trustworthy the factory's evidence is. Pure classification
 * of a name-status list plus a scan of diff text for disabled tests; the Git calls that produce
 * both live in src/ops/. Nothing here blocks: it labels, and the gates decide.
 */
import type { PolicyDiff } from './verification.ts';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';
export type SensitiveKind = 'policy' | 'ci' | 'test-config' | 'deps' | 'tests';

export interface ChangedPath {
  path: string;
  status: ChangeStatus;
}

export interface SensitiveChange extends ChangedPath {
  kind: SensitiveKind;
  why: string;
}

const RULES: { kind: SensitiveKind; why: string; test: RegExp }[] = [
  { kind: 'policy', why: "the factory's own verification policy", test: /^factory\.json$/ },
  {
    kind: 'ci',
    why: 'CI configuration decides which checks run before merge',
    test: /^(\.github\/workflows\/|\.gitlab-ci\.yml$|\.circleci\/|azure-pipelines|Jenkinsfile$|\.pre-commit-config\.ya?ml$|bitbucket-pipelines\.yml$)/,
  },
  {
    kind: 'test-config',
    why: 'test, lint, or type-check configuration shapes what the checks see',
    test: /(^|\/)((vitest|jest|playwright|eslint|karma|cypress|mocha|ava|babel|prettier)\.config\.[^/]+|tsconfig[^/]*\.json|pytest\.ini|tox\.ini|noxfile\.py|setup\.cfg|conftest\.py|\.mocharc[^/]*|\.eslintrc[^/]*|\.flake8|mypy\.ini|Makefile|justfile)$/,
  },
  {
    kind: 'deps',
    why: 'dependency and script manifests change what the checks execute',
    test: /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|pyproject\.toml|requirements[^/]*\.txt|Pipfile(\.lock)?|poetry\.lock|go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile(\.lock)?)$/,
  },
  {
    kind: 'tests',
    why: 'application tests are the evidence reviewers rely on',
    test: /(\.(test|spec)\.[^/]+$|(^|\/)(tests?|__tests__|spec|e2e)\/|(^|\/)test_[^/]*\.py$|_test\.(py|go|rs)$|_spec\.rb$)/,
  },
];

export function classifyPath(path: string): { kind: SensitiveKind; why: string } | undefined {
  const p = path.split('\\').join('/');
  return RULES.find((r) => r.test.test(p));
}

export function classifyChanges(changes: readonly ChangedPath[]): SensitiveChange[] {
  const out: SensitiveChange[] = [];
  for (const c of changes) {
    const hit = classifyPath(c.path);
    if (hit) out.push({ ...c, kind: hit.kind, why: hit.why });
  }
  return out;
}

export interface DisabledTest {
  path: string;
  line: string;
}

const SKIP = [
  /\b(it|test|describe|context|suite)\.(skip|todo)\s*\(/,
  /\bx(it|test|describe|context)\s*\(/,
  /\b(it|test|describe)\.only\s*\(/,
  /\b(fit|fdescribe)\s*\(/,
  /@pytest\.mark\.(skip|skipif|xfail)/,
  /@unittest\.skip/,
  /\bpytest\.skip\s*\(/,
  /\bt\.Skip(f|Now)?\s*\(/,
  /#\[ignore\]/,
  /^\s*(\/\/|#)\s*(it|test|describe)\s*\(/,
];
const TEST_DEF = /^\s*(it|test|describe)\s*\(|^\s*def test_|^\s*func Test[A-Z]|#\[test\]/;

export interface DiffScan {
  /** Added lines that skip, focus, or comment out a test. */
  disabled: DisabledTest[];
  /** Files where more test definitions were removed than added. */
  removedTests: { path: string; removed: number; added: number }[];
}

/** Scan a unified diff (`git diff` text) of test files for disabled or removed tests. */
export function scanDiff(diff: string): DiffScan {
  const disabled: DisabledTest[] = [];
  const counts = new Map<string, { removed: number; added: number }>();
  let path = '';
  for (const raw of diff.split(/\r?\n/)) {
    const header = /^\+\+\+ b\/(.+)$/.exec(raw);
    if (header) {
      path = header[1] ?? '';
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---') || !path) continue;
    if (raw.startsWith('+')) {
      const line = raw.slice(1);
      if (SKIP.some((re) => re.test(line))) disabled.push({ path, line: line.trim() });
      if (TEST_DEF.test(line)) bump(counts, path, 'added');
    } else if (raw.startsWith('-') && TEST_DEF.test(raw.slice(1))) {
      bump(counts, path, 'removed');
    }
  }
  const removedTests = [...counts]
    .filter(([, n]) => n.removed > n.added)
    .map(([p, n]) => ({ path: p, ...n }));
  return { disabled, removedTests };
}

function bump(
  m: Map<string, { removed: number; added: number }>,
  p: string,
  k: 'removed' | 'added',
) {
  const n = m.get(p) ?? { removed: 0, added: 0 };
  n[k] += 1;
  m.set(p, n);
}

export type Authorization = 'not-needed' | 'required' | 'authorized';

export interface SensitiveReport {
  changes: SensitiveChange[];
  scan: DiffScan;
  /** Effective policy versus the worktree's factory.json at HEAD; null when identical. */
  policy: PolicyDiff | null;
  /** Whether the policy change has been accepted by a human. */
  authorization: Authorization;
  /** True when a reviewer must look: anything beyond plainly added tests. */
  needsReview: boolean;
}

export function buildReport(
  changes: readonly ChangedPath[],
  scan: DiffScan,
  policy: PolicyDiff | null,
  authorized: boolean,
): SensitiveReport {
  const classified = classifyChanges(changes);
  const authorization: Authorization = policy?.changed
    ? 'required'
    : authorized
      ? 'authorized'
      : 'not-needed';
  const onlyNewTests = classified.every((c) => c.kind === 'tests' && c.status === 'added');
  const needsReview =
    (classified.length > 0 && !onlyNewTests) ||
    scan.disabled.length > 0 ||
    scan.removedTests.length > 0 ||
    authorization === 'required';
  return { changes: classified, scan, policy, authorization, needsReview };
}

/** The lines a consolidated review or PR body must carry when a report is not empty. */
export function sensitiveSummary(report: SensitiveReport): string[] {
  const lines = report.changes.map((c) => `${c.path} (${c.status}; ${c.kind}: ${c.why})`);
  for (const d of report.scan.disabled) lines.push(`${d.path}: disabled/focused test: ${d.line}`);
  for (const r of report.scan.removedTests) {
    lines.push(
      `${r.path}: ${String(r.removed)} test definition(s) removed, ${String(r.added)} added`,
    );
  }
  if (report.policy?.changed) {
    const p = report.policy;
    lines.push(
      `verification policy changed (added: ${p.added.join(', ') || 'none'}; removed: ${p.removed.join(', ') || 'none'}; ` +
        `modified: ${p.modified.join(', ') || 'none'}; weakened: ${p.weakened.join(', ') || 'none'}); ` +
        `human authorization ${report.authorization === 'authorized' ? 'recorded' : 'REQUIRED'}`,
    );
  }
  return lines;
}
