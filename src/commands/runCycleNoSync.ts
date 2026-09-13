/**
 * CLI entrypoint: run a cycle WITHOUT syncing from GitHub first — DEV UTILITY
 *
 * This is a development utility script (not in package.json scripts) used to
 * run the scoring + LLM decision + follow-up recording flow against the
 * existing DB state, without the sync step overwriting manually-set test data
 * (e.g. backdated PR timestamps for testing the scoring engine).
 *
 * REAL: All logic is real (scoring, follow-up recording, audit).
 * MOCKED: The LLM call falls back to mock cadence (Ollama unreachable).
 */
import { loadPendingReviewRequests, loadReviewerOpenRequestCount, loadRecentFollowUpsForReviewer, recordFollowUp, recordAuditEvent } from '../state/prs.js';
import { scorePendingReviews, reviewerLoadScore } from '../intelligence/scoring.js';
import { decideCadence } from '../intelligence/agent.js';
import type { AgentContext, AgentContextReview } from '../intelligence/agentSchema.js';

const HOUR_MS = 60 * 60 * 1000;
const now = new Date();

const pending = await loadPendingReviewRequests();
console.log('Pending:', pending.length);

const reviewerIds = [...new Set(pending.map((p) => p.reviewer_id))];
const loads = new Map();
for (const id of reviewerIds) {
  const [openCount, recentFollowUps] = await Promise.all([
    loadReviewerOpenRequestCount(id),
    loadRecentFollowUpsForReviewer(id, new Date(now.getTime() - 24 * HOUR_MS)),
  ]);
  loads.set(id, {
    reviewerId: id,
    reviewerLogin: pending.find((p) => p.reviewer_id === id)?.reviewer_login ?? 'unknown',
    openRequestCount: openCount,
    recentFollowUpCount: recentFollowUps.length,
    loadScore: reviewerLoadScore(openCount, recentFollowUps.length),
  });
}

const scored = scorePendingReviews(pending, loads, now);
console.log('Top score:', scored[0]?.compositeScore);

const reviews: AgentContextReview[] = scored.map((s) => ({
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
  hoursSinceLastPing: null,
}));

const ctx: AgentContext = {
  generatedAt: now.toISOString(),
  totalOpenReviews: reviews.length,
  uniqueReviewers: new Set(reviews.map((r) => r.reviewerLogin)).size,
  reviews,
};

const plan = await decideCadence(ctx);
console.log('Reasoning:', plan.globalReasoning);
const pingCount = plan.decisions.filter((d) => d.decision.shouldPing).length;
console.log('Pings planned:', pingCount);

for (const d of plan.decisions) {
  if (!d.decision.shouldPing) continue;
  const matched = scored.find(
    (s) => s.reviewer_login === d.reviewerLogin && s.pr_number === d.prNumber && s.repo_full_name === d.repoFullName,
  );
  if (!matched) continue;
  const messageText = d.decision.messageText ?? 'nudge';
  await recordFollowUp({
    prId: matched.pr_id,
    reviewerId: matched.reviewer_id,
    channel: 'slack',
    messageText,
    decisionReason: d.decision.reason,
    dryRun: true,
  });
  console.log('Recorded:', d.reviewerLogin, '-> PR #' + d.prNumber);
}

await recordAuditEvent('cycle_complete', {
  dryRun: true,
  pendingCount: pending.length,
  pingCount,
  globalReasoning: plan.globalReasoning,
});
console.log('Done');
process.exit(0);