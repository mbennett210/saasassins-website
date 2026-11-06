// An inspection LEFT OPEN AND FINISHED LATER (Matt, the 2026-10-06 call; plan
// docs/plans/2026-10-11-oct-6-call-additions.md §3, D7–D9).
//
// Matt: "if I'm walking a site right now, and then I have to go look at another site, for
// whatever reason, I might leave that inspection open." Before this build the record was made
// as a draft at Start and every tick lived ONLY in the form's memory until Submit, so closing
// the form lost them all (production, 2026-10-10: two drafts started with 0 items saved).
//
// Held here, through the REAL api/qc and api/public/qc handlers over the loopback Supabase fake
// (fake-supabase.mjs — never production) and through the demo stub (lib/qcApi):
//   A. the pure rules (lib/inspectionDrafts): what a draft stores, who may work it, when it is
//      stale, which copy wins on open (the device's when it is newer);
//   B. the server: save-draft round trip; a submitted record refused (409) with the status
//      predicate ON the update; save-draft scores nothing, rings nobody, opens no ticket, emails
//      no client and writes no activity row; who (the inspector or the office, never another
//      manager); Continue → Submit opens exactly ONE ticket; Discard removes the items and the
//      photos (rows and Storage objects); 30-day retention on create, bounded; the caller's own
//      drafts; the list's "N of M answered";
//   C. every read that must exclude a draft does — with a draft that HAS saved ticks: the public
//      link and its PDF, the figures, the Reports tally, the latest-by-customer read (the
//      reminders and the manager Home's "due"), the customer hub's reads and its history, the
//      manager Home's trend;
//   D. the demo stub does the same;
//   E. the form and the list, read mechanically (the drive is the screenshots);
//   F. CS-649: every inspection read and write is pinned to the organization — another org's
//      record, share token or template is a 404 on every route, and nothing of it changes;
//   G. CS-650: save-draft and Submit each write through ONE database function that locks the
//      record first (public.inspection_write, migration 20261011110000), so they serialize: a
//      Submit can no longer land inside a save, a save can no longer land inside a Submit, and
//      a second Submit's `prev` (the activity row, the client email) is what the first left.
//
// REGRESSION (THE LAW II.3): on the pre-change tree there is no lib/inspectionDrafts and no
// save-draft / draft / discard / drafts branch, so §A, §B and every §C check that first saves a
// draft go red. §F and §G go red on the tree before CS-649 / CS-650 (`89c8e19a`): the reads by
// id alone answer another org's record, and the two writers interleave.
//
//   node app/scripts/test-inspection-drafts.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world, INSPECTION_WRITE_PATCH_KEYS } from './fake-supabase.mjs';
import { installResolveShim } from './deletion-core.mjs';

const ORG = '00000000-0000-0000-0000-000000000011';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
for (const k of ['SYSTEM_SENDER_EMAIL', 'APP_PUBLIC_URL', 'APP_BASE_URL', 'APP_URL']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();
installResolveShim(); // the stub (lib/qcApi) is written for Vite's extensionless imports

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };

const D = await tryImport('../src/lib/inspectionDrafts.js');
const { inspectionFillItems, scoreInspection } = await import('../src/lib/inspections.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const { inspectionTrend } = await import('../src/lib/managerHome.js');
const qc = (await import('../api/qc/[...path].js')).default;
const pub = (await import('../api/public/qc/[...path].js')).default;
const hubReads = await import('../api/_lib/clientHub/reads.js');
const activity = await import('../api/_lib/activityLog.js');
const notify = await tryImport('../api/_lib/clientHub/notify.js');

// The source-of-truth constants, read off the module (fallbacks only so the pre-change run can
// REPORT what it wanted instead of dying on a TypeError).
const RETENTION_DAYS = D.DRAFT_RETENTION_DAYS ?? 30;
const SWEEP_MAX = D.DRAFT_RETENTION_SWEEP_MAX ?? 25;
const COMMENT_MAX = D.MAX_DRAFT_ITEM_COMMENT_LEN ?? 2000;
const NOT_A_DRAFT = D.DRAFT_CODES?.notADraft ?? 'not-a-draft';
const NOT_YOURS = D.DRAFT_CODES?.notYours ?? 'not-your-draft';

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). The repo's suites disagree; this one is label-first.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const fn = (name) => (typeof D[name] === 'function' ? D[name] : () => { throw new Error(`lib/inspectionDrafts.${name} is missing`); });

// ── the fixture ──────────────────────────────────────────────────────────────
const SCHEMA = {
  areas: [
    { id: 'a_rest', label: 'Restrooms', items: [{ id: 'r_floor', label: 'Floor' }, { id: 'r_sink', label: 'Sink' }] },
    { id: 'a_break', label: 'Break room', items: [{ id: 'b_counter', label: 'Counter' }, { id: 'b_fridge', label: 'Fridge', naAllowed: true }] },
    { id: 'a_lobby', label: 'Lobby', items: [{ id: 'l_glass', label: 'Glass' }, { id: 'l_mats', label: 'Mats' }] },
  ],
};
const SNAP = { name: 'Nightly Janitorial QC', kind: 'inspection', rating_scale: { type: 'passfail', passThreshold: 80 }, schema: SCHEMA };
const NUM_SNAP = { name: 'Rated QC', kind: 'inspection', rating_scale: { type: 'numeric', max: 5, passThreshold: 80 }, schema: SCHEMA };
const TOTAL_ITEMS = SCHEMA.areas.reduce((n, a) => n + a.items.length, 0);

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();
const ago = (ms) => new Date(NOW - ms).toISOString();
const user = (id, role) => ({ id, role, status: 'active', name: `${id} name`, email: `${id}@example.test` });
const USERS = [user('u_m', 'manager'), user('u_m2', 'manager'), user('u_o', 'owner'), user('u_a', 'admin'), user('u_c', 'crew'), user('u_sup', 'manager')];
const login = (role, id) => ({ id: `auth-${id}`, email: `${id}@example.test`, app_metadata: { role, org_user_id: id, org_id: ORG } });
const LOGINS = { 'tok-mgr': login('manager', 'u_m'), 'tok-mgr2': login('manager', 'u_m2'), 'tok-owner': login('owner', 'u_o'), 'tok-admin': login('admin', 'u_a'), 'tok-crew': login('crew', 'u_c') };
const CU = 'a0000000-0000-4000-8000-0000000000c1';

const DRAFT = 'b0000000-0000-4000-8000-000000000001';     // u_m's open draft at c1/s1
const OLD_DRAFT = 'b0000000-0000-4000-8000-000000000002'; // untouched 31 days
const KEEP_DRAFT = 'b0000000-0000-4000-8000-000000000003'; // untouched 29 days
const OLD_SUB = 'b0000000-0000-4000-8000-000000000004';   // submitted 60 days ago
const SUB = 'b0000000-0000-4000-8000-000000000005';       // submitted yesterday, 100%
const M2_DRAFT = 'b0000000-0000-4000-8000-000000000006';  // u_m2's draft at s1
const rec = (id, { status = 'draft', inspector = 'u_m', site = 's1', performed = ago(3600000), updated = performed, score = null, result = null, org = ORG } = {}) => ({
  id, organization_id: org, public_token: `tok_${id.slice(-2)}`, template_id: 'it_i', template_version_id: 'v_i', template_snapshot: SNAP,
  client_id: 'c1', site_id: site, job_id: null, time_entry_id: null, inspector_user_id: inspector,
  client_name: 'Coral Bay HOA', site_name: 'Clubhouse', inspector_name: `${inspector} name`,
  overall_score: score, result, status, internal_note: null, performed_at: performed, created_at: performed, updated_at: updated,
});
const media = (id, ref, { thumb = null } = {}) => ({
  id, organization_id: ORG, scope: 'inspection', ref_id: ref, area_id: 'before', site_id: 's1', client_id: 'c1', kind: 'image',
  mime_type: 'image/jpeg', storage_path: `${ORG}/s1/${id}.jpg`, thumb_path: thumb, caption: null, uploaded_by_user_id: 'u_m', created_at: ago(DAY),
});

