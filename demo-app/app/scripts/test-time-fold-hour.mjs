// CS-668 — 1 Nov 2026 (America/New_York, clocks go back at 2 AM): a punch in the REPEATED
// 1 AM hour keeps its instant when edited, and the form can say which 1 AM.
//
// The edit form showed a punch's times on the wall clock (`HH:MM`, no offset) and rebuilt them
// with composeIso, which always picks the FIRST 1:xx (EDT). So a punch in the SECOND 1:xx (EST)
// moved an hour on any save — even a note-only one: +60 min paid on a clock-in, −60 on a
// clock-out — a punch across the fold could not be saved at all (`out-before-in`), Add time
// could not express the second 1:xx, and the history line read "1:15 AM → 1:15 AM".
//
// Pins (pure rules, then the REAL api/time handler over scripts/fake-supabase.mjs with the
// process clock moved to that afternoon, as the audit's verifier did):
//   1. lib/wallClock: the two instants of a repeated wall time, which one an instant is, and
//      composing the chosen one — in the org zone, and in a zone east of UTC (whose composeIso
//      lands on the SECOND occurrence, so the helper must not assume an order); a skipped
//      spring-forward time has none; an ordinary time has one.
//   2. lib/timeEntryForm: a note-only edit of a second-1:xx punch sends no time; changing the
//      minutes keeps the punch's own 1 AM; switching to the other 1 AM is an hour; a NEW time
//      in the repeated hour needs a choice; the fold-crossing punch saves.
//   3. The real `correct` route keeps the durations of the audit's shapes D and E.
//   4. The history line and the punch detail name the zone in the repeated hour.
//
//   node app/scripts/test-time-fold-hour.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
import { validatePunchTimes } from '../src/lib/timeRules.js';

