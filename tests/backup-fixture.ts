/** Shared by the backup test files: a seeded data directory and archive rewriting. */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

import { type Manifest, sha256 } from '../src/core/backup.ts';
import { decodeTar, encodeTar, type TarEntry } from '../src/core/tar.ts';
import { addTicket } from '../src/ops/tickets.ts';
import { type Ctx, go, makePolicyRepo, add, start } from './drive.ts';
import { type TempStore } from './helpers.ts';

/** A job with spec.md registered (spec stage, running) and one ticket. */
export function seedJob(store: TempStore): Ctx & { clone: string } {
  const { clone } = makePolicyRepo();
  const c = start(store, clone);
  go(store, c, 'start');
  add(store, c, 'spec.md');
  addTicket(store, { title: 'Back me up', repo: clone });
  return { ...c, clone };
}

/** Entries of an archive file. */
export function entries(file: string): TarEntry[] {
  return decodeTar(gunzipSync(readFileSync(file)));
}

/** Rewrite an archive: `edit` changes the manifest in place and returns the other entries. */
export function rewrite(
  file: string,
  edit: (m: Manifest, list: TarEntry[]) => TarEntry[],
  out = file,
): void {
  const [first, ...rest] = entries(file);
  const m = JSON.parse(first?.data.toString('utf8') ?? '{}') as Manifest;
  const list = edit(m, rest);
  const manifest = { path: 'manifest.json', data: Buffer.from(JSON.stringify(m)) };
  writeFileSync(out, gzipSync(encodeTar([manifest, ...list])));
}

/** Add an entry and its manifest line. */
export function withFile(m: Manifest, list: TarEntry[], path: string, body: string): TarEntry[] {
  const data = Buffer.from(body);
  m.files.push({ path, bytes: data.length, sha256: sha256(data) });
  return [...list, { path, type: '0', data }];
}
