// A caller who has not passed a route's check learns nothing about the server's configuration, and
// a misconfigured cron still reads as a server error to the monitoring that watches it (CS-215).
//
// The cron routes answered a missing CRON_SECRET with 500 "CRON_SECRET is not configured" — to
// ANYONE, before any check — and /api/time's auto-close and watchdog answered it with a 401, which
// cron monitoring cannot tell from a wrong secret (CS-215's outlier half). /api/push/test answered
// a missing VAPID keypair with 503 "Push is not set up … (VAPID keys missing)" before its login
// check. The rule now (the orchestrator's ruling, 2026-10-12, on CS-215 and the no-leak rule):
//   • every cron gate (all nine; the tenth, reviews/sync, left with Google reviews on 2026-10-20) answers an UNSET secret with a 500 and ONE fixed body that names
//     nothing (`_lib/cronGate.js` CRON_UNAVAILABLE), whatever the caller sends, before any work, and
//     logs the gap by name; a wrong or missing bearer on a configured server stays a 401;
//   • /api/push/test checks the login first; a signed-in member on a server without the keys is
//     told push is not set up, in a sentence that names no key; the log names them.
//
//   G  the suite drives every CRON_SECRET gate under app/api (an enumeration of the reads).
//   C  each gate, through its REAL handler over fake-supabase.mjs: C0/C0b configured → 401 for a
//      wrong or missing bearer; C1/C2 unset → 500 whatever the bearer; C3 the body IS
//      CRON_UNAVAILABLE; C3b it names no configuration; C4 the log names the gap; C5 no query ran.
//   P  /api/push/test: no login → the same 401 as on a server with push configured; a signed-in
//      member on a server without the keys → 503 with a sentence that names no key; the log does.
//
// REGRESSION (THE LAW II.3): on b4ff8f30 (where an unset secret answered the wrong-secret 401)
// every C1 and C3 fails (ten gates each), and C4 for the two time crons, which logged nothing.
// On the tree before that, P1 / P3 failed and every C3b but the time crons'.
//
//   node app/scripts/test-config-gap-refusals.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORG = '00000000-0000-0000-0000-000000000042';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
for (const k of ['CRON_SECRET', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'SYSTEM_SENDER_EMAIL']) delete process.env[k];
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'api');
const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();
const { seedPermissions } = await import('../src/lib/roles.js');
// The source of truth for an unconfigured cron's answer. Before the fix the module does not
// exist, so every C3 fails rather than the suite crashing.
let CRON_UNAVAILABLE = null;
try { ({ CRON_UNAVAILABLE } = await import('../api/_lib/cronGate.js')); } catch { /* not there yet */ }

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const show = (r) => `${r?.status} ${JSON.stringify(r?.body)?.slice(0, 160)}`;
const same = (a, b) => a.status === b.status && JSON.stringify(a.body) === JSON.stringify(b.body);
// Words that would tell a caller something about the configuration.
const CONFIG_WORDS = /CRON_SECRET|VAPID|config|secret|key|\benv|missing|unset/i;

function seed() {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 1,
        state: {
          version: 57, company: { timezone: 'America/New_York' },
          users: [{ id: 'u_owner', role: 'owner', name: 'Dana Owner', status: 'active', email: 'u_owner@example.test' }],
          clients: [], permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
        },
      }],
    },
    logins: { 'tok-owner': { id: 'auth-o', email: 'u_owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } } },
  });
}

let logs = [];
async function call(handler, { method = 'GET', path: p = '', headers = {}, query = {} } = {}) {
  const [sub, qs] = p.split('?');
  const req = { method, headers, query: { ...(sub ? { subpath: sub } : {}), ...Object.fromEntries(new URLSearchParams(qs || '')), ...query }, body: {} };
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args) => { logs.push(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.log = () => {};
  console.warn = capture;
  console.error = capture;
  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: 'timeout', body: null }), 15000);
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

// ── C. the cron gates ── [name (the log's label), module, subpath]
const CRONS = [
  ['cron/ops-alerts', 'cron/ops-alerts.js', ''],
  ['cron/qbo-refresh', 'cron/qbo-refresh.js', ''],
  ['cron/reap', 'cron/reap.js', ''],
  ['inbox/ingest', 'inbox/ingest.js', ''],
  ['marketing/run', 'marketing/run.js', ''],
  ['reminders/run', 'reminders/run.js', ''],
  ['push/dispatch', 'push/dispatch.js', ''],
  ['time/auto-close', 'time/[...path].js', 'auto-close'],
  ['time/watchdog', 'time/[...path].js', 'watchdog'],
];

