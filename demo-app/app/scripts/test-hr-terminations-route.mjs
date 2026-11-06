// /api/hr-terminations/[...path] and the 5-minute run that turns logins off, driven END TO END
// through the REAL handler and the REAL access module against fake-supabase.mjs (no network, no
// credentials, no live project — BUILD_INTEGRITY §6b). Super Clippy's idea #513 from Clean
// Corner's queue, 2026-11-05: Matt's termination form, which ends the person's Clean Corner access.
//
// What it proves, in the order it matters:
//   1. the gates: anonymous → 401; a cleaner reaches nothing (one termination's read answers 404);
//      FILING takes hr.edit AND the Team page's rule for turning a login off (Daniel's pick, "HR
//      and Team editors"): an admin (no hr.edit), a claim-less manager (as live) and a manager
//      whose "Invite / edit team" was revoked are refused; never a Super Admin, never yourself, an
//      Admin only by an Admin or a Super Admin
//   2. what is filed: the employee and the Direct Account Manager are PICKED and proved against the
//      committed roster (an Operations Manager or a Disabled one is refused: "Account Managers
//      only"), their names stamped; one live termination per person (409); a retried id is a no-op
//   3. 🔴 THE LOGIN (Daniel's pick, "On the termination date"): a day that has come turns it off AS
//      IT IS FILED — the Supabase login banned, the roster row Disabled with the moment stamped —
//      and the person is refused at once (account-disabled); a day still ahead leaves it on until
//      the 5-minute run on that day turns it off; GoTrue down at filing answers "pending" and the
//      run finishes it; a run that died half-way is finished by the next; a member already
//      Disabled on Team is left as they are ("already off")
//   4. VOID is the OWNER's alone, with a reason: before the day the login never turns off; after
//      it, the login comes back on, but only when THIS termination turned it off ("kept" when it
//      was changed on Team since)
//   5. LOCKED: no edit route, no delete route; nothing in the activity log
//
//   node app/scripts/test-hr-terminations-route.mjs
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.FORMS_ORG_ID = ORG;
process.env.CLEANSPACE_ORG_ID = ORG;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const { readFileSync } = await import('node:fs');
const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { dayKey, addDaysKey } = await import('../src/lib/dates.js');
let handler = null;
let A = {};
let L = {};
try { handler = (await import('../api/hr-terminations/[...path].js')).default; } catch (e) { fails.push(`the route loads (${e.code || e.message})`); }
try { A = await import('../api/_lib/hrTerminations/access.js'); } catch (e) { fails.push(`the access module loads (${e.code || e.message})`); }
try { L = await import('../src/lib/hrTerminations.js'); } catch { fails.push('lib/hrTerminations.js loads'); }
const { TERMINATION_REASON = {}, ACCESS_STATE = {}, TERMINATION_STATUS = {} } = L;
const { runTerminationAccess = async () => ({}) } = A;

