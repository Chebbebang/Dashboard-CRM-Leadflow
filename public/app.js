const { createElement: h, useState, useEffect, useMemo, useRef } = React;
const { createRoot } = ReactDOM;

const POLL = 60_000;

const RANGE_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 Days' },
  { value: '30d', label: 'Last 30 Days' },
  { value: 'custom', label: 'Custom Range…' },
];

// 'YYYY-MM-DDTHH:mm' of `date` in Dubai wall-clock time — the format the
// custom range inputs use and the API interprets as Asia/Dubai.
function dubaiLocalValue(date) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Dubai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

const THEME_KEY = 'leadflow-theme';

const THEME_ICONS = {
  light: h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
    h('circle', { cx: 12, cy: 12, r: 4 }),
    h('path', { d: 'M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41' }),
  ),
  dark: h('svg', { viewBox: '0 0 24 24', fill: 'currentColor' },
    h('path', { d: 'M20.7 15.3A8.5 8.5 0 0 1 8.7 3.3a8.5 8.5 0 1 0 12 12z' }),
  ),
  system: h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
    h('rect', { x: 3, y: 4, width: 18, height: 13, rx: 2 }),
    h('path', { d: 'M8 21h8M12 17v4' }),
  ),
};

const THEME_OPTIONS = [
  { value: 'light', label: 'Light Mode' },
  { value: 'dark', label: 'Night Mode' },
  { value: 'system', label: 'System Default' },
];

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_KEY) || 'system');

  useEffect(() => {
    if (theme === 'system') {
      delete document.documentElement.dataset.theme;
    } else {
      document.documentElement.dataset.theme = theme;
    }
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  return [theme, setTheme];
}

// Single button showing the current mode's icon — click cycles to the next
// mode. No floating menu, so nothing to misposition or clip on mobile.
function ThemeToggle({ theme, setTheme }) {
  const idx = THEME_OPTIONS.findIndex(o => o.value === theme);
  const current = THEME_OPTIONS[idx] || THEME_OPTIONS[0];

  function cycle() {
    const next = THEME_OPTIONS[(idx + 1) % THEME_OPTIONS.length];
    setTheme(next.value);
  }

  return h('button', {
    type: 'button',
    className: 'theme-btn',
    'data-tooltip': current.label + ' (click to change)',
    'aria-label': current.label,
    onClick: cycle,
  }, THEME_ICONS[current.value]);
}

// All data columns except Agent. `key` is the field on each agent row used
// for sorting; columns without a key are placeholders awaiting their metric
// and become sortable once that key exists.
const COLUMNS = [
  {
    key: 'freshPrimary', label: 'Fresh Leads Received – Primary',
    info: 'Leads created within the selected range that have since moved past the "1. Fresh" stage, grouped by assigned agent. Leads still sitting untouched in Fresh aren\'t counted as "received" yet.',
  },
  {
    key: 'freshSecondary', label: 'Fresh Leads Received – Secondary',
    info: 'Property Finder–sourced leads, plus Rental Leads pipeline deals, created within the selected range that have since moved past their pipeline\'s Fresh stage, grouped by assigned agent.',
  },
  {
    key: 'reshuffled', label: 'New Reshuffled Leads Assigned',
    info: 'Leads whose stage history shows an entry into "Reshuffled - Assigned" within the selected range, grouped by the lead\'s current assignee.',
  },
  {
    key: 'contacted', label: 'Leads Contacted',
    info: 'Two sources, added together: (1) leads that moved directly from a "being worked" stage (Reshuffled - Assigned, Assigned, No Answer, or Leads Pool) into Warm, Hot, or Cold within the selected range, with a same-day timeline comment logged as evidence of real agent work credited to the lead\'s current assignee, only the earliest qualifying transition per lead counts; plus (2) any other timeline comment logged within range while a lead sits in Warm, Hot, Cold, or Leads Pool with no stage change that day credited to the lead\'s current assignee, or for Leads Pool to the comment\'s author (since it\'s public and anyone can comment), capped at one credit per person per lead per day.',
  },
  {
    key: 'noAnswer', label: 'Leads No Answer',
    info: 'Same mechanism as Contacted, but for transitions from a "being worked" stage (Reshuffled - Assigned, Assigned, Junk, or Leads Pool) directly into No Answer, with a same-day timeline comment required.',
  },
];

// Current pipeline-by-stage table: range-independent, so it polls on its own
// schedule rather than reacting to the range selector.
const STAGE_COLUMNS = [
  { key: 'assigned', label: 'Assigned' },
  { key: 'reshuffled', label: 'Reshuffled - Assigned' },
  { key: 'noAnswer', label: 'No Answer' },
  { key: 'cold', label: 'Cold' },
  { key: 'warm', label: 'Warm' },
  { key: 'hot', label: 'Hot' },
  { key: 'total', label: 'Total' },
];

const SKELETON_ROWS = 10;

function SkeletonBody() {
  return h('tbody', null,
    Array.from({ length: SKELETON_ROWS }, (_, i) => h('tr', { key: i },
      h('td', { className: 'rank' }, h('span', { className: 'skel skel-rank' })),
      h('td', { className: 'name' }, h('span', { className: 'skel skel-name' })),
      COLUMNS.map(col => h('td', { className: col.key !== null ? 'num' : 'pending', key: col.label },
        h('span', { className: 'skel skel-num' }),
      )),
    )),
  );
}

function SortableHeader({ column, sortKey, sortDir, onSort, numeric = true }) {
  const sortable = column.key !== null;
  const isSorted = sortable && sortKey === column.key;
  return h('th', {
    className: [numeric ? 'num' : '', sortable ? 'sortable' : 'pending', isSorted ? 'sorted' : ''].filter(Boolean).join(' '),
    onClick: sortable ? () => onSort(column.key) : undefined,
  }, column.label, isSorted && h('span', { className: 'arrow' }, sortDir === 'asc' ? '▲' : '▼'));
}

// Explains, per column, the exact criteria a lead must meet to be counted —
// text mirrors the rules documented in README.md so the two never diverge in
// meaning (wording may be trimmed for on-screen space).
function ColumnInfoModal({ onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return h('div', { className: 'modal-backdrop', onClick: onClose },
    h('div', {
      className: 'modal-card',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Column counting criteria',
      onClick: e => e.stopPropagation(),
    },
      h('div', { className: 'modal-head' },
        h('h2', null, 'How Columns Are Counted'),
        h('button', { type: 'button', className: 'modal-close', 'data-tooltip': 'Close', 'aria-label': 'Close', onClick: onClose }, '✕'),
      ),
      h('dl', { className: 'modal-body' },
        COLUMNS.map(col => [
          h('dt', { key: col.label + '-t' }, col.label),
          h('dd', { key: col.label + '-d' }, col.info),
        ]),
      ),
    ),
  );
}

function StageCountsSkeletonBody() {
  return h('tbody', null,
    Array.from({ length: SKELETON_ROWS }, (_, i) => h('tr', { key: i },
      h('td', { className: 'rank' }, h('span', { className: 'skel skel-rank' })),
      h('td', { className: 'name' }, h('span', { className: 'skel skel-name' })),
      STAGE_COLUMNS.map(col => h('td', { className: 'num', key: col.label },
        h('span', { className: 'skel skel-num' }),
      )),
    )),
  );
}

// Shows how many leads each agent currently owns, broken down by stage
// (Assigned, Reshuffled - Assigned, No Answer, Cold, Warm, Hot). Unlike the
// main table this has no date range — it reflects the live pipeline right
// now — so it fetches and polls independently of the range selector above.
function StageCountsTable() {
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [sortKey, setSortKey] = useState('total');
  const [sortDir, setSortDir] = useState('desc');

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  }

  const sortedAgents = useMemo(() => {
    if (!agents || !sortKey) return agents;
    const rows = [...agents];
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = typeof av === 'string' || typeof bv === 'string'
        ? String(av || '').localeCompare(String(bv || ''))
        : (av || 0) - (bv || 0);
      if (cmp === 0) return a.name.localeCompare(b.name);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [agents, sortKey, sortDir]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const r = await fetch('/api/leadflow/stage-counts');
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error || 'Request failed: ' + r.status);
        if (cancelled) return;
        setAgents(d.agents || []);
        setUpdatedAt(d.updatedAt || null);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    }

    load();
    const id = setInterval(load, POLL);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const lastUpdated = updatedAt
    ? new Date(updatedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit' })
    : '—';

  return h('section', { className: 'stage-counts' },
    h('div', { className: 'section-head' },
      h('h2', null, 'Current Pipeline by Stage'),
      h('div', { className: 'icon-btns' },
        h('div', { className: 'status' }, `Updated ${lastUpdated}`),
      ),
    ),
    error && h('div', { className: 'error' }, 'Failed to load data: ' + error),
    !error && h('div', { className: 'table-wrap' },
      h('table', null,
        h('thead', null,
          h('tr', null,
            h('th', null, '#'),
            h(SortableHeader, { column: { key: 'name', label: 'Agent' }, sortKey, sortDir, onSort: handleSort, numeric: false }),
            STAGE_COLUMNS.map(col => h(SortableHeader, { key: col.label, column: col, sortKey, sortDir, onSort: handleSort })),
          ),
        ),
        agents === null
          ? h(StageCountsSkeletonBody, null)
          : h('tbody', null,
              sortedAgents.map((agent, i) => h('tr', { key: agent.id },
                h('td', { className: 'rank' }, i + 1),
                h('td', { className: 'name' }, agent.name),
                STAGE_COLUMNS.map(col => {
                  const val = agent[col.key];
                  return h('td', {
                    className: 'num' + (val > 0 ? ' live' : ''),
                    key: col.label,
                  }, val);
                }),
              )),
            ),
        agents !== null && h('tfoot', null,
          h('tr', null,
            h('td', null),
            h('td', { className: 'tlabel' }, 'Team Total'),
            STAGE_COLUMNS.map(col => {
              const val = agents.reduce((s, a) => s + a[col.key], 0);
              return h('td', {
                className: 'num' + (val > 0 ? ' live' : ''),
                key: col.label,
              }, val);
            }),
          ),
        ),
      ),
    ),
    !error && agents !== null && agents.length === 0 && h('div', { className: 'empty' }, 'No active agents found.'),
  );
}

function App() {
  const [theme, setTheme] = useTheme();
  const [range, setRange] = useState('today');
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('desc');
  const [loading, setLoading] = useState(false);
  // Custom datetime range: draft values in the pickers vs. the range that was
  // actually applied to the last fetch.
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [appliedFrom, setAppliedFrom] = useState('');
  const [appliedTo, setAppliedTo] = useState('');
  const [showColumnInfo, setShowColumnInfo] = useState(false);
  // Bumped by the refresh button to re-trigger the fetch effect on demand,
  // independent of the 60s poll and any range/date change.
  const [refreshTick, setRefreshTick] = useState(0);
  // Set right before bumping refreshTick so only that one fetch (not the
  // subsequent 60s polls) asks the server to bypass its cache.
  const forceRef = useRef(false);

  // Prefill the pickers with a sensible default window (last 7 days through
  // now, Dubai time) the first time the custom range is selected.
  useEffect(() => {
    if (range !== 'custom') return;
    if (!customFrom) setCustomFrom(dubaiLocalValue(new Date(Date.now() - 7 * 86400000)));
    if (!customTo) setCustomTo(dubaiLocalValue(new Date()));
  }, [range, customFrom, customTo]);

  const customValid = Boolean(customFrom && customTo && customFrom < customTo);

  function applyCustomRange() {
    if (!customValid) return;
    setAppliedFrom(customFrom);
    setAppliedTo(customTo);
  }

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    } else {
      setSortKey(key);
      setSortDir(key === 'name' ? 'asc' : 'desc');
    }
  }

  const sortedAgents = useMemo(() => {
    if (!agents || !sortKey) return agents;
    const rows = [...agents];
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const cmp = typeof av === 'string' || typeof bv === 'string'
        ? String(av || '').localeCompare(String(bv || ''))
        : (av || 0) - (bv || 0);
      if (cmp === 0) return a.name.localeCompare(b.name);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [agents, sortKey, sortDir]);

  // Tracks the last range/window fetched so a manual refresh (refreshTick)
  // doesn't blank the table like an actual range change does.
  const rangeKeyRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const rangeKey = range + '|' + appliedFrom + '|' + appliedTo;
    const isNewRange = rangeKeyRef.current !== rangeKey;
    rangeKeyRef.current = rangeKey;
    const force = forceRef.current;
    forceRef.current = false;

    async function load(isForced) {
      setLoading(true);
      try {
        const qs = (range === 'custom'
          ? 'from=' + encodeURIComponent(appliedFrom) + '&to=' + encodeURIComponent(appliedTo)
          : 'range=' + encodeURIComponent(range)) + (isForced ? '&force=1' : '');
        const r = await fetch('/api/leadflow?' + qs);
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error || 'Request failed: ' + r.status);
        if (cancelled) return;
        setAgents(d.agents || []);
        setUpdatedAt(d.updatedAt || null);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (isNewRange) setAgents(null);
    load(force);
    const id = setInterval(() => load(false), POLL);
    return () => { cancelled = true; clearInterval(id); };
  }, [range, appliedFrom, appliedTo, refreshTick]);

  const lastUpdated = updatedAt
    ? new Date(updatedAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit' })
    : '—';

  return h('div', null,
    h('header', null,
      h('div', null,
        h('h1', null, 'Lead Flow Dashboard'),
        h('div', { className: 'sub' }, 'K Estates · Sales Agents'),
      ),
      h('div', { className: 'meta' },
        h('div', { className: 'icon-btns' },
          h(ThemeToggle, { theme, setTheme }),
          h('button', {
            type: 'button',
            className: 'info-btn',
            'data-tooltip': 'How columns are counted',
            'aria-label': 'How columns are counted',
            onClick: () => setShowColumnInfo(true),
          }, 'ⓘ'),
        ),
        h('div', { className: 'status' },
          h('button', {
            type: 'button',
            className: 'refresh-btn',
            'data-tooltip': 'Refresh this table',
            'aria-label': 'Refresh this table',
            onClick: () => { forceRef.current = true; setRefreshTick(t => t + 1); },
          }, '⟳'),
          `Updated ${lastUpdated} · `,
          loading && h('span', { className: 'status-loading' }, 'Loading… · '),
          h('select', {
            className: 'range',
            value: range,
            onChange: e => setRange(e.target.value),
          }, RANGE_OPTIONS.map(o => h('option', { key: o.value, value: o.value }, o.label))),
        ),
        range === 'custom' && h('div', { className: 'custom-range' },
          h('label', { className: 'cr-label' }, 'From'),
          h('input', {
            type: 'datetime-local',
            className: 'cr-input',
            value: customFrom,
            max: customTo || undefined,
            onChange: e => setCustomFrom(e.target.value),
          }),
          h('label', { className: 'cr-label' }, 'To'),
          h('input', {
            type: 'datetime-local',
            className: 'cr-input',
            value: customTo,
            min: customFrom || undefined,
            onChange: e => setCustomTo(e.target.value),
          }),
          h('button', {
            type: 'button',
            className: 'cr-apply',
            disabled: !customValid,
            onClick: applyCustomRange,
          }, 'Apply'),
          !customValid && h('span', { className: 'cr-hint' }, 'From must be before To'),
        ),
      ),
    ),
    error && h('div', { className: 'error' }, 'Failed to load data: ' + error),
    !error && h('div', { className: 'table-wrap' },
      h('table', null,
        h('thead', null,
          h('tr', null,
            h('th', null, '#'),
            h(SortableHeader, { column: { key: 'name', label: 'Agent' }, sortKey, sortDir, onSort: handleSort, numeric: false }),
            COLUMNS.map(col => h(SortableHeader, { key: col.label, column: col, sortKey, sortDir, onSort: handleSort })),
          ),
        ),
        agents === null
          ? h(SkeletonBody, null)
          : h('tbody', null,
              sortedAgents.map((agent, i) => h('tr', { key: agent.id },
                h('td', { className: 'rank' }, i + 1),
                h('td', { className: 'name' }, agent.name),
                COLUMNS.map(col => {
                  const val = col.key !== null ? agent[col.key] : null;
                  return h('td', {
                    className: val === null ? 'pending' : 'num' + (val > 0 ? ' live' : ''),
                    key: col.label,
                  }, val === null ? '—' : val);
                }),
              )),
            ),
        agents !== null && h('tfoot', null,
          h('tr', null,
            h('td', null),
            h('td', { className: 'tlabel' }, 'Team Total'),
            COLUMNS.map(col => {
              const val = agents.reduce((s, a) => s + a[col.key], 0);
              return h('td', {
                className: 'num' + (val > 0 ? ' live' : ''),
                key: col.label,
              }, val);
            }),
          ),
        ),
      ),
    ),
    !error && agents !== null && agents.length === 0 && h('div', { className: 'empty' }, 'No active agents found.'),
    h(StageCountsTable, null),
    showColumnInfo && h(ColumnInfoModal, { onClose: () => setShowColumnInfo(false) }),
  );
}

createRoot(document.getElementById('app')).render(h(App, null));
