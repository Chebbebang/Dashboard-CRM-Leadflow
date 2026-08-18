# Agent instructions

This file guides coding agents (Claude Code, etc.) working in this repository.

## What this project is

A single-page dashboard (Node/Express + React, no build step) that shows live per-agent lead metrics pulled from Bitrix24 CRM. See `README.md` for the full column definitions and setup.

## Ground rules

- **No build step.** The frontend is plain React served as production UMD bundles from `public/vendor/`, loaded directly via `<script>` tags — don't introduce a bundler, JSX transform, or npm frontend framework unless explicitly asked.
- **No database.** All data comes live from Bitrix24 via `bitrix.js`; results are cached in memory only (`server.js`). Don't add persistent storage unless asked.
- **Single-origin app.** Frontend and backend are served from the same Express process/port — don't split them or add CORS unless asked.
- **Keep `.env` out of git.** `LEADFLOW_WEBHOOK_URL` is a live Bitrix24 webhook secret; never commit it, log it, or print it in full.
- **Dubai timezone.** All date-range logic (`getRangeBounds`, `dubaiDateStr` in `server.js`) is anchored to `Asia/Dubai`. Keep any new date logic consistent with this rather than using server-local or UTC time.
- **Stage-transition counting logic is intentional.** The "Contacted" and "No Answer" columns require a same-day *timeline* comment (`crm.timeline.comment.list`), not the lead's static `COMMENTS` field, as evidence of real agent work. Don't change this without explicit direction — it's a deliberate business rule, not an oversight.
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
- After any change to `public/app.js`, sanity-check syntax with `node --check public/app.js` before considering the task done.
- There is no automated test suite. Verify backend changes by hitting `/api/leadflow?range=today` and checking response shape; verify frontend changes by loading the page (use a cache-busting/incognito load, per above).
