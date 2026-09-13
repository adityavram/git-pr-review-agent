/**
 * Long-running entrypoint — REAL
 *
 * Starts the web UI server and runs the orchestrator on a poll interval.
 * This is fully functional production code — no mocks.
 *
 * Flow:
 * 1. Start web server on PORT (default 3000)
 * 2. Run one orchestrator cycle immediately (don't wait for first interval)
 * 3. Schedule subsequent cycles every POLL_INTERVAL_MS (default 15 min)
 * 4. Graceful shutdown on SIGINT/SIGTERM (destroys DB pool)
 */
import { logger } from './config/logger.js';
import { env } from './config/env.js';
import { runCycle } from './orchestrator/orchestrator.js';
import { db } from './db/client.js';
import { startWebServer } from './web/server.js';

async function main(): Promise<void> {
  logger.info(
    { pollIntervalMs: env.POLL_INTERVAL_MS, dryRun: env.DRY_RUN, port: env.PORT },
    'agent starting',
  );

  startWebServer();

  const runOnce = async (): Promise<void> => {
    try {
      await runCycle();
    } catch (err) {
      logger.error({ err }, 'cycle failed');
    }
  };

  await runOnce();
  setInterval(runOnce, env.POLL_INTERVAL_MS);

  const shutdown = async (sig: string): Promise<void> => {
    logger.info({ sig }, 'shutting down');
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal startup error');
  process.exit(1);
});