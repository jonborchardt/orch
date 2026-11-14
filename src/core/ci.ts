/**
 * CI verdicts: pure rules that turn GitHub's check runs and commit statuses for one commit into
 * a workflow outcome. No I/O; `src/ops/github.ts` fetches the inputs and records the result.
 */
import type { CiStatus } from './workflow.ts';

export interface CiCheck {
  /** GitHub check-run id; null for a commit status. A re-run creates a new id for the same name. */
  id: number | null;
  /**
   * Check suite (one per workflow run) the run belongs to; null for a commit status or when GitHub
   * did not say. Same suite and name means another attempt of the same check, not another check.
   */
  suiteId: number | null;
  name: string;
  /** `queued`, `in_progress`, `completed`, or the commit-status `pending`. */
  status: string;
  /** success, failure, neutral, cancelled, skipped, timed_out, action_required, stale, startup_failure, error, or ''. */
  conclusion: string;
  url: string | null;
  /** GitHub Actions job id (equal to the check-run id) when the check is an Actions job. */
  jobId: number | null;
}

export type CiOutcome = 'passing' | 'pending' | 'failing' | 'infrastructure' | 'none';

export interface CiEvaluation {
  outcome: CiOutcome;
  /** Check names the verdict rests on. */
  required: string[];
  /** True when `required` came from the base branch's protection or rulesets. */
  configured: boolean;
  /** Required checks that concluded with a defect a builder can act on. */
  failed: CiCheck[];
  /** Required checks that did not run to a verdict (cancelled, startup failure, stale, ...). */
  infrastructure: CiCheck[];
  /** Required checks queued or in progress. */
  pending: string[];
  /** Required checks GitHub has not reported for this commit at all. */
  missing: string[];
  optionalFailed: string[];
  reason: string;
}

/**
 * Observations of the same commit with no checks reported before "nothing reported" becomes a
 * verdict instead of a wait: workflows take a moment to register their check runs after a push.
 */
export const CI_GRACE_POLLS = 5;

/**
 * Re-runs `orch gh ci` may request per PR head before a failure is treated as a defect (rework)
 * or escalated. One: a required check must fail twice for the same commit before the builder is
 * engaged, so a flaky or infrastructure failure costs a CI cycle, not a repair cycle.
 */
export const CI_MAX_RERUNS = 1;

/** Conclusions a re-run of the failed jobs can change. `action_required` and `neutral` cannot. */
export const RERUNNABLE = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'startup_failure',
  'stale',
]);

/** Pending observations of one head in one session before the coordinator releases the job. */
export const CI_MAX_SESSION_POLLS = 20;

/**
 * Seconds to wait before observing a pending head again: a minute for the first five
 * observations (checks register and start quickly), then longer, never more than five minutes.
 */
export function waitSeconds(polls: number): number {
  return Math.min(60 * Math.ceil(Math.max(polls, 1) / 5), 300);
}

const OK = new Set(['success', 'neutral', 'skipped']);
const DEFECT = new Set(['failure', 'timed_out']);
const RAN = new Set(['success', 'failure']);

type Conclusion = 'ok' | 'defect' | 'infrastructure' | 'pending';

function conclusionOf(c: CiCheck): Conclusion {
  if (c.status.toLowerCase() !== 'completed') return 'pending';
  const k = c.conclusion.toLowerCase();
  if (OK.has(k)) return 'ok';
  if (DEFECT.has(k)) return 'defect';
  return 'infrastructure';
}

/** When independent runs share a name (two workflows posting the same check), the worst one counts. */
const SEVERITY: Record<Conclusion, number> = { defect: 3, pending: 2, infrastructure: 1, ok: 0 };

/**
 * Drop superseded attempts: runs with the same name in the same check suite are attempts of one
 * check (a re-run creates a new, higher id in the same suite), and only the newest is GitHub's
 * current verdict. Runs whose suite is unknown are never collapsed, so an ambiguous duplicate
 * still counts at its worst.
 */