const ORG = '00000000-0000-0000-0000-000000000001';
const TZ = 'America/New_York';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();
const time = (await import('../api/time/[...path].js')).default;
// New with the fix; loaded softly so a pre-fix run reports failures instead of crashing.
const WC = await import('../src/lib/wallClock.js').catch(() => ({}));
const FORM = await import('../src/lib/timeEntryForm.js').catch(() => ({}));

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ═══ 1. the wall clock on the fold night ════════════════════════════════════════
{
  const { wallClockInstants, foldOf, composeWallClock } = WC;
  ok('lib/wallClock exports wallClockInstants / foldOf / composeWallClock / fmtPunchTime',
    [wallClockInstants, foldOf, composeWallClock, WC.fmtPunchTime].every((f) => typeof f === 'function'));
  if (typeof wallClockInstants === 'function') {
    ok('1:15 AM on 1 Nov happened twice: 05:15Z (EDT) and 06:15Z (EST)',
      same(wallClockInstants('2026-11-01', '01:15', TZ), ['2026-11-01T05:15:00.000Z', '2026-11-01T06:15:00.000Z']), JSON.stringify(wallClockInstants('2026-11-01', '01:15', TZ)));
    ok('12:30 AM that night happened once', same(wallClockInstants('2026-11-01', '00:30', TZ), ['2026-11-01T04:30:00.000Z']));
    ok('2:30 AM that night happened once (EST)', same(wallClockInstants('2026-11-01', '02:30', TZ), ['2026-11-01T07:30:00.000Z']));
    ok('1:15 AM on an ordinary night happened once', same(wallClockInstants('2026-10-25', '01:15', TZ), ['2026-10-25T05:15:00.000Z']));
    ok('2:30 AM on 8 Mar (clocks go forward) never happened', same(wallClockInstants('2026-03-08', '02:30', TZ), []));
    ok('east of UTC too: 1:30 AM on 25 Oct in London happened twice (BST, then GMT)',
      same(wallClockInstants('2026-10-25', '01:30', 'Europe/London'), ['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']), JSON.stringify(wallClockInstants('2026-10-25', '01:30', 'Europe/London')));
  }
  if (typeof foldOf === 'function') {
    ok('foldOf: 06:15Z is the SECOND 1:15', foldOf('2026-11-01T06:15:00+00:00', TZ) === 'second');
    ok('foldOf: 05:15Z is the FIRST 1:15', foldOf('2026-11-01T05:15:00.000Z', TZ) === 'first');
    ok('foldOf: seconds do not matter (06:15:27.123Z is still the second)', foldOf('2026-11-01T06:15:27.123+00:00', TZ) === 'second');
    ok('foldOf: an ordinary time is neither', foldOf('2026-11-01T09:15:00.000Z', TZ) === null);
  }
  if (typeof foldOf === 'function' && typeof wallClockInstants === 'function') {
    // foldOf answers most instants from a two-read fast path; it must agree with the definition
    // (two instants share the wall time) at every 5 minutes around the fold, in three shapes of fold.
    const { splitIso } = await import('../src/lib/dates.js');
    let bad = 0; let folds = 0;
    for (const [tz, from] of [[TZ, '2026-10-31T00:00:00Z'], ['Europe/London', '2026-10-24T12:00:00Z'], ['Australia/Lord_Howe', '2026-04-04T00:00:00Z']]) {
      for (let t = Date.parse(from); t < Date.parse(from) + 48 * 3600e3; t += 5 * 60000) {
        const iso = new Date(t).toISOString();
        const { date, time: hm } = splitIso(iso, tz);
        const list = wallClockInstants(date, hm, tz);
        const want = list.length < 2 ? null : (t === Date.parse(list[0]) ? 'first' : 'second');
        if (want) folds += 1;
        if (foldOf(iso, tz) !== want) bad += 1;
      }
    }
    ok(`foldOf agrees with the definition at every 5 min around three folds (${folds} repeated)`, bad === 0 && folds === 60, `${bad} mismatches, ${folds} repeated`);
  }
  if (typeof composeWallClock === 'function') {
    ok('composeWallClock: the second 1:30', composeWallClock('2026-11-01', '01:30', { fold: 'second', tz: TZ }) === '2026-11-01T06:30:00.000Z');
    ok('composeWallClock: the first 1:30', composeWallClock('2026-11-01', '01:30', { fold: 'first', tz: TZ }) === '2026-11-01T05:30:00.000Z');
    ok('composeWallClock: an ordinary time ignores the choice', composeWallClock('2026-11-01', '03:00', { fold: 'second', tz: TZ }) === '2026-11-01T08:00:00.000Z');
  }
}

