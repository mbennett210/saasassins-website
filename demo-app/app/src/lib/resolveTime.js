// TIME TO RESOLVE — how long a ticket takes from being opened to being closed. Matt's KPI (the
// Oct 6 call): "how long it takes from a ticket to be open to closed … on the average last 30 days,
// it takes us, you know, 17 minutes on average", and on the client hub "how long Clean Space takes
// to resolve your issues". Plan docs/plans/2026-10-11-oct-6-call-additions.md §4, D10–D12.
//
// ONE pure rule, shared, so no two surfaces can disagree: the customer hub's Home tile (api/hub
// `home` through lib/hubHome hubResolveTile, and its demo twin lib/hubDemo.js), the office's
// Reports → Time to resolve (api/qc `reports/resolve-time` and the demo stub in lib/qcApi.js
// resolveTimes) and scripts/test-resolve-time.mjs.
//
//   D10  A ticket's time to resolve is resolved_at − created_at (wall-clock, as Matt counts it:
//        opened 1:40 PM, closed 2:00 PM = 20 minutes). The figure is the MEAN (the median beside it
//        in the office's report) over the tickets whose status is resolved and whose resolved_at
//        falls in the window — the last RESOLVE_WINDOW_DAYS days unless a period is given. A
//        REOPENED ticket counts once, to its LATEST resolution: reopening clears resolved_at
//        (api/_lib/qc/store reopenProblem, updateProblem) and resolving again stamps it anew, so the
//        row itself carries the answer; a repeated row (two reads joined) is still one ticket.
//   D11  WHICH tickets is the caller's choice, never this rule's: the hub passes only the building's
//        requests from the hub (origin portal — what the customer can check against their own
//        Requests list), the office every ticket.
//   D12  "Met the deadline" = resolved at or before the ticket's deadline, which is the ONE deadline
//        rule (lib/workOrders computeDueAt: by type for a client's request, by urgency for an issue —
//        Matt's standards, WO-20 / WO-21), DERIVED from created_at as every other reader derives it.
//        The stored `due_at` is only the server's cache and may be missing or older than the rule,
//        so it is never read here.
//
// PURE and node-safe: the server imports it. The formatter's words are catalog lines
// (`resolveTime.dur.*`): a screen passes its reader's `t`; the default is English, which the hub
// uses (LANG-8: everything a customer reads stays English).
import { normalizeStatus, computeDueAt, WO_TYPES, DEFAULT_WO_TYPE } from './workOrders.js';
import { english } from '../i18n/core.js';

// Matt's "last 30 days".
export const RESOLVE_WINDOW_DAYS = 30;
// What every figure carries (the hub projects a part of it, lib/hubHome HUB_RESOLVE_FIELDS).
export const RESOLVE_STATS_FIELDS = Object.freeze(['count', 'meanMs', 'medianMs', 'onTime', 'withDeadline']);

const DAY_MS = 24 * 3600 * 1000;
const msOf = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

// The window as [fromMs, toMs], both ends included. An explicit `from` / `to` (ms or ISO — the
// report's period) wins; otherwise the last `days` days up to `now`.
export function resolveWindow({ now = Date.now(), days = RESOLVE_WINDOW_DAYS, from = null, to = null } = {}) {
  const toMs = msOf(to) ?? msOf(now) ?? Date.now();
  const span = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : RESOLVE_WINDOW_DAYS;
  const fromMs = msOf(from) ?? (toMs - span * DAY_MS);
  return { fromMs, toMs };
}

// One ticket's part in a figure: { key, ms, onTime } — or null when it does not count (not resolved,
// a time missing, resolved outside the window). A resolution stamped before its creation (a clock
// out of step) counts as no time at all, never a negative.
export function resolvedTicketTime(row, { fromMs, toMs }) {
  if (!row || normalizeStatus(row.status) !== 'resolved') return null;
  const created = msOf(row.created_at ?? row.createdAt);
  const resolved = msOf(row.resolved_at ?? row.resolvedAt);
  if (created == null || resolved == null) return null;
  if (resolved < fromMs || resolved > toMs) return null;
  const due = msOf(computeDueAt(new Date(created).toISOString(), { type: row.type, priority: row.priority, severity: row.severity }));
  return {
    key: row.id ?? null,
    ms: Math.max(0, resolved - created),
    onTime: due == null ? null : resolved <= due,
  };
}

