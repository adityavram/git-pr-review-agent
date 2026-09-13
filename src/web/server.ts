/**
 * Web server — REAL
 *
 * Hono HTTP server serving the dashboard UI and JSON API.
 * All endpoints are fully implemented — no mocks.
 *
 * Endpoints:
 * - GET /              → HTML dashboard (server-rendered)
 * - GET /api/health    → health check
 * - GET /api/stats     → summary counts
 * - GET /api/prs       → open PRs (JSON)
 * - GET /api/reviewers → reviewers + load (JSON)
 * - GET /api/follow-ups → recent follow-up decisions (JSON)
 * - POST /api/run-cycle → trigger a manual orchestrator cycle (fire-and-forget)
 */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import {
  fetchDashboardPrs,
  fetchDashboardRepos,
  fetchDashboardReviewers,
  fetchRecentFollowUps,
  fetchStats,
} from './queries.js';
import { renderDashboard } from './template.js';
import { runCycle } from '../orchestrator/orchestrator.js';

export function createApp(): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const [stats, prs, reviewers, followUps, repos] = await Promise.all([
      fetchStats(),
      fetchDashboardPrs(),
      fetchDashboardReviewers(),
      fetchRecentFollowUps(50),
      fetchDashboardRepos(),
    ]);
    const html = renderDashboard({
      stats,
      dryRun: env.DRY_RUN,
      pollIntervalMs: env.POLL_INTERVAL_MS,
      prs,
      reviewers,
      followUps,
      repos,
    });
    return c.html(html);
  });

  app.get('/api/health', (c) => c.json({ ok: true, dryRun: env.DRY_RUN }));

  app.get('/api/stats', async (c) => {
    const stats = await fetchStats();
    return c.json({ ...stats, dryRun: env.DRY_RUN, pollIntervalMs: env.POLL_INTERVAL_MS });
  });

  app.get('/api/prs', async (c) => {
    const prs = await fetchDashboardPrs();
    return c.json(prs);
  });

  app.get('/api/reviewers', async (c) => {
    const reviewers = await fetchDashboardReviewers();
    return c.json(reviewers);
  });

  app.get('/api/follow-ups', async (c) => {
    const followUps = await fetchRecentFollowUps(100);
    return c.json(followUps);
  });

  app.post('/api/run-cycle', async (c) => {
    runCycle().catch((err) => logger.error({ err }, 'manual cycle failed'));
    return c.json({ triggered: true });
  });

  return app;
}

export function startWebServer(): void {
  const app = createApp();
  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    logger.info({ port: info.port }, 'web UI listening');
  });
}