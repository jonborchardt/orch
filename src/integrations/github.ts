/**
 * GitHub access through the `gh` CLI, invoked with argument arrays. Never force-pushes; the PR
 * mutations are creating a draft, marking it ready, and `mergePr`, which only a human's dashboard
 * Merge reaches (decision 2026-11-15-humans-merge-from-the-dashboard). Set ORCH_GH_SHIM to a
 * JavaScript file to replace `gh` with `node <shim> <args>` in tests.
 */
import type { CiCheck } from '../core/ci.ts';
import { ToolError } from '../core/errors.ts';
import { spawnTool, type ToolResult, whichSync } from '../core/exec.ts';
import type { CiStatus, PrState } from '../core/workflow.ts';
import { normalizeRemote } from '../git/repo.ts';

export const GH_SHIM_ENV = 'ORCH_GH_SHIM';

/** Run gh and return the raw result; callers decide what a non-zero exit means. */
export function ghResult(args: string[], cwd?: string): ToolResult {
  const env = process.env;
  const shim = env[GH_SHIM_ENV];
  const exe = shim ? process.execPath : whichSync('gh', env);
  if (!exe)
    throw new ToolError('GitHub CLI (gh) not found on PATH. Install it and run gh auth login.');
  return spawnTool(exe, shim ? [shim, ...args] : args, { cwd, env });
}

export function gh(args: string[], cwd?: string): string {
  const r = ghResult(args, cwd);
  if (r.status !== 0) {
    throw new ToolError(
      `gh ${args.slice(0, 2).join(' ')} failed: ${(r.stderr || r.stdout).trim()}`,
    );
  }
  return r.stdout.trim();
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller picks the shape
function ghJson<T>(args: string[], cwd?: string): T {
  const out = gh(args, cwd);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new ToolError(`gh ${args[0] ?? ''} returned invalid JSON: ${out.slice(0, 200)}`);
  }
}

export interface GhRepo {
  nameWithOwner: string;
  url: string;
  defaultBranch: string;
  /** Same form as a job's repo identity: github.com/owner/name (lower-case). */
  identity: string;
}

export function viewRepo(cwd: string): GhRepo {
  const r = ghJson<{
    nameWithOwner: string;
    url: string;
    defaultBranchRef: { name: string } | null;
  }>(['repo', 'view', '--json', 'nameWithOwner,url,defaultBranchRef'], cwd);
  return {
    nameWithOwner: r.nameWithOwner,
    url: r.url,
    defaultBranch: r.defaultBranchRef?.name ?? 'main',
    identity: normalizeRemote(r.url),
  };
}

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: string[];
}

/** `ref` may be `#12`, `12`, or an issue URL. `repo` is owner/name when not inferable from cwd. */
export function viewIssue(ref: string, cwd: string, repo?: string): GhIssue {
  const target = /^#?\d+$/.test(ref) ? ref.replace(/^#/, '') : ref;
  if (!/^(\d+|https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+)$/.test(target)) {
    throw new ToolError(`Not an issue reference: ${ref} (use #N, N, or an issue URL)`);
  }
  const args = ['issue', 'view', target, '--json', 'number,title,body,url,state,labels'];
  if (repo) args.push('--repo', repo);
  const r = ghJson<Omit<GhIssue, 'labels'> & { labels: { name: string }[] }>(args, cwd);
  return { ...r, labels: r.labels.map((l) => l.name) };
}

export interface GhCheck {
  name: string;
  status: string;
  conclusion: string;
}

export interface GhPr {
  number: number;
  url: string;
  /** OPEN, MERGED, or CLOSED. */
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  title: string;
  /** Commit at the head of the PR branch as GitHub sees it. */
  headSha: string | null;
  /** MERGEABLE, CONFLICTING, or UNKNOWN (GitHub has not computed it yet). */
  mergeable: string | null;
  checks: GhCheck[];
}

const PR_FIELDS =
  'number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,title,statusCheckRollup';

interface RawPr {
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid?: string | null;
  mergeable?: string | null;
  title: string;
  statusCheckRollup?: RawCheck[] | null;
}

interface RawCheck {
  name?: string;
  context?: string;
  status?: string;
  state?: string;
  conclusion?: string;
}

