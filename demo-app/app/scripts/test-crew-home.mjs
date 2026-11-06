// The Cleaner Hub's Home (Matt's "Cleaner Hub" design, 2026-10-13; plan
// docs/plans/2026-10-13-cleaner-hub.md, brief A): the rules behind the ONE clear action at the top
// of a cleaner's Home, Today's Stops, the live perimeter line and the account manager's buttons.
// Every rule is pure (src/lib/crewHome.js) so it is held here without a browser:
//
//   currentStop({ cleans, entries, now, graceMins, upcoming })   the hero card
//     1. an OPEN punch anywhere (today's clean or last night's carryover) → that clean, Clock Out
//     2. else the first not-done clean whose clock-in window is open (lib/clockInWindow) → Clock In
//     3. else the next clean today → Clock In, not yet open ("Opens at …")
//     4. every clean done → "All done for today" with the day's count
//     5. no cleans → "No stops today" + the next upcoming clean
//   stopRows(…)          Today's Stops: the open punch first, what is still to do by time, done last
//   isTonight(now, tz)   "stops tonight" from 5 PM on the ORG's clock, never the phone's
//   geoPresence(ctx, fix) the live perimeter read, resolved like the server (lib/geo geofenceVerdict)
//   siteLine({ entry, presence }) what a stop says about where the cleaner is: the server's verdict
//                        once punched (PAY-17: off site is HELD, never locked), the live read before
//   accountManager(client, users) who "Message AM" / "Call AM" reach, or why they can't
//
// The constants are read from the modules that own them (clockInWindow's lead, geo's verdict), never
// restated here (THE LAW II.3).
//
//   node app/scripts/test-crew-home.mjs
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);

let pass = 0;
const fails = [];
const ok = (cond, label, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const imp = async (rel) => { try { return await import(rel); } catch { return {}; } };

const dates = await import('../src/lib/dates.js');
dates.setOrgTimezone('America/New_York');
const W = await import('../src/lib/clockInWindow.js');
const geo = await import('../src/lib/geo.js');
const H = await imp('../src/lib/crewHome.js');
const has = (name) => typeof H[name] === 'function';
// Pre-change (no module) every name below is a fresh Symbol, which nothing returned can equal, so a
// missing rule fails its check instead of passing as undefined === undefined.
const never = (names) => Object.fromEntries(names.map((n) => [n, Symbol(n)]));
const HERO = H.HERO || never(['CLOCK_OUT', 'CLOCK_IN', 'NOT_YET', 'ALL_DONE', 'NONE']);
const STOP = H.STOP || never(['NOW', 'UPCOMING', 'MISSED', 'DONE']);
const PRESENCE = H.PRESENCE || never(['INSIDE', 'OUTSIDE', 'UNKNOWN', 'NO_CENTRE', 'OFF']);
const SITE_LINE = H.SITE_LINE || never(['INSIDE', 'OUTSIDE_HELD', 'UNKNOWN', 'ON_SITE', 'OFF_SITE_HELD', 'NO_LOCATION_HELD']);
const AM_REASON = H.AM_REASON || never(['NO_PHONE', 'NO_MANAGER', 'NO_STOP']);

ok(has('currentStop') && has('stopRows') && has('isTonight') && has('geoPresence') && has('siteLine') && has('accountManager'),
  '0.1 the rules live in one pure module (src/lib/crewHome.js)');
ok(!!H.HERO && !!HERO.CLOCK_OUT && !!HERO.CLOCK_IN && !!HERO.NOT_YET && !!HERO.ALL_DONE && !!HERO.NONE, '0.2 the hero has its five kinds, named');

const MIN = 60 * 1000;
// 6:00 PM New York on Oct 13 = 22:00Z.
const NOW = Date.parse('2026-10-13T22:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const job = (id, startMinsFromNow, mins = 120, extra = {}) => ({
  id, clientId: `c_${id}`, siteId: `s_${id}`, status: 'upcoming', crewIds: ['u_me'],
  startAt: iso(NOW + startMinsFromNow * MIN), endAt: iso(NOW + (startMinsFromNow + mins) * MIN), ...extra,
});
const punch = (jobId, inMinsAgo, outMinsAgo = null, extra = {}) => ({
  id: `te_${jobId}_${inMinsAgo}`, job_id: jobId, user_id: 'u_me', clock_in_at: iso(NOW - inMinsAgo * MIN),
  clock_out_at: outMinsAgo == null ? null : iso(NOW - outMinsAgo * MIN), ...extra,
});
const fn = (name, dflt = {}) => (has(name) ? H[name] : () => dflt);
const cs = (args) => (has('currentStop') ? H.currentStop({ now: NOW, graceMins: 120, upcoming: [], ...args }) : {});

