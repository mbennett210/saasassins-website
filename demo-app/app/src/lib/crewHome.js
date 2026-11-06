// The Cleaner Hub's Home rules (Matt's "Cleaner Hub" design, 2026-10-13; plan
// docs/plans/2026-10-13-cleaner-hub.md, brief A). PURE and node-safe — no React, no store, no
// browser — so the Home, Today's Stops and the Clock screens answer the same questions the same
// way, and app/scripts/test-crew-home.mjs holds every branch.
//
//   currentStop()    the ONE clear action at the top of Home (Matt: "Clock In / Clock Out first and
//                    biggest")
//   stopRows()       Today's Stops, in the order a cleaner works them
//   isTonight()      "stops tonight" from 5 PM on the ORG's clock, never the phone's
//   geoPresence()    the live perimeter read, resolved exactly like the server's verdict
//   siteLine()       what a stop says about where the cleaner is
//   accountManager() who "Message AM" / "Call AM" reach, or why they can't
//   checklistProgress() the checklist's "x of y" — the stored submission, else the unsaved draft
//   clockOutPlan()   what Clock out does with a draft on the phone (save it first, or not)
//
// The clock-in window is lib/clockInWindow's and the verdict lib/geo's: this module only asks
// them, so a rule changed there changes here too.
import { clockInRefusal, clockInWindow } from './clockInWindow.js';
import { geofenceVerdict, punchSiteState, PUNCH_SITE } from './geo.js';
import { hourInZone } from './dates.js';
import { GATE } from './crewChecklist.js';
import { countChecklistSubmission } from './checklistCount.js';
import { draftItems, draftPhotoKeys } from './checklistDraft.js';

// The hero card's five kinds (the brief's rules 1–5).
export const HERO = Object.freeze({
  CLOCK_OUT: 'clockOut',  // an open punch anywhere: clock out of it
  CLOCK_IN: 'clockIn',    // a clean whose clock-in window is open
  NOT_YET: 'notYet',      // the next clean today, its window not open yet ("Opens at 4:00 PM")
  ALL_DONE: 'allDone',    // every clean today is behind them
  NONE: 'none',           // no cleans today (the next upcoming one, if any)
});

// A stop's state FOR THIS CLEANER. Their own punch decides: a co-worker clocked in at the same
// clean does not make it "in progress" for someone still on their way.
export const STOP = Object.freeze({ NOW: 'now', UPCOMING: 'upcoming', MISSED: 'missed', DONE: 'done' });

// "{n} stops tonight" from this hour of the org's day.
export const TONIGHT_FROM_HOUR = 17;

const ms = (v) => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : NaN; };
const startMs = (job) => { const t = ms(job?.startAt); return Number.isFinite(t) ? t : Infinity; };
const isOpen = (e) => !!e && !e.clock_out_at;

// This cleaner's punch on each clean: an open one beats a closed one, else the newest clock-in.
// (The same pick My Day made, so a re-opened clean reads by its open punch.)
export function punchByJob(entries) {
  const map = new Map();
  for (const e of entries || []) {
    if (!e || !e.job_id) continue;
    const ex = map.get(e.job_id);
    if (!ex || (isOpen(e) && !isOpen(ex)) || (isOpen(e) === isOpen(ex) && ms(e.clock_in_at) > ms(ex.clock_in_at))) map.set(e.job_id, e);
  }
  return map;
}

// The newest still-open punch, or null. PAY-13 refuses a second open punch, so there is normally
// one at most; the newest is the one they are working.
export function openPunch(entries) {
  let best = null;
  for (const e of entries || []) if (isOpen(e) && (!best || ms(e.clock_in_at) > ms(best.clock_in_at))) best = e;
  return best;
}

// One clean's state for this cleaner (`entry` = their punch on it, or null).
export function stopState(job, entry, now = Date.now(), graceMins) {
  if (isOpen(entry)) return STOP.NOW;
  if (entry && entry.clock_out_at) return STOP.DONE;
  if (job?.status === 'done') return STOP.DONE;
  if (clockInRefusal(job, now, { graceMins }) === 'late') return STOP.MISSED;
  if (job?.status === 'missed') return STOP.MISSED;
  return STOP.UPCOMING;
}

const live = (cleans) => (cleans || []).filter((j) => j && j.status !== 'cancelled');

