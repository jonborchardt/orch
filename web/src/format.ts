import type { BlockerKind, Liveness } from '../../src/server/types.ts';

export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${String(h)}h ${String(m % 60)}m`;
  return `${String(Math.floor(h / 24))}d`;
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
    label: 'running (lease live)',
    color: 'primary',
    variant: 'filled',
    glyph: '●',
    describe: 'A session renewed its lease recently and reports the job running.',
  },
  stale: {
    label: 'last reported running',
    color: 'warning',
    variant: 'outlined',
    glyph: '◌',
    describe: 'The status is still running but the lease lapsed; the session is presumed gone.',
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
    describe: 'The workflow finished: a draft PR was recorded.',
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
  waiting: 'Waiting for a session',
  cancelled: 'Cancelled',
};

export function verdictColor(v: string | null): ChipColor {
  if (v === 'pass') return 'success';
  if (v === 'changes') return 'warning';
  return 'default';
}

export function ciColor(v: string | null): ChipColor {
  switch (v) {
    case 'passing':
      return 'success';
    case 'failing':
      return 'error';
    case 'pending':
      return 'warning';
    default:
      return 'default';
  }
}
