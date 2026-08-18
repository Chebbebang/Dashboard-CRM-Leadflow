// Minimal Bitrix24 REST client shared by the lead-flow dashboard.
// Handles query-string encoding for batch commands, transient-error retries,
// batch fan-out (50 commands per call) and list pagination.

export function qs(obj) {
  const p = [];
  function walk(o, pre) {
    for (const [k, v] of Object.entries(o)) {
      const isAt = k[0] === '@';
      const ek = isAt ? '@' + encodeURIComponent(k.slice(1)) : encodeURIComponent(k);
      const key = pre ? pre + '[' + ek + ']' : ek;
      if (Array.isArray(v)) {
        if (v.length === 0) continue;
        // Bitrix's batch sub-request parser only accepts indexed array
        // brackets here — a comma-joined value (valid for direct JSON POST
        // bodies) silently matches nothing when parsed from a query string.
        v.forEach((x, i) => p.push(key + '[' + i + ']=' + encodeURIComponent(String(x))));
      } else if (v !== null && typeof v === 'object') {
        walk(v, key);
      } else {
        p.push(key + '=' + encodeURIComponent(String(v)));
      }
    }
  }
  walk(obj, '');
  return p.join('&');
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function createClient(webhook) {
  if (!webhook) throw new Error('createClient: webhook URL is required');
  const base = webhook.endsWith('/') ? webhook : webhook + '/';

  async function fetchRetry(method, body, tries = 3) {
    for (let i = 0; i < tries; i++) {
      try {
        const res = await fetch(base + method, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await res.json();
      } catch (e) {
        if (i === tries - 1) throw e;
        await sleep(1000 * (i + 1));
      }
    }
  }

  async function call(method, params = {}, tries = 5) {
    for (let i = 0; i < tries; i++) {
      const data = await fetchRetry(method, params);
      if (!data.error) return data;
      // The portal enforces a rolling request budget; back off and retry
      // rather than failing the whole dashboard request.
      if (data.error !== 'QUERY_LIMIT_EXCEEDED' || i === tries - 1) {
        throw new Error(`${method}: ${data.error} — ${data.error_description || ''}`.trim());
      }
      await sleep(1000 * (i + 1));
    }
  }

  // Runs up to 50 commands in one request, re-queueing any that errored.
  async function batch(cmdMap) {
    let pending = { ...cmdMap };
    const items = {};
    for (let attempt = 0; attempt < 5 && Object.keys(pending).length > 0; attempt++) {
      const data = await fetchRetry('batch', { cmd: pending, halt: 0 });
      const r = data.result || {};
      const raw = r.result || {};
      const errors = r.result_error || {};
      const next = {};
      for (const [k, v] of Object.entries(raw)) {
        if (errors[k]) { next[k] = pending[k]; continue; }
        items[k] = Array.isArray(v) ? v : (v?.items || []);
      }
      for (const k of Object.keys(pending)) {
        if (!(k in raw)) next[k] = pending[k];
      }
      pending = next;
      if (Object.keys(pending).length > 0 && attempt < 4) await sleep(1500 * (attempt + 1));
    }
    return items;
  }

  // Pages a *.list method to completion using batched offset requests.
  async function fetchAll(method, filter = {}, select = [], extra = {}) {
    const first = await call(method, { filter, select, ...extra, start: 0 });
    const total = first.total || 0;
    // Most *.list methods return `result` as an array; a few (e.g.
    // crm.stagehistory.list) wrap it as `{ items: [...] }`.
    const firstItems = Array.isArray(first.result) ? first.result : (first.result?.items || []);
    if (!total) return firstItems;
    const all = [...firstItems];
    const pageSize = 50;
    const numPages = Math.ceil(total / pageSize);
    const baseCmd = method + '?' + qs({ filter, select, ...extra });
    for (let page = 1; page < numPages; page += 50) {
      const cmd = {};
      const size = Math.min(50, numPages - page);
      for (let j = 0; j < size; j++) cmd['p' + (page + j)] = baseCmd + '&start=' + ((page + j) * pageSize);
      const items = await batch(cmd);
      for (const key of Object.keys(cmd)) {
        if (Array.isArray(items[key])) all.push(...items[key]);
      }
      if (page + 50 < numPages) await sleep(200);
    }
    return all;
  }

  // user.get paginates with `next` rather than a total, so it needs its own loop.
  async function fetchUsers(filter = {}) {
    const users = [];
    let start = 0;
    for (;;) {
      const r = await call('user.get', { filter, start });
      users.push(...(r.result || []));
      if (r.next === undefined || r.next === null) break;
      start = r.next;
    }
    return users;
  }

  return { call, batch, fetchAll, fetchUsers };
}
