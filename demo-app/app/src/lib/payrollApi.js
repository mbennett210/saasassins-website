// Client adapter for the payroll domain (wave W2-L). Real backend (/api/payroll/*) when
// Supabase auth is configured; an auto-engaged localStorage STUB in local/demo mode so the
// Payroll screens work with no backend. The stub runs the SAME pure computePayRun over the
// stub time ledger (timeApi's STUB_KEY), the stub OT approvals (OT_STUB_KEY), the store blob
// (window.__ppGetState) and a payroll-runs stub (RUNS_STUB_KEY) — so a demo preview / close
// prices identically to production. The stub is DEAD in production builds exactly like the
// other stubs (demoBackendsEngaged() is false there → BACKEND is set → the stub is never called).
import { authHeaders } from './authHeader';
import { demoBackendsEngaged } from './demoMode';
import * as timeApi from './timeApi';
import * as driveApi from './driveApi';
import { entryFromRow } from './otLedger';
import { computePayRun } from './payRun';
import { drivePayEnabled } from './driveTime';
import { payPeriodRange, payWeekKeyOf, payDateConfigOf, payWeekStartDayOf } from './payroll';
import { addDaysKey, startOfDayKey, DEFAULT_ORG_TIMEZONE } from './dates';

const STUB = demoBackendsEngaged();
const BACKEND = STUB
  ? null
  : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isPayrollStub() { return !BACKEND; }

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON / empty */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status; err.code = json?.code || null; err.payload = json;
    throw err;
  }
  return json;
}

// ── public adapter ────────────────────────────────────────────────────────────
// The closed runs (no file/paid_weeks), newest period first.
export async function runs() {
  if (BACKEND) return (await api('/payroll/runs')).runs || [];
  return stubRuns().sort((a, b) => String(b.period_key).localeCompare(String(a.period_key)));
}
// One closed run, full (the CSV source). null when the period has no run.
export async function run(periodKey) {
  if (BACKEND) return (await api(`/payroll/run?periodKey=${encodeURIComponent(periodKey)}`)).run || null;
  return stubRuns().find((r) => r.period_key === periodKey) || null;
}
// The pay-run preview at an offset: a closed period returns { period, closed }; an open one
// returns the priced run + { closable, closeBlockers, asOf, prev }.
export async function preview(offset = 0) {
  if (BACKEND) return api(`/payroll/preview${offset ? `?offset=${offset}` : ''}`);
  return stubPreview(offset);
}
// Close a period: { periodKey, asOf } → { run } or a coded refusal (409 stale / period-order /
// period-closed / not-ended / pending-blocks-close). Throws err.code on a refusal, like the API.
export async function close({ periodKey, asOf } = {}) {
  if (BACKEND) return api('/payroll/close', { method: 'POST', body: { periodKey, asOf } });
  return stubClose({ periodKey, asOf });
}

// ── demo stub (local mode only) ─────────────────────────────────────────────────
const ppGetState = () => { try { return (typeof window !== 'undefined' && typeof window.__ppGetState === 'function') ? window.__ppGetState() : null; } catch { return null; } };
const RUNS_KEY = timeApi.RUNS_STUB_KEY;
const OT_KEY = timeApi.OT_STUB_KEY;
function stubRuns() {
  try { const r = JSON.parse(localStorage.getItem(RUNS_KEY)); return Array.isArray(r) ? r : (Array.isArray(r?.runs) ? r.runs : []); } catch { return []; }
}
function saveRuns(list) { try { localStorage.setItem(RUNS_KEY, JSON.stringify(list)); } catch { /* quota */ } }
function stubOt() { try { const r = JSON.parse(localStorage.getItem(OT_KEY)); return Array.isArray(r) ? r : (Array.isArray(r?.approvals) ? r.approvals : []); } catch { return []; } }
function stubEntries() { const e = timeApi._stubEntries(); return Array.isArray(e) ? e : []; }
const sortRuns = (list) => list.slice().sort((a, b) => String(a.period_key).localeCompare(String(b.period_key)));

