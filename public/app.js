const { createElement: h, useState, useEffect, useMemo } = React;
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
    title: current.label + ' (click to change)',
    'aria-label': current.label,
    onClick: cycle,
  }, THEME_ICONS[current.value]);
}

// All data columns except Agent. `key` is the field on each agent row used
// for sorting; columns without a key are placeholders awaiting their metric
// and become sortable once that key exists.
const COLUMNS = [
  { key: 'freshPrimary', label: 'Fresh Leads Received – Primary' },
  { key: 'freshSecondary', label: 'Fresh Leads Received – Secondary' },
  { key: 'reshuffled', label: 'New Reshuffled Leads Assigned' },
  { key: 'contacted', label: 'Leads Contacted' },
  { key: 'noAnswer', label: 'Leads No Answer' },
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

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const qs = range === 'custom'
          ? 'from=' + encodeURIComponent(appliedFrom) + '&to=' + encodeURIComponent(appliedTo)
          : 'range=' + encodeURIComponent(range);
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

    setAgents(null);
    load();
    const id = setInterval(load, POLL);
    return () => { cancelled = true; clearInterval(id); };
  }, [range, appliedFrom, appliedTo]);

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
        h(ThemeToggle, { theme, setTheme }),
        h('div', { className: 'status' },
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
  );
}

createRoot(document.getElementById('app')).render(h(App, null));
