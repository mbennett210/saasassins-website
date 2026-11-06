// A key a CLEANER reports lost (or of unknown whereabouts) alerts the office in the live app (CS-710).
//
// A cleaner taps a key's status → "Confirmed lost…" → Report Lost, and the dialog says "managers are
// alerted". The alert was built in the BROWSER (the reducer's MARK_KEY_LOST / MARK_KEY_UNKNOWN), and a
// crew save goes through the server's allowlist merge (api/_lib/crewMerge.js), which drops every bell
// row addressed to someone else and derived only message and key check-out bells itself. So
// production kept the key as lost and alerted NOBODY; the demo, whose reducer runs locally, showed
// five office bells. Now ONE builder, lib/notifications fanOutKeyStatusAlert, is called by the
// reducer and by the crew merge, which derives the alert itself on the move to lost or unknown.
//
//   K1–K6  the merge, on the seed (the verifier's v02 shape: the REAL reducer feeding the REAL merge):
//          a cleaner's Report Lost / Mark unknown saves the office's alerts — the same people and the
//          same words the reducer gives an office report; the cleaner's own rows for others are still
//          dropped; nothing for a key already in that state; the push is flushed
//   K7–K9  the REAL POST /api/state/org-state over the loopback fake, with a crew login: the alerts
//          are committed to the shared record
//   K10    the builder is the reducer's too, and its words are catalog lines rendered per recipient
//
// REGRESSION (THE LAW II.3): on the tree before the fix (`186fffb0`) K1–K4, K6–K8 and K10 fail.
//
//   node app/scripts/test-crew-key-lost.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore } from './deletion-core.mjs';
import { startFakeSupabase } from './fake-supabase-http.mjs';
import { canonicalJson } from '../src/lib/canonicalJson.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const sorted = (a) => [...a].sort().join(',');

const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
const { mergeCrewChanges } = await import('../api/_lib/crewMerge.js');
const { projectCrewView } = await import('../api/_lib/crewView.js');
const notif = await import('../src/lib/notifications.js');

// ── K1–K6: the merge, on the seed ────────────────────────────────────────────────────────────
const full = clone(INITIAL_STATE);
delete full.currentUserId;
const crew = (full.users || []).find((u) => u.role === 'crew' && u.status !== 'inactive');
const scope = { clientIds: (full.clients || []).map((c) => c.id), siteIds: (full.sites || []).map((s) => s.id) };
const served = projectCrewView(full, { userId: crew.id, scope });
const key = (served.keys || []).find((k) => k.status === 'in') || (served.keys || [])[0];
ok('K0 the seed has a key the cleaner can see', !!key, JSON.stringify((served.keys || []).map((k) => k.id)));

