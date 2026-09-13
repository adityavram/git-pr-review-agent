# Git PR Review Agent

An agent that manages **PR reviewer morale at scale** by tracking repo / branch / reviewer state across GitHub repos and orchestrating socially-acceptable follow-up cadence via Slack (Teams planned).

The problem this solves: a flood of AI-generated PRs is bottlenecking on scarce, fatigued human reviewer time. The agent keeps enough state to know *who is overwhelmed*, *which PR actually matters*, and *when (or whether) it's appropriate to nudge someone* — instead of blindly spamming every reviewer on every cycle.

## Architecture

```
GitHub (Octokit) ─┐                         ┌─ Slack (DM follow-ups)
                  ├─> Postgres state store ─┤
  orchestrator ───┘                         └─ audit log
        │
        ▼
  scoring engine (PR urgency + reviewer load)
        │
        ▼
  Ollama (llama3.1, OpenAI-compatible API) ── decides cadence + drafts message
        │
        ▼
  Hono web UI ── dashboard (auto-refresh)
```

**Loop (every `POLL_INTERVAL_MS`):** sync → score → LLM decides who to ping → act (send or dry-run log) → audit.

### Layers

| Layer | File(s) | Responsibility |
|---|---|---|
| Config / env | `src/config/env.ts` | Zod-validated env, repo list, Slack allowlist |
| DB | `src/db/` | Kysely + Postgres, schema, migrations |
| State repo | `src/state/` | Typed upserts/queries for repos, PRs, review requests, follow-ups, audit |
| GitHub sync | `src/github/`, `src/sync/` | Pull open PRs, requested reviewers, submitted reviews, branch protection |
| Scoring | `src/intelligence/scoring.ts` | PR urgency score + reviewer load score → composite |
| LLM agent | `src/intelligence/agent.ts` | Ollama (llama3.1) call that returns a structured cadence plan |
| Integrations | `src/integrations/slack.ts` | DM follow-ups (allowlist-gated) |
| Orchestrator | `src/orchestrator/orchestrator.ts` | Wires everything together per cycle |
| Web UI | `src/web/` | Hono server + embedded HTML dashboard |

### State model (v1)

- `repos` — tracked repositories
- `pull_requests` — every open PR (synced each cycle; closed PRs marked)
- `reviewers` — GitHub users, with optional Slack mapping
- `review_requests` — per-PR per-reviewer state (pending / approved / changes_requested / dismissed)
- `follow_ups` — every ping sent (or dry-run logged), with decision reason
- `audit_log` — cycle-level events

## Quickstart

```bash
cp .env.example .env      # fill in GITHUB_TOKEN, OLLAMA_*, DATABASE_URL, etc.
npm install
npm run migrate           # create / migrate the Postgres schema
npm run sync              # one-off: pull state from GitHub
npm run once              # one full cycle: sync + score + decide + act
npm run dev               # long-running loop (polls every POLL_INTERVAL_MS) + web UI
```

The web UI auto-starts with the main process and is available at `http://localhost:3000` (or `PORT`). It auto-refreshes every 30s. There's also JSON API endpoints:

| Endpoint | What |
|---|---|
| `GET /` | HTML dashboard |
| `GET /api/health` | Health check |
| `GET /api/stats` | Summary counts |
| `GET /api/prs` | Open PRs (JSON) |
| `GET /api/reviewers` | Reviewers + load (JSON) |
| `GET /api/follow-ups` | Recent follow-up decisions (JSON) |
| `POST /api/run-cycle` | Trigger a manual orchestrator cycle |

`DRY_RUN=true` (default) means the agent computes and logs decisions and records follow-ups as dry-run, but **sends no Slack messages**. Flip to `false` once you've reviewed the decisions.

### Environment

See `.env.example` for the full list. Key ones:

- `GITHUB_REPOS` — comma-separated `owner/name` list. v1 uses the first.
- `GITHUB_TOKEN` — PAT with `repo:read`, `pull-requests:read`.
- `OLLAMA_BASE_URL` — Ollama cloud API base (OpenAI-compatible). Default `https://api.olama.cloud/v1`.
- `OLLAMA_API_KEY` — API key for the Ollama cloud service.
- `OLLAMA_MODEL` — model name (default `llama3.1`).
- `SLACK_BOT_TOKEN` — `xoxb-…` bot token with `chat:write` + `conversations:open`.
- `SLACK_ALLOWED_USER_IDS` — comma-separated allowlist of Slack user IDs the bot may DM. Leave empty to allow any mapped reviewer. **Strongly recommended to set this during v1 testing.**
- `DRY_RUN` — `true` (default) / `false`.
- `POLL_INTERVAL_MS` — cycle cadence (default 15 min).

### Mapping a reviewer's GitHub login → Slack user ID

The agent can only DM reviewers whose `slack_user_id` is populated. For now there is no auto-discovery; map manually via SQL:

```sql
UPDATE reviewers SET slack_user_id = 'U012ABC', updated_at = now()
WHERE github_login = 'your-teammate';
```

(A Slack `users.lookupByEmail` auto-link is a planned follow-up — see Roadmap.)

## How the LLM agent decides

The agent receives a compact JSON context for every pending review request: PR age, size, composite score, the reviewer's open-request count, how many times they've been pinged in the last 24h, and how long since the last ping. It returns a structured `CadencePlan` with a decision per review.

Hard rules baked into the system prompt (enforced by instruction, validated by schema):

1. Never ping the same reviewer more than once per 4 hours.
2. If a reviewer has ≥3 outstanding pending reviews, skip them unless one PR is on fire (age > 72h + high score), and even then at most one.
3. No pings for PRs < 6h old.
4. If a reviewer has no Slack mapping, `shouldPing=false`.
5. Messages ≤ 280 chars, warm, specific, low-pressure.

The scoring engine gives the LLM a head start with a deterministic composite score so it can reason about *why* and *how*, not *whether to compute priority*.

## Railway deployment

1. Create a Railway project with a **Postgres** plugin. Copy the `DATABASE_URL` into service vars.
2. Set all vars from `.env.example` as Railway variables. Set `DRY_RUN=false` only after you've validated.
3. Build command: `npm install && npm run build`
4. Release command: `npm run migrate`
5. Start command: `node dist/index.js` (or `npm run start`)
6. The single long-running process serves the web UI on `PORT` and polls the agent on `POLL_INTERVAL_MS`.

The web UI and agent run in one process — Railway exposes the `PORT` automatically.

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | Compile TS → `dist/` |
| `npm run typecheck` | Type-check only |
| `npm run lint` | ESLint |
| `npm run migrate` | Apply DB migrations |
| `npm run sync` | One-off GitHub sync into Postgres |
| `npm run once` | One orchestrator cycle (sync + decide + act) |
| `npm run dev` | Long-running loop with file watch |
| `npm start` | Long-running loop (production) |

## Roadmap

- [ ] **Teams integration** — mirror the Slack sender.
- [ ] **Slack auto-link** — `users.lookupByEmail` to map GitHub → Slack automatically using commit author emails.
- [ ] **Approval-requirement awareness** — ingest branch protection `required_approving_review_count` and code-owner rules into scoring (scaffolding already fetches it).
- [ ] **Branch cleanup** — detect merged/deleted branches and propose cleanup.
- [ ] **Multi-repo prioritization** — cross-repo reviewer load (the schema supports it; the v1 sync handles one repo first).
- [ ] **Reviewer morale heuristics** — track reviewer response latency over time to detect burnout signals and back off proactively.
- [ ] **GitHub comment follow-up channel** — post a gentle comment instead of a Slack DM for certain urgency tiers.
- [ ] **UI: reviewer load charts, manual reviewer-Slack mapping UI, decision history filters.**

## Project structure

```
src/
  config/        env (zod), logger
  db/            kysely client, types, migrate, migrations/
  state/         repos.ts, prs.ts — typed persistence access
  github/        client.ts — Octokit wrappers
  sync/          sync.ts — per-repo sync orchestration
  intelligence/  scoring.ts, agent.ts, agentSchema.ts
  integrations/  slack.ts
  orchestrator/  orchestrator.ts — the per-cycle loop
  web/           server.ts, queries.ts, template.ts — Hono dashboard
  commands/      sync.ts, runOnce.ts — CLI entrypoints
  index.ts       long-running entrypoint (agent + web)
```