function seed({ extraRecords = [], extraMedia = [] } = {}) {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 7,
        state: {
          version: 58,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: USERS,
          clients: [{ id: 'c1', name: 'Coral Bay HOA', supervisorId: 'u_sup', status: 'active' }],
          sites: [{ id: 's1', clientId: 'c1', name: 'Clubhouse' }, { id: 's2', clientId: 'c1', name: 'Annexe' }],
          permissions: seedPermissions(),
          userPermissionOverrides: [],
          notifications: [],
        },
      }],
      crew_assignments: [{ organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' }],
      jobs: [],
      time_entries: [],
      checklist_results: [],
      inspection_templates: [{ id: 'it_i', organization_id: ORG, name: SNAP.name, kind: 'inspection', is_published: true, published_version_id: 'v_i', rating_scale: SNAP.rating_scale }],
      inspection_template_versions: [{ id: 'v_i', template_id: 'it_i', version_number: 1, status: 'published', schema: SCHEMA }],
      inspection_records: [
        rec(DRAFT),
        rec(OLD_DRAFT, { performed: ago(40 * DAY), updated: ago((RETENTION_DAYS + 1) * DAY) }),
        rec(KEEP_DRAFT, { performed: ago(40 * DAY), updated: ago((RETENTION_DAYS - 1) * DAY) }),
        rec(OLD_SUB, { status: 'submitted', performed: ago(60 * DAY), score: 100, result: 'pass' }),
        rec(SUB, { status: 'submitted', performed: ago(DAY), score: 100, result: 'pass' }),
        rec(M2_DRAFT, { inspector: 'u_m2', performed: ago(2 * 3600000) }),
        ...extraRecords,
      ],
      inspection_items: [
        { id: 'ii_old', inspection_id: OLD_DRAFT, item_key: 'r_floor', label: 'Restrooms. Floor', rating: 'pass', comment: null, photo_count: 0 },
        { id: 'ii_sub', inspection_id: SUB, item_key: 'r_floor', label: 'Restrooms. Floor', rating: 'pass', comment: null, photo_count: 0 },
      ],
      account_media: [
        media('m_d1', DRAFT, { thumb: `${ORG}/s1/m_d1.thumb.jpg` }), media('m_d2', DRAFT),
        media('m_old', OLD_DRAFT), media('m_sub', SUB),
        ...extraMedia,
      ],
      problem_reports: [],
      work_order_messages: [],
      activity_log: [],
      client_users: [{ id: CU, organization_id: ORG, name: 'Pat Manager', email: 'pat@coralbay.test', phone: null, status: 'active', auth_user_id: 'auth-cu' }],
      client_user_groups: [],
      client_user_group_members: [],
      client_user_assignments: [{ id: 'as1', organization_id: ORG, client_user_id: CU, client_id: 'c1', group_id: null }],
    },
    logins: LOGINS,
  });
}

