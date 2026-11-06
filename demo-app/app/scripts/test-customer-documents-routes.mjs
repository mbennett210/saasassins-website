// CUSTOMER DOCUMENTS — the service agreement, the COI and the W-9 (client hub redesign, plan
// 2026-10-08 §3.6). The office's /api/customer-documents/* and the hub's `documents` /
// `document-url` branches, driven through the REAL handlers over fake-supabase.mjs: no network,
// no credentials, no live project (BUILD_INTEGRITY §6b).
//
// What it holds:
//   A. 🔴 the permission gate: every office branch needs `hub.documents.manage` (owner, admin,
//      manager by default; never crew; a revoke holds), a customer login is refused outright,
//      and an unknown branch authenticates before it 404s;
//   B. 🔴 the object path is REBUILT on the server from the document's id and revision — never
//      taken from a body, whatever the body says;
//   C. the writes: upload address → confirm (caller-minted id, a replay is one row), the switch
//      and the title, replace (the OLD object is deleted, a stale revision is refused), delete
//      (the row AND the object);
//   D. 🔴 the hub's scope: the building's VISIBLE documents plus the company-wide ones; another
//      building's document, a hidden one and an out-of-scope building are 404s; signed links last
//      five minutes;
//   E. the agreement: the building's ACTIVE contract only, its name (else "Service Agreement")
//      and start day, the signed PDF — never a price; a master agreement opens from any building
//      it covers (Matt's M3 ★a); no PDF on file is its own answer;
//   F. "Expired" is judged on the ORG-ZONE day: valid THROUGH the day, expired after it.
//
// REGRESSION (THE LAW II.3): on the pre-change tree there is no /api/customer-documents route and
// no hub `documents` branch, so every check below fails.
//
//   node app/scripts/test-customer-documents-routes.mjs
import { readFileSync } from 'node:fs';

const ORG = '00000000-0000-0000-0000-000000000077';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const { seedPermissions } = await import('../src/lib/roles.js');
const { dayKey, addDaysKey } = await import('../src/lib/dates.js');
const docs = await tryImport('../src/lib/customerDocuments.js');
const office = (await tryImport('../api/customer-documents/[...path].js')).default || null;
const hub = (await tryImport('../api/hub/[...path].js')).default || null;

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail) — the repo's suites disagree; this one is label first.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 260)}`;
const exact = (o, list) => !!o && Array.isArray(list) && Object.keys(o).sort().join() === [...list].sort().join();
ok('the shared rule module exists (src/lib/customerDocuments.js)', !docs.__error, docs.__error);
ok('the office route exists (api/customer-documents/[...path].js)', !!office);

// ── the world ─────────────────────────────────────────────────────────────────
const TZ = 'America/New_York';
const TODAY = dayKey(new Date(), TZ);
const CU1 = 'a7000000-0000-4000-8000-000000000001'; // cl_a directly, cl_b through a group
const CU4 = 'a7000000-0000-4000-8000-000000000004'; // cl_x only
const G1 = 'b7000000-0000-4000-8000-000000000001';
const D = (n) => `d7000000-0000-4000-8000-00000000000${n}`;
const NEW1 = 'e7000000-0000-4000-8000-000000000001';
const CT_A = 'c7000000-0000-4000-8000-00000000000a';
const CT_M = 'c7000000-0000-4000-8000-00000000000b';
const CT_DRAFT = 'c7000000-0000-4000-8000-00000000000c';
const PRICE = 987654; // a contract's monthly cents: must never reach a customer
const user = (id, role) => ({ id, role, name: `${id} Person`, status: 'active', email: `${id}@example.test` });
const doc = (id, clientId, kind, title, extra = {}) => ({
  id, organization_id: ORG, client_id: clientId, kind, title, valid_until: null, file_name: `${title}.pdf`, file_size: 2048,
  mime_type: 'application/pdf', visible_to_client: true, revision: 1, created_at: '2026-10-01T12:00:00Z', updated_at: '2026-10-01T12:00:00Z',
  created_by_user_id: 'u_owner', ...extra,
});

