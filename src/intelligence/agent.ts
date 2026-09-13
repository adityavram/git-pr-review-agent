/**
 * LLM cadence agent — PARTIALLY REAL, PARTIALLY MOCKED
 *
 * REAL:
 * - The OpenAI SDK client is configured to point at an Ollama cloud endpoint
 *   (OpenAI-compatible API). The `decideCadence` function makes a real
 *   chat.completions.create() call with the system prompt and scored context.
 * - The system prompt encodes 7 social rules (no pings <6h, 4h between pings,
 *   back off on >=3 pending, etc.) and instructs the LLM to return strict JSON.
 * - The response is parsed with regex JSON extraction + Zod schema validation.
 * - If the LLM returns valid JSON, it's used directly — fully real.
 *
 * MOCKED (fallback):
 * - `mockCadence()` is a deterministic fallback that runs ONLY when the Ollama
 *   API is unreachable or returns non-JSON output. It applies the same social
 *   rules as the system prompt but in hard-coded if/else logic instead of
 *   LLM reasoning. It produces realistic-looking decisions with reasons and
 *   message text, but lacks the LLM's judgment for edge cases.
 * - In the current deployment, the Ollama cloud endpoint (api.olama.cloud) is
 *   dead (DNS doesn't resolve), so the mock fallback is ALWAYS being used.
 *   To use the real LLM, set OLLAMA_BASE_URL to a working Ollama endpoint
 *   (e.g. http://localhost:11434/v1 for local Ollama, or a working cloud URL).
 */
import OpenAI from 'openai';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { AgentContext, CadencePlan } from './agentSchema.js';
import { CadencePlanSchema } from './agentSchema.js';

const client = new OpenAI({
  baseURL: env.OLLAMA_BASE_URL,
  apiKey: env.OLLAMA_API_KEY || undefined,
});

// REAL: This system prompt is sent to the LLM when the API is reachable.
// It encodes the same social rules that the mock fallback implements.
const SYSTEM_PROMPT = `You are the PR Review Morale Agent. Your job: decide when and how to follow up with PR reviewers so reviews actually happen WITHOUT overwhelming or demoralizing them.

Non-negotiable social rules:
1. Never ping the same reviewer more than once per 4 hours.
2. If a reviewer has >=3 outstanding pending reviews, do NOT ping them this cycle unless one of their PRs is on fire (age > 72h AND high composite score). In that case, pick AT MOST ONE.
3. Prefer batching: if you must ping a reviewer, acknowledge their other pending reviews briefly so they can batch their review time.
4. Tone: warm, specific, human, low-pressure. Never blame. Never guilt-trip. Reference the PR by title and link. Offer context (what's blocking, what depends on it) when you have it.
5. If a PR is <6h old, do NOT ping. Give people a chance to see the GitHub notification naturally.
6. If a reviewer has no Slack ID mapped, do not propose a Slack ping (shouldPing=false).
7. Message text must be short (<=280 chars), ready to send as a Slack DM, no markdown headers.

You return a strict JSON cadence plan. Each decision has shouldPing, reason, messageText (null if not pinging), and urgency. Always include globalReasoning explaining your prioritization.

Return ONLY valid JSON. No prose before or after the JSON object.`;

/**
 * REAL: Calls the Ollama LLM with the scored context and gets a cadence plan.
 * Falls back to mockCadence() if the API is unreachable or returns bad JSON.
 */
export async function decideCadence(ctx: AgentContext): Promise<CadencePlan> {
  const userPrompt = `Here is the current state of all pending PR review requests across tracked repos. Decide which reviewers (if any) to ping this cycle.

Return JSON matching this shape:
{
  "globalReasoning": string,
  "decisions": [
    {
      "reviewerLogin": string,
      "prNumber": number,
      "repoFullName": string,
      "decision": {
        "shouldPing": boolean,
        "reason": string,
        "messageText": string | null,
        "urgency": "low" | "medium" | "high"
      }
    }
  ]
}

Include a decision entry for EVERY review in the input (even if shouldPing=false). Do not omit any.

Current time: ${ctx.generatedAt}
Total pending reviews: ${ctx.totalOpenReviews}
Unique reviewers: ${ctx.uniqueReviewers}

Reviews (JSON):
${JSON.stringify(ctx.reviews, null, 2)}`;

  logger.debug({ reviewCount: ctx.reviews.length, model: env.OLLAMA_MODEL }, 'calling Ollama for cadence decision');

  let text: string;
  try {
    const response = await client.chat.completions.create({
      model: env.OLLAMA_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.4,
    });
    text = response.choices[0]?.message?.content ?? '';
  } catch (err) {
    logger.error({ err }, 'Ollama chat completion failed; falling back to mock cadence');
    return mockCadence(ctx);
  }

  let parsed: unknown;
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
  } catch (err) {
    logger.error({ err, rawText: text }, 'Ollama returned non-JSON output; falling back to mock cadence');
    return mockCadence(ctx);
  }

  return CadencePlanSchema.parse(parsed);
}