function toPr(raw: RawPr): GhPr {
  const checks = (raw.statusCheckRollup ?? []).map((c) => ({
    name: c.name ?? c.context ?? 'check',
    status: c.status ?? c.state ?? '',
    conclusion: c.conclusion ?? c.state ?? '',
  }));
  const pr: GhPr = {
    number: raw.number,
    url: raw.url,
    state: raw.state,
    isDraft: raw.isDraft,
    baseRefName: raw.baseRefName,
    headRefName: raw.headRefName,
    headSha: raw.headRefOid ?? null,
    mergeable: raw.mergeable ?? null,
    title: raw.title,
    checks,
  };
  return pr;
}

/** All PRs (open, merged, closed) whose head is `branch`. */
export function listPrsForBranch(branch: string, cwd: string): GhPr[] {
  const raw = ghJson<RawPr[]>(
    ['pr', 'list', '--head', branch, '--state', 'all', '--json', PR_FIELDS],
    cwd,
  );
  return raw.map(toPr);
}

export function viewPr(urlOrNumber: string, cwd: string): GhPr {
  return toPr(ghJson<RawPr>(['pr', 'view', urlOrNumber, '--json', PR_FIELDS], cwd));
}

export interface CreatePrInput {
  base: string;
  head: string;
  title: string;
  bodyFile: string;
}

/** Always a draft. Returns the created PR's details. */
export function createDraftPr(input: CreatePrInput, cwd: string): GhPr {
  const out = gh(
    [
      'pr',
      'create',
      '--draft',
      '--base',
      input.base,
      '--head',
      input.head,
      '--title',
      input.title,
      '--body-file',
      input.bodyFile,
    ],
    cwd,
  );
  const url = out.split(/\s+/).find((w) => w.startsWith('https://'));
  if (!url) throw new ToolError(`gh pr create did not return a PR URL: ${out}`);
  return viewPr(url, cwd);
}

// ---------------------------------------------------------------------------------------------
// Checks for one exact commit. `gh pr view` only rolls up the current head; these read the
// check runs and commit statuses of a given SHA, so a verdict is never borrowed from another one.

interface RawCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url?: string | null;
  details_url?: string | null;
  app?: { slug?: string | null } | null;
  check_suite?: { id?: number | null } | null;
}

interface RawStatus {
  context: string;
  state: string;
  target_url?: string | null;
}

/**
 * Every page of a paginated endpoint, flattened with `pick`. `gh api --paginate --slurp` follows
 * the Link header and returns the pages as one JSON array (gh 2.41 or newer); a failed page fails
 * the whole call, so a partial list is never mistaken for the complete one.
 */
function allPages<T>(path: string, key: string, cwd: string): T[] {
  const pages = ghJson<Record<string, T[] | undefined>[]>(
    ['api', `${path}?per_page=100`, '--paginate', '--slurp'],
    cwd,
  );
  return pages.flatMap((page) => page[key] ?? []);
}

/** Check runs plus commit statuses reported for `sha`, as one list, across every page. */
export function listChecksFor(nameWithOwner: string, sha: string, cwd: string): CiCheck[] {
  const commit = `repos/${nameWithOwner}/commits/${sha}`;
  const runs = allPages<RawCheckRun>(`${commit}/check-runs`, 'check_runs', cwd);
  const statuses = allPages<RawStatus>(`${commit}/status`, 'statuses', cwd);
  const fromRuns: CiCheck[] = runs.map((r) => ({
    id: r.id,
    suiteId: typeof r.check_suite?.id === 'number' ? r.check_suite.id : null,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion ?? '',
    url: r.html_url ?? r.details_url ?? null,
    jobId: r.app?.slug === 'github-actions' ? r.id : null,
  }));
  const fromStatuses: CiCheck[] = statuses.map((s) => ({
    id: null,
    suiteId: null,
    name: s.context,
    status: s.state === 'pending' ? 'pending' : 'completed',
    conclusion: s.state === 'pending' ? '' : s.state,
    url: s.target_url ?? null,
    jobId: null,
  }));
  return [...fromRuns, ...fromStatuses];
}

/** Workflow run an Actions job belongs to, or null when GitHub could not tell us. */
export function actionsJobRunId(nameWithOwner: string, jobId: number, cwd: string): number | null {
  const r = optionalJson<{ run_id?: number } | null>(
    ['api', `repos/${nameWithOwner}/actions/jobs/${String(jobId)}`],
    cwd,
    null,
  );
  return typeof r?.run_id === 'number' ? r.run_id : null;
}