function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 5,
        state: {
          company: { name: 'Clean Space', timezone: TZ },
          users: [user('u_owner', 'owner'), user('u_admin', 'admin'), user('u_mgr', 'manager'), user('u_mgr2', 'manager'), user('u_crew', 'crew')],
          clients: [{ id: 'cl_a', name: 'Coral Bay HOA' }, { id: 'cl_b', name: 'Bayshore Senior Living' }, { id: 'cl_x', name: 'Harbor Tower' }],
          sites: [],
          permissions: seedPermissions(),
          userPermissionOverrides: [{ userId: 'u_mgr2', grants: [], revokes: ['hub.documents.manage'] }],
        },
      }],
      crew_assignments: [],
      client_users: [
        { id: CU1, organization_id: ORG, name: 'Pat Manager', email: 'pat@coralbay.test', status: 'active', auth_user_id: 'auth-c1' },
        { id: CU4, organization_id: ORG, name: 'Harbor Person', email: 'h@harbor.test', status: 'active', auth_user_id: 'auth-c4' },
      ],
      client_user_groups: [{ id: G1, organization_id: ORG, name: 'Portfolio', kind: 'management' }],
      client_user_group_members: [{ organization_id: ORG, group_id: G1, client_id: 'cl_b' }],
      client_user_assignments: [
        { id: 'as1', organization_id: ORG, client_user_id: CU1, client_id: 'cl_a', group_id: null },
        { id: 'as2', organization_id: ORG, client_user_id: CU1, client_id: null, group_id: G1 },
        { id: 'as3', organization_id: ORG, client_user_id: CU4, client_id: 'cl_x', group_id: null },
      ],
      customer_documents: [
        doc(D(1), 'cl_a', 'coi', 'Certificate of Insurance', { valid_until: addDaysKey(TODAY, 30) }),
        doc(D(2), 'cl_a', 'coi', 'Old certificate', { valid_until: addDaysKey(TODAY, -1) }),
        doc(D(3), 'cl_a', 'other', 'ZZHIDDENZZ office copy', { visible_to_client: false }),
        doc(D(4), null, 'w9', 'W-9'),
        doc(D(5), 'cl_b', 'coi', 'Bayshore certificate', { valid_until: TODAY }),
        doc(D(6), 'cl_x', 'coi', 'Harbor certificate'),
        doc(D(7), null, 'other', 'ZZHIDDENCOMPANYZZ', { visible_to_client: false }),
      ],
      contracts: [
        { id: CT_A, organization_id: ORG, name: null, status: 'active', is_master: false, start_date: '2025-01-06', end_date: null, base_monthly_cents: PRICE, document_name: 'Signed.pdf', document_size: 1000, document_path: `${ORG}/${CT_A}/signedcopy.pdf`, special_terms: 'ZZTERMSZZ' },
        { id: CT_M, organization_id: ORG, name: 'Portfolio master agreement', status: 'active', is_master: true, start_date: '2024-03-01', end_date: null, base_monthly_cents: PRICE, document_name: null, document_size: null, document_path: null },
        { id: CT_DRAFT, organization_id: ORG, name: 'ZZDRAFTZZ renewal', status: 'draft', is_master: false, start_date: '2027-01-06', end_date: null, base_monthly_cents: PRICE, document_path: `${ORG}/${CT_DRAFT}/draft.pdf` },
      ],
      contract_buildings: [
        { id: 'cb1', organization_id: ORG, contract_id: CT_A, client_id: 'cl_a', active: true },
        { id: 'cb2', organization_id: ORG, contract_id: CT_M, client_id: 'cl_b', active: true },
        { id: 'cb3', organization_id: ORG, contract_id: CT_M, client_id: 'cl_x', active: true },
        { id: 'cb4', organization_id: ORG, contract_id: CT_DRAFT, client_id: 'cl_a', active: false },
      ],
    },
    logins: {
      'tok-owner': { id: 'auth-o', email: 'u_owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
      'tok-admin': { id: 'auth-a', email: 'u_admin@example.test', app_metadata: { role: 'admin', org_user_id: 'u_admin', org_id: ORG } },
      'tok-mgr': { id: 'auth-m', email: 'u_mgr@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
      'tok-mgr2': { id: 'auth-m2', email: 'u_mgr2@example.test', app_metadata: { role: 'manager', org_user_id: 'u_mgr2', org_id: ORG } },
      'tok-crew': { id: 'auth-crew', email: 'u_crew@example.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
      'tok-client': { id: 'auth-c1', email: 'pat@coralbay.test', app_metadata: { role: 'client', client_user_id: CU1, org_id: ORG } },
      'tok-client4': { id: 'auth-c4', email: 'h@harbor.test', app_metadata: { role: 'client', client_user_id: CU4, org_id: ORG } },
    },
  });
}

