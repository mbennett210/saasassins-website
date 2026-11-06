// HUB-16 — an INTERNAL note on an inspection: the office sees it, the client never does.
//
// Matt, 2026-10-02: "Should inspectors be able to add a note only your team sees? — Yes,
// add an internal note for your team only." The client sees the FULL report including the
// per-item comments (HUB-6), so this had to be stored apart from those comments and kept
// out of every client-facing surface.
//
// 🔴 THE WHOLE BOUNDARY IS ONE FUNCTION. `projectReport` (api/_lib/qc/store.js) is what
// the public token page, the in-app report document and the server PDF are ALL built
// from. `internal_note` is not in it — so the note cannot reach any of them, and the test
// for that is not "we remembered to strip it in three places", it is "the one projection
// everything is built from never carried it". §3 enumerates that mechanically, over the
// source, so a future edit that adds it to the projection fails here rather than on a
// client's screen.
//
// REGRESSION (THE LAW II.3): on the pre-fix tree the column, the route's gate and the
// modal's block do not exist, so §1, §2 and §4 go red.
//
//   node app/scripts/test-inspection-internal-note.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000016';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { buildInspectionReportHtml } = await import('../src/lib/inspectionReportTemplate.js');
const store = await import('../api/_lib/qc/store.js');
const qc = (await import('../api/qc/[...path].js')).default;
const pub = (await import('../api/public/qc/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// A sentence nobody would write twice by accident, so finding it anywhere is proof.
const SECRET = 'ZZINTERNALZZ crew was two hours late and the supervisor covered for them';
const CLIENT_SAFE = 'Mirrors left streaky';

const SCHEMA = {
  areas: [{ id: 'a_rest', label: 'Restrooms', items: [{ id: 'r_mirror', label: 'Mirrors' }, { id: 'r_floor', label: 'Floor' }] }],
};
const SNAP = { name: 'Nightly Janitorial QC', kind: 'inspection', rating_scale: { type: 'passfail', passThreshold: 80 }, schema: SCHEMA };
const ITEMS = [
  { item_key: 'r_mirror', label: 'Restrooms. Mirrors', rating: 'fail', comment: CLIENT_SAFE },
  { item_key: 'r_floor', label: 'Restrooms. Floor', rating: 'pass', comment: null },
];

const user = (id, role) => ({ id, role, status: 'active', name: id, email: `${id}@example.test` });
const logins = {
  'tok-mgr': { id: 'auth-m', email: 'm@example.test', app_metadata: { role: 'manager', org_user_id: 'u_m', org_id: ORG } },
  'tok-crew': { id: 'auth-c', email: 'c@example.test', app_metadata: { role: 'crew', org_user_id: 'u_c1', org_id: ORG } },
};

function seed({ note = null, status = 'draft' } = {}) {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 57,
        state: {
          version: 57,
          company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
          users: [user('u_m', 'manager'), user('u_c1', 'crew')],
          clients: [{ id: 'c1', name: 'Coral Bay HOA', supervisorId: 'u_m' }],
          sites: [{ id: 's1', clientId: 'c1', name: 'Clubhouse' }],
          permissions: seedPermissions(),
          userPermissionOverrides: [],
          notifications: [],
        },
      }],
      crew_assignments: [
        { organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' },
        { organization_id: ORG, user_id: 'u_c1', site_id: null, client_id: 'c1', source: 'standing_client' },
      ],
      inspection_templates: [{ id: 'it_i', organization_id: ORG, name: 'Nightly Janitorial QC', kind: 'inspection', is_published: true, published_version_id: 'v_i' }],
      inspection_template_versions: [{ id: 'v_i', template_id: 'it_i', version_number: 1, status: 'published', schema: SCHEMA }],
      inspection_records: [{
        id: 'ir_1', organization_id: ORG, public_token: 'tok_public_1', template_id: 'it_i', template_version_id: 'v_i',
        template_snapshot: SNAP, client_id: 'c1', site_id: 's1', job_id: null,
        inspector_user_id: 'u_m', client_name: 'Coral Bay HOA', site_name: 'Clubhouse', inspector_name: 'Maria',
        status, overall_score: 50, result: 'fail', internal_note: note,
        performed_at: '2026-10-02T22:00:00.000Z',
      }],
      inspection_items: status === 'draft' ? [] : ITEMS.map((it, i) => ({ id: `ii_${i}`, inspection_id: 'ir_1', ...it, photo_count: 0 })),
      account_media: [],
      problem_reports: [],
      activity_log: [],
      time_entries: [],
    },
    logins,
  });
}

