// CS-494 — a checklist submission is counted against the PUBLISHED CHECKLIST, never
// against the caller's own item list.
//
// WHY THIS SUITE. `qc.checklist.perform` is a crew default, and `submitChecklist` stored
// `completed_count: items.filter(i => i.checked).length, total_count: items.length` — the
// payload measured against itself — although it had just read the published version to
// snapshot it. So a cleaner who POSTed one invented, ticked item recorded 1/1;
// `isChecklistComplete` (`total_count > 0 && completed_count >= total_count`) reads that as
// finished, and the clock-out block (R4, `api/_lib/time/checklistGate.js`) then let them
// clock out with the real checklist untouched. The block the client asked for with "no way
// around it on the cleaner's side" was bypassable with one request.
//
// It is proven where it actually matters: the REAL `api/qc/[...path].js` handler stores a
// submission, and the REAL `api/time/[...path].js` handler is then asked to clock the same
// cleaner out of the same clean. Both run against the loopback Supabase fake
// (`fake-supabase.mjs` — no network, no credentials, no live project; BUILD_INTEGRITY §6b,
// and no sandbox exists yet, CS-033). A unit test on the counting helper alone could not
// catch this: the defect was never in the arithmetic, it was in WHICH LIST was measured.
//
// The oracle is the SEEDED SCHEMA itself, read back with `countSchemaItems`
// (`src/lib/inspections.js` — the same function that refuses to publish an item-less
// checklist), never a number restated here.
//
// REGRESSION (THE LAW II.3): on the pre-fix tree the forged one-item submission stores 1/1
// and `POST /api/time/clock-out` answers 200 — every case in section 1 goes red. Restore
// the fix and they pass.
//
//   node app/scripts/test-checklist-submit-count-route.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000494';
// Set BEFORE anything under api/ loads (constants.js / orgState.js read env at import).
// The URL is a closed local port and fetch is stubbed: nothing here can reach a network.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { countSchemaItems } = await import('../src/lib/inspections.js');
const { isChecklistComplete } = await import('../src/lib/crewChecklist.js');
const { CHECKLIST_INCOMPLETE_CODE } = await import('../src/lib/clockOutBlock.js');
// Destructured off the namespace object on purpose: on the pre-fix tree these are simply
// `undefined` rather than a link error, so the red run reports the real failures instead of
// refusing to load. Their existence is asserted below.
const { NOT_A_CHECKLIST_CODE, NOT_A_CHECKLIST_ERROR } = await import('../src/lib/checklistCount.js');
// The counting rule itself, so a parity case can measure the demo stub's expression
// (`countChecklistSubmission(pv.schema, list)`) against what the REAL route stored.
const { countChecklistSubmission } = await import('../src/lib/checklistCount.js');
const qc = (await import('../api/qc/[...path].js')).default;
const time = (await import('../api/time/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── the fixture ──────────────────────────────────────────────────────────────
// The cleaner's checklist, `it_a`, has TWO published versions and one draft:
//   v_one   published, 1 item   — the version the checklist STARTED as, before a republish
//   v_pub   published, 5 items  — the CURRENT published version
//   v_draft draft,     1 item   — never published
// A second checklist `it_b` exists so "a version of ANOTHER template" can be named, and an
// INSPECTION template `it_insp` so a submission naming one can be refused (F-B). `it_old`
// is a hand-inserted row with NO kind at all — impossible on the real table (`kind text not
// null default 'inspection'`, migration 20260614120000) and therefore never refused: the
// rule refuses a KNOWN non-checklist kind, not an unknown one.
const area = (id, label, items) => ({ id, label, items });
const item = (id, label, naAllowed = true) => ({ id, label, photoRequired: false, naAllowed });
// CS-546: exactly ONE item of the current published checklist carries the office's "N/A ok"
// flag (`c_cart`), so this fixture can tell a sanctioned N/A from a forged one. The other
// four MUST be done — which is the shape of every checklist in production today, where no
// item carries the flag at all.
const NA_OK = 'c_cart';
const SCHEMA_PUB = {
  areas: [
    area('a_close', 'Close-Out', [item('c_lights', 'Lights off', false), item('c_lock', 'All doors locked', false), item('c_alarm', 'Alarm set', false)]),
    area('a_cart', 'Cart', [item(NA_OK, 'Cart cleaned & restocked', true), item('c_trash', 'Trash to the dumpster', false)]),
  ],
};
const SCHEMA_ONE = { areas: [area('a_close', 'Close-Out', [item('c_lights', 'Lights off')])] };
const SCHEMA_DRAFT = { areas: [area('a_close', 'Close-Out', [item('c_lights', 'Lights off')])] };
const SCHEMA_B = { areas: [area('a_floors', 'Floors', [item('f_mop', 'Mopped')])] };
const SCHEMA_INSP = { areas: [area('a_rest', 'Restrooms', [item('r_floor', 'Floor'), item('r_sink', 'Sink')])] };

// The oracles, read off the schemas themselves.
const TOTAL_PUB = countSchemaItems(SCHEMA_PUB);
const TOTAL_ONE = countSchemaItems(SCHEMA_ONE);
const keysOf = (schema) => schema.areas.flatMap((a) => a.items.map((i) => i.id));
// A GENUINE submission: exactly what ChecklistFill posts for that schema — one entry per
// item, keyed by the schema item's id.
const fill = (schema, checkedKeys) => keysOf(schema).map((key) => ({
  key, label: key, checked: checkedKeys === 'all' || checkedKeys.includes(key), note: null,
}));

const START = '2026-09-27T13:00:00.000Z';
const END = '2026-09-27T16:00:00.000Z';

const user = (id, role) => ({ id, role, status: 'active', name: id, email: `${id}@example.test` });
const logins = {
  'tok-c1': { id: 'auth-c1', email: 'u_c1@example.test', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } },
};

function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG,
        version: 57,
        state: {
          version: 57,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [user('u_c1', 'crew')],
          clients: [{ id: 'c1', name: 'Coral Bay HOA', crewChecklists: { u_c1: 'it_a' } }],
          sites: [{ id: 's1', clientId: 'c1', name: 'Tower', expectedCleanMins: 120 }],
          permissions: seedPermissions(),
          userPermissionOverrides: [],
          opsSettings: { offlineReplayWindowHours: 12 },
        },
      }],
      // The crew member is assigned to the account, so the submit is in scope. The marker
      // row is what tells `assignmentsInitialized` the table has ever been synced.
      crew_assignments: [
        { organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' },
        { organization_id: ORG, user_id: 'u_c1', site_id: null, client_id: 'c1', source: 'standing_client' },
      ],
      inspection_templates: [
        { id: 'it_a', organization_id: ORG, name: 'Nightly Close-Out', kind: 'checklist', is_published: true, published_version_id: 'v_pub' },
        { id: 'it_b', organization_id: ORG, name: 'Floor Care', kind: 'checklist', is_published: true, published_version_id: 'v_b' },
        { id: 'it_insp', organization_id: ORG, name: 'Restroom Deep-Clean QC', kind: 'inspection', is_published: true, published_version_id: 'v_insp' },
        { id: 'it_old', organization_id: ORG, name: 'Legacy list', is_published: true, published_version_id: 'v_oldkind' },
      ],
      inspection_template_versions: [
        { id: 'v_one', template_id: 'it_a', version_number: 1, status: 'published', schema: SCHEMA_ONE },
        { id: 'v_pub', template_id: 'it_a', version_number: 2, status: 'published', schema: SCHEMA_PUB },
        { id: 'v_draft', template_id: 'it_a', version_number: 3, status: 'draft', schema: SCHEMA_DRAFT },
        { id: 'v_b', template_id: 'it_b', version_number: 1, status: 'published', schema: SCHEMA_B },
        { id: 'v_insp', template_id: 'it_insp', version_number: 1, status: 'published', schema: SCHEMA_INSP },
        { id: 'v_oldkind', template_id: 'it_old', version_number: 1, status: 'published', schema: SCHEMA_ONE },
      ],
      checklist_results: [],
      jobs: [{
        id: 'j1', organization_id: ORG, site_id: 's1', client_id: 'c1', start_at: START,
        data: { id: 'j1', clientId: 'c1', siteId: 's1', startAt: START, endAt: END, status: 'in_progress', crewIds: ['u_c1'] },
      }],
      time_entries: [{
        id: 'e_c1', organization_id: ORG, job_id: 'j1', client_id: 'c1', site_id: 's1', user_id: 'u_c1',
        clock_in_at: '2026-09-27T13:05:00.000Z', clock_out_at: null, status: 'in_progress',
        scheduled_start: START, scheduled_end: END, approval_status: 'pending', edit_history: [],
        client_punch_id: null, duration_minutes: null, row_version: 0,
      }],
      payroll_runs: [],
    },
    logins,
  });
}

