/**
 * Orchestrator — REAL (with mocked LLM fallback)
 *
 * The per-cycle brain. This is fully functional production code — no mocks
 * in the orchestration logic itself. The only mock is in the LLM call
 * (see agent.ts): when the Ollama API is unreachable, the orchestrator
 * gets a deterministic mock cadence plan instead of an LLM-generated one.
 *
 * Cycle flow:
 * 1. syncAll() — REAL: pulls state from GitHub into Postgres
 * 2. loadPendingReviewRequests() — REAL: queries DB for pending reviews
 * 3. buildReviewerLoads() — REAL: computes per-reviewer load scores
 * 4. scorePendingReviews() — REAL: deterministic scoring engine
 * 5. buildAgentContext() — REAL: assembles context for the LLM
 * 6. decideCadence() — PARTLY MOCKED: calls real Ollama API, falls back to mock
 * 7. Execute decisions — REAL: records follow-ups in DB, sends Slack if not dry-run
 * 8. recordAuditEvent() — REAL: logs cycle completion to audit_log
 *
 * DEDUP: The orchestrator skips recording a follow-up if one already exists
 * for the same (pr_id, reviewer_id) within the last 4 hours (hasRecentFollowUp).
 *
 * DRY_RUN: When DRY_RUN=true (the default), the orchestrator computes and
 * records decisions but does NOT send Slack messages. All follow-ups are
 * recorded with dry_run=true.
 */
import { logger } from '../config/logger.js';
import { trackedRepos } from '../config/env.js';
import { syncAll } from '../sync/sync.js';
import {
  loadPendingReviewRequests,
  loadRecentFollowUpsForReviewer,
  loadReviewerOpenRequestCount,
  hasRecentFollowUp,
  recordAuditEvent,
  recordFollowUp,
  type PendingReviewWithReviewer,
} from '../state/prs.js';
import {
  reviewerLoadScore,
  scorePendingReviews,
  type ReviewerLoad,
  type ScoredPendingReview,
} from '../intelligence/scoring.js';
import { decideCadence } from '../intelligence/agent.js';
import type { AgentContext, AgentContextReview } from '../intelligence/agentSchema.js';
import { sendDm } from '../integrations/slack.js';
import { env } from '../config/env.js';

const HOUR_MS = 60 * 60 * 1000;
const RECENT_PING_WINDOW_HOURS = 24;

async function buildReviewerLoads(
  pending: PendingReviewWithReviewer[],
  now: Date,
): Promise<Map<number, ReviewerLoad>> {
  const reviewerIds = [...new Set(pending.map((p) => p.reviewer_id))];
  const loads = new Map<number, ReviewerLoad>();
  const since = new Date(now.getTime() - RECENT_PING_WINDOW_HOURS * HOUR_MS);

  for (const id of reviewerIds) {
    const [openCount, recentFollowUps] = await Promise.all([
      loadReviewerOpenRequestCount(id),
      loadRecentFollowUpsForReviewer(id, since),
    ]);
    const reviewerLogin = pending.find((p) => p.reviewer_id === id)?.reviewer_login ?? 'unknown';
    loads.set(id, {
      reviewerId: id,
      reviewerLogin,
      openRequestCount: openCount,
      recentFollowUpCount: recentFollowUps.length,
      loadScore: reviewerLoadScore(openCount, recentFollowUps.length),
    });
  }
  return loads;
}

async function buildAgentContext(
  scored: ScoredPendingReview[],
  now: Date,
): Promise<AgentContext> {
  const recentFollowUpsByReviewer = new Map<number, Date | null>();
  const since = new Date(now.getTime() - RECENT_PING_WINDOW_HOURS * HOUR_MS);

  for (const s of scored) {
    if (!recentFollowUpsByReviewer.has(s.reviewer_id)) {
      const recent = await loadRecentFollowUpsForReviewer(s.reviewer_id, since);
      const latest = recent.length > 0 ? recent[0]?.sent_at ?? null : null;
      recentFollowUpsByReviewer.set(s.reviewer_id, latest);
    }
  }

  const reviews: AgentContextReview[] = scored.map((s) => {
    const lastPing = recentFollowUpsByReviewer.get(s.reviewer_id) ?? null;
    const hoursSinceLastPing = lastPing
      ? (now.getTime() - lastPing.getTime()) / HOUR_MS
      : null;
    return {
      reviewerLogin: s.reviewer_login,
      reviewerSlackId: s.reviewer_slack_id,
      prNumber: s.pr_number,
      prTitle: s.pr_title,
      prUrl: s.pr_html_url,
      repoFullName: s.repo_full_name,
      ageHours: Math.round(s.ageHours * 10) / 10,
      changedFiles: s.changed_files,
      additions: s.additions,
      deletions: s.deletions,
      openRequestCount: s.reviewerLoad.openRequestCount,
      recentFollowUpCount: s.reviewerLoad.recentFollowUpCount,
      compositeScore: s.compositeScore,
      prScore: s.prScore,
      reviewerLoadScore: s.reviewerLoad.loadScore,
      hoursSinceLastPing: hoursSinceLastPing === null ? null : Math.round(hoursSinceLastPing * 10) / 10,
    };
  });

  const uniqueReviewers = new Set(reviews.map((r) => r.reviewerLogin)).size;
  return {
    generatedAt: now.toISOString(),
    totalOpenReviews: reviews.length,
    uniqueReviewers,
    reviews,
  };
}