async function call(handler, { method = 'GET', path: p, token, body }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  const [sub, qs] = p.split('?');
  req.query = { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) };
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
const rec = () => world.tables.inspection_records[0];

// ── 1. it is written at submit, and only when the caller says something ─────
{
  seed();
  const r = await call(qc, { method: 'POST', path: 'inspections/submit', token: 'tok-mgr', body: { id: 'ir_1', items: ITEMS, internalNote: `  ${SECRET}  ` } });
  eq('an inspection submits with an internal note', r.status, 200);
  eq('…and the note is stored, trimmed', rec().internal_note, SECRET);
  // A re-submit that says nothing about the note leaves it alone: an edit screen that
  // forgot to resend it must not silently delete the office's own record.
  await call(qc, { method: 'POST', path: 'inspections/submit', token: 'tok-mgr', body: { id: 'ir_1', items: ITEMS } });
  eq('a re-submit that says nothing keeps it', rec().internal_note, SECRET);
  // An empty one CLEARS it — that is how the office deletes a note.
  await call(qc, { method: 'POST', path: 'inspections/submit', token: 'tok-mgr', body: { id: 'ir_1', items: ITEMS, internalNote: '   ' } });
  eq('an empty note clears it', rec().internal_note, null);
}
{
  // The cap is asserted against the MODULE'S own constant, never a restated number
  // (THE LAW II.3). On the pre-fix tree there is no constant and no column, so both of
  // these go red rather than throwing.
  ok('the store declares the note\'s length cap', Number.isFinite(store.MAX_INTERNAL_NOTE_LEN));
  ok('…and the rule that normalizes one', typeof store.normalizeInternalNote === 'function');
  seed();
  const cap = Number.isFinite(store.MAX_INTERNAL_NOTE_LEN) ? store.MAX_INTERNAL_NOTE_LEN : 4000;
  const long = 'x'.repeat(cap + 500);
  await call(qc, { method: 'POST', path: 'inspections/submit', token: 'tok-mgr', body: { id: 'ir_1', items: ITEMS, internalNote: long } });
  eq('an over-long note is capped at the module\'s own limit', rec().internal_note?.length ?? null, cap);
  eq('a non-string note is stored as nothing', store.normalizeInternalNote?.(42) ?? null, null);
}

// ── 2. WHO reads it back ────────────────────────────────────────────────────
{
  seed({ note: SECRET, status: 'submitted' });
  const r = await call(qc, { path: 'inspections/report?id=ir_1', token: 'tok-mgr' });
  eq('the office report read answers', r.status, 200);
  eq('…and carries the note BESIDE the document', r.body?.internalNote, SECRET);
  ok('…never inside the document the client is shown',
    !JSON.stringify(r.body.inspection).includes(SECRET) && !JSON.stringify(r.body.items).includes(SECRET));
  // And the document built from that payload — the exact HTML the modal renders — is clean.
  ok('…so the rendered report HTML does not contain it', !buildInspectionReportHtml(r.body).includes(SECRET));
  ok('…while the client-safe item comment IS in it', buildInspectionReportHtml(r.body).includes(CLIENT_SAFE));
}
{
  seed({ note: SECRET, status: 'submitted' });
  const r = await call(qc, { path: 'inspections/report?id=ir_1', token: 'tok-crew' });
  eq('a crew reader still gets the report', r.status, 200);
  ok('…with no internal note anywhere in it', !JSON.stringify(r.body).includes(SECRET), JSON.stringify(r.body).slice(0, 300));
  const g = await call(qc, { path: 'inspections/get?id=ir_1', token: 'tok-crew' });
  eq('…and the raw record read answers them too', g.status, 200);
  ok('…stripped of the note', !JSON.stringify(g.body).includes(SECRET));
  const gm = await call(qc, { path: 'inspections/get?id=ir_1', token: 'tok-mgr' });
  eq('…while an inspector reads it on the raw record', gm.body?.inspection?.internal_note, SECRET);
}

