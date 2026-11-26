/**
 * The end-of-session report of `orch start | do | resume`: the one text a person reads after an
 * unattended run, printed by the CLI and mailed as is (`reportRunMail`). Pure formatting of a
 * `RunSummary`: what merged, what needs you, what was passed over, and what it cost.
 */
import { ticketKey } from '../core/tickets.ts';
import { choiceLine } from './actions.ts';
import type { MergedTicket, RunSummary } from './run.ts';
import type { TokenCounts } from '../server/types.ts';

const NEEDS_YOU = ['needs-human', 'blocked', 'refused'];
const needsYou = (s: RunSummary) => s.tickets.filter((t) => NEEDS_YOU.includes(t.outcome));

const duration = (s: number) => `${String(Math.floor(s / 60))} min ${String(s % 60)} s`;

function tokens(t: TokenCounts | null): string {
  if (t === null) return 'tokens not recorded';
  const sum = t.input + t.output + t.cacheRead + t.cacheCreation;
  return (
    `${String(sum)} tokens (input ${String(t.input)}, output ${String(t.output)}, ` +
    `cache read ${String(t.cacheRead)}, cache creation ${String(t.cacheCreation)})`
  );
}

function merged(m: MergedTicket): string[] {
  const head = m.head === null ? 'head unknown' : `head ${m.head.slice(0, 12)}`;
  const commit = m.mergeCommit === null ? '' : `, merge commit ${m.mergeCommit.slice(0, 12)}`;
  const time = m.seconds === null ? 'time not recorded' : duration(m.seconds);
  return [
    `${ticketKey(m.ticketId)} ${m.title}`,
    `     job ${m.jobId}, ${head}${commit}`,
    `     receipt: ${m.prUrl ?? 'no PR recorded'}`,
    `     cost of job ${m.jobId} only: ${time}, ${tokens(m.tokens)}`,
  ];
}

export function formatSummary(s: RunSummary): string {
  const lines = [
    '',
    `Session ended: ${s.reason}`,
    `tickets   ${String(s.attempted)} attempted, ${String(s.completed)} verified and completed, ` +
      `${String(s.blocked)} blocked`,
    `re-lands  ${String(s.relands)}`,
    `elapsed   ${duration(s.elapsedSeconds)}`,
    '',
    `Merged (${String(s.merged.length)})`,
  ];
  lines.push(...(s.merged.length === 0 ? ['none'] : s.merged.flatMap(merged)));
  const needs = needsYou(s);
  lines.push('', `Needs you (${String(needs.length)})`);
  if (needs.length === 0) lines.push('none');
  for (const t of needs) {
    // A job still waiting in needs-human leads with what is needed and a link per choice.
    const w =
      t.outcome === 'needs-human'
        ? s.waiting.find((x) => x.ticketId === t.ticketId && x.jobId === t.jobId)
        : undefined;
    if (w === undefined) lines.push(`${ticketKey(t.ticketId)} ${t.outcome}: ${t.reason}`);
    else {
      lines.push(`${ticketKey(t.ticketId)} needs-human: ${w.needed}`);
      lines.push(...w.choices.map((c) => `     ${choiceLine(c)}`));
      lines.push(`     reason: ${t.reason}`);
    }
    if (t.next !== null) lines.push(`     next: ${t.next}`);
  }
  const other = s.tickets.filter((t) => t.outcome !== 'done' && !NEEDS_YOU.includes(t.outcome));
  if (other.length + s.skipped.length > 0) lines.push('', 'Passed over');
  for (const t of other) lines.push(`${ticketKey(t.ticketId)} ${t.outcome}: ${t.reason}`);
  for (const k of s.skipped) lines.push(`${ticketKey(k.ticketId)} passed over: ${k.reason}`);
  return lines.join('\n');
}

/** The session mail's subject; `sendReport` puts the configured prefix in front. */
export function runSubject(s: RunSummary): string {
  return `session ended: ${String(s.merged.length)} merged, ${String(needsYou(s).length)} need you`;
}