// ── 1. the hero card, branch by branch ──────────────────────────────────────────────────────
{
  const a = job('a', -100); // 4:20 PM – 6:20 PM, under way
  const b = job('b', 150);  // 8:30 PM
  let r = cs({ cleans: [a, b], entries: [punch('a', 102)] });
  ok(r.kind === HERO.CLOCK_OUT && r.jobId === 'a' && r.entry?.job_id === 'a' && r.job?.id === 'a',
    '1.1 an open punch on today\'s clean → that clean, Clock Out', JSON.stringify({ kind: r.kind, jobId: r.jobId }));

  // a carryover: last night's clean is off today's list, the punch is still open
  r = cs({ cleans: [b], entries: [punch('yesterday', 26 * 60)] });
  ok(r.kind === HERO.CLOCK_OUT && r.jobId === 'yesterday' && r.job === null,
    '1.2 an open punch from last night (not on today\'s list) still wins → Clock Out', JSON.stringify({ kind: r.kind, jobId: r.jobId }));
  r = cs({ cleans: [b], entries: [punch('yesterday', 26 * 60)], findJob: (id) => (id === 'yesterday' ? { id: 'yesterday' } : null) });
  ok(r.job?.id === 'yesterday', '1.3 …and its clean is looked up when the caller can find it');

  // the open punch beats a clean whose window is open
  const open = job('open', -30);
  r = cs({ cleans: [open, b], entries: [punch('b', 5)] });
  ok(r.kind === HERO.CLOCK_OUT && r.jobId === 'b', '1.4 an open punch beats a clean whose window is open');

  // two open punches (never meant to happen, PAY-13): the newest one
  r = cs({ cleans: [a, b], entries: [punch('a', 200), punch('b', 10)] });
  ok(r.kind === HERO.CLOCK_OUT && r.jobId === 'b', '1.5 with two open punches, the newest clock-in is the one shown');

  // 2. the first not-done clean whose window is open
  const late = job('late', -75, 60);       // 4:45–5:45 PM, nobody in (window open to 7:45)
  const lasOlas = job('lasolas', -12, 120); // started 12 minutes ago
  r = cs({ cleans: [late, lasOlas, b], entries: [] });
  ok(r.kind === HERO.CLOCK_IN && r.jobId === 'late', '2.1 no open punch → the FIRST not-done clean whose window is open, Clock In', JSON.stringify({ kind: r.kind, jobId: r.jobId }));

  // a done clean is skipped; done = a closed punch of mine, or the job marked done
  r = cs({ cleans: [late, lasOlas, b], entries: [punch('late', 70, 20)] });
  ok(r.kind === HERO.CLOCK_IN && r.jobId === 'lasolas', '2.2 a clean I clocked out of is done and skipped');
  r = cs({ cleans: [{ ...late, status: 'done' }, lasOlas], entries: [] });
  ok(r.kind === HERO.CLOCK_IN && r.jobId === 'lasolas', '2.3 a clean the office (or the last cleaner out) marked done is skipped');
  r = cs({ cleans: [{ ...late, status: 'missed' }, lasOlas], entries: [] });
  ok(r.kind === HERO.CLOCK_IN && r.jobId === 'late', '2.4 a clean marked missed whose window is still open can still be clocked into');

  // the window is lib/clockInWindow's: a clean that ended 100 minutes ago is open with the default
  // grace, closed with a 60-minute one
  const ended = job('ended', -160, 60); // ended 100 min ago
  r = cs({ cleans: [ended, b], entries: [], graceMins: 120 });
  ok(r.kind === HERO.CLOCK_IN && r.jobId === 'ended', '2.5 the office\'s grace keeps a just-ended clean open (120 min)');
  r = cs({ cleans: [ended, b], entries: [], graceMins: 60 });
  ok(r.kind === HERO.NOT_YET && r.jobId === 'b', '2.6 …and a shorter grace closes it, so the next clean is the one shown', JSON.stringify({ kind: r.kind, jobId: r.jobId }));

  // 3. the next clean today, not open yet
  r = cs({ cleans: [b], entries: [] });
  const opensAt = W.clockInWindow(b, { graceMins: 120 }).opensAt;
  ok(r.kind === HERO.NOT_YET && r.jobId === 'b' && r.opensAt === opensAt,
    '3.1 nothing open yet → the next clean, not yet open, with when it opens (lib/clockInWindow)', JSON.stringify({ kind: r.kind, opensAt: r.opensAt, want: opensAt }));
  ok(opensAt === Date.parse(b.startAt) - W.CLOCK_IN_LEAD_MS, '3.2 …which is the window\'s own lead before the start');

  // 4. all done
  r = cs({ cleans: [late, lasOlas], entries: [punch('late', 70, 20), punch('lasolas', 10, 1)] });
  ok(r.kind === HERO.ALL_DONE && r.done === 2 && r.total === 2, '4.1 every clean done → all done, with the day\'s count', JSON.stringify(r));
  r = cs({ cleans: [ended, lasOlas], entries: [punch('lasolas', 10, 1)], graceMins: 60 });
  ok(r.kind === HERO.ALL_DONE && r.done === 1 && r.total === 2, '4.2 a clean whose window closed with no punch is not counted as done', JSON.stringify(r));

  // 5. no cleans
  const tomorrow = job('tomorrow', 20 * 60);
  r = cs({ cleans: [], entries: [], upcoming: [tomorrow] });
  ok(r.kind === HERO.NONE && r.next?.id === 'tomorrow', '5.1 no cleans today → "No stops today" with the next upcoming clean');
  r = cs({ cleans: [], entries: [], upcoming: [] });
  ok(r.kind === HERO.NONE && r.next === null, '5.2 …and none at all → no next clean');
  r = cs({ cleans: [{ ...b, status: 'cancelled' }], entries: [], upcoming: [] });
  ok(r.kind === HERO.NONE, '5.3 a cancelled clean is not a stop');
  r = cs({ cleans: [], entries: [punch('yesterday', 26 * 60)] });
  ok(r.kind === HERO.CLOCK_OUT, '5.4 no cleans, but a punch still open → Clock Out (never stranded on the clock)');
}

