/**
 * The factory skill's oracle. Given a job, decide deterministically what the coordinating Claude
 * session must do next: which stage, which subagents (with models), which artifacts, and the exact
 * CLI commands to run. The skill follows this plan instead of reasoning about workflow state.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CI_MAX_SESSION_POLLS, waitSeconds } from '../core/ci.ts';
import { ValidationError } from '../core/errors.ts';
import { type Flake, integrateFirst, integrateFirstAdvice } from '../core/flake.ts';
import { leaseExpired } from '../core/ownership.ts';
import { jobArtifactDir } from '../core/paths.ts';
import type { SensitiveReport } from '../core/sensitive.ts';
import { ticketKey } from '../core/tickets.ts';
import {
  detectUi,
  type FactoryConfig,
  parseConfig,
  resolveRoles,
  reviewersFor,
  type Role,
} from '../core/roles.ts';
import {
  completionOf,
  describeNext,
  challengeSlot,
  latestChallenge,
  now,
  prPhase,
  requiredArtifact,
  RESUMABLE_STATUSES,
  reviewArtifact,
  scopeGapSpecRefusal,
  simplifyArtifact,
  simplifyReviewArtifact,
  type Stage,
  TERMINAL_STATUSES,
} from '../core/workflow.ts';
import { dirtyFiles, fetchBase, remoteExists } from '../git/repo.ts';
import { tryGit } from '../git/run.ts';
import type { WorktreeInfo } from '../git/worktree.ts';
import { validateArtifact } from '../storage/artifacts.ts';
import type { Store } from '../storage/client.ts';
import { eventsOfTypes } from '../storage/events.ts';
import { claimJob, createJob, getJob, jobDetail, releaseJob, resumeJob } from '../storage/jobs.ts';
import type { Artifact, Event, Integration, Job, Review } from '../storage/schema.ts';
import { latestRun, listIntegrations } from '../storage/verification.ts';
import { issue as ghIssue } from './github.ts';
import { jobRepository } from './repo.ts';
import { ticketJobRequest } from './tickets.ts';
import {
  currentFlakes,
  effectivePolicy,
  sensitiveReport,
  verificationStatus,
  type VerificationStatus,
} from './verify.ts';
import { adoptWorktree, createWorktree, showWorktree } from './worktree.ts';

export function configPath(store: Store): string {
  return join(store.paths.config, 'factory.json');
}

export function loadConfig(store: Store): FactoryConfig {
  const file = configPath(store);
  if (!existsSync(file)) return parseConfig(undefined);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ValidationError(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  return parseConfig(raw);
}

export type Step =
  | 'resume' // nobody owns it (or the lease lapsed / it was interrupted): run factory resume
  | 'create-worktree'
  | 'run-stage' // do the stage's work, register the artifact, complete
  | 'needs-human'
  | 'done'
  | 'cancelled';

export interface AgentTask {
  role: string;
  agent: string;
  model: string;
  /** Artifact the agent must write, relative to the artifact directory. */
  artifact: string;
}

export interface ArtifactCheck {
  path: string;
  stage: Stage;
  ok: boolean;
  problem?: string;
}

export interface Plan {
  jobId: string;
  title: string;
  stage: Stage;
  status: Job['status'];
  round: number;
  maxRounds: number;
  step: Step;
  /** Why this step; shown to the coordinator. */
  reason: string;
  owner: { session: string | null; leaseExpiresAt: string | null; expired: boolean };
  repo: { identity: string; path: string; baseBranch: string };
  artifactDir: string;
  worktree: (WorktreeInfo & { fingerprint: string }) | null;
  /**
   * Uncommitted files in the initiating checkout (`repo.path`). The factory never writes there;
   * a list that grows during a stage means a subagent or project-local skill used the wrong
   * directory. Null when the checkout is not reachable.
   */
  checkoutDirty: string[] | null;
  /** Latest verification run against the current HEAD and policy; null without a worktree. */
  verification: VerificationStatus | null;
  /** Sensitive paths in the job's diff, disabled tests, and policy drift; null without a diff. */
  sensitive: SensitiveReport | null;
  /** Newest likely-flaky verification failure; null for finished jobs or after a newer pass. A label only. */
  flake: Flake | null;
  /** Most recent base integration attempt, if any. */
  integration: Integration | null;
  /** Rendered UI touched (decides whether UI reviewers run). */
  ui: boolean;
  agents: AgentTask[];
  /** Reviewers of the current round, with their recorded verdicts. */
  reviews: { reviewer: string; verdict: Review['verdict'] }[];
  requiredArtifacts: string[];
  /** Registered artifacts, re-verified against disk. */
  artifacts: ArtifactCheck[];
  /** Literal commands, in order; the skill substitutes `<token>` in each. */
  commands: string[];
  pr: { url: string | null; state: string | null; ciStatus: string | null };
  /** CI reconciliation state: which commit the rollup describes and the repair budget. */
  ci: {
    head: string | null;
    /** The recorded rollup is for the worktree HEAD. */
    current: boolean;
    repairs: number;
    maxRepairs: number;
    /** Observations of the current head so far (one per `orch gh ci`). */
    polls: number;
    /** Observations of the current head since this session claimed the job. */
    sessionPolls: number;
    /** Re-runs GitHub accepted for the current head. */
    reruns: number;
    /** Seconds to sleep before the next `orch gh ci` while checks are pending. */
    waitSeconds: number;
    /** True when this session has observed the head pending CI_MAX_SESSION_POLLS times. */
    release: boolean;
    /** Reason from the newest observation. */
    lastReason: string | null;
  };
  /** Last escalation reason, when the job is in needs-human. */
  blockedReason?: string | null;
  /** Outside events for the session, read before acting on the step. */
  notices: Notice[];
  /** Command that acknowledges the posted messages shown; null when none or the job is finished. */
  noticeAck: string | null;
}

