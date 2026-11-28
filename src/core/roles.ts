/**
 * Factory roles: which subagent plays each part, its default model, and when it applies. Model
 * assignments are data here and overridable from <config>/factory.json, never spread through code.
 */
import { createHash } from 'node:crypto';

import { ValidationError } from './errors.ts';
import { classifyPath } from './sensitive.ts';

export const MODELS = ['opus', 'sonnet', 'haiku', 'fable', 'inherit'] as const;
export type Model = (typeof MODELS)[number];

export type RoleKind =
  'spec' | 'spec-challenge' | 'build' | 'fast-build' | 'simplify' | 'review' | 'approve';

export interface Role {
  /** Short name used in `orch job review record --reviewer <name>` and review-<name>.md. */
  name: string;
  /** Claude Code subagent name (agents/<agent>.md). */
  agent: string;
  model: Model;
  kind: RoleKind;
  /** Only runs when the change touches rendered UI. */
  ui?: boolean;
}

export const ROLES: readonly Role[] = [
  { name: 'spec-writer', agent: 'factory-spec-writer', model: 'opus', kind: 'spec' },
  {
    name: 'spec-challenger',
    agent: 'factory-spec-challenger',
    model: 'sonnet',
    kind: 'spec-challenge',
  },
  { name: 'builder', agent: 'factory-builder', model: 'opus', kind: 'build' },
  // The one agent of a fast job (core/workflow.ts JOB_MODES): build, verify, build.md.
  { name: 'fast-builder', agent: 'factory-fast-builder', model: 'opus', kind: 'fast-build' },
  { name: 'simplifier', agent: 'factory-simplifier', model: 'sonnet', kind: 'simplify' },
  { name: 'security', agent: 'factory-reviewer-security', model: 'opus', kind: 'review' },
  { name: 'correctness', agent: 'factory-reviewer-correctness', model: 'sonnet', kind: 'review' },
  { name: 'code-quality', agent: 'factory-reviewer-code-quality', model: 'sonnet', kind: 'review' },
  {
    name: 'ui-design',
    agent: 'factory-reviewer-ui-design',
    model: 'sonnet',
    kind: 'review',
    ui: true,
  },
  { name: 'ux', agent: 'factory-reviewer-ux', model: 'sonnet', kind: 'review', ui: true },
  {
    name: 'accessibility',
    agent: 'factory-reviewer-accessibility',
    model: 'sonnet',
    kind: 'review',
    ui: true,
  },
  { name: 'approver', agent: 'factory-approver', model: 'opus', kind: 'approve' },
];

/** File extensions that mean "rendered UI changed" unless the config says otherwise. */
export const DEFAULT_UI_PATTERNS = [
  '\\.(tsx|jsx|vue|svelte|astro|html|htm|css|scss|sass|less|styl)$',
  '(^|/)(public|static|assets)/.*\\.(svg|png|jpg|jpeg|webp|gif)$',
];

export interface FactoryConfig {
  /** A fixed model, or a pool orch draws one model from per job (`drawModel`). */
  models: Partial<Record<string, Model | Model[]>>;
  uiPatterns: string[];
  /** Default review rounds for new jobs. */
  maxRounds: number;
  /** Default CI repair cycles (failed required checks -> builder -> re-review -> push) per job. */
  maxCiRepairs: number;
  /**
   * Repository identities (`github.com/owner/name`) where `orch job merge` may merge without a
   * human click. Empty by default; changed with `orch factory config merge enable|disable`.
   */
  mergeRepos: string[];
  /**
   * Permission arguments `orch start` passes to its `claude -p` child, replacing
   * DEFAULT_RUNNER_CLAUDE_ARGS. The additions below still apply on top (`runnerArgsFor`).
   */
  runnerClaudeArgs: string[];
  /** Tool rules added to the session's `--allowedTools` for every repository. */
  extraAllowedTools: string[];
  /** Tool rules added only for the repository with that identity (`github.com/owner/name`). */
  repoAllowedTools: Record<string, string[]>;
}

/**
 * The smallest set a headless /factory session was found to need: classifier-approved edits plus
 * the shell commands the skill and its builder run. Never a blanket permission bypass.
 */
export const DEFAULT_RUNNER_CLAUDE_ARGS: readonly string[] = [
  '--permission-mode',
  'auto',
  '--allowedTools',
  'Bash(orch *)',
  'Bash(git *)',
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(node *)',
  'Bash(cd *)',
];

export const DEFAULT_CONFIG: FactoryConfig = {
  models: {},
  uiPatterns: DEFAULT_UI_PATTERNS,
  maxRounds: 3,
  maxCiRepairs: 2,
  mergeRepos: [],
  runnerClaudeArgs: [...DEFAULT_RUNNER_CLAUDE_ARGS],
  extraAllowedTools: [],
  repoAllowedTools: {},
};

