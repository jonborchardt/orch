/** `orch factory ...` handlers: the skill-facing commands. */
import { UsageError } from '../core/errors.ts';
import { newSessionId } from '../core/ownership.ts';
import { type Stage, STAGES } from '../core/workflow.ts';
import { cancelJob } from '../ops/actions.ts';
import { dispatchJob, listFactory } from '../ops/dispatch.ts';
import {
  checkReadonly,
  configPath,
  loadConfig,
  planJobFresh,
  resumeFactoryJob,
  startJob,
} from '../ops/factory.ts';
import { mergeAuthorization, setMergeAuthorization } from '../ops/merge.ts';
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
  ticket?: string;
}

export const FACTORY_HELP = `Usage: orch factory <command> [options]

  start   (--title <t> --description <d> | --issue <ref> [--title <t>] [--description <d>])
          [--ticket <id>] [--repo <path>] [--base <branch>] [--max-rounds <n>]
          [--session <name>] [--ui|--no-ui]
                              Create, claim, and give a worktree to a new job; print the plan + token.
                              A job needs a non-blank description: --description, or one fetched
                              from --issue (its URL and body) when --description is omitted.
                              --ticket links the job to that ticket and marks it in progress in
                              the same transaction (refused while the ticket is blocked or already
                              has an unfinished job); its title and body are the defaults
  dispatch (--title <t> --description <d> | --issue <ref> | --ticket <id>) [--title <t>]
          [--description <d>] [--repo <path>] [--base <branch>] [--max-rounds <n>]
          [--session <name>]
                              Create a job for another (or this) repository that an independent
                              session will run; print what that session needs (workspace, prompt).
                              Refused unless the repository's factory.json is ready. Nothing is
                              claimed, no worktree is made, no session is started.
  list [--repo <path|identity>]
                              One row per job: stage, status, action (human/resume/wait/none),
                              PR, age, title; --json adds owner, session, resume command
  next <id> [--ui|--no-ui]    What to do now (read-only): step, agents (with models), artifacts,
                              exact commands. status <id> is an alias of next with the same options
  resume <id> [--session <name>] [--to <stage>] [--force] [--ui|--no-ui] [--adopt <worktree>]
                              Adopt an interrupted or orphaned job from persisted state; --adopt
                              records an existing worktree of the repository (the one this session
                              runs in) when the job has none yet
  cancel <id> --reason <r> [--session <name>] [--force]
                              Cancel the job in one short episode as this session; exit 4 when
                              another session holds a live lease, unless --force takes it over
  check-readonly <id> --fingerprint <f>
                              Exit 1 if the worktree changed since the plan was taken
  config                      Effective role -> model configuration and its file location
  config merge enable|disable|status [--repo <path>]
                              Whether orch job merge may merge PRs of that repository (default:
                              this one) without a human click. Off until enabled; stored per
                              repository identity in your own factory.json, never in a repository.
                              It lifts no gate: every merge check still has to pass

--session defaults to $ORCH_SESSION, else to a newly generated unique id. start, dispatch, resume,
and cancel print the session they ran as; pass it back as --session on later commands.
The plan's commands carry --token <token> explicitly.
`;

export function runFactory(
  store: Store,
  args: string[],
  o: FactoryOptions,
  env = process.env,
): unknown {
  const [cmd, id] = args;
  // An empty --session or $ORCH_SESSION counts as absent.
  const given = [o.session, env['ORCH_SESSION']].find((s) => s !== undefined && s !== '');
  const ui = o.ui ? true : o['no-ui'] ? false : undefined;
  const needId = () => need(id, '<job-id>', FACTORY_HELP);
  const needSession = (): string => {
    if (!given) return newSessionId();
    if (!/^[\w.:-]{1,64}$/.test(given)) {
      throw new UsageError('--session may contain letters, digits, . _ : - (max 64)');
    }
    return given;
  };
  const maxRounds = () => int(o['max-rounds'], '--max-rounds', 1);
  switch (cmd) {
    // start, dispatch, resume, and cancel return the session they ran as, so a caller that let it
    // be generated can pass it back on later commands.
    case 'start': {
      const session = needSession();
      const started = startJob(store, {
        title: o.title,
        description: o.description,
        issue: o.issue,
        ticket: o.ticket,
        repo: o.repo,
        base: o.base,
        maxRounds: maxRounds(),
        session,
        cwd: process.cwd(),
        ui,
      });
      return { session, ...started };
    }
    case 'dispatch': {
      if (!o.title && !o.issue && !o.ticket) {
        throw new UsageError('dispatch needs --title <t>, --issue <ref>, or --ticket <id>');
      }
      const session = needSession();
      const dispatched = dispatchJob(store, {
        title: o.title,
        description: o.description,
        issue: o.issue,
        ticket: o.ticket,
        repo: o.repo,
        base: o.base,
        maxRounds: maxRounds(),
        session,
        cwd: process.cwd(),
      });
      return { session, ...dispatched };
    }
    case 'list':
      return listFactory(store, { repo: o.repo });
    case 'next':
    case 'status':
      return planJobFresh(store, needId(), { ui });
    case 'resume': {
      const jobId = needId();
      const session = needSession();
      const resumed = resumeFactoryJob(store, jobId, {
        session,
        to: oneOf<Stage>(o.to, STAGES, '--to'),
        force: o.force,
        ui,
        adopt: o.adopt,
      });
      return { session, ...resumed };
    }
    case 'cancel': {
      const jobId = needId();
      if (o.reason === undefined || o.reason.trim() === '') {
        throw new UsageError('cancel needs --reason "<why>"; it is recorded with the job');
      }
      const session = needSession();
      return { session, ...cancelJob(store, jobId, { session, reason: o.reason, force: o.force }) };
    }
    case 'check-readonly':
      return checkReadonly(store, needId(), need(o.fingerprint, '--fingerprint <f>'));
    case 'config': {
      if (id === undefined) return { file: configPath(store), ...loadConfig(store) };
      const action = args[2];
      if (id !== 'merge' || !['enable', 'disable', 'status'].includes(action ?? '')) {
        throw new UsageError(
          'Usage: orch factory config [merge enable|disable|status [--repo <path>]]',
        );
      }
      const path = o.repo ?? process.cwd();
      return action === 'status'
        ? mergeAuthorization(store, path)
        : setMergeAuthorization(store, path, action === 'enable');
    }
    case undefined:
      throw new UsageError(FACTORY_HELP);
    default:
      throw new UsageError(`Unknown factory command: ${cmd}\n\n${FACTORY_HELP}`);
  }
}
