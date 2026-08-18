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
// exposes GET /api/leadflow?range=today|7d|30d with the row data.

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

// Sales departments: 5 = Sales, 29 = Client Managers (same scope as the
// existing performance-board dashboard).
const SALES_DEPARTMENTS = [5, 29];

// Non-agent accounts to always exclude regardless of department assignment:
// Khaled El Sherif (CEO), Mina Adel (Performance Marketing Manager), K Estates (generic/system account).
const EXCLUDED_USER_IDS = ['5', '25185', '23781'];

async function fetchActiveAgents() {
  const users = await bx.fetchUsers({ ACTIVE: true });
  return users
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

// Counts leads that entered the Reshuffled stage within [from, to] (by
// stage-history entry time, not lead creation date), grouped by each lead's
// current assignee. A stage-history entry exists whether the lead is still
// sitting in Reshuffled or has since moved on, so this covers both cases.
async function fetchReshuffledCounts(from, to) {
  const history = await bx.fetchAll(
    'crm.stagehistory.list',
    { TYPE_ID: 2, STATUS_ID: RESHUFFLED_STATUS_ID, '>=CREATED_TIME': from, '<=CREATED_TIME': to },
    ['ID', 'OWNER_ID'],
    { entityTypeId: 1, order: { ID: 'ASC' } },
  );
  const leadIds = [...new Set(history.map(h => String(h.OWNER_ID)))];
  if (!leadIds.length) return {};

  const counts = {};
  for (let i = 0; i < leadIds.length; i += 50) {
    const chunk = leadIds.slice(i, i + 50);
    const r = await bx.call('crm.lead.list', { filter: { '@ID': chunk }, select: ['ID', 'ASSIGNED_BY_ID'] });
    for (const lead of r.result || []) {
      const uid = lead.ASSIGNED_BY_ID;
      if (uid == null) continue;
      counts[uid] = (counts[uid] || 0) + 1;
    }
  }
  return counts;
}

function dubaiDateStr(isoString) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date(isoString));
}

// Counts leads that moved from one of `fromStatuses` directly into one of
// `toStatuses` within [from, to] (by the transition's stage-history time),
// AND have a timeline comment logged on that same calendar day — a stage
// change with no same-day comment isn't counted, since it has no evidence an
// agent actually did the work. Grouped by each lead's current assignee.
async function fetchStageTransitionCounts(from, to, toStatuses, fromStatuses) {
  const toEntries = await bx.fetchAll(
    'crm.stagehistory.list',
    { TYPE_ID: 2, '@STATUS_ID': toStatuses, '>=CREATED_TIME': from, '<=CREATED_TIME': to },
    ['ID', 'OWNER_ID', 'STATUS_ID', 'CREATED_TIME'],
    { entityTypeId: 1, order: { ID: 'ASC' } },
  );
  if (!toEntries.length) return {};

  const entriesByLead = {};
  for (const e of toEntries) {
    const lid = String(e.OWNER_ID);
    (entriesByLead[lid] ||= []).push(e);
  }
  const leadIds = Object.keys(entriesByLead);

  // For each lead, look at its recent history to find what stage immediately
  // preceded each candidate transition.
  const qualifyingByLead = {}; // leadId -> earliest qualifying transition CREATED_TIME
  for (let i = 0; i < leadIds.length; i += 50) {
    const chunk = leadIds.slice(i, i + 50);
    const cmd = {};
    for (const lid of chunk) {
      cmd['h' + lid] = `crm.stagehistory.list?entityTypeId=1&filter[OWNER_ID]=${lid}&order[CREATED_TIME]=DESC&select[0]=ID&select[1]=STATUS_ID&select[2]=CREATED_TIME&limit=8`;
    }
    const items = await bx.batch(cmd);
    for (const [key, list] of Object.entries(items)) {
      if (!Array.isArray(list)) continue;
      const lid = key.slice(1);
      for (const target of entriesByLead[lid] || []) {
        const idx = list.findIndex(it => String(it.ID) === String(target.ID));
        if (idx === -1 || idx + 1 >= list.length) continue;
        if (!fromStatuses.includes(list[idx + 1].STATUS_ID)) continue;
        if (!qualifyingByLead[lid] || target.CREATED_TIME < qualifyingByLead[lid]) {
          qualifyingByLead[lid] = target.CREATED_TIME;
        }
      }
    }
    if (i + 50 < leadIds.length) await sleep(150);
  }

  const qualifyingLeadIds = Object.keys(qualifyingByLead);
  if (!qualifyingLeadIds.length) return {};

  // Require a timeline comment on the same calendar day as the transition,
  // and attribute the count to the lead's current assignee.
  const counts = {};
  for (let i = 0; i < qualifyingLeadIds.length; i += 50) {
    const chunk = qualifyingLeadIds.slice(i, i + 50);
    const commentCmd = {};
    for (const lid of chunk) commentCmd['c' + lid] = `crm.timeline.comment.list?filter[ENTITY_TYPE]=LEAD&filter[ENTITY_ID]=${lid}`;

    const [commentItems, leadResp] = await Promise.all([
      bx.batch(commentCmd),
      bx.call('crm.lead.list', { filter: { '@ID': chunk }, select: ['ID', 'ASSIGNED_BY_ID'] }),
    ]);

    const assigneeOf = {};
    for (const lead of leadResp.result || []) assigneeOf[String(lead.ID)] = lead.ASSIGNED_BY_ID;

    for (const lid of chunk) {
      const transitionDay = dubaiDateStr(qualifyingByLead[lid]);
      const comments = commentItems['c' + lid] || [];
      const hasSameDayComment = comments.some(c => dubaiDateStr(c.CREATED) === transitionDay);
      if (!hasSameDayComment) continue;
      const uid = assigneeOf[lid];
      if (uid == null) continue;
      counts[uid] = (counts[uid] || 0) + 1;
    }
    if (i + 50 < qualifyingLeadIds.length) await sleep(150);
  }
  return counts;
}

