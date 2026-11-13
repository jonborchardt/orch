/**
 * Seed a throwaway ORCH_HOME with representative factory jobs and print how to view them.
 *
 *   ORCH_HOME=/tmp/orch-demo npm run ui:seed && ORCH_HOME=/tmp/orch-demo orch ui --open
 *
 * Refuses to run without ORCH_HOME so it can never touch the real database.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { runtimePaths } from '../src/core/paths.ts';
import { openStore } from '../src/storage/client.ts';
import { seedDashboard } from '../tests/fixtures/dashboard.ts';

const home = process.env['ORCH_HOME'] ?? '';
if (!home) {
  console.error('Set ORCH_HOME to a scratch directory first; this script seeds demo data.');
  process.exit(2);
}
const paths = runtimePaths();
const store = openStore(paths);
try {
  const repos = {
    alpha: join(paths.data, 'demo-repos', 'alpha'),
    beta: join(paths.data, 'demo-repos', 'beta'),
    gamma: join(paths.data, 'demo-repos', 'gamma'),
  };
  for (const dir of Object.values(repos)) mkdirSync(dir, { recursive: true });
  const ids = seedDashboard(store, repos);
  console.log(`Seeded ${store.file}`);
  for (const [name, id] of Object.entries(ids) as [string, string][]) {
    console.log(`  ${name.padEnd(10)} ${id}`);
  }
  console.log(`\nNow run: ORCH_HOME=${home} orch ui --open`);
} finally {
  store.close();
}
