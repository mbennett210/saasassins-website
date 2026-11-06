// Task #507 (Clean Corner's queue) — a building's SPECIAL SERVICES and their reminders (UI_RULES
// §192). Offline.
//
// Matt, "clean corner" (2026-11-03, 10:46 AM PT): "a section to track recurring special services at
// each location … Type of special service, Frequency (monthly, quarterly, semi-annually, annually,
// etc.), Next scheduled service date", and "The system should automatically notify both the Account
// Manager and Operations Manager when the next special service is coming up." Daniel's answers
// (2026-11-04), each pinned below:
//   1. the reminders are built too: a bell and a phone alert to the building's Account Manager and
//      that manager's Operations Manager, 14 days before the next date, during office hours, on the
//      ops-alert run, once per date;
//   2. a 7th part on the onboarding bar, green once a service is entered or the building is marked
//      as having none;
//   3. the frequencies: Monthly, Every 2 months, Quarterly, Semi-annually, Annually, Every 2 years,
//      and Every … months (1 to 36);
//   4. Mark done moves the next date one frequency after the SCHEDULED date (Jan 15 quarterly →
//      Apr 15); a date that has passed reads Overdue.
//
//   §1  the rule (lib/specialServices): frequencies, the form's problems, the stored row, Mark
//       done's date (month ends, a date far past), the due states at their edges, the suggestions
//   §2  the store (the real reducer): add, change, remove, the cap, Mark done once however often
//       it's pressed, "none at this building" and its undo, two people's adds both landing on
//       replay, the onboarding step reading it
//   §3  the reminder (lib/specialServiceReminders): office hours, the 14 days, once per date, a new
//       date after Mark done, who hears (the AM and their OM; an OM's own building; no manager →
//       the Super Admins), archived / inactive / vendor buildings left out, the run's cap, the words
//   §4  the whole raise through the cron's run() and its REAL computeDue (scripts/fake-supabase),
//       the apply step's marker kept past the 48-hour horizon while the service exists and dropped
//       once it's removed, the bell rows and the log
//   §5  the screens and the catalog: the card on the Overview, the bar's part, every word a
//       catalog line, the switch in Account → Notifications, the bell's icon
//
// REGRESSION (THE LAW II.3): on aa3c72f4 (the tree before this change) lib/specialServices.js and
// lib/specialServiceReminders.js don't exist, so §1–§4 fail at their first check and §5 finds no
// card, no part and no catalog lines.
//
//   node app/scripts/test-special-services.mjs
//
// ok(label, cond, detail) — the CONDITION is second in this file.
import { readFileSync } from 'node:fs';
import { loadStore } from './deletion-core.mjs';
import { installFakeSupabase, resetWorld } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000507';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const read = (rel) => { try { return readFileSync(new URL(rel, import.meta.url), 'utf8'); } catch { return ''; } };
const soft = async (rel) => { try { return await import(rel); } catch (e) { fails.push(`${rel} loads (${e.message.split('\n')[0]})`); return {}; } };

const S = await soft('../src/lib/specialServices.js');
const R = await soft('../src/lib/specialServiceReminders.js');
const OB = await soft('../src/lib/onboarding.js');
const { applyOpsAlert } = await soft('../src/lib/opsAlertApply.js');
const { english } = await soft('../src/i18n/core.js');
const { NOTIFICATION_GROUPS } = await soft('../src/lib/notifications.js');
const { EVENT_META } = await soft('../src/lib/notificationMeta.js');
const { seedPermissions } = await soft('../src/lib/roles.js');
const { run } = await soft('../api/cron/ops-alerts.js');
const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
const has = typeof S.nextDateAfterDone === 'function' && typeof R.getDueSpecialServiceAlerts === 'function';
ok('the rule and the reminder load', has);

const TZ = 'America/New_York';
// Wednesday 2026-11-04, 10:00 AM in New York (EST): inside the default office hours (Mon–Fri 8–5).
const NOW = Date.parse('2026-11-04T15:00:00.000Z');
const TODAY = '2026-11-04';
const DAY = 86400000;
const row = (id, type, months, nextDate, extra = {}) => ({ id, type, months, nextDate, lastDoneOn: null, lastDoneBy: null, createdAt: null, createdBy: null, ...extra });