// ═══ 2. the form ═════════════════════════════════════════════════════════════════
const asEntry = (r) => ({ id: r.id, rowVersion: r.row_version, clockInAt: r.clock_in_at, clockOutAt: r.clock_out_at, note: r.note || '', approvalStatus: r.approval_status });
const D = { id: 'te_dst_A', clock_in_at: '2026-11-01T06:15:00+00:00', clock_out_at: '2026-11-01T09:15:00+00:00', duration_minutes: 180 };
const E = { id: 'te_dst_B', clock_in_at: '2026-11-01T03:00:00+00:00', clock_out_at: '2026-11-01T06:45:00+00:00', duration_minutes: 225 };
const X = { id: 'te_cross', clock_in_at: '2026-11-01T05:40:00+00:00', clock_out_at: '2026-11-01T06:10:00+00:00', duration_minutes: 30 };
const NOW_ON_THE_DAY = Date.parse('2026-11-01T15:00:00Z');
{
  const { openCorrectionForm, buildCorrectionPatch, resolveFormTime } = FORM;
  const forms = typeof openCorrectionForm === 'function' && typeof buildCorrectionPatch === 'function';
  ok('lib/timeEntryForm opens and builds', forms);
  if (forms) {
    const d = openCorrectionForm(asEntry(D), { tz: TZ });
    ok('D opens on 1:15 AM marked as the SECOND one', d.form.inAt === '2026-11-01T01:15' && d.form.inFold === 'second', JSON.stringify(d.form));
    const noteOnly = buildCorrectionPatch({ entry: asEntry(D), form: { ...d.form, note: 'checked' }, initial: d.initial, tz: TZ });
    ok('D, note only: no time is sent', same(noteOnly.patch, { note: 'checked' }), JSON.stringify(noteOnly.patch));
    const minutes = buildCorrectionPatch({ entry: asEntry(D), form: { ...d.form, inAt: '2026-11-01T01:20' }, initial: d.initial, tz: TZ });
    ok('D, minutes changed: the punch keeps ITS 1 AM (06:20Z, not 05:20Z)', same(minutes.patch, { clock_in_at: '2026-11-01T06:20:00.000Z' }), JSON.stringify(minutes.patch));
    const other = buildCorrectionPatch({ entry: asEntry(D), form: { ...d.form, inFold: 'first' }, initial: d.initial, tz: TZ });
    ok('D, the other 1 AM chosen: an hour earlier (05:15Z)', same(other.patch, { clock_in_at: '2026-11-01T05:15:00.000Z' }), JSON.stringify(other.patch));

    const x = openCorrectionForm(asEntry(X), { tz: TZ });
    ok('the fold-crossing punch opens as 1:40 AM (first) → 1:10 AM (second)', x.form.inAt === '2026-11-01T01:40' && x.form.inFold === 'first' && x.form.outAt === '2026-11-01T01:10' && x.form.outFold === 'second', JSON.stringify(x.form));
    const xb = buildCorrectionPatch({ entry: asEntry(X), form: { ...x.form, note: 'ok' }, initial: x.initial, tz: TZ });
    ok('…a note-only save sends no time', same(xb.patch, { note: 'ok' }), JSON.stringify(xb.patch));
    ok('…and validates against its real instants (no out-before-in)', validatePunchTimes({ clockInAt: xb.inIso, clockOutAt: xb.outIso, now: NOW_ON_THE_DAY, requireOut: true }) === null, `${xb.inIso} → ${xb.outIso}`);

    if (typeof resolveFormTime === 'function') {
      const fresh = resolveFormTime({ input: '2026-11-01T01:30', fold: null, tz: TZ });
      ok('Add time at 1:30 AM that night asks which one (no silent guess)', fresh.needsFold === true && fresh.iso == null, JSON.stringify(fresh));
      ok('…the second 1:30 is now expressible (06:30Z)', resolveFormTime({ input: '2026-11-01T01:30', fold: 'second', tz: TZ }).iso === '2026-11-01T06:30:00.000Z');
      ok('…an ordinary time needs no choice', resolveFormTime({ input: '2026-11-01T03:30', fold: null, tz: TZ }).iso === '2026-11-01T08:30:00.000Z');
    }
  }
}