// ── 2. Today's Stops ────────────────────────────────────────────────────────────────────────
{
  const done = job('done', -330);
  const now1 = job('now1', -36, 90);
  const next = job('next', 70, 45);
  const later = job('later', 200, 60);
  const rows = fn('stopRows', [])({
    cleans: [done, now1, next, later],
    entries: [punch('done', 333, 212), punch('now1', 38), punch('carry', 25 * 60)],
    now: NOW, graceMins: 120, findJob: () => null,
  });
  const ids = rows.map((r) => r.jobId);
  ok(ids.join(',') === 'carry,now1,next,later,done',
    '6.1 the open punches first (last night\'s carryover first of all), then what is still to do by time, then what is done', ids.join(','));
  const st = Object.fromEntries(rows.map((r) => [r.jobId, r.state]));
  ok(st.carry === STOP.NOW && st.now1 === STOP.NOW && st.next === STOP.UPCOMING && st.done === STOP.DONE, '6.2 each row carries its state', JSON.stringify(st));
  ok(rows.find((r) => r.jobId === 'carry')?.carryover === true && rows.find((r) => r.jobId === 'now1')?.carryover === false,
    '6.3 the carryover row says so (its clean is not on today\'s list)');
  const missed = fn('stopRows', [])({ cleans: [job('gone', -400, 60)], entries: [], now: NOW, graceMins: 120 });
  ok(missed[0]?.state === STOP.MISSED, '6.4 a clean whose window closed with no punch reads missed');
  const coWorker = fn('stopRows', [])({ cleans: [{ ...next, status: 'in_progress' }], entries: [], now: NOW, graceMins: 120 });
  ok(coWorker[0]?.state === STOP.UPCOMING, '6.5 a co-worker\'s clock-in does not make the clean "in progress" for me (my own punch decides)');
}

