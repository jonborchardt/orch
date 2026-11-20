/** `orch job ...` handlers: parse options, call storage, return data for printing. */

import { UsageError } from '../core/errors.ts';
import { jobArtifactDir } from '../core/paths.ts';
import {
  type Action,
  ACTIONS,
  describeNext,
  type Stage,
  STAGES,
  type Status,
  STATUSES,
  type Verdict,
  VERDICTS,
} from '../core/workflow.ts';
import { SESSION_PROVIDERS, type SessionProvider, validateSessionRef } from '../core/session.ts';
import { postNotice, supersede } from '../ops/actions.ts';
import { addArtifact, recordVerdict, transitionGuarded } from '../ops/gates.ts';
import { findJobs, jobRepository } from '../ops/repo.ts';
import { jobUsage } from '../ops/usage.ts';
import { repointRepo } from '../ops/worktree.ts';
import type { Store } from '../storage/client.ts';
import { listEvents } from '../storage/events.ts';
import {
  ackNotice,
  attachSession,
  claimJob,
  createJob,
  getJob,
  jobDetail,
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
  summary?: string;
  status?: string;
  stage?: string;
  limit?: string;
  replace?: boolean;
  by?: string;
  provider?: string;
  ref?: string;
  cwd?: string;
  message?: string;
  through?: string;
}

export const JOB_HELP = `Usage: orch job <command> [options]

  create    --title <t> --description <d> [--issue <ref>] [--repo <path>] [--base <branch>]
            [--max-rounds <n>]              --description is required and non-blank; --issue
                                            only records the reference (never fetched)
  list      [--repo <path|identity>] [--status <s>] [--stage <s>]
  show <id>
  events <id> [--limit <n>]
  usage <id>                                time per stage visit, reviewer run, verification, and CI;
                                            configured models; token counts are not measured
  claim <id> --session <name> [--lease <minutes>] [--force]
  release <id> --token <t>
  resume <id> --session <name> [--to <stage>] [--force]
  transition <id> <${ACTIONS.join('|')}> --token <t> [--to <stage>] [--reason <r>]
            [--revision <n>]
  artifact add <id> <relative-path> --token <t> [--replace]
  review record <id> --reviewer <name> [--verdict pass|changes] [--summary <s>] --token <t>
            the verdict is read from round-<n>/review-<name>.md, which must agree
  repo <id> [--repo <path>] --token <t>     confirm the checkout's current remote identity
  supersede <id> --by <new-id> --session <name> [--force]
            record that <new-id> replaced <id> (same repository; both histories are kept)
  session attach <id> --provider <${SESSION_PROVIDERS.join('|')}> --ref <link|uuid> [--cwd <dir>] [--token <t>]
            record the execution session driving the job (metadata; the owner's token is
            required while the job is claimed, none while it is unowned)
  notice post <id> --message <m> [--by <name>]
            leave a message for the job's session (no token; --by defaults to human); its
            next orch factory next|status shows it until the owner acknowledges it
  notice ack <id> --through <event-id> --token <t>
            acknowledge every posted notice up to that event id (the plan's noticeAck)

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
      const { repo, base } = jobRepository(o.repo ?? process.cwd(), o.base);
      const job = createJob(store, {
        title,
        description: o.description,
        issueRef: o.issue,
        repo: repo.identity,
        repoPath: repo.root,
        baseBranch: base,
        maxRounds: int(o['max-rounds'], '--max-rounds', 1),
        actor: session,
      });
      return summary(job, store);
    }
    case 'list': {
      // --repo accepts a local path (that repository and clones of its remote) or an identity
      // such as github.com/o/r.
      return findJobs(store, {
        repo: o.repo,
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
    case 'usage':
      return jobUsage(store, id());
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
        summary: o.summary,
      });
      return summary(getJob(store.db, jobId), store, { review });
    }
    case 'repo':
      return summary(repointRepo(store, id(), auth, o.repo), store);
    case 'supersede':
      return summary(
        supersede(store, id(), {
          by: need(o.by, '--by <new-id>'),
          session: need(session, '--session'),
          force: o.force,
        }),
        store,
      );
    case 'session': {
      if (rest[0] !== 'attach') throw new UsageError('Usage: orch job session attach <id> ...');
      const jobId = need(rest[1], '<id>');
      const provider = need(
        oneOf<SessionProvider>(o.provider, SESSION_PROVIDERS, '--provider'),
        '--provider',
      );
      const r = attachSession(store, jobId, {
        session: validateSessionRef(provider, need(o.ref, '--ref'), o.cwd),
        token: auth.token,
        actor: session,
      });
      return summary(r.job, store, { changed: r.changed });
    }
    case 'notice': {
      const jobId = need(rest[1], '<id>');
      if (rest[0] === 'post') {
        if (o.message === undefined || o.message.trim() === '') {
          throw new UsageError('notice post needs a non-blank --message "<text>"');
        }
        return postNotice(store, jobId, { text: o.message, actor: o.by ?? 'human' });
      }
      if (rest[0] === 'ack') {
        const through = need(int(o.through, '--through', 1), '--through <event-id>');
        return summary(ackNotice(store, jobId, auth, through), store, { through });
      }
      throw new UsageError('Usage: orch job notice post|ack <id> ...');
    }
    case undefined:
      throw new UsageError(JOB_HELP);
    default:
      throw new UsageError(`Unknown job command: ${cmd}\n\n${JOB_HELP}`);
  }
}
