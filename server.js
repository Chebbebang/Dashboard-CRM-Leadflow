// Lead-flow dashboard backend.
//
// Columns (built up incrementally, per K Estates' request):
//   1. Agent                              <- live now
//   2. Fresh Leads received - Primary     <- live now (leads created in range, by assignee)
//   3. Fresh Leads received - Secondary   <- live now (Property Finder leads + Rental Leads deals created in range, by assignee)
//   4. New Reshuffled Leads assigned      <- live now (leads that entered the Reshuffled stage in range, by current assignee)
//   5. Leads Contacted                    <- live now (Reshuffled/Assigned/No Answer/Pool -> Warm/Hot/Cold, with same-day comment)
//   6. Leads no Answer                    <- live now (Reshuffled/Assigned/Junk/Pool -> No Answer, with same-day comment)
//
// Serves index.html (this dashboard's own page) as a static file and
// exposes GET /api/leadflow?range=today|7d|30d with the row data, plus a
// custom datetime window via ?from=YYYY-MM-DDTHH:mm&to=YYYY-MM-DDTHH:mm
// (interpreted as Dubai time).

import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import 'dotenv/config';
import { createClient, sleep } from './bitrix.js';

const WEBHOOK = process.env.LEADFLOW_WEBHOOK_URL;
if (!WEBHOOK) {
  console.error('Missing LEADFLOW_WEBHOOK_URL in .env');
  process.exit(1);
}

const bx = createClient(WEBHOOK);

const app = express();
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
  // Not needed for this single-origin dashboard, and stricter than useful.
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());

// Cacheable static assets (vendor bundles, css, app script) get a real
// browser cache lifetime; index.html stays revalidate-on-load so deploys
// take effect immediately without needing cache-busted filenames.
app.use(express.static('public', {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }
  },
}));

// range -> last computed { range, agents, updatedAt }. Populated and kept
// warm by the background refresh loops below, so requests almost always hit
// cache instantly instead of waiting on a live Bitrix computation.
const cache = new Map();
// range -> in-flight computation Promise, so concurrent requests/refreshes
// for the same range share one computation instead of racing duplicates.
const inFlight = new Map();

const RANGES = {
  today: 0,
  '7d': 6,
  '30d': 29,
};

function getDubaiParts(date) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Dubai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date || new Date());
  const get = t => parseInt(parts.find(p => p.type === t).value);
  return { y: get('year'), M: get('month'), d: get('day'), h: get('hour'), m: get('minute'), s: get('second') };
}

function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${dd}T${h}:${min}:${s}+04:00`;
}

// Returns the [from, to] ISO bounds (Dubai time) for a range key: the start
// of (today - daysBack) through right now.
function getRangeBounds(rangeKey) {
  const daysBack = RANGES[rangeKey] ?? RANGES.today;
  const db = getDubaiParts();
  const now = new Date(db.y, db.M - 1, db.d, db.h, db.m, db.s);
  const from = new Date(db.y, db.M - 1, db.d - daysBack);
  return { from: iso(from), to: iso(now) };
}

// Custom datetime-range filtering: the frontend sends naive local datetimes
// (YYYY-MM-DDTHH:mm[:ss]) that are interpreted as Dubai wall-clock time, the
// same anchor every other range uses. Dubai is UTC+4 year-round, so the
// offsets below match what `iso()` produces for the preset ranges.
const DUBAI_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function dubaiIso(naive) {
  const m = DUBAI_DATETIME_RE.exec(naive);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+04:00`;
}

// Validates `from`/`to` query params and returns bounds, or null if invalid.
// The naive datetimes are validated as real calendar dates (rejects 2026-02-30
// etc.) and `to` must be strictly after `from`.
function parseDubaiBounds(from, to) {
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const mf = DUBAI_DATETIME_RE.exec(from.trim());
  const mt = DUBAI_DATETIME_RE.exec(to.trim());
  if (!mf || !mt) return null;

  const asUtc = m => Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
  const valid = m => {
    const d = new Date(asUtc(m));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  };
  if (!valid(mf) || !valid(mt)) return null;

  const fromMs = asUtc(mf);
  const toMs = asUtc(mt);
  if (toMs <= fromMs) return null;

  return { from: dubaiIso(from.trim()), to: dubaiIso(to.trim()) };
}

