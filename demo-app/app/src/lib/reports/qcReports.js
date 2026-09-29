// Pure QC report aggregations (node-safe: no imports, no browser globals) — the
// inspections-per-site and checklists-per-site rollups behind Reports. The SAME
// functions run server-side over every record in the window (api/qc reports/*, a
// complete paged read) and in the demo stub (lib/qcApi.js), so the two can't disagree.
// The server has no live store, so it tallies without Manager scoping and labels from
// the denormalized names; scopeSiteRows() then applies Manager/Customer + live names.

const ms = (iso) => { const t = new Date(iso).getTime(); return Number.isFinite(t) ? t : NaN; };
const inWin = (t, from, to) => Number.isFinite(t) && t >= from && t <= to;

// One row per (site, customer): a site that moved to another customer mid-window must
// not pool the two accounts' records under whichever customer wrote first — the Manager /
// Customer scope is applied per row afterwards, so each row must belong to ONE account.
const siteClientKey = (r) => `${r.site_id || '-'}|${r.client_id || '-'}|${r.site_id || r.client_id ? '' : r.id}`;

// Resolve a stable display name for a QC record's site/account: prefer the live
// store (clients/sites), fall back to the denormalized name on the record.
function labelFor(r, clientsById, sitesById) {
  return (r.client_id && clientsById.get(r.client_id)?.name)
    || (r.site_id && sitesById.get(r.site_id)?.name)
    || r.client_name || r.site_name || '—';
}

// Group SUBMITTED inspections by site over [fromMs,toMs].
//   inspections : qcApi records ({ site_id, client_id, client_name, site_name,
//                 inspector_name, overall_score, result, status, performed_at })
//   clientsById : Map clientId -> client (supervisor scoping + name)
//   sitesById   : Map siteId  -> site  (name fallback)
//   managerId   : restrict to accounts this manager supervises (null = all)
//   result      : 'pass' | 'fail' | null (all)
export function aggregateInspectionsPerSite({
  inspections = [], clientsById = new Map(), sitesById = new Map(),
  fromMs = -Infinity, toMs = Infinity, managerId = null, clientId = null, result = null,
} = {}) {
  const map = new Map();
  for (const r of inspections) {
    if (!r || r.status === 'draft') continue;                 // only submitted count
    if (!inWin(ms(r.performed_at), fromMs, toMs)) continue;
    if (result && r.result !== result) continue;
    if (clientId && r.client_id !== clientId) continue;       // one customer
    const client = r.client_id ? clientsById.get(r.client_id) : null;
    if (managerId && (!client || client.supervisorId !== managerId)) continue;
    const key = siteClientKey(r);
    let acc = map.get(key);
    if (!acc) {
      acc = {
        key, siteId: r.site_id || null, clientId: r.client_id || null,
        name: labelFor(r, clientsById, sitesById),
        count: 0, passCount: 0, failCount: 0, scoreSum: 0, scoreN: 0, lastAt: null,
      };
      map.set(key, acc);
    }
    acc.count += 1;
    if (r.result === 'pass') acc.passCount += 1;
    else if (r.result === 'fail') acc.failCount += 1;
    if (Number.isFinite(r.overall_score)) { acc.scoreSum += r.overall_score; acc.scoreN += 1; }
    const t = ms(r.performed_at);
    if (Number.isFinite(t) && (acc.lastAt == null || t > acc.lastAt)) acc.lastAt = t;
  }
  return [...map.values()]
    .map((a) => ({ ...a, avgScore: a.scoreN ? Math.round(a.scoreSum / a.scoreN) : null }))
    .sort((a, b) => b.failCount - a.failCount || b.count - a.count || a.name.localeCompare(b.name));
}

// Scope per-site rows (from either aggregator) to a Manager's book and/or one Customer,
// and relabel each from the live store (a site/customer renamed since the records were
// written reads by its current name). Rows keep their order.
//   managerId : only accounts this manager supervises (null = all)
//   clientId  : one customer (null = all)
export function scopeSiteRows(rows = [], { clientsById = new Map(), sitesById = new Map(), managerId = null, clientId = null } = {}) {
  const out = [];
  for (const row of rows || []) {
    if (!row) continue;
    if (clientId && row.clientId !== clientId) continue;
    const client = row.clientId ? clientsById.get(row.clientId) : null;
    if (managerId && (!client || client.supervisorId !== managerId)) continue;
    const name = client?.name || (row.siteId && sitesById.get(row.siteId)?.name) || row.name || '—';
    out.push(name === row.name ? row : { ...row, name });
  }
  return out;
}

// Group completed checklists by site over [fromMs,toMs].
//   checklists : qcApi records ({ site_id, client_id, completed_count, total_count,
//                completed_by_user_id, performed_at })
export function aggregateChecklistsPerSite({
  checklists = [], clientsById = new Map(), sitesById = new Map(),
  fromMs = -Infinity, toMs = Infinity, managerId = null, clientId = null,
} = {}) {
  const map = new Map();
  for (const r of checklists) {
    if (!r) continue;
    if (!inWin(ms(r.performed_at), fromMs, toMs)) continue;
    if (clientId && r.client_id !== clientId) continue;       // one customer
    const client = r.client_id ? clientsById.get(r.client_id) : null;
    if (managerId && (!client || client.supervisorId !== managerId)) continue;
    const key = siteClientKey(r);
    let acc = map.get(key);
    if (!acc) {
      acc = {
        key, siteId: r.site_id || null, clientId: r.client_id || null,
        name: labelFor(r, clientsById, sitesById),
        count: 0, fullCount: 0, itemsDone: 0, itemsTotal: 0, lastAt: null,
      };
      map.set(key, acc);
    }
    acc.count += 1;
    const done = r.completed_count || 0;
    const total = r.total_count || 0;
    acc.itemsDone += done; acc.itemsTotal += total;
    if (total > 0 && done >= total) acc.fullCount += 1;
    const t = ms(r.performed_at);
    if (Number.isFinite(t) && (acc.lastAt == null || t > acc.lastAt)) acc.lastAt = t;
  }
  return [...map.values()]
    .map((a) => ({ ...a, completionPct: a.itemsTotal ? Math.round((a.itemsDone / a.itemsTotal) * 100) : null }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}