// ── §1 the rule ─────────────────────────────────────────────────────────────────────────────
if (has) {
  ok('§1 the frequency menu, in Daniel\'s order, then Every … months',
    JSON.stringify(S.FREQUENCY_KEYS) === JSON.stringify(['monthly', 'bimonthly', 'quarterly', 'semiannual', 'annual', 'biennial', 'custom'])
    && JSON.stringify(S.FREQUENCY_PRESETS.map((p) => p.months)) === JSON.stringify([1, 2, 3, 6, 12, 24]));
  ok('§1 a preset is its months; Every … months takes 1 to 36 only',
    S.monthsFromChoice('quarterly') === 3 && S.monthsFromChoice('custom', '4') === 4 && S.monthsFromChoice('custom', 36) === 36
    && S.monthsFromChoice('custom', '0') === null && S.monthsFromChoice('custom', '37') === null && S.monthsFromChoice('custom', '2.5') === null
    && S.monthsFromChoice('weekly') === null);
  ok('§1 a stored number reads its preset\'s name, or "Every N months"',
    S.frequencyLabel(6).key === 'specialSvc.freq.semiannual' && S.frequencyLabel(4).key === 'specialSvc.freq.every' && S.frequencyLabel(4).params.count === 4
    && S.frequencyKeyOf(3) === 'quarterly' && S.frequencyKeyOf(5) === 'custom');
  ok('§1 the form needs all three fields',
    JSON.stringify(S.specialServiceProblems({ type: ' ', frequency: 'custom', customMonths: '', nextDate: '2026-02-30' }))
    === JSON.stringify(['specialSvc.err.type', 'specialSvc.err.months', 'specialSvc.err.date'])
    && S.specialServiceProblems({ type: 'Carpet cleaning', frequency: 'quarterly', nextDate: '2027-01-15' }).length === 0);
  const made = S.specialServiceRow({ type: '  Carpet   cleaning ', frequency: 'quarterly', nextDate: '2027-01-15' }, { id: 'ss1', at: 'T', by: 'u1' });
  ok('§1 a new row: the type tidied, the months, the date, who made it', made && made.id === 'ss1' && made.type === 'Carpet cleaning' && made.months === 3 && made.nextDate === '2027-01-15' && made.createdBy === 'u1' && made.lastDoneOn === null, JSON.stringify(made));
  const changed = S.specialServiceRow({ type: 'Carpet shampoo', frequency: 'custom', customMonths: '4', nextDate: '2027-02-01' }, { prev: { ...made, lastDoneOn: '2026-10-15', lastDoneBy: 'u2' }, id: 'other' });
  ok('§1 a changed row keeps its id, who made it and its last-done day', changed.id === 'ss1' && changed.months === 4 && changed.lastDoneOn === '2026-10-15' && changed.createdBy === 'u1');
  ok('§1 the type is capped', S.specialServiceRow({ type: 'x'.repeat(200), frequency: 'annual', nextDate: '2027-01-15' }, { id: 'ss9' }).type.length === S.SPECIAL_SERVICE_TYPE_MAX);

  ok('§1 Mark done: Jan 15 quarterly → Apr 15 (one frequency after the SCHEDULED date)', S.nextDateAfterDone(row('a', 'Carpet', 3, '2027-01-15'), '2027-01-20') === '2027-04-15');
  ok('§1 … done early, it still moves one frequency on', S.nextDateAfterDone(row('a', 'Carpet', 3, '2027-01-15'), '2027-01-02') === '2027-04-15');
  ok('§1 … strip and wax every six months: Mar 31 → Sep 30', S.nextDateAfterDone(row('a', 'Strip and wax', 6, '2027-03-31'), '2027-03-31') === '2027-09-30');
  ok('§1 … long overdue, it lands after the day it was done, never in the past', S.nextDateAfterDone(row('a', 'Carpet', 3, '2026-01-15'), '2026-11-04') === '2027-01-15');
  ok('§1 … each step counts from the scheduled day, so a month-end service stays at the month end',
    S.nextDateAfterDone(row('a', 'Windows', 1, '2027-01-31'), '2027-03-05') === '2027-03-31');
  ok('§1 the due states at their edges (14 days ahead is Due soon, 15 is not, yesterday is Overdue)',
    S.dueState(row('a', 'x', 3, '2026-11-03'), TODAY) === 'overdue' && S.dueState(row('a', 'x', 3, TODAY), TODAY) === 'soon'
    && S.dueState(row('a', 'x', 3, '2026-11-18'), TODAY) === 'soon' && S.dueState(row('a', 'x', 3, '2026-11-19'), TODAY) === 'later'
    && S.SPECIAL_SERVICE_LEAD_DAYS === 14);
  ok('§1 a damaged row is never shown', S.specialServicesOf({ specialServices: [row('a', '', 3, TODAY), row('b', 'x', 0, TODAY), row('c', 'x', 3, '2026-13-01'), null, row('d', 'Ok', 3, TODAY)] }).map((s) => s.id).join() === 'd');
  ok('§1 soonest first', S.specialServicesOf({ specialServices: [row('a', 'B', 3, '2027-02-01'), row('b', 'A', 3, '2026-12-01')] }).map((s) => s.id).join() === 'b,a');
  ok('§1 the suggestions: the types in use, most used first, one per spelling',
    JSON.stringify(S.knownServiceTypes([{ specialServices: [row('a', 'Strip and wax', 6, TODAY)] }, { specialServices: [row('b', 'Carpet cleaning', 3, TODAY), row('c', 'strip and wax', 6, TODAY)] }])) === JSON.stringify(['Strip and wax', 'Carpet cleaning']));
  ok('§1 … and at most SPECIAL_SERVICE_SUGGESTIONS_MAX of them, however many one-off names the book holds',
    S.knownServiceTypes(Array.from({ length: 50 }, (_, i) => ({ specialServices: [row('x' + i, 'Type ' + i, 3, TODAY)] }))).length === S.SPECIAL_SERVICE_SUGGESTIONS_MAX
    && S.SPECIAL_SERVICE_SUGGESTIONS_MAX === 30);
}

