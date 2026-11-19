import type { BlockerKind, BoardRow, Liveness, Verdict } from '../../src/server/types.ts';

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
    color: 'primary',
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
    color: 'error',
    variant: 'outlined',
    glyph: '✕',
    describe: 'The stage was marked failed.',
  },
  blocked: {
    label: 'needs human',
    color: 'error',
    variant: 'filled',
    glyph: '⚠',
    describe: 'The workflow is waiting for a human decision.',
  },
  completed: {
    label: 'completed',
    color: 'success',
    variant: 'filled',
    glyph: '✓',
    describe: 'The workflow finished: a draft PR was delivered with its required checks passing.',
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
