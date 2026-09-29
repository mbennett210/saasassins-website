// Field-level authorization for public.jobs writes — the guard that makes Increment
// 1e mean something on the jobs table, as orgStateGuard does for the blob.
//
// THE HOLE: POST /api/state/jobs-delta gated with requireAuthority ONLY. The server
// owns organization_id and updated_by, but the job CONTENT — crewIds, siteId — was
// copied verbatim from the body. So any authenticated user could POST a job naming
// themselves at any site and satisfy requireSiteAssignment(..., {allowJobBased:true}),
// or POST {removed:[...]} and delete the schedule.
//
// ⚠️ WHY THESE TESTS ARE SHAPED AROUND *SANITIZING*, NOT REJECTING.
// A jobs write audit established that clients re-POST rows they never touched:
// diffJobs compares by OBJECT REFERENCE and lastSyncedJobs is not advanced when a
// realtime patch lands, so a crew phone routinely submits a MANAGER's crewIds/siteId,
// and crew tabs re-emit manager deletes as their own removed[]. A 403 on any of that
// is invisible (stateApi treats only 409 as a real answer) and, post-1e, wedges the
// tab in a permanent 5s retry loop with the user's own clock-in stuck behind it.
// So the guard ACCEPTS every write from someone who may not edit the schedule and
// replaces what they may not change with the stored value: an echo is a no-op, an
// escalation is a 200 that moves nothing. (Since the ping-pong fix, store/sync.js
// advanceJobsBaseline, pure echoes are rare; stale tabs and offline replays still send
// rows someone else changed, which is what the echo cases below stand for.)
//
// WHO may edit the schedule (owner's calls, 2026-09-23): owner + admin by role, or a
// MANAGER holding schedule.edit in the COMMITTED Roles matrix + their per-user
// overrides; crew never, whatever they are granted. See the section at the bottom.
// Before it, a 4th-tier manager was sanitized like crew.
//
// The ECHO and OUTAGE cases below are the load-bearing ones.
//
//   node scripts/test-jobs-guard.mjs
import { readFileSync, readdirSync } from 'node:fs';
import {
  sanitizeJobsDelta, idsNeedingPrev, PROTECTED_JOB_FIELDS, JOB_MANAGER_ROLES, AUTHZ_READ_SAFE_JOB_FIELDS,
  guardJobsDelta, holdsScheduleEdit, JOB_EDIT_KEY, JOB_MATRIX_ROLES,
} from '../api/_lib/jobsGuard.js';
import { seedPermissions, PERMISSIONS } from '../src/lib/roles.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const ME = 'u_crew';
const OTHER = 'u_other';

const job = (over = {}) => ({
  // Mirrors the reducer's create shape — shiftId defaults to null.
  id: 'j1', siteId: 's1', clientId: 'c1', seriesId: null, recurrence: null, shiftId: null,
  startAt: '2026-07-20T17:00:00.000Z', endAt: '2026-07-20T19:00:00.000Z',
  status: 'upcoming', crewIds: [OTHER], notes: '', ...over,
});
const prevMap = (j = job()) => new Map([[j.id, j]]);
const run = (over, role = 'crew', removed = []) =>
  sanitizeJobsDelta({ prev: prevMap(), changed: [job(over)], removed, role });
const committed = (r) => r.changed[0];

// ── THE headline escalation: neutralized, not rejected ────────────────────
{
  const r = run({ crewIds: [OTHER, ME] });
  ok('crew self-assignment does NOT reject (no wedge)', r.changed.length === 1);
  ok('  ...and crewIds is restored to the stored value', JSON.stringify(committed(r).crewIds) === JSON.stringify([OTHER]));
  ok('  ...the caller is NOT added', !committed(r).crewIds.includes(ME));
  ok('  ...and it is reported for logging', r.adjustments.some((a) => a.includes('assigned')));
}
ok('crew replacing crew with themselves is neutralized',
  !committed(run({ crewIds: [ME] })).crewIds.includes(ME));
ok('crew emptying crewIds is neutralized',
  JSON.stringify(committed(run({ crewIds: [] })).crewIds) === JSON.stringify([OTHER]));

// ── the rest of the authority set ────────────────────────────────────────
ok('siteId is restored', committed(run({ siteId: 's_victim' })).siteId === 's1');
ok('clientId is restored', committed(run({ clientId: 'c_victim' })).clientId === 'c1');
ok('startAt is restored', committed(run({ startAt: '2026-09-09T00:00:00.000Z' })).startAt === job().startAt);
// endAt bounds the job-based assignment window, so extending it extends access.
ok('endAt is restored', committed(run({ endAt: '2026-12-31T00:00:00.000Z' })).endAt === job().endAt);
ok('seriesId is restored', committed(run({ seriesId: 'ser_x' })).seriesId === null);
ok('recurrence is restored', committed(run({ recurrence: { freq: 'daily' } })).recurrence === null);
// A field the stored row doesn't carry (e.g. `oneOff`, optional) is restored as null —
// the guard's documented "absent stored value is written as null" — so compare with
// absent and null as the same value.
ok('EVERY protected field is enforced', PROTECTED_JOB_FIELDS.every((f) => {
  const bogus = f === 'crewIds' ? [ME] : (f === 'recurrence' ? { freq: 'weekly' } : 'CHANGED');
  return JSON.stringify(committed(run({ [f]: bogus }))[f] ?? null) === JSON.stringify(job()[f] ?? null);
}));
ok('a crew-written oneOff mark is neutralized (it decides who stays on a visit)',
  committed(run({ oneOff: { crew: true } })).oneOff === null);
// coverFor (R8, 2026-09-27) decides WHICH checklist a cleaner must fill on a clean — and
// from step 4 whether they can clock out of it. Crew-writable, it would let a cleaner
// point themselves at a colleague's (or an absent) checklist and dodge their own.
// Sanitized like oneOff, never rejected (the echo law above).
{
  const r = run({ coverFor: { [ME]: OTHER } });
  ok('a crew-written coverFor is neutralized (it picks the checklist they must fill)',
    committed(r).coverFor === null);
  ok('  ...and does NOT reject (no wedge)', r.changed.length === 1);
  const kept = { coverFor: { [ME]: OTHER } };
  const stored = job(kept);
  const echo = sanitizeJobsDelta({ prev: prevMap(stored), changed: [{ ...stored }], removed: [], role: 'crew' });
  ok('an ECHO of the office\'s own coverFor passes through untouched',
    JSON.stringify(echo.changed[0].coverFor) === JSON.stringify(kept.coverFor) && echo.adjustments.length === 0);
  const wiped = sanitizeJobsDelta({ prev: prevMap(stored), changed: [job({ coverFor: null })], removed: [], role: 'crew' });
  ok('crew DROPPING the office\'s coverFor is put back',
    JSON.stringify(committed(wiped).coverFor) === JSON.stringify(kept.coverFor));
}
ok('several protected fields at once are all restored', (() => {
  const c = committed(run({ crewIds: [ME], siteId: 'x', startAt: 'z' }));
  return !c.crewIds.includes(ME) && c.siteId === 's1' && c.startAt === job().startAt;
})());