/**
 * Something that happened outside the session: derived from state on every plan (base moved, PR
 * merged, cancelled, fetch failed) or posted by a human or tool until the owner acknowledges it.
 */
export interface Notice {
  kind: 'base-moved' | 'pr-merged' | 'cancelled' | 'fetch-failed' | 'message';
  text: string;
  at: string | null;
  by: string | null;
  eventId: number | null;
}

function noticesFor(
  store: Store,
  job: Job,
  worktree: WorktreeInfo | null,
  fetchError: string | undefined,
): Notice[] {
  const id = job.id;
  const out: Notice[] = [];
  const derived = (kind: Notice['kind'], text: string): Notice => ({
    kind,
    text,
    at: null,
    by: null,
    eventId: null,
  });
  const finished = TERMINAL_STATUSES.includes(job.status);
  const behind = worktree?.behind ?? 0;
  if (worktree?.baseRef && behind > 0 && !finished && job.stage !== 'needs-human') {
    const sha = tryGit(worktree.path, 'rev-parse', worktree.baseRef)?.slice(0, 7) ?? '?';
    const integrate = `orch worktree integrate ${id} --token <token>`;
    out.push(
      derived(
        'base-moved',
        `Base ${job.baseBranch} moved: ${String(behind)} commit(s) ahead of this branch at ${sha}; ` +
          (job.stage === 'review'
            ? `integrate after this round completes (${integrate}).`
            : `run \`${integrate}\` before the next \`orch verify\`.`),
      ),
    );
  }
  if (job.prState === 'merged') {
    out.push(derived('pr-merged', `PR merged: ${job.prUrl ?? 'no URL'}.`));
  }
  if (fetchError !== undefined) {
    out.push(
      derived(
        'fetch-failed',
        `Could not fetch origin/${job.baseBranch} (${fetchError}); base-moved uses the last fetched ref.`,
      ),
    );
  }
  const own = eventsOfTypes(store.db, id, ['job.cancelled', 'notice.posted', 'notice.acked']);
  const cancelled = own.find((e) => e.type === 'job.cancelled');
  if (cancelled) {
    const reason =
      typeof cancelled.payload['reason'] === 'string' ? cancelled.payload['reason'] : '';
    out.push({
      kind: 'cancelled',
      text: `Cancelled by ${cancelled.actor ?? 'unknown'}: ${reason || 'no reason given'}`,
      at: cancelled.createdAt,
      by: cancelled.actor,
      eventId: cancelled.id,
    });
  }
  // Event ids are global and increasing; acknowledged means id <= the largest `through`.
  const acked = Math.max(
    0,
    ...own.filter((e) => e.type === 'notice.acked').map((e) => Number(e.payload['through']) || 0),
  );
  for (const e of own.filter((x) => x.type === 'notice.posted' && x.id > acked).reverse()) {
    out.push({
      kind: 'message',
      text: String(e.payload['text']),
      at: e.createdAt,
      by: e.actor,
      eventId: e.id,
    });
  }
  return out;
}

function tryDirty(root: string): string[] | undefined {
  try {
    return dirtyFiles(root);
  } catch {
    return undefined;
  }
}

/** Stable hash of HEAD plus the dirty-file list, to detect writes by read-only reviewers. */
export function fingerprint(info: WorktreeInfo): string {
  const h = createHash('sha256');
  h.update(info.head ?? '');
  for (const f of [...info.dirty].sort()) h.update(`\n${f}`);
  return h.digest('hex').slice(0, 16);
}

const CHANGED_SINCE_REGISTRATION = 'content changed since registration';

/**
 * The steps that continue a spec escalation, shared by the escalate reason, the needs-human
 * plan, and the controller's `next:` hint so they never disagree.
 */
export function specResumeSteps(id: string, artifactDir: string, ticketId: number | null): string {
  const run = ticketId === null ? `/factory ${id}` : `orch do ${ticketKey(ticketId)}`;
  return (
    `1. edit ${join(artifactDir, 'spec.md')}; 2. choose Resume at spec on the dashboard (orch ui), ` +
    `or run orch factory resume ${id} --to spec --release; 3. run ${run}`
  );
}