// Sales departments: 5 = Sales, 29 = Client Managers (same scope as the
// existing performance-board dashboard).
const SALES_DEPARTMENTS = [5, 29];

// Non-agent accounts to always exclude regardless of department assignment:
// Khaled El Sherif (CEO), Mina Adel (Performance Marketing Manager), K Estates (generic/system account).
const EXCLUDED_USER_IDS = ['5', '25185', '23781'];

// Agents and their department membership rarely change; cache briefly so
// every computation doesn't re-pay a user.get scan.
let agentsCache = { at: 0, value: null };
const AGENTS_TTL_MS = 15 * 60_000;

async function fetchActiveAgents() {
  if (agentsCache.value && Date.now() - agentsCache.at < AGENTS_TTL_MS) return agentsCache.value;
  const users = await bx.fetchUsers({ ACTIVE: true });
  const agents = users
    .filter(u => u.ACTIVE === true)
    .filter(u => !EXCLUDED_USER_IDS.includes(String(u.ID)))
    .filter(u => {
      const d = u.UF_DEPARTMENT || [];
      return SALES_DEPARTMENTS.some(dep => d.includes(dep));
    })
    .map(u => ({
      id: u.ID,
      name: [u.NAME, u.LAST_NAME].filter(Boolean).join(' '),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  agentsCache = { at: Date.now(), value: agents };
  return agents;
}

// Source of "Fresh Leads received - Secondary".
const PROPERTY_FINDER_SOURCE_ID = 'UC_E5UPNG';
// Deal pipeline (crm.dealcategory) that also feeds "Fresh Leads received - Secondary".
const RENTAL_LEADS_CATEGORY_ID = 13;

function countByAssignee(items) {
  const counts = {};
  for (const item of items) {
    const uid = item.ASSIGNED_BY_ID;
    if (uid == null) continue;
    counts[uid] = (counts[uid] || 0) + 1;
  }
  return counts;
}

// Runs `fn(chunk)` over chunks of `items` with up to `concurrency` chunks in
// flight at once. Each chunk is one request (a batch or a list call), so
// bounded concurrency cuts wall-clock time without bursting the portal's
// rolling request-rate budget — the client already backs off on
// QUERY_LIMIT_EXCEEDED if a burst slips through.
async function mapChunks(items, fn, { chunkSize = 50, concurrency = 3, paceMs = 150 } = {}) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) chunks.push(items.slice(i, i + chunkSize));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, async () => {
    for (;;) {
      const idx = next++;
      if (idx >= chunks.length) return;
      await fn(chunks[idx]);
      if (paceMs) await sleep(paceMs);
    }
  }));
}

// Counts leads created within [from, to], grouped by assigned agent.
async function fetchFreshLeadCounts(from, to) {
  const leads = await bx.fetchAll(
    'crm.lead.list',
    { '>=DATE_CREATE': from, '<=DATE_CREATE': to },
    ['ID', 'ASSIGNED_BY_ID'],
  );
  return countByAssignee(leads);
}

// Counts Property Finder leads + Rental Leads pipeline deals created within
// [from, to], grouped by assigned agent.
async function fetchFreshLeadSecondaryCounts(from, to) {
  const [pfLeads, rentalDeals] = await Promise.all([
    bx.fetchAll(
      'crm.lead.list',
      { '>=DATE_CREATE': from, '<=DATE_CREATE': to, SOURCE_ID: PROPERTY_FINDER_SOURCE_ID },
      ['ID', 'ASSIGNED_BY_ID'],
    ),
    bx.fetchAll(
      'crm.deal.list',
      { '>=DATE_CREATE': from, '<=DATE_CREATE': to, CATEGORY_ID: RENTAL_LEADS_CATEGORY_ID },
      ['ID', 'ASSIGNED_BY_ID'],
    ),
  ]);
  const counts = countByAssignee(pfLeads);
  for (const [uid, c] of Object.entries(countByAssignee(rentalDeals))) {
    counts[uid] = (counts[uid] || 0) + c;
  }
  return counts;
}

// Lead stage: "2. Reshuffled - Assigned".
const RESHUFFLED_STATUS_ID = 'UC_HKU9EC';

// Cached current-assignee lookups, shared by the reshuffled and transition
// passes (and across ranges, since Today ⊂ 7d ⊂ 30d). Reassignment of a lead
// is reflected after the TTL.
const assigneeCache = new Map(); // lid -> { at, v: uid }
const ASSIGNEE_TTL_MS = 5 * 60_000;

