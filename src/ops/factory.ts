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
import { leaseExpired } from '../core/ownership.ts';
import { jobArtifactDir } from '../core/paths.ts';
import type { SensitiveReport } from '../core/sensitive.ts';
import {
  detectUi,
  type FactoryConfig,
  parseConfig,
  resolveRoles,
  reviewersFor,
  type Role,
} from '../core/roles.ts';
import {
  describeNext,
  now,
  requiredArtifact,
  reviewArtifact,
  type Stage,
} from '../core/workflow.ts';
import { describeRepo, dirtyFiles } from '../git/repo.ts';
import type { WorktreeInfo } from '../git/worktree.ts';
import { validateArtifact } from '../storage/artifacts.ts';
import type { Store } from '../storage/client.ts';
import {
  claimJob,
  createJob,
  getJob,
  jobDetail,
  resumeJob,
  transitionJob,
} from '../storage/jobs.ts';
import type { Artifact, Event, Integration, Job, Review } from '../storage/schema.ts';
import { listIntegrations } from '../storage/verification.ts';
import { issue as ghIssue } from './github.ts';
import {
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
          problem: 'content changed since registration',
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
  };

  if (job.status === 'cancelled') {
    plan.step = 'cancelled';
    plan.reason = 'The job was cancelled. Nothing to do.';
    return plan;
  }
  if (job.stage === 'completed') {
    plan.step = 'done';
    const done = [...detail.events].reverse().find((e) => e.type === 'job.completed');
    plan.reason =
      done?.payload['acceptedByHuman'] === true
        ? `Delivery accepted by a human (${job.prUrl ?? 'no URL'}): required checks were ` +
          `${job.ciStatus ?? 'unobserved'} for ${job.ciHead?.slice(0, 7) ?? 'no commit'}; this is a ` +
          'manual close-out, not a CI verdict. Humans mark it ready and merge.'
        : `Draft PR delivered (${job.prUrl ?? 'no URL'}) with required checks ${job.ciStatus ?? 'unobserved'} ` +
          `for ${job.ciHead?.slice(0, 7) ?? 'no commit'}. Humans mark it ready and merge.`;
    plan.commands = [`orch gh pr status ${id}`];
    return plan;
  }
  if (job.stage === 'needs-human') {
    plan.step = 'needs-human';
    const blocked = [...detail.events].reverse().find((e) => e.type === 'job.blocked');
    plan.blockedReason = (blocked?.payload['reason'] as string | null | undefined) ?? null;
    plan.reason =
      'A human must decide. Report the blocking reason and stop. To continue after the decision: ' +
      `orch factory resume ${id} --session <name> [--to ${job.returnStage ?? '<stage>'}]`;
    plan.commands = [`orch job show ${id}`];
    return plan;
  }
  if (
    job.ownerSession === null ||
    expired ||
    ['interrupted', 'failed', 'blocked'].includes(job.status)
  ) {
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
      const r = role('spec');
      if (r) plan.agents = [{ role: r.name, agent: r.agent, model: r.model, artifact: 'spec.md' }];
      plan.reason = 'Write the specification from the request and the repository.';
      plan.commands = [...start, add('spec.md'), complete];
      break;
    }
    case 'build': {
      const r = role('build');
      if (r) plan.agents = [{ role: r.name, agent: r.agent, model: r.model, artifact: 'build.md' }];
      const rework = job.round > 0;
      const reworked = [...detail.events].reverse().find((e) => e.type === 'job.reworked');
      const ciReason = reworked?.payload['reason'];
      const ciRepair =
        reworked?.payload['from'] === 'ci'
          ? ` CI repair ${String(job.ciRepairs)} of ${String(job.maxCiRepairs)}: ${typeof ciReason === 'string' ? ciReason : 'required checks failed'}. ` +
            'The builder reads the saved logs, fixes the defect without weakening checks or the policy, commits, and runs orch verify.'
          : '';
      const conflict =
        integration &&
        (integration.status === 'conflict' || (integration.material?.length ?? 0) > 0)
          ? ` Base integration of ${integration.baseRef} needs the builder: ` +
            (integration.status === 'conflict'
              ? `conflicts in ${integration.conflicts?.join(', ') ?? 'unknown files'}; merge ${integration.baseRef}, resolve, commit the merge.`
              : `merge ${integration.resultHead?.slice(0, 7) ?? '?'} edited ${integration.material?.join(', ') ?? ''}; review those edits as new code.`)
          : '';
      plan.reason =
        (rework
          ? `Rework round ${String(job.round + 1)}: address round-${String(job.round)}/consolidated.md, then rebuild build.md.`
          : 'Implement spec.md in the worktree, commit, run orch verify, and write build.md citing the run id.') +
        ciRepair +
        conflict;
      plan.commands = [...start, verify, add('build.md', rework), complete];
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
      plan.reason =
        'Independent final approval: spec, build.md, git diff, review artifacts, outstanding findings.';
      plan.commands = [
        ...start,
        ...verifyIfStale,
        add('decision.md', has('decision.md')),
        `${complete}   # only if DECISION: APPROVE; otherwise: orch job transition ${id} escalate --reason "<why>"${tok}`,
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
}

export interface StartResult {
  plan: Plan;
  token: string;
  job: Job;
}

/** Create, claim, and give a worktree to a new job in one step; returns the first plan. */
export function startJob(store: Store, input: StartInput): StartResult {
  const repo = describeRepo(input.repo ?? input.cwd);
  let title = input.title;
  let description = input.description;
  if (!title && input.issue) {
    const found = ghIssue(input.issue, repo.root);
    title = found.title;
    description ??= `${found.url}\n\n${found.body}`;
  }
  if (!title)
    throw new ValidationError('Provide --title (or --issue so the title can be fetched).');
  const config = loadConfig(store);
  const job = createJob(store, {
    title,
    description,
    issueRef: input.issue,
    repo: repo.identity,
    repoPath: repo.root,
    baseBranch: input.base ?? repo.currentBranch,
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
}

export interface ResumeResult extends StartResult {
  /** Whether a different session previously owned the job. */
  tookOver: boolean;
  previousOwner: string | null;
  /** What happened to `adopt`: null when it was not given. */
  adopted: 'adopted' | 'kept-existing' | null;
}

/**
 * Adopt a job from persisted state: claim (or take over a lapsed lease), return interrupted work
 * to pending, make sure the worktree exists, verify artifacts, and plan the next step.
 */
export function resumeFactoryJob(store: Store, id: string, input: ResumeInput): ResumeResult {
  const before = getJob(store.db, id);
  const previousOwner = before.ownerSession;
  const { token } = resumeJob(store, id, {
    session: input.session,
    to: input.to,
    force: input.force,
  });
  let job = getJob(store.db, id);
  let adopted: ResumeResult['adopted'] = null;
  if (job.stage !== 'needs-human' && job.stage !== 'completed' && job.status !== 'cancelled') {
    if (input.adopt !== undefined && job.worktreePath === null) {
      job = adoptWorktree(store, id, { token }, input.adopt).job;
      adopted = 'adopted';
    } else {
      if (input.adopt !== undefined) adopted = 'kept-existing';
      job = createWorktree(store, id, { token }).job;
    }
  }
  return {
    plan: planJob(store, id, { ui: input.ui }),
    token,
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

/** Mark a stage failed with a reason (malformed subagent output, tests red). */
export function failStage(
  store: Store,
  id: string,
  token: string | undefined,
  reason: string,
): Job {
  return transitionJob(store, id, 'fail', { token, reason });
}