// ── the world ───────────────────────────────────────────────────────────────
const TZ = 'America/New_York';
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  owner2: { id: 'u_owner2', role: 'owner', claim: true },
  admin: { id: 'u_admin', role: 'admin', claim: true },
  am: { id: 'u_am', role: 'manager', claim: true },                          // an Account Manager, claim-backed
  am2: { id: 'u_am2', role: 'manager', claim: true },
  amOff: { id: 'u_am_off', role: 'manager', claim: true, status: 'disabled' },
  om: { id: 'u_om', role: 'manager', claim: true, managerLevel: 'operations' },
  mgrNoClaim: { id: 'u_mgr_nc', role: 'manager', claim: false },             // claim-less, as live
  crew: { id: 'u_crew', role: 'crew', claim: true },
  crew2: { id: 'u_crew2', role: 'crew', claim: true },
  crew3: { id: 'u_crew3', role: 'crew', claim: true },
  crew4: { id: 'u_crew4', role: 'crew', claim: true },
  crew5: { id: 'u_crew5', role: 'crew', claim: true },
  crewOff: { id: 'u_crew_off', role: 'crew', claim: true, status: 'disabled' },
};
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const NAMES = {
  owner: 'Olivia Owner', owner2: 'Otto Owner', admin: 'Adam Admin', am: 'Renata Cruz', am2: 'Nadia Brooks', amOff: 'Gone Manager',
  om: 'Gabriel Ortiz', mgrNoClaim: 'Mia Manager', crew: 'Luis Ferrer', crew2: 'Tomas Rivera', crew3: 'Keisha Bryant',
  crew4: 'Andre Baptiste', crew5: 'Rosa Diaz', crewOff: 'Old Cleaner',
};
const roster = () => Object.entries(PEOPLE).map(([k, p]) => ({
  id: p.id, email: emailOf(k), role: p.role, status: p.status || 'active', name: NAMES[k], notificationPrefs: {},
  ...(p.managerLevel ? { managerLevel: p.managerLevel } : {}),
  ...(p.status === 'disabled' ? { disabledAt: '2026-10-01T12:00:00.000Z' } : {}),
}));
const loginOf = (k, p) => ({ id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {} });
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, loginOf(k, p)]));
const authUsers = Object.entries(PEOPLE).map(([k, p]) => ({ ...loginOf(k, p), banned_until: p.status === 'disabled' ? '2126-01-01T00:00:00.000Z' : null }));

function build({ overrides = [] } = {}) {
  const state = {
    users: roster(), permissions: seedPermissions(), userPermissionOverrides: overrides,
    clients: [], company: { timezone: TZ }, notifications: [],
  };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 4 }],
      hr_terminations: [],
      activity_log: [], activity_log_baseline: [],
    },
    logins,
    authUsers,
  });
  // The table's partial unique index: one FILED termination per person.
  world.uniqueKeys = { hr_terminations: [(r) => (r.status === 'filed' ? `${r.organization_id}|${r.employee_user_id}` : null)] };
  world.authFail = null;
  return state;
}