const newKeyLost = (before, after) => {
  const had = new Set((before || []).map((n) => n.id));
  return (after || []).filter((n) => !had.has(n.id) && n.eventKey === 'keyLost');
};
for (const [type, status] of [['MARK_KEY_LOST', 'lost'], ['MARK_KEY_UNKNOWN', 'unknown']]) {
  if (!key) break;
  // What the office would get for the same report made on the full record (the reducer's own fan-out).
  const asOffice = reducer({ ...clone(full), currentUserId: crew.id }, { type: ACTIONS[type], keyId: key.id, note: 'gone' });
  const want = newKeyLost(full.notifications, asOffice.notifications);
  // The cleaner's phone: the reducer over the crew view, saved through the merge.
  const posted = reducer({ ...clone(served), currentUserId: crew.id }, { type: ACTIONS[type], keyId: key.id, note: 'gone' });
  const { next, dropped, pushWorthy } = mergeCrewChanges({ full: clone(full), posted, userId: crew.id, scope });
  const got = newKeyLost(full.notifications, next.notifications);
  ok(`🔴 K1 ${type}: the key is ${status} on the server (the custody fields merge, as before)`, next.keys.find((k) => k.id === key.id)?.status === status);
  ok(`🔴 K2 ${type}: the office's alerts are SAVED (${got.length} of the reducer's ${want.length})`, want.length > 0 && got.length === want.length, `got ${got.length}, want ${want.length}`);
  ok(`🔴 K3 ${type}: …to exactly the people an office report alerts`, sorted(got.map((n) => n.userId)) === sorted(want.map((n) => n.userId)), `${sorted(got.map((n) => n.userId))} vs ${sorted(want.map((n) => n.userId))}`);
  ok(`🔴 K4 ${type}: …in the same words`, got.length > 0 && got.every((n) => want.some((w) => w.userId === n.userId && w.title === n.title && w.body === n.body && w.url === n.url)),
    JSON.stringify(got.map((n) => n.title)));
  ok(`K5 ${type}: the rows the cleaner's phone made for others are still dropped (the server builds its own)`, dropped.some((d) => d.slice === 'notifications' && d.reason === 'foreign-notification')
    && got.every((n) => !(posted.notifications || []).some((p) => p.id === n.id)));
  ok(`🔴 K6 ${type}: …and the alert is pushed (the save is push-worthy)`, pushWorthy === true);
}
if (key) {
  // Nothing new for a key already lost: the merge alerts on the MOVE to lost or unknown.
  const lostFull = clone(full);
  lostFull.keys = lostFull.keys.map((k) => (k.id === key.id ? { ...k, status: 'lost', heldByUserId: null, heldByName: null } : k));
  const lostServed = projectCrewView(lostFull, { userId: crew.id, scope });
  const posted = clone(lostServed);
  posted.keys = posted.keys.map((k) => (k.id === key.id ? { ...k, updatedAt: new Date().toISOString() } : k));
  const { next } = mergeCrewChanges({ full: clone(lostFull), posted, userId: crew.id, scope });
  ok('K5b a save that leaves a lost key lost alerts nobody again', newKeyLost(lostFull.notifications, next.notifications).length === 0);
}

// ── K7–K9: the real route, a crew login ─────────────────────────────────────────────────────
const ORG = '00000000-0000-0000-0000-000000000001';
const USERS = {
  't-owner': { id: 'a-owner', email: 'owner@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner' } },
  't-crew': { id: 'a-crew', email: 'crew@cs.co', app_metadata: { role: 'crew', org_user_id: 'u_crew' } },
};
const fake = await startFakeSupabase({ authUsers: USERS });
Object.assign(process.env, { SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'service-role', SUPABASE_ANON_KEY: 'anon', CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG });
delete process.env.ALERT_WEBHOOK_URL;
const consoleError = console.error;
console.error = (...a) => { if (a[0] === '[ALERT]') return; consoleError(...a); };
const { default: handler } = await import('../api/state/org-state.js');
const person = (id, role, name) => ({ id, role, status: 'active', name, email: `${id}@cs.co`, notificationPrefs: {}, pay: { type: 'none' } });
const routeState = () => ({
  version: 5,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: [person('u_owner', 'owner', 'Olive Owner'), person('u_admin', 'admin', 'Ada Admin'), person('u_mgr', 'manager', 'Max Manager'), person('u_crew', 'crew', 'Cora Crew')],
  services: [], frequencies: [], tags: [], snippets: [], inspectionTemplates: [], checklistTemplates: [],
  clients: [{ id: 'c1', name: 'Acme', standingCrewIds: [] }],
  sites: [{ id: 's1', clientId: 'c1' }],
  contacts: [], clientActivities: [], invoices: [], payrollLines: [], reimbursements: [],
  permissions: [{ id: 'keys.view', roles: ['owner', 'admin', 'manager', 'crew'] }, { id: 'keys.checkout', roles: ['owner', 'admin', 'manager', 'crew'] }],
  userPermissionOverrides: [], timeOff: [],
  keys: [{ id: 'k1', clientId: 'c1', clientName: 'Acme', siteId: 's1', masterCode: 'SECRET1', label: 'Front door', status: 'in', heldByUserId: null, heldByName: null }],
  keyEvents: [], conversations: [], messages: [], notifications: [],
  opsSettings: {}, accountMedia: [], quotes: [], syncedPayments: [], financialSnapshot: null, employeeDocuments: [], pipelines: [], opportunities: [], activePipelineId: null,
  marketingInboxes: [], marketingSequences: [], marketingEnrollments: [], marketingSends: [], marketingReplies: [], marketingSuppressions: [], marketingSettings: {},
  inspectionFollowUps: [], opsAlertEvents: [], supplyItems: [], supplyRequests: [], contactActivities: [],
  clientReview: { sections: {}, drafts: {}, picks: {} }, reminderTemplates: [], reminderEvents: [], oauthWorkspaces: [], connectedInboxes: [], invitations: [], jobs: [],
});
fake.tables.org_state.splice(0, fake.tables.org_state.length, { organization_id: ORG, state: routeState(), version: 5, protected_fingerprint: null, min_client_build: null, freeze_strip: [] });
// start_at inside the jobs window: since CS-676/CS-677 the crew scope reads the cleaner's cleans in the window (getCrewJobRows), as a real row always carries start_at.
fake.tables.jobs = [{ id: 'j1', organization_id: ORG, start_at: new Date().toISOString(), data: { id: 'j1', crewIds: ['u_crew'], clientId: 'c1', siteId: 's1', startAt: new Date().toISOString() } }];
async function save(token, state, baseVersion) {
  const text = `{"state":${canonicalJson(state)},"baseVersion":${baseVersion},"build":0,"tab":"tab-1"}`;
  const req = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-length': String(Buffer.byteLength(text)) }, body: JSON.parse(text) };
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return res; }, json(b) { out.body = b; return res; }, setHeader() { return res; } };
  await handler(req, res);
  return out;
}
{
  const view = projectCrewView(routeState(), { userId: 'u_crew', crewJobs: [{ id: 'j1', crewIds: ['u_crew'], clientId: 'c1', siteId: 's1' }] });
  const posted = reducer({ ...clone(view), currentUserId: 'u_crew' }, { type: ACTIONS.MARK_KEY_LOST, keyId: 'k1', note: 'gone' });
  const r = await save('t-crew', posted, 5);
  const committed = fake.tables.org_state[0].state;
  const alerts = (committed.notifications || []).filter((n) => n.eventKey === 'keyLost');
  ok('K7 the crew save is accepted, and the key is LOST in the shared record', r.status === 200 && committed.keys.find((k) => k.id === 'k1')?.status === 'lost', `${r.status} ${JSON.stringify(r.body)?.slice(0, 160)}`);
  ok(`🔴 K8 the office's alerts are COMMITTED: the owner, the admin and the manager (${sorted(alerts.map((n) => n.userId))})`, sorted(alerts.map((n) => n.userId)) === 'u_admin,u_mgr,u_owner');
  ok('K9 …never the cleaner who reported it, and the master code is untouched', alerts.every((n) => n.userId !== 'u_crew') && committed.keys.find((k) => k.id === 'k1')?.masterCode === 'SECRET1');
}
await fake.close?.();

