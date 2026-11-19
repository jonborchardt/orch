/** Human vs JSON rendering. Handlers return plain data; this decides how it is printed. */
import { OrchError } from '../core/errors.ts';
import { flakeLabel } from '../core/flake.ts';
import type { FactoryRow } from '../ops/dispatch.ts';
import type { Plan, Step } from '../ops/factory.ts';

export function print(data: unknown, json: boolean): void {
  console.log(json ? JSON.stringify(data, null, 2) : human(data));
}

export function printError(err: unknown, json: boolean): number {
  const code = err instanceof OrchError ? err.exitCode : 1;
  const message = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : 'Error';
  console.error(
    json
      ? JSON.stringify({ error: { type: name, message, exitCode: code } })
      : `${name}: ${message}`,
  );
  return code;
}

/** Key/value lines; arrays of objects become one line per item; nested objects indent. */
export function human(data: unknown, indent = ''): string {
  if (Array.isArray(data)) {
    if (data.length === 0) return `${indent}(none)`;
    return data.map((item) => human(item, indent)).join(data.some(isObject) ? '\n\n' : '\n');
  }
  if (isObject(data)) {
    const width = Math.max(...Object.keys(data).map((k) => k.length));
    return Object.entries(data)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => {
        if (isObject(v) || (Array.isArray(v) && v.some(isObject))) {
          return `${indent}${k}:\n${human(v, indent + '  ')}`;
        }
        const val = Array.isArray(v) ? (v.length ? v.join(', ') : '(none)') : String(v);
        return `${indent}${k.padEnd(width)}  ${val}`;
      })
      .join('\n');
  }
  return `${indent}${String(data)}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Column header and width cap, in display order. ID is never cut: it is what the user copies. */
const FACTORY_COLUMNS: readonly [string, number][] = [
  ['ID', Infinity],
  ['REPO', 16],
  ['STAGE', 12],
  ['STATUS', 12],
  ['ACTION', 6],
  ['PR', 8],
  ['UPDATED', 10],
  ['TITLE', 50],
];

/** `orch factory list` text: a header and one row per job; `--json` keeps the full rows. */
export function formatFactoryList(rows: FactoryRow[], now: Date): string {
  if (rows.length === 0) return '(none)';
  const cells = rows.map((r) =>
    [
      r.id,
      r.repo.split('/').pop() ?? r.repo,
      r.stage,
      r.status,
      factoryAction(r),
      prNumber(r.pr.url),
      age(r.updatedAt, now),
      r.title,
    ].map((c, i) => truncate(c, FACTORY_COLUMNS[i]?.[1] ?? Infinity)),
  );
  const table = [FACTORY_COLUMNS.map(([h]) => h), ...cells];
  const widths = FACTORY_COLUMNS.map((_, i) =>
    Math.max(...table.map((row) => row[i]?.length ?? 0)),
  );
  return table
    .map((row) =>
      row
        .map((c, i) => c.padEnd(widths[i] ?? 0))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const NEXT_LABEL: Record<Step, string> = {
  resume: 'Resume the job',
  'create-worktree': 'Create the worktree',
  'run-stage': 'Run the stage',
  'needs-human': 'A human decides',
  done: 'Nothing; the job is done',
  cancelled: 'Nothing; the job was cancelled',
};

/**
 * `orch factory next|status` text: where the job is, what blocks it, what happens next, and the
 * commands to run. Reads only `Plan` fields; `--json` keeps the full plan.
 */
export function formatPlan(plan: Plan): string {
  const lines = (rows: [string, string][]): string[] => {
    const width = Math.max(...rows.map(([k]) => k.length)) + 1;
    return rows.map(([k, v]) => `${`${k}:`.padEnd(width)}  ${v}`);
  };
  const round = plan.round > 0 ? ` (round ${String(plan.round)} of ${String(plan.maxRounds)})` : '';
  const pr = prNumber(plan.pr.url);
  // A merged PR is the headline; the checks it was merged with are in the reason.
  const ci =
    pr === '-'
      ? ''
      : plan.pr.state === 'merged'
        ? ' (merged)'
        : plan.pr.ciStatus
          ? ` (CI ${plan.pr.ciStatus})`
          : '';
  const next: [string, string][] = [
    ['Next', NEXT_LABEL[plan.step]],
    ['Reason', plan.reason],
  ];
  if (plan.blockedReason) next.push(['Blocked', plan.blockedReason]);
  if (plan.flake) next.push(['Flaky', flakeLabel(plan.flake)]);
  const out = [
    ...lines([
      ['Job', plan.jobId],
      ['Title', plan.title],
      ['Repo', plan.repo.identity.split('/').pop() ?? plan.repo.identity],
      ['Stage', plan.stage + round],
      ['Status', plan.status],
      ['PR', pr + ci],
    ]),
    '',
    ...lines(next),
  ];
  if (plan.agents.length) {
    out.push('', 'Agents:');
    for (const a of plan.agents)
      out.push(`  ${a.role}  ${a.agent}  (${a.model})  -> ${a.artifact}`);
  }
  out.push('', 'Commands:');
  if (plan.commands.length === 0) out.push('  (none)');
  plan.commands.forEach((c, i) => out.push(`  ${String(i + 1)}. ${c}`));
  out.push('', `Details: orch factory status ${plan.jobId} --json`);
  return out.join('\n');
}

function factoryAction(r: FactoryRow): string {
  if (r.needsHuman) return 'human';
  if (r.status === 'completed' || r.status === 'cancelled') return 'none';
  return r.resume === null ? 'wait' : 'resume';
}

function prNumber(url: string | null): string {
  const n = /\/pull\/(\d+)/.exec(url ?? '')?.[1];
  return n === undefined ? '-' : `#${n}`;
}

function truncate(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap - 3)}...`;
}

function age(iso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 60) return `${String(s)}s ago`;
  if (s < 3600) return `${String(Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${String(Math.floor(s / 3600))}h ago`;
  return `${String(Math.floor(s / 86400))}d ago`;
}
