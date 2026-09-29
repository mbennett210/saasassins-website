// Pure inspection scoring + result vocabulary — shared by the server QC route
// (api/_lib/qc/store.js) and the demo stub (qcApi.js) so a score computed
// server-side and client-side can never disagree (the lib/geo / lib/variance
// pattern). Browser-dep-free, explicit imports only. See CLEANSPACE_SWEPT.md §5.6.

// The cap on an inspection HISTORY list: the Quality hub's list and a customer's own
// Inspections tab hold the newest this-many records THAT MATCH their filters (applied in
// the query, never to an org-wide slice) and say "showing the newest N" when there are
// more (UI_RULES §117 — a list may stay newest-N; anything that COUNTS reads a complete
// window instead). ONE number for the server read (api/_lib/qc/store.js listInspections)
// and the demo stub (qcApi.js), so both cap, and flag `truncated`, at the same row.
export const INSPECTION_LIST_LIMIT = 200;

// The result vocabulary (inspection_records.result's CHECK constraint).
export const INSPECTION_RESULTS = ['pass', 'fail', 'needs_follow_up'];

// What an inspection filter MEANS, for the demo stub; the server applies the same filters
// in its query (api/_lib/qc/store.js applyInspectionFilters) and the offline suite holds
// the two to one answer. Absent (null/undefined) = no constraint. A list keeps records
// whose field is one of its values, so an EMPTY list keeps nothing (SQL's IN ()), never
// everything. Date bounds are inclusive ISO instants on performed_at.
export function inspectionMatchesFilters(r, { fromIso, toIso, clientId, siteIds, inspectorIds, results, submittedOnly = false } = {}) {
  if (!r) return false;
  const t = Date.parse(r.performed_at);
  if (fromIso && !(t >= Date.parse(fromIso))) return false;
  if (toIso && !(t <= Date.parse(toIso))) return false;
  if (clientId && r.client_id !== clientId) return false;
  if (siteIds && !siteIds.includes(r.site_id)) return false;
  if (inspectorIds && !inspectorIds.includes(r.inspector_user_id)) return false;
  if (results && !results.includes(r.result)) return false;
  if (submittedOnly && r.status === 'draft') return false;
  return true;
}

