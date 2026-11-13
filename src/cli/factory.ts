/** `orch factory ...` handlers: the skill-facing commands. */
import { STAGES, type Stage } from '../core/workflow.ts';
import {
  checkReadonly,
  configPath,
  loadConfig,
  planJob,
  resumeFactoryJob,
  startJob,
} from '../ops/factory.ts';
import type { Store } from '../storage/client.ts';
import { UsageError } from './output.ts';

export interface FactoryOptions {
  title?: string;
  description?: string;
  issue?: string;
  repo?: string;
  base?: string;
  'max-rounds'?: string;
  session?: string;
  to?: string;
  force?: boolean;
  ui?: boolean;
  'no-ui'?: boolean;
  fingerprint?: string;
}

export const FACTORY_HELP = `Usage: orch factory <command> [options]

  start   --title <t> | --issue <ref>  [--description <d>] [--repo <path>] [--base <branch>]
          [--max-rounds <n>] --session <name> [--ui|--no-ui]
                              Create, claim, and give a worktree to a new job; print the plan + token
  next <id> [--ui|--no-ui]    What to do now: step, agents (with models), artifacts, exact commands
  status <id>                 Same as next (read-only; for humans and dashboards)
  resume <id> --session <name> [--to <stage>] [--force] [--ui|--no-ui]
                              Adopt an interrupted or orphaned job from persisted state
  check-readonly <id> --fingerprint <f>
                              Exit 1 if the worktree changed since the plan was taken
  config                      Effective role -> model configuration and its file location

--session defaults to $ORCH_SESSION. The plan's commands expect the token in $ORCH_TOKEN.
`;

export function runFactory(
  store: Store,
  args: string[],
  o: FactoryOptions,
  env = process.env,
): unknown {
  const [cmd, id] = args;
  const session = o.session ?? env['ORCH_SESSION'];
  const ui = o.ui ? true : o['no-ui'] ? false : undefined;
  const needId = (): string => {
    if (!id) throw new UsageError(`Missing required <job-id>\n\n${FACTORY_HELP}`);
    return id;
  };
  const needSession = (): string => {
    if (!session) throw new UsageError('Missing required --session <name> (or $ORCH_SESSION)');
    if (!/^[\w.:-]{1,64}$/.test(session)) {
      throw new UsageError('--session may contain letters, digits, . _ : - (max 64)');
    }
    return session;
  };
  switch (cmd) {
    case 'start': {
      let maxRounds: number | undefined;
      if (o['max-rounds'] !== undefined) {
        maxRounds = Number(o['max-rounds']);
        if (!Number.isInteger(maxRounds) || maxRounds < 1) {
          throw new UsageError('--max-rounds must be a positive integer');
        }
      }
      return startJob(store, {
        title: o.title,
        description: o.description,
        issue: o.issue,
        repo: o.repo,
        base: o.base,
        maxRounds,
        session: needSession(),
        cwd: process.cwd(),
        ui,
      });
    }
    case 'next':
    case 'status':
      return planJob(store, needId(), { ui });
    case 'resume': {
      let to: Stage | undefined;
      if (o.to !== undefined) {
        if (!STAGES.includes(o.to as Stage)) {
          throw new UsageError(`--to must be one of ${STAGES.join(', ')}`);
        }
        to = o.to as Stage;
      }
      return resumeFactoryJob(store, needId(), { session: needSession(), to, force: o.force, ui });
    }
    case 'check-readonly': {
      if (!o.fingerprint) throw new UsageError('Missing required --fingerprint <f>');
      return checkReadonly(store, needId(), o.fingerprint);
    }
    case 'config':
      return { file: configPath(store), ...loadConfig(store) };
    case undefined:
      throw new UsageError(FACTORY_HELP);
    default:
      throw new UsageError(`Unknown factory command: ${cmd}\n\n${FACTORY_HELP}`);
  }
}
