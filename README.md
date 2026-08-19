# LeadFlow — K Estates Lead Flow Dashboard

A live dashboard that tracks per-agent lead activity in Bitrix24 CRM: fresh leads received, reshuffled leads assigned, leads contacted, and leads with no answer — broken down by sales agent, for Today / Last 7 Days / Last 30 Days / any custom date-time range.

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

All ranges are bounded in Dubai local time (`Asia/Dubai`), from the start of the range through "now".

| Column | Rule |
|---|---|
| **Fresh Leads Received – Primary** | Leads created in range, grouped by assigned agent. |
| **Fresh Leads Received – Secondary** | Property Finder–sourced leads + Rental Leads pipeline deals created in range, grouped by assigned agent. |
| **New Reshuffled Leads Assigned** | Leads whose stage-history shows an entry into "Reshuffled - Assigned" within range, grouped by the lead's *current* assignee. |
| **Leads Contacted** | Leads that moved directly from a "being worked" stage (Reshuffled-Assigned, Assigned, No Answer, Leads Pool) into Warm/Hot/Cold within range, **and** have a same-day timeline comment logged. Credited to the lead's current assignee; only the earliest qualifying transition per lead counts. |
| **Leads No Answer** | Same mechanism as Contacted, but for transitions from a "being worked" stage (Reshuffled-Assigned, Assigned, Junk, Leads Pool) directly into "No Answer", with a same-day timeline comment required. |

The same-day-comment requirement exists so a stage move with no evidence of actual agent work (e.g. a stale/automated transition) doesn't get counted. "Same-day comment" checks Bitrix24's **timeline comments** (`crm.timeline.comment.list`), not the lead's static `COMMENTS` field.

Agents shown are active users in the Sales (5) or Client Managers (29) departments, excluding a small hardcoded list of non-agent accounts (CEO, marketing manager, generic system account).

## Project structure

```
server.js          Express app: routes, dashboard computation, caching/refresh loop
bitrix.js           Minimal Bitrix24 REST client (batching, pagination, retries)
public/
  index.html         Page shell
  app.js             React dashboard (table, sorting, theme toggle, polling)
  styles.css         Styling, light/dark theme, responsive layout
  theme-init.js       Applies saved theme before first paint (avoids flash)
  vendor/            Production React/ReactDOM bundles (no CDN/build step)
```

## Notes

- The `/api/leadflow?range=today|7d|30d` endpoint is always served from an in-memory cache that refreshes on a background loop, so requests are fast; the cache itself reflects live CRM data (never HTTP-cached). A custom window can be requested with `?from=YYYY-MM-DDTHH:mm&to=YYYY-MM-DDTHH:mm` — both values are interpreted as Dubai local time, computed on demand (cached briefly, then evicted), and rejected with a 400 if invalid (bad format, impossible date, or `from` not before `to`).
- Static assets (`app.js`, `styles.css`, vendor bundles) are served with a 1-hour browser cache lifetime; `index.html` is always revalidated. When iterating on the frontend, use a private/incognito tab (or hard refresh) to see changes immediately.