// ── §2 the store ────────────────────────────────────────────────────────────────────────────
if (has) {
  const client = { id: 'cl_ss', name: 'Bayshore Senior Living', type: 'customer', supervisorId: null };
  let s = reducer(INITIAL_STATE, { type: ACTIONS.ADD_CLIENT, client });
  const get = (st) => st.clients.find((c) => c.id === 'cl_ss');
  const carpet = S.specialServiceRow({ type: 'Carpet cleaning', frequency: 'quarterly', nextDate: '2027-01-15' }, { id: 'ss_carpet' });
  const wax = S.specialServiceRow({ type: 'Strip and wax', frequency: 'semiannual', nextDate: '2027-03-31' }, { id: 'ss_wax' });

  s = reducer(s, { type: ACTIONS.SET_NO_SPECIAL_SERVICES, clientId: 'cl_ss', none: true, at: 'T', by: 'u1' });
  ok('§2 "None at this building" is stored, and settles the onboarding step', !!get(s).noSpecialServices && S.specialServicesSettled(get(s)) && OB.onboardingFacts({ client: get(s) }).special === true);
  s = reducer(s, { type: ACTIONS.SET_NO_SPECIAL_SERVICES, clientId: 'cl_ss', none: false });
  ok('§2 … and its Undo opens the step again', !get(s).noSpecialServices && OB.onboardingFacts({ client: get(s) }).special === false);
  s = reducer(s, { type: ACTIONS.SET_NO_SPECIAL_SERVICES, clientId: 'cl_ss', none: true });
  s = reducer(s, { type: ACTIONS.SAVE_SPECIAL_SERVICE, clientId: 'cl_ss', service: carpet });
  ok('§2 adding a service clears "none" and settles the step', get(s).specialServices.length === 1 && get(s).noSpecialServices === null && OB.onboardingFacts({ client: get(s) }).special === true);
  const before = s;
  ok('§2 "none" is refused while a service is entered', reducer(s, { type: ACTIONS.SET_NO_SPECIAL_SERVICES, clientId: 'cl_ss', none: true }) === before);
  s = reducer(s, { type: ACTIONS.SAVE_SPECIAL_SERVICE, clientId: 'cl_ss', service: { ...carpet, nextDate: '2027-01-20' } });
  ok('§2 saving the same id changes it in place', get(s).specialServices.length === 1 && get(s).specialServices[0].nextDate === '2027-01-20');
  ok('§2 a damaged row is refused (no-op)', reducer(s, { type: ACTIONS.SAVE_SPECIAL_SERVICE, clientId: 'cl_ss', service: { ...wax, months: 99 } }) === s);
  ok('§2 an unknown building is a no-op', reducer(s, { type: ACTIONS.SAVE_SPECIAL_SERVICE, clientId: 'cl_nope', service: wax }) === s);

  // Two people add a service to the same building at once: the sync replays the pending action on
  // the newer copy (store/sync), so both land.
  const mine = reducer(s, { type: ACTIONS.SAVE_SPECIAL_SERVICE, clientId: 'cl_ss', service: wax });
  const theirs = S.specialServiceRow({ type: 'Window cleaning', frequency: 'monthly', nextDate: '2026-12-01' }, { id: 'ss_win' });
  const remote = reducer(s, { type: ACTIONS.SAVE_SPECIAL_SERVICE, clientId: 'cl_ss', service: theirs });
  const replayed = reducer(remote, { type: ACTIONS.SAVE_SPECIAL_SERVICE, clientId: 'cl_ss', service: wax });
  ok('§2 two people\'s adds both land on replay', mine && get(replayed).specialServices.map((x) => x.id).sort().join() === 'ss_carpet,ss_wax,ss_win');
  s = replayed;

  const done1 = reducer(s, { type: ACTIONS.MARK_SPECIAL_SERVICE_DONE, clientId: 'cl_ss', serviceId: 'ss_carpet', fromDate: '2027-01-20', doneOn: '2027-01-21', by: 'u1' });
  const c1 = get(done1).specialServices.find((x) => x.id === 'ss_carpet');
  ok('§2 Mark done: the next date moves on, the day and who are kept', c1.nextDate === '2027-04-20' && c1.lastDoneOn === '2027-01-21' && c1.lastDoneBy === 'u1', JSON.stringify(c1));
  ok('§2 Mark done twice (or replayed after a teammate\'s) moves it on once',
    reducer(done1, { type: ACTIONS.MARK_SPECIAL_SERVICE_DONE, clientId: 'cl_ss', serviceId: 'ss_carpet', fromDate: '2027-01-20', doneOn: '2027-01-21', by: 'u2' }) === done1);
  s = reducer(done1, { type: ACTIONS.REMOVE_SPECIAL_SERVICE, clientId: 'cl_ss', serviceId: 'ss_win' });
  ok('§2 Remove takes only that service', get(s).specialServices.map((x) => x.id).sort().join() === 'ss_carpet,ss_wax');
  ok('§2 removing one that is gone is a no-op', reducer(s, { type: ACTIONS.REMOVE_SPECIAL_SERVICE, clientId: 'cl_ss', serviceId: 'ss_win' }) === s);
  let full = { ...get(s), specialServices: Array.from({ length: S.SPECIAL_SERVICES_MAX }, (_, i) => row(`f${i}`, `Service ${i}`, 12, '2027-06-01')) };
  ok('§2 a building holds at most SPECIAL_SERVICES_MAX (the shared record carries them)', S.withServiceSaved(full, row('one-more', 'More', 12, '2027-06-01')) === null && !!S.withServiceSaved(full, { ...full.specialServices[0], type: 'Renamed' }));
  full = null;

  const steps = OB.onboardingSteps({ ...get(s), onboarding: OB.newOnboarding({ at: 'T' }) }, OB.onboardingFacts({ client: get(s) }));
  ok('§2 the onboarding bar\'s 7th part reads the services', steps.length === 7 && steps[6].step === 'special' && steps[6].state === 'done' && steps[6].canSkip === true);
  ok('§2 an existing customer without the fields is untouched (no version bump needed)', S.specialServicesOf({}).length === 0 && !S.hasNoSpecialServices({}) && !S.specialServicesSettled({}));
}

