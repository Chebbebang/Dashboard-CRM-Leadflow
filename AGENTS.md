# Agent instructions

This file guides coding agents (Claude Code, etc.) working in this repository.

## What this project is

A single-page dashboard (Node/Express + React, no build step) that shows live per-agent lead metrics pulled from Bitrix24 CRM, across two tables: the range-based Lead Flow table and the range-independent "Current Pipeline by Stage" table (`GET /api/leadflow/stage-counts`). See `README.md` for the full column definitions and setup.

## Ground rules

- **No build step.** The frontend is plain React served as production UMD bundles from `public/vendor/`, loaded directly via `<script>` tags — don't introduce a bundler, JSX transform, or npm frontend framework unless explicitly asked.
- **No database.** All data comes live from Bitrix24 via `bitrix.js`; results are cached in memory only (`server.js`). Don't add persistent storage unless asked.
- **Single-origin app.** Frontend and backend are served from the same Express process/port — don't split them or add CORS unless asked.
- **Keep `.env` out of git.** `LEADFLOW_WEBHOOK_URL` is a live Bitrix24 webhook secret; never commit it, log it, or print it in full.
- **Dubai timezone.** All date-range logic (`getRangeBounds`, `dubaiDateStr`, `parseDubaiBounds` in `server.js`) is anchored to `Asia/Dubai`. The Dubai offset is +04:00 year-round, so naive datetimes from the frontend are formatted as `…+04:00` for Bitrix. Keep any new date logic consistent with this rather than using server-local or UTC time.
- **Stage-transition counting logic is intentional.** The "Contacted" and "No Answer" columns require a same-day *timeline* comment (`crm.timeline.comment.list`), not the lead's static `COMMENTS` field, as evidence of real agent work. Don't change this without explicit direction — it's a deliberate business rule, not an oversight.
- **One Bitrix computation at a time.** `server.js` queues all computations (the background refresh loops *and* on-demand custom-range requests, across both `/api/leadflow` and `/api/leadflow/stage-counts`) through `enqueueCompute` so only one runs at a time — two in parallel burst past Bitrix's rolling request budget (`QUERY_LIMIT_EXCEEDED`). User requests jump the queue; a background refresh just retries on its next interval.
- **`force=1` bypasses the cache, not the queue.** Both endpoints accept `force=1` to skip serving from the in-memory cache and wait for a live recompute (this is what the frontend's per-table refresh buttons send) — it still goes through the same `enqueueCompute` queue as everything else, so it can't burst the Bitrix rate limit either. Don't add a way to force a recompute that skips the queue.
- **Static asset caching.** `public/*` (except `index.html`) is served with a 1-hour `Cache-Control` lifetime (see `server.js`). When testing frontend changes locally or on another device, use a private/incognito tab or hard refresh — don't assume a reload picks up new JS/CSS immediately.

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
