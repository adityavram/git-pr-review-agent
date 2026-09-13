/**
 * GitHub client — REAL
 *
 * All functions use the Octokit SDK to make real GitHub API calls.
 * No mocks — every function hits the live GitHub API.
 *
 * Functions:
 * - fetchRepoDefaultBranch: GET /repos/{owner}/{repo}
 * - fetchOpenPrs: paginated GET /repos/{owner}/{repo}/pulls?state=open
 * - fetchReviewRequests: GET /pulls/{number}/requested_reviewers + GET /pulls/{number}/reviews
 * - fetchBranchProtection: GET /repos/{owner}/{repo}/branches/{branch}/protection
 *   (Returns nulls on error — graceful degradation for unprotected branches)
 */
import { Octokit } from 'octokit';
import { env } from '../config/env.js';

export const octokit = new Octokit({ auth: env.GITHUB_TOKEN });

export interface RepoSpec {
  owner: string;
  name: string;
}

export interface GhPullRequest {
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  authorLogin: string;
  headRef: string;
  baseRef: string;
  createdAt: Date;
  updatedAt: Date;
  mergeableState: string | null;
  mergeable: boolean | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  htmlUrl: string;
  body: string | null;
}

export interface GhReviewRequest {
  reviewerLogin: string;
  requestedAt: Date;
  state: 'pending' | 'approved' | 'changes_requested' | 'dismissed';
  reviewSubmittedAt: Date | null;
}

export async function fetchRepoDefaultBranch(spec: RepoSpec): Promise<string> {
  const { data } = await octokit.rest.repos.get({ owner: spec.owner, repo: spec.name });
  return data.default_branch ?? 'main';
}

export async function fetchOpenPrs(spec: RepoSpec): Promise<GhPullRequest[]> {
  const prs: GhPullRequest[] = [];
  const iter = octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner: spec.owner,
    repo: spec.name,
    state: 'open',
    per_page: 100,
  });

  for await (const { data } of iter) {
    for (const pr of data as Array<Record<string, unknown>>) {
      const headRef = (pr.head as { ref?: string } | undefined)?.ref;
      const baseRef = (pr.base as { ref?: string } | undefined)?.ref;
      if (!headRef || !baseRef) continue;
      const user = pr.user as { login?: string } | undefined;
      prs.push({
        number: pr.number as number,
        title: (pr.title as string) ?? '(no title)',
        state: 'open',
        draft: (pr.draft as boolean) ?? false,
        authorLogin: user?.login ?? 'unknown',
        headRef,
        baseRef,
        createdAt: new Date(pr.created_at as string),
        updatedAt: new Date(pr.updated_at as string),
        mergeableState: (pr.mergeable_state as string) ?? null,
        mergeable: (pr.mergeable as boolean) ?? null,
        additions: (pr.additions as number) ?? 0,
        deletions: (pr.deletions as number) ?? 0,
        changedFiles: (pr.changed_files as number) ?? 0,
        commits: (pr.commits as number) ?? 0,
        htmlUrl: (pr.html_url as string) ?? '',
        body: (pr.body as string) ?? null,
      });
    }
  }
  return prs;
}

export async function fetchReviewRequests(
  spec: RepoSpec,
  prNumber: number,
  prCreatedAt: Date,
): Promise<GhReviewRequest[]> {
  const { data: requested } = await octokit.rest.pulls.listRequestedReviewers({
    owner: spec.owner,
    repo: spec.name,
    pull_number: prNumber,
  });

  const requests: GhReviewRequest[] = (requested.users ?? []).map((u) => ({
    reviewerLogin: u.login ?? 'unknown',
    requestedAt: prCreatedAt,
    state: 'pending' as const,
    reviewSubmittedAt: null,
  }));

  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner: spec.owner,
    repo: spec.name,
    pull_number: prNumber,
    per_page: 100,
  });

  const latestByReviewer = new Map<string, GhReviewRequest>();
  for (const r of reviews) {
    const login = r.user?.login;
    if (!login) continue;
    const submittedAt = r.submitted_at ? new Date(r.submitted_at) : null;
    let state: GhReviewRequest['state'] = 'pending';
    if (r.state === 'APPROVED') state = 'approved';
    else if (r.state === 'CHANGES_REQUESTED') state = 'changes_requested';
    else if (r.state === 'DISMISSED') state = 'dismissed';
    // pending otherwise (COMMENTED/PENDING/etc.)

    const existing = latestByReviewer.get(login);
    const candidate: GhReviewRequest = {
      reviewerLogin: login,
      requestedAt: prCreatedAt,
      state,
      reviewSubmittedAt: submittedAt,
    };
    if (
      !existing ||
      (submittedAt && existing.reviewSubmittedAt && submittedAt > existing.reviewSubmittedAt)
    ) {
      latestByReviewer.set(login, candidate);
    }
  }

  const reviewEntries = Array.from(latestByReviewer.values());

  const byReviewer = new Map<string, GhReviewRequest>();
  for (const rr of requests) byReviewer.set(rr.reviewerLogin, rr);
  for (const rev of reviewEntries) {
    const existing = byReviewer.get(rev.reviewerLogin);
    if (!existing) {
      byReviewer.set(rev.reviewerLogin, rev);
    } else if (rev.state !== 'pending') {
      byReviewer.set(rev.reviewerLogin, { ...existing, ...rev });
    }
  }

  return Array.from(byReviewer.values());
}

export async function fetchBranchProtection(
  spec: RepoSpec,
  branch: string,
): Promise<{ requiredApprovingReviewCount: number | null; requiresCodeOwnerReviews: boolean | null }> {
  try {
    const { data } = await octokit.rest.repos.getBranchProtection({
      owner: spec.owner,
      repo: spec.name,
      branch,
    });
    return {
      requiredApprovingReviewCount:
        data.required_pull_request_reviews?.required_approving_review_count ?? null,
      requiresCodeOwnerReviews:
        data.required_pull_request_reviews?.require_code_owner_reviews ?? null,
    };
  } catch {
    return { requiredApprovingReviewCount: null, requiresCodeOwnerReviews: null };
  }
}