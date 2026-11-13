import type { Liveness } from '../../src/server/types.ts';

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

export const LIVENESS_LABEL: Record<Liveness, string> = {
  running: 'running (lease live)',
  stale: 'last reported running',
  idle: 'idle',
  blocked: 'needs human',
  finished: 'finished',
};

export type ChipColor = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';

export const LIVENESS_COLOR: Record<Liveness, ChipColor> = {
  running: 'primary',
  stale: 'warning',
  idle: 'default',
  blocked: 'error',
  finished: 'success',
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