// Returns { lid: uid } for every lead in `chunk`, reusing cached lookups.
async function assigneesOf(chunk) {
  const toFetch = chunk.filter(lid => cacheGet(assigneeCache, lid, ASSIGNEE_TTL_MS) === undefined);
  const fetched = {};
  if (toFetch.length) {
    const r = await bx.call('crm.lead.list', { filter: { '@ID': toFetch }, select: ['ID', 'ASSIGNED_BY_ID'] });
    for (const lead of r.result || []) {
      const lid = String(lead.ID);
      fetched[lid] = lead.ASSIGNED_BY_ID;
      cachePut(assigneeCache, lid, lead.ASSIGNED_BY_ID);
    }
  }
  const out = {};
  for (const lid of chunk) {
    const uid = fetched[lid] ?? cacheGet(assigneeCache, lid, ASSIGNEE_TTL_MS);
    if (uid != null) out[lid] = uid;
  }
  return out;
}

// Counts leads that entered the Reshuffled stage within [from, to] (by
// stage-history entry time, not lead creation date), grouped by each lead's
// current assignee. A stage-history entry exists whether the lead is still
// sitting in Reshuffled or has since moved on, so this covers both cases.
async function countReshuffled(reshuffledEntries) {
  const leadIds = [...new Set(reshuffledEntries.map(h => String(h.OWNER_ID)))];
  if (!leadIds.length) return {};

  const counts = {};
  await mapChunks(leadIds, async chunk => {
    const assignees = await assigneesOf(chunk);
    for (const lid of chunk) {
      const uid = assignees[lid];
      if (uid == null) continue;
      counts[uid] = (counts[uid] || 0) + 1;
    }
  });
  return counts;
}

function dubaiDateStr(isoString) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date(isoString));
}

// Stage-history scans are the most expensive queries in the dashboard, and
// every range's scan ends at "now" — so a scan fetched for one window (say
// Last 7 Days) covers any custom window inside it. Reuse the widest fresh
// scan whose bounds contain the requested window, extending it with a small
// incremental fetch of just the minutes since the cached scan ran.
const stageHistoryCache = new Map(); // 'fromDay|toDay' -> { at, fromDay, toDay, to, entries }
const STAGE_HISTORY_TTL_MS = 10 * 60_000;
const STAGE_HISTORY_MAX_ENTRIES = 8;

async function fetchStageHistory(from, to) {
  const fromDay = from.slice(0, 10);
  const toDay = to.slice(0, 10);
  let best = null;
  for (const v of stageHistoryCache.values()) {
    if (v.toDay === toDay && v.fromDay <= fromDay && Date.now() - v.at < STAGE_HISTORY_TTL_MS) {
      if (!best || v.fromDay > best.fromDay) best = v;
    }
  }
  if (best && best.to >= to) {
    return best.entries.filter(e => e.CREATED_TIME >= from && e.CREATED_TIME <= to);
  }
  const fetchFrom = best ? best.to : from;
  const tail = await bx.fetchAll(
    'crm.stagehistory.list',
    { TYPE_ID: 2, '>=CREATED_TIME': fetchFrom, '<=CREATED_TIME': to },
    ['ID', 'OWNER_ID', 'STATUS_ID', 'CREATED_TIME'],
    { entityTypeId: 1, order: { ID: 'ASC' } },
  );
  if (best) {
    const seen = new Set(best.entries.map(e => String(e.ID)));
    for (const e of tail) {
      if (!seen.has(String(e.ID))) { seen.add(String(e.ID)); best.entries.push(e); }
    }
    best.to = to;
    best.at = Date.now();
  } else {
    stageHistoryCache.set(fromDay + '|' + toDay, { at: Date.now(), fromDay, toDay, to, entries: tail });
    if (stageHistoryCache.size > STAGE_HISTORY_MAX_ENTRIES) {
      stageHistoryCache.delete(stageHistoryCache.keys().next().value);
    }
  }
  const entries = best ? best.entries : tail;
  return entries.filter(e => e.CREATED_TIME >= from && e.CREATED_TIME <= to);
}
// Lead stages that count as "was being worked" before a real contact.
const CONTACTED_FROM_STATUSES = ['UC_HKU9EC', 'UC_UYK1YZ', '4', 'UC_X8X2WR']; // Reshuffled-Assigned, Assigned, No Answer, Leads Pool
// Lead stages that count as "contact made".
const CONTACTED_TO_STATUSES = ['2', '7', '6']; // Warm, Hot, Cold