// ── 3. "tonight" is the org's 5 PM, never the phone's ───────────────────────────────────────
{
  ok(fn('isTonight')(Date.parse('2026-10-13T20:59:00.000Z'), 'America/New_York') === false, '7.1 4:59 PM in New York → today');
  ok(fn('isTonight')(Date.parse('2026-10-13T21:00:00.000Z'), 'America/New_York') === true, '7.2 5:00 PM in New York → tonight');
  // 18:00Z is 2 PM in New York: tonight for a UTC device, today for the org
  ok(fn('isTonight')(Date.parse('2026-10-13T18:00:00.000Z'), 'America/New_York') === false, '7.3 the org\'s zone decides, not the instant\'s UTC hour');
  ok(fn('isTonight')(Date.parse('2026-10-14T03:30:00.000Z'), 'America/New_York') === true, '7.4 11:30 PM in New York is still tonight');
  ok(H.TONIGHT_FROM_HOUR === 17, '7.5 the hour is a named constant');
}

// ── 4. the live perimeter read ──────────────────────────────────────────────────────────────
{
  const SITE = { lat: 26.3478, lng: -80.0831 };
  const ctx = { siteLat: SITE.lat, siteLng: SITE.lng, radiusM: geo.DEFAULT_GEOFENCE_RADIUS_M, geofenceEnabled: true };
  const near = { lat: SITE.lat + 0.0002, lng: SITE.lng, accuracyM: 5 };   // ~22 m
  const far = { lat: SITE.lat + 0.01, lng: SITE.lng, accuracyM: 5 };      // ~1.1 km
  const r1 = fn('geoPresence')(ctx, near);
  ok(r1.state === PRESENCE.INSIDE && Number.isFinite(r1.distanceM), '8.1 a phone inside the ring → inside', JSON.stringify(r1));
  const r2 = fn('geoPresence')(ctx, far);
  ok(r2.state === PRESENCE.OUTSIDE && r2.distanceM > 1000, '8.2 a phone a kilometre away → outside', JSON.stringify(r2));
  ok(fn('geoPresence')({ ...ctx, siteLat: null, siteLng: null }, near).state === PRESENCE.NO_CENTRE, '8.3 a location with no centre → no ring (noCentre)');
  ok(fn('geoPresence')({ ...ctx, geofenceEnabled: false }, far).state === PRESENCE.OFF, '8.4 the ring switched off (the site, or this cleaner\'s clockRules) → off');
  ok(fn('geoPresence')(ctx, null).state === PRESENCE.UNKNOWN, '8.5 no fix yet (or Location denied) → unknown');
  ok(fn('geoPresence')(null, near).state === PRESENCE.UNKNOWN, '8.6 no clean → unknown');
  // the same verdict the server would reach, accuracy widening included
  const edge = { lat: SITE.lat + 0.0009, lng: SITE.lng, accuracyM: 40 };  // ~100 m, ring 76 m + 40 m accuracy
  const v = geo.geofenceVerdict({ siteLat: SITE.lat, siteLng: SITE.lng, deviceLat: edge.lat, deviceLng: edge.lng, accuracyM: edge.accuracyM, radiusM: ctx.radiusM });
  const r3 = fn('geoPresence')(ctx, edge);
  ok(r3.state === (v.result === 'inside' ? PRESENCE.INSIDE : PRESENCE.OUTSIDE) && r3.distanceM === v.distanceM,
    '8.7 the read is lib/geo\'s geofenceVerdict (the GPS accuracy widens the ring, as on the server)', JSON.stringify({ r3, v }));
  ok(fn('geoPresence')({ ...ctx, radiusM: 2000 }, far).state === PRESENCE.INSIDE, '8.8 the radius is the clean\'s own (shift → site → company default, resolved by the caller)');
}