async function call(handler, method, subpath, { token = 'tok-mgr', body = null, query = {} } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath, ...query };
  req.body = body || {};
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null }), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => done('threw', { error: e?.message }));
    });
  } finally { Object.assign(console, quiet); }
}
const qcPost = (sub, body, token = 'tok-mgr') => call(qc, 'POST', sub, { token, body });
const qcGet = (sub, query = {}, token = 'tok-mgr') => call(qc, 'GET', sub, { token, query });
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 220)}`;
const recOf = (id) => (world.tables.inspection_records || []).find((r) => r.id === id) || null;
const itemsOf = (id) => (world.tables.inspection_items || []).filter((r) => r.inspection_id === id);
const mediaOf = (id) => (world.tables.account_media || []).filter((r) => r.ref_id === id);
const notes = () => world.tables.org_state[0].state.notifications || [];
const removedPaths = () => world.storage.filter((s) => s.op === 'remove').map((s) => s.path);

// Matt walking a site: four boxes ticked of six, the fridge N/A, a comment on the mats, and a
// note for the office.
const ANSWERS = {
  r_floor: { ticked: true }, r_sink: { ticked: true }, b_counter: { ticked: true },
  b_fridge: { na: true }, l_mats: { comment: 'Edges curling by the door.' },
};
const NOTE = 'Gate code changed; ask the HOA.';

// ── A. the pure rules ────────────────────────────────────────────────────────
{
  const items = (() => { try { return fn('draftItemsFromAnswers')(SNAP, ANSWERS); } catch (e) { fails.push(`A0 ${e.message}`); return []; } })();
  eq('A1 a draft stores only the touched items, in schema order', items.map((i) => i.item_key), ['r_floor', 'r_sink', 'b_counter', 'b_fridge', 'l_mats']);
  eq('A2 …a tick as a pass, N/A as na, a comment alone with no rating (unticked is not yet a fail)',
    items.map((i) => i.rating), ['pass', 'pass', 'pass', 'na', null]);
  eq('A3 …each labelled from the schema, as Submit labels it', items.map((i) => i.label).slice(0, 2), inspectionFillItems(SNAP, ANSWERS).map((i) => i.label).slice(0, 2));
  const back = (() => { try { return fn('answersFromItems')(SNAP, items); } catch { return null; } })();
  eq('A4 the stored items reopen as the same answers (Continue)', back, ANSWERS);
  const dirty = [
    { item_key: 'r_floor', label: 'HACKED LABEL', rating: 'pass' },
    { item_key: 'r_floor', label: 'dupe', rating: 'na' },
    { item_key: 'ghost', label: 'Not in the schema', rating: 'pass' },
    { item_key: 'r_sink', label: 'x', rating: 'fail' },
    { item_key: 'l_glass', label: 'x', rating: 'na' },
    { item_key: 'l_mats', label: 'x', rating: null, comment: 'y'.repeat(COMMENT_MAX + 500) },
  ];
  const clean = (() => { try { return fn('sanitizeDraftItems')(SNAP, dirty); } catch { return []; } })();
  eq('A5 the server rebuilds a body against the record\'s schema: unknown keys dropped, first of a key wins, a sent fail is no answer, N/A only where allowed',
    clean.map((i) => `${i.item_key}:${i.rating}`), ['r_floor:pass', 'l_mats:null']);
  ok('A6 …the label is the schema\'s, never the body\'s', clean[0]?.label === 'Restrooms. Floor', JSON.stringify(clean[0]));
  ok('A7 …and a comment is capped at MAX_DRAFT_ITEM_COMMENT_LEN', clean[1]?.comment?.length === COMMENT_MAX, String(clean[1]?.comment?.length));
  const num = (() => { try { return fn('sanitizeDraftItems')(NUM_SNAP, [{ item_key: 'r_floor', rating: 4 }, { item_key: 'r_sink', rating: 9 }, { item_key: 'l_glass', rating: '2' }]); } catch { return []; } })();
  eq('A8 a 1–5 template keeps a rating inside its scale and drops one outside', num.map((i) => `${i.item_key}:${i.rating}`), ['r_floor:4', 'l_glass:2']);
  eq('A9 "N of M answered": a tick, an N/A or a rating answers; a comment alone does not', (() => { try { return fn('draftProgress')(SNAP, items); } catch { return null; } })(), { answered: 4, total: TOTAL_ITEMS });

  const may = (actor, inspector) => { try { return fn('mayWorkDraft')(actor, { inspector_user_id: inspector }); } catch { return 'missing'; } };
  eq('A10 WHO: the inspector who started it', may({ role: 'manager', userId: 'u_m' }, 'u_m'), true);
  eq('A11 …not another manager', may({ role: 'manager', userId: 'u_m2' }, 'u_m'), false);
  eq('A12 …the office: an owner', may({ role: 'owner', userId: 'u_o' }, 'u_m'), true);
  eq('A13 …and an admin', may({ role: 'admin', userId: 'u_a' }, 'u_m'), true);
  eq('A14 …never a cleaner, nor a login with no role or id (fail closed)', [may({ role: 'crew', userId: 'u_c' }, 'u_m'), may({}, 'u_m'), may({ role: 'manager' }, null)], [false, false, false]);

  const stale = (updated, status = 'draft') => { try { return fn('isStaleDraft')({ status, updated_at: updated }, NOW); } catch { return 'missing'; } };
  eq('A15 D9: a draft untouched past DRAFT_RETENTION_DAYS is stale', stale(ago(RETENTION_DAYS * DAY + 60000)), true);
  eq('A16 …one a minute inside it is not', stale(ago(RETENTION_DAYS * DAY - 60000)), false);
  eq('A17 …and a submitted inspection never is, however old', stale(ago(400 * DAY), 'submitted'), false);

  const pick = (args) => { try { return fn('pickDraftSource')(args); } catch { return 'missing'; } };
  const T0 = '2026-10-11T17:00:00.000Z';
  const T1 = '2026-10-11T17:05:00.000Z';
  eq('A18 on open, the DEVICE copy wins when it holds unsent work newer than the server\'s save', pick({ serverUpdatedAt: T0, device: { dirty: true, savedAt: T1, serverAt: null } }), 'device');
  eq('A19 …the server wins when the device copy is older', pick({ serverUpdatedAt: T1, device: { dirty: true, savedAt: T0, serverAt: null } }), 'server');
  eq('A20 …and when the device holds nothing unsent (the server has it all)', pick({ serverUpdatedAt: T0, device: { dirty: false, savedAt: T1, serverAt: T0 } }), 'server');
  eq('A21 …the device wins when the server has not moved since it last saw it, whatever the phone\'s clock says', pick({ serverUpdatedAt: T0, device: { dirty: true, savedAt: '2020-01-01T00:00:00.000Z', serverAt: T0 } }), 'device');
  eq('A22 …and with no device copy, the server', pick({ serverUpdatedAt: T0, device: null }), 'server');

  const mem = new Map();
  const store = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const copy = { savedAt: T1, serverAt: T0, dirty: true, answers: ANSWERS, internalNote: NOTE };
  ok('A23 the device copy is written keyed by the record id, and read back', () => { fn('writeDraftDevice')(DRAFT, copy, store); return JSON.stringify(fn('readDraftDevice')(DRAFT, store)) === JSON.stringify(copy) && mem.has(fn('draftDeviceKey')(DRAFT)); });
  ok('A24 …cleared, it reads as none', () => { fn('clearDraftDevice')(DRAFT, store); return fn('readDraftDevice')(DRAFT, store) === null; });
  const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('blocked'); } };
  ok('A25 …and a blocked or full storage never throws (try/catch), it just reads as none', () => {
    mem.set(fn('draftDeviceKey')('garbage'), '{not json');
    return fn('writeDraftDevice')(DRAFT, copy, broken) === false && fn('readDraftDevice')(DRAFT, broken) === null
      && fn('readDraftDevice')('garbage', store) === null && (fn('clearDraftDevice')(DRAFT, broken), true);
  });
  eq('A26 the open draft at a building is the newest saved one there', (() => { try { return fn('draftAtSite')([
    { id: 'x1', status: 'draft', site_id: 's1', updated_at: T0 }, { id: 'x2', status: 'draft', site_id: 's1', updated_at: T1 }, { id: 'x3', status: 'draft', site_id: 's2', updated_at: T1 },
  ], 's1')?.id; } catch { return 'missing'; } })(), 'x2');
}

// ── B. the server ────────────────────────────────────────────────────────────
const DRAFT_ITEMS = (() => { try { return fn('draftItemsFromAnswers')(SNAP, ANSWERS); } catch { return inspectionFillItems(SNAP, ANSWERS); } })();
{
  seed();
  const sent = [];
  notify.__setHubMailerForTests?.(async (m) => { sent.push(m); return { ok: true, id: `e${sent.length}` }; });
  process.env.APP_PUBLIC_URL = 'https://hub.example.test/';
  const beforeUpdated = recOf(DRAFT).updated_at;
  world.log = [];
  const r = await qcPost('inspections/save-draft', { id: DRAFT, items: DRAFT_ITEMS, internalNote: NOTE });
  ok('B1 save-draft answers 200', r.status === 200, show(r));
  eq('B2 …and stores the touched items, unticked as no rating', itemsOf(DRAFT).map((i) => `${i.item_key}:${i.rating}`), ['r_floor:pass', 'r_sink:pass', 'b_counter:pass', 'b_fridge:na', 'l_mats:null']);
  ok('B3 …and the office-only note', recOf(DRAFT).internal_note === NOTE, String(recOf(DRAFT).internal_note));
  ok('B4 …and stamps updated_at', Date.parse(recOf(DRAFT).updated_at) > Date.parse(beforeUpdated), `${beforeUpdated} → ${recOf(DRAFT).updated_at}`);
  // 🔴 CS-650: the save is ONE call of the database function that takes the record's row lock
  // first (draft-only, pinned to the org) — never a status-guarded UPDATE and a separate item
  // write a Submit could land between.
  const writes = world.log.filter((q) => ['inspection_records', 'inspection_items'].includes(q.table) && q.op !== 'select');
  const calls = world.log.filter((q) => q.table === 'rpc:inspection_write');
  ok('🔴 B5 …in ONE write: inspection_write, draft-only, pinned to the org — no statement of its own on the two tables',
    calls.length === 1 && writes.length === 0 && calls[0].args?.p_draft_only === true && calls[0].args?.p_org === ORG && calls[0].args?.p_id === DRAFT,
    JSON.stringify({ calls: calls.map((c) => c.args?.p_draft_only), writes: writes.map((w) => `${w.table}:${w.op}`) }));
  // D8 — nothing of Submit's.
  eq('🔴 B6 save-draft leaves the record a DRAFT, unscored', [recOf(DRAFT).status, recOf(DRAFT).overall_score, recOf(DRAFT).result], ['draft', null, null]);
  eq('🔴 B7 …opens no ticket', (world.tables.problem_reports || []).length, 0);
  eq('🔴 B8 …rings no bell (no failed-inspection bell, no redo notice)', notes().length, 0);
  eq('🔴 B9 …writes no activity row', (world.tables.activity_log || []).length, 0);
  eq('🔴 B10 …and emails no client', sent.length, 0);

  const g = await qcGet('inspections/draft', { id: DRAFT });
  ok('B11 Continue reads the draft with its saved items', g.status === 200 && (g.body?.items || []).length === 5 && !!g.body?.inspection?.template_snapshot, show(g));
  eq('B12 …which reopen as the answers that were saved', (() => { try { return fn('answersFromItems')(g.body.inspection.template_snapshot, g.body.items); } catch { return null; } })(), ANSWERS);
  eq('B13 …with the note', g.body?.inspection?.internal_note, NOTE);

  // Continue → Submit: the whole list, unticked = fail. 3 of 5 that apply = 60%, a FAIL.
  const submitItems = inspectionFillItems(SNAP, ANSWERS);
  const s = await qcPost('inspections/submit', { id: DRAFT, items: submitItems, internalNote: NOTE });
  ok('B14 a continued draft submits like a fresh one', s.status === 200 && s.body?.inspection?.status === 'submitted', show(s));
  eq('B15 …scored by the shared rule', s.body?.inspection?.overall_score, scoreInspection(submitItems, SNAP.rating_scale).overallScore);
  eq('🔴 B16 …and opens exactly ONE ticket (WO-19)', (world.tables.problem_reports || []).filter((p) => p.inspection_id === DRAFT).length, 1);
  ok('B17 …the office\'s failed-inspection bell rings (once)', notes().filter((n) => n.eventKey === 'inspectionFailed').length > 0);
  ok('B18 …the client is emailed (HUB-11), once', sent.length === 1 && sent[0].to === 'pat@coralbay.test', JSON.stringify(sent.map((m) => m.to)));
  ok('B19 …and the activity row is written', (world.tables.activity_log || []).some((a) => a.action === 'inspection.submitted' && a.entity_id === DRAFT));
  await qcPost('inspections/submit', { id: DRAFT, items: submitItems });
  eq('B20 a second Submit (a replay) still leaves ONE ticket and no second email', [(world.tables.problem_reports || []).length, sent.length], [1, 1]);

  // A submitted record is refused (409) and left exactly as submitted.
  const itemsAfterSubmit = JSON.stringify(itemsOf(DRAFT));
  const late = await qcPost('inspections/save-draft', { id: DRAFT, items: [{ item_key: 'r_floor', rating: 'pass' }] });
  ok('🔴 B21 a save that reaches a SUBMITTED inspection is refused 409 not-a-draft', late.status === 409 && late.body?.code === NOT_A_DRAFT, show(late));
  ok('🔴 B22 …and touches none of its items', JSON.stringify(itemsOf(DRAFT)) === itemsAfterSubmit);
  const lateGet = await qcGet('inspections/draft', { id: DRAFT });
  ok('B23 Continue on a submitted one is a 409 too', lateGet.status === 409 && lateGet.body?.code === NOT_A_DRAFT, show(lateGet));
  const lateDiscard = await qcPost('inspections/discard', { id: DRAFT });
  ok('🔴 B24 Discard on a submitted one is a 409, and it stays', lateDiscard.status === 409 && !!recOf(DRAFT) && itemsOf(DRAFT).length > 0, show(lateDiscard));
  notify.__setHubMailerForTests?.(null);
  delete process.env.APP_PUBLIC_URL;
}
{
  // The record is submitted AFTER save-draft read it and BEFORE its write runs (its status-guarded
  // UPDATE before CS-650, its one inspection_write call since). The write must refuse it, and no
  // item may be touched. (§G holds the whole interleavings both ways.)
  seed();
  world.tables.inspection_items.push({ id: 'ii_final', inspection_id: DRAFT, item_key: 'r_floor', label: 'Restrooms. Floor', rating: 'fail', comment: null, photo_count: 0 });
  world.beforeQuery = async (q) => {
    if ((q.table === 'inspection_records' && q.op === 'update' && q.eq.id === DRAFT)
      || (q.table === 'rpc:inspection_write' && q.args?.p_id === DRAFT)) {
      const r = recOf(DRAFT);
      if (r) { r.status = 'submitted'; r.overall_score = 0; r.result = 'fail'; }
    }
  };
  const r = await qcPost('inspections/save-draft', { id: DRAFT, items: DRAFT_ITEMS });
  world.beforeQuery = null;
  ok('🔴 B25 a Submit landing between save-draft\'s read and its write: the save is refused 409', r.status === 409 && r.body?.code === NOT_A_DRAFT, show(r));
  eq('🔴 B26 …and the submitted items stand untouched', itemsOf(DRAFT).map((i) => i.id), ['ii_final']);
}
{
  // WHO: the inspector or the office, from the login — never another manager, never a cleaner.
  seed();
  const other = await qcPost('inspections/save-draft', { id: DRAFT, items: DRAFT_ITEMS }, 'tok-mgr2');
  ok('🔴 B27 another manager cannot save into it (403 not-your-draft)', other.status === 403 && other.body?.code === NOT_YOURS, show(other));
  const otherGet = await qcGet('inspections/draft', { id: DRAFT }, 'tok-mgr2');
  ok('🔴 B28 …nor continue it', otherGet.status === 403 && otherGet.body?.code === NOT_YOURS, show(otherGet));
  const otherDiscard = await qcPost('inspections/discard', { id: DRAFT }, 'tok-mgr2');
  ok('🔴 B29 …nor discard it', otherDiscard.status === 403 && !!recOf(DRAFT), show(otherDiscard));
  const otherSubmit = await qcPost('inspections/submit', { id: DRAFT, items: inspectionFillItems(SNAP, {}) }, 'tok-mgr2');
  ok('🔴 B30 …nor submit it under their own answers', otherSubmit.status === 403 && recOf(DRAFT).status === 'draft', show(otherSubmit));
  eq('B31 …and nothing was written for any of the four', itemsOf(DRAFT).length, 0);
  const crew = await qcPost('inspections/save-draft', { id: DRAFT, items: DRAFT_ITEMS }, 'tok-crew');
  ok('🔴 B32 a cleaner is refused at the gate (qc.inspect)', crew.status === 403, show(crew));
  const own = await qcPost('inspections/save-draft', { id: DRAFT, items: DRAFT_ITEMS, internalNote: NOTE, inspectorUserId: 'u_m2' }, 'tok-owner');
  ok('B33 the office (an owner) can save into anyone\'s draft', own.status === 200, show(own));
  ok('B34 …and a body cannot change who started it', recOf(DRAFT).inspector_user_id === 'u_m');
  const admin = await qcGet('inspections/draft', { id: DRAFT }, 'tok-admin');
  ok('B35 an admin can continue it', admin.status === 200, show(admin));
  const bad = await qcPost('inspections/save-draft', { id: 'x),status.eq.submitted', items: [] });
  ok('B36 a malformed id is a 400, never handed to the database', bad.status === 400, show(bad));
  const notList = await qcPost('inspections/save-draft', { id: DRAFT, items: 'pass' });
  ok('B37 items that are not a list are a 400', notList.status === 400, show(notList));
  const missing = await qcPost('inspections/save-draft', { id: 'b0000000-0000-4000-8000-0000000000ff', items: [] });
  ok('B38 an inspection that does not exist is a 404', missing.status === 404, show(missing));
}
{
  // Discard: the draft, its items and its photos — rows and Storage objects.
  seed();
  await qcPost('inspections/save-draft', { id: DRAFT, items: DRAFT_ITEMS });
  const before = itemsOf(DRAFT).length;
  const r = await qcPost('inspections/discard', { id: DRAFT });
  ok('B39 Discard answers 200 with how many photos went', r.status === 200 && r.body?.photos === 2, show(r));
  ok('🔴 B40 …the draft is gone', !recOf(DRAFT));
  ok('🔴 B41 …with its items', before === 5 && itemsOf(DRAFT).length === 0, `${before} → ${itemsOf(DRAFT).length}`);
  ok('🔴 B42 …and its photos\' rows', mediaOf(DRAFT).length === 0);
  const removed = removedPaths();
  ok('🔴 B43 …and their Storage objects, the thumbnail too', [`${ORG}/s1/m_d1.jpg`, `${ORG}/s1/m_d1.thumb.jpg`, `${ORG}/s1/m_d2.jpg`].every((p) => removed.includes(p)), JSON.stringify(removed));
  ok('B44 …and nobody else\'s photos', mediaOf(SUB).length === 1 && mediaOf(OLD_DRAFT).length === 1 && !removed.some((p) => /m_sub|m_old/.test(p)));
  ok('🔴 B45 the delete carries the status predicate', world.log.some((q) => q.table === 'inspection_records' && q.op === 'delete' && q.eq.status === 'draft'));
  const again = await qcPost('inspections/discard', { id: DRAFT });
  ok('B46 discarding it again is a 404', again.status === 404, show(again));
}
{
  // D9 — retention on create: past 30 days a draft goes with its items and photos.
  seed();
  const r = await qcPost('inspections/create', { templateId: 'it_i', siteId: 's1', clientId: 'c1' });
  ok('B47 a new inspection is made', r.status === 200 && r.body?.inspection?.status === 'draft', show(r));
  ok('🔴 B48 …and a draft untouched past 30 days is deleted', !recOf(OLD_DRAFT));
  ok('🔴 B49 …with its items and its photos (rows and objects)', itemsOf(OLD_DRAFT).length === 0 && mediaOf(OLD_DRAFT).length === 0 && removedPaths().includes(`${ORG}/s1/m_old.jpg`));
  ok('B50 …one saved 29 days ago stays', !!recOf(KEEP_DRAFT));
  ok('B51 …a submitted one 60 days old stays (only drafts expire)', !!recOf(OLD_SUB));
  ok('B52 …the draft in use stays, with its photos', !!recOf(DRAFT) && mediaOf(DRAFT).length === 2);
}
{
  // …bounded per call, oldest first.
  const many = Array.from({ length: SWEEP_MAX + 5 }, (_, i) => rec(`b1000000-0000-4000-8000-${String(i).padStart(12, '0')}`, { performed: ago(50 * DAY), updated: ago((RETENTION_DAYS + 2) * DAY + i * 60000) }));
  seed({ extraRecords: many });
  await qcPost('inspections/create', { templateId: 'it_i', siteId: 's1', clientId: 'c1' });
  const stale = [...many, rec(OLD_DRAFT, { updated: ago((RETENTION_DAYS + 1) * DAY) })];
  const remaining = stale.filter((m) => recOf(m.id)).map((m) => m.id).sort();
  eq('🔴 B53 one create deletes at most DRAFT_RETENTION_SWEEP_MAX stale drafts', stale.length - remaining.length, SWEEP_MAX);
  const oldestFirst = stale.slice().sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at));
  eq('B54 …the oldest first (the newest stale ones wait for the next create)', remaining, oldestFirst.slice(SWEEP_MAX).map((m) => m.id).sort());
}
{
  // The caller's own drafts, and the list's progress.
  seed();
  await qcPost('inspections/save-draft', { id: DRAFT, items: DRAFT_ITEMS });
  const mine = await qcGet('inspections/drafts', { siteId: 's1' });
  ok('B55 "my drafts here": the caller\'s own open drafts at the building, newest saved first',
    mine.status === 200 && (mine.body?.drafts || []).map((d) => d.id).join() === [DRAFT, KEEP_DRAFT, OLD_DRAFT].join(), show(mine));
  ok('B56 …never another manager\'s', !(mine.body?.drafts || []).some((d) => d.id === M2_DRAFT));
  const theirs = await qcGet('inspections/drafts', { siteId: 's1' }, 'tok-mgr2');
  ok('B57 …and theirs are theirs', theirs.status === 200 && (theirs.body?.drafts || []).map((d) => d.id).join() === M2_DRAFT, show(theirs));
  const none = await qcGet('inspections/drafts', { siteId: 's2' });
  ok('B58 …none at a building where they have none', none.status === 200 && (none.body?.drafts || []).length === 0, show(none));
  const crew = await qcGet('inspections/drafts', {}, 'tok-crew');
  ok('B59 …and a cleaner is refused (qc.inspect)', crew.status === 403, show(crew));
  const list = await qcGet('inspections/list');
  const row = (list.body?.inspections || []).find((x) => x.id === DRAFT);
  ok('B60 the Inspections list carries a draft\'s "N of M answered"', row?.draft_answered === 4 && row?.draft_total === TOTAL_ITEMS, JSON.stringify(row));
  ok('B61 …and who started it (the screen offers Continue / Discard only to them or the office)', row?.inspector_user_id === 'u_m' && !!row?.updated_at, JSON.stringify(row));
  ok('B62 …a submitted row carries no progress', !('draft_answered' in ((list.body?.inspections || []).find((x) => x.id === SUB) || {})));
}

// ── C. every read that must exclude a draft does — with ticks SAVED on it ──
{
  seed();
  const saved = await qcPost('inspections/save-draft', { id: DRAFT, items: DRAFT_ITEMS, internalNote: NOTE });
  ok('C0 the draft has saved ticks (save-draft answered)', saved.status === 200 && itemsOf(DRAFT).length === 5, show(saved));
  const token = recOf(DRAFT).public_token;
  const p1 = await call(pub, 'GET', 'inspection', { token: null, query: { token } });
  ok('🔴 C1 the public link of a draft is a 404', p1.status === 404, show(p1));
  const p2 = await call(pub, 'GET', 'inspection-pdf', { token: null, query: { token } });
  ok('🔴 C2 …and so is its PDF', p2.status === 404, show(p2));
  const f = await qcGet('inspections/figures');
  ok('🔴 C3 the Quality figures score only submitted inspections', f.status === 200 && f.body?.figures?.count === 2 && f.body?.figures?.avgScore === 100 && f.body?.figures?.failCount === 0, show(f));
  const rep = await qcGet('reports/inspections-by-site', { fromIso: ago(90 * DAY), toIso: ago(-DAY) }, 'tok-owner');
  ok('🔴 C4 the Reports tally counts no draft', rep.status === 200 && rep.body?.recordCount === 2, show(rep));
  const latest = await qcGet('inspections/latest-by-client');
  const c1 = (latest.body?.inspections || []).find((x) => x.client_id === 'c1');
  ok('🔴 C5 the newest inspection per customer (the reminders, the manager Home\'s "due") is the newest SUBMITTED one', latest.status === 200 && c1?.performed_at === recOf(SUB).performed_at, show(latest));
  const sinceIso = ago(365 * DAY);
  const hubPage = await hubReads.pageInspections({ clientId: 'c1', sinceIso, offset: 0, limit: 50 });
  ok('🔴 C6 the customer hub\'s Inspections list holds no draft', hubPage.rows.length > 0 && !hubPage.rows.some((r) => r.id === DRAFT || r.id === KEEP_DRAFT), JSON.stringify(hubPage.rows.map((r) => r.id)));
  const tile = await hubReads.tileInspections({ clientId: 'c1', sinceIso });
  ok('🔴 C7 …nor its Home tile', tile.length > 0 && !tile.some((r) => r.id === DRAFT));
  ok('🔴 C8 …nor opens one by id', (await hubReads.getInspection({ clientId: 'c1', id: DRAFT, sinceIso })) === null);
  const events = await activity.serviceEventsForClient({ clientId: 'c1', fromIso: sinceIso, toIso: ago(-DAY) });
  ok('🔴 C9 …nor shows one in the customer\'s history', events.filter((e) => e.kind === 'inspection').length === 2, JSON.stringify(events.map((e) => e.kind)));
  const list = await qcGet('inspections/list', { clientId: 'c1' });
  const trend = inspectionTrend(list.body?.inspections || []);
  ok('🔴 C10 the manager Home\'s "last 92%" and trend read only submitted ones', trend.last?.id === SUB && trend.trend.length === 2, JSON.stringify(trend));
}

// ── F. CS-649: every inspection read and write is pinned to the organization ──
// Another organization's record, share token and template in the same database: every route
// answers as if they did not exist, and nothing of theirs is read, rewritten or copied.
// REGRESSION: submit, get, report, PDF, the two public reads and create read by id (or token)
// alone before the fix, so they answered — and Submit rewrote the other org's record.
const OTHER_ORG = '00000000-0000-0000-0000-0000000000ee';
const O_SUB = 'b0000000-0000-4000-8000-0000000000e1';   // another org's submitted inspection
const O_DRAFT = 'b0000000-0000-4000-8000-0000000000e2'; // …and its open draft
{
  seed({ extraRecords: [
    rec(O_SUB, { org: OTHER_ORG, status: 'submitted', performed: ago(DAY), score: 100, result: 'pass' }),
    rec(O_DRAFT, { org: OTHER_ORG }),
  ] });
  world.tables.inspection_items.push({ id: 'ii_o', inspection_id: O_SUB, item_key: 'r_floor', label: 'Restrooms. Floor', rating: 'pass', comment: 'ZZOTHERORGZZ', photo_count: 0 });
  world.tables.inspection_templates.push({ id: 'it_o', organization_id: OTHER_ORG, name: 'Another org QC', kind: 'inspection', is_published: true, published_version_id: 'v_o', rating_scale: SNAP.rating_scale });
  world.tables.inspection_template_versions.push({ id: 'v_o', template_id: 'it_o', version_number: 1, status: 'published', schema: SCHEMA });
  const theirs = () => JSON.stringify([recOf(O_SUB), recOf(O_DRAFT), itemsOf(O_SUB), itemsOf(O_DRAFT)]);
  const before = theirs();
  const token = recOf(O_SUB).public_token;
  const routes = [
    ['submit', () => qcPost('inspections/submit', { id: O_SUB, items: inspectionFillItems(SNAP, {}) }, 'tok-owner')],
    ['get', () => qcGet('inspections/get', { id: O_SUB }, 'tok-owner')],
    ['report', () => qcGet('inspections/report', { id: O_SUB }, 'tok-owner')],
    ['PDF', () => qcGet('inspections/pdf', { id: O_SUB }, 'tok-owner')],
    ['the public report', () => call(pub, 'GET', 'inspection', { token: null, query: { token } })],
    ['the public PDF', () => call(pub, 'GET', 'inspection-pdf', { token: null, query: { token } })],
    ['create from its template', () => qcPost('inspections/create', { templateId: 'it_o', siteId: 's1', clientId: 'c1' }, 'tok-owner')],
    ['save-draft', () => qcPost('inspections/save-draft', { id: O_DRAFT, items: DRAFT_ITEMS }, 'tok-owner')],
    ['Continue', () => qcGet('inspections/draft', { id: O_DRAFT }, 'tok-owner')],
    ['Discard', () => qcPost('inspections/discard', { id: O_DRAFT }, 'tok-owner')],
  ];
  let n = 0;
  for (const [label, run] of routes) {
    n += 1;
    const r = await run();
    ok(`🔴 F${n} ${label}: another organization's inspection is a 404`, r.status === 404, show(r));
    ok(`F${n}b …and the answer carries nothing of it`, !/ZZOTHERORGZZ|Another org QC/.test(JSON.stringify(r.body || '')));
  }
  ok('🔴 F11 nothing of theirs changed (records and items)', theirs() === before);
  ok('🔴 F12 and no inspection was made here from their template', !(world.tables.inspection_records || []).some((r) => r.template_id === 'it_o'));
  const own = await qcGet('inspections/get', { id: SUB }, 'tok-owner');
  ok('F13 our own inspection still opens (the pin narrows to the org, nothing more)', own.status === 200 && own.body?.inspection?.id === SUB, show(own));
  // A FAILED read is not "not found": the shared report answers its fixed 503 (CS-648's sentence),
  // never a 404 that tells a customer their report does not exist.
  world.failWhen = (q) => q.table === 'inspection_records';
  const down = await call(pub, 'GET', 'inspection', { token: null, query: { token: recOf(SUB).public_token } });
  const downPdf = await call(pub, 'GET', 'inspection-pdf', { token: null, query: { token: recOf(SUB).public_token } });
  world.failWhen = null;
  ok('F14 a failed read of a shared report (and its PDF) is the route\'s 503, never a false 404',
    down.status === 503 && downPdf.status === 503 && down.body?.code === 'report-unavailable', `${show(down)} | ${show(downPdf)}`);
}