async function call(handler, { method = 'POST', path, token, body }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath: path };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${path}: no response`)), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}

const submit = (body) => call(qc, { path: 'checklists/submit', token: 'tok-c1', body: { templateId: 'it_a', siteId: 's1', clientId: 'c1', jobId: 'j1', ...body } });
const clockOut = () => call(time, { path: 'clock-out', token: 'tok-c1', body: { entryId: 'e_c1' } });
const stored = () => world.tables.checklist_results;
const counts = (row) => `${row?.completed_count}/${row?.total_count}`;

// ── 1. THE DEFECT: a forged minimal submission must not clear the block ───────
{
  seed();
  // One key the published checklist has never heard of, ticked. The pre-fix server stored
  // 1/1 from this and the clock-out went through.
  const r = await submit({ items: [{ key: 'not_in_the_schema', label: 'x', checked: true }] });
  eq('a forged one-item submission is ACCEPTED, never refused (II.8)', r.status, 200);
  eq('…it counts 0 of the published checklist, not 1/1', counts(stored()[0]), `0/${TOTAL_PUB}`);
  ok('…so the stored row is NOT complete', !isChecklistComplete(stored()[0]));
  const out = await clockOut();
  eq('…and the clean\'s clock-out stays BLOCKED', out.status, 409);
  eq('…with the checklist code', out.body?.code, CHECKLIST_INCOMPLETE_CODE);
  eq('…and the honest progress', `${out.body?.done}/${out.body?.total}`, `0/${TOTAL_PUB}`);
  ok('…the punch stays open', world.tables.time_entries[0].clock_out_at === null);
}

// Ticking the one real key it knows is no better: the other four are still owed.
{
  seed();
  await submit({ items: [{ key: 'c_lights', label: 'Lights off', checked: true }] });
  eq('a one-real-item submission counts 1 of the published total', counts(stored()[0]), `1/${TOTAL_PUB}`);
  const out = await clockOut();
  eq('…clock-out still blocked', out.status, 409);
  eq('…with the honest progress', `${out.body?.done}/${out.body?.total}`, `1/${TOTAL_PUB}`);
}

// ── 2. a GENUINE complete submission still clears it ─────────────────────────
{
  seed();
  const r = await submit({ items: fill(SCHEMA_PUB, 'all') });
  eq('a genuine full submission is stored', r.status, 200);
  eq('…and counts complete', counts(stored()[0]), `${TOTAL_PUB}/${TOTAL_PUB}`);
  ok('…isChecklistComplete agrees', isChecklistComplete(stored()[0]));
  const out = await clockOut();
  eq('…the cleaner clocks out', out.status, 200);
  ok('…and the punch is closed', !!world.tables.time_entries[0].clock_out_at);
}

// ── 3. a PARTIAL submission blocks, with the right n/m ───────────────────────
{
  seed();
  await submit({ items: fill(SCHEMA_PUB, ['c_lights', 'c_lock', 'c_alarm']) });
  eq('a partial submission counts what was actually ticked', counts(stored()[0]), `3/${TOTAL_PUB}`);
  const out = await clockOut();
  eq('…clock-out blocked', out.status, 409);
  eq('…progress is the partial n/m', `${out.body?.done}/${out.body?.total}`, `3/${TOTAL_PUB}`);
}

// ── 4. unknown keys and duplicates never inflate a count ─────────────────────
{
  seed();
  await submit({ items: [
    ...fill(SCHEMA_PUB, ['c_lights', 'c_lock']),
    { key: 'ghost_1', label: 'made up', checked: true },
    { key: 'ghost_2', label: 'made up', checked: true },
    { key: 'ghost_3', label: 'made up', checked: true },
  ] });
  eq('padding a real submission with ticked unknown keys changes nothing', counts(stored()[0]), `2/${TOTAL_PUB}`);
  const out = await clockOut();
  eq('…and the clock-out is still blocked', out.status, 409);
}
{
  seed();
  await submit({ items: [
    { key: 'c_lights', label: 'Lights off', checked: true },
    { key: 'c_lights', label: 'Lights off', checked: true },
    { key: 'c_lights', label: 'Lights off', checked: true },
  ] });
  eq('the SAME key repeated counts once', counts(stored()[0]), `1/${TOTAL_PUB}`);
}
{
  // A submission that simply omits most of the checklist: total is the schema's, not the
  // payload's, so the missing items read as not done.
  seed();
  await submit({ items: [{ key: 'c_lights', label: 'Lights off', checked: true }, { key: 'c_lock', label: 'All doors locked', checked: false }] });
  eq('omitted items still count toward the total', counts(stored()[0]), `1/${TOTAL_PUB}`);
}
{
  // An EMPTY submission is stored, counted 0/total, and blocks.
  seed();
  const r = await submit({ items: [] });
  eq('an empty submission is accepted', r.status, 200);
  eq('…counted against the published checklist', counts(stored()[0]), `0/${TOTAL_PUB}`);
}

// ── 5. THE CURRENT PUBLISHED VERSION, always — a named version is never honoured ──
// F-A (review of the first CS-494 fix). Counting against a version the SUBMISSION named
// looked like an offline-replay kindness, and it was crew-reachable: `publishTemplate`
// never demotes older versions, and `checklists/list` (qc.view, a crew default) hands a
// cleaner their own past rows complete with `template_version_id` and `template_snapshot`.
// So a checklist republished from 1 item to 5 left version one both PUBLISHED and
// discoverable, and naming it stored 1/1 = complete. The concession is gone: the server
// counts against the template's CURRENT published version, full stop.
//
// THE REPRO, end to end.
{
  seed();
  const r = await submit({ templateVersionId: 'v_one', items: fill(SCHEMA_ONE, 'all') });
  eq('naming the checklist\'s original 1-item version is accepted', r.status, 200);
  eq('…but it is counted against the CURRENT published version', counts(stored()[0]), `${TOTAL_ONE}/${TOTAL_PUB}`);
  ok('…so it is NOT complete', !isChecklistComplete(stored()[0]), counts(stored()[0]));
  eq('…and the row records the current version', stored()[0]?.template_version_id, 'v_pub');
  eq('…with the current schema snapshotted', countSchemaItems(stored()[0]?.template_snapshot?.schema), TOTAL_PUB);
  const out = await clockOut();
  eq('…the clock-out is BLOCKED', out.status, 409);
  eq('…with the honest progress', `${out.body?.done}/${out.body?.total}`, `${TOTAL_ONE}/${TOTAL_PUB}`);
  ok('…and the punch stays open', world.tables.time_entries[0].clock_out_at === null);
}
// Every other thing a caller could name is simply ignored too — never read, never refused.
for (const [label, versionId] of [
  ['an older PUBLISHED version', 'v_one'],
  ['a DRAFT version', 'v_draft'],
  ['a version of ANOTHER template', 'v_b'],
  ['a version id that does not exist', 'v_nope'],
  ['a non-string version id', 12345],
  ['a version id outside the id alphabet', 'v_pub),status.eq.draft,id.eq.(v_draft'],
]) {
  seed();
  const r = await submit({ templateVersionId: versionId, items: [{ key: 'c_lights', label: 'Lights off', checked: true }] });
  eq(`naming ${label} is accepted`, r.status, 200);
  eq(`naming ${label} counts against the published version`, counts(stored()[0]), `1/${TOTAL_PUB}`);
  eq(`naming ${label} records the published version`, stored()[0]?.template_version_id, 'v_pub');
}
// And it costs nothing: exactly ONE version read, the published one, whatever was named.
{
  seed();
  await submit({ templateVersionId: 'v_one', items: [{ key: 'c_lights', checked: true }] });
  const versionReads = world.log.filter((q) => q.table === 'inspection_template_versions');
  eq('a named version costs no extra read', versionReads.length, 1);
  eq('…and the one read is the published version', versionReads[0]?.eq?.id, 'v_pub');
}

// ── 5b. an INSPECTION template can never become a checklist row ──────────────
// F-B (predates the CS-494 fix). `submitChecklist` never looked at the template's kind, so
// a crew token could name an INSPECTION template, get 200, and write a `checklist_results`
// row carrying `template_snapshot.kind = 'inspection'` — which then shows in the Quality
// hub's Checklists table and in Reports › Checklists per site. Refused now, and NOTHING is
// stored. This is not the II.8 case: there is no cleaner's work to preserve, the caller
// named the wrong kind of template, exactly as `notFound` / `notPublished` already refuse.
ok('the refusal vocabulary exists (code + plain message)',
  typeof NOT_A_CHECKLIST_CODE === 'string' && !!NOT_A_CHECKLIST_CODE
  && typeof NOT_A_CHECKLIST_ERROR === 'string' && !!NOT_A_CHECKLIST_ERROR,
  `code=${NOT_A_CHECKLIST_CODE} error=${NOT_A_CHECKLIST_ERROR}`);
{
  seed();
  const r = await submit({ templateId: 'it_insp', items: fill(SCHEMA_INSP, 'all') });
  eq('submitting an INSPECTION template is refused', r.status, 400);
  eq('…with its own code', r.body?.code, NOT_A_CHECKLIST_CODE);
  eq('…and the shared message', r.body?.error, NOT_A_CHECKLIST_ERROR);
  eq('…and NOTHING is stored', stored().length, 0);
  const out = await clockOut();
  eq('…so the cleaner\'s clock-out is still blocked', out.status, 409);
}
{
  // A template row with NO kind is impossible on the real table (`kind text not null
  // default 'inspection'`), so it is not refused: the rule refuses a KNOWN non-checklist
  // kind, never an absent one, and can therefore not lock out a legacy row.
  seed();
  const r = await submit({ templateId: 'it_old', items: fill(SCHEMA_ONE, 'all') });
  eq('a template with NO kind is not refused', r.status, 200);
  eq('…and is counted normally', counts(stored()[0]), `${TOTAL_ONE}/${TOTAL_ONE}`);
}
{
  // The refusal comes BEFORE the idempotency key is consumed, and before any write.
  seed();
  const r = await submit({ templateId: 'it_insp', clientSubmitId: 'cs_insp', items: [] });
  eq('a refused inspection submit stores nothing even with a clientSubmitId', stored().length, 0);
  eq('…and stays refused on replay', (await submit({ templateId: 'it_insp', clientSubmitId: 'cs_insp', items: [] })).status, r.status);
}

