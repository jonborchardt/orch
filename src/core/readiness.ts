/**
 * Repository readiness grade: how much of a safe unattended merge the repository itself enforces,
 * from four facts orch can read. Advice only: nothing decides, gates, or exits on it (decision
 * 2026-11-25-readiness-grade-is-advice).
 */

/** Each fact is true, false, or null when orch could not find out (GitHub not asked or no answer). */
export interface ReadinessFacts {
  /** The trusted verification policy is ready and has a required check that runs tests. */
  policyTest: boolean | null;
  /** GitHub requires at least one status check on the base branch. */
  requiredChecks: boolean | null;
  /** GitHub requires branches to be up to date before merging, or a merge queue applies. */
  upToDate: boolean | null;
  /** The base branch is protected, or a ruleset applies to it. */
  protection: boolean | null;
}

export type ReadinessFact = keyof ReadinessFacts;

export interface ReadinessGrade {
  letter: 'A' | 'B' | 'C' | 'D';
  /** Facts that are true, out of four. */
  met: number;
  facts: ReadinessFacts;
  /** One line per fact that is not met, then one for uncovered executables. */
  advice: string[];
  /** Check executables the repository's agent sessions may not run; non-empty caps the grade at B. */
  uncovered: string[];
}

/**
 * Check executables agents may not run (`uncoveredExecutables`), with what to add where: the
 * repository identity the rule is keyed by and the user's config file.
 */
export interface PermissionGap {
  uncovered: string[];
  repo: string;
  file: string;
}

const ADVICE: Record<ReadinessFact, string> = {
  policyTest:
    'Commit a factory.json with a required check whose id or arguments contain "test" or "check" (orch init --command "test=npm test").',
  requiredChecks:
    'Require at least one status check on the base branch (branch protection or a ruleset).',
  upToDate:
    'Require branches to be up to date before merging, or enable a merge queue, on the base branch.',
  protection: 'Protect the base branch with branch protection or a ruleset.',
};

const FACTS = Object.keys(ADVICE) as ReadinessFact[];

function gapAdvice(gap: PermissionGap): string {
  const setting = JSON.stringify({
    repoAllowedTools: { [gap.repo]: gap.uncovered.map((e) => `Bash(${e} *)`) },
  });
  return `Agent sessions may not run ${gap.uncovered.join(', ')}, which the checks run: add ${setting} to ${gap.file} (or the rules to "extraAllowedTools" for every repository).`;
}

/**
 * A = all four facts true, B = three, C = two, D = one or none. A permission gap (check
 * executables agents may not run) caps A at B and adds one advice line; `met` is unchanged.
 */
export function gradeReadiness(facts: ReadinessFacts, gap?: PermissionGap): ReadinessGrade {
  const met = FACTS.filter((f) => facts[f] === true).length;
  const uncovered = gap?.uncovered ?? [];
  const advice = FACTS.filter((f) => facts[f] !== true).map((f) =>
    facts[f] === null ? `${ADVICE[f]} (unknown: GitHub did not say)` : ADVICE[f],
  );
  if (gap && uncovered.length > 0) advice.push(gapAdvice(gap));
  return {
    letter: met === 4 && uncovered.length === 0 ? 'A' : met >= 3 ? 'B' : met === 2 ? 'C' : 'D',
    met,
    facts,
    advice,
    uncovered,
  };
}

/** Whether a check looks like it runs tests: its id or an argument contains "test" or "check". */
export function runsTests(check: { id: string; args: readonly string[] }): boolean {
  return [check.id, ...check.args].some((s) => /test|check/i.test(s));
}
