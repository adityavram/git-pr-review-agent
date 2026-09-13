/**
 * State layer: repos + reviewers — REAL
 *
 * Typed upserts and queries for the `repos` and `reviewers` tables.
 * All functions are fully implemented and hit the real Postgres DB.
 *
 * MOCK DATA NOTE: `setReviewerSlackId` is used for manual Slack mapping.
 * The mock bot reviewers in the current DB have fake Slack user IDs
 * (U000001AAA, etc.) that don't correspond to real Slack accounts.
 * In a real deployment, these would be populated via `users.lookupByEmail`
 * (planned roadmap item) or real manual mapping.
 */
import { db } from '../db/client.js';
import type { DB } from '../db/types.js';
import type { Selectable } from 'kysely';

type Repo = Selectable<DB['repos']>;
type Reviewer = Selectable<DB['reviewers']>;

export async function upsertRepo(params: {
  owner: string;
  name: string;
  defaultBranch: string | null;
}): Promise<Repo> {
  const fullName = `${params.owner}/${params.name}`;
  const existing = await db
    .selectFrom('repos')
    .selectAll()
    .where('full_name', '=', fullName)
    .executeTakeFirst();

  if (existing) {
    return existing;
  }

  return db
    .insertInto('repos')
    .values({
      owner: params.owner,
      name: params.name,
      full_name: fullName,
      default_branch: params.defaultBranch,
      last_synced_at: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function markRepoSynced(repoId: number): Promise<void> {
  await db
    .updateTable('repos')
    .set({ last_synced_at: new Date() })
    .where('id', '=', repoId)
    .execute();
}

export async function upsertReviewer(params: {
  githubLogin: string;
  githubUserId?: number | null;
  displayName?: string | null;
}): Promise<Reviewer> {
  const existing = await db
    .selectFrom('reviewers')
    .selectAll()
    .where('github_login', '=', params.githubLogin)
    .executeTakeFirst();

  if (existing) {
    if (
      (params.githubUserId !== undefined && existing.github_user_id !== params.githubUserId) ||
      (params.displayName !== undefined && existing.display_name !== params.displayName)
    ) {
      return db
        .updateTable('reviewers')
        .set({
          github_user_id: params.githubUserId ?? existing.github_user_id,
          display_name: params.displayName ?? existing.display_name,
          updated_at: new Date(),
        })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    }
    return existing;
  }

  return db
    .insertInto('reviewers')
    .values({
      github_login: params.githubLogin,
      github_user_id: params.githubUserId ?? null,
      display_name: params.displayName ?? null,
      slack_user_id: null,
      email: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

export async function setReviewerSlackId(
  githubLogin: string,
  slackUserId: string,
): Promise<void> {
  await db
    .updateTable('reviewers')
    .set({ slack_user_id: slackUserId, updated_at: new Date() })
    .where('github_login', '=', githubLogin)
    .execute();
}