// Pure supplies math + request shaping — ZERO imports so node can unit-test it
// headlessly (the lib/money.js / lib/opsAlerts.js precedent). The reducer and the
// Supplies page both read from here so a request's estimated total is computed one
// way everywhere. Dollars, settled to cents PER REQUEST (round2), matching the
// invoice ledger convention — a request's lines snapshot name + unitPrice at submit,
// so a later catalog edit never rewrites what was requested.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Estimated cost of one request = Σ (qty × unitPrice) over its snapshot lines,
// settled to cents. Missing/garbage qty or price reads as 0.
export function supplyRequestTotal(request) {
  const lines = (request && request.lines) || [];
  return round2(lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0));
}

// Total item COUNT across a request's lines (Σ qty) — for "N items" glances.
export function supplyRequestItemCount(request) {
  const lines = (request && request.lines) || [];
  return lines.reduce((a, l) => a + (Number(l.qty) || 0), 0);
}

// A one-line label for a request row: "Glass cleaner ×4 +2 more". Empty when there
// are no lines. Used by the list cell and the completion notification body.
export function summarizeLines(lines) {
  const list = lines || [];
  if (!list.length) return '';
  const first = list[0];
  const head = `${first.name || 'Item'} ×${Number(first.qty) || 0}`;
  const more = list.length - 1;
  return more > 0 ? `${head} +${more} more` : head;
}

// Retention bounds for the COMPLETED tail (open requests are never dropped). Kept
// here as named constants so the reducer's write-point prune and the test agree.
export const SUPPLY_COMPLETED_MAX_AGE_MS = 90 * 86400000; // 90 days
export const SUPPLY_COMPLETED_CAP = 300;                  // newest N completed kept

// Prune the completed tail at the WRITE point (BUILD_INTEGRITY §5 — retention on an
// unbounded slice from day one). Keeps: every OPEN request (always), plus completed
// requests that are BOTH within the age window AND among the newest SUPPLY_COMPLETED_CAP
// by completedAt. Append-newest-last array in, same order out; returns the SAME
// reference when nothing is dropped so an upstream ref-equality gate can skip work.
export function pruneSupplyRequests(list, nowMs = Date.now()) {
  if (!Array.isArray(list) || list.length === 0) return list;
  const cutoff = nowMs - SUPPLY_COMPLETED_MAX_AGE_MS;
  const completed = list
    .filter((r) => r && r.status === 'completed')
    .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0));
  const keep = new Set();
  completed.forEach((r, i) => {
    const t = new Date(r.completedAt || 0).getTime();
    const fresh = Number.isNaN(t) ? true : t >= cutoff; // undated → keep, never drop on a guess
    if (fresh && i < SUPPLY_COMPLETED_CAP) keep.add(r);
  });
  let dropped = false;
  const out = list.filter((r) => {
    if (!r || r.status !== 'completed') return true;
    const k = keep.has(r);
    if (!k) dropped = true;
    return k;
  });
  return dropped ? out : list;
}
