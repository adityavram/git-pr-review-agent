/**
 * LLM agent Zod schemas + context types — REAL
 *
 * These define the structured JSON contract between the LLM and the orchestrator.
 * The LLM returns a `CadencePlan` (validated by Zod), containing a decision
 * per pending review. No mocks — these are pure type/schema definitions.
 */
import { z } from 'zod';

export const FollowUpDecisionSchema = z.object({
  shouldPing: z.boolean(),
  reason: z.string(),
  messageText: z.string().nullable(),
  urgency: z.enum(['low', 'medium', 'high']),
});
export type FollowUpDecision = z.infer<typeof FollowUpDecisionSchema>;

export const CadencePlanSchema = z.object({
  decisions: z.array(
    z.object({
      reviewerLogin: z.string(),
      prNumber: z.number(),
      repoFullName: z.string(),
      decision: FollowUpDecisionSchema,
    }),
  ),
  globalReasoning: z.string(),
});
export type CadencePlan = z.infer<typeof CadencePlanSchema>;

export interface AgentContextReview {
  reviewerLogin: string;
  reviewerSlackId: string | null;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  repoFullName: string;
  ageHours: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  openRequestCount: number;
  recentFollowUpCount: number;
  compositeScore: number;
  prScore: number;
  reviewerLoadScore: number;
  hoursSinceLastPing: number | null;
}

export interface AgentContext {
  generatedAt: string;
  totalOpenReviews: number;
  uniqueReviewers: number;
  reviews: AgentContextReview[];
}