async function call(handler, { method = 'GET', path: p, token, body }) {
  if (!handler) return { status: 0, body: null, headers: {} };
  const [sub, qs] = p.split('?');
  const req = { method, headers: token ? { authorization: `Bearer ${token}` } : {}, query: { subpath: sub, ...Object.fromEntries(new URLSearchParams(qs || '')) }, body: body || {} };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null }), 10000);
      const headers = {};
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { headers[String(k).toLowerCase()] = v; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => done('threw', { error: e?.message }));
    });
  } finally { Object.assign(console, quiet); }
}
const off = (p, body, token = 'tok-owner') => call(office, { method: body ? 'POST' : 'GET', path: p, token, body });
const hubGet = (p, token = 'tok-client') => call(hub, { path: p, token });
const row = (id) => (world.tables.customer_documents || []).find((x) => x.id === id) || null;
const storageOps = (op) => world.storage.filter((s) => s.op === op);
const PATH = (id, rev = 1) => `${ORG}/${id}/r${rev}`;

// ── A. the gate ───────────────────────────────────────────────────────────────
seed();
const OFFICE_BRANCHES = [
  ['GET', 'list?clientId=cl_a'],
  ['GET', `view-url?id=${D(1)}`],
  ['POST', 'upload-url', { id: NEW1, clientId: 'cl_a', mimeType: 'application/pdf', sizeBytes: 1000 }],
  ['POST', 'confirm', { id: NEW1, clientId: 'cl_a', kind: 'coi', title: 'COI', fileName: 'coi.pdf', mimeType: 'application/pdf', sizeBytes: 1000 }],
  ['POST', 'update', { id: D(1), visibleToClient: true }],
  ['POST', 'replace', { id: D(1), revision: 2, fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 10 }],
  ['POST', 'delete', { id: D(6) }],
];
for (const [method, p, body] of OFFICE_BRANCHES) {
  const name = `${method} ${p.split('?')[0]}`;
  const anon = await call(office, { method, path: p, body });
  ok(`A1 ${name}: no login is a 401`, anon.status === 401, show(anon));
  const crew = await call(office, { method, path: p, body, token: 'tok-crew' });
  ok(`🔴 A2 ${name}: crew are refused (403)`, crew.status === 403, show(crew));
  const client = await call(office, { method, path: p, body, token: 'tok-client' });
  ok(`🔴 A3 ${name}: a CUSTOMER login is refused outright (403 client-login)`, client.status === 403 && client.body?.code === 'client-login', show(client));
  const revoked = await call(office, { method, path: p, body, token: 'tok-mgr2' });
  ok(`🔴 A4 ${name}: a manager whose key was revoked is refused`, revoked.status === 403, show(revoked));
}
ok('A5 the sweep is not vacuous (every office branch)', OFFICE_BRANCHES.length === 7);
{
  const admin = await off('list?clientId=cl_a', undefined, 'tok-admin');
  ok('A6 an admin holds the key by default (owner, admin, manager)', admin.status === 200, show(admin));
  const mgr = await off('list?clientId=cl_a', undefined, 'tok-mgr');
  ok('A7 …and a manager', mgr.status === 200, show(mgr));
  const anon = await call(office, { path: 'no-such-thing' });
  const owner = await off('no-such-thing');
  ok('A8 an unknown branch authenticates FIRST: 401 with no login, 404 with one', anon.status === 401 && owner.status === 404, `${show(anon)} / ${show(owner)}`);
  ok('A9 the answers are private and never cached', /no-store/.test(admin.headers?.['cache-control'] || '') && /private/.test(admin.headers?.['cache-control'] || ''));
  const vercel = readFileSync(new URL('../vercel.json', import.meta.url), 'utf8');
  ok('🔴 A10 the domain has its vercel.json rewrite (pretty URLs 404 without it)', /"\/api\/customer-documents\/:rest\*"\s*,\s*"destination"\s*:\s*"\/api\/customer-documents\/_\?subpath=:rest\*"/.test(vercel));
  const roles = await import('../src/lib/roles.js');
  const def = roles.PERMISSIONS?.['hub.documents.manage'];
  ok('🔴 A11 the key exists: owner, admin and manager by default, never crew', !!def && ['owner', 'admin', 'manager'].every((r) => def.defaultRoles.includes(r)) && !def.defaultRoles.includes('crew'));
  ok('A12 …and it has a section in Settings → Roles', (roles.PERM_GROUPS || []).filter((g) => g.keys.includes('hub.documents.manage')).length === 1);
}

