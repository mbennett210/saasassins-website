// CS-019 — GET /api/settings/snapshot served company REVENUE, MRR, outstanding-quote
// value and ACCOUNTS RECEIVABLE to any logged-in session (requireAuth only). Q24 hides
// financials from Admin and from crew entirely, and the invoice surfaces gate on
// `invoices.view` (owner + manager by default), so every crew and admin login could read
// the numbers the app refuses to show them. Verified live-shaped: the route's own comment
// waved it through on the grounds that "crew can already read the blob" — true of the
// figures, and no reason to hand them out through a second door as well.
//
// The gate now follows the surfaces that display them: Super Admin by role, anyone holding
// `invoices.view` under the COMMITTED matrix + per-user overrides. The client half rides
// with it (App.jsx mounts SnapshotSync only for holders), so no tab 403s every 60 s.
//
// It drives the REAL settings handler through fake-supabase.mjs: no network, no
// credentials. A manager login is claim-less, exactly as live (claims.js VALID_ROLES has
// no 'manager' yet), so its role and id resolve from the roster by email.
//
//   node app/scripts/test-snapshot-financial-gate.mjs
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld } from './fake-supabase.mjs';
import { seedPermissions, PERMISSIONS } from '../src/lib/roles.js';

const ORG = '00000000-0000-0000-0000-000000000001';
// Set BEFORE anything under api/ loads (orgState.js + constants.js read them at import).
// The URL is a closed local port and fetch is stubbed: nothing here can reach a network.
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();
const settings = (await import('../api/settings/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── the people ───────────────────────────────────────────────────────────────
// `mgrR` is a manager with invoices.view REVOKED — the case that proves the gate reads the
// matrix and not just the role. `crewG` is a crew member GRANTED it (the office may widen
// per person, exactly as the invoice pages already allow).
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  admin: { id: 'u_admin', role: 'admin', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },
  mgrR: { id: 'u_mgr_r', role: 'manager', claim: false },
  crew: { id: 'u_crew', role: 'crew', claim: true },
  crewG: { id: 'u_crew_g', role: 'crew', claim: true },
};
const KEY = 'invoices.view';
const OVERRIDES = [
  { userId: 'u_crew_g', grants: [KEY], revokes: [] },
  { userId: 'u_mgr_r', grants: [], revokes: [KEY] },
];
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({
  id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k,
}));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`,
  email: emailOf(k),
  app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));

// The figures a leak hands over. Named so a failure reads as what it is.
const SNAPSHOT = {
  organization_id: ORG, source: 'google_sheet',
  revenue_current_month_cents: 4820000, mrr_cents: 3150000,
  ar_cents: 1990000, past_due_30_cents: 640000, outstanding_quotes_cents: 875000,
  updated_at: '2026-09-28T12:00:00.000Z',
};

function buildWorld() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 7,
        state: { users: roster, permissions: seedPermissions(), userPermissionOverrides: OVERRIDES },
      }],
      financial_snapshot: [SNAPSHOT],
    },
    logins,
  });
}

// ── a request through the real handler ───────────────────────────────────────
async function call({ method = 'GET', path, token, query = {} }) {
  const req = Readable.from([]);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { ...query, subpath: path };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 5000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        status(c) { this.statusCode = c; return this; },
        setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(settings(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally {
    Object.assign(console, quiet);
  }
}
const snapshotFor = (who) => call({ path: 'snapshot', token: who ? `tok-${who}` : undefined });
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`;
// A leak is a response that carries ANY of the money columns, whatever the status.
const leaks = (r) => {
  const s = JSON.stringify(r.body || {});
  return /revenue_current_month_cents|mrr_cents|ar_cents|past_due_30_cents|outstanding_quotes_cents/.test(s);
};

console.log('GET /api/settings/snapshot — who may read revenue, MRR and receivables:');

// The key's own defaults are the source of truth for who should pass — never a restated
// role list (THE LAW II.3).
const DEFAULTS = PERMISSIONS[KEY].defaultRoles;
ok(`the gate's key exists and defaults to ${JSON.stringify(DEFAULTS)}`, Array.isArray(DEFAULTS) && DEFAULTS.includes('owner'));
ok(`🔴 '${KEY}' does NOT default to admin (Q24) — so admin must be refused below`, !DEFAULTS.includes('admin'));
ok(`🔴 '${KEY}' does NOT default to crew`, !DEFAULTS.includes('crew'));

for (const who of ['owner', 'mgr', 'crewG']) {
  buildWorld();
  const r = await snapshotFor(who);
  ok(`${who} holds ${KEY} → 200 with the figures`, r.status === 200 && !!r.body?.snapshot, show(r));
}

for (const who of ['admin', 'crew', 'mgrR']) {
  buildWorld();
  const r = await snapshotFor(who);
  ok(`🔴 ${who} does NOT hold ${KEY} → 403`, r.status === 403, show(r));
  ok(`🔴 … and the response leaks no figure`, !leaks(r), show(r));
}

buildWorld();
{
  const r = await snapshotFor(null);
  ok('no session → 401, never the figures', r.status === 401, show(r));
  ok('… and no figure leaks', !leaks(r), show(r));
}

// ── the client half ──────────────────────────────────────────────────────────
// Gating the endpoint alone would 403 every admin and crew tab every 60 s while the same
// figures stayed readable in the blob — noise for nothing. The poller has to follow.
{
  const app = read('../src/App.jsx');
  ok('🔴 SnapshotSync is mounted only for holders of the financial permission, not every office role',
    /usePermission\('invoices\.view'\)/.test(app) && !/isOffice && <SnapshotSync/.test(app));
  const sync = read('../src/components/SnapshotSync.jsx');
  ok('the poller gives up after a refusal rather than retrying every 60 s',
    /REFUSED_STATUSES|status === 403/.test(sync));
}

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\nsnapshot financial gate: ${pass}/${pass} passed`);
}
