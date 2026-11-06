// SAVING A DRAFT OF A PUBLISHED TEMPLATE CHANGES NOTHING LIVE (CS-669; S128 F5-01).
//
// "Save draft" on the PUBLISHED "Nightly Janitorial QC" wrote the new pass mark (80 → 100) and
// the name straight onto the template ROW, while only the items waited in the draft version. A
// new inspection snapshots the row's scale with the PUBLISHED items, so the draft's pass mark
// scored live inspections at once: 92% filed as Fail, which opens a ticket, rings the office,
// sends the redo notice and emails the customer. The Templates list still said "Published" and
// offered no Publish button (it showed one only for a never-published template).
//
// Held here (lib/inspections is the one rule; the REAL api/qc handler over the loopback fake —
// never production — and the demo stub):
//   A. Save draft on a published template keeps the row's name and pass mark; the draft version
//      carries them; a NEW inspection is scored by the published 80 (4 of 5 = 80% passes);
//   B. the list marks it "unpublished changes" and Publish moves the name and pass mark onto the
//      row (the frozen version carries no pending keys); the next inspection uses 100;
//   C. a template never published still takes its name and scale at once (nothing is live);
//   D. the editor re-opens a draft with its OWN name and pass mark;
//   E. the demo stub does the same; the screens read the rule.
//
// REGRESSION (THE LAW II.3): on the tree before the fix (`e9d5974f`) Save draft rewrites the row
// (A fails: the new inspection snapshots 100 and 80% is a Fail), the list has no draft flag and
// the stub mirrors the bug.
//
//   node app/scripts/test-template-draft.mjs
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
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
installResolveShim();

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };
const INS = await import('../src/lib/inspections.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const qc = (await import('../api/qc/[...path].js')).default;

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). This suite is label-first.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const PENDING = INS.PENDING_TEMPLATE_KEY || 'pendingTemplate';

