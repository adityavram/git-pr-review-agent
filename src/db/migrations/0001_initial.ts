/**
 * Initial migration — REAL
 *
 * Creates all 6 tables: repos, reviewers, pull_requests, review_requests,
 * follow_ups, audit_log. Includes indexes and foreign keys with cascade deletes.
 * The `required_approving_review_count` and `requires_code_owner_reviews`
 * columns on `repos` were added to persist GitHub branch protection data.
 *
 * Reversible — the `down` migration drops all tables in reverse dependency order.
 */
import type { Migration } from 'kysely';
import { sql } from 'kysely';

export const Migration0001Initial: Migration = {
  async up(db): Promise<void> {
    await db.schema
      .createTable('repos')
      .ifNotExists()
      .addColumn('id', 'serial', (c) => c.primaryKey())
      .addColumn('owner', 'text', (c) => c.notNull())
      .addColumn('name', 'text', (c) => c.notNull())
      .addColumn('full_name', 'text', (c) => c.notNull().unique())
      .addColumn('default_branch', 'text')
      .addColumn('last_synced_at', 'timestamptz')
      .addColumn('required_approving_review_count', 'integer')
      .addColumn('requires_code_owner_reviews', 'boolean')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .execute();

    await db.schema
      .createIndex('repos_owner_name_idx')
      .ifNotExists()
      .on('repos')
      .columns(['owner', 'name'])
      .execute();

    await db.schema
      .createTable('reviewers')
      .ifNotExists()
      .addColumn('id', 'serial', (c) => c.primaryKey())
      .addColumn('github_login', 'text', (c) => c.notNull().unique())
      .addColumn('github_user_id', 'integer')
      .addColumn('display_name', 'text')
      .addColumn('slack_user_id', 'text')
      .addColumn('email', 'text')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn('updated_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .execute();

    await db.schema
      .createTable('pull_requests')
      .ifNotExists()
      .addColumn('id', 'serial', (c) => c.primaryKey())
      .addColumn('repo_id', 'integer', (c) =>
        c.notNull().references('repos.id').onDelete('cascade'),
      )
      .addColumn('number', 'integer', (c) => c.notNull())
      .addColumn('title', 'text', (c) => c.notNull())
      .addColumn('state', 'text', (c) => c.notNull())
      .addColumn('draft', 'boolean', (c) => c.notNull().defaultTo(false))
      .addColumn('author_login', 'text', (c) => c.notNull())
      .addColumn('head_ref', 'text', (c) => c.notNull())
      .addColumn('base_ref', 'text', (c) => c.notNull())
      .addColumn('created_at_github', 'timestamptz', (c) => c.notNull())
      .addColumn('updated_at_github', 'timestamptz', (c) => c.notNull())
      .addColumn('mergeable_state', 'text')
      .addColumn('mergeable', 'boolean')
      .addColumn('additions', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('deletions', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('changed_files', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('commits', 'integer', (c) => c.notNull().defaultTo(0))
      .addColumn('html_url', 'text', (c) => c.notNull())
      .addColumn('body', 'text')
      .addColumn('last_synced_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn('first_seen_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .execute();

    await db.schema
      .createIndex('pr_repo_number_idx')
      .ifNotExists()
      .on('pull_requests')
      .columns(['repo_id', 'number'])
      .unique()
      .execute();

    await db.schema
      .createIndex('pr_state_idx')
      .ifNotExists()
      .on('pull_requests')
      .column('state')
      .execute();

    await db.schema
      .createTable('review_requests')
      .ifNotExists()
      .addColumn('id', 'serial', (c) => c.primaryKey())
      .addColumn('pr_id', 'integer', (c) =>
        c.notNull().references('pull_requests.id').onDelete('cascade'),
      )
      .addColumn('reviewer_id', 'integer', (c) =>
        c.notNull().references('reviewers.id').onDelete('cascade'),
      )
      .addColumn('requested_at', 'timestamptz', (c) => c.notNull())
      .addColumn('state', 'text', (c) => c.notNull().defaultTo('pending'))
      .addColumn('review_submitted_at', 'timestamptz')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .execute();

    await db.schema
      .createIndex('rr_pr_reviewer_idx')
      .ifNotExists()
      .on('review_requests')
      .columns(['pr_id', 'reviewer_id'])
      .unique()
      .execute();

    await db.schema
      .createIndex('rr_reviewer_state_idx')
      .ifNotExists()
      .on('review_requests')
      .columns(['reviewer_id', 'state'])
      .execute();

    await db.schema
      .createTable('follow_ups')
      .ifNotExists()
      .addColumn('id', 'serial', (c) => c.primaryKey())
      .addColumn('pr_id', 'integer', (c) =>
        c.notNull().references('pull_requests.id').onDelete('cascade'),
      )
      .addColumn('reviewer_id', 'integer', (c) =>
        c.notNull().references('reviewers.id').onDelete('cascade'),
      )
      .addColumn('channel', 'text', (c) => c.notNull())
      .addColumn('message_text', 'text')
      .addColumn('sent_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .addColumn('decision_reason', 'text', (c) => c.notNull())
      .addColumn('dry_run', 'boolean', (c) => c.notNull().defaultTo(false))
      .execute();

    await db.schema
      .createIndex('fu_reviewer_sent_idx')
      .ifNotExists()
      .on('follow_ups')
      .columns(['reviewer_id', 'sent_at'])
      .execute();

    await db.schema
      .createTable('audit_log')
      .ifNotExists()
      .addColumn('id', 'serial', (c) => c.primaryKey())
      .addColumn('event_type', 'text', (c) => c.notNull())
      .addColumn('payload', 'jsonb')
      .addColumn('created_at', 'timestamptz', (c) => c.notNull().defaultTo(sql`now()`))
      .execute();
  },

  async down(db): Promise<void> {
    await db.schema.dropTable('audit_log').ifExists().execute();
    await db.schema.dropTable('follow_ups').ifExists().execute();
    await db.schema.dropTable('review_requests').ifExists().execute();
    await db.schema.dropTable('pull_requests').ifExists().execute();
    await db.schema.dropTable('reviewers').ifExists().execute();
    await db.schema.dropTable('repos').ifExists().execute();
  },
};