/**
 * Whether spec.md on disk differs from its registered content after a human `resume --to spec`
 * newer than the registration of the latest challenge (`reviewed`).
 */
function humanSpecEdit(events: Event[], reviewed: string, checks: ArtifactCheck[]): boolean {
  const challengedAt = events.findLast(
    (e) =>
      (e.type === 'artifact.registered' || e.type === 'artifact.replaced') &&
      e.payload['path'] === reviewed,
  )?.id;
  const resumedAt = events.findLast(
    (e) => e.type === 'job.resumed' && e.payload['to'] === 'spec',
  )?.id;
  if (challengedAt === undefined || resumedAt === undefined || resumedAt < challengedAt) {
    return false;
  }
  return checks.some((c) => c.path === 'spec.md' && c.problem === CHANGED_SINCE_REGISTRATION);
}

function checkArtifacts(store: Store, job: Job, artifacts: Artifact[]): ArtifactCheck[] {
  const dir = jobArtifactDir(job.id, store.paths);
  return artifacts.map((a) => {
    try {
      const checked = validateArtifact(dir, a.path);
      if (a.sha256 && checked.sha256 !== a.sha256) {
        return {
          path: a.path,
          stage: a.stage,
          ok: false,
          problem: CHANGED_SINCE_REGISTRATION,
        };
      }
      return { path: a.path, stage: a.stage, ok: true };
    } catch (err) {
      return { path: a.path, stage: a.stage, ok: false, problem: (err as Error).message };
    }
  });
}

function reviewersForJob(
  roles: Role[],
  config: FactoryConfig,
  worktree: WorktreeInfo | null,
  uiOverride: boolean | undefined,
): { ui: boolean; reviewers: Role[] } {
  const files = worktree ? [...worktree.changedFiles, ...worktree.dirty] : [];
  const ui = uiOverride ?? detectUi(files, config.uiPatterns);
  return { ui, reviewers: reviewersFor(roles, ui) };
}

export interface PlanOptions {
  /** Force UI reviewers on or off instead of detecting from the diff. */
  ui?: boolean | undefined;
  /** Why fetching the base failed (from `planJobFresh`); shown as a `fetch-failed` notice. */
  fetchError?: string | undefined;
}

/**
 * `planJob` after fetching the base, so `base-moved` reflects origin: the session's
 * `orch factory next|status`. Other readers (dashboard, mail, recovery) call `planJob`, which
 * never fetches. No `origin`, no worktree, or a finished job: no fetch.
 */
export function planJobFresh(store: Store, id: string, opts: PlanOptions = {}): Plan {
  const job = getJob(store.db, id);
  const finished = TERMINAL_STATUSES.includes(job.status);
  let fetchError: string | undefined;
  if (
    !finished &&
    job.worktreePath !== null &&
    existsSync(job.worktreePath) &&
    remoteExists(job.repoPath)
  ) {
    fetchError = fetchBase(job.worktreePath, job.baseBranch) ?? undefined;
  }
  return planJob(store, id, { ...opts, fetchError });
}

/** What `orch gh ci` did about the draft after completing the job (the newest `pr.ready` event). */
function readyLine(events: Event[]): string {
  const e = [...events].reverse().find((x) => x.type === 'pr.ready');
  if (!e) return 'The PR was already ready (or merged) when CI completed.';
  return e.payload['ok'] === true
    ? 'orch marked the PR ready for review.'
    : `orch could not mark the PR ready (${String(e.payload['error'])}); a human runs gh pr ready.`;
}