// ── the fixture: a PUBLISHED inspection template, pass at 80, five items ────────
const SCHEMA = { areas: [{ id: 'a1', label: 'Restrooms', items: ['Floor', 'Sink', 'Mirror', 'Toilet', 'Bin'].map((l, i) => ({ id: `i${i}`, label: l })) }] };
const T = 'e0000000-0000-4000-8000-000000000001';      // published
const T2 = 'e0000000-0000-4000-8000-000000000002';     // never published
const V1 = 'f0000000-0000-4000-8000-000000000001';
const V2 = 'f0000000-0000-4000-8000-000000000002';
const USERS = [{ id: 'u_o', role: 'owner', status: 'active', name: 'Owner', email: 'owner@example.test' }];
const LOGINS = { 'tok-owner': { id: 'auth-u_o', email: 'owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_o', org_id: ORG } } };
resetWorld({
  tables: {
    org_state: [{
      organization_id: ORG, version: 3,
      state: {
        version: 58, company: { id: 'co', name: 'Co', timezone: 'America/New_York' }, users: USERS,
        clients: [{ id: 'c1', name: 'Lakeside' }], sites: [{ id: 's1', clientId: 'c1', name: 'Lakeside' }],
        permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
      },
    }],
    crew_assignments: [{ organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' }],
    inspection_templates: [
      { id: T, organization_id: ORG, slug: 's1', name: 'Nightly Janitorial QC', kind: 'inspection', client_id: null, rating_scale: { type: 'passfail', passThreshold: 80 }, is_published: true, published_version_id: V1, item_count: 5, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' },
      { id: T2, organization_id: ORG, slug: 's2', name: 'Untitled inspection', kind: 'inspection', client_id: null, rating_scale: { type: 'passfail', passThreshold: 80 }, is_published: false, published_version_id: null, item_count: null, created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z' },
    ],
    inspection_template_versions: [
      { id: V1, template_id: T, version_number: 1, schema: SCHEMA, status: 'published', published_at: '2026-10-01T10:00:00Z' },
      { id: V2, template_id: T2, version_number: 1, schema: { areas: [] }, status: 'draft', published_at: null },
    ],
    inspection_records: [], inspection_items: [], account_media: [], problem_reports: [], work_order_messages: [], activity_log: [],
    jobs: [], client_users: [], client_user_groups: [], client_user_group_members: [], client_user_assignments: [],
  },
  logins: LOGINS,
});
async function call(method, subpath, { body = null, query = {} } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { authorization: 'Bearer tok-owner' };
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
      Promise.resolve(qc(req, res)).catch((e) => done('threw', String(e?.message || e)));
    });
  } finally { Object.assign(console, quiet); }
}
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 260)}`;
const row = (id) => world.tables.inspection_templates.find((t) => t.id === id);
const versionsOf = (id) => world.tables.inspection_template_versions.filter((v) => v.template_id === id).sort((a, b) => a.version_number - b.version_number);
// 4 of the 5 items pass = 80%: a Pass at 80, a Fail at 100.
const ITEMS = SCHEMA.areas[0].items.map((it, i) => ({ item_key: it.id, label: `Restrooms. ${it.label}`, rating: i < 4 ? 'pass' : 'fail', comment: null, photo_count: 0 }));
async function inspect() {
  const c = await call('POST', 'inspections/create', { body: { templateId: T, clientId: 'c1', siteId: 's1' } });
  const id = c.body?.inspection?.id;
  const s = await call('POST', 'inspections/submit', { body: { id, items: ITEMS } });
  return { created: c, submitted: s, snapshot: c.body?.inspection?.template_snapshot || null, result: s.body?.inspection?.result ?? null };
}

// ── A. Save draft on the published template ────────────────────────────────────
const save = await call('POST', 'templates/save', { body: { id: T, name: 'Nightly QC (strict)', ratingScale: { type: 'passfail', passThreshold: 100 }, schema: SCHEMA } });
ok('A1 Save draft answers', save.status === 200, show(save));
ok('A2 🔴 the template ROW keeps its published pass mark (80)', row(T).rating_scale?.passThreshold === 80, JSON.stringify(row(T).rating_scale));
ok('A3 🔴 …and its published name', row(T).name === 'Nightly Janitorial QC', row(T).name);
const draftV = versionsOf(T).at(-1);
ok('A4 the draft version holds the new pass mark and name until Publish', draftV?.status === 'draft' && draftV?.schema?.[PENDING]?.ratingScale?.passThreshold === 100 && draftV?.schema?.[PENDING]?.name === 'Nightly QC (strict)', JSON.stringify(draftV));
const a5 = await inspect();
ok('A5 🔴 a NEW inspection snapshots the PUBLISHED pass mark (80)', a5.snapshot?.rating_scale?.passThreshold === 80, JSON.stringify(a5.snapshot?.rating_scale));
ok('A6 🔴 …so 4 of 5 (80%) is a PASS, not a Fail', a5.result === 'pass', show(a5.submitted));
ok('A7 …and nothing failed opened a ticket', (world.tables.problem_reports || []).length === 0);

// ── B. the list, then Publish ───────────────────────────────────────────────────
const list = await call('GET', 'templates/list');
const lrow = (list.body?.templates || []).find((t) => t.id === T);
ok('B1 🔴 the list says it is published WITH unpublished changes', lrow?.is_published === true && lrow?.has_draft === true, JSON.stringify(lrow));
ok('B2 a template with no pending draft says so too', (list.body?.templates || []).find((t) => t.id === T2)?.has_draft === false);
const pub = await call('POST', 'templates/publish', { body: { id: T } });
ok('B3 Publish answers', pub.status === 200, show(pub));
ok('B4 🔴 Publish moves the new pass mark onto the row', row(T).rating_scale?.passThreshold === 100, JSON.stringify(row(T).rating_scale));
ok('B5 …and the new name', row(T).name === 'Nightly QC (strict)');
const frozen = versionsOf(T).at(-1);
ok('B6 the published version carries no pending keys (what inspections snapshot)', frozen?.status === 'published' && !(PENDING in (frozen?.schema || {})), JSON.stringify(frozen?.schema));
const b7 = await inspect();
ok('B7 the next inspection uses the published 100 — 80% is now a Fail', b7.snapshot?.rating_scale?.passThreshold === 100 && b7.result === 'fail', show(b7.submitted));
const list2 = await call('GET', 'templates/list');
ok('B8 after Publish the list has nothing pending', (list2.body?.templates || []).find((t) => t.id === T)?.has_draft === false);

// ── C. a template never published takes its edits at once ───────────────────────
await call('POST', 'templates/save', { body: { id: T2, name: 'Monthly walk', ratingScale: { type: 'passfail', passThreshold: 90 }, schema: SCHEMA } });
ok('C1 a never-published template\'s row takes its name and pass mark at once (nothing is live)', row(T2).name === 'Monthly walk' && row(T2).rating_scale?.passThreshold === 90, JSON.stringify(row(T2)));

// ── D. the editor's read ─────────────────────────────────────────────────────────
await call('POST', 'templates/save', { body: { id: T, name: 'Nightly QC v3', ratingScale: { type: 'passfail', passThreshold: 95 }, schema: SCHEMA } });
const got = await call('GET', 'templates/get', { query: { id: T } });
const eff = typeof INS.effectiveTemplateMeta === 'function' ? INS.effectiveTemplateMeta(got.body?.template, got.body?.latest) : null;
ok('D1 the editor re-opens a draft with ITS name and pass mark (not the live ones)', eff?.name === 'Nightly QC v3' && eff?.ratingScale?.passThreshold === 95 && eff?.hasUnpublishedChanges === true, JSON.stringify(eff));
ok('D2 …while the row still serves the live ones', row(T).name === 'Nightly QC (strict)' && row(T).rating_scale?.passThreshold === 100);

// ── E. the demo stub and the screens ─────────────────────────────────────────────
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => { mem.set(k, String(v)); }, removeItem: (k) => { mem.delete(k); } };
  globalThis.window = { __ppGetState: () => ({ company: { timezone: 'America/New_York' }, users: USERS, clients: [{ id: 'c1', name: 'Lakeside' }], sites: [{ id: 's1', clientId: 'c1', name: 'Lakeside' }], jobs: [] }) };
  const { QC_TEMPLATES_STUB_KEY } = await import('../src/data/stubKeys.js');
  mem.set(QC_TEMPLATES_STUB_KEY, JSON.stringify({ templates: [{ id: 'it_j', name: 'Nightly Janitorial QC', kind: 'inspection', rating_scale: { type: 'passfail', passThreshold: 80 }, is_published: true, published_version_id: 'iv_j1', versions: [{ id: 'iv_j1', version_number: 1, schema: SCHEMA, status: 'published' }] }] }));
  const api = await tryImport('../src/lib/qcApi.js');
  ok('E0 under plain node qcApi runs its demo stub', typeof api.isQcStub === 'function' && api.isQcStub());
  const stubT = () => JSON.parse(mem.get(QC_TEMPLATES_STUB_KEY)).templates.find((t) => t.id === 'it_j');
  await api.saveTemplate('it_j', { name: 'Strict', ratingScale: { type: 'passfail', passThreshold: 100 }, schema: SCHEMA });
  ok('E1 🔴 the stub keeps the live pass mark and name on Save draft', stubT().rating_scale.passThreshold === 80 && stubT().name === 'Nightly Janitorial QC', JSON.stringify(stubT()).slice(0, 200));
  const rec = await api.createInspection({ templateId: 'it_j', clientId: 'c1', siteId: 's1' });
  ok('E2 🔴 …so a new demo inspection snapshots 80', rec?.template_snapshot?.rating_scale?.passThreshold === 80, JSON.stringify(rec?.template_snapshot?.rating_scale));
  const lst = await api.listTemplates({});
  ok('E3 the stub list flags the unpublished changes', lst.find((t) => t.id === 'it_j')?.has_draft === true);
  await api.publishTemplate('it_j');
  ok('E4 the stub\'s Publish moves them onto the template', stubT().rating_scale.passThreshold === 100 && stubT().name === 'Strict');
  const INSP = readFileSync(new URL('../src/pages/Inspections.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  ok('E5 🔴 the list shows "unpublished changes" for a published template with a draft', /t\.has_draft && \(/.test(INSP) && /tplList\.unpublishedChanges/.test(INSP));
  ok('E6 🔴 …and offers Publish for it', /canEditTpl && \(!t\.is_published \|\| t\.has_draft\) && /.test(INSP));
  const ED = readFileSync(new URL('../src/components/InspectionTemplateEditor.jsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  ok('E7 the editor opens a draft on its own name and pass mark (effectiveTemplateMeta)', /effectiveTemplateMeta\(r\.template, r\.latest\)/.test(ED));
}

console.log(`\n${pass}/${pass + fails.length} template-draft checks passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exitCode = fails.length ? 1 : 0;