// ═══ 3. the real route keeps the audit's shapes D and E ═══════════════════════════
{
  const roster = [
    { id: 'u_owner', email: 'owner@example.test', role: 'owner', status: 'active', name: 'owner', pay: { type: 'none' } },
    { id: 'u_crew', email: 'crew@example.test', role: 'crew', status: 'active', name: 'crew', pay: { type: 'hourly', hourlyRate: 22 } },
  ];
  const logins = { 'tok-owner': { id: 'auth-owner', email: 'owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } } };
  const punch = (o) => ({ organization_id: ORG, user_id: 'u_crew', client_id: 'cl_a', site_id: 'st_a', job_id: 'j_a', user_name: 'crew', client_name: 'A', site_name: 'Main',
    status: 'completed', approval_status: 'approved', approved_by: 'u_owner', approved_at: '2026-11-01T12:00:00+00:00', row_version: 3, edit_history: [], note: null, updated_at: '2026-11-01T12:00:00+00:00', ...o });
  const realNow = Date.now;
  Date.now = () => NOW_ON_THE_DAY;                              // the route refuses a future clock-in
  try {
    for (const r of [D, E]) {
      const row = punch(r);
      resetWorld({ tables: { org_state: [{ organization_id: ORG, state: { users: roster, permissions: seedPermissions(), userPermissionOverrides: [], clients: [{ id: 'cl_a', name: 'A' }], sites: [{ id: 'st_a', clientId: 'cl_a', name: 'Main' }], opsSettings: {}, company: { timezone: TZ } }, version: 3 }], time_entries: [row], payroll_runs: [], jobs: [], activity_log: [] }, logins });
      let patch = null;
      if (typeof FORM.openCorrectionForm === 'function') {
        const o = FORM.openCorrectionForm(asEntry(row), { tz: TZ });
        patch = FORM.buildCorrectionPatch({ entry: asEntry(row), form: { ...o.form, note: 'checked with cleaner' }, initial: o.initial, tz: TZ }).patch;
      }
      const body = { entryId: row.id, version: 3, patch: patch || {}, reason: 'adding a note only' };
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      req.method = 'POST'; req.headers = { authorization: 'Bearer tok-owner' }; req.query = { subpath: 'correct' }; req.body = body;
      const quiet = { log: console.log, warn: console.warn, error: console.error };
      console.log = console.warn = console.error = () => {};
      let res;
      try {
        res = await new Promise((resolve, reject) => {
          const out = { statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(b) { resolve({ status: this.statusCode, body: b }); return this; }, end(b) { resolve({ status: this.statusCode, body: b ?? null }); return this; } };
          Promise.resolve(time(req, out)).catch(reject);
        });
      } finally { Object.assign(console, quiet); }
      const after = world.tables.time_entries[0];
      ok(`${r.id}: a note-only save lands (200)`, res.status === 200, JSON.stringify(res.body).slice(0, 160));
      ok(`${r.id}: the punch did not move (${r.duration_minutes} min, same instants)`, after.duration_minutes === r.duration_minutes && after.clock_in_at === r.clock_in_at && after.clock_out_at === r.clock_out_at,
        `${after.clock_in_at} → ${after.clock_out_at} = ${after.duration_minutes}`);
      ok(`${r.id}: still approved`, after.approval_status === 'approved', after.approval_status);
    }
  } finally { Date.now = realNow; }
}

// ═══ 4. the office can SEE which 1 AM ════════════════════════════════════════════
{
  if (typeof WC.fmtPunchTime === 'function') {
    ok('a second-1:15 time names its zone (EST)', /EST/.test(WC.fmtPunchTime('2026-11-01T06:15:00.000Z', TZ)), WC.fmtPunchTime('2026-11-01T06:15:00.000Z', TZ));
    ok('a first-1:15 time names its zone (EDT)', /EDT/.test(WC.fmtPunchTime('2026-11-01T05:15:00.000Z', TZ)), WC.fmtPunchTime('2026-11-01T05:15:00.000Z', TZ));
    ok('an ordinary time stays as it was', !/E[SD]T/.test(WC.fmtPunchTime('2026-11-01T09:15:00.000Z', TZ)), WC.fmtPunchTime('2026-11-01T09:15:00.000Z', TZ));
  }
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const read = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'));
  const modal = read('../src/components/TimeEntryModal.jsx');
  const history = read('../src/components/TimeClockHistory.jsx');
  ok('the form offers the choice where the hour repeats', /foldChoices\(/.test(modal) && /segmented-btn/.test(modal));
  ok('the form sends a new time through the fold-aware rule', /resolveFormTime\(\{[^}]*fold/.test(modal));
  ok('the history line and the punch detail name the zone in the repeated hour', /fmtPunchTime\(/.test(history) && !/fmtVal = \(v\) => \(fields\.some\(\(f\) => CLOCK_FIELDS\.has\(f\.trim\(\)\)\) && v \? fmtTime\(v\)/.test(history));
}

console.log(`\ntime-fold-hour: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
}