// ── G. CS-650: save-draft and Submit serialize behind the record's row lock ──
// Each writes through ONE database function (public.inspection_write, migration
// 20261011110000) that locks the record, replaces its items and updates it in one transaction.
// The fake's twin of it runs atomically, as the lock makes the real one. `holdFirst` parks ONE
// request at its first write and runs a whole second request through the real handler in the gap.
// Before CS-650 each writer was two or three statements: the save's status-guarded UPDATE came
// before its item write, and Submit's item write came before its status update, so either could
// land inside the other.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function holdFirst(match) {
  let release;
  const gate = new Promise((r) => { release = r; });
  let heldAt;
  const held = new Promise((r) => { heldAt = r; });
  let armed = true;
  world.beforeQuery = async (q) => {
    if (armed && match(q)) { armed = false; heldAt(q); await gate; }
  };
  return { held: Promise.race([held, sleep(5000).then(() => null)]), release: () => release() };
}
// A save's first touch of the items (before CS-650: AFTER its status-guarded UPDATE; since: its
// one call). Submit's record write (before: AFTER its items were written; since: its one call).
const SAVE_WRITE = (q) => q.table === 'inspection_items' || (q.table === 'rpc:inspection_write' && q.args?.p_draft_only === true);
const SUBMIT_WRITE = (q) => (q.table === 'inspection_records' && q.op === 'update') || (q.table === 'rpc:inspection_write' && q.args?.p_draft_only === false);
const ALL_PASS = Object.fromEntries(SCHEMA.areas.flatMap((a) => a.items.map((i) => [i.id, { ticked: true }])));
const SUBMIT_ITEMS = inspectionFillItems(SNAP, ALL_PASS);
const keysOf = (items) => items.map((i) => `${i.item_key}:${i.rating}`).sort();
{
  // (1) A whole Submit lands while a save is between its writes.
  seed();
  const hold = holdFirst(SAVE_WRITE);
  const saving = qcPost('inspections/save-draft', { id: DRAFT, items: DRAFT_ITEMS, internalNote: 'ZZLATESAVEZZ' });
  ok('G1 the save is held at its write', !!(await hold.held));
  const s = await qcPost('inspections/submit', { id: DRAFT, items: SUBMIT_ITEMS });
  hold.release();
  const sv = await saving;
  world.beforeQuery = null;
  ok('G2 the Submit in the gap lands', s.status === 200 && recOf(DRAFT)?.status === 'submitted', show(s));
  ok('🔴 G3 the held save then finds it submitted and is refused 409', sv.status === 409 && sv.body?.code === NOT_A_DRAFT, show(sv));
  eq('🔴 G4 the submitted inspection holds exactly what Submit sent', keysOf(itemsOf(DRAFT)), keysOf(SUBMIT_ITEMS));
  ok('🔴 G5 …its score is the one those items give, and the late save\'s note never landed',
    recOf(DRAFT)?.overall_score === scoreInspection(SUBMIT_ITEMS, SNAP.rating_scale).overallScore && recOf(DRAFT)?.internal_note !== 'ZZLATESAVEZZ',
    JSON.stringify({ score: recOf(DRAFT)?.overall_score, note: recOf(DRAFT)?.internal_note }));
}
{
  // (2) A whole save lands while a Submit is between its writes.
  seed();
  const hold = holdFirst(SUBMIT_WRITE);
  const submitting = qcPost('inspections/submit', { id: DRAFT, items: SUBMIT_ITEMS });
  ok('G6 the Submit is held at its record write', !!(await hold.held));
  const sv = await qcPost('inspections/save-draft', { id: DRAFT, items: DRAFT_ITEMS });
  hold.release();
  const s = await submitting;
  world.beforeQuery = null;
  ok('G7 the save in the gap lands on what is still a draft', sv.status === 200, show(sv));
  ok('G8 the Submit lands', s.status === 200 && recOf(DRAFT)?.status === 'submitted', show(s));
  eq('🔴 G9 the submitted inspection holds what Submit sent, never the save\'s', keysOf(itemsOf(DRAFT)), keysOf(SUBMIT_ITEMS));
  eq('🔴 G10 …and the score it stores is those items\' score', recOf(DRAFT)?.overall_score, scoreInspection(SUBMIT_ITEMS, SNAP.rating_scale).overallScore);
}
{
  // (3) Two Submits: the second to take the lock sees what the first left, so `prev` — the
  // activity row and HUB-11's first-submit email — is right.
  seed();
  const sent = [];
  notify.__setHubMailerForTests?.(async (m) => { sent.push(m); return { ok: true, id: `e${sent.length}` }; });
  process.env.APP_PUBLIC_URL = 'https://hub.example.test/';
  const FAILING = inspectionFillItems(SNAP, ANSWERS);
  const hold = holdFirst(SUBMIT_WRITE);
  const first = qcPost('inspections/submit', { id: DRAFT, items: FAILING });
  ok('G11 the first Submit is held at its record write', !!(await hold.held));
  const second = await qcPost('inspections/submit', { id: DRAFT, items: FAILING }, 'tok-owner');
  hold.release();
  const f = await first;
  world.beforeQuery = null;
  ok('G12 both answer 200', f.status === 200 && second.status === 200, `${show(f)} | ${show(second)}`);
  eq('🔴 G13 ONE client email (HUB-11 is a first submit\'s)', sent.length, 1);
  eq('🔴 G14 one "submitted" and one "edited" activity row', (world.tables.activity_log || []).filter((a) => a.entity_id === DRAFT).map((a) => a.action).sort(), ['inspection.edited', 'inspection.submitted']);
  eq('G15 ONE ticket (WO-19)', (world.tables.problem_reports || []).filter((p) => p.inspection_id === DRAFT).length, 1);
  notify.__setHubMailerForTests?.(null);
  delete process.env.APP_PUBLIC_URL;
}
{
  // (4) Submit is ONE write too, and what both writers send is what the SQL allows.
  seed();
  world.log = [];
  await qcPost('inspections/save-draft', { id: DRAFT, items: DRAFT_ITEMS, internalNote: NOTE });
  await qcPost('inspections/submit', { id: DRAFT, items: inspectionFillItems(SNAP, ANSWERS), internalNote: NOTE });
  const calls = world.log.filter((q) => q.table === 'rpc:inspection_write');
  const writes = world.log.filter((q) => ['inspection_records', 'inspection_items'].includes(q.table) && q.op !== 'select');
  ok('🔴 G16 Submit writes through ONE call too: inspection_write, not draft-only, pinned to the org',
    calls.length === 2 && writes.length === 0 && calls[1].args?.p_draft_only === false && calls[1].args?.p_org === ORG && calls[1].args?.p_id === DRAFT,
    JSON.stringify({ calls: calls.map((c) => c.args?.p_draft_only), writes: writes.map((w) => `${w.table}:${w.op}`) }));
  const sql = (() => { try { return readFileSync(path.resolve(APP, '../supabase/migrations/20261011110000_inspection_write.sql'), 'utf8'); } catch { return ''; } })();
  const sqlKeys = [...sql.matchAll(/v_patch\s*\?\s*'([a-z_]+)'/g)].map((m) => m[1]).sort();
  eq('🔴 G17 the fake\'s twin allowlists exactly the keys the SQL does (the SQL is the truth)', [...(INSPECTION_WRITE_PATCH_KEYS || [])].sort(), sqlKeys);
  ok('G18 …and every key either writer sends is on that list',
    calls.length > 0 && calls.every((c) => Object.keys(c.args?.p_patch || {}).every((k) => sqlKeys.includes(k))),
    JSON.stringify(calls.map((c) => Object.keys(c.args?.p_patch || {}))));
  eq('G19 the save sends only the note; Submit the status, score, result, start and note',
    calls.map((c) => Object.keys(c.args?.p_patch || {}).sort()), [['internal_note'], ['internal_note', 'overall_score', 'performed_at', 'result', 'status']]);
}

