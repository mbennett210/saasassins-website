// "Mark as not completed" (Matt, 2026-10-13, D2 of docs/plans/2026-10-13-cleaner-hub.md) and
// the cleaner's full-page checklist that carries it (Brief B, UI_RULES §166).
//
// THE RULE. A task the cleaner marks "not completed" WITH a short reason counts toward
// unlocking clock-out — on ANY task, with no office flag, and it needs no photo (like an N/A).
// A "not completed" with a blank (or too short) reason counts as NOT done. Ticked and
// not-completed on one item is one item; an unknown key still counts nothing; completed can
// never exceed total. The office sees every one of them as "Not completed — <reason>"; it is
// NOT cleaned, so an area holding one records no last-cleaned time (the QR page, the hub), and
// the customer's hub shows it as not done, without the reason.
//
// Proven where it matters: the REAL `/api/qc` submit then the REAL `/api/time` clock-out
// against the loopback Supabase fake (no network, no credentials — fake-supabase.mjs), plus
// the pure rules, the phone's queued gate, the office's result view, the area times, the
// customer hub's projection, the on-phone draft store, and the page's wiring read
// mechanically. Every oracle is read off the source-of-truth module (the schema, the
// constants), never restated here.
//
// REGRESSION (THE LAW II.3): on the base tree (`894f100f`) most of this goes red — the count
// ignores `notCompleted`, the result view has no such state, there is no draft store and no
// page. See the builder's report for the failing count.
//
//   node app/scripts/test-checklist-not-completed.mjs
import { Readable } from 'node:stream';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000d02';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const read = (rel) => { try { return readFileSync(path.join(APP, rel), 'utf8'); } catch { return ''; } };
// Comments describe the rule in prose; only real code counts for the wiring checks.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// Off the NAMESPACE, so on the base tree the missing exports are `undefined` and the red run
// reports the real failures rather than refusing to load.
const cc = await import('../src/lib/checklistCount.js');
const { countChecklistSubmission, itemRequiresPhoto } = cc;
const { clockOutGate, GATE, isChecklistComplete } = await import('../src/lib/crewChecklist.js');
const rv = await import('../src/lib/checklistResultView.js');
const areas = await import('../src/lib/checklistAreas.js');
const hub = await import('../src/lib/clientHubView.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const { CHECKLIST_INCOMPLETE_CODE } = await import('../src/lib/clockOutBlock.js');
const draftMod = await import('../src/lib/checklistDraft.js').catch(() => ({}));
const qc = (await import('../api/qc/[...path].js')).default;
const time = (await import('../api/time/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const safe = (fn, fallback = undefined) => { try { return fn(); } catch { return fallback; } };

const MIN = cc.NOT_COMPLETED_REASON_MIN;
const MAX = cc.NOT_COMPLETED_REASON_MAX;
ok('the reason bounds are declared once, in the rule module', Number.isInteger(MIN) && Number.isInteger(MAX) && MIN > 0 && MAX > MIN, `MIN=${MIN} MAX=${MAX}`);
const MIN_ = Number.isInteger(MIN) ? MIN : 3;
const MAX_ = Number.isInteger(MAX) ? MAX : 300;

// ── the fixture: five tasks, one the office allows N/A on, one it wants a photo of ─────────
const item = (id, label, extra = {}) => ({ id, label, photoRequired: false, naAllowed: false, ...extra });
const NA_OK = 'c_cart';
const PHOTO = 'c_glass';
const SCHEMA = {
  areas: [
    { id: 'a_lobby', label: 'Lobby', siteAreaId: 'area_lobby', items: [item('c_trash', 'Empty trash'), item(PHOTO, 'Entrance glass', { photoRequired: true })] },
    { id: 'a_rest', label: 'Restrooms', siteAreaId: 'area_rest', items: [item('c_restock', 'Restock'), item('c_walls', 'Spot-clean walls')] },
    { id: 'a_cart', label: 'Cart', items: [item(NA_OK, 'Cart restocked', { naAllowed: true })] },
  ],
};
const KEYS = SCHEMA.areas.flatMap((a) => a.items.map((i) => i.id));
const TOTAL = cc.checklistSchemaKeys ? cc.checklistSchemaKeys(SCHEMA).length : KEYS.length;
const REASON = 'Supply closet locked, no key available';
const tick = (key) => ({ key, label: key, checked: true, na: false, note: null });
const nc = (key, reason = REASON) => ({ key, label: key, checked: false, na: false, note: null, notCompleted: true, notCompletedReason: reason });
const counted = (items, opts) => { const c = countChecklistSubmission(SCHEMA, items, opts); return `${c.completed_count}/${c.total_count}`; };

// ── 1. the count rule (pure) ─────────────────────────────────────────────────
{
  const everyOtherTicked = KEYS.filter((k) => k !== 'c_walls').map(tick);
  eq('a not-completed task WITH a reason counts toward completed (no office flag needed)',
    counted([...everyOtherTicked.filter((i) => i.key !== PHOTO), nc('c_walls'), nc(PHOTO)]), `${TOTAL}/${TOTAL}`);
  eq('…with a blank reason it counts as NOT done', counted([...everyOtherTicked, nc('c_walls', '')], { photoKeys: [PHOTO] }), `${TOTAL - 1}/${TOTAL}`);
  eq('…a whitespace-only reason counts as NOT done', counted([...everyOtherTicked, nc('c_walls', '   \n\t ')], { photoKeys: [PHOTO] }), `${TOTAL - 1}/${TOTAL}`);
  eq('…a reason shorter than the minimum counts as NOT done', counted([...everyOtherTicked, nc('c_walls', 'x'.repeat(MIN_ - 1))], { photoKeys: [PHOTO] }), `${TOTAL - 1}/${TOTAL}`);
  eq('…a reason of exactly the minimum counts', counted([...everyOtherTicked, nc('c_walls', 'x'.repeat(MIN_))], { photoKeys: [PHOTO] }), `${TOTAL}/${TOTAL}`);
  eq('…a reason with no `notCompleted` flag is just text: NOT done', counted([...everyOtherTicked, { key: 'c_walls', notCompletedReason: REASON }], { photoKeys: [PHOTO] }), `${TOTAL - 1}/${TOTAL}`);
  eq('a photo-required task marked not completed counts WITHOUT a photo (like N/A)',
    counted([...KEYS.filter((k) => k !== PHOTO).map(tick), nc(PHOTO)]), `${TOTAL}/${TOTAL}`);
  eq('…while the same task ticked with no photo still does not', counted(KEYS.map(tick)), `${TOTAL - 1}/${TOTAL}`);
  eq('ticked AND not-completed on one item is ONE item', counted([...KEYS.map(tick), { ...nc('c_walls'), checked: true }], { photoKeys: [PHOTO] }), `${TOTAL}/${TOTAL}`);
  eq('a not-completed on a key the schema never heard of counts nothing', counted([nc('ghost_1'), nc('ghost_2')]), `0/${TOTAL}`);
  eq('completed never exceeds total — every task marked every way', counted([...KEYS.map((k) => ({ ...nc(k), checked: true, na: true })), nc('ghost')], { photoKeys: KEYS }), `${TOTAL}/${TOTAL}`);
  eq('marking EVERY task not completed with reasons resolves the checklist (the office still sees each one)', counted(KEYS.map((k) => nc(k))), `${TOTAL}/${TOTAL}`);
  eq('a reason over the maximum is capped, never refused, and still counts', counted([...KEYS.filter((k) => k !== 'c_walls').map(tick), nc('c_walls', 'y'.repeat(MAX_ + 50))], { photoKeys: [PHOTO] }), `${TOTAL}/${TOTAL}`);
  eq('the reason a count reads is trimmed, one line, capped',
    safe(() => cc.notCompletedReasonOf(nc('c_walls', `  Locked\n\n  closet   ${'z'.repeat(MAX_)}`))?.length), MAX_);
  eq('…and a clean one comes back as written', safe(() => cc.notCompletedReasonOf(nc('c_walls', `  ${REASON}  `))), REASON);
  eq('…a blank one is null', safe(() => cc.notCompletedReasonOf(nc('c_walls', '  '))), null);
  ok('the save button\'s reason check is the same rule (3 chars passes, 2 does not, blank does not)',
    safe(() => cc.notCompletedReasonOk('x'.repeat(MIN_))) === true && safe(() => cc.notCompletedReasonOk('x'.repeat(MIN_ - 1))) === false && safe(() => cc.notCompletedReasonOk('   ')) === false);
}

// ── 1b. the sanitizer every writer stores through ────────────────────────────
{
  const s = cc.sanitizeChecklistItems;
  ok('sanitizeChecklistItems exists', typeof s === 'function');
  const out = safe(() => s([
    { key: 'c_walls', label: 'x', checked: false, notCompleted: 'yes', notCompletedReason: `  Locked \n out  ${'q'.repeat(MAX_)}`, note: '  dusty  ', completedAt: null, extra: 1 },
    { key: 'c_trash', checked: true, notCompleted: 0, notCompletedReason: 42 },
    null, 'garbage', 7,
    { item_key: 'c_restock', checked: true },
  ]), []);
  eq('non-object entries are dropped, the rest kept in order', (out || []).map((i) => i.key || i.item_key), ['c_walls', 'c_trash', 'c_restock']);
  eq('`notCompleted` is stored as a boolean', [out?.[0]?.notCompleted, out?.[1]?.notCompleted], [true, false]);
  ok('the reason is stored one line, trimmed and capped', typeof out?.[0]?.notCompletedReason === 'string' && out[0].notCompletedReason.length === MAX_ && !/\n/.test(out[0].notCompletedReason) && out[0].notCompletedReason.startsWith('Locked out'));
  eq('a non-string reason is stored as null', out?.[1]?.notCompletedReason, null);
  eq('an item that never mentioned the two fields is left without them', ['notCompleted' in (out?.[2] || {}), 'notCompletedReason' in (out?.[2] || {})], [false, false]);
  eq('the comment (note) is trimmed', out?.[0]?.note, 'dusty');
  ok('the comment is capped at the declared maximum', Number.isInteger(cc.CHECKLIST_NOTE_MAX)
    && safe(() => s([{ key: 'k', note: 'n'.repeat(cc.CHECKLIST_NOTE_MAX + 20) }])[0].note.length) === cc.CHECKLIST_NOTE_MAX);
  eq('other fields ride through untouched', [out?.[0]?.label, out?.[0]?.extra, out?.[2]?.checked], ['x', 1, true]);
  eq('a non-array is an empty list', safe(() => s('nope')), []);
}

// ── 2. the phone's gate over a QUEUED fill (crewChecklist.queuedAsRows) ─────
{
  const ME = 'u_me';
  const JOB = 'j1';
  const LIST = 'it_list';
  const queued = (items) => [{ id: 'cl_q', payload: { templateId: LIST, jobId: JOB, siteId: 's1', completedByUserId: ME, items }, createdAt: '2026-10-13T20:00:00.000Z' }];
  const all = KEYS.map((k, i) => (i < 3 ? tick(k) : nc(k)));
  eq('a queued fill whose unfinished tasks are not completed WITH reasons unlocks the clock-out on the phone',
    clockOutGate({ checklistId: LIST, results: [], queued: queued(all), userId: ME, jobId: JOB }).state, GATE.DONE);
  const blank = KEYS.map((k, i) => (i < 3 ? tick(k) : nc(k, '')));
  eq('…the same with blank reasons stays BLOCKED', clockOutGate({ checklistId: LIST, results: [], queued: queued(blank), userId: ME, jobId: JOB }).state, GATE.BLOCKED);
  eq('…with the honest progress', clockOutGate({ checklistId: LIST, results: [], queued: queued(blank), userId: ME, jobId: JOB }).done, 3);
}

// ── 3. the REAL route: /api/qc submit, then /api/time clock-out ──────────────
const START = '2026-09-27T13:00:00.000Z';
const END = '2026-09-27T16:00:00.000Z';
const user = (id, role) => ({ id, role, status: 'active', name: id, email: `${id}@example.test` });
function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 57,
        state: {
          version: 57,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [user('u_c1', 'crew')],
          clients: [{ id: 'c1', name: 'Coral Bay HOA', crewChecklists: { u_c1: 'it_a' } }],
          sites: [{ id: 's1', clientId: 'c1', name: 'Tower', expectedCleanMins: 120 }],
          permissions: seedPermissions(), userPermissionOverrides: [],
          opsSettings: { offlineReplayWindowHours: 12 },
        },
      }],
      crew_assignments: [
        { organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' },
        { organization_id: ORG, user_id: 'u_c1', site_id: null, client_id: 'c1', source: 'standing_client' },
      ],
      inspection_templates: [{ id: 'it_a', organization_id: ORG, name: 'Nightly', kind: 'checklist', is_published: true, published_version_id: 'v_pub' }],
      inspection_template_versions: [{ id: 'v_pub', template_id: 'it_a', version_number: 1, status: 'published', schema: SCHEMA }],
      checklist_results: [],
      account_media: [],
      jobs: [{ id: 'j1', organization_id: ORG, site_id: 's1', client_id: 'c1', start_at: START,
        data: { id: 'j1', clientId: 'c1', siteId: 's1', startAt: START, endAt: END, status: 'in_progress', crewIds: ['u_c1'] } }],
      time_entries: [{
        id: 'e_c1', organization_id: ORG, job_id: 'j1', client_id: 'c1', site_id: 's1', user_id: 'u_c1',
        clock_in_at: '2026-09-27T13:05:00.000Z', clock_out_at: null, status: 'in_progress',
        scheduled_start: START, scheduled_end: END, approval_status: 'pending', edit_history: [],
        client_punch_id: null, duration_minutes: null, row_version: 0,
      }],
      payroll_runs: [],
    },
    logins: { 'tok-c1': { id: 'auth-c1', email: 'u_c1@example.test', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } } },
  });
}
async function call(handler, { method = 'POST', path: p, token, body }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method; req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath: p }; req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${p}: no response`)), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; } };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const submit = (body) => call(qc, { path: 'checklists/submit', token: 'tok-c1', body: { templateId: 'it_a', siteId: 's1', clientId: 'c1', jobId: 'j1', ...body } });
const clockOut = () => call(time, { path: 'clock-out', token: 'tok-c1', body: { entryId: 'e_c1' } });
const stored = () => world.tables.checklist_results;
const counts = (row) => `${row?.completed_count}/${row?.total_count}`;

{
  // THE BOARD: most tasks ticked, the rest marked not completed with a reason. The glass is
  // photo-required and has no photo, so it is one of the not-completed ones.
  seed();
  const items = [tick('c_trash'), tick('c_restock'), tick(NA_OK), nc(PHOTO), nc('c_walls')];
  const r = await submit({ items, clientSubmitId: 'cl_board' });
  eq('3a a fill with every unfinished task marked not completed WITH reasons is stored', r.status, 200);
  eq('…and counts complete against the published schema', counts(stored()[0]), `${TOTAL}/${TOTAL}`);
  ok('…isChecklistComplete agrees', isChecklistComplete(stored()[0]));
  const out = await clockOut();
  eq('…so the cleaner CLOCKS OUT (200)', out.status, 200);
  ok('…and the punch is closed', !!world.tables.time_entries[0].clock_out_at);
  const walls = (stored()[0]?.items || []).find((i) => i.key === 'c_walls');
  eq('3b the stored item keeps BOTH fields', [walls?.notCompleted, walls?.notCompletedReason], [true, REASON]);
}
{
  seed();
  const items = [tick('c_trash'), tick('c_restock'), tick(NA_OK), nc(PHOTO, ''), nc('c_walls', '  ')];
  const r = await submit({ items });
  eq('3c the same fill with BLANK reasons is still accepted (II.8)', r.status, 200);
  eq('…but counts the two as not done', counts(stored()[0]), `${TOTAL - 2}/${TOTAL}`);
  const out = await clockOut();
  eq('…and the clock-out is BLOCKED (409)', out.status, 409);
  eq('…with the checklist code', out.body?.code, CHECKLIST_INCOMPLETE_CODE);
  eq('…and the honest progress', `${out.body?.done}/${out.body?.total}`, `${TOTAL - 2}/${TOTAL}`);
  ok('…the punch stays open', world.tables.time_entries[0].clock_out_at === null);
}
{
  // The forgery the schema check exists to stop: not-completed on invented keys.
  seed();
  await submit({ items: [nc('ghost_1'), nc('ghost_2'), nc('ghost_3'), nc('ghost_4'), nc('ghost_5')] });
  eq('3d not-completed on keys the checklist never heard of counts nothing', counts(stored()[0]), `0/${TOTAL}`);
  eq('…and the clock-out is blocked', (await clockOut()).status, 409);
}
{
  // The stored reason is sanitized on the SERVER, whatever the phone sent.
  seed();
  await submit({ items: [...KEYS.filter((k) => k !== 'c_walls').map(tick), { key: 'c_walls', notCompleted: 'true', notCompletedReason: `\n  Ladder\n   broken ${'w'.repeat(MAX_)}` }] });
  const walls = (stored()[0]?.items || []).find((i) => i.key === 'c_walls');
  eq('3e the server stores `notCompleted` as a boolean', walls?.notCompleted, true);
  ok('…and the reason trimmed, one line and capped', typeof walls?.notCompletedReason === 'string' && walls.notCompletedReason.length === MAX_ && walls.notCompletedReason.startsWith('Ladder broken'),
    JSON.stringify(walls?.notCompletedReason?.slice(0, 20)));
  // The demo stub runs the same two calls over the same list: its count can never differ.
  const posted = [...KEYS.filter((k) => k !== 'c_walls').map(tick), { key: 'c_walls', notCompleted: 'true', notCompletedReason: 'Ladder broken' }];
  const stub = safe(() => countChecklistSubmission(SCHEMA, cc.sanitizeChecklistItems(posted), {}), {});
  seed();
  await submit({ items: posted });
  eq('3f PARITY: the stub\'s expression counts what the real route stored', `${stub.completed_count}/${stub.total_count}`, counts(stored()[0]));
}

// ── 4. the office's result view ──────────────────────────────────────────────
{
  const S = rv.ITEM_STATE || {};
  ok('4a the result view has a NOT_COMPLETED state of its own', typeof S.NOT_COMPLETED === 'string' && ![S.DONE, S.NA, S.NOT_DONE].includes(S.NOT_COMPLETED));
  const items = [tick('c_trash'), tick(PHOTO), tick('c_restock'), nc('c_walls'), { key: NA_OK, na: true }];
  const row = { id: 'cr1', template_snapshot: { name: 'Nightly', schema: SCHEMA }, items, ...countChecklistSubmission(SCHEMA, items, { photoKeys: [PHOTO] }) };
  const view = safe(() => rv.projectChecklistResult(row, { photoKeys: [PHOTO] }), null);
  const walls = view?.items?.find((i) => i.key === 'c_walls');
  eq('4b the task reads NOT_COMPLETED with its reason', [walls?.state, walls?.reason], [S.NOT_COMPLETED, REASON]);
  eq('4c the derived "done" equals the count the server stored (resolved)', view?.counts?.done, row.completed_count);
  eq('4d …and the not-completed are counted apart', view?.counts?.notCompleted, 1);
  eq('4e …never as "not done"', view?.counts?.notDone, 0);
  ok('4f "Needs a look" lists it', (view?.exceptions || []).some((i) => i.key === 'c_walls' && i.state === S.NOT_COMPLETED));
  ok('4g it has its own filter chip', Array.isArray(rv.RESULT_FILTERS) && rv.RESULT_FILTERS.includes(S.NOT_COMPLETED));
  eq('4h …which shows exactly the not-completed tasks', safe(() => rv.filterResultItems(view.items, S.NOT_COMPLETED).map((i) => i.key)), ['c_walls']);
  eq('4i …and "only what wasn\'t done" is still strictly not done', safe(() => rv.filterResultItems(view.items, S.NOT_DONE).map((i) => i.key)), []);
  const blankRow = { ...row, items: [tick('c_trash'), tick(PHOTO), tick('c_restock'), nc('c_walls', ''), { key: NA_OK, na: true }] };
  eq('4j a not-completed with a blank reason reads NOT DONE', safe(() => rv.projectChecklistResult(blankRow, { photoKeys: [PHOTO] }).items.find((i) => i.key === 'c_walls').state), S.NOT_DONE);
  const area = view?.areas?.find((a) => a.id === 'a_rest');
  eq('4k the area tallies it', [area?.done, area?.total, area?.notCompleted], [2, 2, 1]);
  const noSchema = safe(() => rv.projectChecklistResult({ items: [nc('c_walls'), tick('c_trash')] }), null);
  eq('4l without a schema the submitted mark still reads NOT_COMPLETED', noSchema?.items?.[0]?.state, S.NOT_COMPLETED);
}

// ── 5. it is NOT cleaned: the area times and the QR page ────────────────────
{
  const PERFORMED = '2026-10-13T23:00:00.000Z';
  const restAllDone = [tick('c_trash'), tick(PHOTO), tick('c_restock'), tick('c_walls'), tick(NA_OK)];
  const withNc = [tick('c_trash'), tick(PHOTO), tick('c_restock'), nc('c_walls'), tick(NA_OK)];
  const timesDone = areas.areaCompletionTimes(SCHEMA, restAllDone, { performedAt: PERFORMED, photoKeys: [PHOTO] });
  const timesNc = areas.areaCompletionTimes(SCHEMA, withNc, { performedAt: PERFORMED, photoKeys: [PHOTO] });
  ok('5a a fully ticked Restrooms area records a time (control)', !!timesDone.a_rest);
  ok('5b an area holding a not-completed task records NO time', !timesNc.a_rest, JSON.stringify(timesNc));
  ok('5c …while the other areas of the same fill still do', !!timesNc.a_lobby && !!timesNc.a_cart);
  const row = { id: 'r1', client_submit_id: 'cl_x', completed_by_user_id: 'u_c1', performed_at: PERFORMED,
    template_snapshot: { name: 'Nightly', schema: SCHEMA }, items: withNc, area_completions: timesNc };
  const status = areas.siteAreaStatus({ cleaningAreas: [{ id: 'area_lobby', label: 'Lobby' }, { id: 'area_rest', label: 'Restrooms' }], results: [row], media: [{ id: 'm1', ref_id: 'cl_x', area_id: PHOTO, created_at: PERFORMED }] });
  eq('5d the QR page\'s answer: the restrooms have no last-cleaned time', status.find((a) => a.areaId === 'area_rest')?.lastCleanedAt, null);
  ok('5e …the lobby does', !!status.find((a) => a.areaId === 'area_lobby')?.lastCleanedAt);
}

// ── 6. the customer hub: not done, and never the reason ─────────────────────
{
  const items = [tick('c_trash'), tick(PHOTO), tick('c_restock'), nc('c_walls'), tick(NA_OK)];
  const row = { id: 'cr_h', template_snapshot: { name: 'Nightly', kind: 'checklist', schema: SCHEMA }, items, performed_at: '2026-10-13T23:00:00.000Z',
    completed_by_user_id: 'u_c1', ...countChecklistSubmission(SCHEMA, items, { photoKeys: [PHOTO] }) };
  const out = safe(() => hub.projectHubChecklist(row, { cleanerName: 'Andre Baptiste', photoKeys: [PHOTO] }), null);
  const walls = out?.areas?.flatMap((a) => a.items).find((i) => i.key === 'c_walls');
  eq('6a the customer sees the task as NOT DONE', walls?.state, 'notdone');
  ok('6b 🔴 the reason appears nowhere in what the hub serves', !!out && !JSON.stringify(out).includes(REASON) && !/notCompleted|notcompleted|reason/i.test(JSON.stringify(out)), JSON.stringify(out)?.slice(0, 200));
  eq('6c the headline counts it as not done', [out?.done, out?.total, out?.notDone, out?.complete], [TOTAL - 1, TOTAL, 1, false]);
  const restArea = out?.areas?.find((a) => a.id === 'a_rest');
  eq('6d …and so does its area', [restArea?.done, restArea?.total], [1, 2]);
  ok('6e the hub still serves exactly its allowlist', !!out && Object.keys(out).sort().join() === [...hub.HUB_CHECKLIST_FIELDS].sort().join());
}

// ── 7. the phone's draft (UI_RULES §154): retention at the write point, try/catch ──
{
  const D = draftMod;
  ok('7a lib/checklistDraft.js exists and exports the integration pass\'s four', ['readChecklistDraft', 'draftItems', 'clearChecklistDraft', 'submitChecklistDraft'].every((k) => typeof D[k] === 'function'),
    Object.keys(D).join(','));
  const mem = () => {
    const m = new Map();
    return {
      m,
      get length() { return m.size; },
      key: (i) => [...m.keys()][i] ?? null,
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => { m.set(k, String(v)); },
      removeItem: (k) => { m.delete(k); },
    };
  };
  const id = { jobId: 'j1', templateId: 'it_a', userId: 'u_c1' };
  const key = safe(() => D.checklistDraftKey(id));
  eq('7b the key is per (clean, checklist, cleaner)', key, 'cleanspace_crew_checklist_draft_v1:j1:it_a:u_c1');
  const store = mem();
  const draft = { submissionId: 'cl_first', checks: { c_walls: { notCompleted: true, reason: REASON, at: '2026-10-13T22:00:00.000Z' }, c_trash: { checked: true } }, photos: { c_trash: 1 } };
  ok('7c a write is remembered', safe(() => D.writeChecklistDraft(id, draft, { store, now: Date.parse('2026-10-13T22:00:00Z') })) === true);
  const back = safe(() => D.readChecklistDraft(id, { store, now: Date.parse('2026-10-13T22:05:00Z') }));
  eq('…and read back, the submission id the draft minted first included', [back?.submissionId, back?.checks?.c_walls?.reason, back?.photos?.c_trash], ['cl_first', REASON, 1]);
  // Retention: 30 drafts at most, none older than three days.
  const many = mem();
  const base = Date.parse('2026-10-10T00:00:00Z');
  for (let i = 0; i < 40; i += 1) safe(() => D.writeChecklistDraft({ jobId: `j${i}`, templateId: 't', userId: 'u' }, { submissionId: `s${i}`, checks: {}, photos: {} }, { store: many, now: base + i * 60000 }));
  const kept = [...many.m.keys()].filter((k) => k.startsWith('cleanspace_crew_checklist_draft_v1:'));
  eq('7d no more than CHECKLIST_DRAFT_MAX drafts are kept', kept.length, D.CHECKLIST_DRAFT_MAX);
  ok('…the newest ones', kept.includes('cleanspace_crew_checklist_draft_v1:j39:t:u') && !kept.includes('cleanspace_crew_checklist_draft_v1:j0:t:u'));
  safe(() => D.writeChecklistDraft({ jobId: 'late', templateId: 't', userId: 'u' }, { submissionId: 'sl', checks: {}, photos: {} }, { store: many, now: base + D.CHECKLIST_DRAFT_MAX_AGE_MS + 3600e3 }));
  const left = [...many.m.keys()].filter((k) => k.startsWith('cleanspace_crew_checklist_draft_v1:'));
  ok('7e a draft past the age ceiling is dropped at the next write', D.CHECKLIST_DRAFT_MAX_AGE_MS > 0 && !left.includes('cleanspace_crew_checklist_draft_v1:j0:t:u') && left.includes('cleanspace_crew_checklist_draft_v1:late:t:u') && left.length < 30, left.length);
  ok('7f …and an expired one reads as nothing', safe(() => D.readChecklistDraft({ jobId: 'j39', templateId: 't', userId: 'u' }, { store: many, now: base + 10 * 86400e3 })) === null);
  ok('7g a phone that refuses storage never throws: a read is null', safe(() => D.readChecklistDraft(id, { store: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); }, key() { throw new Error('denied'); }, get length() { throw new Error('denied'); } } }), 'threw') === null);
  ok('…a write is false', safe(() => D.writeChecklistDraft(id, draft, { store: { getItem() { throw new Error('quota'); }, setItem() { throw new Error('quota'); }, removeItem() {}, key: () => null, length: 0 } }), 'threw') === false);
  ok('…a clear is quiet', safe(() => { D.clearChecklistDraft(id, { store: { removeItem() { throw new Error('x'); } } }); return true; }, false));
  const bad = mem(); bad.setItem(key || 'k', '{not json');
  ok('7h a corrupt draft reads as nothing', safe(() => D.readChecklistDraft(id, { store: bad }), 'threw') === null);
  safe(() => D.clearChecklistDraft(id, { store }));
  ok('7i clearChecklistDraft removes it', safe(() => D.readChecklistDraft(id, { store })) === null);
  const two = mem();
  safe(() => D.writeChecklistDraft(id, draft, { store: two }));
  two.setItem('unrelated', 'keep me');
  safe(() => D.clearAllChecklistDrafts({ store: two }));
  ok('7j sign-out clears every draft and nothing else', [...two.m.keys()].join() === 'unrelated');

  // draftItems: the list posted is the list counted.
  const posted = safe(() => D.draftItems(SCHEMA, { submissionId: 'x', checks: { c_trash: { checked: true, at: '2026-10-13T21:00:00.000Z' }, c_walls: { notCompleted: true, reason: REASON }, [NA_OK]: { na: true }, c_restock: { checked: true, note: 'Out of soap' } }, photos: {} }), []);
  eq('7k draftItems posts one entry per schema task, in schema order', (posted || []).map((i) => i.key), KEYS);
  const walls = (posted || []).find((i) => i.key === 'c_walls');
  eq('…a not-completed task carries its flag and reason', [walls?.notCompleted, walls?.notCompletedReason, walls?.checked], [true, REASON, false]);
  eq('…a comment rides as the item\'s note', (posted || []).find((i) => i.key === 'c_restock')?.note, 'Out of soap');
  eq('…a tick carries when it was made (QR-1)', (posted || []).find((i) => i.key === 'c_trash')?.completedAt, '2026-10-13T21:00:00.000Z');
  eq('…and the count over it is the server\'s', counted(posted), `${TOTAL - 1}/${TOTAL}`);

  // submitChecklistDraft: ONE submission, under the id the draft minted first, then cleared.
  const sent = [];
  const sstore = mem();
  safe(() => D.writeChecklistDraft(id, draft, { store: sstore }));
  const res = await Promise.resolve(safe(() => D.submitChecklistDraft({
    job: { id: 'j1', siteId: 's1', clientId: 'c1' }, templateId: 'it_a', userId: 'u_c1', schema: SCHEMA,
    store: sstore, submit: async (p) => { sent.push(p); return { id: 'cr_new' }; },
  }), null)).catch(() => null);
  eq('7l submitChecklistDraft sends exactly ONE submission', sent.length, 1);
  eq('…under the draft\'s own id, which its photos were filed under (CS-547)', sent[0]?.clientSubmitId, 'cl_first');
  eq('…for this clean, this location and this cleaner', [sent[0]?.jobId, sent[0]?.siteId, sent[0]?.clientId, sent[0]?.templateId, sent[0]?.completedByUserId], ['j1', 's1', 'c1', 'it_a', 'u_c1']);
  ok('…with the draft\'s items', Array.isArray(sent[0]?.items) && sent[0].items.length === KEYS.length);
  eq('…and the draft is cleared once it is sent', safe(() => D.readChecklistDraft(id, { store: sstore })), null);
  ok('…returning what the API answered', res?.id === 'cr_new');
  const none = [];
  const r2 = await Promise.resolve(safe(() => D.submitChecklistDraft({ job: { id: 'j9' }, templateId: 'it_a', userId: 'u_c1', schema: SCHEMA, store: mem(), submit: async (p) => { none.push(p); } }), null)).catch(() => 'threw');
  ok('7m no draft → nothing is sent and the answer is null', none.length === 0 && r2 === null);
}

// ── 8. the wiring, read mechanically ─────────────────────────────────────────
{
  const PAGE = 'src/pages/crew/CrewChecklist.jsx';
  ok('8a the page exists', existsSync(path.join(APP, PAGE)));
  const page = code(PAGE);
  const app = code('src/App.jsx');
  ok('8b App.jsx routes my-day/checklist/:jobId to the page behind qc.checklist.perform, remounted per clean',
    /<Route\s+path="my-day\/checklist\/:jobId"\s+element=\{<RequirePerm perm="qc\.checklist\.perform"><KeyedByParam name="jobId"><CrewChecklist\s*\/><\/KeyedByParam><\/RequirePerm>\}/.test(app)
    && /lazyRoute\(\(\) => import\('\.\/pages\/crew\/CrewChecklist'\)\)/.test(app));
  ok('8c the route path is crewPaths.checklist\'s', /checklist:\s*\(jobId(?:,\s*\w+)?\)\s*=>\s*`\$\{CREW_HOME_PATH\}\/checklist\//.test(read('src/lib/crewPaths.js')));
  ok('8d the service worker keeps the page on the phone', /'src\/pages\/crew\/CrewChecklist\.jsx'/.test(read('vite-plugins/sw-precache.mjs')));
  ok('8e the page is on the catalog (CONVERTED)', /'src\/pages\/crew\/CrewChecklist\.jsx'/.test(read('scripts/test-i18n-coverage.mjs')));
  ok('8f the page resolves the cleaner\'s OWN checklist (covers included)', /checklistFor\(\{\s*client,\s*job,\s*userId/.test(page) && /coveredCleanerId/.test(page));
  ok('8g …loads the PUBLISHED schema', /getTemplate\(/.test(page) && /published\?\.schema|published\.schema/.test(page));
  ok('8h …counts with the server\'s rule over the posted list + photo keys', /countChecklistSubmission\(schema,\s*items,\s*\{\s*photoKeys\s*\}\)/.test(page));
  ok('8i …saves through the draft (one submission, its minted id)', /submitChecklistDraft\(/.test(page) && /writeChecklistDraft\(/.test(page));
  ok('8j …is disabled while the owner previews', /useCrewPreview\(\)/.test(page) && /previewing/.test(page));
  ok('8k …honours the office\'s per-cleaner lock switch', /checklistBlockOff/.test(page));
  ok('8l …reads the clean\'s window (CS-690)', /checklistFillRefusal\(/.test(page));
  ok('8m …asks the reason rule the count reads', /notCompletedReasonOk\(/.test(page));
  ok('8n …offers N/A only where the office allows it (CS-546)', /itemAllowsNa\(/.test(page));
  ok('8o …a photo on EVERY task (ChecklistItemPhoto), the required tick still waits for it', /<ChecklistItemPhoto/.test(page) && /itemRequiresPhoto\(/.test(page));
  ok('8p …Clock Out goes to crewPaths.clock', /crewPaths\.clock\(/.test(page));
  ok('8q …never hand-writes a /my-day path', !/['"`]\/my-day/.test(page));
  const clean = code('src/components/CleanChecklist.jsx');
  ok('8r CleanChecklist\'s crew button opens the page (crewPaths.checklist), with the referrer', /navigate\(crewPaths\.checklist\([^)]*\),\s*\{\s*state:\s*nav\s*\}\)/.test(clean));
  ok('8s …and no longer opens the ChecklistFill modal (replace means delete)', !/ChecklistFill/.test(clean));
  ok('8t sign-out clears the drafts beside the gate memo', /clearAllChecklistDrafts\(\)/.test(code('src/auth/AuthProvider.jsx')));
  ok('8u the server stores items through the sanitizer', /sanitizeChecklistItems\(/.test(code('api/_lib/qc/store.js')));
  ok('8v …and so does the demo stub', /sanitizeChecklistItems\(/.test(code('src/lib/qcApi.js')));
  const modal = code('src/components/ChecklistResultModal.jsx');
  ok('8w the office\'s pop-up names the state and the reason', /ITEM_STATE\.NOT_COMPLETED/.test(modal) && /\.reason/.test(modal));
  ok('8x the Quality hub\'s Checklists rows say how many were not completed', /notCompletedCountOf\(/.test(code('src/pages/Inspections.jsx')));
  ok('8y the queued gate counts through the shared rule', /itemNotCompleted\(/.test(code('src/lib/crewChecklist.js')));
}

// ── 9. a QR scan opens the page at its area (`crewPaths.checklist(jobId, areaId)` → ?area=) ──
{
  const pick = areas.schemaAreasFor;
  ok('9a the area rule lives beside siteAreaIdOf (lib/checklistAreas)', typeof pick === 'function');
  const S2 = { areas: [
    { id: 'sec_lobby', label: 'Lobby', siteAreaId: 'area_lobby', items: [item('x1', 'X1')] },
    { id: 'sec_rest', label: 'Restrooms', site_area_id: 'area_rest', items: [item('x2', 'X2')] },
    { id: 'sec_rest2', label: 'Restrooms (2nd floor)', siteAreaId: 'area_rest', items: [item('x3', 'X3')] },
  ] };
  eq('9b a building area (the QR code\'s) finds every section linked to it, in schema order', safe(() => pick(S2, 'area_rest')), ['sec_rest', 'sec_rest2']);
  eq('9c a checklist section\'s own id finds that section', safe(() => pick(S2, 'sec_lobby')), ['sec_lobby']);
  eq('9d an unknown area finds nothing', safe(() => pick(S2, 'area_pool')), []);
  eq('9e no area (or no schema) finds nothing', [safe(() => pick(S2, null)), safe(() => pick(S2, '  ')), safe(() => pick(null, 'area_rest'))], [[], [], []]);
  const page = code('src/pages/crew/CrewChecklist.jsx');
  ok('9f the page reads ?area= from the URL', /useSearchParams\(\)/.test(page) && /\.get\('area'\)/.test(page));
  ok('9g …asks the shared rule which sections it names', /schemaAreasFor\(schema,/.test(page));
  ok('9h …scrolls the first into view once the checklist has loaded, once', /scrollIntoView\(/.test(page) && /focusedOnce/.test(page));
  ok('9i …and marks them for a moment with a token-only class', /crew-chk-area-focus/.test(page)
    && /\.crew-chk-area\.crew-chk-area-focus\s*\{[^}]*var\(--/.test(read('src/index.css'))
    && !/\.crew-chk-area\.crew-chk-area-focus\s*\{[^}]*#[0-9a-f]{3,8}/i.test(read('src/index.css')));
}

if (fails.length) { console.error('\nchecklist-not-completed FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nchecklist-not-completed: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