// Newest first, ties by id — the order the server's list query asks for.
const performedMs = (r) => { const t = Date.parse(r.performed_at); return Number.isFinite(t) ? t : -Infinity; };
export function newestInspectionFirst(a, b) {
  const ta = performedMs(a);
  const tb = performedMs(b);
  if (ta !== tb) return tb > ta ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// The Quality hub's figures over a set of records: how many there are (drafts included,
// as the list holds them) plus the scored roll-up. The server tallies EVERY matching
// record with this (qc/store.js); the demo stub runs it over its local records. Sorted
// first so a tie on performed_at splits the trend's halves by id, whatever order the
// records arrived in (the server's pages come oldest-first, the stub's newest-first).
export function inspectionFigures(records) {
  const sorted = (records || []).slice().sort(newestInspectionFirst);
  return { total: sorted.length, ...summarizeInspections(sorted) };
}

// One export row: what the CSV writes (plus the id, which the paged read dedupes on, and
// the client/site ids its location label falls back to), with the template's name read
// out of the frozen snapshot (which can run to kilobytes). The server selects the same
// fields (qc/store.js INSPECTION_EXPORT_COLUMNS) so both answer one shape.
export function toInspectionExportRow(r) {
  return {
    id: r.id, performed_at: r.performed_at ?? null,
    client_id: r.client_id ?? null, site_id: r.site_id ?? null,
    client_name: r.client_name ?? null, site_name: r.site_name ?? null,
    template_name: r.template_snapshot?.name ?? null,
    overall_score: r.overall_score ?? null, result: r.result ?? null, inspector_name: r.inspector_name ?? null,
  };
}

// items: [{ rating, ... }]. scale: { type:'passfail'|'numeric', max?, passThreshold? }.
// 'na' / null / '' ratings are excluded from the denominator. passfail = % pass;
// numeric = average as a % of max. result = pass when score >= threshold (default 80).
export function scoreInspection(items, scale = {}) {
  const scored = (items || []).filter((it) => it.rating != null && it.rating !== '' && it.rating !== 'na');
  if (!scored.length) return { overallScore: null, result: 'needs_follow_up' };
  const threshold = Number.isFinite(scale.passThreshold) ? scale.passThreshold : 80;
  let pct;
  if (scale.type === 'numeric') {
    const max = Number.isFinite(scale.max) ? scale.max : 5;
    const avg = scored.reduce((s, it) => s + (Number(it.rating) || 0), 0) / scored.length;
    pct = max > 0 ? Math.round((avg / max) * 100) : 0;
  } else {
    const pass = scored.filter((it) => String(it.rating) === 'pass').length;
    pct = Math.round((pass / scored.length) * 100);
  }
  return { overallScore: pct, result: pct >= threshold ? 'pass' : 'fail' };
}

export function resultBadgeVariant(result) {
  if (result === 'pass') return 'green';
  if (result === 'fail') return 'red';
  if (result === 'needs_follow_up') return 'amber';
  return 'slate';
}

export function resultLabel(result) {
  if (result === 'pass') return 'Pass';
  if (result === 'fail') return 'Fail';
  if (result === 'needs_follow_up') return 'Needs follow-up';
  return '—';
}

// Roll a set of inspection records into an average score + a simple recent-vs-prior
// trend (delta of the newer half's avg minus the older half's). Records are sorted
// performed_at-desc; only submitted records with a numeric overall_score count toward
// the average. failCount tallies fail/needs_follow_up results. Shared by the account
// Operations tab and the Quality hub so both read the same math. Browser-dep-free.
export function summarizeInspections(records) {
  const list = records || [];
  const scored = list
    .filter((r) => r.status === 'submitted' && r.overall_score != null)
    .slice()
    .sort((a, b) => new Date(b.performed_at) - new Date(a.performed_at));
  const failCount = list.filter((r) => r.result === 'fail' || r.result === 'needs_follow_up').length;
  const count = scored.length;
  if (!count) return { count: 0, avgScore: null, recentAvg: null, priorAvg: null, delta: null, failCount };
  const avg = (arr) => (arr.length ? Math.round(arr.reduce((s, r) => s + Number(r.overall_score), 0) / arr.length) : null);
  const avgScore = avg(scored);
  let recentAvg = null; let priorAvg = null; let delta = null;
  if (count >= 2) {
    const half = Math.floor(count / 2);
    recentAvg = avg(scored.slice(0, count - half)); // newer half
    priorAvg = avg(scored.slice(count - half));      // older half
    if (recentAvg != null && priorAvg != null) delta = recentAvg - priorAvg;
  }
  return { count, avgScore, recentAvg, priorAvg, delta, failCount };
}

// ── Publishing a template ────────────────────────────────────────────────────
// How many items a template's schema holds, across every area.
export function countSchemaItems(schema) {
  return (schema?.areas || []).reduce((n, a) => n + (Array.isArray(a?.items) ? a.items.length : 0), 0);
}

// Why this template may NOT be published, or null. ONE rule, shared by the server store,
// the demo stub and the editor, so the three cannot drift.
//
// A CHECKLIST with ZERO items can never be complete: completion is
// `total_count > 0 && completed_count >= total_count` (lib/crewChecklist.isChecklistComplete),
// and an item-less checklist submits 0/0. Its holders would be nudged and then escalated on
// every clean for ever, and step 4's clock-out block would lock them out with nothing to
// tick. Inspection templates are left alone — they are scored, not ticked.
export const NO_ITEMS_MESSAGE = 'Add at least one item before publishing';
export function publishRefusal({ kind, schema } = {}) {
  if (kind === 'checklist' && countSchemaItems(schema) === 0) return NO_ITEMS_MESSAGE;
  return null;
}