// G: every read of CRON_SECRET under app/api (the shared _lib aside) is a gate driven below, so a
// new cron cannot join without this suite holding it to the rule.
{
  const reads = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '_lib' && e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(js|mjs)$/.test(e.name)) continue;
      const n = (fs.readFileSync(p, 'utf8').match(/process\.env\.CRON_SECRET\b/g) || []).length;
      if (n) reads.set(path.relative(API, p).split(path.sep).join('/'), n);
    }
  };
  walk(API);
  const driven = new Map();
  for (const [, mod] of CRONS) driven.set(mod, (driven.get(mod) || 0) + 1);
  const off = [...new Set([...reads.keys(), ...driven.keys()])].filter((f) => reads.get(f) !== driven.get(f));
  ok(`G every CRON_SECRET gate under app/api is driven here (${[...reads.values()].reduce((a, b) => a + b, 0)} reads in ${reads.size} files)`,
    () => off.length === 0, off.map((f) => `${f}: ${reads.get(f) || 0} read(s), ${driven.get(f) || 0} driven`).join('; '));
}

for (const [name, mod, p] of CRONS) {
  const handler = (await import(`../api/${mod}`)).default;
  seed();
  process.env.CRON_SECRET = 'the-real-secret';
  const wrong = await call(handler, { path: p, headers: { authorization: 'Bearer not-the-secret' } });
  const none = await call(handler, { path: p });
  delete process.env.CRON_SECRET;
  seed();
  logs = [];
  const unsetBare = await call(handler, { path: p });
  const unsetBearer = await call(handler, { path: p, headers: { authorization: 'Bearer anything' } });
  ok(`C0 ${name}: configured, a wrong bearer → 401`, () => wrong.status === 401, show(wrong));
  ok(`C0b ${name}: configured, no bearer → the same 401`, () => same(none, wrong), `${show(none)} vs ${show(wrong)}`);
  ok(`🔴 C1 ${name}: CRON_SECRET unset → 500, so monitoring sees the misconfiguration (CS-215)`, () => unsetBare.status === 500, show(unsetBare));
  ok(`C2 ${name}: …whatever bearer the caller sends`, () => same(unsetBearer, unsetBare), `${show(unsetBearer)} vs ${show(unsetBare)}`);
  ok(`🔴 C3 ${name}: …with the one fixed body, cronGate's CRON_UNAVAILABLE`,
    () => !!CRON_UNAVAILABLE && JSON.stringify(unsetBare.body) === JSON.stringify(CRON_UNAVAILABLE), show(unsetBare));
  ok(`C3b ${name}: the answer names no configuration`, () => !CONFIG_WORDS.test(JSON.stringify(unsetBare.body ?? '')), show(unsetBare));
  ok(`C4 ${name}: the gap is in the server log, by name`,
    () => logs.some((l) => l.includes(`[${name}]`) && /CRON_SECRET/.test(l) && /not configured/i.test(l)), logs.join(' | ').slice(0, 160));
  ok(`C5 ${name}: refused before any work (no query ran)`, () => world.log.length === 0, JSON.stringify(world.log.slice(0, 3)));
}

// ── P. /api/push/test ──
{
  const pushTest = (await import('../api/push/test.js')).default;
  seed();
  process.env.VAPID_PUBLIC_KEY = 'fake-public';
  process.env.VAPID_PRIVATE_KEY = 'fake-private';
  const configuredAnon = await call(pushTest, { method: 'POST' });
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  logs = [];
  const anon = await call(pushTest, { method: 'POST' });
  ok('P0 (control) push/test with push configured: no login → 401', () => configuredAnon.status === 401, show(configuredAnon));
  ok('P1 push/test with NO keys: no login → the same 401, not a 503 naming the keys', () => same(anon, configuredAnon), `${show(anon)} vs ${show(configuredAnon)}`);
  logs = [];
  const member = await call(pushTest, { method: 'POST', headers: { authorization: 'Bearer tok-owner' } });
  ok('P2 a signed-in member on a server without the keys is told push is not set up (503)', () => member.status === 503 && typeof member.body?.error === 'string', show(member));
  ok('P3 …in a sentence that names no key', () => !/VAPID|key/i.test(member.body?.error || ''), show(member));
  ok('P4 …and the gap is in the server log', () => logs.some((l) => /VAPID/.test(l)), logs.join(' | ').slice(0, 160));
}

console.log(`\ntest-config-gap-refusals: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
