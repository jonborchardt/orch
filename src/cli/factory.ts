/** `orch factory ...` handlers: the skill-facing commands. */
import { UsageError } from '../core/errors.ts';
import { type Stage, STAGES } from '../core/workflow.ts';
import { cancelJob } from '../ops/actions.ts';
import { dispatchJob, listFactory } from '../ops/dispatch.ts';
import {
  checkReadonly,
  configPath,
  loadConfig,
  planJob,
  resumeFactoryJob,
  startJob,
} from '../ops/factory.ts';
import type { Store } from '../storage/client.ts';
import { int, need, oneOf } from './args.ts';

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
  reason?: string;
  ui?: boolean;
  'no-ui'?: boolean;
  fingerprint?: string;
  adopt?: string;
}

export const FACTORY_HELP = `Usage: orch factory <command> [options]

  start   --title <t> | --issue <ref>  [--description <d>] [--repo <path>] [--base <branch>]
          [--max-rounds <n>] --session <name> [--ui|--no-ui]
                              Create, claim, and give a worktree to a new job; print the plan + token
  dispatch --title <t> | --issue <ref> [--description <d>] [--repo <path>] [--base <branch>]
          [--max-rounds <n>] --session <name>
                              Create a job for another (or this) repository that an independent
                              session will run; print what that session needs (workspace, prompt).
                              Refused unless the repository's factory.json is ready. Nothing is
                              claimed, no worktree is made, no session is started.
  list [--repo <path|identity>]
                              One row per job: stage, status, action (human/resume/wait/none),
                              PR, age, title; --json adds owner, session, resume command
  next <id> [--ui|--no-ui]    What to do now: step, agents (with models), artifacts, exact commands
  status <id>                 Same as next (read-only; for humans and dashboards)
  resume <id> --session <name> [--to <stage>] [--force] [--ui|--no-ui] [--adopt <worktree>]
                              Adopt an interrupted or orphaned job from persisted state; --adopt
                              records an existing worktree of the repository (the one this session
                              runs in) when the job has none yet
  cancel <id> --reason <r> --session <name> [--force]
                              Cancel the job in one short episode as this session; exit 4 when
                              another session holds a live lease, unless --force takes it over
  check-readonly <id> --fingerprint <f>
                              Exit 1 if the worktree changed since the plan was taken
  config                      Effective role -> model configuration and its file location

--session defaults to $ORCH_SESSION. The plan's commands carry --token <token> explicitly.
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
  const needId = () => need(id, '<job-id>', FACTORY_HELP);
  const needSession = (): string => {
    if (!session) throw new UsageError('Missing required --session <name> (or $ORCH_SESSION)');
    if (!/^[\w.:-]{1,64}$/.test(session)) {
      throw new UsageError('--session may contain letters, digits, . _ : - (max 64)');
    }
    return session;
  };
  const maxRounds = () => int(o['max-rounds'], '--max-rounds', 1);
  switch (cmd) {
    case 'start':
      return startJob(store, {
        title: o.title,
        description: o.description,
        issue: o.issue,
        repo: o.repo,
        base: o.base,
        maxRounds: maxRounds(),
        session: needSession(),
        cwd: process.cwd(),
        ui,
      });
    case 'dispatch':
      if (!o.title && !o.issue) throw new UsageError('dispatch needs --title <t> or --issue <ref>');
      return dispatchJob(store, {
        title: o.title,
        description: o.description,
        issue: o.issue,
        repo: o.repo,
        base: o.base,
        maxRounds: maxRounds(),
        session: needSession(),
        cwd: process.cwd(),
      });
    case 'list':
      return listFactory(store, { repo: o.repo });
    case 'next':
    case 'status':
      return planJob(store, needId(), { ui });
    case 'resume':
      return resumeFactoryJob(store, needId(), {
        session: needSession(),
        to: oneOf<Stage>(o.to, STAGES, '--to'),
        force: o.force,
        ui,
        adopt: o.adopt,
      });
    case 'cancel': {
      const jobId = needId();
      if (o.reason === undefined || o.reason.trim() === '') {
        throw new UsageError('cancel needs --reason "<why>"; it is recorded with the job');
      }
      return cancelJob(store, jobId, { session: needSession(), reason: o.reason, force: o.force });
    }
    case 'check-readonly':
      return checkReadonly(store, needId(), need(o.fingerprint, '--fingerprint <f>'));
    case 'config':
      return { file: configPath(store), ...loadConfig(store) };
    case undefined:
      throw new UsageError(FACTORY_HELP);
    default:
      throw new UsageError(`Unknown factory command: ${cmd}\n\n${FACTORY_HELP}`);
  }
}