// ── ⚠️ THE ECHO CASE — the one that would have caused the outage ──────────
// A crew tab re-POSTs a manager's row verbatim. It must pass through untouched and
// register NO adjustment, or every crew phone wedges.
{
  const managerRow = job({ crewIds: ['u_a', 'u_b'], siteId: 's9', startAt: '2026-08-01T00:00:00.000Z' });
  const r = sanitizeJobsDelta({ prev: prevMap(managerRow), changed: [{ ...managerRow }], removed: [], role: 'crew' });
  ok('an ECHO of a manager row passes through untouched', JSON.stringify(r.changed[0]) === JSON.stringify(managerRow));
  ok('  ...and records NO adjustment', r.adjustments.length === 0);
}
{
  // Echo + the crew member's own legitimate status change in the same payload.
  const mgr = job({ crewIds: ['u_a'], siteId: 's9' });
  const r = sanitizeJobsDelta({ prev: prevMap(mgr), changed: [{ ...mgr, status: 'in_progress' }], removed: [], role: 'crew' });
  ok('an echo carrying the crew\'s OWN status change commits the status', r.changed[0].status === 'in_progress');
  ok('  ...while leaving the manager\'s crewIds intact', JSON.stringify(r.changed[0].crewIds) === JSON.stringify(['u_a']));
  ok('  ...with no adjustment', r.adjustments.length === 0);
}
// A STALE tab echoes the OLD value after a manager changed it. Must not reject —
// this is the race that would wedge a phone mid-shift.
{
  const stored = job({ crewIds: ['u_new'] });
  const stale = job({ crewIds: [OTHER], status: 'in_progress' });
  const r = sanitizeJobsDelta({ prev: prevMap(stored), changed: [stale], removed: [], role: 'crew' });
  ok('a STALE echo is accepted, never rejected', r.changed.length === 1);
  ok('  ...the manager\'s newer crewIds survive', JSON.stringify(r.changed[0].crewIds) === JSON.stringify(['u_new']));
  ok('  ...and the crew\'s status change still lands', r.changed[0].status === 'in_progress');
}

// ── ⚠️ OUTAGE CASES — what crew MUST still be able to do ─────────────────
ok('crew CAN change status (schedule.statusTransition)', committed(run({ status: 'in_progress' })).status === 'in_progress');
ok('crew CAN complete a job', committed(run({ status: 'completed' })).status === 'completed');
ok('crew CAN edit notes', committed(run({ notes: 'gate code changed' })).notes === 'gate code changed');
// Deny-by-exception: a job row grows fields as the Swept build lands.
ok('crew CAN write a NEW field the guard has never heard of', committed(run({ clockInAt: 'T' })).clockInAt === 'T');
ok('crew CAN write several unknown fields', (() => {
  const c = committed(run({ checklistResultId: 'cr_1', beforePhotoCount: 3 }));
  return c.checklistResultId === 'cr_1' && c.beforePhotoCount === 3;
})());
ok('a REORDERED crewIds with the same members is not a change', (() => {
  const r = sanitizeJobsDelta({ prev: prevMap(job({ crewIds: [OTHER, ME] })), changed: [job({ crewIds: [ME, OTHER] })], removed: [], role: 'crew' });
  return r.adjustments.length === 0;
})());
ok('an unchanged row records no adjustment', run({}).adjustments.length === 0);
ok('an empty delta is a clean no-op', (() => {
  const r = sanitizeJobsDelta({ prev: new Map(), changed: [], removed: [], role: 'crew' });
  return r.changed.length === 0 && r.removed.length === 0 && r.adjustments.length === 0;
})());

// ── deletes: dropped, never rejected ─────────────────────────────────────
// Dropping is right for BOTH cases. An echo targets a row already gone, so ignoring
// it leaves the DB identical and the tab advances. An originating delete is the
// mass-wipe primitive and must not commit.
{
  const r = run({}, 'crew', ['j1', 'j2', 'j3']);
  ok('crew deletes are DROPPED, not rejected', r.removed.length === 0);
  ok('  ...the request still succeeds', Array.isArray(r.changed));
  ok('  ...and it is logged', r.adjustments.includes('delete jobs'));
}
ok('a crew mass-delete of 250 ids removes nothing',
  run({}, 'crew', Array.from({ length: 250 }, (_, i) => `j${i}`)).removed.length === 0);
ok('a crew delete does not block the same request\'s legitimate status change',
  run({ status: 'in_progress' }, 'crew', ['j2']).changed[0].status === 'in_progress');

// ── creates: dropped ─────────────────────────────────────────────────────
// With TOP_UP_RECURRING_SERIES gated on schedule.edit client-side, no legitimate crew
// create remains; a stale/replayed tab can still emit one and must not wedge.
{
  const r = sanitizeJobsDelta({ prev: new Map(), changed: [job({ id: 'j_new', crewIds: [ME], siteId: 'victim' })], removed: [], role: 'crew' });
  ok('a crew CREATE is dropped', r.changed.length === 0);
  ok('  ...not rejected', Array.isArray(r.changed));
  ok('  ...and logged', r.adjustments.includes('create a job'));
}

// ── owner + admin (the role list) are untouched, and pay no read ────────
// (A 4th-tier manager is NOT on this list: it passes through the matrix, at the bottom.)
for (const role of JOB_MANAGER_ROLES) {
  ok(`${role} create passes through`, sanitizeJobsDelta({ prev: new Map(), changed: [job({ id: 'n' })], removed: [], role }).changed.length === 1);
  ok(`${role} delete passes through`, sanitizeJobsDelta({ prev: prevMap(), changed: [], removed: ['j1'], role }).removed.length === 1);
  ok(`${role} reassign passes through`, JSON.stringify(sanitizeJobsDelta({ prev: prevMap(), changed: [job({ crewIds: [ME] })], removed: [], role }).changed[0].crewIds) === JSON.stringify([ME]));
  ok(`${role} never consults prev at all`, (() => {
    const r = sanitizeJobsDelta({ prev: undefined, changed: [job({ crewIds: [ME] })], removed: ['x'], role });
    return r.changed.length === 1 && r.removed.length === 1 && r.adjustments.length === 0;
  })());
}

// ── fail closed on an unresolvable caller ────────────────────────────────
for (const role of [null, undefined, '', 'Owner', 'superuser']) {
  ok(`role ${JSON.stringify(role)} is NOT treated as a manager`,
    !sanitizeJobsDelta({ prev: prevMap(), changed: [job({ crewIds: [ME] })], removed: ['j1'], role }).changed[0].crewIds.includes(ME));
}

