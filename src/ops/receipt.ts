/**
 * A job's merge receipt: one human-readable summary of the evidence orch already recorded (the
 * verified commit and its checks, review verdicts, budgets used, sensitive-path labels, human
 * decisions, and the merge). Read-only over existing rows and Git objects; it decides nothing.
 */
import { type DrawnModels, drawnModelsOf } from '../core/roles.ts';
import { classifyChanges, type SensitiveChange } from '../core/sensitive.ts';
import { changesBetween } from '../git/worktree.ts';
import type { Store } from '../storage/client.ts';
import { eventsOfTypes } from '../storage/events.ts';
import { listReviews, mergeEvidence } from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import { listChecks, listRuns } from '../storage/verification.ts';
import { mergedHead } from './merge-view.ts';

export interface Receipt {
  jobId: string;
  /** `job.ciHead`, else the head of the newest passing verification run. */
  verifiedHead: string | null;
  checks: { id: string; status: string; durationMs: number | null }[];
  /** The job's `models.drawn` event: each role's model and `sameAsAuthor`; null if not recorded. */
  models: DrawnModels | null;
  /** `model` and `sameAsAuthor` are null when the row did not record them (legacy jobs). */
  reviews: {
    round: number;
    reviewer: string;
    verdict: string | null;
    model: string | null;
    sameAsAuthor: boolean | null;
  }[];
  round: number;
  maxRounds: number;
  ciRepairs: number;
  maxCiRepairs: number;
  ciReruns: number;
  /** Null when the merge base or the verified commit could not be read from Git. */
  sensitive: SensitiveChange[] | null;
  decisions: string[];
  merge: { head: string | null; mergeCommit: string | null; verified: boolean | null } | null;
}

const DECISION_EVENTS = [
  'job.blocked',
  'job.resumed',
  'policy.authorized',
  'job.completed',
  'job.cancelled',
];

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const short = (v: unknown): string => str(v)?.slice(0, 7) ?? 'unknown';

/** Each escalation with the human answer that followed it, and every other human decision. */
function decisions(store: Store, id: string): string[] {
  const out: string[] = [];
  let open: number | null = null; // index in `out` of an escalation not answered yet
  for (const e of eventsOfTypes(store.db, id, DECISION_EVENTS).reverse()) {
    const p = e.payload;
    const by = e.actor ?? 'unknown';
    if (e.type === 'job.blocked') {
      out.push(`Blocked in ${str(p['from']) ?? '?'}: ${str(p['reason']) ?? 'no reason recorded'}`);
      open = out.length - 1;
    } else if (e.type === 'job.resumed' && str(p['to']) && open !== null) {
      out[open] = `${out[open] ?? ''}; resumed to ${String(p['to'])} by ${by}`;
      open = null;
    } else if (e.type === 'policy.authorized') {
      out.push(`Verification policy at ${short(p['head'])} authorized by ${by}`);
    } else if (e.type === 'job.completed' && p['acceptedByHuman'] === true) {
      out.push(
        `Delivery accepted by ${by}: ${str(p['reason']) ?? 'no reason recorded'} (CI ${str(p['ciStatus']) ?? 'not observed'})`,
      );
    } else if (e.type === 'job.completed' && p['mergedByHuman'] === true) {
      out.push(`PR merged by a human before CI finished (CI ${str(p['ciStatus']) ?? 'unknown'})`);
    } else if (e.type === 'job.cancelled') {
      out.push(
        `Cancelled by ${by} in ${str(p['stage']) ?? '?'}: ${str(p['reason']) ?? 'no reason recorded'}`,
      );
    }
  }
  return out;
}

