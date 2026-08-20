# Agent instructions

This file guides coding agents (Claude Code, etc.) working in this repository.

## What this project is

A single-page dashboard (Node/Express + React, no build step) that shows live per-agent lead metrics pulled from Bitrix24 CRM, across two tables: the range-based Lead Flow table and the range-independent "Current Pipeline by Stage" table (`GET /api/leadflow/stage-counts`). See `README.md` for the full column definitions and setup.

## Ground rules

- **No build step.** The frontend is plain React served as production UMD bundles from `public/vendor/`, loaded directly via `<script>` tags — don't introduce a bundler, JSX transform, or npm frontend framework unless explicitly asked.
- **No database — but the in-memory cache is snapshotted to a local JSON file.** All data still comes live from Bitrix24 via `bitrix.js`; the caches in `server.js` remain the source of truth at runtime. `saveCacheToDisk`/`loadCacheFromDisk` periodically snapshot them to `.cache/leadflow-cache.json` (gitignored) purely so a restart doesn't force a full cold re-scan of the current pipeline — it's a local performance cache, not a database, and the app must still boot and behave correctly with the file missing or corrupt. Don't add real persistent storage (a DB, external cache, etc.) beyond this without being asked.
- **Single-origin app.** Frontend and backend are served from the same Express process/port — don't split them or add CORS unless asked.
- **Keep `.env` out of git.** `LEADFLOW_WEBHOOK_URL` is a live Bitrix24 webhook secret; never commit it, log it, or print it in full.
- **Dubai timezone.** All date-range logic (`getRangeBounds`, `dubaiDateStr`, `parseDubaiBounds` in `server.js`) is anchored to `Asia/Dubai`. The Dubai offset is +04:00 year-round, so naive datetimes from the frontend are formatted as `…+04:00` for Bitrix. Keep any new date logic consistent with this rather than using server-local or UTC time.
- **Stage-transition counting logic is intentional.** The "Contacted" and "No Answer" columns require a same-day *timeline* comment (`crm.timeline.comment.list`), not the lead's static `COMMENTS` field, as evidence of real agent work. "Contacted" also adds a second source — any other timeline comment logged while a lead sits in Warm/Hot/Cold/Leads Pool with no stage change that day, credited to the assignee (or, for Leads Pool, the comment's author) — see `fetchCommentContactCounts` in `server.js`. Don't change any of this without explicit direction — it's a deliberate business rule, not an oversight.
- **"Fresh Leads Received" excludes leads still in the Fresh stage.** Both Primary and Secondary only count leads/deals created in range that have since moved past their pipeline's "1. Fresh" stage (`NEW` for leads, `C13:NEW` for Rental Leads deals) — see `FRESH_LEAD_STATUS_ID`/`FRESH_RENTAL_DEAL_STAGE_ID` in `server.js`.
- **One Bitrix computation at a time.** `server.js` queues all computations (the background refresh loops *and* on-demand custom-range requests, across both `/api/leadflow` and `/api/leadflow/stage-counts`) through `enqueueCompute` so only one runs at a time — two in parallel burst past Bitrix's rolling request budget (`QUERY_LIMIT_EXCEEDED`). User requests jump the queue; a background refresh just retries on its next interval.
- **`force=1` bypasses the cache, not the queue.** Both endpoints accept `force=1` to skip serving from the in-memory cache and wait for a live recompute (this is what the Lead Flow table's refresh button sends — the "Current Pipeline by Stage" table has no refresh button and only ever polls) — it still goes through the same `enqueueCompute` queue as everything else, so it can't burst the Bitrix rate limit either. Don't add a way to force a recompute that skips the queue.
- **The cooldown in `enqueueCompute` must never delay the caller's own result.** `COMPUTE_COOLDOWN_MS` exists so the *next* queued computation waits for Bitrix's rate budget to refill — it must not be awaited before `enqueueCompute`'s returned promise resolves, or every non-cached request (force refresh, custom range, first load after restart) pays it on top of its own compute time for no benefit. It's chained onto `computeQueue` separately from the `started` promise returned to the caller — keep that split if you touch this function.
- **Bitrix's `batch` endpoint hard-caps at 50 commands per call.** Anything past that comes back per-command as `ERROR_BATCH_LENGTH_EXCEEDED` (verified against the live portal), which `bitrix.js`'s `batch()` retries after a mandatory 3s+ backoff — so any `mapChunks` call site that emits more than one Bitrix command per item (currently only `fetchCommentContactCounts`, which batches a stage-history + a comment-list lookup per lead) needs a `chunkSize` low enough that `chunkSize * commandsPerItem <= 50` (25, for 2 commands/item). Every other call site emits one command per item and is fine at the default `chunkSize: 50`.
- **Static asset caching.** `public/*` (except `index.html`) is served with a 1-hour `Cache-Control` lifetime (see `server.js`). When testing frontend changes locally or on another device, use a private/incognito tab or hard refresh — don't assume a reload picks up new JS/CSS immediately.
- **Per-lead caches are persisted to disk, not just memory.** `agentsCache`, `cache`, `stageCountsCache`, `assigneeCache`, `historyCache`, `commentCache`, and `stageHistoryCache` are snapshotted to `CACHE_FILE` every `CACHE_SAVE_INTERVAL_MS` and on `SIGINT`/`SIGTERM`, and reloaded via `loadCacheFromDisk()` before the server starts listening. Loaded entries aren't specially validated — they're hydrated as-is and rely on each cache's own TTL check (`cacheGet`) to treat stale ones as expired, same as a live expiry. In-flight/control-flow state (`computeQueue`, `inFlight`, `pendingUserRequests`, etc.) is deliberately never persisted — only add a new cache to the snapshot if it's genuinely reconstructable data, not live request state.
- **`COMMENT_TTL_MS` is 15 minutes, matching `HISTORY_TTL_MS`.** It used to be 5 minutes; since the whole comment cache gets populated in one clustered burst during any cold scan, a short TTL meant it also went stale in a clustered burst, re-triggering a near-full re-scan of the current pipeline every ~5 minutes indefinitely. Don't lower it without checking whether that recurring-storm behavior is what you're reintroducing.

## Running locally

```bash
npm install
npm start        # or: npm run dev (nodemon, auto-restart)
```

Requires a `.env` file with `LEADFLOW_WEBHOOK_URL` set (see `README.md`).

## Making changes

- Backend logic lives in `server.js` (routes, dashboard computation, caching) and `bitrix.js` (generic REST client — batching, pagination, retry/backoff for `QUERY_LIMIT_EXCEEDED`).
- Frontend is a single file, `public/app.js` (React via `createElement`, no JSX). Styling is in `public/styles.css`, including a `@media (max-width: 640px)` block for mobile.
- After any change to `public/app.js`, sanity-check syntax with `node --check public/app.js` before considering the task done (`server.js`/`bitrix.js` too).
- There is no automated test suite. Verify backend changes by hitting `/api/leadflow?range=today`, `/api/leadflow?range=7d`, a custom window (`/api/leadflow?from=YYYY-MM-DDTHH:mm&to=YYYY-MM-DDTHH:mm`), and `/api/leadflow/stage-counts`, and checking response shape; verify frontend changes by loading the page (use a cache-busting/incognito load, per above).
- Don't kill dev server processes broadly. A blind `pkill -f "node server.js"` (or similar) matches nodemon's child process too — nodemon then goes into "app crashed, waiting for file changes" and stops listening until a watched file changes. If you spin up a throwaway server instance for testing, stop only that specific PID.
