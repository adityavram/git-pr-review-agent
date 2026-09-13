/**
 * CLI entrypoint: `npm run once` — REAL (with mocked LLM fallback)
 *
 * Runs one full orchestrator cycle: sync → score → LLM decide → act → audit.
 * The LLM call falls back to the mock cadence if Ollama is unreachable.
 * See orchestrator.ts and agent.ts for details on what's real vs mocked.
 */
import { logger } from '../config/logger.js';
import { runCycle } from '../orchestrator/orchestrator.js';
import { db } from '../db/client.js';

async function main(): Promise<void> {
  await runCycle();
  await db.destroy();
}

main().catch((err) => {
  logger.error({ err }, 'runOnce command failed');
  process.exit(1);
});