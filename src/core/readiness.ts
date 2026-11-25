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
  /** One line per fact that is not met. */
  advice: string[];
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

/** A = all four facts true, B = three, C = two, D = one or none. */
export function gradeReadiness(facts: ReadinessFacts): ReadinessGrade {
  const met = FACTS.filter((f) => facts[f] === true).length;
  return {
    letter: met === 4 ? 'A' : met === 3 ? 'B' : met === 2 ? 'C' : 'D',
    met,
    facts,
    advice: FACTS.filter((f) => facts[f] !== true).map((f) =>
      facts[f] === null ? `${ADVICE[f]} (unknown: GitHub did not say)` : ADVICE[f],
    ),
  };
}

/** Whether a check looks like it runs tests: its id or an argument contains "test" or "check". */
export function runsTests(check: { id: string; args: readonly string[] }): boolean {
  return [check.id, ...check.args].some((s) => /test|check/i.test(s));
}
