import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatStatus } from '../src/cli/run.ts';
import { BUILD_INFO, installBuild } from '../src/ops/install-build.ts';
import type { RunnerStatus } from '../src/ops/run.ts';
import { commitFile, gitIn, makeRepo, makeRepoWithOrigin, tempDir } from './helpers.ts';

function stamp(root: string, commit: string): void {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, BUILD_INFO), JSON.stringify({ commit }));
}
const head = (root: string) => gitIn(root, 'rev-parse', 'HEAD');
const short = (sha: string) => sha.slice(0, 7);

describe('installBuild', () => {
  it('is null without a stamp, or outside a Git checkout', () => {
    expect(installBuild(makeRepo())).toBeNull();
    const plain = tempDir('orch-plain-');
    stamp(plain, 'a'.repeat(40));
    expect(installBuild(plain)).toBeNull();
  });

  it('is current when the stamp is HEAD and there is no upstream', () => {
    const repo = makeRepo();
    stamp(repo, head(repo));
    expect(installBuild(repo)).toMatchObject({ head: head(repo), upstream: null, stale: false });
  });

  it('is stale once HEAD moves past the stamped commit', () => {
    const repo = makeRepo();
    const built = head(repo);
    stamp(repo, built);
    const now = commitFile(repo, 'a.txt', 'a');
    const b = installBuild(repo);
    expect(b?.stale).toBe(true);
    expect(b?.message).toBe(
      `built from ${short(built)}, main is at ${short(now)}: pull, \`npm run build\`, \`orch install\``,
    );
  });

  it('is stale for a commit the checkout does not know', () => {
    const repo = makeRepo();
    stamp(repo, 'b'.repeat(40));
    expect(installBuild(repo)?.stale).toBe(true);
  });

  it('is stale when the fetched upstream is ahead, without fetching or moving a ref', () => {
    const { clone, bare } = makeRepoWithOrigin();
    stamp(clone, head(clone));
    // Another clone pushes; a fetch here updates origin/main but not the local branch.
    const other = tempDir('orch-other-');
    gitIn(other, 'clone', '-q', bare, '.');
    const ahead = commitFile(other, 'b.txt', 'b');
    gitIn(other, 'push', '-q', 'origin', 'main');
    gitIn(clone, 'fetch', '-q');
    const refs = gitIn(clone, 'for-each-ref');
    const b = installBuild(clone);
    expect(b).toMatchObject({ head: head(clone), upstream: ahead, stale: true });
    expect(b?.message).toContain(`origin/main is at ${short(ahead)}`);
    expect(gitIn(clone, 'for-each-ref')).toBe(refs);
  });
});

describe('formatStatus build line', () => {
  const status = (build: RunnerStatus['build']): RunnerStatus => ({
    controllers: [],
    last: null,
    build,
    waiting: [],
  });
  const build = {
    builtFrom: 'a',
    head: 'b',
    upstream: null,
    message: 'built from a, main is at b',
  };

  it('prints the message only when the build is stale', () => {
    expect(formatStatus(status({ ...build, stale: true }))).toContain(
      'build       built from a, main is at b',
    );
    expect(formatStatus(status({ ...build, stale: false }))).not.toContain('build ');
    expect(formatStatus(status(null))).not.toContain('build ');
  });
});