// Lead stages that count as "was being worked" before landing in No Answer.
const NO_ANSWER_FROM_STATUSES = ['UC_HKU9EC', 'UC_UYK1YZ', 'JUNK', 'UC_X8X2WR']; // Reshuffled-Assigned, Assigned, Junk, Leads Pool
const NO_ANSWER_TO_STATUSES = ['4']; // No Answer

// Both same-day-comment rules are evaluated in ONE pass over the stage
// history, so a lead that qualifies under both rules (e.g. contacted one day,
// no answer another) only pays for its per-lead history and comment lookups
// once instead of twice.
const TRANSITION_RULES = [
  { label: 'contacted', toStatuses: CONTACTED_TO_STATUSES, fromStatuses: CONTACTED_FROM_STATUSES },
  { label: 'noAnswer', toStatuses: NO_ANSWER_TO_STATUSES, fromStatuses: NO_ANSWER_FROM_STATUSES },
];

// Per-lead lookups dominate the transition-count cost, and ranges overlap
// (Today ⊂ Last 7 Days ⊂ Last 30 Days, plus custom windows), so cache them:
// stage history is very stable (long TTL), timeline comments less so.
const CACHE_MAX = 8000;
const HISTORY_TTL_MS = 15 * 60_000;
const COMMENT_TTL_MS = 5 * 60_000;
const historyCache = new Map(); // lid -> { at, v: [stage-history entries] }
const commentCache = new Map(); // lid -> { at, v: [timeline comments] }

function cacheGet(map, key, ttlMs) {
  const hit = map.get(key);
  return hit && Date.now() - hit.at < ttlMs ? hit.v : undefined;
}

function cachePut(map, key, value) {
  map.set(key, { at: Date.now(), v: value });
  if (map.size <= CACHE_MAX) return;
  // Evict oldest (Map preserves insertion order).
  for (const k of map.keys()) {
    map.delete(k);
    if (map.size <= CACHE_MAX) break;
  }
}

