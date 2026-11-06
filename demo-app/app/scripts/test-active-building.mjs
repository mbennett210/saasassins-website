// ONE "is this a building we clean now?" rule (CS-683, the S128 full-app pass, finding F2-02).
//
// The status menu and the Customers import write `client.statusOverride`; the reminder walkers
// read the RETIRED `client.status`, so a building marked Inactive through the menu kept its
// inspection-due pushes and its monthly supply-order reminders, and the manager Home kept
// counting its inspection as due. Supply-order reminders also fired for leads and vendors,
// because the walker never applied the supplies module's own "is this a supply building" rule.
// And the fixture that was meant to prove the inactive skip built its building with the retired
// field (test-supplies-approval), so the suite stayed green over the app's real path.
//
// Held here, against the field the app writes (`statusOverride`) and the ONE rule
// (lib/customerStatus isActiveBuilding; Inactive and Archived are out):
//   A. the rule itself;
//   B. the walkers: inspection-due and the three supply alerts (order due, overdue, over budget);
//   C. the manager Home's "Inspections · N due";
//   D. the server's twin reads, through the REAL handlers over the loopback fake (never
//      production): GET /api/qc/inspections/latest-by-client and the ops-alerts cron's own
//      computation (a dry run of `run`, which writes nothing).
//
// REGRESSION (THE LAW II.3): on the tree before the fix (`186fffb0`) there is no
// lib/customerStatus, and every B / C / D check about a building set Inactive through the menu,
// a lead or a vendor goes red.
//
//   node app/scripts/test-active-building.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000011';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };
const CS = await tryImport('../src/lib/customerStatus.js');
const opsAlerts = await import('../src/lib/opsAlerts.js');
const managerHome = await import('../src/lib/managerHome.js');
const supplies = await import('../src/lib/supplies.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const qc = (await import('../api/qc/[...path].js')).default;
const cron = await import('../api/cron/ops-alerts.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). This suite is label-first.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const rule = (c) => (typeof CS.isActiveBuilding === 'function' ? CS.isActiveBuilding(c) : (() => { throw new Error('lib/customerStatus isActiveBuilding is missing'); })());

// The buildings. Ids are NOT seed ids (cl_seed_*), which the walkers skip on purpose (CS-030).
const SUP = 'u_sup';
const live = { id: 'b_live', name: 'Live Tower', supervisorId: SUP };
const inactive = { id: 'b_inactive', name: 'Inactive Plaza', supervisorId: SUP, statusOverride: 'inactive' };   // the status menu's write
const archived = { id: 'b_archived', name: 'Archived Court', supervisorId: SUP, statusOverride: 'archived' };
const lead = { id: 'b_lead', name: 'Lead Lofts', supervisorId: SUP, statusOverride: 'lead' };
const vendor = { id: 'b_vendor', name: 'Paper Supply Co', supervisorId: SUP, type: 'vendor' };
const legacy = { id: 'b_legacy', name: 'Old Row', supervisorId: SUP, status: 'inactive' };                       // the retired field
const BUILDINGS = [live, inactive, archived, lead, vendor, legacy];

// ── A. the rule ──────────────────────────────────────────────────────────────
ok('A1 lib/customerStatus exports the one rule', typeof CS.isActiveBuilding === 'function');
ok('A2 a building with no status set is active', () => rule(live) === true);
ok('A3 🔴 Inactive set through the status menu (statusOverride) is NOT active', () => rule(inactive) === false);
ok('A4 Archived is NOT active', () => rule(archived) === false);
ok('A5 the retired `status: inactive` is still read as inactive', () => rule(legacy) === false);
ok('A6 a vendor is never a building', () => rule(vendor) === false);
ok('A7 a Lead stays a building (the walkers narrow further themselves)', () => rule(lead) === true);
ok('A8 nothing, or a row with no id, is not a building', () => rule(null) === false && rule({ name: 'x' }) === false);
ok('A9 the status vocabulary lists archived beside the menu\'s three',
  () => ['lead', 'active', 'inactive', 'archived'].every((s) => (CS.CUSTOMER_STATUS_OVERRIDES || []).includes(s)));
ok('A10 the old reader is GONE (replace means delete): opsAlerts.isReminderClient', !('isReminderClient' in opsAlerts));

// ── B. the walkers ───────────────────────────────────────────────────────────
const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-09-11T16:00:00Z');   // the 11th, 12:00 in New York
const longAgo = new Date(NOW - 60 * DAY).toISOString();
const inspections = BUILDINGS.map((b) => ({ client_id: b.id, performed_at: longAgo }));
const insp = opsAlerts.getDueInspectionReminders({ clients: BUILDINGS, inspections, now: NOW, settings: {} }).map((a) => a.clientId);
ok('B1 the live building is reminded (control)', insp.includes(live.id), JSON.stringify(insp));
ok('B2 🔴 a building set Inactive through the menu gets NO inspection reminder', !insp.includes(inactive.id), JSON.stringify(insp));
ok('B3 an Archived building gets no inspection reminder', !insp.includes(archived.id), JSON.stringify(insp));
ok('B4 the retired-field inactive building still gets none', !insp.includes(legacy.id), JSON.stringify(insp));

const SETTINGS = { supplyOrderDayOfMonth: 10 };
const kinds = opsAlerts.getDueSupplyAlerts({ clients: BUILDINGS, requests: [], now: NOW, settings: SETTINGS, tz: 'America/New_York' })
  .map((a) => `${a.kind}:${a.clientId}`);
// The office hears the day after the supervisor's reminder went out (CS-953), so the control
// for the office alert carries every building's reminder as raised on the 10th.
const dueIds = BUILDINGS.map((b) => `oa_supplyOrderDue_${b.id}_2026-09`);
const officeKinds = opsAlerts.getDueSupplyAlerts({
  clients: BUILDINGS, requests: [], now: NOW, settings: SETTINGS, tz: 'America/New_York',
  firedIds: new Set(dueIds), firedAt: new Map(dueIds.map((id) => [id, '2026-09-10T16:00:00.000Z'])),
}).map((a) => `${a.kind}:${a.clientId}`);
ok('B5 the live building is reminded to order and the office told the day after (control)',
  kinds.includes(`supplyOrderDue:${live.id}`) && officeKinds.includes(`supplyOrderOverdue:${live.id}`), JSON.stringify([kinds, officeKinds]));
const allKinds = [...kinds, ...officeKinds];
ok('B6 🔴 a building set Inactive through the menu gets NO supply reminder', !allKinds.some((k) => k.endsWith(`:${inactive.id}`)), JSON.stringify(allKinds));
ok('B7 an Archived building gets no supply reminder', !allKinds.some((k) => k.endsWith(`:${archived.id}`)), JSON.stringify(allKinds));
ok('B8 🔴 a LEAD gets no supply reminder (the supplies rule, isSupplyBuilding)', !allKinds.some((k) => k.endsWith(`:${lead.id}`)), JSON.stringify(allKinds));
ok('B9 🔴 a VENDOR gets no supply reminder', !allKinds.some((k) => k.endsWith(`:${vendor.id}`)), JSON.stringify(allKinds));
const orphan = { id: 'b_nobody', name: 'Nobody Manages', supervisorId: null };
const orphanKinds = opsAlerts.getDueSupplyAlerts({ clients: [orphan], requests: [], now: NOW, settings: SETTINGS, tz: 'America/New_York' }).map((a) => a.kind);
ok('B10 a building nobody manages, with no budget and nothing in flight, is not a supply building — no reminder blankets the office',
  orphanKinds.length === 0, JSON.stringify(orphanKinds));
const budgetedInactive = { ...inactive, supplyBudgetMonthly: 100 };
const overspend = [{ id: 'p', clientId: inactive.id, status: 'completed', createdAt: '2026-09-02T16:00:00Z', completedAt: '2026-09-05T16:00:00Z', lines: [{ name: 'TP', qty: 3, unitPrice: 41.2 }] }];
const overKinds = opsAlerts.getDueSupplyAlerts({ clients: [budgetedInactive], requests: overspend, now: NOW, settings: SETTINGS, tz: 'America/New_York' }).map((a) => a.kind);
ok('B11 an Inactive building raises no over-budget alert either', !overKinds.includes('supplyBudgetExceeded'), JSON.stringify(overKinds));
ok('B12 the supplies rule agrees: an Archived building is not a supply building',
  supplies.isSupplyBuilding(archived) === false && supplies.isSupplyBuilding(live) === true);

// ── C. the manager Home ──────────────────────────────────────────────────────
const latestRows = BUILDINGS.map((b) => ({ client_id: b.id, performed_at: longAgo }));
const due = managerHome.inspectionsDueCount({ clients: BUILDINGS, latest: latestRows, scope: { mgrId: SUP, clientIds: new Set(BUILDINGS.map((b) => b.id)) }, now: NOW, settings: {} });
// live + lead are the active buildings (vendor and the three inactive / archived are not).
ok('C1 🔴 "Inspections · N due" counts only the active buildings (Inactive, Archived and vendors out)', due === 2, `got ${due}`);

// ── D. the server's twin reads (the REAL handlers, over the loopback fake) ─────
const USERS = [
  { id: SUP, role: 'manager', status: 'active', name: 'Dana Sup', email: 'dana@example.test' },
  { id: 'u_o', role: 'owner', status: 'active', name: 'Owner', email: 'owner@example.test' },
];
const LOGINS = { 'tok-owner': { id: 'auth-u_o', email: 'owner@example.test', app_metadata: { role: 'owner', org_user_id: 'u_o', org_id: ORG } } };
const rec = (id, clientId) => ({
  id, organization_id: ORG, public_token: `tok_${id}`, template_id: 't', template_version_id: 'v', template_snapshot: {},
  client_id: clientId, site_id: `s_${clientId}`, job_id: null, inspector_user_id: SUP, overall_score: 100, result: 'pass',
  status: 'submitted', performed_at: longAgo, created_at: longAgo, updated_at: longAgo,
});
resetWorld({
  tables: {
    org_state: [{
      organization_id: ORG, version: 3,
      state: {
        version: 58,
        company: { id: 'co', name: 'Co', timezone: 'America/New_York' },
        users: USERS, clients: BUILDINGS, sites: BUILDINGS.map((b) => ({ id: `s_${b.id}`, clientId: b.id, name: b.name })),
        permissions: seedPermissions(), userPermissionOverrides: [], notifications: [], opsAlertEvents: [], opsSettings: {},
      },
    }],
    crew_assignments: [{ organization_id: ORG, user_id: '__sync_marker__', site_id: null, client_id: null, source: 'marker' }],
    inspection_records: BUILDINGS.map((b, i) => rec(`r${i}`, b.id)),
    inspection_templates: [], jobs: [], time_entries: [], checklist_results: [], problem_reports: [], work_order_messages: [],
    supply_requests: [], contract_reminders: [], hr_warnings: [],
  },
  logins: LOGINS,
});

async function call(handler, method, subpath, { token = 'tok-owner', query = {} } = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath, ...query };
  req.body = {};
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
      Promise.resolve(handler(req, res)).catch((e) => done('threw', String(e?.message || e)));
    });
  } finally { Object.assign(console, quiet); }
}