// ── §3 the reminder ──────────────────────────────────────────────────────────────────────────
const users = () => ([
  { id: 'u_owner', role: 'owner', status: 'active', name: 'Matt Owner', notificationPrefs: {} },
  { id: 'u_owner2', role: 'owner', status: 'disabled', name: 'Old Owner', notificationPrefs: {} },
  { id: 'u_admin', role: 'admin', status: 'active', name: 'Ada Admin', notificationPrefs: {} },
  { id: 'u_om', role: 'manager', managerLevel: 'operations', status: 'active', name: 'Olga Ops', notificationPrefs: {} },
  { id: 'u_am', role: 'manager', managerLevel: 'account', opsManagerId: 'u_om', status: 'active', name: 'Ana Manager', notificationPrefs: {} },
  { id: 'u_am_solo', role: 'manager', status: 'active', name: 'Sol Manager', notificationPrefs: {} },
  { id: 'u_crew', role: 'crew', status: 'active', name: 'Cleo Crew', notificationPrefs: {} },
]);
const svc = (id, type, months, nextDate) => row(id, type, months, nextDate);
const baseState = (over = {}) => ({
  company: { id: 'co', timezone: TZ },
  users: users(),
  clients: [
    { id: 'cl_a', name: 'Alpha Tower', supervisorId: 'u_am', specialServices: [svc('s_carpet', 'Carpet cleaning', 3, '2026-11-18'), svc('s_far', 'Pressure washing', 12, '2026-11-19')] },
    { id: 'cl_b', name: 'Bravo Plaza', supervisorId: 'u_om', specialServices: [svc('s_wax', 'Strip and wax', 6, '2026-10-01')] },
    { id: 'cl_c', name: 'Charlie Court', supervisorId: null, specialServices: [svc('s_win', 'Window cleaning', 1, TODAY)] },
    { id: 'cl_d', name: 'Delta Lofts', supervisorId: 'u_am_solo', specialServices: [svc('s_tile', 'Tile and grout', 6, '2026-11-10')] },
    { id: 'cl_arch', name: 'Archived Arms', statusOverride: 'archived', supervisorId: 'u_am', specialServices: [svc('s_x1', 'Carpet cleaning', 3, TODAY)] },
    { id: 'cl_inact', name: 'Inactive Inn', statusOverride: 'inactive', supervisorId: 'u_am', specialServices: [svc('s_x2', 'Carpet cleaning', 3, TODAY)] },
    { id: 'cl_vend', name: 'Vendor Co', type: 'vendor', specialServices: [svc('s_x3', 'Carpet cleaning', 3, TODAY)] },
  ],
  sites: [], timeOff: [],
  permissions: seedPermissions ? seedPermissions() : {}, userPermissionOverrides: [],
  notifications: [], opsAlertEvents: [], opsSettings: {},
  ...over,
});