/** Build the plan for a job. Read-only. */
export function planJob(store: Store, id: string, opts: PlanOptions = {}): Plan {
  const detail = jobDetail(store, id, 1000);
  const job = detail.job;
  const config = loadConfig(store);
  const roles = resolveRoles(config);
  const ts = now();
  const { worktree: wt } = showWorktree(store, id);
  const worktree = wt.exists && wt.isWorktree ? { ...wt, fingerprint: fingerprint(wt) } : null;
  const { ui, reviewers } = reviewersForJob(roles, config, worktree, opts.ui);
  const current = detail.reviews.filter((r) => r.round === job.round);
  const expired = job.ownerSession !== null && leaseExpired(job, ts);
  let verification: VerificationStatus | null = null;
  let sensitive: SensitiveReport | null = null;
  let planProblem = '';
  if (worktree?.head && worktree.baseRef) {
    const tree = { ...worktree, head: worktree.head };
    try {
      const eff = effectivePolicy(job, tree);
      verification = verificationStatus(store, job, tree, eff);
      sensitive = sensitiveReport(tree, eff);
    } catch (err) {
      planProblem = (err as Error).message;
    }
  }
  const integration = listIntegrations(store.db, id)[0] ?? null;
  const required = requiredArtifact(job.stage, job.round);
  const observations = detail.events.filter((e) => e.type === 'ci.observed');
  const lastObserved = observations.at(-1);
  const ciCurrent = job.ciHead !== null && job.ciHead === (worktree?.head ?? null);
  const ofHead = (e: Event) =>
    e.payload['head'] === job.ciHead && e.payload['outcome'] !== undefined;
  const polls = observations.filter(ofHead).length;
  const claimedAt = detail.events.filter((e) => e.type === 'job.claimed').at(-1)?.id ?? 0;
  const sessionPolls = observations.filter((e) => e.id > claimedAt && ofHead(e)).length;
  const has = (p: string) => detail.artifacts.some((a) => a.path === p);
  // Every mutating command carries the token explicitly: shells spawned by Claude Code do not
  // keep environment variables between calls, so the skill substitutes <token> each time.
  const tok = ' --token <token>';
  const notices = noticesFor(store, job, worktree, opts.fetchError);
  const newestMessage = notices.filter((n) => n.kind === 'message').at(-1)?.eventId;
  const noticeAck =
    newestMessage != null && !TERMINAL_STATUSES.includes(job.status)
      ? `orch job notice ack ${id} --through ${String(newestMessage)}${tok}`
      : null;

  const plan: Plan = {
    jobId: id,
    title: job.title,
    stage: job.stage,
    status: job.status,
    round: job.round,
    maxRounds: job.maxRounds,
    step: 'run-stage',
    reason: '',
    owner: { session: job.ownerSession, leaseExpiresAt: job.leaseExpiresAt, expired },
    repo: { identity: job.repo, path: job.repoPath, baseBranch: job.baseBranch },
    artifactDir: detail.artifactDir,
    worktree,
    checkoutDirty: existsSync(job.repoPath) ? (tryDirty(job.repoPath) ?? null) : null,
    verification,
    sensitive,
    flake: currentFlakes(store).get(id) ?? null,
    integration,
    ui,
    agents: [],
    reviews: current.map((r) => ({ reviewer: r.reviewer, verdict: r.verdict })),
    requiredArtifacts: describeNext(job).requiredArtifacts,
    artifacts: checkArtifacts(store, job, detail.artifacts),
    commands: [],
    pr: { url: job.prUrl, state: job.prState, ciStatus: job.ciStatus },
    ci: {
      head: job.ciHead,
      current: ciCurrent,
      repairs: job.ciRepairs,
      maxRepairs: job.maxCiRepairs,
      polls,
      sessionPolls,
      reruns: detail.events.filter(
        (e) =>
          e.type === 'ci.rerun' && e.payload['head'] === job.ciHead && e.payload['ok'] === true,
      ).length,
      waitSeconds: waitSeconds(polls),
      release: job.ciStatus === 'pending' && sessionPolls >= CI_MAX_SESSION_POLLS,
      lastReason: (lastObserved?.payload['reason'] as string | undefined) ?? null,
    },
    notices,
    noticeAck,
  };

  if (job.status === 'cancelled') {
    plan.step = 'cancelled';
    plan.reason = 'The job was cancelled. Nothing to do.';
    return plan;
  }
  if (job.stage === 'completed') {
    plan.step = 'done';
    const done = [...detail.events].reverse().find((e) => e.type === 'job.completed');
    const phase = prPhase(job, completionOf(job.stage, done?.payload));
    const merge =
      phase === 'ready-to-merge'
        ? 'PR phase ready-to-merge: Humans merge (Merge on the dashboard, or on GitHub).'
        : `PR phase ${phase}. Humans merge.`;
    plan.reason =
      done?.payload['mergedByHuman'] === true
        ? `PR merged by a human before CI finished (${job.prUrl ?? 'no URL'}): required checks were ` +
          `${job.ciStatus ?? 'unobserved'} for ${job.ciHead?.slice(0, 7) ?? 'no commit'}, ` +
          'the verified, approved HEAD. Nothing to do.'
        : done?.payload['acceptedByHuman'] === true
          ? `Delivery accepted by a human (${job.prUrl ?? 'no URL'}): required checks were ` +
            `${job.ciStatus ?? 'unobserved'} for ${job.ciHead?.slice(0, 7) ?? 'no commit'}; this is a ` +
            `manual close-out, not a CI verdict; the PR was not marked ready. ${merge}`
          : `PR delivered (${job.prUrl ?? 'no URL'}) with required checks ${job.ciStatus ?? 'unobserved'} ` +
            `for ${job.ciHead?.slice(0, 7) ?? 'no commit'}. ${readyLine(detail.events)} ${merge}`;
    plan.commands = [`orch gh pr status ${id}`];
    return plan;
  }
  if (job.stage === 'needs-human') {
    plan.step = 'needs-human';
    const blocked = [...detail.events].reverse().find((e) => e.type === 'job.blocked');
    plan.blockedReason = (blocked?.payload['reason'] as string | null | undefined) ?? null;
    plan.reason =
      job.returnStage === 'spec'
        ? 'A human must decide. Report the blocking reason and stop. To continue: ' +
          `${specResumeSteps(id, detail.artifactDir, job.ticketId)}.`
        : 'A human must decide. Report the blocking reason and stop. To continue after the decision: ' +
          `orch factory resume ${id} --session <name> [--to ${job.returnStage ?? '<stage>'}]`;
    plan.commands = [`orch job show ${id}`];
    return plan;
  }
  if (job.ownerSession === null || expired || RESUMABLE_STATUSES.includes(job.status)) {
    plan.step = 'resume';
    plan.reason =
      job.ownerSession === null
        ? 'No session owns this job.'
        : expired
          ? `The lease held by ${job.ownerSession} lapsed; that session is presumed gone.`
          : `The job is ${job.status}.`;
    plan.commands = [`orch factory resume ${id} --session <your-session-name>`];
    return plan;
  }
  if (!worktree) {
    plan.step = 'create-worktree';
    plan.reason = 'The job has no usable worktree yet.';
    plan.commands = [`orch worktree create ${id}${tok}`, `orch factory next ${id}`];
    return plan;
  }

  const start = job.status === 'pending' ? [`orch job transition ${id} start${tok}`] : [];
  const verify = `orch verify ${id}${tok}`;
  const verifyIfStale = verification?.valid ? [] : [verify];
  const notes: string[] = [];
  if (planProblem) notes.push(`Policy problem: ${planProblem}.`);
  if (verification && !verification.configured) {
    notes.push(
      `No verification policy (factory.json) on the base branch: the job cannot pass its gates ` +
        'until one exists (orch init, then commit on the base branch) or a human accepts a proposed ' +
        'policy (dashboard: accept-policy).',
    );
  }
  if (verification?.policy.authorization === 'required') {
    notes.push(
      'The worktree changes the verification policy; a human must accept it (dashboard: accept-policy) ' +
        'or it must be reverted before approval.',
    );
  }
  if (sensitive?.needsReview) {
    notes.push(
      `Sensitive changes need explicit review: ${sensitive.changes.map((c) => c.path).join(', ') || 'see sensitive.scan'}.`,
    );
  }
  const add = (p: string, replace = false) =>
    `orch job artifact add ${id} ${p}${replace ? ' --replace' : ''}${tok}`;
  const complete = `orch job transition ${id} complete${tok}`;
  const role = (kind: Role['kind']) => roles.find((r) => r.kind === kind);

  switch (job.stage) {
    case 'spec': {
      // Write, challenge, revise once, challenge again; a second CHANGES goes to a human.
      const spec = detail.artifacts.find((a) => a.path === 'spec.md');
      const latest = latestChallenge(detail.artifacts);
      const reviewed = latest?.path ?? '';
      const n = challengeSlot(reviewed);
      const current = latest !== undefined && latest.specSha256 === spec?.sha256;
      const next = `orch factory next ${id}`;
      const task = (kind: Role['kind'], artifact: string) => {
        const r = role(kind);
        if (r) plan.agents = [{ role: r.name, agent: r.agent, model: r.model, artifact }];
      };
      if (!spec) {
        task('spec', 'spec.md');
        plan.reason = 'Write the specification from the request and the repository.';
        plan.commands = [...start, add('spec.md'), next];
      } else if (scopeGapSpecRefusal(detail.artifacts)) {
        // The approver found the spec less than the request (DECISION: REWORK-SPEC).
        task('spec', 'spec.md');
        plan.reason =
          'Scope gap at approval: decision.md says REWORK-SPEC, the spec covers less than the request. ' +
          'Revise spec.md from the request and decision.md so it covers every requested case, then it is challenged again.';
        plan.commands = [...start, add('spec.md', true), next];
      } else if (current && latest.marker === 'pass') {
        plan.reason = `${reviewed} passes the current spec.md; complete the stage.`;
        plan.commands = [...start, complete];
      } else if (current && n < 2) {
        task('spec', 'spec.md');
        plan.reason = `Revise spec.md once to answer the material objections in ${reviewed}, then it is challenged again.`;
        plan.commands = [...start, add('spec.md', true), next];
      } else if (current && humanSpecEdit(detail.events, reviewed, plan.artifacts)) {
        // A human resumed to spec after the second CHANGES and edited spec.md: register it so
        // the next plan re-challenges it. An agent's own edit has no newer human resume.
        task('spec', 'spec.md');
        plan.reason =
          `A human resumed the job to spec after ${reviewed} and edited spec.md; register the edit ` +
          'as it is (do not rewrite it), then it is challenged again.';
        plan.commands = [...start, add('spec.md', true), next];
      } else if (current) {
        plan.reason =
          `The spec challenger asked for changes twice; escalate with the objections in ${reviewed}. ` +
          `To continue, a human: ${specResumeSteps(id, detail.artifactDir, job.ticketId)}. ` +
          'The next plan registers the edit and re-challenges it.';
        plan.commands = [
          `orch job transition ${id} escalate --reason "spec challenger requested changes twice; see ${reviewed}"${tok}`,
        ];
      } else {
        // No challenge yet, or the latest one reviewed an earlier spec.md.
        const slot = n === 2 || (n === 1 && latest?.marker === 'changes') ? 2 : 1;
        const artifact = `spec-review-${String(slot)}.md`;
        task('spec-challenge', artifact);
        plan.reason = `Independent challenge of spec.md against the request and the repository's conventions: write ${artifact} with VERDICT: PASS or CHANGES.`;
        plan.commands = [...start, add(artifact, has(artifact)), next];
      }
      break;
    }
    case 'build': {
      const r = role('build');
      if (r) plan.agents = [{ role: r.name, agent: r.agent, model: r.model, artifact: 'build.md' }];
      const rework = job.round > 0;
      // A rework (CI failure, base-integration conflict or merge edits) is addressed by the next
      // build visit only; once that build completed, later visits are ordinary review rounds.
      const newest = [...detail.events].reverse();
      const reworked = newest.find((e) => e.type === 'job.reworked');
      const builtSince = newest.find(
        (e) => e.type === 'stage.completed' && e.payload['stage'] === 'build',
      );
      const pending = reworked && (!builtSince || reworked.id > builtSince.id) ? reworked : null;
      const why = typeof pending?.payload['reason'] === 'string' ? pending.payload['reason'] : null;
      const reworkNote = !pending
        ? ''
        : typeof pending.payload['scopeGap'] === 'string'
          ? ` Scope gap at approval: ${why ?? 'the build covers less than requested'}. ` +
            'Implement everything spec.md puts in scope that decision.md names as missing; this is the one automatic scope rework.'
          : pending.payload['from'] === 'ci' && pending.payload['integration'] !== true
            ? ` CI repair ${String(job.ciRepairs)} of ${String(job.maxCiRepairs)}: ${why ?? 'required checks failed'}. ` +
              'The builder reads the saved logs, fixes the defect without weakening checks or the policy, commits, and runs orch verify.'
            : ` Base integration needs the builder: ${why ?? 'the merge did not apply cleanly'}. ` +
              `Merge ${job.baseBranch}, resolve, commit the merge; the result is reviewed as new code.`;
      plan.reason =
        (rework
          ? `Rework round ${String(job.round + 1)}: address round-${String(job.round)}/consolidated.md, then rebuild build.md.`
          : 'Implement spec.md in the worktree, commit, run orch verify, and write build.md citing the run id.') +
        reworkNote;
      plan.commands = [...start, verify, add('build.md', rework), complete];
      break;
    }
    case 'simplify': {
      const findings = simplifyReviewArtifact(job.round);
      const record = simplifyArtifact(job.round);
      const task = (kind: Role['kind'], artifact: string) => {
        const r = role(kind);
        return r ? [{ role: r.name, agent: r.agent, model: r.model, artifact }] : [];
      };
      plan.agents = [...task('simplify', findings), ...task('build', record)];
      plan.reason =
        `Simplify round ${String(job.round)}: the simplifier reviews the job's diff for over-engineering and writes ` +
        `${findings} without touching code; the builder applies the findings that make sense (never widening ` +
        `scope), commits if anything changed, runs orch verify (which returns the build's run when nothing ` +
        `changed), and writes ${record} listing what was applied and each declined finding with its reason.`;
      plan.commands = [
        ...start,
        add(findings, has(findings)),
        verify,
        add(record, has(record)),
        complete,
      ];
      break;
    }
    case 'review': {
      plan.agents = reviewers.map((r) => ({
        role: r.name,
        agent: r.agent,
        model: r.model,
        artifact: reviewArtifact(job.round, r.name),
      }));
      const pending = reviewers
        .filter((r) => !current.some((c) => c.reviewer === r.name && c.verdict !== null))
        .map((r) => r.name);
      plan.reason =
        `Review round ${String(job.round)} of ${String(job.maxRounds)}: run ${String(reviewers.length)} reviewers` +
        `${ui ? ' (UI reviewers included)' : ''} concurrently, record verdicts, consolidate.` +
        (pending.length ? ` Pending: ${pending.join(', ')}.` : ' All verdicts recorded.');
      plan.commands = [
        ...start,
        ...reviewers.map((r) => `orch job review record ${id} --reviewer ${r.name}${tok}`),
        `orch factory check-readonly ${id} --fingerprint ${worktree.fingerprint}`,
        ...reviewers.map(
          (r) =>
            `orch job review record ${id} --reviewer ${r.name} --verdict <pass|changes> --summary "<one line>"${tok}`,
        ),
        add(`round-${String(job.round)}/consolidated.md`),
        complete,
      ];
      break;
    }
    case 'approve': {
      const r = role('approve');
      if (r)
        plan.agents = [{ role: r.name, agent: r.agent, model: r.model, artifact: 'decision.md' }];
      const behind = worktree.behind ?? 0;
      plan.reason =
        'Independent final approval: spec, build.md, git diff, review artifacts, outstanding findings.' +
        (behind > 0
          ? ` Base advanced by ${String(behind)} commit(s): if the approver escalates for that, run orch worktree integrate ${id} instead; a conflict sends the job back to build as rework.`
          : '');
      plan.commands = [
        ...start,
        ...verifyIfStale,
        add('decision.md', has('decision.md')),
        `${complete}   # only if DECISION: APPROVE`,
        `orch job transition ${id} rework --reason "<the scope gap>"${tok}   # DECISION: REWORK-BUILD (code less than spec) or REWORK-SPEC (spec less than request)`,
        `orch job transition ${id} escalate --reason "<why>"${tok}   # DECISION: ESCALATE`,
      ];
      break;
    }
    case 'pr': {
      const behind = worktree.behind ?? 0;
      plan.reason =
        'Deliver: integrate base if it advanced, verify the resulting commit, push, create or reuse the draft PR, write pr.md. ' +
        'Completing hands the job to the ci stage; delivery is not done until required checks pass.' +
        (behind > 0 ? ` Base is ${String(behind)} commit(s) ahead.` : '') +
        (job.prUrl ? ` The existing PR ${job.prUrl} is updated, never duplicated.` : '');
      plan.commands = [
        ...start,
        ...(behind > 0
          ? [
              `orch worktree integrate ${id}${tok}   # conflicts send the job back to build`,
              `orch factory next ${id}   # re-plan: HEAD changed`,
            ]
          : []),
        ...(behind > 0 ? [verify] : verifyIfStale),
        `orch gh push ${id}${tok}`,
        `orch gh pr create ${id} --body-file "${join(detail.artifactDir, 'pr.md')}"${tok}`,
        add('pr.md', has('pr.md')),
        complete,
        `orch factory next ${id}`,
      ];
      break;
    }
    case 'ci': {
      const ci = `orch gh ci ${id}${tok}`;
      const budget = `Repairs used: ${String(job.ciRepairs)} of ${String(job.maxCiRepairs)}.`;
      // A stored verdict, even a passing one for HEAD, never completes the stage: orch gh ci
      // re-reads GitHub and completes in the same call when the checks still pass for this head.
      if (plan.ci.release) {
        plan.reason =
          `CI is still pending after ${String(sessionPolls)} observations in this session. Release the job, ` +
          `tell the user CI is running, and stop; orch factory resume re-reads GitHub later. ${budget}` +
          (plan.ci.lastReason ? ` Last observation: ${plan.ci.lastReason}` : '');
        plan.commands = [`orch job release ${id}${tok}`];
      } else {
        plan.reason =
          `Reconcile CI for the PR head through orch gh ci; it records GitHub's verdict for the exact commit and ` +
          `acts on it (passing: completes the job; failing: re-run once, then rework to build with saved logs; ` +
          `cannot run or no checks: escalate). Pending checks are only an observation: sleep plan.ci.waitSeconds ` +
          `(${String(plan.ci.waitSeconds)} s now) and run it again; the CLI never polls by itself. ${budget}` +
          (job.ciHead && !ciCurrent
            ? ` The last observation was for ${job.ciHead.slice(0, 7)}, not HEAD ${worktree.head?.slice(0, 7) ?? '?'}.`
            : '') +
          (ciCurrent && job.ciStatus === 'passing'
            ? ` A passing verdict is recorded for ${job.ciHead?.slice(0, 7) ?? '?'}; it is confirmed against GitHub, not reused.`
            : '') +
          (plan.ci.lastReason ? ` Last observation: ${plan.ci.lastReason}` : '');
        plan.commands = [...start, ci, `orch factory next ${id}`];
      }
      break;
    }
    default:
      break;
  }
  // A failure only in files the job did not change, with a moved base: integrate and verify again
  // before any rework (decision 2026-11-19-integrate-base-before-reworking-unchanged-failures).
  const behind = worktree.behind ?? 0;
  if (
    ['build', 'simplify', 'approve', 'pr'].includes(job.stage) &&
    integrateFirst(plan.flake, latestRun(store.db, id)?.run, worktree.head, behind)
  ) {
    plan.reason = `${integrateFirstAdvice(id, behind)} ${plan.reason}`;
    // pr already integrates first when base moved.
    if (job.stage !== 'pr') {
      plan.commands.splice(
        start.length,
        0,
        `orch worktree integrate ${id}${tok}   # base moved; verify again after it`,
      );
    }
  }
  if (required && !plan.requiredArtifacts.includes(required)) plan.requiredArtifacts.push(required);
  if (notes.length > 0) plan.reason = `${plan.reason} ${notes.join(' ')}`;
  return plan;
}