// The hero card.
//   cleans    today's cleans for this cleaner (store/selectors selectTodayCleansForUser)
//   entries   their punches (lib/timeApi mine), offline punches included
//   upcoming  their cleans after today, soonest first (for "No stops today · next: …")
//   findJob   looks a clean up by id when an open punch's clean is not on today's list
// → { kind, jobId, job, entry, opensAt, done, total, next }
export function currentStop({ cleans = [], entries = [], now = Date.now(), graceMins, upcoming = [], findJob = null } = {}) {
  const list = live(cleans);
  const base = { kind: HERO.NONE, jobId: null, job: null, entry: null, opensAt: null, done: 0, total: list.length, next: null };

  // 1. On the clock anywhere: the punch to close, whether today's clean or last night's.
  const open = openPunch(entries);
  if (open) {
    const job = list.find((j) => j.id === open.job_id) || (findJob ? findJob(open.job_id) || null : null);
    return { ...base, kind: HERO.CLOCK_OUT, jobId: open.job_id || null, job, entry: open };
  }

  const punches = punchByJob(entries);
  const todo = list
    .map((job) => ({ job, state: stopState(job, punches.get(job.id) || null, now, graceMins) }))
    .filter((r) => r.state !== STOP.DONE);

  // 2. The first clean still to do whose clock-in window is open.
  const openNow = todo.find((r) => clockInRefusal(r.job, now, { graceMins }) === null);
  if (openNow) return { ...base, kind: HERO.CLOCK_IN, jobId: openNow.job.id, job: openNow.job };

  // 3. The next clean today, its window not open yet.
  const early = todo.find((r) => clockInRefusal(r.job, now, { graceMins }) === 'early');
  if (early) {
    const w = clockInWindow(early.job, { graceMins });
    return { ...base, kind: HERO.NOT_YET, jobId: early.job.id, job: early.job, opensAt: w ? w.opensAt : null };
  }

  // 4. Every clean today is behind them (finished, or its window closed with no punch).
  if (list.length > 0) {
    const done = list.filter((j) => stopState(j, punches.get(j.id) || null, now, graceMins) === STOP.DONE).length;
    return { ...base, kind: HERO.ALL_DONE, done };
  }

  // 5. Nothing today.
  return { ...base, next: (upcoming || []).find((j) => j && j.status !== 'cancelled') || null };
}

// Today's Stops: open punches first (last night's carryover first of all), then the cleans still
// to do in time order, then the finished ones. → [{ key, jobId, job, entry, state, carryover }]
export function stopRows({ cleans = [], entries = [], now = Date.now(), graceMins, findJob = null } = {}) {
  const list = live(cleans);
  const punches = punchByJob(entries);
  const onList = new Set(list.map((j) => j.id));
  const carry = (entries || [])
    .filter((e) => isOpen(e) && e.job_id && !onList.has(e.job_id))
    .sort((a, b) => ms(a.clock_in_at) - ms(b.clock_in_at))
    .map((e) => ({ key: `carry-${e.id}`, jobId: e.job_id, job: findJob ? findJob(e.job_id) || null : null, entry: e, state: STOP.NOW, carryover: true }));
  const rows = list.map((job) => {
    const entry = punches.get(job.id) || null;
    return { key: job.id, jobId: job.id, job, entry, state: stopState(job, entry, now, graceMins), carryover: false };
  });
  const rank = (r) => (r.state === STOP.NOW ? 0 : r.state === STOP.DONE ? 2 : 1);
  rows.sort((a, b) => rank(a) - rank(b) || startMs(a.job) - startMs(b.job));
  return [...carry, ...rows];
}

// "{n} stops tonight" once the org's clock reads 5 PM — a cleaner's phone may sit in another zone,
// and the work is in the org's.
export function isTonight(now = Date.now(), tz) {
  return hourInZone(new Date(now), tz) >= TONIGHT_FROM_HOUR;
}