function currentAttempts(checks: CiCheck[]): CiCheck[] {
  const newest = new Map<string, CiCheck>();
  const rest: CiCheck[] = [];
  for (const c of checks) {
    if (c.suiteId === null || c.id === null) {
      rest.push(c);
      continue;
    }
    const key = `${String(c.suiteId)}:${c.name}`; // ids are digits: the first colon splits
    const seen = newest.get(key);
    if (!seen || (seen.id ?? 0) < c.id) newest.set(key, c);
  }
  return [...newest.values(), ...rest];
}

/**
 * Decide the CI outcome for one commit. `configured` is the base branch's required-check list
 * (null when GitHub could not tell us); without one every reported check is treated as required
 * and the commit only passes when at least one check actually ran and succeeded. `polls` counts
 * earlier observations of this commit, for the grace window on checks not yet reported.
 */
export function evaluateChecks(
  checks: CiCheck[],
  configured: string[] | null,
  polls: number,
): CiEvaluation {
  const isConfigured = configured !== null && configured.length > 0;
  const required = isConfigured
    ? [...new Set(configured)]
    : [...new Set(checks.map((c) => c.name))];
  const requiredSet = new Set(required);
  checks = currentAttempts(checks);
  const byName = new Map<string, CiCheck>();
  for (const c of checks) {
    const seen = byName.get(c.name);
    if (!seen || SEVERITY[conclusionOf(c)] > SEVERITY[conclusionOf(seen)]) byName.set(c.name, c);
  }
  const failed: CiCheck[] = [];
  const infrastructure: CiCheck[] = [];
  const pending: string[] = [];
  const missing: string[] = [];
  for (const name of required) {
    const c = byName.get(name);
    if (!c) {
      missing.push(name);
      continue;
    }
    switch (conclusionOf(c)) {
      case 'ok':
        break;
      case 'defect':
        failed.push(c);
        break;
      case 'infrastructure':
        infrastructure.push(c);
        break;
      case 'pending':
        pending.push(name);
        break;
    }
  }
  const optionalFailed = checks
    .filter(
      (c) => !requiredSet.has(c.name) && conclusionOf(c) !== 'ok' && conclusionOf(c) !== 'pending',
    )
    .map((c) => c.name);
  const base = {
    required,
    configured: isConfigured,
    failed,
    infrastructure,
    pending,
    missing,
    optionalFailed,
  };
  const names = (list: { name: string }[]) => list.map((c) => c.name).join(', ');
  const grace = polls < CI_GRACE_POLLS;

  if (failed.length > 0) {
    return {
      ...base,
      outcome: 'failing',
      reason: `required check(s) failed for this commit: ${names(failed)}`,
    };
  }
  if (required.length === 0) {
    return grace
      ? { ...base, outcome: 'pending', reason: 'no checks reported for this commit yet' }
      : {
          ...base,
          outcome: 'none',
          reason: `GitHub reports no checks for this commit after ${String(polls)} observations`,
        };
  }
  if (pending.length > 0 || (missing.length > 0 && grace)) {
    const waiting = [...pending, ...missing];
    return { ...base, outcome: 'pending', reason: `waiting for: ${waiting.join(', ')}` };
  }
  if (infrastructure.length > 0 || missing.length > 0) {
    const parts = [
      infrastructure.length ? `did not reach a verdict: ${names(infrastructure)}` : '',
      missing.length ? `never reported: ${missing.join(', ')}` : '',
    ].filter(Boolean);
    return { ...base, outcome: 'infrastructure', reason: `required check(s) ${parts.join('; ')}` };
  }
  // Skipped-only runs verified nothing, even when a human made the checks required (GitHub's merge
  // button would count them): the factory escalates and a human may close out explicitly.
  if (!checks.some((c) => RAN.has(c.conclusion.toLowerCase()))) {
    return grace
      ? { ...base, outcome: 'pending', reason: 'every reported check was skipped so far' }
      : { ...base, outcome: 'none', reason: 'every check reported for this commit was skipped' };
  }
  return {
    ...base,
    outcome: 'passing',
    reason: `required check(s) passed: ${required.join(', ')}`,
  };
}

/** The persisted rollup for an outcome. */
export function ciStatusOf(outcome: CiOutcome): CiStatus {
  switch (outcome) {
    case 'passing':
      return 'passing';
    case 'pending':
      return 'pending';
    case 'none':
      return 'none';
    default:
      return 'failing';
  }
}