// ── shape robustness ─────────────────────────────────────────────────────
ok('prev may be a plain object',
  !sanitizeJobsDelta({ prev: { j1: job() }, changed: [job({ crewIds: [ME] })], removed: [], role: 'crew' }).changed[0].crewIds.includes(ME));
ok('malformed changed entries are skipped, not crashed',
  sanitizeJobsDelta({ prev: prevMap(), changed: [null, undefined, {}, { id: '' }, 5], removed: [], role: 'crew' }).changed.length === 0);
ok('a non-array changed does not throw', sanitizeJobsDelta({ prev: prevMap(), changed: 'nope', removed: [], role: 'crew' }).changed.length === 0);
ok('a non-array removed does not throw', sanitizeJobsDelta({ prev: prevMap(), changed: [], removed: 'nope', role: 'crew' }).removed.length === 0);
ok('the caller\'s object is not mutated', (() => {
  const input = job({ crewIds: [ME] });
  sanitizeJobsDelta({ prev: prevMap(), changed: [input], removed: [], role: 'crew' });
  return input.crewIds.includes(ME);
})());
ok('adjustments are de-duplicated across many rows', (() => {
  const prev = new Map([['a', job({ id: 'a' })], ['b', job({ id: 'b' })]]);
  const r = sanitizeJobsDelta({ prev, changed: [job({ id: 'a', crewIds: [ME] }), job({ id: 'b', crewIds: [ME] })], removed: [], role: 'crew' });
  return r.adjustments.length === 1;
})());
// An absent stored value must be written as null, not left undefined — JSON drops
// undefined, which would read as "field absent" rather than "field restored".
ok('an absent stored field is restored as null, not dropped', (() => {
  const r = sanitizeJobsDelta({ prev: new Map([['j1', { id: 'j1' }]]), changed: [{ id: 'j1', crewIds: [ME] }], removed: [], role: 'crew' });
  return Object.prototype.hasOwnProperty.call(r.changed[0], 'crewIds') && r.changed[0].crewIds === null;
})());
ok('crewIds absent on both sides is not a change',
  sanitizeJobsDelta({ prev: new Map([['j1', { id: 'j1', status: 'a' }]]), changed: [{ id: 'j1', status: 'b' }], removed: [], role: 'crew' }).adjustments.length === 0);

// ── idsNeedingPrev ───────────────────────────────────────────────────────
ok('collects ids to fetch', idsNeedingPrev([job({ id: 'a' }), job({ id: 'b' })]).length === 2);
ok('de-duplicates', idsNeedingPrev([job({ id: 'a' }), job({ id: 'a' })]).length === 1);
ok('drops malformed ids', idsNeedingPrev([{ id: '' }, { id: null }, {}, null, 7]).length === 0);
ok('handles a non-array', idsNeedingPrev('nope').length === 0);
ok('handles undefined', idsNeedingPrev().length === 0);

// ── shiftId: an INTEGRITY vector, not an access one ──────────────────────
// time/store.js lets a job's shift OVERRIDE the site's expectedCleanMins (the
// variance/payroll baseline) and geofenceRadiusM (the clock-in geofence), so writing
// it games the labor figure. Free to protect: no client path sets it non-null.
ok('shiftId is protected', PROTECTED_JOB_FIELDS.includes('shiftId'));
ok('crew cannot widen their own geofence by switching shift', (() => {
  const stored = job({ shiftId: 'sh_strict' });
  const r = sanitizeJobsDelta({ prev: prevMap(stored), changed: [job({ shiftId: 'sh_loose' })], removed: [], role: 'crew' });
  return r.changed[0].shiftId === 'sh_strict';
})());
ok('owner / admin CAN set shiftId', (() => {
  const r = sanitizeJobsDelta({ prev: prevMap(job({ shiftId: null })), changed: [job({ shiftId: 'sh_loose' })], removed: [], role: 'admin' });
  return r.changed[0].shiftId === 'sh_loose';
})());

// ── a PAST job is still status-writable (stale tab, past occurrence) ─────
// endAt is protected, so a crew member closing out yesterday's clean must not trip on
// the fact that endAt is in the past — it is unchanged, so it is not a change.
{
  const past = job({ startAt: '2026-07-01T17:00:00.000Z', endAt: '2026-07-01T19:00:00.000Z' });
  const r = sanitizeJobsDelta({ prev: prevMap(past), changed: [{ ...past, status: 'completed' }], removed: [], role: 'crew' });
  ok('crew CAN status-change a job whose endAt has passed', r.changed[0].status === 'completed');
  ok('  ...with no adjustment (endAt unchanged)', r.adjustments.length === 0);
  ok('  ...and endAt is not silently rewritten', r.changed[0].endAt === past.endAt);
}

