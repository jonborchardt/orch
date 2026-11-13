import { statSync } from 'node:fs';
import path from 'node:path';

import { eq } from 'drizzle-orm';

import { ValidationError } from '../core/errors.ts';
import type { Db } from './client.ts';
import { artifacts, type Artifact } from './schema.ts';

/**
 * Phase 2 validation: the file must live inside the job artifact directory, exist, be a
 * non-empty Markdown file. Returns the normalized relative path (forward slashes).
 */
export function validateArtifact(
  artifactDir: string,
  relPath: string,
): { path: string; bytes: number } {
  const abs = path.resolve(artifactDir, relPath);
  const rel = path.relative(artifactDir, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ValidationError(`Artifact must be inside ${artifactDir}: ${relPath}`);
  }
  if (path.extname(abs) !== '.md') throw new ValidationError(`Artifact must be a .md file: ${rel}`);
  let st;
  try {
    st = statSync(abs);
  } catch {
    throw new ValidationError(`Artifact file not found: ${abs}`);
  }
  if (!st.isFile()) throw new ValidationError(`Artifact is not a file: ${abs}`);
  if (st.size === 0) throw new ValidationError(`Artifact is empty: ${abs}`);
  return { path: rel.split(path.sep).join('/'), bytes: st.size };
}

/** Insert or refresh (same path registered twice is idempotent). */
export function upsertArtifact(tx: Db, row: Omit<Artifact, 'id'>): Artifact {
  return tx
    .insert(artifacts)
    .values(row)
    .onConflictDoUpdate({
      target: [artifacts.jobId, artifacts.path],
      set: { bytes: row.bytes, stage: row.stage, round: row.round, createdAt: row.createdAt },
    })
    .returning()
    .get();
}

export function listArtifacts(db: Db, jobId: string): Artifact[] {
  return db.select().from(artifacts).where(eq(artifacts.jobId, jobId)).orderBy(artifacts.id).all();
}
