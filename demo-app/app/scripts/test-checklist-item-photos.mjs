// MISC-5 / CS-547 — a checklist item the office marked "photo required" is DONE only
// once a photo actually exists for it.
//
// WHY THIS SUITE. Matt: "Should a cleaner have to attach a photo? — Yes, on the items the
// office marks." `InspectionTemplateEditor` has written `photoRequired` on every item
// since the templates shipped and NOTHING read it — `ChecklistFill` rendered no control
// and `countChecklistSubmission` treated every item as photo-free — which is exactly the
// hole CS-546 found in `naAllowed`. So the office could mark an item and the cleaner
// would tick it, the row would store complete, and the clock-out block would clear with
// no photo anywhere.
//
// It is proven where it matters: the REAL `api/qc/[...path].js` handler stores a
// submission and the REAL `api/time/[...path].js` handler is then asked to clock the same
// cleaner out, both against the loopback Supabase fake (`fake-supabase.mjs` — no network,
// no credentials, no live project; BUILD_INTEGRITY §6b, and no sandbox exists yet,
// CS-033). The oracle is the SEEDED SCHEMA, read back with `countSchemaItems`, never a
// number restated here.
//
// 🔴 IT IS A COUNT, NOT A REFUSAL (II.8). A submission with a missing photo is STORED as
// the cleaner sent it — the clean happened and this row is its only record — and what the
// missing photo costs is the count, which is what the clock-out block reads. Refusing
// would destroy an offline fill whose photo is still in the media queue, while a forger
// would simply drop the item and store n-1/n, which clears nothing anyway. §2 asserts
// that explicitly so nobody "hardens" it into a 4xx later.
//
// REGRESSION (THE LAW II.3): on the pre-fix tree §1 and §2 go red — the forged tick
// stores 5/5 and `POST /api/time/clock-out` answers 200.
//
//   node app/scripts/test-checklist-item-photos.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000547';
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
// Destructured off the namespace on purpose: on the pre-fix tree these are `undefined`
// rather than a link error, so the red run reports the real failures instead of refusing
// to load. Their existence is asserted below.
const { itemRequiresPhoto, checklistPhotoRequiredKeys, countChecklistSubmission } =
  await import('../src/lib/checklistCount.js');
