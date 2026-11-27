import type {
  BlockerKind,
  BoardRow,
  JobDetailView,
  Liveness,
  Verdict,
} from '../../src/server/types.ts';
import { statusColor } from './theme.ts';

export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${String(h)}h ${String(m % 60)}m`;
  return `${String(Math.floor(h / 24))}d`;
}

/** The board's Elapsed cell: `Unknown` for an unknown span, `<1s` rather than `0s` under a second. */
export function elapsedCell(ms: number | null): string {
  if (ms === null) return 'Unknown';
  return ms < 1000 ? '<1s' : elapsed(ms);
}

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const diff = now - Date.parse(iso);
  if (Number.isNaN(diff)) return iso;
  return diff < 5_000 ? 'just now' : `${elapsed(diff)} ago`;
}

export type ChipColor = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';

export interface StateStyle {
  label: string;
  color: ChipColor;
  variant: 'filled' | 'outlined';
  /** Decorative glyph so colour is never the only cue; the label carries the meaning. */
  glyph: string;
  /** What the state means when nothing else explains the job. */
  describe: string;
}

/** One presentation per execution state, shared by the board and the detail view. */
export const STATE: Record<Liveness, StateStyle> = {
  running: {
    label: 'running',
    color: statusColor.running,
    variant: 'filled',
    glyph: '●',
    describe:
      'Lease live: a session renewed its ownership lease recently and reports the job running. A renewed lease is not proof that a process is alive at this moment.',
  },
  stale: {
    label: 'stale',
    color: 'warning',
    variant: 'outlined',
    glyph: '◌',
    describe:
      'Last reported running: the status is still running, but the ownership lease lapsed without renewal. The session may no longer be working, or may only have missed a renewal.',
  },
  idle: {
    label: 'idle',
    color: 'default',
    variant: 'outlined',
    glyph: '○',
    describe: 'Pending: the owning session is between stages.',
  },
  interrupted: {
    label: 'interrupted',
    color: 'warning',
    variant: 'filled',
    glyph: '⏸',
    describe: 'Execution stopped before the stage finished.',
  },
  failed: {
    label: 'failed',
    color: statusColor.failed,
    variant: 'outlined',
    glyph: '✕',
    describe: 'The stage was marked failed.',
  },
  blocked: {
    label: 'needs human',
    color: statusColor.needsHuman,
    variant: 'filled',
    glyph: '⚠',
    describe: 'The workflow is waiting for a human decision.',
  },
  completed: {
    label: 'completed',
    color: statusColor.completed,
    variant: 'filled',
    glyph: '✓',
    describe:
      'The workflow finished. The label says how, when the record shows it; completed is not merged unless it says so.',
  },
  cancelled: {
    label: 'cancelled',
    color: 'default',
    variant: 'filled',
    glyph: '⊘',
    describe: 'The job was cancelled; nothing will resume it.',
  },
};

export const BLOCKER_LABEL: Record<BlockerKind, string> = {
  interrupted: 'Interrupted',
  failed: 'Stage failed',
  verification: 'Verification failed',
  findings: 'Blocking findings',
  decision: 'Decision needed',
  escalated: 'Escalated',
  ci: 'CI stopped',
  waiting: 'Waiting for a session',
  stopped: 'Stopped by the controller',
  cancelled: 'Cancelled',
};

export function verdictColor(v: string | null): ChipColor {
  if (v === 'pass') return 'success';
  if (v === 'changes') return 'warning';
  return 'default';
}

/** Board default order: what needs a human first, finished jobs last. */
const ATTENTION: Record<Liveness, number> = {
  blocked: 0,
  stale: 1,
  failed: 2,
  interrupted: 2,
  running: 3,
  idle: 4,
  completed: 5,
  cancelled: 5,
};

/** Attention group, then most recently updated first. */
export function byAttention(
  a: Pick<BoardRow, 'liveness' | 'updatedAt'>,
  b: Pick<BoardRow, 'liveness' | 'updatedAt'>,
): number {
  const d = ATTENTION[a.liveness] - ATTENTION[b.liveness];
  if (d) return d;
  return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
}

/** One chip for a round's reviews; null when the round has none. */
export function reviewRollup(reviews: Verdict[]): { label: string; color: ChipColor } | null {
  const n = reviews.length;
  if (!n) return null;
  const changes = reviews.filter((v) => v.verdict === 'changes').length;
  if (changes) return { label: `${String(changes)} changes`, color: 'warning' };
  const pass = reviews.filter((v) => v.verdict === 'pass').length;
  if (pass === n) return { label: `${String(n)}/${String(n)} pass`, color: 'success' };
  return { label: `${String(pass)}/${String(n)}, ${String(n - pass)} pending`, color: 'default' };
}

export function ciColor(v: string | null): ChipColor {
  switch (v) {
    case 'passing':
      return 'success';
    case 'failing':
      return 'error';
    case 'pending':
      return 'info';
    case 'none':
      return 'warning';
    default:
      return 'default';
  }
}

/** Short head for display; "?" when nothing was observed. */
export function sha7(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : '?';
}

/** Local date and time with the zone (a tooltip's absolute time); the input when it is no date. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { timeZoneName: 'short' });
}

/** One line for an event: its type, then its `eventDetail` when there is any. Never throws. */
export function eventSummary(e: JobDetailView['events'][number]): string {
  const detail = eventDetail(e);
  return detail ? `${e.type}: ${detail}` : e.type;
}

/**
 * The fields an event's type records (the same choices as the status mail's `describe`), without
 * the type; empty when there is nothing to say. Payloads are untyped JSON, so a missing or
 * wrong-typed field is left out; an unknown type lists its short scalar fields. Never throws.
 */
export function eventDetail(e: JobDetailView['events'][number]): string {
  const raw: unknown = e.payload;
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  /** A non-empty string or a number, on one line; anything else is absent. */
  const str = (key: string): string | null => {
    const v = p[key];
    if (typeof v === 'number') return String(v);
    return typeof v === 'string' && v.trim() !== '' ? v.trim().replace(/\s+/g, ' ') : null;
  };
  const with_ = (label: string, key: string) => {
    const v = str(key);
    return v === null ? null : `${label} ${v}`;
  };
  const at = () => (typeof p['head'] === 'string' && p['head'] ? `@${sha7(p['head'])}` : null);
  const join = (...xs: (string | null)[]) => xs.filter(Boolean).join(' ') || null;
  let parts: (string | null)[];
  switch (e.type) {
    case 'stage.started':
    case 'stage.completed':
    case 'stage.failed':
      parts = [str('stage'), with_('round', 'round'), str('reason')];
      break;
    case 'job.blocked':
    case 'job.resumed':
    case 'job.reworked':
    case 'job.cancelled':
    case 'job.interrupted':
      parts = [str('stage'), with_('from', 'from'), with_('to', 'to'), str('reason')];
      break;
    case 'ci.observed':
      parts = [join(str('outcome') ?? str('ciStatus'), at()), with_('poll', 'polls')];
      break;
    case 'verification.completed':
      parts = [with_('run', 'runId'), str('status')];
      break;
    case 'review.recorded': {
      const reviewer = str('reviewer');
      const verdict = str('verdict') ?? 'pending';
      parts = [with_('round', 'round'), reviewer === null ? verdict : `${reviewer}: ${verdict}`];
      break;
    }
    case 'artifact.registered':
    case 'artifact.replaced':
      parts = [str('path')];
      break;
    case 'pr.recorded':
    case 'pr.merged':
    case 'pr.observed': {
      const merge = p['ok'] === true ? 'merged' : p['ok'] === false ? 'merge refused' : null;
      parts = [join(str('state') ?? merge, at()), str('error')];
      break;
    }
    case 'branch.pushed':
      parts = [join(str('branch'), at())];
      break;
    case 'session.attached':
      // A UUID or a session link: the first eight characters of its last path segment.
      parts = [str('provider'), str('ref')?.split('/').pop()?.slice(0, 8) ?? null];
      break;
    case 'runner.session':
    case 'runner.stopped':
      parts = [str('outcome'), str('code'), with_('exit', 'exitCode'), str('reason')];
      break;
    default:
      parts = Object.entries(p).map(([k, v]) =>
        typeof v === 'boolean' || typeof v === 'number' || (typeof v === 'string' && v.length <= 60)
          ? `${k}=${String(v)}`
          : null,
      );
  }
  return parts.filter(Boolean).join(', ');
}

/**
 * Short labels for the distinct repository identities on the board: the basename, or the
 * shortest unique trailing path when basenames collide, else the full identity. Empty when
 * fewer than two repositories are present, since a label would add nothing.
 */
export function repoLabels(repos: readonly string[]): Map<string, string> {
  const ids = [...new Set(repos)];
  const labels = new Map<string, string>();
  if (ids.length < 2) return labels;
  const parts = ids.map((id) => id.split('/'));
  ids.forEach((id, i) => {
    const p = parts[i] ?? [];
    let label = id;
    for (let n = 1; n <= p.length; n++) {
      const tail = p.slice(-n).join('/');
      if (parts.every((q, j) => j === i || q.slice(-n).join('/') !== tail)) {
        label = tail;
        break;
      }
    }
    labels.set(id, label);
  });
  return labels;
}

/** The PR number when the URL ends in `/pull/<n>` (optional trailing slash), else undefined. */
export function prNumber(url: string | null): string | undefined {
  return url ? /\/pull\/(\d+)\/?$/.exec(url)?.[1] : undefined;
}

/** R2: `<links.repo>/commit/<sha>` for a hex SHA, else null (no base, or not a SHA). */
export function commitHref(repo: string | null, sha: string | null | undefined): string | null {
  return repo && sha && /^[0-9a-f]{7,40}$/.test(sha) ? `${repo}/commit/${sha}` : null;
}

/**
 * R3: the commits known to exist on the remote. (a) the CI head, every `branch.pushed` head, the
 * merged head and merged commits; (b) in each newest-first list, every entry from the first one
 * in (a) on; (c) the integration's base commit and a baseline policy head, when the base ref
 * came from `origin/`.
 */
export function knownCommits(d: JobDetailView): Set<string> {
  const wt = d.plan?.worktree ?? null;
  const a = new Set(
    [
      d.ci.head,
      ...d.links.pushedHeads,
      d.merge?.head,
      ...(d.merge?.commits ?? []).map((c) => c.sha),
    ].filter((s): s is string => typeof s === 'string'),
  );
  const known = new Set(a);
  for (const list of [wt?.commits ?? [], d.merge?.outstanding ?? []]) {
    const i = list.findIndex((c) => a.has(c.sha));
    if (i >= 0) for (const c of list.slice(i)) known.add(c.sha);
  }
  const integ = d.plan?.integration ?? null;
  if (integ?.baseRef.startsWith('origin/')) known.add(integ.baseSha);
  const policy = d.plan?.verification?.policy;
  if (policy?.source === 'baseline' && policy.head && wt?.baseRef?.startsWith('origin/')) {
    known.add(policy.head);
  }
  return known;
}

/** R8: GitHub's log URL is an href only over https. */
export function httpsHref(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * R6: split `text` at whole occurrences of the PR URL (`pr`), at most three. An occurrence counts
 * only when bounded: before it nothing, whitespace or `( [ " '`; after it nothing, whitespace or
 * `. , ; : ! ? ) ] " '`. Those characters stay in the text. No other URL is linked.
 */
export function prParts(text: string, pr: string | null): (string | { pr: string })[] {
  if (!pr) return [text];
  const parts: (string | { pr: string })[] = [];
  let last = 0;
  let links = 0;
  for (let i = text.indexOf(pr); i >= 0 && links < 3; i = text.indexOf(pr, i + 1)) {
    const before = text.charAt(i - 1);
    const after = text.charAt(i + pr.length);
    if (i < last) continue;
    if ((i === 0 || /[\s(["']/.test(before)) && (after === '' || /[\s.,;:!?)\]"']/.test(after))) {
      if (i > last) parts.push(text.slice(last, i));
      parts.push({ pr });
      last = i + pr.length;
      links++;
    }
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