// Counts transitions for every rule in `rules` in a single pass over the
// already-fetched stage-history entries. Each rule counts leads that moved
// from one of its fromStatuses directly into one of its toStatuses within
// [from, to] (by the transition's stage-history time), AND have a timeline
// comment logged on that same calendar day — a stage change with no same-day
// comment isn't counted, since it has no evidence an agent actually did the
// work. Grouped by each lead's current assignee.
async function fetchTransitionCounts(toEntries, rules) {
  const countsByRule = {};
  for (const r of rules) countsByRule[r.label] = {};

  const entriesByLead = {};
  for (const e of toEntries) {
    const lid = String(e.OWNER_ID);
    (entriesByLead[lid] ||= []).push(e);
  }
  const leadIds = Object.keys(entriesByLead);
  if (!leadIds.length) return countsByRule;

  // For each lead, look at its recent history to find what stage immediately
  // preceded each candidate transition. Cached lookups are skipped entirely.
  const qualifyingByRule = {}; // rule label -> leadId -> earliest qualifying transition CREATED_TIME
  await mapChunks(leadIds, async chunk => {
    const toFetch = chunk.filter(lid => cacheGet(historyCache, lid, HISTORY_TTL_MS) === undefined);
    const cmd = {};
    for (const lid of toFetch) {
      cmd['h' + lid] = `crm.stagehistory.list?entityTypeId=1&filter[OWNER_ID]=${lid}&order[CREATED_TIME]=DESC&select[0]=ID&select[1]=STATUS_ID&select[2]=CREATED_TIME&limit=8`;
    }
    const items = toFetch.length ? await bx.batch(cmd) : {};
    for (const lid of chunk) {
      const list = items['h' + lid] ?? cacheGet(historyCache, lid, HISTORY_TTL_MS);
      if (!Array.isArray(list)) continue;
      if (toFetch.includes(lid)) cachePut(historyCache, lid, list);
      for (const target of entriesByLead[lid] || []) {
        const idx = list.findIndex(it => String(it.ID) === String(target.ID));
        if (idx === -1 || idx + 1 >= list.length) continue;
        const rule = rules.find(r =>
          r.toStatuses.includes(target.STATUS_ID) && r.fromStatuses.includes(list[idx + 1].STATUS_ID));
        if (!rule) continue;
        const byLead = (qualifyingByRule[rule.label] ||= {});
        const cur = byLead[lid];
        if (!cur || target.CREATED_TIME < cur) byLead[lid] = target.CREATED_TIME;
      }
    }
  });

  // (rule, lead, time) pairs for the comment pass — one lead may qualify
  // under several rules on different days.
  const pairsByLead = {};
  for (const [label, byLead] of Object.entries(qualifyingByRule)) {
    for (const [lid, time] of Object.entries(byLead)) {
      (pairsByLead[lid] ||= []).push({ time, rule: label });
    }
  }
  const qualifyingLeadIds = Object.keys(pairsByLead);
  if (!qualifyingLeadIds.length) return countsByRule;

  // Require a timeline comment on the same calendar day as the transition,
  // and attribute the count to the lead's current assignee.
  await mapChunks(qualifyingLeadIds, async chunk => {
    const toFetch = chunk.filter(lid => cacheGet(commentCache, lid, COMMENT_TTL_MS) === undefined);
    const commentCmd = {};
    for (const lid of toFetch) commentCmd['c' + lid] = `crm.timeline.comment.list?filter[ENTITY_TYPE]=LEAD&filter[ENTITY_ID]=${lid}`;

    const [commentItems, assignees] = await Promise.all([
      toFetch.length ? bx.batch(commentCmd) : Promise.resolve({}),
      assigneesOf(chunk),
    ]);

    for (const lid of chunk) {
      const comments = commentItems['c' + lid] ?? cacheGet(commentCache, lid, COMMENT_TTL_MS);
      if (!Array.isArray(comments)) continue;
      if (toFetch.includes(lid)) cachePut(commentCache, lid, comments);
      for (const { time, rule } of pairsByLead[lid]) {
        const transitionDay = dubaiDateStr(time);
        const hasSameDayComment = comments.some(c => dubaiDateStr(c.CREATED) === transitionDay);
        if (!hasSameDayComment) continue;
        const uid = assignees[lid];
        if (uid == null) continue;
        const c = countsByRule[rule];
        c[uid] = (c[uid] || 0) + 1;
      }
    }
  });
  return countsByRule;
}

async function computeDashboard(bounds) {
  const { from, to } = bounds;
  // One scan of the lead stage-history table feeds all three stage-based
  // columns (Reshuffled entries, Contacted candidates, No Answer candidates).
  // fetchStageHistory reuses a previously fetched scan for any window ending
  // "now" instead of re-scanning the table.
  const history = await fetchStageHistory(from, to);
  const reshuffledEntries = history.filter(e => e.STATUS_ID === RESHUFFLED_STATUS_ID);
  const targetStatuses = new Set(TRANSITION_RULES.flatMap(r => r.toStatuses));
  const transitionEntries = history.filter(e => targetStatuses.has(e.STATUS_ID));

  const [agents, freshPrimaryBy, freshSecondaryBy, reshuffledBy] = await Promise.all([
    fetchActiveAgents(),
    fetchFreshLeadCounts(from, to),
    fetchFreshLeadSecondaryCounts(from, to),
    countReshuffled(reshuffledEntries),
  ]);
  // The heavy transition pass (per-lead stage-history + comment lookups) runs
  // after the fetchers above, and evaluates both rules in one scan so its
  // per-lead lookups are never paid twice.
  const countsByRule = await fetchTransitionCounts(transitionEntries, TRANSITION_RULES);
  const contactedBy = countsByRule.contacted;
  const noAnswerBy = countsByRule.noAnswer;

  const rows = agents.map(a => ({
    ...a,
    freshPrimary: freshPrimaryBy[a.id] || 0,
    freshSecondary: freshSecondaryBy[a.id] || 0,
    reshuffled: reshuffledBy[a.id] || 0,
    contacted: contactedBy[a.id] || 0,
    noAnswer: noAnswerBy[a.id] || 0,
  }));

  return { agents: rows, updatedAt: new Date().toISOString() };
}