const qc = (await import('../api/qc/[...path].js')).default;
const time = (await import('../api/time/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── the fixture ──────────────────────────────────────────────────────────────
// `it_a` is the cleaner's published checklist: FIVE items, of which the office marked ONE
// photo-required (`c_mop`) and ONE N/A-allowed (`c_cart`). That is the shape the rule has
// to tell apart — a tick that needs proof, a tick that does not, and an exception that
// needs no proof because the work did not happen.
const PHOTO_KEY = 'c_mop';
const NA_KEY = 'c_cart';
const item = (id, label, extra = {}) => ({ id, label, photoRequired: false, naAllowed: false, ...extra });
const SCHEMA_PUB = {
  areas: [
    { id: 'a_close', label: 'Close-Out', items: [
      item('c_lights', 'Lights off'),
      item(PHOTO_KEY, 'Hard floors mopped', { photoRequired: true }),
      item('c_alarm', 'Alarm set'),
    ] },
    { id: 'a_cart', label: 'Cart', items: [
      item(NA_KEY, 'Cart cleaned & restocked', { naAllowed: true }),
      item('c_trash', 'Trash to the dumpster'),
    ] },
  ],
};
// A checklist with NO marked item — the shape of every checklist in production today.
const SCHEMA_PLAIN = { areas: [{ id: 'a_one', label: 'One', items: [item('p_1', 'Only item')] }] };

const TOTAL = countSchemaItems(SCHEMA_PUB);
const keysOf = (schema) => schema.areas.flatMap((a) => a.items.map((i) => i.id));
// A GENUINE fill: one entry per published item, exactly what ChecklistFill posts.
const fill = (schema, { checked = 'all', na = [] } = {}) => keysOf(schema).map((key) => ({
  key, label: key, note: null,
  checked: !na.includes(key) && (checked === 'all' || checked.includes(key)),
  na: na.includes(key),
}));

const START = '2026-10-02T13:00:00.000Z';
const END = '2026-10-02T16:00:00.000Z';
const SUBMIT_ID = 'cl_fixture_1';

const user = (id, role) => ({ id, role, status: 'active', name: id, email: `${id}@example.test` });
const logins = {
  'tok-c1': { id: 'auth-c1', email: 'u_c1@example.test', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } },
};

// One account_media row, as api/account-media/confirm writes it for a checklist photo:
// scope 'checklist', ref_id = the SUBMISSION id, area_id = the ITEM key.
const photoRow = (id, { refId = SUBMIT_ID, areaId = PHOTO_KEY, scope = 'checklist' } = {}) => ({
  id, organization_id: ORG, scope, ref_id: refId, area_id: areaId,
  site_id: 's1', client_id: 'c1', kind: 'image', mime_type: 'image/jpeg',
  storage_path: `${ORG}/s1/aaaaaaaaaaaaaaaa.jpg`, thumb_path: null,
  created_at: '2026-10-02T15:00:00.000Z',
});

function seed({ media = [], schema = SCHEMA_PUB } = {}) {
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
      crew_assignments: [
        { organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' },
        { organization_id: ORG, user_id: 'u_c1', site_id: null, client_id: 'c1', source: 'standing_client' },
      ],
      inspection_templates: [
        { id: 'it_a', organization_id: ORG, name: 'Nightly Close-Out', kind: 'checklist', is_published: true, published_version_id: 'v_pub' },
      ],
      inspection_template_versions: [
        { id: 'v_pub', template_id: 'it_a', version_number: 1, status: 'published', schema },
      ],
      checklist_results: [],
      account_media: media,
      jobs: [{
        id: 'j1', organization_id: ORG, site_id: 's1', client_id: 'c1', start_at: START,
        data: { id: 'j1', clientId: 'c1', siteId: 's1', startAt: START, endAt: END, status: 'in_progress', crewIds: ['u_c1'] },
      }],
      time_entries: [{
        id: 'e_c1', organization_id: ORG, job_id: 'j1', client_id: 'c1', site_id: 's1', user_id: 'u_c1',
        clock_in_at: '2026-10-02T13:05:00.000Z', clock_out_at: null, status: 'in_progress',
        scheduled_start: START, scheduled_end: END, approval_status: 'pending', edit_history: [],
        client_punch_id: null, duration_minutes: null, row_version: 0,
      }],
      payroll_runs: [],
    },
    logins,
  });
}