// ── K10: one builder, the catalog's words ────────────────────────────────────────────────────
{
  const red = fs.readFileSync(path.join(APP, 'src/store/reducer.js'), 'utf8');
  const merge = fs.readFileSync(path.join(APP, 'api/_lib/crewMerge.js'), 'utf8');
  const lostCase = red.slice(red.indexOf('case ACTIONS.MARK_KEY_UNKNOWN:'), red.indexOf('// REMOVED 2026-07-22 — `SWEEP_OVERDUE_KEYS`'));
  ok('🔴 K10a the reducer and the crew merge build the alert with ONE builder (fanOutKeyStatusAlert)', typeof notif.fanOutKeyStatusAlert === 'function'
    && (lostCase.match(/fanOutKeyStatusAlert\(/g) || []).length === 2 && !/fanOutManagerAlert\(/.test(lostCase) && /fanOutKeyStatusAlert\(/.test(merge));
  const lib = fs.readFileSync(path.join(APP, 'src/lib/notifications.js'), 'utf8');
  const builder = lib.slice(lib.indexOf('export function fanOutKeyStatusAlert'), lib.indexOf('export function fanOutKeyStatusAlert') + 900);
  const { SOURCE_CATALOG } = await import('../src/i18n/core.js');
  ok('🔴 K10b …its words are catalog lines rendered per recipient (no English left in the reducer\'s key cases)', !/reported LOST|marked unknown/.test(lostCase)
    && /msg\(/.test(builder) && ['alerts.key.lost', 'alerts.key.lostUnnamed', 'alerts.key.unknown', 'alerts.key.unknownUnnamed'].every((k) => builder.includes(`'${k}'`) && typeof SOURCE_CATALOG[k] === 'string'));
}

console.log(`\ntest-crew-key-lost: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