/** Tool rules: non-empty strings that never start with "-", so a rule cannot become a flag. */
function toolRules(value: unknown, key: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((v) => typeof v === 'string' && v !== '' && !v.startsWith('-'))
  ) {
    throw new ValidationError(
      `factory.json: "${key}" must be an array of tool rules (non-empty strings not starting with "-")`,
    );
  }
  return value as string[];
}

const ALLOWED_TOOLS_FLAGS = ['--allowedTools', '--allowed-tools'];

/** Index just past the last value of the last `--allowedTools` group, or -1 without one. */
function allowedToolsEnd(args: readonly string[]): number {
  let end = -1;
  for (let i = 0; i < args.length; i++) {
    if (!ALLOWED_TOOLS_FLAGS.includes(args[i] ?? '')) continue;
    end = i + 1;
    while (end < args.length && !(args[end] ?? '').startsWith('-')) end++;
  }
  return end;
}

/** The values of every `--allowedTools` (or `--allowed-tools`) group in `args`, in order. */
export function allowedToolsOf(args: readonly string[]): string[] {
  const tools: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!ALLOWED_TOOLS_FLAGS.includes(args[i] ?? '')) continue;
    for (let j = i + 1; j < args.length && !(args[j] ?? '').startsWith('-'); j++) {
      tools.push(args[j] ?? '');
    }
  }
  return tools;
}

/**
 * The `claude -p` arguments for a session in repository `repo`: `runnerClaudeArgs` (the defaults
 * unless overridden), then `extraAllowedTools`, then `repoAllowedTools[repo]`, skipping rules
 * already allowed, inserted after the last `--allowedTools` value (or appended under a new
 * `--allowedTools` when the base has none). Pure: same config and identity, same array.
 */
export function runnerArgsFor(config: FactoryConfig, repo: string): string[] {
  const base = config.runnerClaudeArgs;
  const allowed = new Set(allowedToolsOf(base));
  const additions: string[] = [];
  for (const rule of [...config.extraAllowedTools, ...(config.repoAllowedTools[repo] ?? [])]) {
    if (allowed.has(rule)) continue;
    allowed.add(rule);
    additions.push(rule);
  }
  if (additions.length === 0) return [...base];
  const end = allowedToolsEnd(base);
  if (end === -1) return [...base, '--allowedTools', ...additions];
  return [...base.slice(0, end), ...additions, ...base.slice(end)];
}

/**
 * The executables in `executables` a session with `args` may not run: neither a blanket `Bash`,
 * `Bash(*)`, `Bash(E *)` nor `Bash(E:*)` is allowed, and permissions are not bypassed.
 */
export function uncoveredExecutables(
  args: readonly string[],
  executables: readonly string[],
): string[] {
  const bypass =
    args.includes('--dangerously-skip-permissions') ||
    args.some((a, i) => a === '--permission-mode' && args[i + 1] === 'bypassPermissions');
  if (bypass) return [];
  const allowed = new Set(allowedToolsOf(args));
  if (allowed.has('Bash') || allowed.has('Bash(*)')) return [];
  return [...new Set(executables)].filter(
    (e) => !allowed.has(`Bash(${e} *)`) && !allowed.has(`Bash(${e}:*)`),
  );
}