// ── 5. what a stop says about where the cleaner is ──────────────────────────────────────────
{
  const L = (entry, presence) => fn('siteLine')({ entry, presence });
  ok(L(null, { state: PRESENCE.INSIDE }) === SITE_LINE.INSIDE, '9.1 before the punch, inside → "Inside site perimeter"');
  ok(L(null, { state: PRESENCE.OUTSIDE }) === SITE_LINE.OUTSIDE_HELD,
    '9.2 before the punch, outside → the PAY-17 line (time held for approval), never a lock');
  ok(L(null, { state: PRESENCE.NO_CENTRE }) === null && L(null, { state: PRESENCE.OFF }) === null, '9.3 no centre or ring off → nothing');
  ok(L(null, { state: PRESENCE.UNKNOWN }) === SITE_LINE.UNKNOWN, '9.4 no fix → it says it cannot see the location');
  const open = { geofence_result: 'inside', clock_out_at: null };
  ok(L(open, { state: PRESENCE.OUTSIDE }) === SITE_LINE.ON_SITE, '9.5 once punched, the SERVER\'s verdict, not the phone\'s live read');
  ok(L({ geofence_result: 'outside', clock_out_at: null }, { state: PRESENCE.INSIDE }) === SITE_LINE.OFF_SITE_HELD, '9.6 a punch made off site stays "held for review"');
  ok(L({ geofence_result: 'unavailable', clock_out_at: null }, null) === SITE_LINE.NO_LOCATION_HELD, '9.7 a punch with no location stays "held for review"');
  ok(L({ geofence_result: 'no_site_coords', clock_out_at: null }, { state: PRESENCE.INSIDE }) === null, '9.8 a punch the server could not judge says nothing');
}

// ── 6. the account manager ──────────────────────────────────────────────────────────────────
{
  const users = [{ id: 'u_am', name: 'Renata Cruz', role: 'manager', phone: '1-754-555-0105' }, { id: 'u_nop', name: 'No Phone', role: 'manager', phone: '' }];
  const a1 = fn('accountManager')({ supervisorId: 'u_am' }, users);
  ok(a1.user?.id === 'u_am' && a1.phone === '1-754-555-0105' && a1.reason === null, '10.1 the customer\'s supervisor, with a phone → both buttons live');
  const a2 = fn('accountManager')({ supervisorId: 'u_nop' }, users);
  ok(a2.user?.id === 'u_nop' && a2.phone === null && a2.reason === AM_REASON.NO_PHONE, '10.2 no phone on file → Call is off and says why');
  const a3 = fn('accountManager')({ supervisorId: null }, users);
  ok(a3.user === null && a3.reason === AM_REASON.NO_MANAGER, '10.3 no account manager → both off, with the reason');
  const a4 = fn('accountManager')(null, users);
  ok(a4.user === null && a4.reason === AM_REASON.NO_STOP, '10.4 no stop at all → both off, with the reason');
  const a5 = fn('accountManager')({ supervisorId: 'u_gone' }, users);
  ok(a5.user === null && a5.reason === AM_REASON.NO_MANAGER, '10.5 a supervisor no longer on the team counts as none');
}

