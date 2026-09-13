/**
 * CLI entrypoint: `npm run sync` — REAL
 *
 * One-off GitHub sync into Postgres. No mocks — hits the real GitHub API
 * and writes to the real DB. Useful for populating state before running
 * the orchestrator.
 */
import { logger } from '../config/logger.js';
import { trackedRepos } from '../config/env.js';
import { syncAll } from '../sync/sync.js';
import { db } from '../db/client.js';

async function main(): Promise<void> {
  const specs = trackedRepos();
  if (specs.length === 0) {
    logger.warn('no repos configured (GITHUB_REPOS empty)');
    process.exit(1);
  }
  const results = await syncAll(specs);
  logger.info({ results }, 'sync all done');
  await db.destroy();
}

main().catch((err) => {
  logger.error({ err }, 'sync command failed');
  process.exit(1);
});