// ── 5c. N/A is the OFFICE's per-item exception, and only that (CS-546) ────────
// The client's rule is that the whole checklist is done before clock-out with no way around
// it on the cleaner's side. `InspectionTemplateEditor` has always written an `naAllowed`
// flag per item and `ChecklistFill` never offered the control, so an item that does not
// apply tonight had to be ticked anyway or the cleaner could not clock out. It is honoured
// now — against the PUBLISHED schema, exactly like a tick, so `qc.checklist.perform` (a crew
// default) cannot turn it into an escape: a `na` on an item the office did not flag counts
// no more than a ticked key the schema never heard of.
//
// A GENUINE fill: one entry per published item, the ones named in `naKeys` marked N/A
// instead of ticked — exactly what ChecklistFill posts.
const naFill = (schema, naKeys) => keysOf(schema).map((key) => ({
  key, label: key, checked: !naKeys.includes(key), na: naKeys.includes(key), note: null,
}));
{
  seed();
  const items = naFill(SCHEMA_PUB, [NA_OK]);
  const r = await submit({ items });
  eq('an N/A-allowed item marked N/A is stored', r.status, 200);
  eq('…and the checklist counts COMPLETE', counts(stored()[0]), `${TOTAL_PUB}/${TOTAL_PUB}`);
  ok('…isChecklistComplete agrees', isChecklistComplete(stored()[0]));
  const out = await clockOut();
  eq('…so the cleaner CLOCKS OUT', out.status, 200);
  ok('…and the punch is closed', !!world.tables.time_entries[0].clock_out_at);
}
{
  // The same submission with the N/A on an item the office did NOT flag: it is stored
  // honestly (II.8 — the clean happened), counts as not done, and the block holds.
  seed();
  const r = await submit({ items: naFill(SCHEMA_PUB, ['c_alarm']) });
  eq('an N/A on an item WITHOUT the flag is still accepted', r.status, 200);
  eq('…but it counts as not done', counts(stored()[0]), `${TOTAL_PUB - 1}/${TOTAL_PUB}`);
  ok('…so the row is NOT complete', !isChecklistComplete(stored()[0]));
  const out = await clockOut();
  eq('…and the clock-out stays BLOCKED', out.status, 409);
  eq('…with the honest progress', `${out.body?.done}/${out.body?.total}`, `${TOTAL_PUB - 1}/${TOTAL_PUB}`);
  ok('…the punch stays open', world.tables.time_entries[0].clock_out_at === null);
}
{
  // THE FORGERY the schema check exists to stop: mark the whole checklist N/A in one POST.
  // Only the one item the office flagged counts.
  seed();
  const r = await submit({ items: naFill(SCHEMA_PUB, keysOf(SCHEMA_PUB)) });
  eq('marking EVERY item N/A is accepted', r.status, 200);
  eq('…and counts only the one the office allowed', counts(stored()[0]), `1/${TOTAL_PUB}`);
  const out = await clockOut();
  eq('…so the clock-out is BLOCKED', out.status, 409);
  eq('…with the honest progress', `${out.body?.done}/${out.body?.total}`, `1/${TOTAL_PUB}`);
}
{
  // A bare `na` on an invented key is worth exactly what a ticked invented key is worth.
  seed();
  await submit({ items: [{ key: 'not_in_the_schema', label: 'x', na: true }] });
  eq('an N/A on a key the checklist never heard of counts nothing', counts(stored()[0]), `0/${TOTAL_PUB}`);
  eq('…and the clock-out is blocked', (await clockOut()).status, 409);
}
{
  // Ticked AND N/A on the same item is one item, not two.
  seed();
  await submit({ items: [
    ...fill(SCHEMA_PUB, ['c_lights', 'c_lock', 'c_alarm', 'c_trash']),
    { key: NA_OK, label: NA_OK, checked: true, na: true },
  ] });
  eq('ticked and N/A on the same item counts once', counts(stored()[0]), `${TOTAL_PUB}/${TOTAL_PUB}`);
  eq('…and the cleaner clocks out', (await clockOut()).status, 200);
}
{
  // The RECORD keeps the mark, so every surface that shows a submitted checklist can read
  // that item as N/A rather than as missed.
  seed();
  await submit({ items: naFill(SCHEMA_PUB, [NA_OK]) });
  const row = stored()[0];
  const marked = (row?.items || []).filter((i) => i && i.na).map((i) => i.key);
  eq('the stored items record WHICH item was marked N/A', JSON.stringify(marked), JSON.stringify([NA_OK]));
}
{
  // PARITY: the demo stub evaluates `countChecklistSubmission(pv.schema, list)` — the same
  // expression, against the same published schema — so it can never accept what the server
  // would count short. Measured here against what the REAL route actually stored.
  seed();
  const items = naFill(SCHEMA_PUB, [NA_OK]);
  await submit({ items });
  const stub = countChecklistSubmission(SCHEMA_PUB, items);
  eq('the demo stub counts the same completed', stub.completed_count, stored()[0]?.completed_count);
  eq('the demo stub counts the same total', stub.total_count, stored()[0]?.total_count);
  const forged = naFill(SCHEMA_PUB, keysOf(SCHEMA_PUB));
  seed();
  await submit({ items: forged });
  const stubForged = countChecklistSubmission(SCHEMA_PUB, forged);
  eq('…and refuses the forgery the same way', `${stubForged.completed_count}/${stubForged.total_count}`, counts(stored()[0]));
}