// ── 7. the checklist's progress with the draft on the phone (integration: B's draft) ─────────
// Home's tile and the hero read the stored submission (the shared gate) and, when none is stored
// yet, the unsaved draft on the phone — counted by the SAME rule the checklist page and the server
// use (lib/checklistCount countChecklistSubmission over lib/checklistDraft draftItems + the draft's
// photo keys), never the draft's own say-so.
const GATE = (await imp('../src/lib/crewChecklist.js')).GATE || {};
const SCHEMA = { areas: [{ id: 'a1', label: 'Lobby', items: [{ id: 'i1', label: 'Mop' }, { id: 'i2', label: 'Glass', photoRequired: true }, { id: 'i3', label: 'Bins', naAllowed: true }] }] };
const draftOf = (checks, photos = {}) => ({ submissionId: 'cs_x', checks, photos, schema: SCHEMA, savedAt: new Date(NOW).toISOString() });
{
  const cp = fn('checklistProgress', null);
  let r = cp({ gate: { state: GATE.BLOCKED, done: 0, total: 0 }, draft: draftOf({ i1: { checked: true }, i3: { na: true } }) });
  ok(r && r.source === 'draft' && r.done === 2 && r.total === 3 && r.ready === false,
    '11.1 no submission stored: the draft on the phone counts — ticked and an allowed N/A', JSON.stringify(r));
  r = cp({ gate: { state: GATE.BLOCKED, done: 0, total: 0 }, draft: draftOf({ i1: { checked: true }, i2: { checked: true }, i3: { na: true } }) });
  ok(r && r.done === 2 && r.ready === false, '11.2 …a photo-required task ticked with no photo on the phone does not count (CS-547)', JSON.stringify(r));
  r = cp({ gate: { state: GATE.BLOCKED, done: 0, total: 0 }, draft: draftOf({ i1: { checked: true }, i2: { checked: true }, i3: { notCompleted: true, reason: 'Bin room locked' } }, { i2: 1 }) });
  ok(r && r.done === 3 && r.total === 3 && r.ready === true, '11.3 …with its photo, and a "not completed" with a reason, the draft is ready to save', JSON.stringify(r));
  r = cp({ gate: { state: GATE.BLOCKED, done: 0, total: 0 }, draft: draftOf({ i1: { notCompleted: true, reason: '' } }) });
  ok(r && r.done === 0, '11.4 …a "not completed" with no reason counts nothing', JSON.stringify(r));
  r = cp({ gate: { state: GATE.BLOCKED, done: 4, total: 9 }, draft: draftOf({ i1: { checked: true } }) });
  ok(r && r.source === 'saved' && r.done === 4 && r.total === 9, '11.5 a stored submission is what counts when there is one', JSON.stringify(r));
  r = cp({ gate: { state: GATE.DONE, done: 9, total: 9 }, draft: null });
  ok(r && r.source === 'saved' && r.done === 9 && r.ready === false && r.complete === true, '11.6 a complete stored submission reads done (nothing to save)', JSON.stringify(r));
  ok(cp({ gate: { state: GATE.BLOCKED, done: 0, total: 0 }, draft: null }) === null, '11.7 no submission and no draft → not started (no number)');
  ok(cp({ gate: { state: GATE.BLOCKED, done: 0, total: 0 }, draft: { ...draftOf({ i1: { checked: true } }), schema: undefined } }) === null,
    '11.8 a draft with no checklist kept on it is not counted (no number it does not have)');
}

// ── 8. what Clock out does with a draft on the phone ────────────────────────────────────────
//   (a) a FINISHED draft not saved yet → "Save checklist & clock out": save first, then clock out;
//   (b) the lock OFF for this cleaner (clockRules.checklistBlockOff) and a PARTIAL draft → save it
//       first so the office sees what was done, then clock out;
//   otherwise a plain clock-out (the lock still holds a partial draft back).
{
  const plan = fn('clockOutPlan', null);
  const P = H.CLOCK_OUT_PLAN || never(['OUT', 'SAVE_THEN_OUT', 'SAVE_PARTIAL_THEN_OUT']);
  const full = draftOf({ i1: { checked: true }, i2: { checked: true }, i3: { na: true } }, { i2: 1 });
  const part = draftOf({ i1: { checked: true } });
  ok(plan({ gate: { state: GATE.BLOCKED, done: 0, total: 0 }, draft: full }) === P.SAVE_THEN_OUT, '12.1 (a) a finished, unsaved draft → save, then clock out');
  ok(plan({ gate: { state: GATE.OFF, done: 0, total: 0 }, draft: full }) === P.SAVE_THEN_OUT, '12.2 (a) …whether or not the lock applies to this cleaner');
  ok(plan({ gate: { state: GATE.OFF, done: 0, total: 0 }, draft: part }) === P.SAVE_PARTIAL_THEN_OUT, '12.3 (b) lock off + a partial draft → save the partial, then clock out');
  ok(plan({ gate: { state: GATE.BLOCKED, done: 0, total: 0 }, draft: part }) === P.OUT, '12.4 lock on + a partial draft → no save (the lock still holds the button)');
  ok(plan({ gate: { state: GATE.DONE, done: 3, total: 3 }, draft: null }) === P.OUT, '12.5 a saved checklist → a plain clock-out');
  ok(plan({ gate: { state: GATE.NONE }, draft: null }) === P.OUT, '12.6 no checklist → a plain clock-out');
  ok(plan({ gate: { state: GATE.OFF }, draft: draftOf({}) }) === P.OUT, '12.7 lock off + an untouched draft → nothing to save');
  ok(plan({ gate: { state: GATE.DONE, done: 3, total: 3 }, draft: full }) === P.OUT, '12.8 a stored complete submission wins over a stray draft (never saved twice)');
}

console.log(`\ntest-crew-home: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
if (fails.length) process.exitCode = 1;