export async function runCycle(): Promise<void> {
  const now = new Date();
  logger.info({ dryRun: env.DRY_RUN }, 'starting orchestrator cycle');

  const specs = trackedRepos();
  if (specs.length === 0) {
    logger.warn('no repos configured (GITHUB_REPOS empty); nothing to sync');
    return;
  }

  await syncAll(specs);

  const pending = await loadPendingReviewRequests();
  if (pending.length === 0) {
    logger.info('no pending review requests; nothing to act on');
    return;
  }

  const reviewerLoads = await buildReviewerLoads(pending, now);
  const scored = scorePendingReviews(pending, reviewerLoads, now);

  logger.info(
    { totalPending: scored.length, topScore: scored[0]?.compositeScore ?? null },
    'scored pending reviews',
  );

  const ctx = await buildAgentContext(scored, now);
  const plan = await decideCadence(ctx);

  logger.info(
    { globalReasoning: plan.globalReasoning, decisionCount: plan.decisions.length },
    'LLM cadence plan received',
  );

  const pingCount = plan.decisions.filter((d) => d.decision.shouldPing).length;
  logger.info({ pingCount, dryRun: env.DRY_RUN }, 'pings planned');

  for (const d of plan.decisions) {
    if (!d.decision.shouldPing) {
      logger.debug(
        { reviewer: d.reviewerLogin, pr: d.prNumber, reason: d.decision.reason },
        'skip ping',
      );
      continue;
    }

    const matched = scored.find(
      (s) =>
        s.reviewer_login === d.reviewerLogin &&
        s.pr_number === d.prNumber &&
        s.repo_full_name === d.repoFullName,
    );
    if (!matched) {
      logger.warn(
        { decision: d },
        'LLM decision did not match any known pending review; skipping',
      );
      continue;
    }

    const messageText = d.decision.messageText ?? `Friendly nudge: ${matched.pr_title} (${matched.pr_html_url})`;

    const alreadyFollowedUp = await hasRecentFollowUp(matched.pr_id, matched.reviewer_id, 4);
    if (alreadyFollowedUp) {
      logger.info(
        { reviewer: d.reviewerLogin, pr: d.prNumber, reason: 'duplicate: follow-up recorded <4h ago for same reviewer+PR' },
        'skip ping — dedup',
      );
      continue;
    }

    if (env.DRY_RUN) {
      logger.info(
        { reviewer: d.reviewerLogin, pr: d.prNumber, messageText, reason: d.decision.reason },
        '[DRY RUN] would send Slack DM',
      );
      await recordFollowUp({
        prId: matched.pr_id,
        reviewerId: matched.reviewer_id,
        channel: 'slack',
        messageText,
        decisionReason: d.decision.reason,
        dryRun: true,
      });
      continue;
    }

    if (!matched.reviewer_slack_id) {
      logger.warn(
        { reviewer: d.reviewerLogin, pr: d.prNumber },
        'reviewer has no slack_user_id mapped; cannot send. Use setReviewerSlackId or map manually.',
      );
      await recordFollowUp({
        prId: matched.pr_id,
        reviewerId: matched.reviewer_id,
        channel: 'slack',
        messageText,
        decisionReason: `${d.decision.reason} [NOT SENT: no slack mapping]`,
        dryRun: true,
      });
      continue;
    }

    const sent = await sendDm(matched.reviewer_slack_id, messageText);
    await recordFollowUp({
      prId: matched.pr_id,
      reviewerId: matched.reviewer_id,
      channel: 'slack',
      messageText,
      decisionReason: d.decision.reason,
      dryRun: !sent,
    });
  }

  await recordAuditEvent('cycle_complete', {
    dryRun: env.DRY_RUN,
    pendingCount: pending.length,
    pingCount,
    globalReasoning: plan.globalReasoning,
  });

  logger.info('orchestrator cycle complete');
}