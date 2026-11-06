// HUB-7 — a failed inspection sends the cleaners ON SITE back to redo the area.
//
// Matt, 2026-10-02: "Does not have to create a work order… Once the inspection failed,
// there should be some sort of a tool where the cleaners on site receive a notification
// that an area needs to be done."
//
// Three things make or break it, and all three are asserted against the REAL
// `api/qc/[...path].js` handler over the loopback Supabase fake:
//   1. WHO — the cleaners with an OPEN PUNCH at that building right now, not the roster
//      and not the office. A cleaner who never turned up cannot redo anything, and a
//      cover who IS there is not on the roster.
//   2. WHEN — on FAILING ITEMS, not on the overall result. An inspection can score 88%
//      and still have the restrooms marked fail; the building still needs the restrooms.
//   3. WHAT — the AREAS, by name. "Restrooms and Break room need redoing" is a sentence a
//      cleaner can act on from a lock screen; "an inspection failed" is not.
// Plus the thing Matt explicitly ruled out: the notice files NO work order of its own. (A
// FAILED inspection opens one since WO-19, 2026-10-09 — test-failed-inspection-ticket.mjs — and
// a passing one with a failed item still opens none: §2's last case.)
//
// REGRESSION (THE LAW II.3): on the pre-fix tree `notifyCleanersToRedo` does not exist,
// no `inspectionRedo` row is ever written, and every assertion in §2-§5 goes red.
//
//   node app/scripts/test-inspection-redo-notice.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000007';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
// Off the namespace objects, with fallbacks: on the pre-fix tree none of these exist, and
// the run must report WHAT it wanted rather than die on a TypeError.
const inspections = await import('../src/lib/inspections.js');
const isFailingRating = inspections.isFailingRating || (() => false);
const redoAreasFor = inspections.redoAreasFor || (() => []);
// CS-193: the alert's sentence is the catalog's `alerts.redo.title` with the area names as
// a list, so each cleaner reads it in their own language; the list's English is checked here.
const { english } = await import('../src/i18n/core.js');
const redoAreasSentence = (areas) => {
  const names = (areas || []).map((a) => a.label).filter(Boolean);
  return names.length ? english('alerts.redo.title', { areas: names }).replace(/^Please redo: /, '') : '';
};
const notifications = await import('../src/lib/notifications.js');
const REDO_EVENT_KEY = notifications.REDO_EVENT_KEY || 'inspectionRedo';
const { NOTIFICATION_GROUPS } = notifications;
const { crewPaths } = await import('../src/lib/crewPaths.js');
const qc = (await import('../api/qc/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── the fixture ──────────────────────────────────────────────────────────────
const SCHEMA = {
  areas: [
    { id: 'a_rest', label: 'Restrooms', items: [{ id: 'r_floor', label: 'Floor' }, { id: 'r_sink', label: 'Sink' }] },
    { id: 'a_break', label: 'Break room', items: [{ id: 'b_counter', label: 'Counter' }] },
    // Six items in all, deliberately: ONE failure is then 5 of 6 = 83%, which PASSES at
    // the 80% threshold. That is the case §3 exists for — an inspection that passes and
    // still leaves an area needing to be done.
    { id: 'a_lobby', label: 'Lobby', items: [{ id: 'l_glass', label: 'Glass' }, { id: 'l_floor', label: 'Floor' }, { id: 'l_mats', label: 'Mats' }] },
  ],
};
const PASSFAIL = { type: 'passfail', passThreshold: 80 };
const NUMERIC = { type: 'numeric', max: 5, passThreshold: 80 };
const SNAP = (scale = PASSFAIL) => ({ name: 'Nightly Janitorial QC', kind: 'inspection', rating_scale: scale, schema: SCHEMA });
// What InspectionFill posts: every item, labelled "<Area>. <Item>".
const answers = (ratings) => SCHEMA.areas.flatMap((a) => a.items.map((i) => ({
  item_key: i.id, label: `${a.label}. ${i.label}`, rating: ratings[i.id] ?? 'pass', comment: null,
})));

const user = (id, role) => ({ id, role, status: 'active', name: id, email: `${id}@example.test` });
const logins = {
  'tok-mgr': { id: 'auth-m', email: 'm@example.test', app_metadata: { role: 'manager', org_user_id: 'u_m', org_id: ORG } },
};

// `openPunches` is the list of user ids with a punch still open at s1.
function seed({ openPunches = [], supervisorId = 'u_sup', scale = PASSFAIL, siteId = 's1' } = {}) {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 57,
        state: {
          version: 57,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [user('u_m', 'manager'), user('u_sup', 'manager'), user('u_c1', 'crew'), user('u_c2', 'crew'), user('u_c3', 'crew')],
          clients: [{ id: 'c1', name: 'Coral Bay HOA', supervisorId }],
          sites: [{ id: 's1', clientId: 'c1', name: 'Clubhouse' }, { id: 's2', clientId: 'c1', name: 'Annexe' }],
          permissions: seedPermissions(),
          userPermissionOverrides: [],
          notifications: [],
        },
      }],
      crew_assignments: [{ organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' }],
      inspection_templates: [{ id: 'it_i', organization_id: ORG, name: 'Nightly Janitorial QC', kind: 'inspection', is_published: true, published_version_id: 'v_i' }],
      inspection_template_versions: [{ id: 'v_i', template_id: 'it_i', version_number: 1, status: 'published', schema: SCHEMA }],
      inspection_records: [{
        id: 'ir_1', organization_id: ORG, public_token: 'tok_1', template_id: 'it_i', template_version_id: 'v_i',
        template_snapshot: SNAP(scale), client_id: 'c1', site_id: siteId, job_id: null,
        inspector_user_id: 'u_m', client_name: 'Coral Bay HOA', site_name: 'Clubhouse', inspector_name: 'u_m',
        status: 'draft', performed_at: '2026-10-02T22:00:00.000Z',
      }],
      inspection_items: [],
      problem_reports: [],
      activity_log: [],
      // Everyone on this list has an OPEN punch at s1; u_c3 is clocked out, and u_c2 (when
      // absent from the list) is simply not there tonight.
      time_entries: [
        ...openPunches.map((uid, i) => ({
          id: `e_${uid}`, organization_id: ORG, job_id: `j${i}`, client_id: 'c1', site_id: 's1', user_id: uid,
          clock_in_at: '2026-10-02T20:00:00.000Z', clock_out_at: null, status: 'in_progress', row_version: 0,
        })),
        { id: 'e_done', organization_id: ORG, job_id: 'jz', client_id: 'c1', site_id: 's1', user_id: 'u_c3',
          clock_in_at: '2026-10-02T15:00:00.000Z', clock_out_at: '2026-10-02T19:00:00.000Z', status: 'completed', row_version: 0 },
        { id: 'e_other', organization_id: ORG, job_id: 'jy', client_id: 'c1', site_id: 's2', user_id: 'u_c2',
          clock_in_at: '2026-10-02T20:00:00.000Z', clock_out_at: null, status: 'in_progress', row_version: 0 },
      ],
    },
    logins,
  });
}