if (has) {
  const due = R.getDueSpecialServiceAlerts({ state: baseState(), now: NOW });
  const ids = due.map((a) => a.id);
  ok('§3 due: inside 14 days, today, and past dates; the 15th day out is not', ids.length === 4
    && ids.includes(R.specialServiceAlertId('cl_a', 's_carpet', '2026-11-18')) && !ids.some((x) => x.includes('s_far')), JSON.stringify(ids));
  ok('§3 archived, inactive and vendor buildings are left out', !ids.some((x) => /s_x[123]/.test(x)));
  ok('§3 soonest first (the overdue one leads)', ids[0].includes('s_wax'));
  const by = Object.fromEntries(due.map((a) => [a.refId, a]));
  ok('§3 the AM and the OM they report to', JSON.stringify(by['cl_a:s_carpet'].userIds) === JSON.stringify(['u_am', 'u_om']));
  ok('§3 an OM\'s own building: the OM alone', JSON.stringify(by['cl_b:s_wax'].userIds) === JSON.stringify(['u_om']));
  ok('§3 an AM with no OM: the AM alone', JSON.stringify(by['cl_d:s_tile'].userIds) === JSON.stringify(['u_am_solo']));
  ok('§3 no manager on the building: the active Super Admins, so it never goes to nobody', JSON.stringify(by['cl_c:s_win'].userIds) === JSON.stringify(['u_owner']));
  const a = by['cl_a:s_carpet'];
  ok('§3 the alert: the users scope, its event, the customer page', a.kind === 'specialServiceDue' && a.eventKey === 'specialServiceDue' && a.recipientScope === 'users' && a.url === '/clients/cl_a' && a.clientId === 'cl_a');
  ok('§3 the words: "Carpet cleaning at Alpha Tower", "Scheduled for Nov 18 (Quarterly)…"',
    english(a.title.$t, a.title.p) === 'Carpet cleaning at Alpha Tower'
    && english(a.body.$t, a.body.p) === 'Scheduled for Nov 18 (Quarterly). Time to coordinate the work.',
    `${english(a.title.$t, a.title.p)} | ${english(a.body.$t, a.body.p)}`);
  const w = by['cl_b:s_wax'];
  ok('§3 a date already past says so', english(w.body.$t, w.body.p) === 'It was due Oct 1 (Semi-annually). Mark it done on the customer’s page once it’s done.', english(w.body.$t, w.body.p));
  ok('§3 a custom frequency reads its months', english(R.specialServiceCopy({ client: { name: 'X' }, service: svc('q', 'Vents', 4, '2026-11-10'), today: TODAY }).body.$t, R.specialServiceCopy({ client: { name: 'X' }, service: svc('q', 'Vents', 4, '2026-11-10'), today: TODAY }).body.p).includes('(Every 4 months)'));

  ok('§3 outside office hours: nothing (it waits for the office to open)',
    R.getDueSpecialServiceAlerts({ state: baseState(), now: Date.parse('2026-11-04T23:30:00.000Z') }).length === 0
    && R.getDueSpecialServiceAlerts({ state: baseState(), now: Date.parse('2026-11-07T15:00:00.000Z') }).length === 0);
  ok('§3 once per date: an id already raised is not due again', R.getDueSpecialServiceAlerts({ state: baseState(), now: NOW, firedIds: new Set(ids) }).length === 0);
  const movedOn = baseState();
  movedOn.clients[0].specialServices[0] = { ...movedOn.clients[0].specialServices[0], nextDate: '2027-02-18' };
  ok('§3 after Mark done the new date is not due until it comes up', !R.getDueSpecialServiceAlerts({ state: movedOn, now: NOW, firedIds: new Set(ids) }).length
    && R.getDueSpecialServiceAlerts({ state: movedOn, now: Date.parse('2027-02-04T15:00:00.000Z'), firedIds: new Set(ids) }).some((x) => x.id === R.specialServiceAlertId('cl_a', 's_carpet', '2027-02-18')));
  const many = baseState({ clients: [{ id: 'cl_m', name: 'Many', supervisorId: 'u_am', specialServices: Array.from({ length: 40 }, (_, i) => svc(`m${i}`, `S${i}`, 3, TODAY)) },
    { id: 'cl_n', name: 'More', supervisorId: 'u_am', specialServices: Array.from({ length: 40 }, (_, i) => svc(`n${i}`, `S${i}`, 3, TODAY)) }] });
  ok('§3 a run tells at most SPECIAL_SERVICE_MAX_PER_RUN (the rest the next runs)', R.getDueSpecialServiceAlerts({ state: many, now: NOW }).length === R.SPECIAL_SERVICE_MAX_PER_RUN);
}