function stubConfig(state) {
  return {
    tz: state?.company?.timezone || DEFAULT_ORG_TIMEZONE,
    cadence: state?.opsSettings?.payPeriodCadence || 'biweekly',
    // PAY-19, through lib/payroll's ONE reader of the workweek start, exactly as payConfigOf does.
    weekStartDay: payWeekStartDayOf(state?.opsSettings),
    otMultiplier: Number.isFinite(state?.opsSettings?.otMultiplier) ? state.opsSettings.otMultiplier : 1.5,
    pendingPolicy: state?.opsSettings?.payrollPendingPolicy === 'block' ? 'block' : 'rollForward',
    // PAY-6, read through lib/driveTime's ONE reader, exactly as api/_lib/payroll/compute does.
    payDriveTime: drivePayEnabled(state?.opsSettings || {}),
    // PAY-2, through lib/payroll's ONE reader of the payday field names, as payConfigOf does.
    payDate: payDateConfigOf(state?.opsSettings),
  };
}

// The SAME arrears detection as api/_lib/payroll/ledger.changedWeeksSinceLatestClose, over the
// localStorage ledger: weeks changed in closed territory since the latest close (§6.2).
function changedWeeks({ firstRun, latestRun, entries, otApprovals, tz, weekStartDay }) {
  const set = new Set();
  if (!firstRun || !latestRun || !latestRun.closed_at) return set;
  const threshold = Date.parse(latestRun.closed_at) - 3600e3;
  const terrFrom = Date.parse(firstRun.from_iso); const terrTo = Date.parse(latestRun.to_iso);
  for (const e of entries) {
    const ci = Date.parse(e.clock_in_at); const up = Date.parse(e.updated_at);
    if (Number.isFinite(ci) && ci >= terrFrom && ci <= terrTo && Number.isFinite(up) && up > threshold) set.add(`${e.user_id}|${payWeekKeyOf(e.clock_in_at, weekStartDay, tz)}`);
  }
  for (const a of otApprovals) {
    const up = Date.parse(a.updatedAt); const weekEnd = addDaysKey(a.weekKey, 6);
    if (Number.isFinite(up) && up > threshold && a.weekKey <= latestRun.to_key && weekEnd >= firstRun.from_key) set.add(`${a.userId}|${a.weekKey}`);
  }
  return set;
}

// Gather the inputs + price ONE period, exactly as api/_lib/payroll/compute.computeRunForPeriod
// does, but from localStorage.
async function gather(period, state, now) {
  const { tz, weekStartDay, otMultiplier, payDriveTime, payDate } = stubConfig(state);
  const users = Array.isArray(state?.users) ? state.users : [];
  const lines = Array.isArray(state?.payrollLines) ? state.payrollLines : [];
  const clientsById = new Map((Array.isArray(state?.clients) ? state.clients : []).map((c) => [c.id, c]));
  const allEntries = stubEntries();
  const otApprovals = stubOt();
  const runsList = sortRuns(stubRuns());
  const firstRun = runsList[0] || null; const latestRun = runsList[runsList.length - 1] || null;
  const arrearsWeeks = changedWeeks({ firstRun, latestRun, entries: allEntries, otApprovals, tz, weekStartDay });

  const firstWeek = payWeekKeyOf(period.fromKey, weekStartDay, tz);
  let earliestWeek = firstWeek;
  for (const uw of arrearsWeeks) { const w = uw.slice(uw.indexOf('|') + 1); if (w < earliestWeek) earliestWeek = w; }
  const lastWeek = payWeekKeyOf(period.toKey, weekStartDay, tz);
  const fromMs = startOfDayKey(earliestWeek, tz).getTime();
  const toMs = startOfDayKey(addDaysKey(lastWeek, 7), tz).getTime() - 1;
  const windowEntries = allEntries.filter((e) => { const t = Date.parse(e.clock_in_at); return Number.isFinite(t) && t >= fromMs && t <= toMs; });

  // PAY-6: with drive pay OFF the read is not made — computePayRun drops every leg anyway.
  let driveSegments = [];
  if (payDriveTime) {
    try {
      const drive = await driveApi.report({ fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString(), filters: {}, payroll: true, config: state?.opsSettings, sites: state?.sites });
      driveSegments = Array.isArray(drive?.rows) ? drive.rows : [];
    } catch { /* labor-only if the demo drive stub is unavailable */ }
  }

  const runResult = computePayRun({
    period, tz, weekStartDay, entries: windowEntries.map(entryFromRow), driveSegments, otApprovals,
    runs: runsList, arrearsWeeks, users, lines, otMultiplier, payDriveTime, payDate, clientsById,
  });
  return { run: runResult, runsList, firstRun, latestRun, asOf: now.toISOString(), tz };
}