// ── 3. THE CLIENT-FACING SURFACES, by construction ──────────────────────────
{
  seed({ note: SECRET, status: 'submitted' });
  const r = await call(pub, { path: 'inspection?token=tok_public_1' });
  eq('the public token report answers', r.status, 200);
  ok('…and the whole response is free of the note', !JSON.stringify(r.body).includes(SECRET), JSON.stringify(r.body).slice(0, 300));
  ok('…while carrying the client-safe comment', JSON.stringify(r.body).includes(CLIENT_SAFE));
  // The public page renders the same document from the same payload.
  ok('…and the public page\'s HTML is free of it', !buildInspectionReportHtml(r.body).includes(SECRET));
}
{
  // The projection ITSELF — what the PDF renderer builds from too (reportPdf.js calls
  // projectReport with the raw row and its photos, so the row's own column is in scope
  // and must still not appear).
  const row = { ...rec(), internal_note: SECRET };
  const projected = store.projectReport(row, ITEMS, []);
  ok('projectReport never carries the note', !JSON.stringify(projected).includes(SECRET), JSON.stringify(projected).slice(0, 300));
  ok('…and the PDF document built from it does not either', !buildInspectionReportHtml(projected, { forPdf: true }).includes(SECRET));
}

// ── 4. enumerated over the source: nothing client-facing may learn it ───────
{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const APP = path.resolve(HERE, '..');
  const REPO = path.resolve(APP, '..');
  const rel = (p) => path.relative(REPO, p).split(path.sep).join('/');
  const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
  const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // The ONE function every client-facing surface is built from.
  const STORE = read(path.join(APP, 'api/_lib/qc/store.js'));
  const projectSrc = /export function projectReport\([\s\S]*?\n}/.exec(STORE)?.[0] || '';
  ok('projectReport was found in the store', projectSrc.length > 100);
  ok('…and its body never names the internal note',
    !/internal_?[Nn]ote/.test(projectSrc.replace(/^\s*\/\/.*$/gm, '')), projectSrc.slice(0, 200));

  // The three documents + the public route, by file.
  const CLIENT_FACING = [
    'src/lib/inspectionReportTemplate.js',   // the document itself (in-app, public, PDF)
    'api/public/qc/[...path].js',            // the token route
    'api/_lib/qc/reportPdf.js',              // the PDF renderer
    'src/pages/PublicInspection.jsx',        // the public page
  ];
  const leaks = CLIENT_FACING.filter((f) => /internal_?[Nn]ote/.test(code(path.join(APP, f))));
  ok(`no client-facing surface names the internal note (leaks: ${leaks.join(', ') || 'none'})`, leaks.length === 0);

  // The authed route gates it on the permission inspections are WRITTEN with, with the
  // same fail-closed helper the share-token gate uses.
  const ROUTE = code(path.join(APP, 'api/qc/[...path].js'));
  ok('the authed route strips the note for a caller without qc.inspect',
    /holdsPermission\(g, 'qc\.inspect'\)/.test(ROUTE) && /stripInternalNote/.test(ROUTE));

  // The office surfaces that DO show it.
  ok('the inspection fill offers the note', /internalNote/.test(code(path.join(APP, 'src/components/InspectionFill.jsx'))));
  ok('…and the report viewer shows it OUTSIDE the document',
    /report\.internalNote/.test(code(path.join(APP, 'src/components/InspectionReportModal.jsx'))));

  // And the demo stub behaves the same way, so the demo cannot show a client something
  // production keeps internal.
  const API = code(path.join(APP, 'src/lib/qcApi.js'));
  ok('the demo stub stores the note on the record', /rec\.internal_note/.test(API));
  const publicStub = /async function stubPublicInspection\([\s\S]*?\n}/.exec(API)?.[0] || '';
  ok('…and its PUBLIC projection never returns it', publicStub.length > 20 && !/internal_?[Nn]ote/.test(publicStub));

  ok('the suite enumerated real files', CLIENT_FACING.every((f) => read(path.join(APP, f)).length > 0),
    CLIENT_FACING.map((f) => rel(path.join(APP, f))).join(', '));
}

