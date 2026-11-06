// Pure, dependency-free decision helpers for the demo-sandbox bootstrap. The
// component that touches localStorage and builds the real seed data lives in
// lib/demoBootstrap.js; the logic that decides WHEN the seeded time-ledger has
// gone stale and WHICH stub keys are missing lives here so it stays unit-testable
// headlessly (the same split as opsAlerts.js vs OpsAlertScheduler.jsx).
// Node-ESM-safe: no imports, no browser globals.

// A seeded time-ledger's demo story rows are dated to first load and never move on
// their own. Payroll reads a FIXED biweekly pay-period window and Variance reads
// rolling day windows, so once the newest story row is older than this the current
// pay period shows 0 hours ($0.00 payroll) and "last night" variance goes empty.
// 3 days comfortably exceeds the age of the freshest story rows (day 0 open punch +
// day -1 "last night"), so a same-session reload never triggers a rebuild.
export const DEMO_LEDGER_STALE_MS = 3 * 24 * 60 * 60 * 1000;

// The seeded demo story rows all carry synthetic `te_demo_*` ids (data/demoTimeLedger).
// A punch the client created while exploring the sandbox carries a different id, so
// this predicate is what lets a rebuild replace the story while preserving their work.
const isStoryRow = (e) => !!e && typeof e.id === 'string' && e.id.startsWith('te_demo_');

// Decide the next time-ledger entry list. `currentEntries` is the parsed
// `{ entries }.entries` from the stub (may be null/undefined); `freshStory` is a
// newly-built demo story (te_demo_* rows dated near now). Returns
// { changed, entries }: when the ledger is empty or its newest story row is older
// than `staleMs`, the story is replaced with `freshStory` and any client-created
// punch (non te_demo_* id) is kept; otherwise the input is returned unchanged so a
// within-session reload preserves the client's approvals/clock-ins. `now`/`staleMs`
// are injected so the clock is controllable (and the unit test is deterministic).
// `placedElsewhere(row)` names story rows that are re-placed on their own, shorter clock
// (the manager's day, below): they are left out of the age test, or a day re-placed two
// hours ago would keep a week-old story looking fresh for ever.
export function refreshLedgerEntries(currentEntries, freshStory, now = Date.now(), staleMs = DEMO_LEDGER_STALE_MS, placedElsewhere = () => false) {
  const entries = Array.isArray(currentEntries) ? currentEntries : [];
  const clientRows = entries.filter((e) => !isStoryRow(e));
  const storyRows = entries.filter((e) => isStoryRow(e) && !placedElsewhere(e));
  const newest = storyRows.reduce((max, e) => {
    const t = new Date(e && e.clock_in_at).getTime();
    return Number.isFinite(t) && t > max ? t : max;
  }, 0);
  const stale = storyRows.length === 0 || (now - newest) > staleMs;
  if (!stale) return { changed: false, entries };
  return { changed: true, entries: [...(Array.isArray(freshStory) ? freshStory : []), ...clientRows] };
}

// Of `allKeys`, return those a store does NOT already have. `has(key)` is injected
// (`localStorage.getItem(key) != null` in the app; a Set lookup in the test) so the
// backfill only writes stubs an older seed never wrote and never clobbers a present
// one (which may hold the client's own QC edits).
export function missingStubKeys(allKeys, has) {
  const list = Array.isArray(allKeys) ? allKeys : [];
  return list.filter((k) => !has(k));
}

// ── The manager's day (data/demoManagerDay.js) ───────────────────────────────────────────────
// Today's visits, their punches and saves, and the customer's requests are placed around the
// moment the bootstrap built them. A day placed at 9 AM read at 4 PM would show the 9:48 "late"
// visit as missed and the 12:30 "upcoming" one as missed too, so the day is placed again once it
// is MANAGER_DAY_STALE_MS old, or from yesterday. Two hours: a demo walked through in one
// sitting keeps every row the viewer touched, and one opened later in the day reads true.
export const MANAGER_DAY_STALE_MS = 2 * 60 * 60 * 1000;

// `anchor` is what the bootstrap stored the last time it placed the day ({ at: ms, day: key });
// `todayKey` the org day of `now`. A clock that went backwards also re-places.
export function managerDayStale(anchor, now, todayKey, staleMs = MANAGER_DAY_STALE_MS) {
  if (!anchor || typeof anchor !== 'object' || !Number.isFinite(anchor.at)) return true;
  if (anchor.day !== todayKey) return true;
  return now - anchor.at > staleMs || now < anchor.at - 60 * 1000;
}

const idOf = (r) => (r && typeof r.id === 'string' ? r.id : null);

// Every row `owns` claims goes; the fresh rows go in. The viewer's own rows are untouched.
export function replaceOwned(rows, fresh, owns) {
  const kept = (Array.isArray(rows) ? rows : []).filter((r) => !owns(r));
  return [...kept, ...(Array.isArray(fresh) ? fresh : [])];
}

// The fresh rows whose id the list does not have yet are appended; nothing present changes.
export function addMissing(rows, fresh) {
  const list = Array.isArray(rows) ? rows : [];
  const have = new Set(list.map(idOf));
  return [...list, ...(Array.isArray(fresh) ? fresh : []).filter((r) => !have.has(idOf(r)))];
}