async function call(handler, { method = 'POST', path: p, token, body }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath: p };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${p}: no response`)), 10000);
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

const submit = (body) => call(qc, { path: 'checklists/submit', token: 'tok-c1', body: { templateId: 'it_a', siteId: 's1', clientId: 'c1', jobId: 'j1', clientSubmitId: SUBMIT_ID, ...body } });
const clockOut = () => call(time, { path: 'clock-out', token: 'tok-c1', body: { entryId: 'e_c1' } });
const stored = () => world.tables.checklist_results;
const counts = (row) => `${row?.completed_count}/${row?.total_count}`;

// ── 0. the rule exists and reads the office's flag strictly ──────────────────
ok('the rule module exports itemRequiresPhoto', typeof itemRequiresPhoto === 'function');
ok('…and the schema reader checklistPhotoRequiredKeys', typeof checklistPhotoRequiredKeys === 'function');
if (typeof itemRequiresPhoto === 'function') {
  ok('photoRequired: true requires a photo', itemRequiresPhoto({ photoRequired: true }));
  ok('the snake_case spelling the migration documents is read too', itemRequiresPhoto({ photo_required: true }));
  ok('an unflagged item requires nothing', !itemRequiresPhoto({ label: 'x' }));
  ok('photoRequired: false requires nothing', !itemRequiresPhoto({ photoRequired: false }));
  // STRICT, like itemAllowsNa: a truthy string in a hand-edited schema must not start
  // demanding proof the cleaner was never shown a control for.
  ok('a truthy non-boolean does NOT start requiring a photo', !itemRequiresPhoto({ photoRequired: 'yes' }));
  ok('a 1 does not either', !itemRequiresPhoto({ photoRequired: 1 }));
  ok('a non-object is safe', !itemRequiresPhoto(null) && !itemRequiresPhoto('x'));
}
if (typeof checklistPhotoRequiredKeys === 'function') {
  eq('the schema reader finds exactly the marked items', JSON.stringify(checklistPhotoRequiredKeys(SCHEMA_PUB)), JSON.stringify([PHOTO_KEY]));
  eq('…and none on a checklist with no marked item', checklistPhotoRequiredKeys(SCHEMA_PLAIN).length, 0);
}

// ── 1. THE DEFECT: a marked item ticked with NO photo does not count ─────────
{
  seed();
  const r = await submit({ items: fill(SCHEMA_PUB) });
  eq('a full tick with no photo is ACCEPTED, never refused (II.8)', r.status, 200);
  eq('…but the photo-required item does not count', counts(stored()[0]), `${TOTAL - 1}/${TOTAL}`);
  ok('…so the stored row is NOT complete', !isChecklistComplete(stored()[0]), counts(stored()[0]));
  const out = await clockOut();
  eq('…and the clean\'s clock-out stays BLOCKED', out.status, 409);
  eq('…with the checklist code', out.body?.code, CHECKLIST_INCOMPLETE_CODE);
  eq('…and the honest progress', `${out.body?.done}/${out.body?.total}`, `${TOTAL - 1}/${TOTAL}`);
  ok('…the punch stays open', world.tables.time_entries[0].clock_out_at === null);
  // The cleaner's work is all still there — this is a count, not a rejection.
  eq('…the submission is stored in full', (stored()[0]?.items || []).length, TOTAL);
  ok('…including the tick on the unproven item',
    (stored()[0]?.items || []).some((i) => i.key === PHOTO_KEY && i.checked === true));
}

// ── 2. WITH the photo, the same fill completes and the cleaner clocks out ────
{
  seed({ media: [photoRow('am_1')] });
  const r = await submit({ items: fill(SCHEMA_PUB) });
  eq('the same fill with the photo on the record is stored', r.status, 200);
  eq('…and counts COMPLETE', counts(stored()[0]), `${TOTAL}/${TOTAL}`);
  ok('…isChecklistComplete agrees', isChecklistComplete(stored()[0]));
  const out = await clockOut();
  eq('…so the cleaner CLOCKS OUT', out.status, 200);
  ok('…and the punch is closed', !!world.tables.time_entries[0].clock_out_at);
}

// ── 3. only THIS item's own photo, on THIS submission, unlocks it ────────────
for (const [label, row] of [
  ['a photo on ANOTHER item of the same submission', photoRow('am_x', { areaId: 'c_lights' })],
  ['a photo on another SUBMISSION', photoRow('am_y', { refId: 'cl_someone_else' })],
  ['media at another SCOPE with the same ref', photoRow('am_z', { scope: 'inspection' })],
  ['a media row with no area at all', photoRow('am_w', { areaId: null })],
]) {
  seed({ media: [row] });
  await submit({ items: fill(SCHEMA_PUB) });
  eq(`${label} does not unlock it`, counts(stored()[0]), `${TOTAL - 1}/${TOTAL}`);
  eq(`${label}: clock-out still blocked`, (await clockOut()).status, 409);
}

// ── 4. N/A needs no photo; a submission with no id finds no photos ───────────
{
  // The office's two switches are independent: an item that may be marked N/A and also
  // carries the camera is DONE when marked N/A, because there is nothing to photograph on
  // a night the work did not happen.
  const schema = {
    areas: [{ id: 'a1', label: 'A', items: [
      item('both', 'Bins out', { photoRequired: true, naAllowed: true }),
      item('plain', 'Lights off'),
    ] }],
  };
  seed({ schema });
  await submit({ items: [{ key: 'both', na: true }, { key: 'plain', checked: true }] });
  eq('N/A on a photo-required item counts without a photo', counts(stored()[0]), '2/2');
  eq('…and the cleaner clocks out', (await clockOut()).status, 200);
}
{
  // Ticking the same item instead, with no photo, does not.
  const schema = {
    areas: [{ id: 'a1', label: 'A', items: [
      item('both', 'Bins out', { photoRequired: true, naAllowed: true }),
      item('plain', 'Lights off'),
    ] }],
  };
  seed({ schema });
  await submit({ items: [{ key: 'both', checked: true }, { key: 'plain', checked: true }] });
  eq('…while TICKING it with no photo does not', counts(stored()[0]), '1/2');
}
{
  // No submission id means the photos have nowhere to have been filed, so the marked item
  // counts as not done. Fail CLOSED — the alternative is granting proof nobody looked for.
  seed({ media: [photoRow('am_1')] });
  await submit({ clientSubmitId: null, items: fill(SCHEMA_PUB) });
  eq('a submission with no id counts the marked item as not done', counts(stored()[0]), `${TOTAL - 1}/${TOTAL}`);
}

// ── 5. a checklist with no marked item costs NO media read ───────────────────
{
  seed({ schema: SCHEMA_PLAIN });
  await submit({ items: fill(SCHEMA_PLAIN) });
  eq('an unmarked checklist still completes', counts(stored()[0]), '1/1');
  const mediaReads = world.log.filter((q) => q.table === 'account_media');
  eq('…and the server never touches account_media for it', mediaReads.length, 0);
}
{
  seed({ media: [photoRow('am_1')] });
  await submit({ items: fill(SCHEMA_PUB) });
  const mediaReads = world.log.filter((q) => q.table === 'account_media');
  eq('a marked checklist costs exactly ONE media read', mediaReads.length, 1);
  eq('…keyed on this submission', mediaReads[0]?.eq?.ref_id, SUBMIT_ID);
  eq('…and scoped to checklist media', mediaReads[0]?.eq?.scope, 'checklist');
}

// ── 6. the demo stub and the server count the same ───────────────────────────
{
  seed({ media: [photoRow('am_1')] });
  const items = fill(SCHEMA_PUB);
  await submit({ items });
  const stub = countChecklistSubmission(SCHEMA_PUB, items, { photoKeys: [PHOTO_KEY] });
  eq('the shared rule, given the same photos, counts the same completed', stub.completed_count, stored()[0]?.completed_count);
  eq('…and the same total', stub.total_count, stored()[0]?.total_count);
  const blind = countChecklistSubmission(SCHEMA_PUB, items);
  eq('…and with NO photos passed it fails closed, like a writer that did not look',
    `${blind.completed_count}/${blind.total_count}`, `${TOTAL - 1}/${TOTAL}`);
}

// ── 7. the wiring, enumerated over the source ────────────────────────────────
// The defect class here is a SECOND opinion about whether an item is proven, so what is
// checked is that there is only one.
{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const APP = path.resolve(HERE, '..');
  const code = (p) => {
    let src = '';
    try { src = readFileSync(path.join(APP, p), 'utf8'); } catch { return ''; }
    return src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  };
  const FILL = code('src/components/ChecklistFill.jsx');
  const STORE = code('api/_lib/qc/store.js');
  const FLUSH = code('src/lib/offlineFlush.js');
  const VIEW = code('src/lib/checklistResultView.js');
  const MODAL = code('src/components/ChecklistResultModal.jsx');

  ok('the server reads the PHOTOS THAT EXIST, not the payload', /checklistPhotoKeys/.test(STORE));
  ok('…and only when the published schema marks an item', /checklistPhotoRequiredKeys\(version\.schema\)/.test(STORE));
  ok('…and hands them to the shared counter', /countChecklistSubmission\(version\.schema, list, \{ photoKeys \}\)/.test(STORE));
  ok('the fill asks the shared rule which items need a photo', /itemRequiresPhoto/.test(FILL));
  ok('…holds the tick until one is attached', /disabled=\{photoBlocked\}/.test(FILL));
  // ONE id, used as BOTH the submission's idempotency key and the ref its photos are
  // filed under — the whole reason a photo taken before Submit ends up attached to the
  // submission it proves. Two ids here would be the defect wearing a fix.
  ok('…and mints ONE id, used as the submission key AND the photos\' ref',
    /const \[submissionId, setSubmissionId\] = useState/.test(FILL)
    && /clientSubmitId: submissionId/.test(FILL)
    && /submissionId=\{submissionId\}/.test(FILL));
  ok('…re-minted on every open, so two fills are two submissions',
    /setSubmissionId\(newChecklistId\(\)\)/.test(FILL));
  ok('the office\'s result view reads the same rule for an item\'s state', /itemRequiresPhoto/.test(VIEW));
  ok('…and the pop-up shows the item\'s photos', /scope: 'checklist'/.test(MODAL));
  // The ordering half: the evidence queue drains before the queue judged on it.
  const mediaAt = FLUSH.indexOf("name: 'media'");
  const listAt = FLUSH.indexOf("name: 'checklists'");
  const punchAt = FLUSH.indexOf("name: 'punches'");
  ok('the offline flush drains MEDIA before CHECKLISTS before PUNCHES',
    mediaAt > -1 && listAt > mediaAt && punchAt > listAt, `media@${mediaAt} checklists@${listAt} punches@${punchAt}`);
}

if (fails.length) { console.error('\nchecklist-item-photos FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nchecklist-item-photos: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