// ── §4 the whole raise through the cron's run(), with its real computeDue ────────────────────
if (has && typeof run === 'function') {
  const ref = { current: baseState(), version: 1 };
  const logged = [];
  const mk = (over = {}) => ({
    now: NOW,
    readState: async () => ({ state: structuredClone(ref.current), version: ref.version }),
    writeState: async (next, version) => { if (version !== ref.version) return false; ref.current = structuredClone(next); ref.version += 1; return true; },
    dispatch: async () => ({ claimed: 0, sent: 0 }),
    pushReady: () => true,
    pushToUser: async () => { throw new Error('a special-service reminder never pushes to a userId directly'); },
    logAuto: async (rows) => { logged.push(...rows); return rows; },
    report: () => {},
    ...over,
  });
  resetWorld({ tables: {} });
  const out = await run(false, mk());
  const after = ref.current;
  const rows = (uid) => after.notifications.filter((n) => n.userId === uid && n.eventKey === 'specialServiceDue');
  // The real run raises the rest of its walkers too (the month's supply-order reminders here).
  const svcLogged = () => logged.filter((r) => r.after.kind === 'specialServiceDue');
  ok('§4 run (the real computeDue): the four due services raised', svcLogged().length === 4 && after.opsAlertEvents.filter((e) => e.kind === 'specialServiceDue').length === 4, JSON.stringify(out));
  ok('§4 the AM\'s and the OM\'s bells', rows('u_am').length === 1 && rows('u_om').length === 2 && rows('u_am')[0].title === 'Carpet cleaning at Alpha Tower' && rows('u_am')[0].url === '/clients/cl_a',
    JSON.stringify(after.notifications.map((n) => [n.userId, n.title])));
  ok('§4 nobody else is rung (the Admin, the crew)', rows('u_admin').length === 0 && rows('u_crew').length === 0);
  ok('§4 the log: one alert.sent row each, in English', svcLogged().length === 4 && svcLogged().every((r) => r.action === 'alert.sent' && r.auto === true)
    && svcLogged().some((r) => r.summary === 'Carpet cleaning at Alpha Tower — Scheduled for Nov 18 (Quarterly). Time to coordinate the work.'), JSON.stringify(logged.map((r) => r.summary)));
  const v = ref.version;
  const again = await run(false, mk({ now: NOW + 5 * 60000 }));
  ok('§4 the next tick raises nothing and writes nothing', again.raised === 0 && ref.version === v, JSON.stringify(again));
  logged.length = 0;
  await run(false, mk({ now: NOW + 7 * DAY }));
  ok('§4 a week on (past the 48-hour marker horizon): the same dates are not told again; Pressure washing (Nov 19) now is',
    JSON.stringify(svcLogged().map((r) => r.summary.split(' — ')[0])) === JSON.stringify(['Pressure washing at Alpha Tower']), JSON.stringify(svcLogged().map((r) => r.summary)));
  const markers = ref.current.opsAlertEvents.filter((e) => e.kind === 'specialServiceDue');
  ok('§4 one marker per service told, keyed by building:service', markers.length === 5 && markers.every((e) => e.refId && e.refId.includes(':')));

  // A marker of a service that's been removed goes with it; the others stay.
  const removed = structuredClone(ref.current);
  removed.clients.find((c) => c.id === 'cl_c').specialServices = [];
  const applied = applyOpsAlert(removed, { id: 'oa_probe', kind: 'shiftMissed', recipientScope: 'users', userIds: [], title: 't', body: 'b', url: '/' }, { now: NOW + 7 * DAY });
  const kept = applied.opsAlertEvents.filter((e) => e.kind === 'specialServiceDue').map((e) => e.refId).sort();
  ok('§4 a removed service\'s marker is dropped; the rest are kept past the horizon', JSON.stringify(kept) === JSON.stringify(['cl_a:s_carpet', 'cl_a:s_far', 'cl_b:s_wax', 'cl_d:s_tile']), JSON.stringify(kept));
  // Mark done → the new date's alert supersedes the old marker (newest per service).
  const moved = structuredClone(ref.current);
  moved.clients.find((c) => c.id === 'cl_a').specialServices[0].nextDate = '2026-11-19';
  const due2 = R.getDueSpecialServiceAlerts({ state: moved, now: NOW + DAY, firedIds: new Set(moved.opsAlertEvents.map((e) => e.id)) });
  ok('§4 a moved date is told again', due2.length === 1 && !!due2[0] && due2[0].id === R.specialServiceAlertId('cl_a', 's_carpet', '2026-11-19'), JSON.stringify(due2.map((x) => x.id)));
  const ap2 = due2[0] ? applyOpsAlert(moved, due2[0], { now: NOW + DAY }) : null;
  ok('§4 … and its marker supersedes the old one (one per service)', !!ap2 && ap2.opsAlertEvents.filter((e) => e.refId === 'cl_a:s_carpet').length === 1);
  const muted = baseState();
  muted.users.find((u) => u.id === 'u_am').notificationPrefs = { specialServiceDue: false };
  const ap3 = applyOpsAlert(muted, R.getDueSpecialServiceAlerts({ state: muted, now: NOW }).find((x) => x.refId === 'cl_a:s_carpet'), { now: NOW }) || { notifications: [] };
  ok('§4 an AM who turned the switch off gets nothing; their OM still does',
    !ap3.notifications.some((n) => n.userId === 'u_am') && ap3.notifications.some((n) => n.userId === 'u_om'), JSON.stringify(ap3.notifications.map((n) => n.userId)));
}