async function submit(items) {
  const body = { id: 'ir_1', items };
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = { authorization: 'Bearer tok-mgr' };
  req.query = { subpath: 'inspections/submit' };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response')), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(qc(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const notes = (eventKey = REDO_EVENT_KEY) =>
  (world.tables.org_state[0].state.notifications || []).filter((n) => n.eventKey === eventKey);

// ── 1. the pure rule: what counts as failing, and which areas it names ──────
ok('the shared rule exports its two readers (the sentence is the catalog\'s now)',
  typeof inspections.isFailingRating === 'function' && typeof inspections.redoAreasFor === 'function'
  && english('alerts.redo.title', { areas: ['X'] }) === 'Please redo: X');
ok('a pass/fail "fail" is failing', isFailingRating('fail', PASSFAIL));
ok('a pass/fail "pass" is not', !isFailingRating('pass', PASSFAIL));
ok('an unrated item is NOT failing — nobody judged it', !isFailingRating(null, PASSFAIL) && !isFailingRating('', PASSFAIL));
ok('an N/A is not failing either', !isFailingRating('na', PASSFAIL));
// Numeric uses the inspection's OWN threshold, not a second opinion: 80% of 5 is 4.
ok('a numeric 3 of 5 is failing at an 80% threshold', isFailingRating('3', NUMERIC));
ok('a numeric 4 of 5 is not', !isFailingRating('4', NUMERIC));
ok('a numeric 5 of 5 is not', !isFailingRating(5, NUMERIC));
ok('a nonsense numeric rating is not failing', !isFailingRating('abc', NUMERIC));

{
  const areas = redoAreasFor(SNAP(), answers({ r_sink: 'fail', b_counter: 'fail' }));
  eq('the failing items are grouped by their AREA', areas.map((a) => a.label).join(' | '), 'Restrooms | Break room');
  eq('…in the frozen schema\'s own order', areas[0]?.id, 'a_rest');
  eq('…naming the item, without stuttering the area back', areas[0]?.items.join(','), 'Sink');
  eq('…and a clean area is absent', areas.some((a) => a.id === 'a_lobby'), false);
  eq('the sentence reads naturally for two', redoAreasSentence(areas), 'Restrooms and Break room');
  eq('…and for one', redoAreasSentence([areas[0]]), 'Restrooms');
  eq('…and for three', redoAreasSentence([{ label: 'A' }, { label: 'B' }, { label: 'C' }]), 'A, B and C');
  eq('…and says nothing for none', redoAreasSentence([]), '');
}
{
  eq('an all-pass inspection names no areas', redoAreasFor(SNAP(), answers({})).length, 0);
  // A failing item the snapshot cannot place is still work owed — never dropped.
  const orphan = redoAreasFor(SNAP(), [{ item_key: 'ghost', label: 'Nowhere. Thing', rating: 'fail' }]);
  eq('a failing item the schema cannot place is kept', orphan.length, 1);
  eq('…in its own bucket', orphan[0]?.id, null);
}

// ── 2. THE ALERT: the cleaners on site are told, by name of area ────────────
{
  seed({ openPunches: ['u_c1'] });
  const r = await submit(answers({ r_sink: 'fail', b_counter: 'fail' }));
  eq('the inspection is submitted', r.status, 200);
  const rows = notes();
  eq('the cleaner on site gets exactly one redo row', rows.length, 1);
  eq('…addressed to them', rows[0]?.userId, 'u_c1');
  ok('…naming the areas', /Restrooms and Break room/.test(rows[0]?.title), rows[0]?.title);
  ok('…and the building', /Clubhouse/.test(rows[0]?.body), rows[0]?.body);
  eq('…unread', rows[0]?.readAt, null);
  // HUB-7 itself files nothing ("Does not have to create a work order"); since WO-19 (Matt,
  // 2026-10-09) a FAILED inspection opens its own ticket — this one fails at 4 of 6 — and the
  // redo notice is how the cleaners hear of it, so it opens that ticket
  // (test-failed-inspection-ticket.mjs holds the rest of that rule).
  const tickets = world.tables.problem_reports;
  eq('a failed inspection opens one ticket of its own (WO-19)', `${tickets.length}/${tickets[0]?.type}`, '1/failed_inspection');
  // The Cleaner Hub (2026-10-13, brief C §1): a CLEANER's row opens the request in their phone
  // app (lib/crewPaths), never the office's Quality hub.
  eq('🔴 …and the redo notice opens it in the cleaner\'s phone app (their Client Requests)', rows[0]?.url, crewPaths.request(tickets[0]?.id));
}
{
  // …while the OFFICE's row still opens the drawer: nobody on site, nobody on the ticket (no
  // cleans in the fixture), so the building's supervisor is told instead (HUB-7's fallback).
  seed({ openPunches: [] });
  await submit(answers({ r_sink: 'fail', b_counter: 'fail' }));
  const rows = notes();
  const tickets = world.tables.problem_reports;
  eq('the supervisor\'s redo row (nobody on site) still opens the ticket\'s drawer', `${rows.map((n) => n.userId).join(',')} ${rows[0]?.url}`, `u_sup /inspections?tab=workorders&wo=${tickets[0]?.id}`);
}
{
  // Everyone on the clock there, and only them: a cleaner who clocked OUT and one at a
  // different building of the same customer are not in the building now.
  seed({ openPunches: ['u_c1', 'u_c2'] });
  await submit(answers({ r_sink: 'fail' }));
  eq('every cleaner on the clock there is told', notes().map((n) => n.userId).sort().join(','), 'u_c1,u_c2');
  ok('…and nobody who has clocked out', !notes().some((n) => n.userId === 'u_c3'));
}
{
  seed({ openPunches: [] });   // u_c2's open punch is at s2, the other building
  await submit(answers({ r_sink: 'fail' }));
  const rows = notes();
  eq('a cleaner on the clock at ANOTHER building is not told', rows.some((n) => n.userId === 'u_c2'), false);
  eq('…and with nobody on site the supervisor is', rows.map((n) => n.userId).join(','), 'u_sup');
  ok('…and the message says nobody was there', /Nobody on site/.test(rows[0]?.title), rows[0]?.title);
}
{
  seed({ openPunches: [], supervisorId: null });
  await submit(answers({ r_sink: 'fail' }));
  eq('with nobody on site and no supervisor, nothing is invented', notes().length, 0);
  eq('…and still no work order', world.tables.problem_reports.length, 0);
}

// ── 3. it fires on FAILING ITEMS, not on the overall result ─────────────────
{
  // 5 of 6 pass = 83%, which PASSES at an 80% threshold — and the restrooms still need
  // doing. This is the case the manager-facing `inspectionFailed` bell does NOT cover.
  seed({ openPunches: ['u_c1'] });
  const r = await submit(answers({ r_sink: 'fail' }));
  eq('…the inspection PASSES overall', r.body?.inspection?.result, 'pass');
  eq('…and the cleaner is still sent back', notes().length, 1);
  eq('…while the manager-facing failure bell stays silent', notes('inspectionFailed').length, 0);
}
{
  seed({ openPunches: ['u_c1'] });
  const r = await submit(answers({}));
  eq('an all-pass inspection tells nobody to redo anything', notes().length, 0);
  eq('…and is a pass', r.body?.inspection?.result, 'pass');
}
{
  // A badly failed one does both: the crew are sent back AND the office hears about it.
  seed({ openPunches: ['u_c1'] });
  const r = await submit(answers({ r_floor: 'fail', r_sink: 'fail', b_counter: 'fail', l_glass: 'fail' }));
  eq('a failing inspection is a fail', r.body?.inspection?.result, 'fail');
  eq('…the crew on site are sent back', notes().length, 1);
  ok('…and the office hears about the failure too', notes('inspectionFailed').length > 0);
}

// ── 4. the inspector is never told to redo their own finding ────────────────
{
  // The actor is skipped by every fan-out here; a supervisor who inspected the building
  // themselves already knows.
  seed({ openPunches: ['u_m'] });
  await submit(answers({ r_sink: 'fail' }));
  eq('the inspector is not sent their own redo notice', notes().length, 0);
}

// ── 5. the event is one the CREW can actually receive ───────────────────────
{
  const item = NOTIFICATION_GROUPS.flatMap((g) => g.items).find((i) => i.key === REDO_EVENT_KEY);
  ok('the redo event is in the notification catalog', !!item);
  // The recipients ARE crew, so an office-only allowlist would strip every recipient —
  // the `accountOpsUpdated` lesson.
  ok('…with NO roleAllowlist, so crew receive it and see the toggle', !item?.roleAllowlist, JSON.stringify(item?.roleAllowlist));
  ok('…and no permission gate a cleaner would fail', !item?.requiresPermission);
  ok('…and it is opt-OUT, not opt-in', !item?.defaultOff);
}

if (fails.length) { console.error('\ninspection-redo-notice FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\ninspection-redo-notice: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
