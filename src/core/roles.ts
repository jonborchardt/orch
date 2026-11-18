/**
 * Factory roles: which subagent plays each part, its default model, and when it applies. Model
 * assignments are data here and overridable from <config>/factory.json, never spread through code.
 */
import { ValidationError } from './errors.ts';

export const MODELS = ['opus', 'sonnet', 'haiku', 'inherit'] as const;
export type Model = (typeof MODELS)[number];

export type RoleKind = 'spec' | 'spec-challenge' | 'build' | 'simplify' | 'review' | 'approve';

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
  {
    name: 'web-platform',
    agent: 'factory-reviewer-web-platform',
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
  models: Partial<Record<string, Model>>;
  uiPatterns: string[];
  /** Default review rounds for new jobs. */
  maxRounds: number;
  /** Default CI repair cycles (failed required checks -> builder -> re-review -> push) per job. */
  maxCiRepairs: number;
}

export const DEFAULT_CONFIG: FactoryConfig = {
  models: {},
  uiPatterns: DEFAULT_UI_PATTERNS,
  maxRounds: 3,
  maxCiRepairs: 2,
};

/** Validate a parsed factory.json. Unknown keys are rejected so typos do not pass silently. */
export function parseConfig(raw: unknown): FactoryConfig {
  if (raw === undefined || raw === null) return DEFAULT_CONFIG;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError('factory.json must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const config: FactoryConfig = { ...DEFAULT_CONFIG, models: {} };
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
          if (typeof model !== 'string' || !MODELS.includes(model as Model)) {
            throw new ValidationError(
              `factory.json: model for "${role}" must be one of ${MODELS.join(', ')}`,
            );
          }
          config.models[role] = model as Model;
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
      default:
        throw new ValidationError(`factory.json: unknown key "${key}"`);
    }
  }
  return config;
}

/** Apply model overrides. */
export function resolveRoles(config: FactoryConfig): Role[] {
  return ROLES.map((r) => ({ ...r, model: config.models[r.name] ?? r.model }));
}

/** True when any changed file looks like rendered UI. */
export function detectUi(files: readonly string[], patterns: readonly string[]): boolean {
  const regexes = patterns.map((p) => new RegExp(p, 'i'));
  return files.some((f) => regexes.some((re) => re.test(f)));
}

/** Reviewers for a round: the always-on ones plus UI reviewers when the change renders. */
export function reviewersFor(roles: readonly Role[], ui: boolean): Role[] {
  return roles.filter((r) => r.kind === 'review' && (ui || !r.ui));
}
