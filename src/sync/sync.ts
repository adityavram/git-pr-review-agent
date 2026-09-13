/**
 * GitHub sync orchestration — REAL
 *
 * The sync layer pulls state from GitHub into Postgres. This is fully
 * functional production code — no mocks. Each cycle:
 * 1. Fetches the repo's default branch
 * 2. Upserts the repo row
 * 3. Fetches all open PRs (paginated)
 * 4. For each non-draft PR, fetches review requests + submitted reviews
 * 5. Detects stale PRs (open in DB but not in GitHub) and marks them closed
 * 6. Fetches and persists branch protection data (required approvals, code owners)
 * 7. Marks the repo as synced
 *
 * BRANCH PROTECTION: The `required_approving_review_count` and
 * `requires_code_owner_reviews` values are persisted to the `repos` table.
 * The demo repo (adityavram/pr-review-agent-demo) has real branch protection
 * requiring 2 approvals, set via the GitHub API.
 */
import { logger } from '../config/logger.js';
import { db } from '../db/client.js';
import {
  fetchBranchProtection,
  fetchOpenPrs,
  fetchRepoDefaultBranch,
  fetchReviewRequests,
  type RepoSpec,
} from '../github/client.js';
import { markRepoSynced, upsertRepo } from '../state/repos.js';
import {
  markPrClosed,
  upsertPr,
  upsertReviewRequest,
  type PrSnapshot,
} from '../state/prs.js';

export interface SyncResult {
  repo: RepoSpec;
  openPrCount: number;
  reviewRequestCount: number;
}

export async function syncRepo(spec: RepoSpec): Promise<SyncResult> {
  logger.info({ repo: `${spec.owner}/${spec.name}` }, 'syncing repo');

  const defaultBranch = await fetchRepoDefaultBranch(spec);
  const repo = await upsertRepo({ owner: spec.owner, name: spec.name, defaultBranch });

  const openPrs = await fetchOpenPrs(spec);

  const knownNumbers = new Set<number>();
  let reviewRequestCount = 0;

  for (const pr of openPrs) {
    knownNumbers.add(pr.number);
    const snap: PrSnapshot = {
      repoId: repo.id,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      draft: pr.draft,
      authorLogin: pr.authorLogin,
      headRef: pr.headRef,
      baseRef: pr.baseRef,
      createdAtGithub: pr.createdAt,
      updatedAtGithub: pr.updatedAt,
      mergeableState: pr.mergeableState,
      mergeable: pr.mergeable,
      additions: pr.additions,
      deletions: pr.deletions,
      changedFiles: pr.changedFiles,
      commits: pr.commits,
      htmlUrl: pr.htmlUrl,
      body: pr.body,
    };
    const persistedPr = await upsertPr(snap);

    if (!pr.draft) {
      const requests = await fetchReviewRequests(spec, pr.number, pr.createdAt);
      for (const rr of requests) {
        await upsertReviewRequest({
          prId: persistedPr.id,
          reviewerLogin: rr.reviewerLogin,
          requestedAt: rr.requestedAt,
          state: rr.state,
          reviewSubmittedAt: rr.reviewSubmittedAt,
        });
        reviewRequestCount++;
      }
    }
  }

  const staleOpen = await db
    .selectFrom('pull_requests')
    .select(['number'])
    .where('repo_id', '=', repo.id)
    .where('state', '=', 'open')
    .where('number', 'not in', knownNumbers.size ? Array.from(knownNumbers) : [0])
    .execute();

  for (const row of staleOpen) {
    await markPrClosed(repo.id, row.number);
  }

  // Fetch and persist branch protection for the default branch
  const branch = defaultBranch;
  const protection = await fetchBranchProtection(spec, branch);
  await db
    .updateTable('repos')
    .set({
      required_approving_review_count: protection.requiredApprovingReviewCount,
      requires_code_owner_reviews: protection.requiresCodeOwnerReviews,
    })
    .where('id', '=', repo.id)
    .execute();
  logger.debug(
    { repo: `${spec.owner}/${spec.name}`, branch, protection },
    'branch protection persisted',
  );

  await markRepoSynced(repo.id);

  logger.info(
    { repo: `${spec.owner}/${spec.name}`, openPrCount: openPrs.length, reviewRequestCount },
    'sync complete',
  );

  return { repo: spec, openPrCount: openPrs.length, reviewRequestCount };
}

export async function syncAll(specs: RepoSpec[]): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const spec of specs) {
    try {
      results.push(await syncRepo(spec));
    } catch (err) {
      logger.error({ err, repo: `${spec.owner}/${spec.name}` }, 'sync failed');
    }
  }
  return results;
}