// ── B/C. the writes ───────────────────────────────────────────────────────────
seed();
{
  const evil = `${ORG}/${D(6)}/r1`;
  const up = await off('upload-url', { id: NEW1, clientId: 'cl_a', mimeType: 'application/pdf', sizeBytes: 5000, path: '../../etc/x', storagePath: evil });
  ok('C1 an upload address for a new document', up.status === 200 && typeof up.body?.signedUrl === 'string' && up.body?.revision === 1, show(up));
  ok('🔴 B1 its path is rebuilt from the id — <org>/<id>/r1 — whatever the body said', up.body?.path === PATH(NEW1) && storageOps('upload-url').every((s) => s.bucket === 'customer-documents' && s.path === PATH(NEW1)), JSON.stringify(world.storage));
  for (const [label, body, code] of [
    ['a file type it does not take (GIF)', { id: NEW1, clientId: 'cl_a', mimeType: 'image/gif', sizeBytes: 10 }, 'file-type'],
    ['a file over 10 MB', { id: NEW1, clientId: 'cl_a', mimeType: 'application/pdf', sizeBytes: 10 * 1024 * 1024 + 1 }, 'file-size'],
    ['an id that is not a uuid', { id: 'doc_1', clientId: 'cl_a', mimeType: 'application/pdf', sizeBytes: 10 }, 'document-id'],
    ['a customer that does not exist', { id: NEW1, clientId: 'cl_nope', mimeType: 'application/pdf', sizeBytes: 10 }, 'unknown-customer'],
  ]) {
    const x = await off('upload-url', body);
    ok(`C2 refused: ${label} (400 ${code})`, x.status === 400 && x.body?.code === code, show(x));
  }
  const taken = await off('upload-url', { id: D(1), clientId: 'cl_a', mimeType: 'application/pdf', sizeBytes: 10 });
  ok('C3 a new upload on an id that already names a document is refused (409)', taken.status === 409 && taken.body?.code === 'document-exists', show(taken));
  ok('C4 the shared rule names the same limits the route enforces', docs.CUSTOMER_DOCUMENT_MAX_BYTES === 10 * 1024 * 1024 && JSON.stringify([...(docs.CUSTOMER_DOCUMENT_MIME || [])].sort()) === JSON.stringify(['application/pdf', 'image/jpeg', 'image/png']));

  const conf = await off('confirm', { id: NEW1, clientId: 'cl_a', kind: 'coi', title: '  Certificate of Insurance 2027 ', validUntil: addDaysKey(TODAY, 300), fileName: 'coi.pdf', mimeType: 'application/pdf', sizeBytes: 5000, visibleToClient: true, storagePath: evil, created_by_user_id: 'u_crew' });
  ok('C5 confirm records the document', conf.status === 200 && conf.body?.document?.id === NEW1 && conf.body.document.title === 'Certificate of Insurance 2027', show(conf));
  ok('C6 …in the office\'s allowlist', exact(conf.body?.document, docs.OFFICE_DOCUMENT_FIELDS), Object.keys(conf.body?.document || {}).join());
  const saved = row(NEW1);
  ok('🔴 B2 the row stores NO path at all (it is rebuilt from the id and revision), and its author is the caller', !!saved && !('storage_path' in saved) && saved.revision === 1 && saved.created_by_user_id === 'u_owner', JSON.stringify(saved));
  const replay = await off('confirm', { id: NEW1, clientId: 'cl_a', kind: 'coi', title: 'Certificate of Insurance 2027', fileName: 'coi.pdf', mimeType: 'application/pdf', sizeBytes: 5000 });
  ok('C7 a replayed confirm answers the same document and adds nothing', replay.status === 200 && replay.body?.document?.id === NEW1 && world.tables.customer_documents.filter((x) => x.id === NEW1).length === 1, show(replay));
  const clash = await off('confirm', { id: NEW1, clientId: 'cl_b', kind: 'coi', title: 'x', fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 5 });
  ok('C8 the same id for ANOTHER building is refused (409), never moved', clash.status === 409 && row(NEW1)?.client_id === 'cl_a', show(clash));
  for (const [label, body, code] of [
    ['a kind outside the vocabulary', { kind: 'passport', title: 'x' }, 'kind'],
    ['an empty title', { kind: 'coi', title: '   ' }, 'title'],
    ['a valid-through that is not a day', { kind: 'coi', title: 'x', validUntil: '31/03/2027' }, 'valid-until'],
  ]) {
    const x = await off('confirm', { id: 'e7000000-0000-4000-8000-0000000000f1', clientId: 'cl_a', fileName: 'x.pdf', mimeType: 'application/pdf', sizeBytes: 5, ...body });
    ok(`C9 confirm refuses ${label} (400 ${code})`, x.status === 400 && x.body?.code === code, show(x));
  }

  const hide = await off('update', { id: D(1), visibleToClient: false, title: 'Certificate of Insurance (2026)' });
  ok('C10 the "Visible to the customer" switch and the title save', hide.status === 200 && row(D(1))?.visible_to_client === false && row(D(1))?.title === 'Certificate of Insurance (2026)', show(hide));
  const hubAfter = await hubGet('documents?buildingId=cl_a');
  ok('C11 …and a hidden document leaves the customer\'s list at once', hubAfter.status === 200 && !(hubAfter.body?.documents || []).some((x) => x.id === D(1)), show(hubAfter));
  await off('update', { id: D(1), visibleToClient: true });

  world.storage = [];
  const rep = await off('upload-url', { id: D(2), replace: true, mimeType: 'image/png', sizeBytes: 900, storagePath: `${ORG}/${D(1)}/r1` });
  ok('🔴 B3 a replacement uploads to the NEXT revision\'s path, rebuilt on the server', rep.status === 200 && rep.body?.revision === 2 && rep.body?.path === PATH(D(2), 2), show(rep));
  const done = await off('replace', { id: D(2), revision: 2, fileName: 'coi-2027.png', mimeType: 'image/png', sizeBytes: 900, validUntil: addDaysKey(TODAY, 365), storagePath: `${ORG}/${D(6)}/r1` });
  ok('C12 replace swaps the file and the date', done.status === 200 && row(D(2))?.revision === 2 && row(D(2))?.file_name === 'coi-2027.png' && row(D(2))?.mime_type === 'image/png' && row(D(2))?.valid_until === addDaysKey(TODAY, 365), show(done));
  ok('🔴 C13 replace means delete: the OLD object is removed (and nothing the body named)', storageOps('remove').map((s) => `${s.bucket}:${s.path}`).join() === `customer-documents:${PATH(D(2), 1)}`, JSON.stringify(storageOps('remove')));
  const stale = await off('replace', { id: D(2), revision: 2, fileName: 'again.png', mimeType: 'image/png', sizeBytes: 900 });
  ok('C14 a stale revision is refused (409), so two replaces cannot both land', stale.status === 409 && stale.body?.code === 'stale' && row(D(2))?.file_name === 'coi-2027.png', show(stale));

  world.storage = [];
  const del = await off('delete', { id: D(5), storagePath: `${ORG}/${D(6)}/r1` });
  ok('C15 delete removes the row', del.status === 200 && !row(D(5)), show(del));
  ok('🔴 C16 …and its object, rebuilt from the id (never the path the body named)', storageOps('remove').map((s) => `${s.bucket}:${s.path}`).join() === `customer-documents:${PATH(D(5))}`, JSON.stringify(storageOps('remove')));
  const gone = await off('delete', { id: D(5) });
  ok('C17 deleting it again is a 404', gone.status === 404, show(gone));

  world.storage = [];
  const view = await off(`view-url?id=${D(4)}`);
  ok('C18 the office opens a document through a 5-minute signed link', view.status === 200 && /ttl=300/.test(view.body?.url || '') && storageOps('download-url')[0]?.path === PATH(D(4)) && storageOps('download-url')[0]?.ttl === 300, show(view));
}

