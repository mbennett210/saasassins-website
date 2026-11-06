// CS-692 — crew could upload and delete the office's access files through the API.
//
// WHAT WAS WRONG. `/api/site-attachments` let a WRITE (upload-url, delete) through on
// `sites.attachments` — a CREW default (lib/roles) — plus an assignment to the site with no
// time window: any cleaner who ever had a clean there could put arbitrary PDFs/images in the
// bucket under that location, or delete the office's gate map (the location then lists a file
// nobody can open). The app only ever offers those controls inside the location's EDIT form,
// which needs `sites.edit`.
//
// THE RULE (lib/siteAttachmentRules siteAttachmentWriteAllowed, read by the route AND the
// Location card): a write needs `sites.edit` AND `sites.attachments` AND an office role — crew
// never, whatever a per-user grant says (the QR codes' office floor, lib/scanCodes). Crew keep
// READING their assigned sites' files (the customer page's Access tab opens them).
//
// Driven through the REAL handler over the in-process fake Supabase (no network).
// REGRESSION (THE LAW II.3): on the pre-fix tree a crew upload-url and delete answer 200 and
// the office's file is removed.
//
//   node scripts/test-site-attachments-write.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const ORG = '00000000-0000-0000-0000-000000000692';
Object.assign(process.env, { SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon', CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG });
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const rules = await import('../src/lib/siteAttachmentRules.js');
const att = (await import('../api/site-attachments/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── the rule, pure ───────────────────────────────────────────────────────────────────────
{
  const allowed = typeof rules.siteAttachmentWriteAllowed === 'function' ? rules.siteAttachmentWriteAllowed : () => undefined;
  const both = { canEditSites: true, canAttach: true };
  eq('the owner who edits the location may', allowed('owner', both), true);
  eq('a manager who edits the location may', allowed('manager', both), true);
  eq('an admin who edits the location may', allowed('admin', both), true);
  eq('crew never may, even granted both keys', allowed('crew', both), false);
  eq('a customer login never may', allowed('client', both), false);
  eq('without sites.edit (the edit form) no one may', allowed('owner', { canEditSites: false, canAttach: true }), false);
  eq('without sites.attachments (the button) no one may', allowed('manager', { canEditSites: true, canAttach: false }), false);
}

// ── the real route ───────────────────────────────────────────────────────────────────────
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const PEOPLE = { owner: 'owner', manager: 'manager', crew: 'crew', crewGranted: 'crew' };
const roster = Object.entries(PEOPLE).map(([k, role]) => ({ id: `u_${k}`, email: `${k}@example.test`, role, status: 'active', name: k }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, role]) => [`tok-${k}`, { id: `auth-${k}`, email: `${k}@example.test`, app_metadata: { role, org_user_id: `u_${k}`, org_id: ORG } }]));
const prefix = `${ORG}/site-attachments/site/st_a/`;
const officeFile = { name: 'gate-map.pdf', size: 1234, type: 'application/pdf', storagePath: `${prefix}abcdefghijklmnop.pdf` };
function seed(overrides = []) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 3, state: {
        users: roster, permissions: seedPermissions(), userPermissionOverrides: overrides,
        clients: [{ id: 'cl_a', name: 'Acme' }], sites: [{ id: 'st_a', clientId: 'cl_a', name: 'A', attachments: [officeFile] }],
        opsSettings: {},
      } }],
      // Both cleaners had a clean at the site a month ago — the "any clean, ever" path.
      jobs: [{ organization_id: ORG, id: 'j_old', site_id: 'st_a', status: 'done', start_at: iso(NOW - 30 * 864e5), data: { id: 'j_old', siteId: 'st_a', clientId: 'cl_a', crewIds: ['u_crew', 'u_crewGranted'], startAt: iso(NOW - 30 * 864e5), endAt: iso(NOW - 30 * 864e5 + 36e5), status: 'done' } }],
      crew_assignments: [], time_entries: [], payroll_runs: [],
    },
    logins,
  });
  world.objects[`ops-media/${officeFile.storagePath}`] = Buffer.from('%PDF-1.4');
}
function call(who, action, body) {
  const raw = JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST'; req.headers = { authorization: `Bearer tok-${who}` }; req.query = { subpath: action }; req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no response')), 10000);
    const done = (status, b) => { clearTimeout(t); Object.assign(console, quiet); resolve({ status, body: b }); };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; } };
    Promise.resolve(att(req, res)).catch((e) => { clearTimeout(t); Object.assign(console, quiet); reject(e); });
  });
}
const upload = (who) => call(who, 'upload-url', { scope: 'site', ownerId: 'st_a', mimeType: 'application/pdf', sizeBytes: 1000 });
const remove = (who) => call(who, 'delete', { scope: 'site', ownerId: 'st_a', storagePath: officeFile.storagePath });
const download = (who) => call(who, 'download-url', { scope: 'site', ownerId: 'st_a', storagePath: officeFile.storagePath });
const removals = () => (world.storage || []).filter((s) => /remove/i.test(JSON.stringify(s)));

seed();
eq('crew READ their site\'s access file (200)', (await download('crew')).status, 200);
eq('crew can no longer get an upload link (403)', (await upload('crew')).status, 403);
eq('crew can no longer delete the office\'s gate map (403)', (await remove('crew')).status, 403);
eq('…and nothing was removed from storage', removals().length, 0);
eq('…the file is still there to open', (await download('crew')).status, 200);

seed([{ userId: 'u_crewGranted', grants: ['sites.edit', 'sites.attachments'], revokes: [] }]);
eq('crew granted sites.edit AND sites.attachments still cannot upload (the office floor)', (await upload('crewGranted')).status, 403);
eq('…nor delete', (await remove('crewGranted')).status, 403);

seed();
eq('the owner may get an upload link', (await upload('owner')).status, 200);
eq('a manager may', (await upload('manager')).status, 200);
eq('the owner may delete', (await remove('owner')).status, 200);

seed([{ userId: 'u_manager', grants: [], revokes: ['sites.attachments'] }]);
eq('a manager with sites.attachments revoked may not upload (the button\'s key)', (await upload('manager')).status, 403);
seed([{ userId: 'u_manager', grants: [], revokes: ['sites.edit'] }]);
eq('a manager with sites.edit revoked may not upload (the edit form\'s key)', (await upload('manager')).status, 403);
eq('…nor delete', (await remove('manager')).status, 403);

// ── the screen reads the same rule ──────────────────────────────────────────────────────
{
  const card = read('src/components/LocationCard.jsx');
  ok('the Location card shows the attach controls by the same rule', /siteAttachmentWriteAllowed\(currentUser\?\.role, \{ canEditSites: !!canEdit, canAttach: canAttachKey \}\)/.test(card));
  const route = read('api/site-attachments/[...path].js');
  ok('the route reads the shared rule', /siteAttachmentWriteAllowed\(/.test(route));
}

if (fails.length) {
  console.error(`\ntest-site-attachments-write: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\ntest-site-attachments-write: ${pass}/${pass} passed`);
}