/**
 * MOCKED: Deterministic fallback cadence planner.
 * Used only when the Ollama LLM API is unreachable or returns invalid JSON.
 * Implements the same social rules as the system prompt but as if/else logic.
 * Does NOT call any external API — it's pure local computation.
 */
function mockCadence(ctx: AgentContext): CadencePlan {
  const decisions = ctx.reviews.map((r) => {
    const tooNew = r.ageHours < 6;
    const onFire = r.ageHours > 72 && r.compositeScore > 0;
    const overloaded = r.openRequestCount >= 3 && !onFire;
    const hasSlack = r.reviewerSlackId !== null;
    const recentlyPinged = r.hoursSinceLastPing !== null && r.hoursSinceLastPing < 4;

    let shouldPing = false;
    let urgency: 'low' | 'medium' | 'high' = 'low';
    let reason: string;
    let messageText: string | null = null;

    if (tooNew) {
      reason = `PR is only ${r.ageHours}h old — giving reviewer time to see the GitHub notification naturally.`;
    } else if (overloaded) {
      reason = `${r.reviewerLogin} has ${r.openRequestCount} outstanding pending reviews — backing off to avoid burnout.`;
    } else if (recentlyPinged) {
      reason = `Last ping was ${r.hoursSinceLastPing}h ago — waiting at least 4h between pings.`;
    } else if (!hasSlack) {
      reason = `${r.reviewerLogin} has no Slack mapping — cannot DM. Map them via SQL or users.lookupByEmail.`;
    } else if (r.compositeScore > 1.5 || onFire) {
      shouldPing = true;
      urgency = 'high';
      reason = `PR "${r.prTitle}" has high urgency (score ${r.compositeScore}) and ${r.reviewerLogin} has capacity. ${onFire ? 'PR is on fire (age > 72h).' : ''}`;
      messageText = `Hey! ${r.prTitle} (#${r.prNumber}) in ${r.repoFullName} could use a review when you have a moment. It's been ${r.ageHours}h and has ${r.changedFiles} changed files. No rush — just didn't want it to get lost in the queue!`;
    } else if (r.compositeScore > 0.5) {
      shouldPing = true;
      urgency = 'medium';
      reason = `Moderate urgency (score ${r.compositeScore}) — ${r.reviewerLogin} has capacity for a gentle nudge.`;
      messageText = `Hi! Just a friendly heads-up about ${r.prTitle} (#${r.prNumber}) in ${r.repoFullName}. It's been ${r.ageHours}h and would benefit from a look when you get a chance.`;
    } else {
      shouldPing = false;
      urgency = 'low';
      reason = `Low urgency (score ${r.compositeScore}) — no need to ping this cycle.`;
    }

    return {
      reviewerLogin: r.reviewerLogin,
      prNumber: r.prNumber,
      repoFullName: r.repoFullName,
      decision: {
        shouldPing,
        reason,
        messageText,
        urgency,
      },
    };
  });

  const pingCount = decisions.filter((d) => d.decision.shouldPing).length;
  const skipCount = decisions.length - pingCount;

  return {
    globalReasoning: `Mock cadence (LLM unreachable): Evaluated ${decisions.length} pending reviews. Pinged ${pingCount}, skipped ${skipCount}. Applied rules: no pings for PRs <6h old, 4h minimum between pings, back off if reviewer has >=3 pending reviews (unless PR is on fire: age > 72h), no ping if no Slack mapping. Prioritized by composite score (urgency - morale penalty).`,
    decisions,
  };
}