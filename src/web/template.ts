/**
 * Dashboard HTML template — REAL
 *
 * Server-rendered HTML with inline CSS and JS. No mocks, no SPA build step.
 * All data is injected from the queries layer. The template includes:
 * - Collapsible sections (click h2 to toggle)
 * - Tracked repos table (collapsible by default)
 * - Open PRs table with clickable links to GitHub
 * - Reviewers table (humans sorted first, highlighted in green)
 * - Follow-ups & decisions table
 * - 30s auto-refresh
 * - Responsive layout (scales with window size)
 */
import type {
  DashboardFollowUpRow,
  DashboardPrRow,
  DashboardRepoRow,
  DashboardReviewerRow,
} from './queries.js';

export interface DashboardData {
  stats: {
    openPrs: number;
    pendingReviews: number;
    reviewers: number;
    followUps24h: number;
    trackedRepos: number;
    lastSyncedAt: Date | null;
  };
  dryRun: boolean;
  pollIntervalMs: number;
  prs: DashboardPrRow[];
  reviewers: DashboardReviewerRow[];
  followUps: DashboardFollowUpRow[];
  repos: DashboardRepoRow[];
}

function esc(s: string | null | undefined): string {
  if (s === null || s === undefined) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(date: Date | null): string {
  if (!date) return 'never';
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function prAgeHours(createdAt: Date): string {
  const hours = (Date.now() - new Date(createdAt).getTime()) / 3_600_000;
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

export function renderDashboard(data: DashboardData): string {
  const { stats, dryRun, pollIntervalMs, prs, reviewers, followUps, repos } = data;
  const pollMin = Math.round(pollIntervalMs / 60_000);

  const repoRows = repos
    .map((r) => {
      const synced = r.last_synced_at ? timeAgo(r.last_synced_at) : 'never';
      const protection = r.required_approving_review_count
        ? `<span class="badge protect">${r.required_approving_review_count} approval${r.required_approving_review_count > 1 ? 's' : ''} required</span>${r.requires_code_owner_reviews ? '<span class="badge codeowner">code owners</span>' : ''}`
        : '<span class="badge noprotect">no protection</span>';
      return `<tr>
        <td><a href="https://github.com/${esc(r.full_name)}" target="_blank">${esc(r.full_name)}</a></td>
        <td>${esc(r.default_branch ?? '—')}</td>
        <td>${r.open_pr_count}</td>
        <td>${protection}</td>
        <td><span class="time">${synced}</span></td>
      </tr>`;
    })
    .join('');

  const prRows = prs
    .map((pr) => {
      const reviewers = pr.pending_reviewers
        ? `<span class="reviewers">awaiting: ${esc(pr.pending_reviewers)}</span>`
        : '<span class="reviewers none">no pending reviewers</span>';
      const draft = pr.draft ? '<span class="badge draft">draft</span>' : '';
      const merge = pr.mergeable_state
        ? `<span class="badge merge-${esc(pr.mergeable_state)}">${esc(pr.mergeable_state)}</span>`
        : '';
      const protection = pr.required_approving_review_count
        ? `<span class="badge protect">${pr.required_approving_review_count} approval${pr.required_approving_review_count > 1 ? 's' : ''}</span>${pr.requires_code_owner_reviews ? '<span class="badge codeowner">code owners</span>' : ''}`
        : '';
      const reviewUrl = `${esc(pr.html_url)}/files`;
      return `<tr>
        <td><a href="${esc(pr.html_url)}" target="_blank">#${pr.number}</a></td>
        <td><div class="pr-title"><a href="${esc(pr.html_url)}" target="_blank">${esc(pr.title)}</a></div><div class="pr-meta"><a href="https://github.com/${esc(pr.repo_full_name)}" target="_blank">${esc(pr.repo_full_name)}</a> • ${esc(pr.author_login)}</div></td>
        <td><span class="age">${prAgeHours(pr.created_at_github)}</span></td>
        <td>+${pr.additions} / -${pr.deletions}</td>
        <td>${draft}${merge}${protection}</td>
        <td>${reviewers}</td>
        <td><a href="${reviewUrl}" target="_blank" class="review-link">review &amp; approve</a></td>
      </tr>`;
    })
    .join('');

  const reviewerRows = reviewers
    .map((r) => {
      const slack = r.slack_user_id
        ? '<span class="badge mapped">slack mapped</span>'
        : '<span class="badge unmapped">no slack</span>';
      const load =
        r.open_requests >= 3
          ? '<span class="load high">high</span>'
          : r.open_requests >= 1
            ? '<span class="load med">medium</span>'
            : '<span class="load low">low</span>';
      const humanClass = r.is_human ? ' class="reviewer-human"' : '';
      const humanBadge = r.is_human ? '<span class="badge human">human</span>' : '<span class="badge bot">bot</span>';
      return `<tr${humanClass}>
        <td>${humanBadge} ${esc(r.github_login)}</td>
        <td>${r.open_requests}</td>
        <td>${r.recent_follow_ups}</td>
        <td>${load}</td>
        <td>${slack}</td>
      </tr>`;
    })
    .join('');

  const followUpRows = followUps
    .map((f) => {
      const channel = esc(f.channel);
      const tag = f.dry_run ? '<span class="badge dry">dry-run</span>' : `<span class="badge sent">sent</span>`;
      return `<tr>
        <td><span class="time">${timeAgo(f.sent_at)}</span></td>
        <td>${tag} <span class="channel">${channel}</span></td>
        <td><div class="fu-target">${esc(f.reviewer_login)} → #${f.pr_number}</div><div class="fu-repo">${esc(f.repo_full_name)}</div></td>
        <td><div class="fu-msg">${esc(f.message_text)}</div><div class="fu-reason">${esc(f.decision_reason)}</div></td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PR Evaluator Hub</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #2f81f7; --green: #3fb950;
    --yellow: #d29922; --red: #f85149; --purple: #a371f7;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); }
  header { border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  header h1 { margin: 0; font-size: 18px; font-weight: 600; }
  header .status { color: var(--muted); font-size: 13px; }
  .dry-run-pill { background: var(--yellow); color: #000; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .live-pill { background: var(--green); color: #000; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  main { padding: 24px; max-width: 100%; margin: 0 auto; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .stat .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  .stat .value { font-size: 24px; font-weight: 600; margin-top: 4px; }
  section { margin-bottom: 32px; }
  section h2 { font-size: 15px; font-weight: 600; margin: 0 0 12px 0; color: var(--text); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-weight: 500; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
  td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:hover td { background: var(--surface); }
  .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow-x: auto; }
  .pr-title { font-weight: 500; }
  .pr-title a { color: var(--text); }
  .pr-meta { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .pr-meta a { color: var(--muted); }
  .pr-meta a:hover { color: var(--accent); }
  .age, .time { color: var(--muted); white-space: nowrap; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 10px; font-size: 10px; font-weight: 600; margin-right: 4px; }
  .badge.draft { background: var(--purple); color: #000; }
  .badge.merge-clean, .badge.merge-mergeable { background: var(--green); color: #000; }
  .badge.merge-blocked, .badge.merge-dirty, .badge.merge-conflicting { background: var(--red); color: #000; }
  .badge.merge-behind, .badge.merge-unstable { background: var(--yellow); color: #000; }
  .badge.mapped { background: var(--green); color: #000; }
  .badge.unmapped { background: #30363d; color: var(--muted); }
  .badge.dry { background: var(--yellow); color: #000; }
  .badge.sent { background: var(--accent); color: #fff; }
  .badge.protect { background: var(--accent); color: #fff; }
  .badge.codeowner { background: var(--purple); color: #000; }
  .badge.noprotect { background: #30363d; color: var(--muted); }
  .badge.human { background: var(--green); color: #000; }
  .badge.bot { background: #30363d; color: var(--muted); }
  .reviewer-human td { background: rgba(63, 185, 80, 0.06); }
  .reviewer-human td:first-child { color: var(--green); font-weight: 600; }
  .reviewers { font-size: 12px; }
  .reviewers.none { color: var(--muted); font-style: italic; }
  .load { padding: 1px 6px; border-radius: 10px; font-size: 10px; font-weight: 600; }
  .load.high { background: var(--red); color: #000; }
  .load.med { background: var(--yellow); color: #000; }
  .load.low { background: var(--green); color: #000; }
  .fu-target { font-weight: 500; }
  .fu-repo, .fu-reason { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .fu-msg { color: var(--text); }
  .channel { color: var(--purple); font-size: 11px; }
  .empty { text-align: center; color: var(--muted); padding: 24px; font-style: italic; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .review-link { font-size: 12px; font-weight: 500; white-space: nowrap; }
  section > h2 { cursor: pointer; user-select: none; display: flex; align-items: center; gap: 6px; }
  section > h2::before { content: '▾'; font-size: 12px; transition: transform 0.2s; }
  section.collapsed > h2::before { transform: rotate(-90deg); }
  section.collapsed .table-wrap { display: none; }
</style>
</head>
<body>
<header>
  <h1>PR Evaluator Hub</h1>
  ${dryRun ? '<span class="dry-run-pill">DRY RUN</span>' : '<span class="live-pill">LIVE</span>'}
  <span class="status">poll: ${pollMin}m • last sync: ${timeAgo(stats.lastSyncedAt)} • <span id="clock"></span></span>
</header>
<main>
  <div class="stats">
    <div class="stat"><div class="label">Tracked Repos</div><div class="value">${stats.trackedRepos}</div></div>
    <div class="stat"><div class="label">Open PRs</div><div class="value">${stats.openPrs}</div></div>
    <div class="stat"><div class="label">Pending Reviews</div><div class="value">${stats.pendingReviews}</div></div>
    <div class="stat"><div class="label">Reviewers</div><div class="value">${stats.reviewers}</div></div>
    <div class="stat"><div class="label">Follow-ups (24h)</div><div class="value">${stats.followUps24h}</div></div>
  </div>

  <section class="collapsed">
    <h2>Tracked Repositories</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Repo</th><th>Default Branch</th><th>Open PRs</th><th>Branch Protection</th><th>Last Synced</th></tr></thead>
        <tbody>${repoRows || `<tr><td colspan="5" class="empty">No repos tracked</td></tr>`}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Open Pull Requests</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>Title</th><th>Age</th><th>Diff</th><th>Status</th><th>Reviewers</th><th>Action</th></tr></thead>
        <tbody>${prRows || `<tr><td colspan="7" class="empty">No open PRs</td></tr>`}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Reviewers</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Login</th><th>Open Requests</th><th>Pings (24h)</th><th>Load</th><th>Slack</th></tr></thead>
        <tbody>${reviewerRows || `<tr><td colspan="5" class="empty">No reviewers yet</td></tr>`}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Recent Follow-ups & Decisions</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>When</th><th>Channel</th><th>Target</th><th>Message & Reason</th></tr></thead>
        <tbody>${followUpRows || `<tr><td colspan="4" class="empty">No follow-ups yet — run <code>npm run once</code> to generate decisions</td></tr>`}</tbody>
      </table>
    </div>
  </section>
</main>
<script>
  function tick(){ document.getElementById('clock').textContent = new Date().toLocaleTimeString(); }
  tick(); setInterval(tick, 1000);
  setTimeout(()=>location.reload(), 30000);
  document.querySelectorAll('section > h2').forEach(function(h2) {
    h2.addEventListener('click', function() { h2.parentElement.classList.toggle('collapsed'); });
  });
</script>
</body>
</html>`;
}