// ── status: kept from anyone, except the two changes statusChangeKept refuses (S81) ──
// Status is an input to crew's door-code access (src/lib/siteAccess.js): un-cancelling a
// clean would hand back access the office took away, and a visit flipped more than a day
// out would keep its crew through the office's series edits and deletes (they touch only
// upcoming visits). Clock-in / clock-out's own changes must still land.
{
  const NOW = Date.parse('2026-09-23T15:00:00.000Z');
  const at = (h) => new Date(NOW + h * 3600e3).toISOString();
  const visit = (h, status = 'upcoming') => job({ crewIds: [ME], startAt: at(h), endAt: at(h + 2), status });
  const put = (stored, to, role = 'crew') =>
    sanitizeJobsDelta({ prev: prevMap(stored), changed: [{ ...stored, status: to }], removed: [], role, now: NOW });
  const un = put(visit(2, 'cancelled'), 'upcoming');
  ok("🔴 crew can't un-cancel a clean: the stored 'cancelled' goes back", un.changed[0].status === 'cancelled');
  ok('  ...accepted with an adjustment, never rejected', un.changed.length === 1 && un.adjustments.includes("change a job's status"));
  ok("🔴 crew can't move a cancelled clean to in_progress or done either",
    put(visit(-1, 'cancelled'), 'in_progress').changed[0].status === 'cancelled'
    && put(visit(-5, 'cancelled'), 'done').changed[0].status === 'cancelled');
  ok("🔴 crew can't flip next week's visit to in_progress", put(visit(7 * 24), 'in_progress').changed[0].status === 'upcoming');
  ok("🔴 ...nor mark it done, nor cancel it",
    put(visit(7 * 24), 'done').changed[0].status === 'upcoming' && put(visit(7 * 24), 'cancelled').changed[0].status === 'upcoming');
  ok('a day out exactly, the change is kept; a millisecond further, it goes back',
    sanitizeJobsDelta({ prev: prevMap(visit(24)), changed: [{ ...visit(24), status: 'in_progress' }], removed: [], role: 'crew', now: NOW }).changed[0].status === 'in_progress'
    && sanitizeJobsDelta({ prev: prevMap(visit(24)), changed: [{ ...visit(24), status: 'in_progress' }], removed: [], role: 'crew', now: NOW - 1 }).changed[0].status === 'upcoming');
  ok('crew CAN start a clean that begins within the day (clock-in)', put(visit(2), 'in_progress').changed[0].status === 'in_progress');
  ok('crew CAN start a missed one (a late clock-in)', put(visit(-3, 'missed'), 'in_progress').changed[0].status === 'in_progress');
  ok('crew CAN finish a clean (clock-out)', put(visit(-1, 'in_progress'), 'done').changed[0].status === 'done');
  ok("crew CAN cancel today's clean (status stays theirs to move)", put(visit(2), 'cancelled').changed[0].status === 'cancelled');
  ok("🔴 a manager without schedule.edit can't un-cancel either (sanitized like crew)",
    put(visit(2, 'cancelled'), 'upcoming', 'manager').changed[0].status === 'cancelled');
  for (const role of JOB_MANAGER_ROLES) {
    ok(`${role} writes status whole: un-cancel and next week's visit both land`,
      put(visit(2, 'cancelled'), 'upcoming', role).changed[0].status === 'upcoming'
      && put(visit(7 * 24), 'done', role).changed[0].status === 'done');
  }
  const moved = sanitizeJobsDelta({ prev: prevMap(visit(7 * 24)), changed: [{ ...visit(7 * 24), startAt: at(1), status: 'in_progress' }], removed: [], role: 'crew', now: NOW });
  ok("🔴 a nearer start sent with it doesn't unlock a far visit's status (judged on the STORED start)",
    moved.changed[0].status === 'upcoming' && moved.changed[0].startAt === at(7 * 24));
  const echo = sanitizeJobsDelta({ prev: prevMap(visit(2, 'cancelled')), changed: [visit(2, 'cancelled')], removed: [], role: 'crew', now: NOW });
  ok('an echo of a cancelled clean passes untouched, with no adjustment', echo.changed[0].status === 'cancelled' && echo.adjustments.length === 0);
  const stale = sanitizeJobsDelta({ prev: prevMap(visit(2, 'cancelled')), changed: [visit(2, 'upcoming')], removed: [], role: 'crew', now: NOW });
  ok("🔴 a stale crew tab's echo no longer revives a clean the office cancelled", stale.changed[0].status === 'cancelled');
  ok('a job with no start: only the un-cancel limit applies',
    sanitizeJobsDelta({ prev: new Map([['j1', { id: 'j1', status: 'upcoming' }]]), changed: [{ id: 'j1', status: 'done' }], removed: [], role: 'crew', now: NOW }).changed[0].status === 'done'
    && sanitizeJobsDelta({ prev: new Map([['j1', { id: 'j1', status: 'cancelled' }]]), changed: [{ id: 'j1', status: 'done' }], removed: [], role: 'crew', now: NOW }).changed[0].status === 'cancelled');
}

// ── EVERY protected field absent on both sides is a no-op ────────────────
// A one-off job legitimately has no seriesId/recurrence/shiftId. The guard must not
// inject keys that were never there — an injected null is a silent data change.
ok('every protected field absent on BOTH sides is not a change', (() => {
  const bare = { id: 'j1', status: 'upcoming' };
  const r = sanitizeJobsDelta({ prev: new Map([['j1', bare]]), changed: [{ id: 'j1', status: 'completed' }], removed: [], role: 'crew' });
  return r.adjustments.length === 0
    && PROTECTED_JOB_FIELDS.every((f) => !Object.prototype.hasOwnProperty.call(r.changed[0], f));
}));

// ── 🔴 THE PROTECTED FIELDS MUST BE FIELDS THAT ACTUALLY EXIST ──────────
// A guard that names a field the app never writes is INERT while looking healthy —
// and it will pass its own tests, because the fixtures get written from the same
// wrong assumption. That is not hypothetical: api/_lib/blobBudget.js shipped guarding
// `signatureDataUrl` when the real field is `imageDataUrl`, and its 27 tests passed.
//
// Verified against PRODUCTION when this was written: the protected fields were present
// on 100% of 19,267 rows (`select jsonb_object_keys(data) ... group by 1`).
// (crewExcludedIds was retired 2026-09-19 with the named-only crew model — feat/crew
// 008f5f2 — so it is no longer a job field or a protected one.)
// The real job shape is:
//   id · status · startAt · endAt · clientId · siteId · serviceId · seriesId
//   · recurrence · crewIds · shiftId · tagIds · notes · createdAt
//
// This asserts the names against reducer.js — the code that CREATES jobs — so a typo
// or a rename fails the build instead of silently disarming the guard.
{
  const reducer = readFileSync(new URL('../src/store/reducer.js', import.meta.url), 'utf8');
  const missing = PROTECTED_JOB_FIELDS.filter((f) => !new RegExp(`\\b${f}\\b`).test(reducer));
  ok(`every protected field is a real job field (missing from reducer.js: ${missing.join(', ') || 'none'})`,
    missing.length === 0);
  // The live shape, pinned. If a field leaves the job object this list must be
  // revisited deliberately rather than the guard quietly covering nothing.
  // `oneOff` (2026-09-23) and `coverFor` (2026-09-27) are OPTIONAL — only a series visit
  // changed on its own carries the first, only a visit somebody is covering the second
  // (reducer.js markOneOff / settleCoverFor) — so unlike the rest they are not on every row.
  const LIVE_JOB_FIELDS = ['id', 'status', 'startAt', 'endAt', 'clientId', 'siteId',
    'serviceId', 'seriesId', 'recurrence', 'crewIds', 'shiftId', 'tagIds', 'notes', 'createdAt',
    'oneOff', 'coverFor'];
  const notReal = PROTECTED_JOB_FIELDS.filter((f) => !LIVE_JOB_FIELDS.includes(f));
  ok(`no protected field is invented (${notReal.join(', ') || 'none'})`, notReal.length === 0);
  // And every live field is accounted for: protected, explicitly safe, or ordinary
  // data. `serviceId`, `tagIds`, `notes`, `createdAt` are business data — none is
  // read by any server gate (asserted by the coverage scan below).
  const ORDINARY = ['serviceId', 'tagIds', 'notes', 'createdAt'];
  const unaccounted = LIVE_JOB_FIELDS.filter((f) =>
    !PROTECTED_JOB_FIELDS.includes(f) && !AUTHZ_READ_SAFE_JOB_FIELDS.includes(f) && !ORDINARY.includes(f));
  ok(`every live job field is classified (${unaccounted.join(', ') || 'none'} unaccounted)`, unaccounted.length === 0);
}