function stubPreview(offset) {
  const state = ppGetState() || {};
  const { tz, cadence, weekStartDay, pendingPolicy } = stubConfig(state);
  const now = new Date();
  // PAY-19: the pay-period calendar follows the ORG's workweek start, not a hardcoded Sunday.
  const period = payPeriodRange(cadence, offset, now, tz, weekStartDay);
  const closed = sortRuns(stubRuns()).find((r) => r.period_key === period.fromKey);
  if (closed) return Promise.resolve({ period, closed });
  return gather(period, state, now).then(({ run, latestRun }) => {
    const expectedKey = latestRun && latestRun.to_key ? addDaysKey(latestRun.to_key, 1) : payPeriodRange(cadence, -1, now, tz, weekStartDay).fromKey;
    const ended = Date.parse(period.toIso) < now.getTime();
    const rf = run.rolledForward;
    const blocks = pendingPolicy === 'block' && (rf.pendingCount > 0 || rf.openCount > 0 || rf.otHeldMinutes > 0);
    const closeBlockers = [];
    if (!ended) closeBlockers.push('not-ended');
    if (period.fromKey !== expectedKey) closeBlockers.push({ code: 'period-order', expected: expectedKey });
    if (blocks) closeBlockers.push({ code: 'pending-blocks-close', counts: rf });
    const prev = latestRun ? { periodKey: latestRun.period_key, label: latestRun.file?.label || null, rows: (latestRun.file?.rows || []).map((r) => ({ userName: r.userName, gross: r.gross })) } : null;
    return { ...run, closable: closeBlockers.length === 0, closeBlockers, asOf: run ? new Date().toISOString() : null, prev };
  });
}

function refusal(code, extra = {}) { const e = new Error(code); e.status = 409; e.code = code; Object.assign(e, extra); return e; }

async function stubClose({ periodKey }) {
  const state = ppGetState() || {};
  const { tz, cadence, weekStartDay, pendingPolicy } = stubConfig(state);
  const closedAt = new Date();
  const period = payPeriodRange(cadence, 0, periodKey, tz, weekStartDay);
  if (period.fromKey !== periodKey) { const e = new Error('invalid-period'); e.status = 400; e.code = 'invalid-period'; throw e; }
  const runsList = sortRuns(stubRuns());
  const latestRun = runsList[runsList.length - 1] || null;
  if (Date.parse(period.toIso) >= closedAt.getTime()) throw refusal('not-ended');
  if (runsList.some((r) => r.period_key === periodKey)) throw refusal('period-closed');
  const expectedKey = latestRun && latestRun.to_key ? addDaysKey(latestRun.to_key, 1) : payPeriodRange(cadence, -1, closedAt, tz, weekStartDay).fromKey;
  if (periodKey !== expectedKey) throw refusal('period-order', { expected: expectedKey });
  const { run } = await gather(period, state, closedAt);
  const rf = run.rolledForward;
  if (pendingPolicy === 'block' && (rf.pendingCount > 0 || rf.openCount > 0 || rf.otHeldMinutes > 0)) throw refusal('pending-blocks-close', { counts: rf });
  const me = (state.users || []).find((u) => u.id === state.currentUserId) || null;
  const runRow = {
    id: `run_${period.fromKey}`, organization_id: null, period_key: period.fromKey, cadence,
    from_key: period.fromKey, to_key: period.toKey, from_iso: period.fromIso, to_iso: period.toIso, status: 'closed',
    closed_at: closedAt.toISOString(), closed_by: me?.id || null, closed_by_name: me?.name || null,
    pending_policy: pendingPolicy, rolled_forward: rf, paid_weeks: run.paidWeeksOut, held_ot: run.heldOtOut, file: run.file,
  };
  saveRuns([...stubRuns(), runRow]);
  return { run: runRow };
}
