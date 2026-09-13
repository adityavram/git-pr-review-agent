/**
 * Scoring engine — REAL (deterministic, no LLM)
 *
 * Pure functions that compute a composite score for each pending review.
 * This is fully functional production code — no mocks, no external calls.
 *
 * Scoring formula:
 * - prScore: ageScore (caps at 3) + changeScore (log-scaled, caps at 2) + sizeScore (log-scaled, caps at 2)
 * - reviewerLoadScore: loadFromRequests (caps at 3) + loadFromPings (caps at 2)
 * - compositeScore: urgency (prScore * age amplification) - moralePenalty (reviewerLoad * 0.6)
 *
 * The composite score can go negative for overloaded reviewers on low-urgency PRs
 * — this is intentional (the agent should back off).
 *
 * NOTE: `commits` is passed as 0 because the `PendingReviewWithReviewer` shape
 * doesn't carry commit count from the DB join. The data is available in the
 * `pull_requests` table but not surfaced to scoring. This is a minor data gap,
 * not a mock.
 */
import type { PendingReviewWithReviewer } from '../state/prs.js';

export interface ReviewerLoad {
  reviewerId: number;
  reviewerLogin: string;
  openRequestCount: number;
  recentFollowUpCount: number;
  loadScore: number;
}

export interface ScoredPendingReview extends PendingReviewWithReviewer {
  ageHours: number;
  prScore: number;
  reviewerLoad: ReviewerLoad;
  compositeScore: number;
}

const HOUR_MS = 60 * 60 * 1000;

export function ageHours(from: Date, now: Date = new Date()): number {
  return Math.max(0, (now.getTime() - from.getTime()) / HOUR_MS);
}

export function scorePr(params: {
  ageHours: number;
  changedFiles: number;
  commits: number;
  additions: number;
  deletions: number;
}): number {
  const ageScore = Math.min(params.ageHours / 48, 3);
  const changeScore = Math.min(Math.log1p(params.changedFiles) / 3, 2);
  const sizeScore = Math.min(Math.log1p(params.additions + params.deletions) / 5, 2);
  return Number((ageScore + changeScore + sizeScore).toFixed(3));
}

export function reviewerLoadScore(openRequestCount: number, recentFollowUpCount: number): number {
  const loadFromRequests = Math.min(openRequestCount / 3, 3);
  const loadFromPings = Math.min(recentFollowUpCount, 2);
  return Number((loadFromRequests + loadFromPings).toFixed(3));
}

export function compositeScore(prScore: number, reviewerLoadScoreValue: number, ageHours: number): number {
  const urgency = prScore * (1 + Math.min(ageHours / 72, 0.5));
  const moralePenalty = reviewerLoadScoreValue * 0.6;
  return Number((urgency - moralePenalty).toFixed(3));
}

export function scorePendingReviews(
  pending: PendingReviewWithReviewer[],
  reviewerLoads: Map<number, ReviewerLoad>,
  now: Date = new Date(),
): ScoredPendingReview[] {
  const scored = pending.map((r) => {
    const ageH = ageHours(r.requested_at, now);
    const prScore = scorePr({
      ageHours: ageH,
      changedFiles: r.changed_files,
      commits: 0,
      additions: r.additions,
      deletions: r.deletions,
    });
    const load = reviewerLoads.get(r.reviewer_id) ?? {
      reviewerId: r.reviewer_id,
      reviewerLogin: r.reviewer_login,
      openRequestCount: 0,
      recentFollowUpCount: 0,
      loadScore: 0,
    };
    const composite = compositeScore(prScore, load.loadScore, ageH);
    return { ...r, ageHours: ageH, prScore, reviewerLoad: load, compositeScore: composite };
  });
  scored.sort((a, b) => b.compositeScore - a.compositeScore);
  return scored;
}