// ── list + F. expired on the org-zone day ─────────────────────────────────────
seed();
{
  const r = await off('list?clientId=cl_a');
  const ids = (r.body?.documents || []).map((x) => x.id).sort();
  ok('L1 the customer page lists the building\'s documents (hidden ones too) and the company-wide ones', r.status === 200 && JSON.stringify(ids) === JSON.stringify([D(1), D(2), D(3), D(4), D(7)].sort()), JSON.stringify(ids));
  ok('L2 every row is exactly the office allowlist', (r.body?.documents || []).length > 0 && r.body.documents.every((x) => exact(x, docs.OFFICE_DOCUMENT_FIELDS)));
  const co = await off('list?scope=company');
  ok('L3 Settings → Company lists only the documents for every customer', co.status === 200 && (co.body?.documents || []).map((x) => x.id).sort().join() === [D(4), D(7)].sort().join(), show(co));
  const bad = await off('list');
  ok('L4 a list names a building or the company scope (400 otherwise)', bad.status === 400, show(bad));
  const nobody = await off('list?clientId=cl_nope');
  ok('L5 a building that does not exist is refused', nobody.status === 400 && nobody.body?.code === 'unknown-customer', show(nobody));
  const exp = (id) => r.body?.documents?.find((x) => x.id === id)?.expired;
  ok('🔴 F1 valid through yesterday (org zone) is Expired; valid 30 more days is not', exp(D(2)) === true && exp(D(1)) === false, JSON.stringify(r.body?.documents));
  const de = docs.documentExpired;
  ok('🔴 F2 the rule: valid THROUGH the day — expired only after it; no date never expires',
    typeof de === 'function' && de('2026-10-08', '2026-10-08') === false && de('2026-10-07', '2026-10-08') === true && de(null, '2026-10-08') === false && de('2026-10-09', '2026-10-08') === false);
}

