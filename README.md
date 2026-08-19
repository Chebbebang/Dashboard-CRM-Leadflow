# LeadFlow — K Estates Lead Flow Dashboard

A live dashboard that tracks per-agent lead activity in Bitrix24 CRM, broken down by sales agent, across two tables:

- **Lead Flow** — fresh leads received, reshuffled leads assigned, leads contacted, and leads with no answer, for Today / Last 7 Days / Last 30 Days / any custom date-time range.
- **Current Pipeline by Stage** — how many leads each agent currently owns right now, broken down by stage (Assigned, Reshuffled - Assigned, No Answer, Cold, Warm, Hot). This table has no date range — it always reflects the live pipeline.

## Stack

- **Backend:** Node.js (Express 5), talking to Bitrix24 via an incoming webhook
- **Frontend:** React (no build step — served as production UMD bundles), plain CSS
- No database — all data is fetched live from Bitrix24 and cached in memory

## Setup

```bash
npm install
```

Create a `.env` file in the project root:

```
LEADFLOW_WEBHOOK_URL=https://<your-portal>.bitrix24.com/rest/<user-id>/<webhook-token>/
```

Optionally set a custom port (defaults to `3002`):

```
LEADFLOW_PORT=3002
```

## Running

```bash
npm start      # node server.js
npm run dev    # nodemon server.js, restarts on file changes
```

Then open `http://localhost:3002`.

## How the numbers are computed

All ranges are bounded in Dubai local time (`Asia/Dubai`), from the start of the range through "now". Custom ranges accept naive `YYYY-MM-DDTHH:mm` datetimes that are interpreted as Dubai local time (the Dubai offset is +04:00 year-round).

| Selector | Window |
|---|---|
| Today | Start of today → now (Dubai) |
| Last 7 Days / Last 30 Days | The preceding 7 / 30 days through now |
| Custom Range | Any window picked in the From/To pickers; `from` must be before `to`. Impossible dates (e.g. 2026-02-30) and bad formats are rejected with a 400. |

## Endpoints

### `GET /api/leadflow?range=today|7d|30d` or `?from=YYYY-MM-DDTHH:mm&to=YYYY-MM-DDTHH:mm`

Responses are never HTTP-cached (`Cache-Control: no-store`) so you always see live CRM data.

| Column | Rule |
|---|---|
| **Fresh Leads Received – Primary** | Leads created in range, grouped by assigned agent. |
| **Fresh Leads Received – Secondary** | Property Finder–sourced leads + Rental Leads pipeline deals created in range, grouped by assigned agent. |
| **New Reshuffled Leads Assigned** | Leads whose stage-history shows an entry into "Reshuffled - Assigned" within range, grouped by the lead's *current* assignee. |
| **Leads Contacted** | Leads that moved directly from a "being worked" stage (Reshuffled-Assigned, Assigned, No Answer, Leads Pool) into Warm/Hot/Cold within range, **and** have a same-day timeline comment logged. Credited to the lead's current assignee; only the earliest qualifying transition per lead counts. |
| **Leads No Answer** | Same mechanism as Contacted, but for transitions from a "being worked" stage (Reshuffled-Assigned, Assigned, Junk, Leads Pool) directly into "No Answer", with a same-day timeline comment required. |

The same-day-comment requirement exists so a stage move with no evidence of actual agent work (e.g. a stale/automated transition) doesn't get counted. "Same-day comment" checks Bitrix24's **timeline comments** (`crm.timeline.comment.list`), not the lead's static `COMMENTS` field.

The dashboard's ⓘ button shows this same column-by-column breakdown in-app.

### `GET /api/leadflow/stage-counts`

No range/date params — always reflects the live pipeline right now. Counts each agent's leads currently sitting in each of these stages (no date filter):

| Column | Bitrix `STATUS_ID` |
|---|---|
| **Assigned** | `UC_UYK1YZ` |
| **Reshuffled - Assigned** | `UC_HKU9EC` |
| **No Answer** | `4` |
| **Cold** | `6` |
| **Warm** | `2` |
| **Hot** | `7` |

`total` is the sum of those six per agent. Credited to the lead's current assignee (`ASSIGNED_BY_ID`).

### Forcing a live refresh

Both endpoints accept `&force=1` (or `?force=1` on `stage-counts`) to bypass the in-memory cache and wait for a fresh Bitrix recompute instead of returning whatever the background loop last cached. This is what the dashboard's per-table ⟳ refresh buttons use; a forced request can take several seconds to tens of seconds since it's a real live query, not a cache hit.

Agents shown (both endpoints) are active users in the Sales (5) or Client Managers (29) departments, excluding a small hardcoded list of non-agent accounts (CEO, marketing manager, generic system account).

## Project structure

```
server.js          Express app: routes, dashboard computation, caching/refresh loop
bitrix.js           Minimal Bitrix24 REST client (batching, pagination, retries)
public/
  index.html         Page shell
  app.js             React dashboard (both tables, sorting, theme toggle, per-table refresh, column-info modal, polling)
  styles.css         Styling, light/dark theme, responsive layout
  theme-init.js       Applies saved theme before first paint (avoids flash)
  vendor/            Production React/ReactDOM bundles (no CDN/build step)
```

## Notes

- The `/api/leadflow?range=today|7d|30d` endpoint is always served from an in-memory cache that refreshes on a background loop, so requests are fast; the cache itself reflects live CRM data (never HTTP-cached). A custom window can be requested with `?from=YYYY-MM-DDTHH:mm&to=YYYY-MM-DDTHH:mm` — both values are interpreted as Dubai local time, computed on demand (cached briefly, then evicted), and rejected with a 400 if invalid (bad format, impossible date, or `from` not before `to`).
- `/api/leadflow/stage-counts` follows the same in-memory-cache-plus-background-loop pattern (refreshed every 60s), just without a range key since it's always "right now".
- Only one dashboard computation runs at a time across *both* endpoints (the background refresh loops and on-demand requests — including forced ones — share a single queue, and user requests jump ahead of background refreshes), which keeps the Bitrix24 rolling request-rate budget under its `QUERY_LIMIT_EXCEEDED` limit. After a heavy computation the next is delayed briefly by a cooldown so the budget refills. To keep custom ranges fast, per-lead lookups (stage history, timeline comments, lead assignee) are cached in memory for a few minutes, so ranges that overlap in time reuse previously fetched data instead of refetching from Bitrix. First load of a large window takes longest (~10–90s depending on size); repeats and narrower overlapping windows are near-instant.
- Static assets (`app.js`, `styles.css`, vendor bundles) are served with a 1-hour browser cache lifetime; `index.html` is always revalidated. When iterating on the frontend, use a private/incognito tab (or hard refresh) to see changes immediately.