/** Validate a parsed factory.json. Unknown keys are rejected so typos do not pass silently. */
export function parseConfig(raw: unknown): FactoryConfig {
  if (raw === undefined || raw === null) return DEFAULT_CONFIG;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('factory.json must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const config: FactoryConfig = { ...DEFAULT_CONFIG, models: {}, repoAllowedTools: {} };
  for (const [key, value] of Object.entries(obj)) {
    switch (key) {
      case 'models': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new ValidationError('factory.json: "models" must be an object');
        }
        for (const [role, model] of Object.entries(value as Record<string, unknown>)) {
          if (!ROLES.some((r) => r.name === role)) {
            throw new ValidationError(
              `factory.json: unknown role "${role}" (known: ${ROLES.map((r) => r.name).join(', ')})`,
            );
          }
          const pool: unknown[] = Array.isArray(model) ? model : [model];
          const known = (m: unknown) => typeof m === 'string' && MODELS.includes(m as Model);
          if (pool.length === 0 || !pool.every(known) || new Set(pool).size !== pool.length) {
            throw new ValidationError(
              `factory.json: model for "${role}" must be one of ${MODELS.join(', ')}, or a non-empty array of distinct ones`,
            );
          }
          config.models[role] = model as Model | Model[];
        }
        break;
      }
      case 'uiPatterns': {
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
          throw new ValidationError('factory.json: "uiPatterns" must be an array of strings');
        }
        for (const p of value) {
          try {
            new RegExp(p);
          } catch {
            throw new ValidationError(`factory.json: invalid uiPatterns regex ${p}`);
          }
        }
        config.uiPatterns = value;
        break;
      }
      case 'maxRounds': {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 10) {
          throw new ValidationError('factory.json: "maxRounds" must be an integer from 1 to 10');
        }
        config.maxRounds = value;
        break;
      }
      case 'maxCiRepairs': {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 10) {
          throw new ValidationError('factory.json: "maxCiRepairs" must be an integer from 0 to 10');
        }
        config.maxCiRepairs = value;
        break;
      }
      case 'mergeRepos': {
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v !== '')) {
          throw new ValidationError(
            'factory.json: "mergeRepos" must be an array of repository identities',
          );
        }
        config.mergeRepos = value as string[];
        break;
      }
      case 'runnerClaudeArgs': {
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v !== '')) {
          throw new ValidationError(
            'factory.json: "runnerClaudeArgs" must be an array of claude command-line arguments',
          );
        }
        config.runnerClaudeArgs = value as string[];
        break;
      }
      case 'extraAllowedTools':
        config.extraAllowedTools = toolRules(value, key);
        break;
      case 'repoAllowedTools': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new ValidationError(
            'factory.json: "repoAllowedTools" must be an object of repository identity -> tool rules',
          );
        }
        for (const [repo, rules] of Object.entries(value as Record<string, unknown>)) {
          config.repoAllowedTools[repo] = toolRules(rules, `repoAllowedTools.${repo}`);
        }
        break;
      }
      default:
        throw new ValidationError(`factory.json: unknown key "${key}"`);
    }
  }
  return config;
}

/** The pool a role draws from: the configured model or array, else the role's default. */
export function poolFor(models: FactoryConfig['models'], role: Role): Model[] {
  const m = models[role.name] ?? role.model;
  return Array.isArray(m) ? m : [m];
}

/**
 * One model from a role's pool for a job: uniform, and fixed for the job because it depends only
 * on a stable hash of the job id and role (never Math.random or a seeded PRNG).
 */
export function drawModel(jobId: string, role: string, pool: readonly Model[]): Model {
  const n = createHash('sha256').update(`${jobId}:${role}`).digest().readUInt32BE(0);
  const m = pool[n % pool.length];
  if (m === undefined) throw new ValidationError(`Empty model pool for ${role}`);
  return m;
}

/** Whose work a role judges: its drawn model is compared with that author's (`sameAsAuthor`). */
export function authorOf(role: Role): string | null {
  if (role.kind === 'spec-challenge') return 'spec-writer';
  if (role.kind === 'simplify' || role.kind === 'review' || role.kind === 'approve')
    return 'builder';
  return null;
}

/** The `models.drawn` payload's `roles`: each role's drawn model, `sameAsAuthor` where it has one. */
export type DrawnModels = Record<string, { model: Model; sameAsAuthor?: boolean }>;

/** Draw every role in ROLES for a new job. `inherit` equals `inherit`: orch sees only the strings. */
export function drawModels(jobId: string, models: FactoryConfig['models']): DrawnModels {
  const drawn: DrawnModels = {};
  for (const r of ROLES) drawn[r.name] = { model: drawModel(jobId, r.name, poolFor(models, r)) };
  for (const r of ROLES) {
    const author = authorOf(r);
    const entry = drawn[r.name];
    if (author && entry) entry.sameAsAuthor = entry.model === drawn[author]?.model;
  }
  return drawn;
}

/** The recorded draw from a job's `models.drawn` event; null for a job created before pools. */
export function drawnModelsOf(
  events: readonly { type: string; payload: Record<string, unknown> }[],
): DrawnModels | null {
  const roles = events.find((e) => e.type === 'models.drawn')?.payload['roles'];
  return roles && typeof roles === 'object' ? (roles as DrawnModels) : null;
}

/**
 * Models with an allowance of their own, apart from the account's. Only their limit is
 * model-specific (decision 2026-11-26-per-model-limit-falls-back); any other is account-wide.
 */
export const OWN_ALLOWANCE_MODELS: readonly Model[] = ['fable'];

/**
 * The model a role runs when `drawn` may be exhausted: `drawn` itself while it is not, else the
 * next model after it in the pool (wrapping) that is not exhausted, else null (no alternative).
 */
export function fallbackModel(
  pool: readonly Model[],
  drawn: Model,
  exhausted: ReadonlySet<Model>,
): Model | null {
  if (!exhausted.has(drawn)) return drawn;
  const start = pool.indexOf(drawn) + 1;
  for (let i = 0; i < pool.length; i++) {
    const m = pool[(start + i) % pool.length];
    if (m !== undefined && !exhausted.has(m)) return m;
  }
  return null;
}

