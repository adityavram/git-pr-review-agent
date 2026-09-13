/**
 * Slack integration — REAL (but not currently sending)
 *
 * All functions are fully implemented against the real Slack Web API.
 * No mocks — `sendDm` makes a real `chat.postMessage` API call.
 *
 * CURRENT STATE: The `SLACK_BOT_TOKEN` env var is not set (defaults to empty),
 * so `slack()` returns null and `sendDm` logs a warning and returns false.
 * The orchestrator records these as dry-run follow-ups.
 *
 * To enable real Slack DMs:
 * 1. Set SLACK_BOT_TOKEN to a real xoxb- token
 * 2. Set SLACK_ALLOWED_USER_IDS to gate who can be DMed
 * 3. Set DRY_RUN=false
 * 4. Ensure reviewers have real slack_user_id values in the DB
 *    (the current mock bot reviewers have fake Slack IDs like U000001AAA)
 */
import { WebClient } from '@slack/web-api';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { slackAllowedUsers } from '../config/env.js';

let client: WebClient | null = null;

function slack(): WebClient | null {
  if (!env.SLACK_BOT_TOKEN) return null;
  if (!client) client = new WebClient(env.SLACK_BOT_TOKEN);
  return client;
}

export async function resolveDmChannel(slackUserId: string): Promise<string | null> {
  const api = slack();
  if (!api) return null;
  try {
    const res = await api.conversations.open({ users: slackUserId });
    return res.channel?.id ?? null;
  } catch (err) {
    logger.error({ err, slackUserId }, 'failed to open Slack DM channel');
    return null;
  }
}

export async function sendDm(slackUserId: string, text: string): Promise<boolean> {
  const api = slack();
  if (!api) {
    logger.warn('Slack token not configured; skipping send');
    return false;
  }

  const allowlist = slackAllowedUsers();
  if (allowlist.length > 0 && !allowlist.includes(slackUserId)) {
    logger.warn(
      { slackUserId, allowlist },
      'slack user not in allowlist; skipping send (set SLACK_ALLOWED_USER_IDS or leave empty)',
    );
    return false;
  }

  const channelId = await resolveDmChannel(slackUserId);
  if (!channelId) return false;

  await api.chat.postMessage({ channel: channelId, text, mrkdwn: true });
  logger.info({ slackUserId }, 'slack DM sent');
  return true;
}