// The figures over a set of counted parts.
function summarize(parts) {
  const times = parts.map((p) => p.ms).sort((a, b) => a - b);
  const n = times.length;
  const judged = parts.filter((p) => p.onTime !== null);
  let medianMs = null;
  if (n) medianMs = n % 2 ? times[(n - 1) / 2] : Math.round((times[n / 2 - 1] + times[n / 2]) / 2);
  return {
    count: n,
    meanMs: n ? Math.round(times.reduce((a, b) => a + b, 0) / n) : null,
    medianMs,
    onTime: judged.filter((p) => p.onTime).length,
    withDeadline: judged.length,
  };
}

// Every counted part of `rows`, each ticket once (a row without an id is its own ticket).
function countedParts(rows, opts) {
  const win = resolveWindow(opts);
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const part = resolvedTicketTime(row, win);
    if (!part) continue;
    if (part.key != null) {
      if (seen.has(part.key)) continue;
      seen.add(part.key);
    }
    out.push({ ...part, row });
  }
  return out;
}

// { count, meanMs, medianMs, onTime, withDeadline } over the tickets resolved in the window.
// `opts`: { now, days } (the last `days` days to now) or { from, to } (a period).
export function resolveStats(rows, opts = {}) {
  return summarize(countedParts(rows, opts));
}

// The office's report (D12): the company-wide figures, a row per ticket type (every type, in the
// vocabulary's order, so a type with none reads as none rather than going missing) and a row per
// customer that had a ticket resolved. A row with no type, or one this build does not know, is an
// issue — the work-order view model's own default (lib/workOrders toWorkOrder).
export function resolveReport(rows, opts = {}) {
  const parts = countedParts(rows, opts);
  const typeOf = (row) => (WO_TYPES.includes(row.type) ? row.type : DEFAULT_WO_TYPE);
  const byType = WO_TYPES.map((type) => ({ type, ...summarize(parts.filter((p) => typeOf(p.row) === type)) }));
  const groups = new Map();
  for (const p of parts) {
    const clientId = p.row.client_id ?? p.row.clientId ?? null;
    if (!clientId) continue;
    if (!groups.has(clientId)) groups.set(clientId, { name: p.row.client_name ?? p.row.clientName ?? null, parts: [] });
    groups.get(clientId).parts.push(p);
  }
  const byClient = [...groups.entries()]
    .map(([clientId, g]) => ({ clientId, clientName: g.name, ...summarize(g.parts) }))
    .sort((a, b) => String(a.clientName || a.clientId).localeCompare(String(b.clientName || b.clientId), undefined, { sensitivity: 'base' }));
  return { overall: summarize(parts), byType, byClient };
}

// A span as a person reads it: "Under 1 min", "22 min", "3 h", "3 h 10 min", "1 day", "1 day 4 h",
// "2 days". Under a day it is exact to the minute; from a day up, to the hour. `t(key, params)` is
// the reader's translator (a screen's useT); the default renders English. Nothing to say is a dash.
export function formatResolveDuration(ms, t = english) {
  const n = Number(ms);
  if (ms == null || ms === '' || !Number.isFinite(n) || n < 0) return '—';
  const mins = Math.round(n / 60000);
  if (mins < 1) return t('resolveTime.dur.underMinute');
  if (mins < 60) return t('resolveTime.dur.minutes', { count: mins });
  if (mins < 24 * 60) {
    const hours = Math.floor(mins / 60);
    const minutes = mins % 60;
    return minutes ? t('resolveTime.dur.hoursMinutes', { hours, minutes }) : t('resolveTime.dur.hours', { count: hours });
  }
  const totalHours = Math.round(mins / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours ? t('resolveTime.dur.daysHours', { count: days, hours }) : t('resolveTime.dur.days', { count: days });
}
