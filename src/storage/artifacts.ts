import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

import { and, eq } from 'drizzle-orm';

import { checkArtifact } from '../core/artifact-rules.ts';
import { ValidationError } from '../core/errors.ts';
import type { Db } from './client.ts';
import { artifacts, type Artifact } from './schema.ts';

export interface CheckedArtifact {
  /** Normalized relative path, forward slashes. */
  path: string;
  bytes: number;
  sha256: string;
  marker: string | null;
}

/**
 * The file must live inside the job artifact directory (no traversal, no absolute paths), be a
 * non-empty Markdown file, and satisfy the structure rule for its path (core/artifact-rules.ts).
 */
export function validateArtifact(artifactDir: string, relPath: string): CheckedArtifact {
  if (path.isAbsolute(relPath) || /^[a-zA-Z]:/.test(relPath)) {
    throw new ValidationError(`Artifact path must be relative to ${artifactDir}: ${relPath}`);
  }
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
  // Links (file or directory) that lead outside the artifact directory are not artifacts.
  const realDir = realpathSync.native(artifactDir);
  const realRel = path.relative(realDir, realpathSync.native(abs));
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new ValidationError(`Artifact must be inside ${artifactDir} (not a link out): ${rel}`);
  }
  const normalized = rel.split(path.sep).join('/');
  const content = readFileSync(abs, 'utf8');
  const marker = checkArtifact(normalized, content);
  return {
    path: normalized,
    bytes: st.size,
    sha256: createHash('sha256').update(content).digest('hex'),
    marker,
  };
}

export function findArtifact(db: Db, jobId: string, relPath: string): Artifact | undefined {
  return db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.jobId, jobId), eq(artifacts.path, relPath)))
    .get();
}

/** Insert or refresh (same path registered twice is idempotent). */
export function upsertArtifact(tx: Db, row: Omit<Artifact, 'id'>): Artifact {
  return tx
    .insert(artifacts)
    .values(row)
    .onConflictDoUpdate({
      target: [artifacts.jobId, artifacts.path],
      set: {
        bytes: row.bytes,
        sha256: row.sha256,
        marker: row.marker,
        head: row.head,
        stage: row.stage,
        round: row.round,
        createdAt: row.createdAt,
      },
    })
    .returning()
    .get();
}

export function listArtifacts(db: Db, jobId: string): Artifact[] {
  return db.select().from(artifacts).where(eq(artifacts.jobId, jobId)).orderBy(artifacts.id).all();
}