## What's real vs mocked

The codebase is fully implemented, but some components are running in mocked/fallback mode in the current deployment. Here's the breakdown:

### Fully real (production-ready)

| Component | Status | Notes |
|---|---|---|
| Config/env validation | ✅ Real | Zod-validated env vars |
| Postgres DB + migrations | ✅ Real | 6 tables, indexes, FKs, Kysely ORM |
| State layer (upserts/queries) | ✅ Real | All DB operations are functional |
| GitHub sync | ✅ Real | Octokit SDK, paginated PR fetch, review requests, branch protection |
| Scoring engine | ✅ Real | Deterministic, pure functions, no external calls |
| Orchestrator | ✅ Real | Full cycle: sync → score → decide → act → audit |
| Web UI + JSON API | ✅ Real | Hono server, 6 endpoints, server-rendered dashboard |
| Dedup logic | ✅ Real | Prevents duplicate follow-ups within 4h per reviewer+PR |
| Graceful shutdown | ✅ Real | SIGINT/SIGTERM handling, DB pool cleanup |

### Real code, mocked/placeholder runtime data

| Component | Code is real? | Current runtime state |
|---|---|---|
| LLM cadence agent | ✅ Real API call | ❌ Ollama cloud endpoint (api.olama.cloud) is dead — DNS doesn't resolve. Falls back to `mockCadence()` which applies the same rules deterministically. To use the real LLM, set `OLLAMA_BASE_URL` to a working endpoint. |
| Slack DM integration | ✅ Real API call | ❌ `SLACK_BOT_TOKEN` not set. `sendDm()` returns false gracefully. All follow-ups recorded as dry-run. |
| Reviewers in DB | ✅ Real schema | ⚠️ Mock bot reviewers (code-review-bot, code-hygiene-bot, etc.) inserted manually via SQL, not from GitHub sync. Fake Slack user IDs (U000001AAA). |
| Review requests in DB | ✅ Real schema | ⚠️ 18 review requests inserted manually to simulate 6 reviewers × 3 PRs. GitHub sync found 0 real review requests because the PR author can't be a reviewer on their own PRs. |
| Branch protection | ✅ Real | ✅ Demo repo has real branch protection requiring 2 approvals (set via GitHub API). Persisted to `repos` table during sync. |

### How to switch from mock to real

1. **LLM**: Set `OLLAMA_BASE_URL` to a working Ollama endpoint (e.g. `http://localhost:11434/v1` for local Ollama, or a working cloud URL). The `decideCadence()` function will call the real LLM and only fall back to mock on failure.
2. **Slack**: Set `SLACK_BOT_TOKEN` to a real `xoxb-` token, set `SLACK_ALLOWED_USER_IDS`, and flip `DRY_RUN=false`. Ensure reviewers have real `slack_user_id` values.
3. **Reviewers**: In a real deployment, reviewers are synced from GitHub's `listRequestedReviewers` API — no manual SQL needed. The mock data can be cleared with `TRUNCATE review_requests, reviewers, follow_ups CASCADE;` followed by a fresh `npm run sync`.

## Notes / design decisions

- **Ollama, not OpenAI/Anthropic.** The cadence decision runs through a cloud-hosted Ollama llama3.1 endpoint via its OpenAI-compatible API. Keeps the stack self-contained and avoids vendor lock-in.
- **LLM-driven, not pure rules.** Rules-only engines are brittle on the social dimension ("is it okay to ping Alice right now?"). The LLM gets a structured, scored context and returns structured JSON, so it's auditable and cheap to reason about — but it can apply judgment the rules can't.
- **Postgres, not SQLite.** The state graph (repos ↔ PRs ↔ reviewers ↔ requests ↔ follow-ups ↔ audit) is relational and we want durable history. Railway ships Postgres natively.
- **Dry-run by default.** Pinging real humans is the riskiest action; the agent must prove its decisions before it's allowed to send.
- **Follow-ups are auditable.** Every ping (or skipped ping) is recorded with the LLM's stated reason, so you can tune the system prompt against real history.
- **Embedded HTML UI, no separate build.** The dashboard is server-rendered Hono HTML — no SPA build step, single deploy artifact, auto-refreshes. Good enough for demo-ware; easy to upgrade later.