// ── D. the demo stub does the same ───────────────────────────────────────────
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
  globalThis.window = { __ppGetState: () => ({ company: { timezone: 'America/New_York' }, users: USERS, clients: [{ id: 'c1', name: 'Coral Bay HOA', supervisorId: 'u_sup' }], sites: [{ id: 's1', clientId: 'c1', name: 'Clubhouse' }], jobs: [] }) };
  const { QC_INSPECTIONS_STUB_KEY, QC_PROBLEMS_STUB_KEY, QC_TEMPLATES_STUB_KEY } = await import('../src/data/stubKeys.js');
  const stubRec = (id, o = {}) => ({ ...rec(id, o), _items: [] });
  mem.set(QC_INSPECTIONS_STUB_KEY, JSON.stringify({ inspections: [
    stubRec(DRAFT), stubRec(OLD_DRAFT, { performed: ago(40 * DAY), updated: ago((RETENTION_DAYS + 1) * DAY) }),
    stubRec(SUB, { status: 'submitted', performed: ago(DAY), score: 100, result: 'pass' }),
  ] }));
  mem.set('cleanspace_account_media_stub_v1', JSON.stringify({ media: [
    { id: 'sm1', scope: 'inspection', ref_id: DRAFT, site_id: 's1' }, { id: 'sm2', scope: 'inspection', ref_id: OLD_DRAFT, site_id: 's1' }, { id: 'sm3', scope: 'inspection', ref_id: SUB, site_id: 's1' },
  ] }));
  mem.set(QC_TEMPLATES_STUB_KEY, JSON.stringify({ templates: [{ id: 'it_i', name: SNAP.name, kind: 'inspection', rating_scale: SNAP.rating_scale, is_published: true, published_version_id: 'v_i', versions: [{ id: 'v_i', version_number: 1, schema: SCHEMA, status: 'published' }] }] }));
  const qcApi = await tryImport('../src/lib/qcApi.js');
  ok('D0 under plain node qcApi runs its demo stub', typeof qcApi.isQcStub === 'function' && qcApi.isQcStub());
  const stubRows = () => JSON.parse(mem.get(QC_INSPECTIONS_STUB_KEY) || '{"inspections":[]}').inspections;
  const stubMedia = () => JSON.parse(mem.get('cleanspace_account_media_stub_v1') || '{"media":[]}').media;
  const run = async (name, ...args) => { try { return await qcApi[name](...args); } catch (e) { return { __error: e }; } };
  const s1 = await run('saveInspectionDraft', { id: DRAFT, items: DRAFT_ITEMS, internalNote: NOTE });
  ok('D1 the stub saves a draft', !!s1 && !s1.__error && !!s1.updated_at, JSON.stringify(s1?.__error?.message || s1));
  const g1 = await run('getInspectionDraft', DRAFT);
  eq('D2 …and Continue reopens the same answers', (() => { try { return fn('answersFromItems')(SNAP, g1.items); } catch { return null; } })(), ANSWERS);
  const lst = await run('listInspections', {});
  const lrow = (lst?.inspections || []).find((x) => x.id === DRAFT);
  ok('D3 …its list row carries "N of M answered" like the server\'s', lrow?.draft_answered === 4 && lrow?.draft_total === TOTAL_ITEMS, JSON.stringify(lrow));
  ok('🔴 D4 the stub\'s public link of a draft finds nothing', (await run('getPublicInspection', recOf(DRAFT)?.public_token || `tok_${DRAFT.slice(-2)}`)) === null);
  ok('🔴 D5 …its figures score only submitted ones', (await run('inspectionFigures', {}))?.count === 1);
  ok('🔴 D6 …its newest-per-customer read skips the draft', (await run('latestInspectionPerClient'))?.find((x) => x.client_id === 'c1')?.performed_at === stubRows().find((r) => r.id === SUB).performed_at);
  const mine = await run('listMyInspectionDrafts', { siteId: 's1', inspectorUserId: 'u_m' });
  ok('D7 …"my drafts here" lists the caller\'s open ones', Array.isArray(mine) && mine.map((d) => d.id).join() === [DRAFT, OLD_DRAFT].join(), JSON.stringify(mine));
  // Continue → Submit = one ticket, in the demo too.
  await run('submitInspection', { id: DRAFT, items: inspectionFillItems(SNAP, ANSWERS) });
  await run('submitInspection', { id: DRAFT, items: inspectionFillItems(SNAP, ANSWERS) });
  const tickets = JSON.parse(mem.get(QC_PROBLEMS_STUB_KEY) || '{"problems":[]}').problems.filter((p) => p.inspection_id === DRAFT);
  eq('🔴 D8 the stub\'s continued-then-submitted draft opens exactly ONE ticket', tickets.length, 1);
  const late = await run('saveInspectionDraft', { id: DRAFT, items: [] });
  ok('🔴 D9 …and a save after Submit is refused with the server\'s 409 code', late?.__error?.status === 409 && late.__error.code === NOT_A_DRAFT, String(late?.__error?.message));
  const disc = await run('discardInspectionDraft', DRAFT);
  ok('D10 …as is a discard', disc?.__error?.status === 409);
  // Retention on create, and Discard.
  const made = await run('createInspection', { templateId: 'it_i', siteId: 's1', clientId: 'c1', inspectorUserId: 'u_m' });
  ok('🔴 D11 the stub\'s create clears a draft past 30 days, with its photos', !!made?.id && !stubRows().some((r) => r.id === OLD_DRAFT) && !stubMedia().some((m) => m.ref_id === OLD_DRAFT), JSON.stringify(stubRows().map((r) => r.id)));
  mem.set('cleanspace_account_media_stub_v1', JSON.stringify({ media: [...stubMedia(), { id: 'sm9', scope: 'inspection', ref_id: made?.id, site_id: 's1' }] }));
  const d2 = await run('discardInspectionDraft', made?.id);
  ok('🔴 D12 the stub\'s Discard removes the draft and its photos', d2?.ok === true && d2.photos === 1 && !stubRows().some((r) => r.id === made?.id) && !stubMedia().some((m) => m.ref_id === made?.id), JSON.stringify(d2));
  ok('D13 …and nobody else\'s', stubMedia().some((m) => m.ref_id === SUB));
}

