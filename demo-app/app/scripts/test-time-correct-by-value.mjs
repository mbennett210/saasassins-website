// CS-694 — editing only the note of an approved punch no longer sends it back to "needs approval".
//
// The edit form re-sent BOTH clock times on every save, rebuilt at minute precision
// (`...:00.000Z`), and the server compared instants by their SPELLING. Production returns
// `timestamptz` as `+00:00` (with seconds and milliseconds on real clock-ins), so every save was a
// "time change": the seconds were lost, two history lines were written for times nobody touched,
// and the approved punch dropped back to pending, out of pay until someone re-approved it.
//
// Both halves, through the REAL api/time handler over scripts/fake-supabase.mjs (the audit's
// f403 shapes A/B/C — no network, no credentials):
//   1. THE FORM sends only what the person changed (lib/timeEntryForm buildCorrectionPatch): a
//      note-only edit sends the note and nothing else, so a clock-in with seconds keeps them.
//   2. THE SERVER compares instants by VALUE (lib/timeRules sameInstant / correctionChanges): an
//      old cached bundle that still re-sends both times unchanged changes nothing but the note;
//      a save that changes nothing writes nothing at all; a real time change still asks for
//      approval again.
//   3. The same class in the offline replay (an asserted time equal to the stored one by value
//      is not "a different time arrived"), and in the demo stub (source-pinned: it cannot load in
//      bare Node), and the form itself.
//
//   node app/scripts/test-time-correct-by-value.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
import * as rules from '../src/lib/timeRules.js';

const ORG = '00000000-0000-0000-0000-000000000001';
const TZ = 'America/New_York';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();
const time = (await import('../api/time/[...path].js')).default;
// The form's rule (new with the fix), loaded softly so a pre-fix run reports, not crashes.
const FORM = await import('../src/lib/timeEntryForm.js').catch(() => ({}));

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', pay: { type: 'none' } },
  crew: { id: 'u_crew', role: 'crew', pay: { type: 'hourly', hourlyRate: 22 } },
};
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: `${k}@example.test`, role: p.role, status: 'active', name: k, pay: p.pay }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, { id: `auth-${k}`, email: `${k}@example.test`, app_metadata: { role: p.role, org_user_id: p.id, org_id: ORG } }]));

// A punch in the shape PostgREST returns it (probe q-f4: `+00:00`, `.mmm` only when present).
const punch = (o) => ({
  organization_id: ORG, user_id: 'u_crew', client_id: 'cl_a', site_id: 'st_a', job_id: 'j_a',
  user_name: 'crew', client_name: 'A', site_name: 'Main', status: 'completed',
  approval_status: 'approved', approved_by: 'u_owner', approved_at: '2026-10-09T12:00:00+00:00',
  row_version: 3, edit_history: [], note: null, updated_at: '2026-10-09T12:00:00+00:00', ...o,
});
const A = () => punch({ id: 'te_sec', clock_in_at: '2026-10-08T13:02:50.123+00:00', clock_out_at: '2026-10-08T17:31:10.456+00:00', duration_minutes: 268 });
const B = () => punch({ id: 'te_min', clock_in_at: '2026-10-08T13:02:00+00:00', clock_out_at: '2026-10-08T17:31:00+00:00', duration_minutes: 269 });
const C = () => punch({ id: 'te_z', clock_in_at: '2026-10-08T13:02:00.000Z', clock_out_at: '2026-10-08T17:31:00.000Z', duration_minutes: 269 });