// ── D/E. the hub ──────────────────────────────────────────────────────────────
seed();
{
  const r = await hubGet('documents?buildingId=cl_a');
  ok('🔴 D1 GET /api/hub/documents answers the building\'s agreement and documents', r.status === 200 && exact(r.body, ['agreement', 'documents']), show(r));
  const ids = (r.body?.documents || []).map((x) => x.id).sort();
  ok('🔴 D2 the building\'s VISIBLE documents + the company-wide visible ones — nothing hidden, nothing of another building', JSON.stringify(ids) === JSON.stringify([D(1), D(2), D(4)].sort()), JSON.stringify(ids));
  ok('🔴 D3 each document is exactly the hub allowlist', (r.body?.documents || []).length === 3 && r.body.documents.every((x) => exact(x, docs.HUB_DOCUMENT_FIELDS)));
  ok('D4 the COI before the W-9 (the order Matt drew)', (r.body?.documents || []).findIndex((x) => x.kind === 'coi') < (r.body?.documents || []).findIndex((x) => x.kind === 'w9'));
  ok('F3 the hub says Expired on the org day too', r.body?.documents?.find((x) => x.id === D(2))?.expired === true && r.body?.documents?.find((x) => x.id === D(1))?.expired === false);
  const a = r.body?.agreement;
  ok('🔴 E1 the agreement is the ACTIVE contract: "Service Agreement" (no name), its start day, a signed copy on file', exact(a, docs.HUB_AGREEMENT_FIELDS) && a.title === 'Service Agreement' && a.startedDay === '2025-01-06' && a.hasFile === true, JSON.stringify(a));
  const blob = JSON.stringify(r.body);
  ok('🔴 E2 never a price, a term, a draft or a storage path', !blob.includes(String(PRICE)) && !/ZZTERMSZZ|ZZDRAFTZZ|ZZHIDDEN|signedcopy|r1|file_name|fileName/.test(blob), blob.slice(0, 300));
  const b = await hubGet('documents?buildingId=cl_b');
  ok('🔴 E3 a MASTER agreement shows on a building it covers, by its name (M3 ★a)', b.status === 200 && b.body?.agreement?.title === 'Portfolio master agreement' && b.body.agreement.startedDay === '2024-03-01' && b.body.agreement.hasFile === false, show(b));
  const x = await hubGet('documents?buildingId=cl_x', 'tok-client4');
  ok('E4 …and on every other building it covers, for whoever can see that one', x.status === 200 && x.body?.agreement?.title === 'Portfolio master agreement', show(x));

  world.storage = [];
  const own = await hubGet(`document-url?buildingId=cl_a&id=${D(1)}`);
  ok('🔴 D5 the building\'s document opens through a FIVE-minute signed link, at the rebuilt path', own.status === 200 && /ttl=300/.test(own.body?.url || '') && own.body?.expiresIn === 300 && storageOps('download-url').some((s) => s.bucket === 'customer-documents' && s.path === PATH(D(1)) && s.ttl === 300), show(own));
  ok('D6 the answer is exactly { url, expiresIn }', exact(own.body, ['url', 'expiresIn']));
  for (const [label, q, token] of [
    ['another building\'s document asked through MY building', `buildingId=cl_a&id=${D(5)}`],
    ['a building outside my scope', `buildingId=cl_x&id=${D(6)}`],
    ['a HIDDEN document', `buildingId=cl_a&id=${D(3)}`],
    ['a hidden company-wide document', `buildingId=cl_a&id=${D(7)}`],
    ['a made-up id', 'buildingId=cl_a&id=d7000000-0000-4000-8000-0000000000ff'],
    ['not a uuid', 'buildingId=cl_a&id=../x'],
    ['another login\'s building', `buildingId=cl_a&id=${D(1)}`, 'tok-client4'],
  ]) {
    world.storage = [];
    const z = await hubGet(`document-url?${q}`, token);
    ok(`🔴 D7 ${label} is a 404 that signs nothing`, z.status === 404 && z.body?.code === 'not-found' && storageOps('download-url').length === 0, show(z));
  }
  const w9a = await hubGet(`document-url?buildingId=cl_a&id=${D(4)}`);
  const w9b = await hubGet(`document-url?buildingId=cl_b&id=${D(4)}`);
  ok('🔴 D8 a company-wide document opens from EVERY building', w9a.status === 200 && w9b.status === 200, `${show(w9a)} / ${show(w9b)}`);
  world.storage = [];
  const ag = await hubGet('document-url?buildingId=cl_a&id=agreement');
  ok('🔴 E5 the agreement opens as the signed PDF from the contract store, five minutes', ag.status === 200 && storageOps('download-url').some((s) => s.bucket === 'contract-documents' && s.path === `${ORG}/${CT_A}/signedcopy.pdf` && s.ttl === 300), show(ag));
  const none = await hubGet('document-url?buildingId=cl_b&id=agreement');
  ok('E6 an agreement with no signed copy on file says so (404 no-file)', none.status === 404 && none.body?.code === 'no-file', show(none));
  world.tables.contract_buildings = world.tables.contract_buildings.filter((cb) => cb.client_id !== 'cl_a' || cb.contract_id === CT_DRAFT);
  const draftOnly = await hubGet('documents?buildingId=cl_a');
  ok('🔴 E7 a building with only a DRAFT contract shows no agreement', draftOnly.status === 200 && draftOnly.body?.agreement === null, show(draftOnly));
  const noAg = await hubGet('document-url?buildingId=cl_a&id=agreement');
  ok('E8 …and its agreement link is a 404', noAg.status === 404, show(noAg));

  for (const p of ['documents?buildingId=cl_a', `document-url?buildingId=cl_a&id=${D(1)}`]) {
    const anon = await call(hub, { path: p });
    const staff = await hubGet(p, 'tok-owner');
    ok(`D9 ${p.split('?')[0]}: no login 401, a STAFF login 403 office-login`, anon.status === 401 && staff.status === 403 && staff.body?.code === 'office-login', `${show(anon)} / ${show(staff)}`);
  }
  const out = await hubGet('documents?buildingId=cl_x');
  ok('🔴 D10 a building outside the login\'s scope is a 404 that names nothing', out.status === 404 && out.body?.code === 'not-found' && !JSON.stringify(out.body).includes('Harbor'), show(out));
}

console.log(`\ntest-customer-documents-routes: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
}
