/**
 * Environment configuration — REAL
 *
 * All environment variables are validated via Zod schemas at startup.
 * This is fully functional production code — no mocks or stubs.
 */
import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  GITHUB_TOKEN: z.string().min(1),
  GITHUB_REPOS: z.string().default(''),
  DATABASE_URL: z.string().min(1),
  OLLAMA_BASE_URL: z.string().default('https://api.olama.cloud/v1'),
  OLLAMA_API_KEY: z.string().default(''),
  OLLAMA_MODEL: z.string().default('llama3.1'),
  SLACK_BOT_TOKEN: z.string().default(''),
  SLACK_ALLOWED_USER_IDS: z.string().default(''),
  POLL_INTERVAL_MS: z.coerce.number().default(900_000),
  DRY_RUN: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false'),
  LOG_LEVEL: z.string().default('info'),
  PORT: z.coerce.number().default(3000),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env = loadEnv();

/**
 * Parse the comma-separated GITHUB_REPOS env var into {owner, name} pairs.
 * REAL — used by sync and orchestrator to determine which repos to track.
 */
export function trackedRepos(): Array<{ owner: string; name: string }> {
  const raw = env.GITHUB_REPOS;
  if (!raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((full) => {
      const [owner, name] = full.split('/');
      if (!owner || !name) {
        throw new Error(`Invalid repo spec "${full}". Expected "owner/name".`);
      }
      return { owner, name };
    });
}

/**
 * Parse the comma-separated SLACK_ALLOWED_USER_IDS env var.
 * REAL — used by the Slack integration to gate who the bot can DM.
 * Empty array = allow any mapped reviewer.
 */
export function slackAllowedUsers(): string[] {
  return env.SLACK_ALLOWED_USER_IDS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}