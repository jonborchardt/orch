import { describe, expect, it } from 'vitest';
import {
  EMOJI,
  eventEmoji,
  outcomeEmoji,
  reportBody,
  reportSubject,
  stageLines,
} from '../src/core/mail-report.ts';
import { STAGES, STATUSES, type Stage, type Status } from '../src/core/workflow.ts';
import type { Event } from '../src/storage/schema.ts';

const { success: OK, failure: FAIL, waiting: WAIT, progress: RUN, cancelled: STOP } = EMOJI;
const PEND = EMOJI.pending;

const job = (stage: Stage, status: Status) => ({
  id: 'job-1',
  title: 'Mail me',
  repo: 'github.com/o/r',
  stage,
  status,
  prUrl: null,
});

const event = (type: string, payload: Record<string, unknown> = {}): Event => ({
  id: 1,
  jobId: 'job-1',
  type,
  payload,
  actor: null,
  createdAt: '2026-11-17T00:00:00.000Z',
});

/** Parses the stage section into [marker, stage, word] triples. */
function stages(body: string): [string, string, string][] {
  const lines = body.split('\n');
  const start = lines.indexOf('Stages:') + 1;
  return lines.slice(start, start + STAGES.length).map((l) => {
    const [marker = '', stage = '', word = ''] = l.split(/\s+/);
    return [marker, stage, word];
  });
}

describe('emoji table', () => {
  it('maps every status to one of the table emojis', () => {
    const table = Object.values(EMOJI) as string[];
    for (const s of STATUSES) expect(table).toContain(outcomeEmoji({ stage: 'build', status: s }));
  });

  it('uses single-codepoint emojis', () => {
    for (const e of Object.values(EMOJI))
      expect(String.fromCodePoint(e.codePointAt(0) ?? 0)).toBe(e);
  });
});

describe('reportBody headline', () => {
  it.each<[Stage, Status, string]>([
    ['build', 'failed', FAIL],
    ['ci', 'blocked', WAIT],
    ['needs-human', 'running', WAIT],
    ['review', 'running', RUN],
    ['completed', 'completed', OK],
    ['pr', 'cancelled', STOP],
    ['ci', 'interrupted', FAIL],
  ])('%s/%s starts with %s', (stage, status, emoji) => {
    const first = reportBody(job(stage, status), []).split('\n')[0];
    expect(first).toBe(`${emoji} ${status} at ${stage}`);
  });
});

describe('reportBody stage section', () => {
  it('lists every stage once, in order, done / current / pending', () => {
    expect(stages(reportBody(job('review', 'running'), []))).toEqual([
      [OK, 'spec', 'done'],
      [OK, 'build', 'done'],
      [OK, 'simplify', 'done'],
      [RUN, 'review', 'current'],
      [PEND, 'approve', 'pending'],
      [PEND, 'pr', 'pending'],
      [PEND, 'ci', 'pending'],
      [PEND, 'needs-human', 'pending'],
      [PEND, 'completed', 'pending'],
    ]);
  });

  it.each<[Stage, Status, string]>([
    ['build', 'failed', FAIL],
    ['ci', 'blocked', WAIT],
    ['pr', 'interrupted', FAIL],
    ['approve', 'cancelled', STOP],
    ['needs-human', 'running', WAIT],
  ])('marks %s current with the outcome emoji for %s', (stage, status, emoji) => {
    const rows = stages(reportBody(job(stage, status), []));
    expect(rows.map((r) => r[1])).toEqual([...STAGES]);
    const at = STAGES.indexOf(stage);
    expect(rows[at]).toEqual([emoji, stage, 'current']);
    rows.slice(0, at).forEach((r) => {
      expect([r[0], r[2]]).toEqual([OK, 'done']);
    });
    rows.slice(at + 1).forEach((r) => {
      expect([r[0], r[2]]).toEqual([PEND, 'pending']);
    });
  });

  it('keeps done, current, and pending markers distinct for unfinished jobs', () => {
    for (const status of STATUSES.filter((s) => s !== 'completed'))
      for (const stage of STAGES.slice(1, -1)) {
        const rows = stageLines({ stage, status }).map((l) => l.split(' '));
        const at = STAGES.indexOf(stage);
        const done = rows[0]?.[0];
        const cur = rows[at]?.[0];
        const pend = rows[rows.length - 1]?.[0];
        expect(new Set([done, cur, pend]).size).toBe(3);
      }
  });

  it('shows a completed job with every stage done and none current', () => {
    const body = reportBody(job('completed', 'completed'), []);
    expect(stages(body)).toEqual(STAGES.map((s) => [OK, s, 'done']));
    expect(body).not.toContain('current');
    expect(body.startsWith(OK)).toBe(true);
  });
});

describe('reportBody events', () => {
  it.each<[string, string]>([
    ['stage.failed', FAIL],
    ['recovery.failed', FAIL],
    ['job.interrupted', FAIL],
    ['job.blocked', WAIT],
    ['stage.completed', OK],
    ['job.completed', OK],
    ['job.cancelled', STOP],
    ['job.created', RUN],
    ['stage.started', RUN],
    ['job.resumed', RUN],
  ])('prefixes %s with %s', (type, emoji) => {
    expect(eventEmoji(type)).toBe(emoji);
    const body = reportBody(job('build', 'running'), [
      event(type, { stage: 'build', reason: 'because' }),
    ]);
    const lines = body.split('\n');
    const i = lines.findIndex((l) => l.includes(type));
    expect(lines[i]).toBe(`${emoji} 2026-11-17T00:00:00.000Z  ${type} (build)`);
    expect(lines[i + 1]).toBe('    reason: because');
  });
});

describe('reportBody needed block', () => {
  const needed = {
    summary: 'Approver escalated: a human must decide',
    detail: 'origin/main conflicts in web/src/JobBoard.tsx',
    next: ['Decide on the dashboard: approve, cancel', 'Dashboard: run orch ui'],
  };

  it('puts summary, verbatim reason, and next steps between the headline and Job:', () => {
    const lines = reportBody(job('needs-human', 'blocked'), [], needed).split('\n');
    const end = lines.indexOf('Job:    job-1');
    expect(lines.slice(1, end)).toEqual([
      '',
      needed.summary,
      `Reason: ${needed.detail}`,
      ...needed.next,
      '',
    ]);
  });

  it('omits the reason line when there is no detail', () => {
    const body = reportBody(job('build', 'failed'), [], { ...needed, detail: null, next: [] });
    expect(body.split('\n').slice(0, 4)).toEqual([
      `${FAIL} failed at build`,
      '',
      needed.summary,
      '',
    ]);
  });

  it('renders exactly as before without a needed value', () => {
    const plain = reportBody(job('build', 'running'), [event('stage.started')]);
    expect(reportBody(job('build', 'running'), [event('stage.started')], null)).toBe(plain);
    expect(plain.split('\n').slice(0, 3)).toEqual([`${RUN} running at build`, '', 'Job:    job-1']);
  });
});

describe('reportSubject', () => {
  it('carries no emoji', () => {
    expect(reportSubject(job('build', 'failed'))).toBe('job-1: Mail me');
  });
});