export interface StartInput {
  title?: string | undefined;
  description?: string | undefined;
  issue?: string | undefined;
  repo?: string | undefined;
  base?: string | undefined;
  maxRounds?: number | undefined;
  session: string;
  cwd: string;
  ui?: boolean | undefined;
  /** Ticket the job works on; its title and body are the defaults for title and description. */
  ticket?: string | number | undefined;
}

export interface StartResult {
  plan: Plan;
  token: string;
  job: Job;
}

/** Create, claim, and give a worktree to a new job in one step; returns the first plan. */
export function startJob(store: Store, input: StartInput): StartResult {
  // The session works where it stands, so the ticket must belong to that repository.
  const forTicket =
    input.ticket === undefined
      ? undefined
      : ticketJobRequest(store, input.ticket, input.repo ?? input.cwd);
  const { repo, base } = jobRepository(input.repo ?? input.cwd, input.base);
  let title = input.title;
  let description = input.description;
  if ((!title || description === undefined) && input.issue) {
    const found = ghIssue(input.issue, repo.root);
    if (!title) ({ title } = found); // also replaces an empty --title, as before
    description ??= `${found.url}\n\n${found.body}`;
  }
  if (title === undefined || title === '') title = forTicket?.title;
  description ??= forTicket?.description;
  if (!title) {
    throw new ValidationError(
      'Provide --title (or --issue or --ticket so the title can be fetched).',
    );
  }
  const config = loadConfig(store);
  const job = createJob(store, {
    title,
    description,
    ticketId: forTicket?.ticket.id,
    issueRef: input.issue,
    repo: repo.identity,
    repoPath: repo.root,
    baseBranch: base,
    maxRounds: input.maxRounds ?? config.maxRounds,
    maxCiRepairs: config.maxCiRepairs,
    actor: input.session,
  });
  const { token } = claimJob(store, job.id, { session: input.session });
  const created = createWorktree(store, job.id, { token });
  return { plan: planJob(store, job.id, { ui: input.ui }), token, job: created.job };
}