/**
 * `gh run rerun <id> --failed`: GitHub re-runs the failed jobs of that workflow run (and their
 * dependents) against the same commit. Returns null on success, else gh's message. It never
 * touches source, the branch, or the PR.
 */
export function rerunFailedJobs(nameWithOwner: string, runId: number, cwd: string): string | null {
  const r = ghResult(['run', 'rerun', String(runId), '--failed', '--repo', nameWithOwner], cwd);
  return r.status === 0 ? null : (r.stderr || r.stdout).trim() || `exit ${String(r.status)}`;
}

/**
 * `gh pr ready <url>`: take a draft PR out of draft once `orch gh ci` completed the job on a
 * passing verdict for its head. Returns null on success, else gh's message. Never merges.
 */
export function markPrReady(url: string, cwd: string): string | null {
  const r = ghResult(['pr', 'ready', url], cwd);
  return r.status === 0 ? null : (r.stderr || r.stdout).trim() || `exit ${String(r.status)}`;
}

/**
 * `gh pr merge <url> --merge --match-head-commit <head>`: a merge commit, refused by GitHub if the
 * head moved. Never deletes the branch, bypasses protection, or queues an auto-merge. Returns null
 * on success, else gh's message. Called only from the dashboard's human Merge action.
 */
export function mergePr(url: string, head: string, cwd: string): string | null {
  const r = ghResult(['pr', 'merge', url, '--merge', '--match-head-commit', head], cwd);
  return r.status === 0 ? null : (r.stderr || r.stdout).trim() || `exit ${String(r.status)}`;
}

/** 404 means "no such configuration", which is an answer; anything else is "could not tell". */
function optionalJson<T>(args: string[], cwd: string, onNotFound: T): T | null {
  const r = ghResult(args, cwd);
  if (r.status === 0) {
    try {
      return JSON.parse(r.stdout) as T;
    } catch {
      return null;
    }
  }
  return /HTTP 404|Not Found/i.test(r.stderr + r.stdout) ? onNotFound : null;
}

/**
 * Check names the base branch requires, from classic branch protection and rulesets. An empty
 * list means GitHub answered and requires nothing; null means it could not be determined.
 */
export function requiredChecksFor(
  nameWithOwner: string,
  base: string,
  cwd: string,
): string[] | null {
  const protection = optionalJson<{ contexts?: string[]; checks?: { context: string }[] } | null>(
    ['api', `repos/${nameWithOwner}/branches/${base}/protection/required_status_checks`],
    cwd,
    null,
  );
  const rules = optionalJson<
    { type: string; parameters?: { required_status_checks?: { context: string }[] } }[]
  >(['api', `repos/${nameWithOwner}/rules/branches/${base}`], cwd, []);
  if (protection === null && rules === null) return null;
  const names = new Set<string>();
  if (protection) {
    for (const c of protection.contexts ?? []) names.add(c);
    for (const c of protection.checks ?? []) names.add(c.context);
  }
  for (const rule of rules ?? []) {
    if (rule.type !== 'required_status_checks') continue;
    for (const c of rule.parameters?.required_status_checks ?? []) names.add(c.context);
  }
  return [...names];
}

/** Plain-text log of a GitHub Actions job, or null when it is not retrievable. */
export function actionsJobLog(nameWithOwner: string, jobId: number, cwd: string): string | null {
  const r = ghResult(['api', `repos/${nameWithOwner}/actions/jobs/${String(jobId)}/logs`], cwd);
  return r.status === 0 ? r.stdout : null;
}

/** Collapse a PR's checks into one status. */
export function summarizeChecks(checks: GhCheck[]): CiStatus {
  if (checks.length === 0) return 'none';
  const words = checks.map((c) => `${c.status} ${c.conclusion}`.toUpperCase());
  if (
    words.some((w) => /FAILURE|ERROR|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE/.test(w))
  ) {
    return 'failing';
  }
  if (words.some((w) => /PENDING|IN_PROGRESS|QUEUED|EXPECTED|WAITING|REQUESTED/.test(w))) {
    return 'pending';
  }
  return 'passing';
}

/** Workflow PR state for a GitHub PR; undefined only for a state GitHub does not document. */
export function prWorkflowState(pr: Pick<GhPr, 'state' | 'isDraft'>): PrState | undefined {
  if (pr.state === 'MERGED') return 'merged';
  if (pr.state === 'CLOSED') return 'closed';
  if (pr.state === 'OPEN') return pr.isDraft ? 'draft' : 'ready';
  return undefined;
}