const latest = await call(qc, 'GET', 'inspections/latest-by-client');
const latestIds = (latest.body?.inspections || []).map((r) => r.client_id);
ok('D1 latest-by-client answers (control)', latest.status === 200 && latestIds.includes(live.id), `${latest.status} ${JSON.stringify(latest.body)?.slice(0, 200)}`);
ok('D2 🔴 latest-by-client (the reminders\' and the Home\'s read) leaves out a building set Inactive through the menu',
  !latestIds.includes(inactive.id), JSON.stringify(latestIds));
ok('D3 …and an Archived one', !latestIds.includes(archived.id), JSON.stringify(latestIds));

let dry = null;
const quiet = { log: console.log, warn: console.warn, error: console.error };
console.log = console.warn = console.error = () => {};
try { dry = await cron.run(true, { now: NOW, logAuto: async () => [] }); } catch (e) { dry = { threw: String(e?.message || e) }; }
finally { Object.assign(console, quiet); }
const would = Array.isArray(dry?.would) ? dry.would : [];
const wouldFor = (id) => would.filter((w) => w.clientId === id).map((w) => w.kind);
ok('D4 the cron\'s dry run raises the live building\'s inspection reminder (control)', wouldFor(live.id).includes('inspectionDue'), JSON.stringify(dry)?.slice(0, 300));
ok('D5 🔴 the cron raises NOTHING for a building set Inactive through the menu', wouldFor(inactive.id).length === 0, JSON.stringify(wouldFor(inactive.id)));
ok('D6 …nor for an Archived one', wouldFor(archived.id).length === 0, JSON.stringify(wouldFor(archived.id)));
ok('D7 🔴 …nor a supply reminder for a lead or a vendor', wouldFor(lead.id).every((k) => !k.startsWith('supply')) && wouldFor(vendor.id).length === 0,
  JSON.stringify({ lead: wouldFor(lead.id), vendor: wouldFor(vendor.id) }));

console.log(`\n${pass}/${pass + fails.length} active-building checks passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
process.exitCode = fails.length ? 1 : 0;