// Global queue so only one dashboard computation is touching Bitrix at a
// time. The background refresh loops run alongside one-off custom-range
// requests, and two heavy computations in parallel (each doing hundreds of
// batched stage-history/comment lookups) burst past the portal's rolling
// request-rate limit. Serializing them keeps every compute under the budget.
let computeQueue = Promise.resolve();
// Background refreshes yield to user requests waiting in the queue so an
// uncached custom-range request doesn't have to wait behind a multi-minute
// 30-day background scan.
let pendingUserRequests = 0;

// Bitrix's request budget refills gradually after a heavy compute, so the
// next queued computation waits a short cooldown before starting.
const COMPUTE_COOLDOWN_MS = 5_000;

function enqueueCompute(bounds, background) {
  if (!background) pendingUserRequests++;
  const run = computeQueue.then(async () => {
    // A background refresh can be skipped if a user request is waiting: the
    // loop simply retries on its next interval, keeping the cache warm.
    if (background && pendingUserRequests > 0) return null;
    const result = await computeDashboard(bounds);
    await sleep(COMPUTE_COOLDOWN_MS);
    return result;
  }).finally(() => {
    if (!background) pendingUserRequests = Math.max(0, pendingUserRequests - 1);
  });
  computeQueue = run.catch(() => {});
  return run;
}

// Recomputes a range and updates the cache. Concurrent callers for the same
// key (a browser request landing mid-refresh, or two refresh loops
// overlapping) share the same in-flight promise instead of double-computing.
function refreshRange(key, bounds, background = false) {
  if (inFlight.has(key)) return inFlight.get(key);
  const p = enqueueCompute(bounds, background)
    .then(data => {
      if (data) { cache.set(key, data); trimCache(); }
      return data;
    })
    .catch(err => {
      console.error(`Refresh failed for "${key}":`, err.message);
      throw err;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

// Arbitrary custom datetime ranges would otherwise grow the cache forever;
// keep only the most recent entries (preset ranges are re-inserted on their
// refresh loops, so they're never evicted while a loop is running).
const MAX_CACHE_ENTRIES = 60;

function trimCache() {
  while (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

app.get('/api/leadflow', async (req, res) => {
  // API responses reflect live CRM data and must never be cached by the
  // browser or an intermediary — the background loop below is what keeps
  // this endpoint fast, not HTTP caching.
  res.set('Cache-Control', 'no-store');

  // Custom datetime ranges override the preset selector: both bounds are
  // required and must describe a valid, non-empty window in Dubai time.
  const { from, to } = req.query;
  let key;
  let bounds;
  if (from || to) {
    bounds = parseDubaiBounds(from, to);
    if (!bounds) {
      return res.status(400).json({
        error: 'Invalid date range. Use from/to as YYYY-MM-DDTHH:mm (Dubai time), with from before to.',
      });
    }
    key = 'custom|' + bounds.from + '|' + bounds.to;
  } else {
    const range = RANGES.hasOwnProperty(req.query.range) ? req.query.range : 'today';
    key = range;
    bounds = getRangeBounds(range);
  }

  const cached = cache.get(key);
  if (cached) return res.json(cached);

  // Nothing cached yet for this range (first hit since server start) — wait
  // for the one computation in flight rather than failing the request.
    try {
    const data = await refreshRange(key, bounds, false);
    res.json(data);
  } catch (err) {
    res.status(503).json({ error: 'Dashboard data is still warming up — please retry shortly.' });
  }
});

// Keeps each range's cache warm in the background so user requests are
// always served instantly from `cache`. Each range gets its own loop with a
// cadence matched to how expensive it is to compute, and loops re-schedule
// themselves only after finishing (never overlapping their own next run).
function startRefreshLoop(range, intervalMs) {
  async function tick() {
    try {
      await refreshRange(range, getRangeBounds(range), true);
    } catch {
      // Already logged inside refreshRange; keep the loop alive.
    }
    setTimeout(tick, intervalMs);
  }
  tick();
}

const PORT = process.env.LEADFLOW_PORT || 3002;
app.listen(PORT, () => {
  console.log(`LeadFlow dashboard running at http://localhost:${PORT}`);
  startRefreshLoop('today', 30_000);
  setTimeout(() => startRefreshLoop('7d', 60_000), 5_000);
  setTimeout(() => startRefreshLoop('30d', 120_000), 15_000);
});