// ── the live perimeter read ───────────────────────────────────────────────────────────────────
// DISPLAY ONLY: the server judges the punch (PAY-17 records an off-site punch, holds it for
// approval and alerts the manager — it never refuses one). This is the same verdict lib/geo gives
// the server, over the clean's own context (store/selectors selectClockContextForJob: the radius
// shift → site → company default, and the ring off for the site or for this cleaner).
export const PRESENCE = Object.freeze({
  INSIDE: 'inside', OUTSIDE: 'outside', UNKNOWN: 'unknown', NO_CENTRE: 'noCentre', OFF: 'off',
});
// `ctx` = { siteLat, siteLng, radiusM, geofenceEnabled }; `fix` = { lat, lng, accuracyM } or null.
export function geoPresence(ctx, fix) {
  if (!ctx) return { state: PRESENCE.UNKNOWN, distanceM: null };
  if (!Number.isFinite(ctx.siteLat) || !Number.isFinite(ctx.siteLng)) return { state: PRESENCE.NO_CENTRE, distanceM: null };
  if (ctx.geofenceEnabled === false) return { state: PRESENCE.OFF, distanceM: null };
  if (!fix || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) return { state: PRESENCE.UNKNOWN, distanceM: null };
  const v = geofenceVerdict({
    siteLat: ctx.siteLat, siteLng: ctx.siteLng, deviceLat: fix.lat, deviceLng: fix.lng,
    accuracyM: fix.accuracyM, radiusM: ctx.radiusM, enabled: true,
  });
  return { state: v.result === 'inside' ? PRESENCE.INSIDE : PRESENCE.OUTSIDE, distanceM: v.distanceM };
}

// What a stop says about where the cleaner is. Once punched it is the SERVER's verdict on the
// punch (lib/geo punchSiteState, CS-689) — the phone's live read no longer decides anything; before
// the punch it is the live read. null = nothing to say (no centre, the ring off, a punch the server
// could not place against a centre).
export const SITE_LINE = Object.freeze({
  INSIDE: 'inside',                  // "Inside site perimeter"
  OUTSIDE_HELD: 'outsideHeld',       // "Outside the site perimeter · time is held for approval"
  UNKNOWN: 'unknown',                // "Can't see your location yet"
  ON_SITE: 'onSite',                 // the punch was made inside the ring
  OFF_SITE_HELD: 'offSiteHeld',      // the punch was made away: held for review
  NO_LOCATION_HELD: 'noLocationHeld', // the punch had no location: held for review
});
// Its words (literal catalog keys, UI_RULES §140) and its tone (a class suffix the screens share).
export const SITE_LINE_KEYS = Object.freeze({
  [SITE_LINE.INSIDE]: 'crewStops.line.inside',
  [SITE_LINE.OUTSIDE_HELD]: 'crewStops.line.outsideHeld',
  [SITE_LINE.UNKNOWN]: 'crewStops.line.unknown',
  [SITE_LINE.ON_SITE]: 'crewStops.line.onSite',
  [SITE_LINE.OFF_SITE_HELD]: 'myDay.chip.offSiteHeld',
  [SITE_LINE.NO_LOCATION_HELD]: 'myDay.chip.noLocationHeld',
});
export const SITE_LINE_TONE = Object.freeze({
  [SITE_LINE.INSIDE]: 'is-ok',
  [SITE_LINE.ON_SITE]: 'is-ok',
  [SITE_LINE.OUTSIDE_HELD]: 'is-held',
  [SITE_LINE.OFF_SITE_HELD]: 'is-held',
  [SITE_LINE.NO_LOCATION_HELD]: 'is-held',
  [SITE_LINE.UNKNOWN]: 'is-quiet',
});
export function siteLine({ entry = null, presence = null } = {}) {
  if (entry) {
    const s = punchSiteState(entry);
    if (s === PUNCH_SITE.ON_SITE) return SITE_LINE.ON_SITE;
    if (s === PUNCH_SITE.OFF_SITE) return SITE_LINE.OFF_SITE_HELD;
    if (s === PUNCH_SITE.NO_LOCATION) return SITE_LINE.NO_LOCATION_HELD;
    return null;
  }
  const state = presence?.state;
  if (state === PRESENCE.INSIDE) return SITE_LINE.INSIDE;
  if (state === PRESENCE.OUTSIDE) return SITE_LINE.OUTSIDE_HELD;
  if (state === PRESENCE.UNKNOWN) return SITE_LINE.UNKNOWN;
  return null;
}

