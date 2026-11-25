/** `GET /api/jobs/:id/readiness`: the Merge dialog's readiness grade, read-only, behind the guards. */
import { request } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type RunningServer, startServer } from '../src/server/http.ts';
import type { ReadinessView } from '../src/server/types.ts';
import { createJob } from '../src/storage/jobs.ts';
import {
  commitFile,
  type GhShim,
  ghShim,
  gitIn,
  makeRepoWithOrigin,
  POLICY,
  tempStore,
  type TempStore,
} from './helpers.ts';

let store: TempStore;
let srv: RunningServer;
let shim: GhShim;
let id: string;

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(new URL(path, srv.url), { headers: { ...headers, Connection: 'close' } });
const raw = (path: string, headers: Record<string, string>) =>
  new Promise<number>((resolve) => {
    request({ host: '127.0.0.1', port: srv.port, path, headers }, (res) => {
      resolve(res.statusCode ?? 0);
      res.resume();
    }).end();
  });

beforeAll(async () => {
  shim = ghShim('acme/alpha');
  Object.assign(process.env, shim.env);
  shim.write({
    protection: { strict: true, contexts: ['ci'] },
    api: { 'repos/acme/alpha/branches/main': { protected: true } },
  });
  const { clone } = makeRepoWithOrigin();
  commitFile(clone, 'factory.json', JSON.stringify(POLICY) + '\n', 'test policy');
  gitIn(clone, 'push', '-q', 'origin', 'main');
  store = tempStore();
  id = createJob(store, {
    title: 'Export CSV',
    description: 'Export CSV',
    repo: 'github.com/acme/alpha',
    repoPath: clone,
    baseBranch: 'main',
  }).id;
  srv = await startServer({ store, port: 0, webRoot: shim.dir });
});
afterAll(async () => {
  await srv.close();
  store.cleanup();
  for (const k of Object.keys(shim.env)) Reflect.deleteProperty(process.env, k);
  shim.cleanup();
});

describe('readiness route', () => {
  it("returns the grade for the job's repository and base branch", async () => {
    const r = await get(`/api/jobs/${id}/readiness`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as ReadinessView).grade).toMatchObject({
      letter: 'A',
      met: 4,
      advice: [],
    });
    expect(shim.read().calls.map((c) => c[1])).toContain('repos/acme/alpha/branches/main');
  });

  it('is GET-only, keeps the Host guard, and 404s an unknown job', async () => {
    const post = await fetch(new URL(`/api/jobs/${id}/readiness`, srv.url), {
      method: 'POST',
      headers: { Connection: 'close' },
    });
    expect(post.status).toBeGreaterThanOrEqual(400);
    expect(await raw(`/api/jobs/${id}/readiness`, { Host: 'evil.example' })).toBe(400);
    expect((await get('/api/jobs/job-00000000/readiness')).status).toBe(404);
    expect((await get('/api/jobs/not-an-id/readiness')).status).toBe(422);
  });
});
