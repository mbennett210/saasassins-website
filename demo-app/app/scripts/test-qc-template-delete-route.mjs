// Handler-level permission gate for the hard template-delete ROUTE
// (POST /api/qc/templates/delete in api/qc/[...path].js). test-qc-template-delete.mjs calls
// store.deleteTemplate directly, so it cannot catch a removed ROUTE gate — the reviewer
// deleted `requirePermission(req,res,'qc.templates.edit')` from the delete branch and the
// whole suite stayed green. This drives the REAL handler through the loopback Supabase fake
// (fake-supabase.mjs — no network, no credentials), so the gate itself is under test.
//
//   node scripts/test-qc-template-delete-route.mjs
//
// Proves: no session → 401 (nothing deleted); crew, who lack qc.templates.edit → 403
// (nothing deleted); a holder — owner / admin / manager, or a crew member granted the key
// by override — → 200 (the template row is deleted).
//
// REGRESSION (BUILD_INTEGRITY §6a): remove the requirePermission line from the delete
// branch and crew / no-session go 200 and delete the row → this suite goes red. Restore it
// → green.
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';

const ORG = '00000000-0000-0000-0000-000000000042';
// Set BEFORE anything under api/ loads; the URL is a closed local port and fetch is stubbed.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const qc = (await import('../api/qc/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) { pass += 1; } else { fails.push(detail ? `${label} — ${detail}` : label); } };

// ── roster + logins (the manager-tier-gates shape) ──
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner' },
  admin: { id: 'u_admin', role: 'admin' },
  mgr: { id: 'u_mgr', role: 'manager' },
  crew: { id: 'u_crew', role: 'crew' },
  crewG: { id: 'u_crew_g', role: 'crew' }, // granted qc.templates.edit by a per-user override
};
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: emailOf(k), app_metadata: { role: p.role, org_user_id: p.id, org_id: ORG },
}]));
const OVERRIDES = [{ userId: 'u_crew_g', grants: ['qc.templates.edit'], revokes: [] }];

// A fresh template before each case, so "deleted / not deleted" is unambiguous.
function seed() {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 3, state: {
        users: roster, permissions: seedPermissions(), userPermissionOverrides: OVERRIDES,
      } }],
      inspection_templates: [{ id: 'it_del', organization_id: ORG, name: 'Move-out closeout', kind: 'checklist' }],
      inspection_template_versions: [{ id: 'v_del', template_id: 'it_del', version_number: 1, status: 'published' }],
    },
    logins,
  });
}
const templateExists = () => world.tables.inspection_templates.some((t) => t.id === 'it_del');

async function callDelete(token) {
  const raw = JSON.stringify({ id: 'it_del' });
  const req = Readable.from([Buffer.from(raw)]);
  req.method = 'POST';
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath: 'templates/delete' };
  req.body = { id: 'it_del' };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('templates/delete: no response')), 5000);
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

// ── denied → nothing deleted ──
seed();
let r = await callDelete(null);
ok('no session → 401', r.status === 401, `got ${r.status}`);
ok('no session deletes nothing', templateExists());

seed();
r = await callDelete('tok-crew');
ok('crew (lacks qc.templates.edit) → 403', r.status === 403, `got ${r.status}`);
ok('crew deletes nothing', templateExists());

// ── holders → deleted ──
for (const who of ['owner', 'admin', 'mgr', 'crewG']) {
  seed();
  r = await callDelete(`tok-${who}`);
  ok(`${who} (holds qc.templates.edit) → 200`, r.status === 200, `got ${r.status} ${JSON.stringify(r.body)}`);
  ok(`${who} deleted the template`, !templateExists());
}

if (fails.length) { console.error('\nqc-template-delete-route FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\nqc-template-delete-route: ${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
