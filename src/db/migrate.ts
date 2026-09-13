/**
 * Database migration runner — REAL
 *
 * CLI entrypoint (`npm run migrate`). Uses Kysely's Migrator with a
 * StaticMigrationProvider (file-based providers don't work well with
 * compiled JS, so migrations are hard-coded here). No mocks.
 */
import { type Kysely, Migrator, type Migration, type MigrationProvider } from 'kysely';
import { db } from './client.js';
import { logger } from '../config/logger.js';

import { Migration0001Initial } from './migrations/0001_initial.js';

class StaticMigrationProvider implements MigrationProvider {
  constructor(private readonly migrations: Record<string, Migration>) {}
  async getMigrations(): Promise<Record<string, Migration>> {
    return this.migrations;
  }
}

const migrations: Record<string, Migration> = {
  '0001_initial': Migration0001Initial,
};

async function runMigrations(): Promise<void> {
  const migrator = new Migrator({
    db: db as unknown as Kysely<unknown>,
    provider: new StaticMigrationProvider(migrations),
  });

  const { error, results } = await migrator.migrateToLatest();

  for (const r of results ?? []) {
    if (r.status === 'Success') {
      logger.info({ migration: r.migrationName }, 'migration applied');
    } else if (r.status === 'Error') {
      logger.error({ migration: r.migrationName }, 'migration failed');
    }
  }

  if (error) {
    logger.error({ err: error }, 'migration error');
    process.exit(1);
  }
}

runMigrations()
  .then(() => {
    logger.info('migrations complete');
    return db.destroy();
  })
  .then(() => process.exit(0))
  .catch(async (err) => {
    logger.error({ err }, 'migration runner crashed');
    await db.destroy();
    process.exit(1);
  });