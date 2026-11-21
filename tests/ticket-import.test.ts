/**
 * The register import, against fixture registers in temporary directories and temporary
 * databases only: the user's real `todo/` is never read or written by a test.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NotFoundError, ValidationError } from '../src/core/errors.ts';
import { parseTodo, REGISTER_KEYS } from '../src/core/todo-register.ts';
import { importRegister, todoIdsInTitle } from '../src/ops/ticket-import.ts';
import {
  addTicket,
  listTickets,
  showTicket,
  ticketAreas,
  ticketHistory,
} from '../src/ops/tickets.ts';
import { createJob, getJob } from '../src/storage/jobs.ts';
import { ticketEvents, tickets } from '../src/storage/schema.ts';
import { importTickets } from '../src/storage/ticket-import.ts';
import { makeRepo, type TempStore, tempStore } from './helpers.ts';

let store: TempStore;
let repo: string;
let dir: string;

const BASE = {
  status: 'open',
  type: 'bug',
  area: 'web',
  priority: 'P2',
  effort: 1,
  depends_on: [] as number[],
  related: [] as number[],
  duplicate_of: 'null' as string | number,
  classified: 'auto',
  created: '2026-11-06',
  updated: '2026-11-07',
};
const pad = (n: number) => String(n).padStart(4, '0');
const BODY =
  '## What\n\nThe text, with a checklist.\n\n- [ ] first box\n- [x] second box\n\n## Notes\n\n- 2026-11-06: logged.\n- 2026-11-07: started; dotodo\n';

function write(
  id: number,
  over: Partial<typeof BASE> & { title?: string; body?: string } = {},
  to = dir,
) {
  const { body = BODY, ...o } = over;
  const all: Record<string, unknown> = { ...BASE, id, title: `Todo ${String(id)}`, ...o };
  const fm = REGISTER_KEYS.map((k) => {
    const v = all[k];
    return `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : String(v)}`;
  }).join('\n');
  writeFileSync(join(to, `${pad(id)}-todo.md`), `---\n${fm}\n---\n\n${body}`);
}

/** A register shaped like the real one: every status, links, a duplicate, an extra area. */
function seed() {
  writeFileSync(
    join(dir, 'areas.md'),
    'web: the client\ncore: rules\nvideo: an area of this register\n',
  );
  write(1, {
    status: 'done',
    priority: 'P1',
    effort: 0.5,
    classified: 'user',
    title: '"Quoted: title"',
  });
  write(2, { depends_on: [1], related: [1, 3], area: 'video' });
  write(3, { status: 'duplicate', duplicate_of: 1 });
  write(4, { status: 'dropped', type: 'chore' });
  write(5, { status: 'in-progress', depends_on: [2], effort: 0.25 });
}

beforeEach(() => {
  store = tempStore();
  repo = makeRepo('git@github.com:acme/alpha.git');
  dir = join(repo, 'todo');
  mkdirSync(dir);
});
afterEach(() => {
  store.cleanup();
});

const run = (over: Record<string, unknown> = {}) => importRegister(store, { cwd: repo, ...over });
const snapshot = () => readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]);

describe('parsing', () => {
  it('reads the thirteen keys and keeps the body', () => {
    write(12, { depends_on: [1, 2], title: 'Settings page loses its filter' });
    const t = parseTodo(readFileSync(join(dir, '0012-todo.md'), 'utf8'), '0012-todo.md');
    expect(t).toMatchObject({
      id: 12,
      title: 'Settings page loses its filter',
      dependsOn: [1, 2],
      duplicateOf: null,
      created: '2026-11-06',
      effort: 1,
    });
    expect(t.body).toBe(BODY.trimEnd());
  });

  it('refuses a malformed file with its name and line', () => {
    const text = (edit: (s: string) => string) => {
      write(8);
      return edit(readFileSync(join(dir, '0008-todo.md'), 'utf8'));
    };
    const cases: [(s: string) => string, RegExp][] = [
      [(s) => s.replace('type: bug', 'kind: bug'), /0008-todo.md:5: unknown key kind/],
      [(s) => s.replace('effort: 1', 'effort: 4'), /effort: days, one of/],
      [(s) => s.replace('status: open', 'status: blocked'), /status: one of/],
      [(s) => s.replace('id: 8', 'id: 7'), /id 7 does not match the filename/],
      [
        (s) => s.replace('duplicate_of: null', 'duplicate_of: 3'),
        /duplicate_of is set exactly when/,
      ],
      [(s) => s.replace('priority: P2\n', ''), /keys must be exactly, in order/],
      [(s) => s.replace('created: 2026-11-06', 'created: yesterday'), /created: YYYY-MM-DD/],
      [(s) => s.slice(4), /frontmatter must start with ---/],
    ];
    for (const [edit, why] of cases) {
      expect(() => parseTodo(text(edit), '0008-todo.md')).toThrow(why);
    }
  });

  it('finds the todo a job title names', () => {
    expect(todoIdsInTitle('Todo 0074: See a session log')).toEqual([74]);
    expect(todoIdsInTitle('0044: Mandatory spec challenger')).toEqual([44]);
    expect(todoIdsInTitle('Explain consequential actions (todo 8)')).toEqual([8]);
    expect(todoIdsInTitle('Move repairs count (0052)')).toEqual([52]);
    expect(todoIdsInTitle('Dashboard polish (todos 1,2,3,6)')).toEqual([1, 2, 3, 6]);
    expect(todoIdsInTitle('Add an MIT LICENSE')).toEqual([]);
  });
});