// ── E. the form and the list, read mechanically ──────────────────────────────
{
  const read = (p) => { try { return readFileSync(path.join(APP, p), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
  const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const FILL = code('src/components/InspectionFill.jsx');
  ok('E1 the form saves every change to the draft, debounced by the shared constant', /qcApi\.saveInspectionDraft\(/.test(FILL) && /DRAFT_SAVE_DEBOUNCE_MS/.test(FILL));
  ok('E2 …stores what the shared builder builds (unticked = not yet answered)', /draftItemsFromAnswers\(/.test(FILL));
  ok('E3 …keeps a device copy and lets the newer win on open', /writeDraftDevice\(/.test(FILL) && /readDraftDevice\(/.test(FILL) && /pickDraftSource\(/.test(FILL));
  ok('E4 …says Saved · time / Saving… / Not saved, will retry, from the catalog', /inspectionFill\.draft\.saved/.test(FILL) && /inspectionFill\.draft\.saving/.test(FILL) && /inspectionFill\.draft\.retry/.test(FILL));
  ok('E5 …offers "Save and finish later" beside Submit', /inspectionFill\.draft\.saveLater/.test(FILL));
  ok('E6 …and "Continue the one you started" where this person has one open', /listMyInspectionDrafts\(/.test(FILL) && /inspectionFill\.resume\./.test(FILL));
  ok('E7 …and clears the device copy once submitted', /clearDraftDevice\(/.test(FILL));
  const LIST = code('src/pages/Inspections.jsx');
  ok('E8 the Inspections list marks a draft In progress (a slate Badge) with its progress and start', /variant="slate"/.test(LIST) && /inspectionFill\.draft\.inProgress/.test(LIST) && /draft_answered/.test(LIST) && /inspectionFill\.draft\.started/.test(LIST));
  ok('E9 …with Continue and Discard (confirmed) for whoever may work it', /mayWorkDraft\(/.test(LIST) && /qcApi\.discardInspectionDraft\(/.test(LIST) && /<ConfirmDialog[\s\S]*?inspectionFill\.draft\.discardTitle/.test(LIST));
}

if (fails.length) { console.error('\ninspection-drafts FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\ninspection-drafts: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
