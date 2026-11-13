/** `orch job ...` handlers: parse options, call storage, return data for printing. */
import { existsSync } from 'node:fs';

import { UsageError } from '../core/errors.ts';
import { jobArtifactDir } from '../core/paths.ts';
import {
  type Action,
  ACTIONS,
  describeNext,
  PR_STATES,
  type PrState,
  type Stage,
  STAGES,
  type Status,
  STATUSES,
  type Verdict,
  VERDICTS,
} from '../core/workflow.ts';
import { describeRepo } from '../git/repo.ts';
import { addArtifact, recordVerdict, transitionGuarded } from '../ops/gates.ts';
import type { Store } from '../storage/client.ts';
import { listEvents } from '../storage/events.ts';
import {
  claimJob,
  createJob,
  getJob,
  jobDetail,
  listJobs,
  recordPr,
  releaseJob,
  resumeJob,
} from '../storage/jobs.ts';
import type { Job } from '../storage/schema.ts';
import { authFrom, int, need, oneOf } from './args.ts';

export interface JobOptions {
  title?: string;
  description?: string;
  issue?: string;
  repo?: string;
  base?: string;
  'max-rounds'?: string;
  session?: string;
  lease?: string;
  force?: boolean;
  token?: string;
  revision?: string;
  to?: string;
  reason?: string;
  reviewer?: string;
  verdict?: string;
  artifact?: string;
  summary?: string;
  url?: string;
  state?: string;
  status?: string;
  stage?: string;
  limit?: string;
  replace?: boolean;
}

export const JOB_HELP = `Usage: orch job <command> [options]

  create    --title <t> [--description <d>] [--issue <ref>] [--repo <path>] [--base <branch>]
            [--max-rounds <n>]
  list      [--repo <path|identity>] [--status <s>] [--stage <s>]
  show <id>
  events <id> [--limit <n>]
  claim <id> --session <name> [--lease <minutes>] [--force]
  release <id> --token <t>
  resume <id> --session <name> [--to <stage>] [--force]
  transition <id> <${ACTIONS.join('|')}> --token <t> [--to <stage>] [--reason <r>]
            [--revision <n>]
  artifact add <id> <relative-path> --token <t> [--replace]
  review record <id> --reviewer <name> [--verdict pass|changes] [--artifact <path>]
            [--summary <s>] --token <t>
  pr <id> --url <url> --state <${PR_STATES.join('|')}> --token <t>

--token defaults to $ORCH_TOKEN, --session to $ORCH_SESSION. Add --json for machine output.
`;

function summary(job: Job, store: Store, extra: Record<string, unknown> = {}) {
  return {
    jobId: job.id,
    stage: job.stage,
    status: job.status,
    revision: job.revision,
    ...extra,
    next: describeNext(job),
    artifactDir: jobArtifactDir(job.id, store.paths),
    job,
  };
}

export function runJob(store: Store, args: string[], o: JobOptions, env = process.env): unknown {
  const [cmd, ...rest] = args;
  const session = o.session ?? env['ORCH_SESSION'];
  const auth = authFrom(o, env);
  const id = () => need(rest[0], '<id>');

  switch (cmd) {
    case 'create': {
      const title = need(o.title, '--title');
      const repo = describeRepo(o.repo ?? process.cwd());
      const job = createJob(store, {
        title,
        description: o.description,
        issueRef: o.issue,
        repo: repo.identity,
        repoPath: repo.root,
        baseBranch: o.base ?? repo.currentBranch,
        maxRounds: int(o['max-rounds'], '--max-rounds'),
        actor: session,
      });
      return summary(job, store);
    }
    case 'list': {
      // --repo accepts a local path (resolved to its identity) or an identity such as github.com/o/r.
      const repo =
        o.repo === undefined
          ? undefined
          : existsSync(o.repo)
            ? describeRepo(o.repo).identity
            : o.repo;
      return listJobs(store.db, {
        repo,
        status: oneOf<Status>(o.status, STATUSES, '--status'),
        stage: oneOf<Stage>(o.stage, STAGES, '--stage'),
      }).map((j) => ({
        id: j.id,
        stage: j.stage,
        status: j.status,
        repo: j.repo,
        title: j.title,
        owner: j.ownerSession,
      }));
    }
    case 'show':
      return { ...jobDetail(store, id()), next: describeNext(getJob(store.db, id())) };
    case 'events':
      return listEvents(store.db, id(), int(o.limit, '--limit') ?? 100);
    case 'claim': {
      const r = claimJob(store, id(), {
        session: need(session, '--session'),
        leaseMinutes: int(o.lease, '--lease'),
        force: o.force,
      });
      return summary(r.job, store, { token: r.token });
    }
    case 'release':
      return summary(releaseJob(store, id(), auth), store);
    case 'resume': {
      const r = resumeJob(store, id(), {
        session: need(session, '--session'),
        force: o.force,
        to: oneOf<Stage>(o.to, STAGES, '--to'),
      });
      return { ...summary(r.detail.job, store, { token: r.token }), ...r.detail };
    }
    case 'transition': {
      const action = need(oneOf<Action>(rest[1], ACTIONS, '<action>'), '<action>');
      const job = transitionGuarded(store, id(), action, {
        ...auth,
        to: oneOf<Stage>(o.to, STAGES, '--to'),
        reason: o.reason,
      });
      return summary(job, store);
    }
    case 'artifact': {
      if (rest[0] !== 'add') throw new UsageError('Usage: orch job artifact add <id> <path>');
      const jobId = need(rest[1], '<id>');
      const artifact = addArtifact(store, jobId, need(rest[2], '<relative-path>'), {
        ...auth,
        replace: o.replace,
      });
      return summary(getJob(store.db, jobId), store, { artifact });
    }
    case 'review': {
      if (rest[0] !== 'record') throw new UsageError('Usage: orch job review record <id> ...');
      const jobId = need(rest[1], '<id>');
      const review = recordVerdict(store, jobId, {
        ...auth,
        reviewer: need(o.reviewer, '--reviewer'),
        verdict: oneOf<Verdict>(o.verdict, VERDICTS, '--verdict'),
        artifact: o.artifact,
        summary: o.summary,
      });
      return summary(getJob(store.db, jobId), store, { review });
    }
    case 'pr': {
      const job = recordPr(store, id(), {
        ...auth,
        url: need(o.url, '--url'),
        state: need(oneOf<PrState>(o.state, PR_STATES, '--state'), '--state'),
      });
      return summary(job, store);
    }
    case undefined:
      throw new UsageError(JOB_HELP);
    default:
      throw new UsageError(`Unknown job command: ${cmd}\n\n${JOB_HELP}`);
  }
}