describe('import', () => {
  it('preserves ids, fields, bodies, dates, links, and areas, and leaves the files alone', () => {
    seed();
    const before = snapshot();
    const report = run({ actor: 'me' });
    expect(snapshot()).toEqual(before);
    expect(report).toMatchObject({
      repo: 'github.com/acme/alpha',
      dryRun: false,
      alreadyImported: false,
      idsPreserved: true,
      idMap: { '0001': 1, '0002': 2, '0003': 3, '0004': 4, '0005': 5 },
      // Enough to reconcile by hand: every todo with its status and mapped links.
      tickets: [
        { importId: 1, id: 1, title: 'Quoted: title', status: 'done', priority: 'P1' },
        { importId: 2, id: 2, status: 'open', dependsOn: [1], related: [1, 3] },
        { importId: 3, id: 3, status: 'duplicate', duplicateOf: 1 },
        { importId: 4, id: 4, status: 'dropped', dependsOn: [] },
        { importId: 5, id: 5, status: 'in-progress', dependsOn: [2] },
      ],
      counts: {
        tickets: 5,
        byStatus: { done: 1, open: 1, duplicate: 1, dropped: 1, 'in-progress': 1 },
        dependencies: 2,
        related: 2,
        duplicates: 1,
      },
      areasAdded: ['video'],
      nextId: 6,
    });
    expect(showTicket(store, 1).ticket).toMatchObject({
      title: 'Quoted: title',
      status: 'done',
      priority: 'P1',
      effort: 0.5,
      classified: 'user',
      createdAt: '2026-11-06',
      updatedAt: '2026-11-07',
      importId: 1,
      body: BODY.trimEnd(),
    });
    expect(showTicket(store, 2).ticket).toMatchObject({
      dependsOn: [1],
      related: [1, 3],
      area: 'video',
    });
    expect(showTicket(store, 3).ticket).toMatchObject({ status: 'duplicate', duplicateOf: 1 });
    expect(showTicket(store, 5).ticket).toMatchObject({ status: 'in-progress', dependsOn: [2] });
    expect(ticketAreas(store).map((a) => a.name)).toContain('video');
    expect(ticketHistory(store, 2)).toMatchObject([
      { type: 'ticket.imported', actor: 'me', payload: { importId: 2 } },
    ]);
    // Ticket 2 depends on a done ticket: it is the one ready ticket.
    expect(listTickets(store, { view: 'ready' }).tickets.map((t) => t.id)).toEqual([2]);
    // The next new ticket continues the sequence.
    expect(addTicket(store, { title: 'New', repo }).id).toBe(6);
  });

  it('a dry run reports exactly what the import then does, and writes nothing', () => {
    seed();
    const dry = run({ dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(store.db.select().from(tickets).all()).toEqual([]);
    expect(ticketAreas(store).map((a) => a.name)).not.toContain('video');
    const real = run();
    expect({ ...real, dryRun: true }).toEqual(dry);
  });

  it('running it again changes nothing', () => {
    seed();
    run();
    const rows = store.db.select().from(tickets).all();
    const events = store.db.select().from(ticketEvents).all();
    const again = run();
    expect(again).toMatchObject({ alreadyImported: true, idMap: { '0005': 5 }, areasAdded: [] });
    expect(store.db.select().from(tickets).all()).toEqual(rows);
    expect(store.db.select().from(ticketEvents).all()).toEqual(events);
    // Rewriting a file with the same content (other line endings, key spacing) is still a no-op.
    const file = join(dir, '0002-todo.md');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace(/\n/g, '\r\n').replace('priority: P2', 'priority:  P2'));
    expect(run().alreadyImported).toBe(true);
    writeFileSync(file, original);
  });

  it('a register that changed after its import is refused, whatever changed', () => {
    seed();
    run();
    const rows = store.db.select().from(tickets).all();
    const events = store.db.select().from(ticketEvents).all();
    const restore = () => {
      for (const f of readdirSync(dir)) if (f !== 'areas.md') rmSync(join(dir, f));
      seed();
    };
    // Same ids and the same number of files each time, except the last two cases.
    const changes: [() => void, RegExp][] = [
      [
        () => {
          write(2, {
            depends_on: [1],
            related: [1, 3],
            area: 'video',
            body: `${BODY}- [ ] one more\n`,
          });
        },
        /changed 0002\./,
      ],
      [
        () => {
          write(4, { status: 'dropped', type: 'chore', priority: 'P1' });
        },
        /changed 0004\./,
      ],
      [
        () => {
          write(4, { status: 'done', type: 'chore' });
        },
        /changed 0004\./,
      ],
      [
        () => {
          write(5, { status: 'in-progress', depends_on: [1], effort: 0.25 });
        },
        /changed 0005\./,
      ],
      [
        () => {
          write(2, { depends_on: [1], related: [1], area: 'video' });
          write(4, { status: 'dropped', type: 'chore', title: 'Renamed' });
        },
        /changed 0002, 0004\./,
      ],
      [
        () => {
          write(6);
        },
        /added 0006\./,
      ],
      [
        () => {
          rmSync(join(dir, '0005-todo.md'));
          write(2, { related: [1, 3], area: 'video' });
        },
        /changed 0002; removed 0005\./,
      ],
    ];
    for (const [change, why] of changes) {
      change();
      expect(() => run()).toThrow(why);
      expect(() => run({ dryRun: true })).toThrow(/has changed since/);
      expect(store.db.select().from(tickets).all()).toEqual(rows);
      expect(store.db.select().from(ticketEvents).all()).toEqual(events);
      restore();
      expect(run().alreadyImported).toBe(true);
    }
  });

  it('a later register with colliding ids gets new ones, with references rewritten', () => {
    seed();
    run();
    const other = makeRepo('git@github.com:acme/beta.git');
    const otherDir = join(other, 'todo');
    mkdirSync(otherDir);
    write(1, { title: 'Beta one' }, otherDir);
    write(2, { title: 'Beta two', depends_on: [1], related: [3] }, otherDir);
    write(3, { title: 'Beta dup', status: 'duplicate', duplicate_of: 2 }, otherDir);
    const report = importRegister(store, { cwd: other });
    expect(report).toMatchObject({
      repo: 'github.com/acme/beta',
      idsPreserved: false,
      idMap: { '0001': 6, '0002': 7, '0003': 8 },
      nextId: 9,
    });
    expect(report.warnings.join()).toMatch(/every todo gets a new id/);
    expect(showTicket(store, 7).ticket).toMatchObject({
      title: 'Beta two',
      repo: 'github.com/acme/beta',
      importId: 2,
      dependsOn: [6],
      related: [8],
    });
    expect(showTicket(store, 8).ticket.duplicateOf).toBe(7);
    // The first register's tickets are untouched, and the mapping is stable on a repeat.
    expect(showTicket(store, 2).ticket).toMatchObject({ title: 'Todo 2', dependsOn: [1] });
    expect(importRegister(store, { cwd: other }).idMap).toEqual(report.idMap);
  });

  it('an invalid register imports nothing and consumes no ticket number', () => {
    seed();
    type Over = Parameters<typeof write>[1];
    const invalid: [Over[], RegExp][] = [
      [[{ depends_on: [9] }], /depends_on names 9, which does not exist/],
      [[{ area: 'nope' }], /area nope is not in areas.md/],
      [[{ depends_on: [6] }], /depends on itself/],
      [[{ depends_on: [7] }, { depends_on: [6] }], /dependency cycle: 6 -> 7 -> 6/],
      [[{ effort: 4 }], /effort: days/],
    ];
    for (const [files, why] of invalid) {
      files.forEach((over, i) => {
        write(6 + i, over);
      });
      expect(() => run()).toThrow(why);
      expect(() => run({ dryRun: true })).toThrow(ValidationError);
      for (const f of ['0006-todo.md', '0007-todo.md']) rmSync(join(dir, f), { force: true });
    }
    expect(store.db.select().from(tickets).all()).toEqual([]);
    expect(addTicket(store, { title: 'First', repo }).id).toBe(1);
  });

  it('a failure inside the transaction rolls every row back', () => {
    const row = {
      importId: 1,
      fingerprint: 'f',
      title: 't',
      status: 'open' as const,
      type: 'bug' as const,
      area: 'web',
      priority: 'P2' as const,
      effort: 1,
      classified: 'auto' as const,
      body: '',
      createdAt: '2026-11-06',
      updatedAt: '2026-11-06',
      related: [],
      duplicateOf: null,
    };
    const batch = {
      source: 'src',
      repo: 'r',
      repoPath: repo,
      areas: [{ name: 'video', description: 'd' }],
      jobLinks: [],
      // The second row's dependency does not exist: the foreign key fails after earlier inserts.
      rows: [
        { ...row, id: 1, dependsOn: [] },
        { ...row, id: 2, importId: 2, dependsOn: [99] },
      ],
    };
    expect(() => importTickets(store, batch)).toThrow();
    expect(store.db.select().from(tickets).all()).toEqual([]);
    expect(store.db.select().from(ticketEvents).all()).toEqual([]);
    expect(ticketAreas(store).map((a) => a.name)).not.toContain('video');
    expect(addTicket(store, { title: 'First', repo }).id).toBe(1);
  });

  it('ids taken by earlier tickets remap the whole register', () => {
    seed();
    for (const title of ['a', 'b', 'c']) addTicket(store, { title, repo });
    const report = run();
    expect(report.idMap).toMatchObject({ '0001': 4, '0005': 8 });
    expect(showTicket(store, 5).ticket.dependsOn).toEqual([4]);
  });

  it('says so when there is no register', () => {
    rmSync(dir, { recursive: true });
    expect(() => run()).toThrow(NotFoundError);
    mkdirSync(dir);
    expect(() => run()).toThrow(/No todo files/);
    expect(() => importRegister(store, { cwd: store.home })).toThrow(/not inside a Git repository/);
  });

  it('associates jobs whose title names one todo, and reports the rest', () => {
    seed();
    const job = (title: string) =>
      createJob(store, {
        title,
        description: 'd',
        repo: 'github.com/acme/alpha',
        repoPath: repo,
        baseBranch: 'main',
      }).id;
    const named = job('Todo 0002: the second');
    const lead = job('0005 the fifth');
    const second = job('Second attempt (todo 5)');
    const several = job('Polish (todos 1,2)');
    const unrelated = job('Add a license');
    const mentioned = job('Something else');
    write(6, {
      body: `## Notes\n\n- 2026-11-08: raised by reviewers of ${mentioned} and job-00000000.\n`,
    });
    const report = run();
    expect(report.jobs.linked.map((l) => [l.job, l.ticket])).toEqual([
      [named, 2],
      [lead, 5],
    ]);
    expect(report.jobs.ambiguous.map((a) => [a.job, a.ticket])).toEqual([
      [second, 5],
      [several, 1],
      [mentioned, 6],
    ]);
    expect(report.jobs.ambiguous[0]?.why).toMatch(/second unfinished job/);
    expect(report.jobs.unresolved).toMatchObject([{ job: 'job-00000000', ticket: 6 }]);
    expect(getJob(store.db, named).ticketId).toBe(2);
    expect(getJob(store.db, second).ticketId).toBeNull();
    expect(getJob(store.db, unrelated).ticketId).toBeNull();
    expect(showTicket(store, 5).jobs.map((j) => j.id)).toEqual([lead]);
    expect(ticketHistory(store, 2).map((e) => e.type)).toEqual([
      'ticket.imported',
      'ticket.job-linked',
    ]);
  });

  it('copies assets into the private ticket directory', () => {
    seed();
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', '0002-a.png'), 'png');
    writeFileSync(join(dir, 'assets', 'stray.png'), 'png');
    const report = run();
    expect(report.assets).toEqual([{ ticket: 2, file: '0002-a.png' }]);
    expect(report.warnings.join()).toMatch(/assets\/stray.png names no todo/);
    expect(showTicket(store, 2).assets).toEqual(['0002-a.png']);
    expect(readdirSync(join(dir, 'assets'))).toHaveLength(2);
  });
});