// ── 🔴 AUTHORITY COVERAGE — the compensating control for deny-by-exception ──
// Deny-by-exception fails OPEN on a NEW authority field: add one to a job, have a
// server gate read it, forget to name it here, and crew can write it silently. This
// test reads the actual authorization sources and asserts every job field they
// consume is either PROTECTED or explicitly reviewed-safe — so the failure mode
// becomes a red build instead of a quiet hole. Adding a field to the safe list is a
// deliberate, reviewable act; forgetting is not possible.
{
  // src/lib/siteAccess.js: authz's job path decides a clean by jobGrantsSiteAccess there.
  const src = ['../api/_lib/authz.js', '../api/_lib/time/store.js', '../src/lib/siteAccess.js']
    .map((p) => readFileSync(new URL(p, import.meta.url), 'utf8')).join('\n');
  const read = [...new Set(
    [...src.matchAll(/\b(?:job|j)\.([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1])
  )];
  const known = new Set([...PROTECTED_JOB_FIELDS, ...AUTHZ_READ_SAFE_JOB_FIELDS]);
  const unclassified = read.filter((f) => !known.has(f));
  ok(`every job field read by server authz is classified (found ${read.length}: ${read.join(', ')})`, unclassified.length === 0);
  if (unclassified.length) {
    fails.push(`  UNCLASSIFIED job field(s) read by authz: ${unclassified.join(', ')} — add to PROTECTED_JOB_FIELDS or AUTHZ_READ_SAFE_JOB_FIELDS in jobsGuard.js`);
  }
  // Sanity: the scan must actually be finding things, or it passes vacuously.
  ok('the coverage scan is not vacuous', read.length >= 5 && read.includes('crewIds'));
  ok('  ...and it reaches the grant rule (jobGrantsSiteAccess reads the job\'s times)', read.includes('startAt') && read.includes('endAt'));
  ok('the safe list stays small and reviewed', AUTHZ_READ_SAFE_JOB_FIELDS.length <= 4);
}

// ══ WHO MAY EDIT THE SCHEDULE (owner's calls, 2026-09-23) ═══════════════════════
// Owner + admin write whole by role (never tightened) and read nothing. A MANAGER
// writes whole iff the COMMITTED matrix + their per-user overrides give them
// schedule.edit, through the same can() the app gates on. Crew never, whatever they
// are granted; nor a caller with no role or another role, nor a manager whose u_* id
// didn't resolve. Everyone else is sanitized exactly as above. Before this the role
// list alone decided, so a manager (full access by default) had every create and
// delete dropped and every crew / time edit put back, answering 200 — including time
// off's "take them off these cleans".
//
// Fixtures come from the app's own default matrix (seedPermissions), never a restated
// literal: a manager holds schedule.edit because lib/roles says so.
const SEED = seedPermissions();
const without = (role, key = JOB_EDIT_KEY) => SEED.map((p) => (p.id === key ? { ...p, roles: p.roles.filter((r) => r !== role) } : p));
const withRole = (role, key = JOB_EDIT_KEY) => SEED.map((p) => (p.id === key ? { ...p, roles: [...p.roles, role] } : p));
const MGR = 'u_mgr';
const MGR2 = 'u_mgr2';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Fake readers that count their calls, so the cost claims are pinned too. readRows
// answers only the ids asked for, like jobsTable.getJobsByIds.
function readers(opts = {}) {
  const { overrides = [], rows = prevMap(), authzFails = false, rowsFail = false } = opts;
  // As in decide(): an explicitly passed matrix is used as given, undefined included.
  const permissions = Object.prototype.hasOwnProperty.call(opts, 'permissions') ? opts.permissions : SEED;
  const r = { authz: 0, rows: 0 };
  r.readAuthz = async () => {
    r.authz += 1;
    if (authzFails) throw new Error('org_state protected read failed: boom');
    return { permissions, overrides };
  };
  r.readRows = async (ids) => {
    r.rows += 1;
    if (rowsFail) throw new Error('jobs read failed: boom');
    return new Map([...rows].filter(([id]) => ids.includes(id)));
  };
  return r;
}
async function decide(args) {
  const { role, changed = [], removed = [], ...opts } = args;
  // An explicitly passed selfId is used as given, undefined included (a default
  // parameter would silently turn an unresolved id into ME).
  const selfId = Object.prototype.hasOwnProperty.call(args, 'selfId') ? args.selfId : ME;
  const r = readers(opts);
  const out = await guardJobsDelta({ role, selfId, changed, removed, readAuthz: r.readAuthz, readRows: r.readRows, ...(opts.now != null ? { now: opts.now } : {}) });
  return { ...out, reads: { authz: r.authz, rows: r.rows } };
}
const NEW = () => job({ id: 'j_new', crewIds: [OTHER] });

// ── the rule itself, and the constants that carry it ─────────────────────────
ok('the guard gates on a key lib/roles defines', !!PERMISSIONS[JOB_EDIT_KEY]);
ok('the role list is exactly owner + admin: a manager passes through the MATRIX, so a Roles-page revoke reaches them',
  same([...JOB_MANAGER_ROLES].sort(), ['admin', 'owner']));
ok('only a manager can hold it through the matrix (crew never, whatever they are granted)',
  same(JOB_MATRIX_ROLES, ['manager']));
for (const [role, expected] of [['owner', true], ['admin', true], ['manager', true], ['crew', false]]) {
  ok(`on the default matrix, ${role} ${expected ? 'writes jobs whole' : 'is sanitized'}`,
    holdsScheduleEdit({ role, selfId: 'u_x', permissions: SEED, overrides: [] }) === expected);
}
ok('fixture: lib/roles really gives crew no schedule.edit by default (so the crew cases below test the rule, not the default)',
  !PERMISSIONS[JOB_EDIT_KEY].defaultRoles.includes('crew'));

// ── a manager on the default matrix: every schedule edit the app offers is KEPT ──
{
  const created = NEW();
  const r = await decide({ role: 'manager', selfId: MGR, changed: [created], rows: new Map() });
  ok('manager CREATE is kept (was dropped)', r.changed.length === 1 && same(r.changed[0], created));
  ok('  ...with no adjustment', r.adjustments.length === 0);
  ok('  ...for one small matrix read and no row read', r.reads.authz === 1 && r.reads.rows === 0);
}
ok('manager DELETE is kept (was dropped)',
  same((await decide({ role: 'manager', selfId: MGR, removed: ['j1', 'j2'] })).removed, ['j1', 'j2']));
{
  const moved = job({ startAt: '2026-07-21T17:00:00.000Z', endAt: '2026-07-21T19:00:00.000Z' });
  const r = await decide({ role: 'manager', selfId: MGR, changed: [moved] });
  ok('manager RESCHEDULE (startAt / endAt) is kept (was put back)', r.changed[0].startAt === moved.startAt && r.changed[0].endAt === moved.endAt);
}
ok('manager RE-CREW is kept (was put back)',
  same((await decide({ role: 'manager', selfId: MGR, changed: [job({ crewIds: [OTHER, 'u_b'] })] })).changed[0].crewIds, [OTHER, 'u_b']));
{
  // Time off's "take them off these cleans" (APPLY_TIME_OFF_EXCLUSIONS): crewIds loses one member.
  const stored = job({ crewIds: [OTHER, 'u_off'] });
  const r = await decide({ role: 'manager', selfId: MGR, changed: [job({ crewIds: [OTHER] })], rows: prevMap(stored) });
  ok('manager time-off exclusion is kept (was put back)', same(r.changed[0].crewIds, [OTHER]));
}
{
  const r = await decide({ role: 'manager', selfId: MGR, changed: [job({ siteId: 's2', clientId: 'c2', seriesId: 'ser_1', recurrence: { freq: 'weekly' }, shiftId: 'sh_1', oneOff: { crew: true } })] });
  const c = r.changed[0];
  ok('manager can move a job to another site / account / series / shift and mark it one-off',
    c.siteId === 's2' && c.clientId === 'c2' && c.seriesId === 'ser_1' && c.shiftId === 'sh_1'
      && same(c.recurrence, { freq: 'weekly' }) && same(c.oneOff, { crew: true }));
}
for (const permissions of [null, undefined, 'not-an-array']) {
  const r = await decide({ role: 'manager', selfId: MGR, changed: [NEW()], rows: new Map(), permissions });
  ok(`a ${String(permissions)} committed matrix reads as the schema defaults (a manager's create is kept)`, r.changed.length === 1);
}

// ── a manager PARED BACK in Settings → Roles or per user: the server holds it too ──
{
  const permissions = without('manager');
  ok('fixture: the pared-back matrix really lacks manager on schedule.edit',
    !permissions.find((p) => p.id === JOB_EDIT_KEY).roles.includes('manager'));
  const c = await decide({ role: 'manager', selfId: MGR, changed: [NEW()], rows: new Map(), permissions });
  ok('pared-back manager: a create is dropped', c.changed.length === 0 && c.adjustments.includes('create a job'));
  ok('pared-back manager: a delete is dropped', (await decide({ role: 'manager', selfId: MGR, removed: ['j1'], permissions })).removed.length === 0);
  const e = await decide({ role: 'manager', selfId: MGR, changed: [job({ crewIds: [MGR], startAt: 'x', status: 'in_progress' })], permissions });
  ok('pared-back manager: crew and time are put back', same(e.changed[0].crewIds, [OTHER]) && e.changed[0].startAt === job().startAt);
  ok('  ...while their status change still lands', e.changed[0].status === 'in_progress');
  ok('  ...one matrix read, then the rows, never a second matrix read', e.reads.authz === 1 && e.reads.rows === 1);
  const g = await decide({ role: 'manager', selfId: MGR, changed: [NEW()], rows: new Map(), permissions,
    overrides: [{ userId: MGR, grants: [JOB_EDIT_KEY], revokes: [] }] });
  ok('a per-user GRANT restores it for a manager whose role lost it', g.changed.length === 1);
  ok('  ...scoped to its member: another manager\'s grant does not reach them',
    (await decide({ role: 'manager', selfId: MGR, changed: [NEW()], rows: new Map(), permissions,
      overrides: [{ userId: MGR2, grants: [JOB_EDIT_KEY], revokes: [] }] })).changed.length === 0);
  ok('  ...and revoke beats grant for the same key',
    (await decide({ role: 'manager', selfId: MGR, changed: [NEW()], rows: new Map(), permissions,
      overrides: [{ userId: MGR, grants: [JOB_EDIT_KEY], revokes: [JOB_EDIT_KEY] }] })).changed.length === 0);
}
ok('a manager with a per-user REVOKE of schedule.edit is sanitized',
  (await decide({ role: 'manager', selfId: MGR, changed: [NEW()], rows: new Map(), overrides: [{ userId: MGR, grants: [], revokes: [JOB_EDIT_KEY] }] })).changed.length === 0);
ok('  ...and a revoke on ANOTHER member does not touch them',
  (await decide({ role: 'manager', selfId: MGR, changed: [NEW()], rows: new Map(), overrides: [{ userId: MGR2, grants: [], revokes: [JOB_EDIT_KEY] }] })).changed.length === 1);
for (const selfId of [null, undefined, '', 5, { id: MGR }]) {
  const r = await decide({ role: 'manager', selfId, changed: [NEW()], rows: new Map() });
  ok(`a manager whose u_* id didn't resolve (${JSON.stringify(selfId) ?? 'undefined'}) holds nothing: sanitized, the matrix never read`,
    r.changed.length === 0 && r.reads.authz === 0);
}

// ── crew: ALWAYS sanitized, whatever they are granted, and they never read the matrix ──
{
  ok('crew: a create is still dropped',
    (await decide({ role: 'crew', changed: [job({ id: 'j_new', crewIds: [ME], siteId: 'victim' })], rows: new Map() })).changed.length === 0);
  ok('crew: a delete is still dropped', (await decide({ role: 'crew', removed: ['j1', 'j2'] })).removed.length === 0);
  const s = await decide({ role: 'crew', changed: [job({ crewIds: [OTHER, ME] })] });
  ok('crew: self-assignment is still put back', same(s.changed[0].crewIds, [OTHER]));
  ok('  ...for the one row read and NO matrix read (crew are decided by role)', s.reads.rows === 1 && s.reads.authz === 0);
  const st = await decide({ role: 'crew', changed: [job({ status: 'in_progress' })] });
  ok('crew: a status change still lands', st.changed[0].status === 'in_progress');
  const T = Date.parse(job().startAt);
  const far = await decide({ role: 'crew', changed: [job({ status: 'in_progress' })], now: T - 25 * 3600e3 });
  ok("🔴 crew: guardJobsDelta judges status on the server's clock (a visit 25 h out goes back)", far.changed[0].status === 'upcoming');
  ok('  ...for ONE row read and NO matrix read (the hot path is unchanged)', st.reads.rows === 1 && st.reads.authz === 0);
  const managerRow = job({ crewIds: ['u_a', 'u_b'], siteId: 's9' });
  const echo = await decide({ role: 'crew', changed: [{ ...managerRow }], rows: prevMap(managerRow) });
  ok('crew: an ECHO passes untouched with NO matrix read',
    same(echo.changed[0], managerRow) && echo.adjustments.length === 0 && echo.reads.authz === 0);
  ok('crew: an echoed DELETE is dropped with no matrix read either',
    (await decide({ role: 'crew', removed: ['j_gone'] })).reads.authz === 0);
}
{
  const GRANT = [{ userId: ME, grants: [JOB_EDIT_KEY], revokes: [] }];
  const grantCreate = await decide({ role: 'crew', changed: [job({ id: 'j_new', crewIds: [ME] })], rows: new Map(), overrides: GRANT });
  ok('🔴 crew with a per-USER grant of schedule.edit are STILL sanitized: a create is dropped', grantCreate.changed.length === 0);
  ok('  ...without the matrix ever being read', grantCreate.reads.authz === 0);
  ok('🔴 crew given schedule.edit in the MATRIX are still sanitized',
    (await decide({ role: 'crew', changed: [NEW()], rows: new Map(), permissions: withRole('crew') })).changed.length === 0);
  const both = await decide({ role: 'crew', changed: [job({ crewIds: [OTHER, ME] })], removed: ['j2'], permissions: withRole('crew'), overrides: GRANT });
  ok('🔴 crew with BOTH: self-assignment put back and the delete dropped',
    same(both.changed[0].crewIds, [OTHER]) && both.removed.length === 0);
}

// ── owner + admin: never tightened, and they read nothing ────────────────────
for (const role of JOB_MANAGER_ROLES) {
  const self = `u_${role}`;
  const r = await decide({
    role, selfId: self, changed: [job({ id: 'j_new', crewIds: [ME] })], removed: ['j1'], rows: new Map(),
    permissions: without(role), overrides: [{ userId: self, grants: [], revokes: [JOB_EDIT_KEY] }],
  });
  ok(`${role} writes whole even with schedule.edit revoked in the matrix AND per user (never tightened)`, r.changed.length === 1 && same(r.removed, ['j1']));
  ok(`  ...and ${role} reads nothing at all`, r.reads.authz === 0 && r.reads.rows === 0);
}

// ── fail closed on an unresolvable or odd role ───────────────────────────────
for (const role of [null, undefined, '', 'Owner', 'Manager', 'superuser', ['owner'], ['manager'], 'constructor', '__proto__']) {
  const r = await decide({ role, changed: [job({ crewIds: [ME] })], removed: ['j1'], permissions: withRole(role) });
  ok(`role ${JSON.stringify(role)} holds nothing, even named in the matrix: sanitized, the matrix never read`,
    !r.changed[0].crewIds.includes(ME) && r.removed.length === 0 && r.reads.authz === 0);
}

// ── a malformed committed matrix / override row reads as MISSING, never a throw ──
// can() calls .find / .includes on these, so one bad row would throw (a 500 on every
// jobs save, which a tab retries every 5 s forever), and a STRING where an array
// belongs would substring-match.
{
  // A throw here IS the bug, so it reads as a named failure, not a crash.
  const created = (args) => decide({ role: 'manager', selfId: MGR, changed: [NEW()], rows: new Map(), ...args })
    .then((r) => r.changed.length, () => 'threw');
  const junk = [null, 7, { id: 5, roles: ['manager'] }, { roles: ['manager'] }];
  ok('junk matrix rows are ignored, not thrown on (a manager keeps the schema default)',
    await created({ permissions: [...junk, ...SEED] }) === 1);
  ok('a schedule.edit row with roles: null does not throw (it reads as missing: the schema default)',
    await created({ permissions: [{ id: JOB_EDIT_KEY, roles: null }] }) === 1);
  ok('an override whose grants is a STRING does not grant (no substring match)',
    await created({ permissions: without('manager'), overrides: [{ userId: MGR, grants: `x ${JOB_EDIT_KEY} y`, revokes: 'no' }] }) === 0);
  ok('junk override rows are ignored, not thrown on',
    await created({ overrides: [null, 5, { userId: 7, revokes: [JOB_EDIT_KEY] }] }) === 1);
  ok('overrides that are not an array read as none',
    await created({ overrides: { [MGR]: { revokes: [JOB_EDIT_KEY] } } }) === 1);
}

// ── a read that fails THROWS (→ 500, and the tab retries): never a silent pass, ──
// ── never a silent put-back of a holder's edit ───────────────────────────────
{
  const throws = async (args) => { try { await decide(args); return false; } catch { return true; } };
  ok('manager: a failed matrix read throws', await throws({ role: 'manager', selfId: MGR, changed: [NEW()], rows: new Map(), authzFails: true }));
  ok('a manager holder never reads the rows, so a row-read failure cannot touch their edit',
    await decide({ role: 'manager', selfId: MGR, changed: [NEW()], rowsFail: true })
      .then((r) => r.changed.length === 1, () => false));
  ok('crew never read the matrix, so its failure never touches a crew write (an escalation attempt is simply sanitized)',
    await decide({ role: 'crew', changed: [job({ crewIds: [ME] })], authzFails: true })
      .then((r) => !r.changed[0].crewIds.includes(ME), () => false));
  ok('a failed row read throws, as before', await throws({ role: 'crew', changed: [job({ status: 'done' })], rowsFail: true }));
  ok('owner / admin never read, so no read failure touches them',
    (await decide({ role: 'owner', changed: [NEW()], authzFails: true, rowsFail: true })).changed.length === 1);
}

// ── the reads never change the answer ────────────────────────────────────────
// guardJobsDelta reads the matrix only for a manager with a resolved id and the rows
// only for someone it will sanitize. Over randomized callers, matrices, overrides and
// deltas, what it commits must equal the plain rule (holdsScheduleEdit ? the delta
// whole : sanitizeJobsDelta), compared as writeJobsDelta sees it (a row without a
// string id is never written), and the reads must follow the promise above.
{
  let seed = 0x5eed;
  const rnd = () => { // mulberry32: deterministic, so a failure reproduces
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const ROLE_POOL = ['owner', 'admin', 'manager', 'crew', null, 'Owner', ''];
  const IDS = ['u_1', 'u_2', null];
  const MATRICES = [SEED, null, without('manager'), withRole('crew'), without('admin'), [{ id: JOB_EDIT_KEY, roles: 'crew' }], []];
  const OVERRIDES = [[], [{ userId: 'u_1', grants: [JOB_EDIT_KEY], revokes: [] }], [{ userId: 'u_1', grants: [], revokes: [JOB_EDIT_KEY] }],
    [{ userId: 'u_2', grants: [JOB_EDIT_KEY] }], [null, { userId: 'u_1', grants: JOB_EDIT_KEY }]];
  const MUTS = { echo: {}, status: { status: 'done' }, crew: { crewIds: ['u_1'] }, site: { siteId: 's_x' }, time: { startAt: 'T' }, notes: { notes: 'n' } };
  const written = (arr) => JSON.stringify((arr || []).filter((j) => j && typeof j.id === 'string' && j.id));
  let cases = 0; let mismatches = 0; let listReads = 0; let strayMatrixReads = 0; let holderRowReads = 0; let crewHolds = 0;
  for (let i = 0; i < 6000; i += 1) {
    const stored = new Map([['j1', job()], ['j2', job({ id: 'j2', crewIds: ['u_a'] })]]);
    const changed = [];
    for (let k = Math.floor(rnd() * 4); k > 0; k -= 1) {
      const mut = pick([...Object.keys(MUTS), 'junk']);
      if (mut === 'junk') { changed.push(pick([null, {}, { id: '' }, 5])); continue; }
      const id = pick(['j1', 'j2', 'j_new']);
      changed.push({ ...(stored.get(id) || job({ id })), ...MUTS[mut] });
    }
    const removed = rnd() < 0.3 ? [pick(['j1', 'j2', 'j_gone'])] : [];
    const role = pick(ROLE_POOL);
    const selfId = pick(IDS);
    const permissions = pick(MATRICES);
    const overrides = pick(OVERRIDES);
    const got = await decide({ role, selfId, changed, removed, permissions, overrides, rows: stored });
    const holds = holdsScheduleEdit({ role, selfId, permissions, overrides });
    const ref = holds ? { changed, removed } : sanitizeJobsDelta({ prev: stored, changed, removed, role });
    cases += 1;
    if (written(got.changed) !== written(ref.changed) || !same(got.removed, ref.removed)) mismatches += 1;
    const listed = JOB_MANAGER_ROLES.includes(role);
    const tier = JOB_MATRIX_ROLES.includes(role) && typeof selfId === 'string' && selfId !== '';
    if (listed && (got.reads.authz || got.reads.rows)) listReads += 1;
    if (!tier && got.reads.authz) strayMatrixReads += 1;
    if (tier && holds && got.reads.rows) holderRowReads += 1;
    if (role === 'crew' && holds) crewHolds += 1;
  }
  ok(`randomized: the committed write equals the plain rule in every case (${cases} cases, ${mismatches} mismatches)`, cases === 6000 && mismatches === 0);
  ok(`randomized: owner / admin never read (${listReads})`, listReads === 0);
  ok(`randomized: nobody but a manager with a resolved id reads the matrix (${strayMatrixReads})`, strayMatrixReads === 0);
  ok(`randomized: a manager who holds it never reads the rows (${holderRowReads})`, holderRowReads === 0);
  ok(`randomized: crew never hold it, whatever the matrix or overrides say (${crewHolds})`, crewHolds === 0);
}

// ── the app offers job edits exactly where the server keeps them ──────────────
// Every job-writing control gates on useCanEditJobs (schedule.edit, never crew), the
// UI twin of the rule above; status-only controls may use the bare key (the server
// keeps status from anyone, within statusChangeKept for whoever it sanitizes, which Job
// Detail's mayMoveTo mirrors: test-site-access.mjs). And the route hands the guard the caller's claim-first
// identity and the COMMITTED readers, never anything from the body.
{
  const src = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
  const hook = src('../src/hooks/usePermission.js');
  ok('useCanEditJobs = the guard\'s tiers: schedule.edit, held by owner / admin or a manager with an id, never crew',
    /export function useCanEditJobs\(\) \{[^}]*usePermission\('schedule\.edit'\);\s*if \(!holds\) return false;\s*if \(user\?\.role === 'owner' \|\| user\?\.role === 'admin'\) return true;\s*return user\?\.role === 'manager' && typeof user\.id === 'string' && user\.id !== '';/.test(hook));
  ok('Schedule gates New Job / drag / top-up on it', /const canCreate = useCanEditJobs\(\);/.test(src('../src/pages/Schedule.jsx')));
  const jd = src('../src/pages/JobDetail.jsx');
  ok('Job Detail gates Edit on it', /const canEditJob = useCanEditJobs\(\);/.test(jd) && /\{canEditJob && !editing && <button[^>]*onClick=\{handleEditClick\}/.test(jd));
  ok('Job Detail gates Delete on it', /\{canEditJob && <button[^>]*onClick=\{handleDeleteClick\}/.test(jd));
  const to = src('../src/components/TimeOffCard.jsx');
  ok('Time off offers "take them off these cleans" only with it',
    /const canEditJobs = useCanEditJobs\(\);/.test(to)
      && /if \(!start \|\| !jobsHydrated \|\| !canEditJobs\) return \[\];/.test(to)
      && /const removable = jobsHydrated && canEditJobs \?/.test(to));
  ok('Dashboard\'s Schedule quick action gates on it', /const canSchedule = useCanEditJobs\(\);/.test(src('../src/pages/Dashboard.jsx')));
  // A NEW surface gating on the bare key is a decision to make on purpose: does it write
  // protected fields? Reviewed: Job Detail's status buttons (status is kept from anyone
  // within statusChangeKept, and they follow it through mayMoveTo),
  // the hook itself, and global search's "New job" action (search renders nothing for
  // crew, and the action only opens Schedule, whose New Job is gated by the hook).
  const bare = ['../src/pages/JobDetail.jsx', '../src/hooks/usePermission.js', '../src/lib/masterSearch/registry.js'];
  const walk = (dir) => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((e) =>
    (e.isDirectory() ? walk(`${dir}${e.name}/`) : /\.jsx?$/.test(e.name) ? [`${dir}${e.name}`] : []));
  const bareUsers = walk('../src/').filter((f) => /usePermission\('schedule\.edit'\)|perm: 'schedule\.edit'/.test(src(f)));
  ok(`only the reviewed surfaces gate on the bare key (found: ${bareUsers.join(', ') || 'none'})`,
    same(bareUsers.sort(), [...bare].sort()));
  const handler = src('../api/state/jobs-delta.js');
  ok('the route passes the caller\'s claim-first role and id', /role: a\.role,/.test(handler) && /selfId: a\.orgUserId,/.test(handler));
  ok('  ...and the COMMITTED readers, passed not called', /readAuthz: readAuthzSlices,/.test(handler) && /readRows: getJobsByIds,/.test(handler));
  ok('  ...authorizes from nothing in the request body', !/body\.(permissions|userPermissionOverrides|role|orgUserId|selfId)/.test(handler));
  ok('  ...and never rejects on this path (no requirePermission, no 403)', !/requirePermission\(|status\(403\)/.test(handler));
  const authz = src('../api/_lib/authz.js');
  ok('the route reads the roster STRICTLY (a failed read is a 500, not "no role")',
    /requireAuthority\(req, res, \{ strictRoster: true \}\)/.test(handler));
  // (Since 2026-09-23 resolveAuthority reads the roster itself, once, for the claim-less
  // lookup AND the status check; the throw sits on that read.)
  ok('  ...only when the role itself comes from the roster (a claimed role keeps the lenient read)',
    /const strict = strictRoster && !claims\.hasRoleClaim;/.test(authz)
      && /users = await readRosterUsers\(\);\s*\} catch \(e\) \{\s*if \(strict\) throw e;/.test(authz));
  // (Since 2026-09-23 the default lives on resolveAuthorityDetailed, which both
  // resolveAuthority and requireAuthority call with the caller's opts unchanged.)
  ok('  ...and every other route keeps the lenient read (strictRoster defaults off)',
    /async function resolveAuthorityDetailed\(req, \{ strictRoster = false \} = \{\}\)/.test(authz)
      && /export async function resolveAuthority\(req, opts\) \{\s*return \(await resolveAuthorityDetailed\(req, opts\)\)\.authority;/.test(authz)
      && /export async function requireAuthority\(req, res, opts\) \{\s*const r = await resolveAuthorityDetailed\(req, opts\);/.test(authz));
}

console.log(`\njobs write guard: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
