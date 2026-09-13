/**
 * Database client — REAL
 *
 * Kysely ORM backed by a Postgres connection pool (pg).
 * All queries in the app go through this client. No mocks.
 */
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { env } from '../config/env.js';
import type { DB } from './types.js';

const dialect = new PostgresDialect({
  pool: new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 5,
  }),
});

export const db = new Kysely<DB>({ dialect });

export type { DB };