// The store's half: the plan's jobs and call-out replace the ones it placed before (by id).
export function placeManagerDayInState(state, day, { jobIds = [], timeOffIds = [] } = {}) {
  const s = state || {};
  const jobSet = new Set(jobIds);
  const offSet = new Set(timeOffIds);
  return {
    ...s,
    jobs: replaceOwned(s.jobs, day?.jobs, (j) => jobSet.has(idOf(j))),
    timeOff: replaceOwned(s.timeOff, day?.timeOff, (t) => offSet.has(idOf(t))),
  };
}

// A row MOVED with the clock: every `…_at` timestamp on it, and on each message in its thread,
// shifted by `deltaMs`. A request keeps its replies, status and assignee (the viewer's work) and
// stays the same age relative to now.
const shiftAt = (v, d) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t + d).toISOString() : v;
};
export function shiftTimes(row, deltaMs) {
  if (!row || !deltaMs) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = k.endsWith('_at') ? shiftAt(v, deltaMs) : v;
  if (Array.isArray(row.messages)) out.messages = row.messages.map((m) => shiftTimes(m, deltaMs));
  return out;
}
// The plan's requests: a present one moves by `deltaMs` (the time since the day was last
// placed), a missing one is added as fresh. Nothing else changes.
export function moveOwnedRows(rows, fresh, deltaMs) {
  const list = Array.isArray(rows) ? rows : [];
  const mine = new Set((Array.isArray(fresh) ? fresh : []).map(idOf));
  const moved = list.map((r) => (mine.has(idOf(r)) ? shiftTimes(r, deltaMs) : r));
  return addMissing(moved, fresh);
}

// The seeded book's CLOSED tickets (data/demoStubs seededClosedTickets, built at the placing's
// moment): each present one still closed is MOVED so its resolution lands where a fresh seed would
// put it — its open-to-closed span and its thread move with it, so its time to resolve is the
// story's — and the customer hub's figure never ages out of its 30-day window. One the viewer has
// reopened (no longer resolved) is left as they left it; a missing one is not re-added (the stub's
// own backfill seeds it); nothing else is touched. Anchored to the fresh copy rather than moved
// by the time since the last placing, so a stub written fresh on this very load stays put.
export function replaceClosedRows(rows, fresh) {
  const list = Array.isArray(rows) ? rows : [];
  const byId = new Map((Array.isArray(fresh) ? fresh : []).map((r) => [idOf(r), r]));
  return list.map((r) => {
    const f = byId.get(idOf(r));
    if (!f || r.status !== 'resolved') return r;
    const d = Date.parse(f.resolved_at) - Date.parse(r.resolved_at);
    return Number.isFinite(d) ? shiftTimes(r, d) : r;
  });
}

// The supplies' half: the switches and requests are added where absent, and a plan request
// DELIVERED before this month (`monthStartMs`) is put back as fresh, so the building it puts over
// budget stays over budget in the month being read. A switch the viewer already turned on for the
// same building and catalog item (under its own id) is left alone — one switch per building and
// item, the database's own rule (migration 20261011100000). The day's own rows (`replaceIds`: the
// delivery step's "on the way" and "delivered today", data/demoManagerDay
// MANAGER_DAY_DAILY_SUPPLY_IDS) are REPLACED with the fresh copy on every placing, so they are
// always today's — like the day's jobs, a viewer's change to them lasts until the day is placed
// again.
export function placeManagerDaySupplies(db, fresh, monthStartMs, { replaceIds = [] } = {}) {
  const d = db && typeof db === 'object' ? db : {};
  const freshRequests = Array.isArray(fresh?.supplyRequests) ? fresh.supplyRequests : [];
  const byId = new Map(freshRequests.map((r) => [idOf(r), r]));
  const daily = new Set(Array.isArray(replaceIds) ? replaceIds : []);
  const requests = (Array.isArray(d.requests) ? d.requests : []).map((r) => {
    const f = byId.get(idOf(r));
    if (f && daily.has(idOf(r))) return f;
    if (!f || r.status !== 'completed') return r;
    const t = Date.parse(r.completedAt);
    return Number.isFinite(t) && t >= monthStartMs ? r : f;
  });
  const pair = (it) => `${it && it.clientId}|${it && it.catalogItemId}`;
  const on = new Set((Array.isArray(d.items) ? d.items : []).map(pair));
  return {
    ...d,
    items: addMissing(d.items, (Array.isArray(fresh?.supplyItems) ? fresh.supplyItems : []).filter((it) => !on.has(pair(it)))),
    requests: addMissing(requests, freshRequests),
  };
}

// Photos filed under a visit id that has since moved (`{ oldId: newId }`): re-filed, so a browser
// seeded before keeps its visit photos.
export function rekeyRefs(media, map) {
  const list = Array.isArray(media) ? media : [];
  let changed = false;
  const out = list.map((m) => {
    const to = m && map[m.ref_id];
    if (!to) return m;
    changed = true;
    return { ...m, ref_id: to };
  });
  return changed ? out : list;
}