// ── §5 the screens and the catalog ──────────────────────────────────────────────────────────
const en = read('../src/i18n/catalog/en.js');
const card = read('../src/components/SpecialServicesCard.jsx');
const modal = read('../src/components/SpecialServiceModal.jsx');
const bar = read('../src/components/OnboardingBar.jsx');
const page = read('../src/pages/ClientDetail.jsx');
const css = read('../src/index.css');
const cron = read('../api/cron/ops-alerts.js');
ok('§5 the card sits on the Overview, under Service setup, gated on clients.edit',
  /<ServiceSetupCard[^>]*\/>\s*\{\/\*[\s\S]*?\*\/\}\s*<SpecialServicesCard client=\{client\} canEdit=\{canEdit\} \/>/.test(page) && /const canEdit = usePermission\('clients\.edit'\)/.test(page));
ok('§5 the bar has the Special services part, with Add and None at this building', /step === 'special'/.test(bar) && /SET_NO_SPECIAL_SERVICES/.test(bar) && /<SpecialServiceModal/.test(bar));
ok('§5 seven parts in a row on a computer, three to a row on a phone (four cut "Documents" at 375px)', /\.onb-bar \{[^}]*repeat\(7, minmax\(0, 1fr\)\)/.test(css) && /@media \(max-width: 640px\) \{\s*\.onb-bar \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/.test(css));
ok('§5 a service\'s row stacks by the CARD\'s width (a container query), so the Overview\'s narrow side column on a computer never squeezes the words beside the buttons',
  /\.spsvc \{ container: spsvc \/ inline-size; \}/.test(css) && /@container spsvc \(max-width: 520px\) \{\s*\.spsvc-row \{ flex-direction: column;/.test(css));
ok('§5 the cron runs the walker in computeDue, in its own try', /alerts\.push\(\.\.\.getDueSpecialServiceAlerts\(/.test(cron) && /import \{ getDueSpecialServiceAlerts \} from '\.\.\/\.\.\/src\/lib\/specialServiceReminders\.js'/.test(cron));
const keysIn = (src) => [...src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
const libKeys = [...read('../src/lib/specialServices.js').matchAll(/'(specialSvc\.[a-zA-Z0-9_.]+)'/g), ...read('../src/lib/specialServiceReminders.js').matchAll(/'(alerts\.specialSvc\.[a-zA-Z0-9_.]+)'/g)].map((m) => m[1]);
const used = [...new Set([...keysIn(card), ...keysIn(modal), ...libKeys, ...['onboarding.seg.special', 'onboarding.step.special', 'onboarding.special.todo', 'onboarding.special.done', 'onboarding.special.none', 'onboarding.special.more', 'onboarding.action.special', 'onboarding.action.specialNone']])];
const missing = used.filter((k) => !en.includes(`'${k}':`));
ok('§5 every word the card, the pop-ups, the bar and the alert use is a catalog line', used.length > 40 && missing.length === 0, missing.join(', '));
ok('§5 no English literal between tags in the card or the pop-up', ![card, modal].some((src) => />\s*[A-Z][a-z]+( [a-z]+)*\s*</.test(src)));
const item = (NOTIFICATION_GROUPS || []).flatMap((g) => g.items).find((i) => i.key === 'specialServiceDue');
ok('§5 the switch in Account → Notifications (office tiers, who can open customers)', !!item && JSON.stringify(item.roleAllowlist) === JSON.stringify(['owner', 'admin', 'manager']) && item.requiresPermission === 'clients.view'
  && en.includes("'notifPrefs.specialServiceDue':") && en.includes("'notifPrefs.specialServiceDue.desc':"));
ok('§5 the bell list knows its icon', EVENT_META && EVENT_META.specialServiceDue && EVENT_META.specialServiceDue.icon === 'schedule' && EVENT_META.specialServiceDue.filter === 'work');
ok('§5 the pop-ups are the kit Modal (the styling vault\'s popups rule), their words centred by code',
  /from '\.\/Modal'/.test(modal) && /from '\.\/Modal'/.test(card) && !/className="modal-overlay"/.test(card + modal) && /<Modal [^>]*centred>/.test(modal) && /<Modal [^>]*centred>/.test(card)
  && (card.match(/<button /g) || []).length === (card.match(/<Centred>/g) || []).length
  && (modal.match(/<button /g) || []).length === (modal.match(/<Centred>/g) || []).length);

if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  console.log(`FAIL — test-special-services: ${pass} passed, ${fails.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`PASS — test-special-services: ${pass} passed, 0 failed`);
}
