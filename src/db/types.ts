/**
 * Database table types — REAL
 *
 * Kysely type definitions for all 6 tables in the schema.
 * These mirror the migration in `migrations/0001_initial.ts` exactly.
 *
 * MOCK DATA NOTE: The `reviewers` table currently contains mock bot reviewers
 * (code-review-bot, code-hygiene-bot, etc.) inserted manually via SQL, not
 * synced from GitHub. The `review_requests` for these mock reviewers were
 * also inserted manually. In a real deployment, these would come from the
 * GitHub sync layer. The `repos.required_approving_review_count` and
 * `requires_code_owner_reviews` columns ARE real — they're populated by the
 * sync layer from the GitHub branch protection API.
 */
import type { Generated } from 'kysely';

export interface ReposTable {
  id: Generated<number>;
  owner: string;
  name: string;
  full_name: string;
  default_branch: string | null;
  last_synced_at: Date | null;
  required_approving_review_count: number | null;
  requires_code_owner_reviews: boolean | null;
  created_at: Generated<Date>;
}

export interface ReviewersTable {
  id: Generated<number>;
  github_login: string;
  github_user_id: number | null;
  display_name: string | null;
  slack_user_id: string | null;
  email: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface PullRequestsTable {
  id: Generated<number>;
  repo_id: number;
  number: number;
  title: string;
  state: 'open' | 'closed';
  draft: boolean;
  author_login: string;
  head_ref: string;
  base_ref: string;
  created_at_github: Date;
  updated_at_github: Date;
  mergeable_state: string | null;
  mergeable: boolean | null;
  additions: number;
  deletions: number;
  changed_files: number;
  commits: number;
  html_url: string;
  body: string | null;
  last_synced_at: Generated<Date>;
  first_seen_at: Generated<Date>;
}

export interface ReviewRequestsTable {
  id: Generated<number>;
  pr_id: number;
  reviewer_id: number;
  requested_at: Date;
  state: 'pending' | 'approved' | 'changes_requested' | 'dismissed';
  review_submitted_at: Date | null;
  created_at: Generated<Date>;
}

export interface FollowUpsTable {
  id: Generated<number>;
  pr_id: number;
  reviewer_id: number;
  channel: 'slack' | 'teams' | 'github_comment';
  message_text: string | null;
  sent_at: Generated<Date>;
  decision_reason: string;
  dry_run: boolean;
}

export interface AuditLogTable {
  id: Generated<number>;
  event_type: string;
  payload: unknown;
  created_at: Generated<Date>;
}

export interface DB {
  repos: ReposTable;
  reviewers: ReviewersTable;
  pull_requests: PullRequestsTable;
  review_requests: ReviewRequestsTable;
  follow_ups: FollowUpsTable;
  audit_log: AuditLogTable;
}