async function call({ method = 'GET', path, token, body, query = {} }) {
  if (!handler) return { status: 0, body: {} };
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { ...query, subpath: path };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 8000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        setHeader() { return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const quietly = async (fn) => {
  const keep = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try { return await fn(); } finally { Object.assign(console, keep); }
};
const tok = (w) => `tok-${w}`;
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const today = dayKey(new Date(), TZ);
const draft = (extra = {}) => ({
  id: randomUUID(), employeeUserId: 'u_crew', terminationDate: today, managerUserId: 'u_am',
  reasons: [TERMINATION_REASON.resignation, TERMINATION_REASON.anotherJob], reasonOther: '', ...extra,
});
const file = (who, extra) => call({ method: 'POST', path: 'create', token: tok(who), body: draft(extra) });
const member = (id) => (world.tables.org_state[0].state.users || []).find((u) => u.id === id);
const login = (k) => (world.authUsers || []).find((u) => u.email === emailOf(k));
const banned = (k) => { const u = login(k); return !!u?.banned_until && Date.parse(u.banned_until) > Date.now(); };
const row = (id) => (world.tables.hr_terminations || []).find((r) => r.id === id);
const DAY = 864e5;

if (handler && L.TERMINATION_REASON) {
  // ── 1. the gates ──────────────────────────────────────────────────────────
  build();
  let r = await call({ path: 'list' });
  ok('anonymous → 401', r.status === 401, show(r));
  r = await call({ path: 'list', token: tok('crew') });
  ok('a cleaner cannot list terminations', r.status === 403 || r.status === 404, show(r));
  r = await call({ method: 'POST', path: 'create', token: tok('crew'), body: draft({ employeeUserId: 'u_crew2' }) });
  ok('a cleaner cannot file one', r.status === 403, show(r));
  r = await file('admin', { employeeUserId: 'u_crew2' });
  ok('an Admin (no "Edit HR records" by default) cannot file one', r.status === 403, show(r));
  r = await file('mgrNoClaim', { employeeUserId: 'u_crew2' });
  ok('a manager without a claim-backed session is refused (the Team page\'s own login rule)', r.status === 403 && r.body.code === 'not-allowed', show(r));
  ok('…and no login was touched', !banned('crew2') && member('u_crew2').status === 'active');
  r = await file('am', { employeeUserId: 'u_admin' });
  ok('a manager cannot terminate an Admin', r.status === 403 && r.body.code === 'employee-admin', show(r));
  r = await file('am', { employeeUserId: 'u_am', managerUserId: 'u_am2' });
  ok('nobody terminates themselves', r.status === 403 && r.body.code === 'employee-self', show(r));
  r = await file('owner', { employeeUserId: 'u_owner2' });
  ok('never a Super Admin, even by a Super Admin', r.status === 403 && r.body.code === 'employee-owner', show(r));
  ok('…and nothing was filed', (world.tables.hr_terminations || []).length === 0);

  build({ overrides: [{ userId: 'u_am', grants: [], revokes: ['settings.team.edit'] }] });
  r = await file('am', { employeeUserId: 'u_crew2', managerUserId: 'u_am2' });
  ok('a manager whose "Invite / edit team" was revoked cannot file one (HR AND Team editors)', r.status === 403 && r.body.code === 'not-allowed', show(r));
  build({ overrides: [{ userId: 'u_am', grants: [], revokes: ['hr.edit'] }] });
  r = await file('am', { employeeUserId: 'u_crew2', managerUserId: 'u_am2' });
  ok('…nor one whose "Edit HR records" was revoked', r.status === 403, show(r));

  // ── 2. what is filed ──────────────────────────────────────────────────────
  build();
  r = await file('am', { employeeUserId: 'u_crew2', managerUserId: 'u_om' });
  ok('the Direct Account Manager cannot be an Operations Manager (Account Managers only)', r.status === 400 && r.body.code === 'manager-not-account-manager', show(r));
  r = await file('am', { employeeUserId: 'u_crew2', managerUserId: 'u_am_off' });
  ok('…nor a Disabled one', r.status === 400 && r.body.code === 'manager-not-account-manager', show(r));
  r = await file('am', { employeeUserId: 'u_nobody' });
  ok('an employee not on the team is refused', r.status === 400 && r.body.code === 'employee-not-on-team', show(r));
  r = await file('am', { employeeUserId: 'u_crew2', reasons: [] });
  ok('no reason is refused', r.status === 400 && r.body.code === 'reasons-missing', show(r));
  r = await file('am', { employeeUserId: 'u_crew2', reasons: [TERMINATION_REASON.other], reasonOther: '' });
  ok('"Other:" with no words is refused', r.status === 400 && r.body.code === 'reason-other-missing', show(r));
  r = await file('am', { employeeUserId: 'u_crew2', terminationDate: addDaysKey(today, 400) });
  ok('a day more than a year ahead is refused', r.status === 400 && r.body.code === 'date-too-far', show(r));
  ok('…and none of those was filed or touched a login', (world.tables.hr_terminations || []).length === 0 && !banned('crew2'));

  // ── 3. the login: a day that has come turns it off as it is filed ────────
  const now = draft({ employeeUserId: 'u_crew', reasons: [TERMINATION_REASON.other, TERMINATION_REASON.resignation], reasonOther: '  Moved to Ohio  ' });
  r = await call({ method: 'POST', path: 'create', token: tok('am'), body: now });
  const t1 = r.body.termination || {};
  ok('a claim-backed Account Manager files one for today', r.status === 200 && r.body.created === true, show(r));
  ok('its names are stamped from the roster', t1.employeeName === 'Luis Ferrer' && t1.managerName === 'Renata Cruz' && t1.filedByName === 'Renata Cruz' && t1.filedByUserId === 'u_am');
  ok('its reasons are his order, "Other:" with its words', JSON.stringify(t1.reasons) === JSON.stringify([TERMINATION_REASON.resignation, TERMINATION_REASON.other]) && t1.reasonOther === 'Moved to Ohio');
  ok('its day is the org\'s day', t1.terminationDate === today);
  ok('the answer says the login is off', r.body.access === ACCESS_STATE.ended && t1.accessState === ACCESS_STATE.ended && !!t1.accessEndedAt, show(r));
  ok('🔴 the Supabase login is banned', banned('crew'));
  ok('🔴 the roster row reads Disabled, with the moment it went off', member('u_crew').status === 'disabled' && member('u_crew').disabledAt === t1.accessEndedAt);
  ok('…and what it was before is kept, to give back on a void', t1.statusBefore === 'active');
  r = await call({ path: 'list', token: tok('crew') });
  ok('🔴 the person is refused at once (account-disabled)', r.status === 403 && r.body.code === 'account-disabled', show(r));
  r = await call({ method: 'POST', path: 'create', token: tok('am'), body: now });
  ok('a retried filing answers with what is on file, created: false', r.status === 200 && r.body.created === false && r.body.termination.id === now.id, show(r));
  ok('…and files nothing twice', world.tables.hr_terminations.length === 1);
  r = await file('am', { employeeUserId: 'u_crew', managerUserId: 'u_am2' });
  ok('a second termination for someone already terminated is 409', r.status === 409 && r.body.code === 'already-terminated', show(r));
  r = await call({ path: 'list', token: tok('am') });
  ok('the office lists it', r.status === 200 && r.body.terminations.length === 1 && r.body.terminations[0].id === now.id, show(r));
  r = await call({ path: 'list', token: tok('am'), query: { employeeId: 'u_crew2' } });
  ok('one employee\'s list (the HR card) holds only theirs', r.status === 200 && r.body.terminations.length === 0, show(r));
  r = await call({ path: now.id, token: tok('crew2') });
  ok('a cleaner reading one termination gets 404, never 403', r.status === 404, show(r));
  r = await call({ path: now.id, token: tok('am') });
  ok('the office reads one', r.status === 200 && r.body.termination.id === now.id, show(r));

  // A day still ahead: the login stays on until the run on that day.
  const later = draft({ employeeUserId: 'u_crew2', terminationDate: addDaysKey(today, 2) });
  r = await call({ method: 'POST', path: 'create', token: tok('owner'), body: later });
  ok('the Super Admin files one for two days ahead', r.status === 200 && r.body.access === ACCESS_STATE.scheduled, show(r));
  ok('…and the login stays on', !banned('crew2') && member('u_crew2').status === 'active');
  let run = await quietly(() => runTerminationAccess({}));
  ok('today\'s run leaves it on', run.ended === 0 && !banned('crew2') && member('u_crew2').status === 'active', JSON.stringify(run));
  const dry = await quietly(() => runTerminationAccess({ dryRun: true, now: Date.now() + 2 * DAY + 60e3 }));
  ok('a dry run names it on its day and changes nothing', JSON.stringify(dry.wouldEnd) === JSON.stringify([later.id]) && !banned('crew2'), JSON.stringify(dry));
  run = await quietly(() => runTerminationAccess({ now: Date.now() + 2 * DAY + 60e3 }));
  ok('🔴 the run on its day turns the login off', run.ended === 1 && banned('crew2') && member('u_crew2').status === 'disabled', JSON.stringify(run));
  ok('…stamped with the moment, and the row says so', member('u_crew2').disabledAt === row(later.id).access_ended_at && row(later.id).access_state === ACCESS_STATE.ended);
  run = await quietly(() => runTerminationAccess({ now: Date.now() + 2 * DAY + 120e3 }));
  ok('the next run has nothing left to do', run.ended === 0 && run.failed === 0, JSON.stringify(run));

  // GoTrue unreadable: the Team rule can't be judged, so nothing is filed.
  world.authFail = (op) => op === 'listUsers';
  const down = draft({ employeeUserId: 'u_crew3' });
  r = await call({ method: 'POST', path: 'create', token: tok('owner'), body: down });
  ok('with the logins unreadable, the filing is refused and nothing is filed', r.status >= 500 && !row(down.id) && !banned('crew3'), show(r));
  // GoTrue failing the ban at filing: the filing lands, "pending", and the run finishes it.
  world.authFail = (op) => op === 'updateUserById';
  r = await call({ method: 'POST', path: 'create', token: tok('owner'), body: down });
  ok('with the ban failing, the filing still lands, and says the turn-off is pending', r.status === 200 && r.body.created === true && r.body.access === 'pending', show(r));
  ok('…its login is not yet off', !banned('crew3'));
  world.authFail = null;
  run = await quietly(() => runTerminationAccess({}));
  ok('🔴 the next run finishes it', banned('crew3') && member('u_crew3').status === 'disabled' && row(down.id).access_state === ACCESS_STATE.ended, JSON.stringify(run));

  // A run that died half-way (claimed `ending`, nothing else) is finished by the next one.
  const half = draft({ employeeUserId: 'u_crew4', terminationDate: addDaysKey(today, 3) });
  await call({ method: 'POST', path: 'create', token: tok('owner'), body: half });
  const stamp = new Date(Date.now() - 60e3).toISOString();
  Object.assign(row(half.id), { termination_date: today, access_state: ACCESS_STATE.ending, access_ended_at: stamp, status_before: 'active' });
  run = await quietly(() => runTerminationAccess({}));
  ok('a half-finished turn-off is finished, with the moment it began', banned('crew4') && member('u_crew4').disabledAt === stamp && row(half.id).access_state === ACCESS_STATE.ended, JSON.stringify(run));

  // Already Disabled on Team: left as it is.
  const off = draft({ employeeUserId: 'u_crew_off' });
  r = await call({ method: 'POST', path: 'create', token: tok('owner'), body: off });
  ok('a member already Disabled on Team: filed, "already off", their Disabled left as it was', r.status === 200 && r.body.access === ACCESS_STATE.alreadyOff
    && member('u_crew_off').disabledAt === '2026-10-01T12:00:00.000Z', show(r));

  // ── 4. VOID ──────────────────────────────────────────────────────────────
  r = await call({ method: 'POST', path: `${now.id}/void`, token: tok('am'), body: { reason: 'Wrong person' } });
  ok('a manager cannot void', r.status === 403, show(r));
  r = await call({ method: 'POST', path: `${now.id}/void`, token: tok('owner'), body: { reason: '  ' } });
  ok('a void needs a reason', r.status === 400 && r.body.code === 'void-reason-missing', show(r));
  r = await call({ method: 'POST', path: `${now.id}/void`, token: tok('owner'), body: { reason: 'Filed for the wrong person' } });
  ok('the Super Admin voids it', r.status === 200 && r.body.termination.status === TERMINATION_STATUS.voided && r.body.termination.voidReason === 'Filed for the wrong person' && r.body.termination.voidedByName === 'Olivia Owner', show(r));
  ok('🔴 the login it turned off comes back on', r.body.access === ACCESS_STATE.restored && !banned('crew') && member('u_crew').status === 'active' && member('u_crew').disabledAt == null, show(r));
  r = await call({ path: 'list', token: tok('crew') });
  ok('…and the person is let back in', r.status !== 401 && r.body.code !== 'account-disabled', show(r));
  r = await call({ method: 'POST', path: `${now.id}/void`, token: tok('owner'), body: { reason: 'again' } });
  ok('a second void is 409', r.status === 409 && r.body.code === 'already-voided', show(r));
  r = await call({ path: 'list', token: tok('owner') });
  ok('the voided one stays on file', (r.body.terminations || []).some((x) => x.id === now.id && x.status === TERMINATION_STATUS.voided), show(r));
  r = await file('owner', { employeeUserId: 'u_crew', managerUserId: 'u_am2', terminationDate: addDaysKey(today, 1) });
  ok('once voided, a new one can be filed for the person', r.status === 200 && r.body.created === true, show(r));

  // Voided before the day: the login never turns off.
  const before = draft({ employeeUserId: 'u_crew5', terminationDate: addDaysKey(today, 5) });
  await call({ method: 'POST', path: 'create', token: tok('owner'), body: before });
  r = await call({ method: 'POST', path: `${before.id}/void`, token: tok('owner'), body: { reason: 'Changed our mind' } });
  ok('voided before the day: the answer says it never turned off', r.status === 200 && r.body.access === ACCESS_STATE.scheduled, show(r));
  run = await quietly(() => runTerminationAccess({ now: Date.now() + 6 * DAY }));
  ok('🔴 …and the run on that day leaves the login on', !banned('crew5') && member('u_crew5').status === 'active', JSON.stringify(run));

  // Changed on Team since: kept as it is.
  const st = world.tables.org_state[0];
  st.state = { ...st.state, users: st.state.users.map((u) => (u.id === 'u_crew2' ? { ...u, status: 'active', disabledAt: null } : u)) };
  st.version += 1;
  login('crew2').banned_until = null;
  r = await call({ method: 'POST', path: `${later.id}/void`, token: tok('owner'), body: { reason: 'Re-hired' } });
  ok('a login turned back on on Team since: the void leaves it as it is ("kept")', r.status === 200 && r.body.access === ACCESS_STATE.kept && member('u_crew2').status === 'active', show(r));
  st.state = { ...st.state, users: st.state.users.map((u) => (u.id === 'u_crew3' ? { ...u, disabledAt: '2026-12-01T00:00:00.000Z' } : u)) };
  st.version += 1;
  r = await call({ method: 'POST', path: `${down.id}/void`, token: tok('owner'), body: { reason: 'Mistake' } });
  ok('a login Disabled again on Team since: the void leaves it off', r.status === 200 && r.body.access === ACCESS_STATE.kept && member('u_crew3').status === 'disabled' && banned('crew3'), show(r));

  // ── 5. locked ────────────────────────────────────────────────────────────
  r = await call({ method: 'POST', path: `${half.id}/edit`, token: tok('owner'), body: { terminationDate: today } });
  ok('there is no edit route', r.status === 404, show(r));
  r = await call({ method: 'DELETE', path: half.id, token: tok('owner') });
  ok('there is no delete route', r.status === 405 || r.status === 404, show(r));
  ok('nothing went to the activity log', (world.tables.activity_log || []).length === 0);
}

// The cron runs it every 5 minutes, beside the ops alerts, and reports it.
const cron = (() => { try { return readFileSync(new URL('../api/cron/ops-alerts.js', import.meta.url), 'utf8'); } catch { return ''; } })();
ok('the ops-alerts cron runs the turn-off step', /import \{ runTerminationAccess \} from '\.\.\/_lib\/hrTerminations\/access\.js'/.test(cron) && /await runTerminationAccess\(\{ dryRun \}\)/.test(cron));
const vercel = (() => { try { return JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')); } catch { return {}; } })();
ok('the route has its vercel.json rewrite', (vercel.rewrites || []).some((x) => x.source === '/api/hr-terminations/:rest*' && x.destination === '/api/hr-terminations/_?subpath=:rest*'));
ok('the ops-alerts cron runs every 5 minutes', (vercel.crons || []).some((c) => c.path === '/api/cron/ops-alerts' && c.schedule === '*/5 * * * *'));

if (fails.length) {
  console.error(`test-hr-terminations-route: ${pass} passed, ${fails.length} FAILED`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-hr-terminations-route: ${pass} passed, 0 failed`);
