import type { JobDetailView, RoundView } from '../../src/server/types.ts';

/** The job detail's sections, in display order. Ids and panels are keyed by these names. */
export const TABS = [
  'Overview',
  'Spec',
  'Build',
  'Reviews',
  'Findings',
  'Decision',
  'Artifacts',
  'Events',
  'Session',
  'Git',
  'Verification',
  'PR',
] as const;
export type TabName = (typeof TABS)[number];

export interface DetailTab {
  name: TabName;
  /** Visible text and accessible name: the name, plus a count or the `(empty)` cue. */
  label: string;
  /** One meaning per tab (see docs/dashboard.md); null when the tab has no count. */
  count: number | null;
  /** The tab has nothing to show yet (reachable or not). */
  empty: boolean;
  /** Why the tab cannot be opened yet; null when it can. */
  unavailable: string | null;
}

/** The highest-numbered round with a consolidated review, as the board and Escalation read it. */
export function newestConsolidated(detail: JobDetailView): RoundView | undefined {
  return detail.rounds.filter((r) => r.consolidated !== null).at(-1);
}

/**
 * Each tab's label, count, empty flag, and unavailable reason, in `TABS` order. Deep links (todo
 * 0007) must go through this and `resolveTab`, never a rule of their own.
 */
export function detailTabs(detail: JobDetailView): DetailTab[] {
  const has = (path: string) => detail.artifacts.some((a) => a.path === path);
  const plain = (name: TabName, empty: boolean, unavailable: string | null = null): DetailTab => ({
    name,
    label: !unavailable && empty ? `${name} (empty)` : name,
    count: null,
    empty,
    unavailable: empty ? unavailable : null,
  });
  const counted = (
    name: TabName,
    count: number,
    shown = String(count),
    empty = count === 0,
  ): DetailTab => ({ name, label: `${name} (${shown})`, count, empty, unavailable: null });
  const rounds = detail.rounds.length;
  const latest = newestConsolidated(detail);
  const events = detail.events.length;
  return [
    plain('Overview', false),
    plain('Spec', !has('spec.md'), 'Spec needs spec.md (spec stage).'),
    plain('Build', !has('build.md'), 'Build needs build.md (build stage).'),
    counted('Reviews', rounds, `${String(rounds)} round${rounds === 1 ? '' : 's'}`),
    // The newest consolidated round's validated BLOCKING marker; 0 blocking is content, not empty.
    !latest
      ? plain('Findings', true)
      : latest.blocking === null
        ? plain('Findings', false)
        : counted('Findings', latest.blocking, `${String(latest.blocking)} blocking`, false),
    plain('Decision', !has('decision.md'), 'Decision needs decision.md (approve stage).'),
    counted('Artifacts', detail.artifacts.length),
    counted('Events', events, detail.timeline.truncated ? `${String(events)}+` : String(events)),
    // Empty without a claude-code session, but reachable: its panel says how to attach one.
    plain('Session', detail.claudeSessions.length === 0),
    plain('Git', !detail.plan?.worktree && !detail.merge),
    plain('Verification', !detail.plan?.verification),
    plain('PR', !detail.job.prUrl && !has('pr.md'), 'PR needs an opened PR or pr.md (pr stage).'),
  ];
}

/** `wanted` when that tab can be opened for this detail, otherwise the Overview fallback. */
export function resolveTab(detail: JobDetailView, wanted: TabName): TabName {
  return detailTabs(detail).find((t) => t.name === wanted)?.unavailable ? 'Overview' : wanted;
}