function buildWorld(entries, jobs = []) {
  const state = {
    users: roster, permissions: seedPermissions(), userPermissionOverrides: [],
    clients: [{ id: 'cl_a', name: 'A', supervisorId: null }], sites: [{ id: 'st_a', clientId: 'cl_a', name: 'Main' }],
    opsSettings: { payWeekStartDay: 1, offlineReplayWindowHours: 12 }, company: { timezone: TZ },
  };
  resetWorld({ tables: { org_state: [{ organization_id: ORG, state, version: 3 }], time_entries: entries.map((e) => ({ ...e })), payroll_runs: [], jobs, checklist_results: [], activity_log: [] }, logins });
}
async function call(path, body, who = 'owner') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST'; req.headers = { authorization: `Bearer tok-${who}` }; req.query = { subpath: path }; req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${path}: no response`)), 8000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; } };
      Promise.resolve(time(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const row = (id) => world.tables.time_entries.find((e) => e.id === id);
const fields = (e) => (e?.edit_history || []).map((h) => h.field);
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
// The modal's neutral entry shape (Approvals toCorrectTarget / TimeClockHistory / Variance).
const asEntry = (r) => ({ id: r.id, rowVersion: r.row_version, clockInAt: r.clock_in_at, clockOutAt: r.clock_out_at, note: r.note || '', approvalStatus: r.approval_status });

// ═══ 1. the form sends only what changed ════════════════════════════════════════
{
  ok('lib/timeEntryForm exports the patch builder', typeof FORM.buildCorrectionPatch === 'function' && typeof FORM.openCorrectionForm === 'function');
  if (typeof FORM.buildCorrectionPatch === 'function' && typeof FORM.openCorrectionForm === 'function') {
    for (const [label, mk] of [['A (seconds + ms)', A], ['B (whole minutes, +00:00)', B], ['C (the client\'s own spelling)', C]]) {
      const r = mk();
      buildWorld([r]);
      const { form, initial } = FORM.openCorrectionForm(asEntry(r), { tz: TZ });
      const built = FORM.buildCorrectionPatch({ entry: asEntry(r), form: { ...form, note: 'checked with cleaner' }, initial, tz: TZ });
      ok(`${label}: a note-only edit sends ONLY the note`, JSON.stringify(built.patch) === JSON.stringify({ note: 'checked with cleaner' }), JSON.stringify(built.patch));
      const res = await call('correct', { entryId: r.id, version: r.row_version, patch: built.patch, reason: 'adding a note only' });
      const after = row(r.id);
      ok(`${label}: saved (200)`, res.status === 200, show(res));
      ok(`${label}: still APPROVED`, after.approval_status === 'approved' && !!after.approved_at, `${after.approval_status} ${after.approved_at}`);
      ok(`${label}: both times untouched, to the millisecond`, after.clock_in_at === r.clock_in_at && after.clock_out_at === r.clock_out_at, `${after.clock_in_at} ${after.clock_out_at}`);
      ok(`${label}: the duration is unchanged`, after.duration_minutes === r.duration_minutes, `${after.duration_minutes}`);
      ok(`${label}: ONE history line, the note's`, JSON.stringify(fields(after)) === '["note"]', JSON.stringify(fields(after)));
    }
    // A real change still sends that one field, and is still a time change.
    const r = B();
    const { form, initial } = FORM.openCorrectionForm(asEntry(r), { tz: TZ });
    const built = FORM.buildCorrectionPatch({ entry: asEntry(r), form: { ...form, outAt: '2026-10-08T13:45' }, initial, tz: TZ });
    ok('changing the clock-out sends the clock-out only', Object.keys(built.patch).join() === 'clock_out_at' && built.patch.clock_out_at === '2026-10-08T17:45:00.000Z' && built.timeChanged === true, JSON.stringify(built));
    ok('…and validation reads the ORIGINAL clock-in it did not touch', built.inIso === r.clock_in_at, built.inIso);
    const none = FORM.buildCorrectionPatch({ entry: asEntry(r), form, initial, tz: TZ });
    ok('a save with nothing changed builds an empty patch', Object.keys(none.patch).length === 0 && none.timeChanged === false, JSON.stringify(none.patch));
  }
}

// ═══ 2. the server compares by VALUE ═══════════════════════════════════════════════
{
  ok('lib/timeRules exports sameInstant + correctionChanges', typeof rules.sameInstant === 'function' && typeof rules.correctionChanges === 'function');
  if (typeof rules.sameInstant === 'function') {
    ok('sameInstant: +00:00 and .000Z name the same instant', rules.sameInstant('2026-10-08T13:02:00+00:00', '2026-10-08T13:02:00.000Z'));
    ok('sameInstant: a dropped second is a different instant', !rules.sameInstant('2026-10-08T13:02:50.123+00:00', '2026-10-08T13:02:00.000Z'));
    ok('sameInstant: absent equals absent, not a time', rules.sameInstant(null, undefined) && !rules.sameInstant(null, '2026-10-08T13:02:00Z'));
  }
  // An OLD bundle's patch: both times re-sent at minute precision in the client's spelling.
  const r = B();
  buildWorld([r]);
  const res = await call('correct', { entryId: r.id, version: 3, patch: { note: 'checked', clock_in_at: '2026-10-08T13:02:00.000Z', clock_out_at: '2026-10-08T17:31:00.000Z' }, reason: 'note' });
  const after = row(r.id);
  ok('B + an old bundle re-sending both times unchanged: saved', res.status === 200, show(res));
  ok('…still APPROVED (the times are the same instants)', after.approval_status === 'approved', after.approval_status);
  ok('…only the note is in the history', JSON.stringify(fields(after)) === '["note"]', JSON.stringify(fields(after)));
  ok('…and the stored times keep their own spelling', after.clock_in_at === r.clock_in_at && after.clock_out_at === r.clock_out_at, `${after.clock_in_at}`);

  // A save that changes nothing writes nothing.
  buildWorld([B()]);
  const before = structuredClone(row('te_min'));
  const noop = await call('correct', { entryId: 'te_min', version: 3, patch: { clock_in_at: '2026-10-08T13:02:00.000Z', clock_out_at: '2026-10-08T17:31:00.000Z' }, reason: 'opened and saved' });
  ok('a save that changes nothing answers 200', noop.status === 200, show(noop));
  ok('…and writes NOTHING (row byte-for-byte unchanged, no version bump, no "Edited")', JSON.stringify(row('te_min')) === JSON.stringify(before), JSON.stringify(row('te_min')).slice(0, 200));
  ok('…and logs no time correction', !(world.tables.activity_log || []).some((x) => x.action === 'time.corrected'), JSON.stringify(world.tables.activity_log).slice(0, 200));

  // A real time change still goes back to pending (the rule the fix must not lose).
  buildWorld([B()]);
  const real = await call('correct', { entryId: 'te_min', version: 3, patch: { clock_out_at: '2026-10-08T17:45:00.000Z' }, reason: 'left at 1:45' });
  const changed = row('te_min');
  ok('a REAL time change still needs approval again', real.status === 200 && changed.approval_status === 'pending' && changed.clock_out_at === '2026-10-08T17:45:00.000Z' && changed.duration_minutes === 283,
    `${changed.approval_status} ${changed.clock_out_at} ${changed.duration_minutes}`);
}

// ═══ 3. the same class: the offline replay ═══════════════════════════════════════
{
  const job = { organization_id: ORG, id: 'j_a', site_id: 'st_a', status: 'in_progress', start_at: '2026-10-08T12:00:00+00:00',
    data: { id: 'j_a', siteId: 'st_a', clientId: 'cl_a', crewIds: ['u_crew'], startAt: '2026-10-08T12:00:00.000Z', endAt: '2026-10-08T18:00:00.000Z', status: 'in_progress' } };
  // An OPEN row the online clock-in wrote; the phone's buffered twin asserts the same instant.
  const now = new Date(Date.now() - 60 * 60000);
  const pgIn = now.toISOString().replace('Z', '+00:00').replace(/\.\d{3}\+/, '+');   // PostgREST spelling, whole second
  const asserted = new Date(Date.parse(pgIn)).toISOString();                          // the phone's spelling
  buildWorld([punch({ id: 'te_open', job_id: 'j_a', status: 'in_progress', approval_status: 'pending', approved_by: null, approved_at: null, clock_in_at: pgIn, clock_out_at: null, duration_minutes: null, client_punch_id: 'op_online' })], [job]);
  const r1 = await call('replay', { clientPunchId: 'op_buffered', jobId: 'j_a', assertedInAt: asserted }, 'crew');
  ok('replay: a buffered clock-in asserting the SAME instant resolves to the open row', r1.status === 200 && r1.body?.idempotent === true, show(r1));
  ok('…without an "offline clock-in arrived" line (nothing different arrived)', !fields(row('te_open')).includes('offline_clock_in_arrived'), JSON.stringify(row('te_open').edit_history));

  // A closed row found by its punch id; the replay asserts the same clock-out in another spelling.
  const outPg = new Date(Date.parse(pgIn) + 30 * 60000).toISOString().replace('.000Z', '+00:00');
  buildWorld([punch({ id: 'te_closed', job_id: 'j_a', status: 'completed', approval_status: 'pending', approved_by: null, approved_at: null, clock_in_at: pgIn, clock_out_at: outPg, duration_minutes: 30, client_punch_id: 'op_same' })], [job]);
  const r2 = await call('replay', { clientPunchId: 'op_same', jobId: 'j_a', assertedInAt: asserted, assertedOutAt: new Date(Date.parse(outPg)).toISOString() }, 'crew');
  ok('replay: the same clock-out in another spelling is idempotent', r2.status === 200 && r2.body?.idempotent === true, show(r2));
  ok('…without an "offline clock-out arrived" line', !fields(row('te_closed')).includes('offline_clock_out_arrived'), JSON.stringify(row('te_closed').edit_history));
}

// ═══ 4. one rule at every call site ══════════════════════════════════════════════
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const read = (p) => strip(readFileSync(new URL(p, import.meta.url), 'utf8'));
  const store = read('../api/_lib/time/store.js');
  const stub = read('../src/lib/timeApi.js');
  const modal = read('../src/components/TimeEntryModal.jsx');
  const fnBody = (src, name) => { const i = src.indexOf(name); return i < 0 ? '' : src.slice(i, i + 2600); };
  ok('the server correction compares through correctionChanges', /correctionChanges\(/.test(fnBody(store, 'export async function correctEntryRow')));
  ok('the demo stub correction compares through correctionChanges', /correctionChanges\(/.test(fnBody(stub, 'function stubCorrect')));
  ok('the form builds its patch through buildCorrectionPatch', /buildCorrectionPatch\(/.test(modal) && /openCorrectionForm\(/.test(modal));
  // The class guard: no punch instant compared by its spelling in the store, the stub or the form.
  const INSTANT = '(?:clock_in_at|clock_out_at|clockInAt|clockOutAt|assertedInAt|assertedOutAt|origIn|origOut|inIso|outIso|newIn|newOut)';
  const leftSide = new RegExp(`\\b${INSTANT}\\b\\s*[!=]==\\s*(?!null\\b|undefined\\b|['"])[A-Za-z_]`);
  const rightSide = new RegExp(`[A-Za-z_\\])]\\s*[!=]==\\s*(?:[A-Za-z_]\\w*\\.)?${INSTANT}\\b`);
  // `patch[field] !== row[field]` over the time fields was the server's original spelling compare.
  const fieldLoop = /patch\[field\]\s*!==\s*row\[field\]|patch\[field\]\s*!==\s*e\[field\]/;
  for (const [name, src] of [['store.js', store], ['timeApi.js', stub], ['TimeEntryModal.jsx', modal]]) {
    const hits = src.split('\n').filter((l) => leftSide.test(l) || rightSide.test(l) || fieldLoop.test(l));
    ok(`${name}: no punch instant compared by its spelling`, hits.length === 0, hits.map((h) => h.trim()).join(' | ').slice(0, 300));
  }
}

console.log(`\ntime-correct-by-value: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
}