export function buildReceipt(store: Store, job: Job): Receipt {
  const runs = listRuns(store.db, job.id); // newest first
  const verifiedHead = job.ciHead ?? runs.find((r) => r.status === 'passed')?.head ?? null;
  const atHead = runs.filter((r) => r.head === verifiedHead);
  const run = atHead.find((r) => r.status === 'passed') ?? atHead[0];
  // The merge base recorded with the verified commit's baseline run, as ops/merge-view.ts reads it.
  const base = atHead.find((r) => r.policySource === 'baseline')?.policyHead ?? null;
  const changes = verifiedHead && base ? changesBetween(job.repoPath, base, verifiedHead) : null;
  const evidence = job.prState === 'merged' ? mergeEvidence(store.db, job.id) : null;
  return {
    jobId: job.id,
    verifiedHead,
    checks: run
      ? listChecks(store.db, run.id).map((c) => ({
          id: c.checkId,
          status: c.status,
          durationMs: c.durationMs,
        }))
      : [],
    models: drawnModelsOf(eventsOfTypes(store.db, job.id, ['models.drawn'])),
    reviews: listReviews(store.db, job.id)
      .map((r) => ({
        round: r.round,
        reviewer: r.reviewer,
        verdict: r.verdict,
        model: r.model,
        sameAsAuthor: r.sameAsAuthor,
      }))
      .sort((a, b) => a.round - b.round),
    round: job.round,
    maxRounds: job.maxRounds,
    ciRepairs: job.ciRepairs,
    maxCiRepairs: job.maxCiRepairs,
    ciReruns: eventsOfTypes(store.db, job.id, ['ci.rerun']).filter((e) => e.payload['ok'] === true)
      .length,
    sensitive: changes ? classifyChanges(changes) : null,
    decisions: decisions(store, job.id),
    merge:
      job.prState === 'merged'
        ? {
            head: mergedHead(store, job.id),
            mergeCommit: str(evidence?.['mergeCommit']),
            verified: typeof evidence?.['verified'] === 'boolean' ? evidence['verified'] : null,
          }
        : null,
  };
}

const seconds = (ms: number | null) => (ms === null ? '-' : `${(ms / 1000).toFixed(1)} s`);
const code = (v: string | null) => (v ? `\`${v}\`` : 'unknown');
/** "opus, same as author: no"; the flag is left out for roles without an author. */
const modelText = (model: string | null, same: boolean | null | undefined) =>
  (model ?? 'model not recorded') +
  (same === undefined
    ? ''
    : `, same as author: ${same === null ? 'not recorded' : same ? 'yes' : 'no'}`);

export function receiptMarkdown(r: Receipt): string {
  const rounds = [...new Set(r.reviews.map((x) => x.round))];
  const merge = r.merge
    ? `Merged head ${code(r.merge.head)}, merge commit ${code(r.merge.mergeCommit)}, ` +
      `verified: ${r.merge.verified === null ? 'unknown' : r.merge.verified ? 'yes' : 'no'}`
    : 'Not merged.';
  const sensitive =
    r.sensitive === null
      ? 'unknown (the merge base or the verified commit is not available)'
      : r.sensitive.length === 0
        ? 'none'
        : r.sensitive.map((s) => `\`${s.path}\` (${s.kind})`).join(', ');
  return [
    '## Merge receipt',
    '',
    `- Job: ${r.jobId}`,
    `- Verified commit: ${code(r.verifiedHead)}`,
    `- Review rounds ${String(r.round)}/${String(r.maxRounds)}, CI repairs ` +
      `${String(r.ciRepairs)}/${String(r.maxCiRepairs)}, CI re-runs ${String(r.ciReruns)}`,
    `- Sensitive changes: ${sensitive}`,
    '',
    '### Verification checks',
    '',
    ...(r.checks.length
      ? r.checks.map((c) => `- ${c.id}: ${c.status}, ${seconds(c.durationMs)}`)
      : ['No verification run recorded for this commit.']),
    '',
    '### Reviews',
    '',
    ...(rounds.length
      ? rounds.map(
          (n) =>
            `- Round ${String(n)}: ` +
            r.reviews
              .filter((x) => x.round === n)
              .map(
                (x) =>
                  `${x.reviewer} ${x.verdict ?? 'pending'} (${modelText(x.model, x.sameAsAuthor)})`,
              )
              .join(', '),
        )
      : ['None.']),
    '',
    '### Models',
    '',
    ...(r.models
      ? Object.entries(r.models).map(
          ([role, m]) => `- ${role}: ${modelText(m.model, m.sameAsAuthor)}`,
        )
      : ['Not recorded.']),
    '',
    '### Human decisions',
    '',
    ...(r.decisions.length ? r.decisions.map((d) => `- ${d}`) : ['None.']),
    '',
    '### Merge',
    '',
    merge,
    '',
  ].join('\n');
}