// ── the account manager ───────────────────────────────────────────────────────────────────────
// "Message AM" / "Call AM": the customer's supervisor (`client.supervisorId`). Crew read office
// users' phones in their projection (api/_lib/crewView.js), so the phone is on the roster row.
// A button that cannot work is off and says why (UI_RULES §118).
export const AM_REASON = Object.freeze({ NO_STOP: 'noStop', NO_MANAGER: 'noManager', NO_PHONE: 'noPhone' });
export function accountManager(client, users = []) {
  if (!client) return { user: null, phone: null, reason: AM_REASON.NO_STOP };
  const user = client.supervisorId ? (users || []).find((u) => u && u.id === client.supervisorId) || null : null;
  if (!user) return { user: null, phone: null, reason: AM_REASON.NO_MANAGER };
  const phone = typeof user.phone === 'string' && user.phone.trim() ? user.phone.trim() : null;
  return { user, phone, reason: phone ? null : AM_REASON.NO_PHONE };
}

// ── the checklist, with the draft on the phone (the integration of Builder B's page) ─────────────
// The checklist page (pages/crew/CrewChecklist) keeps the cleaner's work ON THE PHONE as they go
// (lib/checklistDraft) and saves it to the server once, at the end. Until then the stored
// submission says nothing, so Home's tile, the hero and the Clock out screen read the draft —
// counted by the SAME rule the page and the server use (lib/checklistCount countChecklistSubmission
// over draftItems and the draft's own photo keys; the server re-counts what lands). A draft with no
// checklist kept on it cannot be counted, and then no number is shown.
//   gate   the shared clock-out gate's verdict ({ state, done, total }, hooks/useCleanChecklist)
//   draft  the draft on the phone for this clean, checklist and cleaner, or null
// → null (nothing to count: not started) or { done, total, source: 'saved'|'draft', complete, ready }
//   `ready` = a FINISHED draft not saved yet (Clock out offers "Save checklist & clock out").
export function checklistProgress({ gate = null, draft = null } = {}) {
  if (gate && gate.state === GATE.DONE) {
    const total = gate.total || 0;
    return { done: total, total, source: 'saved', complete: true, ready: false };
  }
  if (gate && gate.total > 0) {
    return { done: Math.min(gate.done || 0, gate.total), total: gate.total, source: 'saved', complete: false, ready: false };
  }
  const schema = draft?.schema;
  if (!draft || !schema) return null;
  const c = countChecklistSubmission(schema, draftItems(schema, draft), { photoKeys: draftPhotoKeys(draft) });
  if (!c.total_count) return null;
  const complete = c.completed_count >= c.total_count;
  return { done: c.completed_count, total: c.total_count, source: 'draft', complete, ready: complete };
}

// What Clock out does with a draft on the phone (plan §5, the integration pass):
//   SAVE_THEN_OUT          a finished draft not saved yet → "Save checklist & clock out": the save
//                          first, the clock-out after it, through the same gate (the server refuses
//                          the clock-out if the save did not count);
//   SAVE_PARTIAL_THEN_OUT  the office turned the lock OFF for this cleaner (clockRules.
//                          checklistBlockOff → the gate's OFF) and a partial draft exists → save
//                          what was done first, so the office sees it, then clock out;
//   OUT                    anything else — no draft, an untouched one, a checklist already saved,
//                          or a partial draft under the lock (the button stays locked).
export const CLOCK_OUT_PLAN = Object.freeze({ OUT: 'out', SAVE_THEN_OUT: 'saveThenOut', SAVE_PARTIAL_THEN_OUT: 'savePartialThenOut' });
const touched = (draft) => !!draft && (Object.keys(draft.checks || {}).length > 0 || draftPhotoKeys(draft).length > 0);
export function clockOutPlan({ gate = null, draft = null } = {}) {
  if (!touched(draft) || !gate || gate.state === GATE.DONE || gate.state === GATE.NONE) return CLOCK_OUT_PLAN.OUT;
  const p = checklistProgress({ gate: gate.state === GATE.OFF ? null : gate, draft });
  if (p && p.source === 'draft' && p.ready) return CLOCK_OUT_PLAN.SAVE_THEN_OUT;
  if (gate.state === GATE.OFF) return CLOCK_OUT_PLAN.SAVE_PARTIAL_THEN_OUT;
  return CLOCK_OUT_PLAN.OUT;
}