/**
 * The models whose own allowance is spent at `now`: `models.limit` payloads whose `until` (an ISO
 * time) is still ahead, plus `session`, the limits with no known reset the controller remembers.
 */
export function exhaustedModels(
  records: readonly { model?: unknown; until?: unknown }[],
  now: string,
  session: Iterable<Model> = [],
): Set<Model> {
  const out = new Set<Model>(session);
  for (const r of records) {
    const { model, until } = r;
    if (typeof until !== 'string' || until <= now) continue;
    if (OWN_ALLOWANCE_MODELS.includes(model as Model)) out.add(model as Model);
  }
  return out;
}

/** One recorded `models.fallback` event: from when (`at`) `role` runs `to` instead of `from`. */
export interface Fallback {
  role: string;
  from: Model;
  to: Model;
  at: string;
}

/** A job's `models.fallback` events, oldest first, whatever order `events` is in. */
export function fallbacksOf(
  events: readonly {
    id: number;
    type: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }[],
): Fallback[] {
  return events
    .filter((e) => e.type === 'models.fallback')
    .sort((a, b) => a.id - b.id)
    .map((e) => ({
      role: String(e.payload['role']),
      from: e.payload['from'] as Model,
      to: e.payload['to'] as Model,
      at: e.createdAt,
    }));
}

/**
 * The model `role` had at time `at` (now when omitted): its drawn one before its first fallback,
 * then the latest fallback's `to`. Null when nothing is recorded (legacy jobs).
 */
export function modelAt(
  drawn: DrawnModels | null,
  fallbacks: readonly Fallback[],
  role: string,
  at?: string,
): Model | null {
  const last = fallbacks.filter((f) => f.role === role && (at === undefined || f.at <= at)).at(-1);
  return last?.to ?? drawn?.[role]?.model ?? null;
}

/**
 * A judging role's model at `at` and whether it was its author's then. A job without fallbacks
 * keeps the draw's own `sameAsAuthor`.
 */
export function judgeAt(
  drawn: DrawnModels | null,
  fallbacks: readonly Fallback[],
  role: string,
  at?: string,
): { model: Model | null; sameAsAuthor: boolean | null } {
  const model = modelAt(drawn, fallbacks, role, at);
  if (fallbacks.length === 0) return { model, sameAsAuthor: drawn?.[role]?.sameAsAuthor ?? null };
  const r = ROLES.find((x) => x.name === role);
  const author = r ? authorOf(r) : null;
  return {
    model,
    sameAsAuthor:
      model !== null && author !== null ? model === modelAt(drawn, fallbacks, author, at) : null,
  };
}

/**
 * The fallbacks a job needs while `exhausted` holds, all or nothing: one per role whose model is
 * exhausted, or null when any such role has no other model in its pool (the account-wide path).
 * `roles` carry the job's effective models (`resolveRoles`), already narrowed to its mode.
 */
export function planFallbacks(
  roles: readonly Role[],
  models: FactoryConfig['models'],
  exhausted: ReadonlySet<Model>,
): { role: string; from: Model; to: Model }[] | null {
  const out: { role: string; from: Model; to: Model }[] = [];
  for (const r of roles) {
    const to = fallbackModel(poolFor(models, r), r.model, exhausted);
    if (to === null) return null;
    if (to !== r.model) out.push({ role: r.name, from: r.model, to });
  }
  return out;
}

/**
 * Roles with a job's models: its recorded draw, else (legacy jobs) a draw from the config; then
 * the recorded fallbacks, the latest per role winning.
 */
export function resolveRoles(
  config: FactoryConfig,
  jobId: string,
  drawn: DrawnModels | null = null,
  fallbacks: readonly Fallback[] = [],
): Role[] {
  return ROLES.map((r) => ({
    ...r,
    model: modelAt(drawn, fallbacks, r.name) ?? drawModel(jobId, r.name, poolFor(config.models, r)),
  }));
}

/**
 * True when any changed file looks like rendered UI. Test files never count, whichever pattern
 * matches them: a path `classifyPath` (core/sensitive.ts) labels `tests` or `test-config` is
 * skipped, so that classifier stays the one definition of "test file".
 */
export function detectUi(files: readonly string[], patterns: readonly string[]): boolean {
  const regexes = patterns.map((p) => new RegExp(p, 'i'));
  return files.some((f) => {
    const kind = classifyPath(f)?.kind;
    if (kind === 'tests' || kind === 'test-config') return false;
    return regexes.some((re) => re.test(f));
  });
}

/** Reviewers for a round: the always-on ones plus UI reviewers when the change renders. */
export function reviewersFor(roles: readonly Role[], ui: boolean): Role[] {
  return roles.filter((r) => r.kind === 'review' && (ui || !r.ui));
}