// ── 5. THE CLIENT HUB (Round 2): every route a customer login reaches ───────
// The hub serves inspections to the CUSTOMER directly, so it is the most client-facing surface
// of all. Every hub route is driven with a client login against a record that carries the note,
// and the whole response must be free of it — and the hub's own source must never name it in
// code, so a later "just add internalNote here" fails this suite before it reaches a client.
{
  const CU = 'a0000000-0000-4000-8000-0000000000c1';
  const IR = 'c0000000-0000-4000-8000-0000000000c1';
  seed({ note: SECRET, status: 'submitted' });
  // The same inspection, with a uuid id (the hub validates ids the way the real columns type
  // them), and the customer login that may see building c1.
  world.tables.inspection_records.push({ ...rec(), id: IR, public_token: 'tok_public_hub', performed_at: new Date(Date.now() - 3600000).toISOString() });
  world.tables.inspection_items.push(...ITEMS.map((it, i) => ({ id: `iih_${i}`, inspection_id: IR, ...it, photo_count: 0 })));
  Object.assign(world.tables, {
    client_users: [{ id: CU, organization_id: ORG, name: 'Pat Manager', email: 'pat@example.test', status: 'active', auth_user_id: 'auth-cu' }],
    client_user_groups: [], client_user_group_members: [],
    client_user_assignments: [{ id: 'as-c', organization_id: ORG, client_user_id: CU, client_id: 'c1', group_id: null }],
    checklist_results: [], work_order_messages: [], inbox_accounts: [],
  });
  world.logins.set('tok-client', { id: 'auth-cu', email: 'pat@example.test', app_metadata: { role: 'client', client_user_id: CU, org_id: ORG } });
  let hubRoute = null;
  try { hubRoute = (await import('../api/hub/[...path].js')).default; } catch { hubRoute = null; }
  // Home's Inspections tile and Today's Visit (the redesign, 2026-10-08) read inspection rows too.
  const paths = ['view', 'home?buildingId=c1', 'visit?buildingId=c1', 'inspections?buildingId=c1', `inspection?buildingId=c1&id=${IR}`, 'history?buildingId=c1', 'tickets?buildingId=c1', 'checklists?buildingId=c1'];
  for (const p of paths) {
    const r = hubRoute ? await call(hubRoute, { path: p, token: 'tok-client' }) : { status: 0, body: null };
    eq(`the hub answers a client login: ${p.split('?')[0]}`, r.status, 200);
    ok(`…and ${p.split('?')[0]} never carries the internal note`, r.status === 200 && !JSON.stringify(r.body ?? '').includes(SECRET), JSON.stringify(r.body ?? '').slice(0, 200));
  }
  const report = hubRoute ? await call(hubRoute, { path: `inspection?buildingId=c1&id=${IR}`, token: 'tok-client' }) : { body: null };
  ok('the hub\'s report carries the client-safe item comment (HUB-6) — the check above is not vacuous', JSON.stringify(report.body ?? '').includes(CLIENT_SAFE));
  ok('…and the document the hub renders from it is clean',
    !!report.body?.inspection?.report && !buildInspectionReportHtml(report.body.inspection.report).includes(SECRET));

  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const APP = path.resolve(HERE, '..');
  const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
  const code = (p) => read(p).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const HUB = [
    'api/hub/[...path].js',            // every route a customer login reaches
    'api/_lib/clientHub/reads.js',     // its reads
    'src/lib/clientHubView.js',        // its projections
    'src/lib/hubDemo.js',              // the demo's twin of them
    'src/lib/hubHome.js',              // Home's tiles (the redesign)
    'src/lib/hubVisit.js',             // the crew status and Today's Visit (the redesign)
    'src/pages/hub/HubInspection.jsx', // the screen that renders the report
  ];
  const missing = HUB.filter((f) => !read(path.join(APP, f)));
  ok(`the hub's files exist (${missing.join(', ') || 'all'})`, missing.length === 0);
  const leaks = HUB.filter((f) => /internal_?[Nn]ote/.test(code(path.join(APP, f))));
  ok(`no hub file names the internal note in code (leaks: ${leaks.join(', ') || 'none'})`, missing.length === 0 && leaks.length === 0);
}

if (fails.length) { console.error('\ninspection-internal-note FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\ninspection-internal-note: ${pass} passed, ${fails.length} failed`);
process.exitCode = fails.length ? 1 : 0;
