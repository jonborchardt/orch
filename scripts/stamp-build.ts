/**
 * Record which commit `npm run build` built, for `installBuild` in `src/ops/install-build.ts`.
 * Outside a Git checkout it removes any old stamp, so a build is never credited to a wrong commit.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { installRoot } from '../src/core/paths.ts';
import { tryGit } from '../src/git/run.ts';
import { BUILD_INFO } from '../src/ops/install-build.ts';

const root = installRoot();
const file = join(root, BUILD_INFO);
const commit = tryGit(root, 'rev-parse', 'HEAD');
if (commit === undefined) rmSync(file, { force: true });
else writeFileSync(file, JSON.stringify({ commit, builtAt: new Date().toISOString() }) + '\n');