// ── 6. the idempotent replay is untouched ────────────────────────────────────
{
  seed();
  const body = { clientSubmitId: 'cs_replay_1', items: fill(SCHEMA_PUB, ['c_lights', 'c_lock']) };
  const first = await submit(body);
  const again = await submit(body);
  eq('a replayed submission is accepted', again.status, 200);
  eq('…and inserts no second row', stored().length, 1);
  eq('…returning the stored row', again.body?.checklist?.id, first.body?.checklist?.id);
  eq('…with the counts unchanged', counts(stored()[0]), `2/${TOTAL_PUB}`);
}

// ── 7. the counts the route hands back are the counts it stored ──────────────
{
  seed();
  const r = await submit({ items: fill(SCHEMA_PUB, ['c_lights']) });
  eq('the response carries the stored completed_count', r.body?.checklist?.completed_count, stored()[0]?.completed_count);
  eq('the response carries the stored total_count', r.body?.checklist?.total_count, stored()[0]?.total_count);
}

// ── 8. EVERY writer of the two columns goes through the one rule ─────────────
// Enumerated mechanically over the source (BUILD_INTEGRITY — "coverage is enumeration,
// not judgment"), because the defect was a SECOND copy of the counting rule, not a wrong
// one: the server, the demo stub and the two seeds each computed the pair themselves, so
// fixing one left the others free to disagree about whether a clean's checklist is done.
{
  const { readdirSync, readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = (await import('node:path')).default;
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const APP = path.resolve(HERE, '..');
  const REPO = path.resolve(APP, '..');
  const rel = (p) => path.relative(REPO, p).split(path.sep).join('/');
  const walk = (dir, out = []) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); continue; }
      if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const SOURCES = [...walk(path.join(APP, 'src')), ...walk(path.join(APP, 'api')),
    path.join(APP, 'scripts', 'seed-backend.mjs')];
  ok('enumerated the app source', SOURCES.length > 300, `${SOURCES.length} files`);
  // Comments quote the old code on purpose; only real code counts.
  const code = (p) => {
    let src = '';
    try { src = readFileSync(p, 'utf8'); } catch { return ''; }
    return src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  };

  // Every module that PERSISTS a checklist_results row measures it with the shared rule.
  for (const f of ['src/lib/checklistCount.js', 'api/_lib/qc/store.js', 'src/lib/qcApi.js',
    'src/data/demoStubs.js', 'scripts/seed-backend.mjs']) {
    ok(`${f} measures a submission with countChecklistSubmission`,
      /countChecklistSubmission/.test(code(path.join(APP, f))));
  }

  // The named-version concession is GONE, not merely unused (II.5 — no dead option left
  // for a later reader to re-enable). Nothing under app/ names it any more, this suite
  // aside, where it is the forgery being refused.
  const namesVersionOption = SOURCES.filter((p) => /templateVersionId/.test(code(p))).map(rel);
  ok('no source still carries the templateVersionId option', namesVersionOption.length === 0, namesVersionOption.join(', '));

  // Both sides refuse a non-checklist template with the SAME rule, so the demo cannot
  // show a submission the server would turn away (F-B).
  for (const f of ['api/_lib/qc/store.js', 'src/lib/qcApi.js']) {
    ok(`${f} refuses a non-checklist template with the shared rule`,
      /checklistSubmitRefusal/.test(code(path.join(APP, f))));
  }

  // CS-546: ONE module decides whether an item may be marked N/A. Anything else reading the
  // flag is a second rule waiting to disagree with the server's count, which is the CS-494
  // shape all over again. The allow-list is short and each entry is a different job:
  //   · checklistCount.js      — owns the rule (`itemAllowsNa` / `defaultNaAllowed`)
  //   · InspectionTemplateEditor.jsx — WRITES the flag (and its per-kind default)
  //   · InspectionFill.jsx     — the SCORED inspection's own N/A rating, a different
  //                              surface with a different permission and no clock-out block
  //   · demoStubs.js           — demo seed data
  const NA_OWNERS = new Set([
    'app/src/lib/checklistCount.js',
    'app/src/components/InspectionTemplateEditor.jsx',
    'app/src/components/InspectionFill.jsx',
    'app/src/data/demoStubs.js',
  ]);
  const naReaders = SOURCES.filter((p) => !NA_OWNERS.has(rel(p)) && /\bna_?[Aa]llowed\b/.test(code(p))).map(rel);
  ok('no module outside the rule decides for itself whether N/A is allowed',
    naReaders.length === 0, naReaders.join(', '));
  ok('the checklist fill asks the shared rule which items may be marked N/A',
    /itemAllowsNa/.test(code(path.join(APP, 'src/components/ChecklistFill.jsx'))));
  // CS-547 widened the call with the photos the device has (`{ photoKeys }`), which the
  // server reads from account_media — the two still measure the same list against the
  // same schema, so what this asserts is unchanged: the fill does not count for itself.
  ok('…and shows the cleaner the same n/m the server will store',
    /countChecklistSubmission\(schema, items, \{ photoKeys \}\)/.test(code(path.join(APP, 'src/components/ChecklistFill.jsx'))));
  ok('the template editor defaults a new item through the shared rule, not a literal',
    /defaultNaAllowed/.test(code(path.join(APP, 'src/components/InspectionTemplateEditor.jsx')))
    && !/naAllowed:\s*(true|false)\b/.test(code(path.join(APP, 'src/components/InspectionTemplateEditor.jsx'))));

  // …and nobody else spells the columns out by hand. The ONE declared exception is the
  // on-device gate over a still-queued submission (`crewChecklist.queuedAsRows`): the
  // buffered payload carries no schema, that module takes no imports by design, and the
  // row is never persisted — the server re-counts the replay against the schema.
  const EXCEPT = new Set(['app/src/lib/checklistCount.js', 'app/src/lib/crewChecklist.js']);
  const handCounts = SOURCES
    .filter((p) => !EXCEPT.has(rel(p)) && /\b(completed_count|total_count)\s*:/.test(code(p)))
    .map(rel);
  ok('no other module computes completed_count / total_count itself',
    handCounts.length === 0, handCounts.join(', '));
  ok('the one exception is still only the QUEUED on-device row',
    /queued:\s*true/.test(code(path.join(APP, 'src/lib/crewChecklist.js'))));
}

if (fails.length) { console.error('\nchecklist-submit-count-route FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nchecklist-submit-count-route: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