// Lead stages that count as "was being worked" before a real contact.
const CONTACTED_FROM_STATUSES = ['UC_HKU9EC', 'UC_UYK1YZ', '4', 'UC_X8X2WR']; // Reshuffled-Assigned, Assigned, No Answer, Leads Pool
// Lead stages that count as "contact made".
const CONTACTED_TO_STATUSES = ['2', '7', '6']; // Warm, Hot, Cold

function fetchContactedCounts(from, to) {
  return fetchStageTransitionCounts(from, to, CONTACTED_TO_STATUSES, CONTACTED_FROM_STATUSES);
}

// Lead stages that count as "was being worked" before landing in No Answer.
const NO_ANSWER_FROM_STATUSES = ['UC_HKU9EC', 'UC_UYK1YZ', 'JUNK', 'UC_X8X2WR']; // Reshuffled-Assigned, Assigned, Junk, Leads Pool
const NO_ANSWER_TO_STATUSES = ['4']; // No Answer

function fetchNoAnswerCounts(from, to) {
  return fetchStageTransitionCounts(from, to, NO_ANSWER_TO_STATUSES, NO_ANSWER_FROM_STATUSES);
}

async function computeDashboard(range) {
  const { from, to } = getRangeBounds(range);
  const [agents, freshPrimaryBy, freshSecondaryBy, reshuffledBy] = await Promise.all([
    fetchActiveAgents(),
    fetchFreshLeadCounts(from, to),
    fetchFreshLeadSecondaryCounts(from, to),
    fetchReshuffledCounts(from, to),
  ]);
  // Run the two heaviest fetchers (each does a per-lead stage-history +
  // comment lookup) one after another rather than alongside everything
  // above, to avoid bursting past the portal's request-rate limit.
  const contactedBy = await fetchContactedCounts(from, to);
  const noAnswerBy = await fetchNoAnswerCounts(from, to);

  const rows = agents.map(a => ({
    ...a,
    freshPrimary: freshPrimaryBy[a.id] || 0,
    freshSecondary: freshSecondaryBy[a.id] || 0,
    reshuffled: reshuffledBy[a.id] || 0,
    contacted: contactedBy[a.id] || 0,
    noAnswer: noAnswerBy[a.id] || 0,
  }));

  return { range, agents: rows, updatedAt: new Date().toISOString() };
}

// Recomputes a range and updates the cache. Concurrent callers for the same
// range (a browser request landing mid-refresh, or two refresh loops
// overlapping) share the same in-flight promise instead of double-computing.
function refreshRange(range) {
  if (inFlight.has(range)) return inFlight.get(range);
  const p = computeDashboard(range)
    .then(data => { cache.set(range, data); return data; })
    .catch(err => {
      console.error(`Refresh failed for range "${range}":`, err.message);
      throw err;
    })
    .finally(() => inFlight.delete(range));
  inFlight.set(range, p);
  return p;
}

app.get('/api/leadflow', async (req, res) => {
  const range = RANGES.hasOwnProperty(req.query.range) ? req.query.range : 'today';

  // API responses reflect live CRM data and must never be cached by the
  // browser or an intermediary — the background loop below is what keeps
  // this endpoint fast, not HTTP caching.
  res.set('Cache-Control', 'no-store');

  const cached = cache.get(range);
  if (cached) return res.json(cached);

  // Nothing cached yet for this range (first hit since server start) — wait
  // for the one computation in flight rather than failing the request.
  try {
    const data = await refreshRange(range);
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
      await refreshRange(range);
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
