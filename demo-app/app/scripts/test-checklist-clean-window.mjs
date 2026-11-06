// CS-690 — a checklist filled the night before, from home, unlocked the next day's clock-out.
//
// WHAT WAS WRONG. The submit route checked crew scope only; the store wrote `performed_at =
// now` and `job_id` as posted, with no clock or time check; and the clock-out gate matched job
// + cleaner with no time limit. So the night before — off the clock, ~200 mi away, Clock in
// still "opens at 8:30 AM" — a cleaner could open tomorrow's clean and complete its checklist;
// next morning Clock out was unlocked the moment they clocked in, and each area's "last
// cleaned" time (the QR code on the wall, the customer's hub) was stamped from the night
// before.
//
// THE RULE (lib/checklistWindow): a checklist counts for a clean only when it was filled in
// inside that clean's window — the same window its clock-in has, 2 h before the start to the
// end + the auto-close grace — or past it while the cleaner is still clocked in there. Any
// other fill is KEPT (never refused, II.8) but stored WITHOUT the clean and with no area
// stamp. A crew fill naming no clean stamps no area unless it was made inside one of that
// cleaner's cleans at the building. "When" is the server's clock, or for a fill the phone kept
// offline the moment Submit was pressed (`filledAt`), never later than its arrival.
//
// WHAT THIS PINS.
//   §1 the rule, pure
//   §2 the REAL /api/qc submit and the REAL /api/time clock-out (in-process fake Supabase):
//      a night-before fill does not unlock the clock-out and stamps no area; a fill inside the
//      window does both; a late starter past the window still counts while clocked in; an
//      offline fill made in the window and sent hours later counts; a crew fill naming no
//      clean, made away from any of their cleans, stamps no area
//   §3 the phone's own gate agrees (lib/crewChecklist clockOutGate `opensAt`): a queued or
//      older stored fill from before the window opened does not unlock the clock-out offline
//   §4 the wiring: the phone stamps `filledAt` on what it queues; the fill button says when it
//      opens; the screens tell it whether the cleaner is clocked in; the demo stub runs the rule
//
// REGRESSION (THE LAW II.3): on the pre-fix tree the rule module does not exist, the route
// stores every fill on its clean with its area stamps, and the gate ignores `opensAt`.
//
//   node scripts/test-checklist-clean-window.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };

const ORG = '00000000-0000-0000-0000-000000000690';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const win = await import('../src/lib/checklistWindow.js').catch(() => ({}));
const { seedPermissions } = await import('../src/lib/roles.js');
const { clockOutGate, GATE } = await import('../src/lib/crewChecklist.js');
const { CLOCK_IN_LEAD_MS } = await import('../src/lib/clockInWindow.js');
const qc = (await import('../api/qc/[...path].js')).default;
const time = (await import('../api/time/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const H = 3600e3;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const GRACE = 120;

// ── §1 the rule, pure ─────────────────────────────────────────────────────────────────────
{
  const madeAt = typeof win.checklistMadeAt === 'function' ? win.checklistMadeAt : () => NaN;
  const counts = typeof win.checklistCountsForClean === 'function' ? win.checklistCountsForClean : () => undefined;
  const refusal = typeof win.checklistFillRefusal === 'function' ? win.checklistFillRefusal : () => undefined;
  const job = { startAt: iso(NOW + 10 * H), endAt: iso(NOW + 13 * H) };   // tomorrow morning, seen tonight
  eq('§1 a live fill was made when it arrived', madeAt(null, NOW), NOW);
  eq('§1 a fill the phone kept offline was made when Submit was pressed', madeAt(iso(NOW - 3 * H), NOW), NOW - 3 * H);
  eq('§1 a claimed time can only move a fill EARLIER, never into a clean still to come', madeAt(iso(NOW + 10 * H), NOW), NOW);
  eq('§1 the night before → does not count', counts({ job, madeAt: NOW, graceMins: GRACE }), false);
  eq('§1 …even "on the clock" somewhere (a window not yet open is not open)', counts({ job, madeAt: NOW, graceMins: GRACE, onClock: true }), false);
  eq('§1 from the window\'s opening (2 h before the start) → counts', counts({ job, madeAt: Date.parse(job.startAt) - CLOCK_IN_LEAD_MS, graceMins: GRACE }), true);
  eq('§1 a minute before the window opens → does not', counts({ job, madeAt: Date.parse(job.startAt) - CLOCK_IN_LEAD_MS - 60e3, graceMins: GRACE }), false);
  const past = { startAt: iso(NOW - 6 * H), endAt: iso(NOW - 4 * H) };     // ended 4 h ago; grace 2 h
  eq('§1 after the window has closed → does not', counts({ job: past, madeAt: NOW, graceMins: GRACE }), false);
  eq('§1 …unless the cleaner is still clocked in there (a late start runs on)', counts({ job: past, madeAt: NOW, graceMins: GRACE, onClock: true }), true);
  eq('§1 a clean with no start time is not gated (as its clock-in)', counts({ job: { startAt: null }, madeAt: NOW, graceMins: GRACE }), true);
  eq('§1 no clean → does not count', counts({ job: null, madeAt: NOW, graceMins: GRACE }), false);
  eq('§1 the button: early', refusal(job, NOW, { graceMins: GRACE }), 'early');
  eq('§1 the button: open inside the window', refusal({ startAt: iso(NOW - H), endAt: iso(NOW + H) }, NOW, { graceMins: GRACE }), null);
  eq('§1 the button: closed after it…', refusal(past, NOW, { graceMins: GRACE }), 'late');
  eq('§1 …but open while still clocked in there', refusal(past, NOW, { graceMins: GRACE, clockedIn: true }), null);
}

// ── §2 the real routes ────────────────────────────────────────────────────────────────────
const item = (id, label) => ({ id, label, photoRequired: false, naAllowed: false });
const SCHEMA = { areas: [{ id: 'a_floors', label: 'Floors', siteAreaId: 'area_floors', items: [item('f_sweep', 'Swept'), item('f_mop', 'Mopped')] }] };
const ALL = [{ key: 'f_sweep', label: 'Swept', checked: true }, { key: 'f_mop', label: 'Mopped', checked: true }];
const user = (id, role) => ({ id, role, status: 'active', name: id, email: `${id}@example.test` });
const jobRow = (id, startMs, endMs) => ({
  id, organization_id: ORG, site_id: 's1', client_id: 'c1', start_at: iso(startMs), status: 'upcoming',
  data: { id, clientId: 'c1', siteId: 's1', startAt: iso(startMs), endAt: iso(endMs), status: 'upcoming', crewIds: ['u_c1'] },
});
function seed({ jobs, entries = [] }) {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 58,
        state: {
          version: 58, company: { id: 'co', name: 'Co', timezone: 'America/New_York' },
          users: [user('u_c1', 'crew')],
          clients: [{ id: 'c1', name: 'Coral Bay HOA', crewChecklists: { u_c1: 'it_a' } }],
          sites: [{ id: 's1', clientId: 'c1', name: 'Tower', expectedCleanMins: 120, cleaningAreas: [{ id: 'area_floors', label: 'Floors' }] }],
          permissions: seedPermissions(), userPermissionOverrides: [],
          opsSettings: { offlineReplayWindowHours: 12, autoCloseGraceMins: GRACE },
        },
      }],
      crew_assignments: [
        { organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' },
        { organization_id: ORG, user_id: 'u_c1', site_id: null, client_id: 'c1', source: 'standing_client' },
      ],
      inspection_templates: [{ id: 'it_a', organization_id: ORG, name: 'Floor Care', kind: 'checklist', is_published: true, published_version_id: 'v_a', client_id: 'c1' }],
      inspection_template_versions: [{ id: 'v_a', template_id: 'it_a', version_number: 1, status: 'published', schema: SCHEMA }],
      checklist_results: [],
      account_media: [],
      jobs,
      time_entries: entries,
      payroll_runs: [],
    },
    logins: { 'tok-c1': { id: 'auth-c1', email: 'u_c1@example.test', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } } },
  });
}
async function call(handler, { path: p, body }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = 'POST'; req.headers = { authorization: 'Bearer tok-c1' }; req.query = { subpath: p }; req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${p}: no response`)), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; } };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const submit = (body) => call(qc, { path: 'checklists/submit', body: { templateId: 'it_a', siteId: 's1', clientId: 'c1', items: ALL, ...body } });
const clockOut = (entryId) => call(time, { path: 'clock-out', body: { entryId } });
const stored = () => world.tables.checklist_results;
const areaStamped = (row) => !!row && row.area_completions && typeof row.area_completions === 'object' && Object.keys(row.area_completions).length > 0;
const openEntry = (jobId, inMs) => ({
  id: `e_${jobId}`, organization_id: ORG, job_id: jobId, client_id: 'c1', site_id: 's1', user_id: 'u_c1',
  clock_in_at: iso(inMs), clock_out_at: null, status: 'in_progress', scheduled_start: null, scheduled_end: null,
  approval_status: 'pending', edit_history: [], client_punch_id: null, duration_minutes: null, row_version: 0,
});

{
  // THE DEFECT, as the finder ran it: tomorrow's 8:30-ish clean, filled tonight from home.
  seed({ jobs: [jobRow('j_tom', NOW + 10 * H, NOW + 13 * H)] });
  const r = await submit({ jobId: 'j_tom' });
  eq('§2 the night-before fill is accepted, never refused (II.8)', r.status, 200);
  const row = stored()[0];
  ok('§2 …and kept', !!row);
  eq('§2 …but NOT on tomorrow\'s clean', row?.job_id ?? null, null);
  ok('§2 …and it stamps no area "last cleaned" (the QR code and the hub)', !!row && !areaStamped(row), JSON.stringify(row?.area_completions));
  // Next morning: the clean is in its window and the cleaner is clocked in (a punch as the
  // clock-in route writes it — seeded, because this in-process fake applies no column
  // defaults, and the time store's compare-and-swap rides `row_version`).
  world.tables.jobs[0].data.startAt = iso(NOW - 30 * 60e3); world.tables.jobs[0].start_at = iso(NOW - 30 * 60e3);
  world.tables.jobs[0].data.endAt = iso(NOW + 2 * H);
  world.tables.time_entries.push(openEntry('j_tom', NOW - 20 * 60e3));
  const out = await clockOut('e_j_tom');
  eq('§2 …and the night-before checklist does NOT unlock the clock-out (409)', out.status, 409);
}
{
  // Inside the window: counts, unlocks, stamps.
  seed({ jobs: [jobRow('j_now', NOW - H, NOW + 2 * H)], entries: [openEntry('j_now', NOW - 0.5 * H)] });
  const r = await submit({ jobId: 'j_now' });
  const row = stored()[0];
  ok('§2 a fill inside the clean\'s window is kept on the clean', r.status === 200 && row?.job_id === 'j_now');
  ok('§2 …and stamps its area', areaStamped(row));
  eq('§2 …and unlocks the clock-out', (await clockOut('e_j_now')).status, 200);
}
{
  // A late starter: the window closed 1 h ago, but the cleaner is still clocked in there.
  seed({ jobs: [jobRow('j_late', NOW - 5 * H, NOW - 3 * H)], entries: [openEntry('j_late', NOW - 2.5 * H)] });
  const r = await submit({ jobId: 'j_late' });
  const row = stored()[0];
  ok('§2 past the window, while still clocked in there → counts (a late start is not stranded)', r.status === 200 && row?.job_id === 'j_late' && areaStamped(row), JSON.stringify(row?.job_id));
  eq('§2 …and the clock-out unlocks', (await clockOut('e_j_late')).status, 200);
}
{
  // An offline basement fill made in the window, sent 4 h after the window closed.
  seed({ jobs: [jobRow('j_base', NOW - 9 * H, NOW - 6 * H)] });
  const r = await submit({ jobId: 'j_base', filledAt: iso(NOW - 7 * H) });
  const row = stored()[0];
  ok('§2 an offline fill made in the window and sent hours later still counts', r.status === 200 && row?.job_id === 'j_base' && areaStamped(row), JSON.stringify(row?.job_id));
}
{
  // The same late send, claiming a time AFTER its arrival — the claim is capped at the arrival.
  seed({ jobs: [jobRow('j_claim', NOW + 10 * H, NOW + 13 * H)] });
  await submit({ jobId: 'j_claim', filledAt: iso(NOW + 10.5 * H) });
  eq('§2 a fill claiming to be from tomorrow\'s window is placed at its arrival (tonight): not on the clean', stored()[0]?.job_id ?? null, null);
}
{
  // A crew fill naming no clean (the Quality hub's own form), made away from any of their cleans.
  seed({ jobs: [jobRow('j_tom2', NOW + 10 * H, NOW + 13 * H)] });
  const r = await submit({});
  const row = stored()[0];
  ok('§2 a crew fill naming no clean, away from their cleans, is kept but stamps no area', r.status === 200 && !!row && !areaStamped(row), JSON.stringify(row?.area_completions));
  seed({ jobs: [jobRow('j_now2', NOW - H, NOW + 2 * H)] });
  await submit({});
  ok('§2 …made during one of their cleans at that building, it stamps its area', areaStamped(stored()[0]), JSON.stringify(stored()[0]?.area_completions));
}

// ── §3 the phone's own gate ───────────────────────────────────────────────────────────────
{
  const job = { id: 'j1', startAt: iso(NOW - H), endAt: iso(NOW + 2 * H) };
  const opensAt = typeof win.checklistOpensAt === 'function' ? win.checklistOpensAt(job, { graceMins: GRACE }) : null;
  ok('§3 the window\'s opening is known', Number.isFinite(opensAt) && opensAt === Date.parse(job.startAt) - CLOCK_IN_LEAD_MS);
  const queued = [{ id: 'q1', createdAt: iso(NOW - 14 * H), payload: { jobId: 'j1', templateId: 'it_a', completedByUserId: 'u_c1', filledAt: iso(NOW - 14 * H), items: ALL } }];
  const early = clockOutGate({ checklistId: 'it_a', results: [], queued, userId: 'u_c1', jobId: 'j1', opensAt });
  eq('§3 a fill queued the night before does NOT unlock the clock-out offline', early.state, GATE.BLOCKED);
  const stale = [{ job_id: 'j1', template_id: 'it_a', completed_by_user_id: 'u_c1', completed_count: 2, total_count: 2, performed_at: iso(NOW - 14 * H) }];
  eq('§3 …nor an older stored fill from before the window', clockOutGate({ checklistId: 'it_a', results: stale, queued: [], userId: 'u_c1', jobId: 'j1', opensAt }).state, GATE.BLOCKED);
  const fresh = [{ ...queued[0], createdAt: iso(NOW - 0.5 * H), payload: { ...queued[0].payload, filledAt: iso(NOW - 0.5 * H) } }];
  eq('§3 a fill queued during the clean does', clockOutGate({ checklistId: 'it_a', results: [], queued: fresh, userId: 'u_c1', jobId: 'j1', opensAt }).state, GATE.DONE);
  eq('§3 with no window known the gate is unchanged (back-compatible)', clockOutGate({ checklistId: 'it_a', results: stale, queued: [], userId: 'u_c1', jobId: 'j1' }).state, GATE.DONE);
  const server = read('api/_lib/time/checklistGate.js');
  ok('§3 the server\'s gate passes the clean\'s window too (legacy rows)', /checklistOpensAt\(/.test(server) && /opensAt/.test(server));
  const hook = read('src/hooks/useCleanChecklist.js');
  ok('§3 the phone\'s gate passes the clean\'s window', /checklistOpensAt\(job/.test(hook) && /opensAt/.test(hook));
}

// ── §4 the wiring ─────────────────────────────────────────────────────────────────────────
{
  const api = read('src/lib/qcApi.js');
  ok('§4 the phone stamps when a queued checklist was filled in', /payload: \{ \.\.\.body, filledAt: /.test(api));
  ok('§4 the demo stub runs the same rule', /checklistCountsForClean\(/.test(api) && /checklistMadeAt\(/.test(api));
  const store = read('api/_lib/qc/store.js');
  ok('§4 the server reads the rule from the shared module', /from '\.\.\/\.\.\/\.\.\/src\/lib\/checklistWindow\.js'/.test(store) && /checklistCountsForClean\(/.test(store));
  const route = read('api/qc/[...path].js');
  ok('§4 the route passes the claimed fill time and whether the caller is crew', /filledAt: body\.filledAt/.test(route) && /crew: !!crewScope/.test(route));
  const card = read('src/components/CleanChecklist.jsx');
  ok('§4 the fill button reads the rule and says when it opens', /checklistFillRefusal\(/.test(card) && /t\('checklist\.clean\.opensAt'/.test(card) && /t\('checklist\.clean\.closed'\)/.test(card));
  const en = read('src/i18n/catalog/en.js');
  ok('§4 …on the catalog', /'checklist\.clean\.opensAt':/.test(en) && /'checklist\.clean\.closed':/.test(en));
  // (My Day's checklist card went with the Cleaner Hub, brief A: the cleaner's checklist is its own
  // page now, lib/crewPaths checklist. The visit keeps the card.)
  ok('§4 the visit tells it whether the cleaner is clocked in', /<CleanChecklist job=\{job\} client=\{client\} variant="button" onStatus=\{setChecklist\} clockedIn=\{isOpen\}/.test(read('src/components/CrewJobVisit.jsx')));
}

if (fails.length) {
  console.error(`\ntest-checklist-clean-window: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\ntest-checklist-clean-window: ${pass}/${pass} passed`);
}