export interface ResumeInput {
  session: string;
  to?: Stage | undefined;
  force?: boolean | undefined;
  ui?: boolean | undefined;
  /**
   * An existing worktree of the job's repository to adopt when the job has none yet: the one a
   * dispatched session was launched in (VS Code creates it before the session starts). Ignored
   * once the job has a worktree, so a session may always pass its own.
   */
  adopt?: string | undefined;
  /** Release the job once resumed, so the controller (`orch do`) can claim it at once. */
  release?: boolean | undefined;
}

export interface ResumeResult extends StartResult {
  /** Whether `release` gave the job up again; then the token is null. */
  released: boolean;
  /** Whether a different session previously owned the job. */
  tookOver: boolean;
  previousOwner: string | null;
  /** What happened to `adopt`: null when it was not given. */
  adopted: 'adopted' | 'kept-existing' | null;
}

/** A resume that may have released the job: the token is null when it did. */
export type ReleasedResume = Omit<ResumeResult, 'token'> & { token: string | null };

/**
 * Adopt a job from persisted state: claim (or take over a lapsed lease), return interrupted work
 * to pending, make sure the worktree exists, verify artifacts, and plan the next step.
 */
export function resumeFactoryJob(
  store: Store,
  id: string,
  input: ResumeInput & { release?: false | undefined },
): ResumeResult;
export function resumeFactoryJob(store: Store, id: string, input: ResumeInput): ReleasedResume;
export function resumeFactoryJob(store: Store, id: string, input: ResumeInput): ReleasedResume {
  const before = getJob(store.db, id);
  const previousOwner = before.ownerSession;
  const { token } = resumeJob(store, id, {
    session: input.session,
    to: input.to,
    force: input.force,
  });
  let job = getJob(store.db, id);
  let adopted: ReleasedResume['adopted'] = null;
  if (job.stage !== 'needs-human' && job.stage !== 'completed' && job.status !== 'cancelled') {
    if (input.adopt !== undefined && job.worktreePath === null) {
      job = adoptWorktree(store, id, { token }, input.adopt).job;
      adopted = 'adopted';
    } else {
      if (input.adopt !== undefined) adopted = 'kept-existing';
      job = createWorktree(store, id, { token }).job;
    }
  }
  const released = input.release === true;
  if (released) job = releaseJob(store, id, { token });
  return {
    plan: planJob(store, id, { ui: input.ui }),
    token: released ? null : token,
    released,
    job,
    tookOver: previousOwner !== null && previousOwner !== input.session,
    previousOwner,
    adopted,
  };
}

/** Exit 1 when the worktree changed since `expected` was taken (a reviewer wrote code). */
export function checkReadonly(
  store: Store,
  id: string,
  expected: string,
): { ok: true; fingerprint: string } {
  const { worktree } = showWorktree(store, id);
  // An inspection failure is not a reviewer write: fail closed, but say which step failed.
  if (!worktree.exists || !worktree.isWorktree || worktree.head === null) {
    const why = worktree.exists
      ? (worktree.problem ?? 'no detail')
      : 'the directory does not exist';
    throw new ValidationError(`Worktree is missing or unreadable at ${worktree.path}: ${why}`);
  }
  const actual = fingerprint(worktree);
  if (actual !== expected) {
    throw new ValidationError(
      `Worktree changed during a read-only step (HEAD ${worktree.head.slice(0, 7)}, ` +
        `dirty: ${worktree.dirty.join(', ') || 'none'}). Reviewers must not modify code; ` +
        'inspect the changes, revert or commit them deliberately, then rerun the round.',
    );
  }
  return { ok: true, fingerprint: actual };
}
