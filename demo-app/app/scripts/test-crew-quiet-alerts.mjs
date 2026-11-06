// Task #468 (Clean Corner's queue, the 2026-11-03 call) — the QUIET-CLEANER alert: someone on the
// crew who hasn't used the app for 30 days is named to their buildings' account managers and the
// Admins and Super Admins, so the office can turn them off if they've left.
//
// Daniel's answers (2026-11-03), each pinned below:
//   1. active = using the app (an app open, or a clock-in recorded for them); never signed in
//      counts from the day they were added;
//   2. who = each building's account manager + every Admin and Super Admin (no building: the
//      Admins and Super Admins);
//   3. once per quiet stretch;
//   4. time off leaves them out while it lasts; the 30 days start over on the day it ends;
//   5. a reader with 3 or fewer due that morning gets one alert each; with more, one list.
//
// HOW. The pure walker (src/lib/crewQuietAlerts.js), then the cron's half of it
// (api/cron/ops-alerts.js crewQuietAlertsFor) with the REAL reads (api/_lib/crewActivity.js,
// api/_lib/jobsTable getCrewJobRows) through scripts/fake-supabase.mjs, then the whole raise
// through the cron's run() with the REAL apply step (lib/opsAlertApply) and fan-out.
//
//   node app/scripts/test-crew-quiet-alerts.mjs
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000468';
Object.assign(process.env, {
  SUPABASE_URL: 'http://127.0.0.1:9', SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

const Q = await import('../src/lib/crewQuietAlerts.js');
const { crewQuietAlertsFor, run } = await import('../api/cron/ops-alerts.js');
const { applyOpsAlert } = await import('../src/lib/opsAlertApply.js');
const { english } = await import('../src/i18n/core.js');
const { NOTIFICATION_GROUPS } = await import('../src/lib/notifications.js');
const { EVENT_META } = await import('../src/lib/notificationMeta.js');
const { seedPermissions } = await import('../src/lib/roles.js');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

const TZ = 'America/New_York';
// Tuesday 2026-12-08, 8:10 AM in New York (EST): inside the first half hour of the default
// office hours (Mon–Fri 08:00–17:00).
const NOW = Date.parse('2026-12-08T13:10:00.000Z');
const DAY = 86400000;
const iso = (s) => new Date(s).toISOString();

const users = () => ([
  { id: 'u_owner', role: 'owner', status: 'active', name: 'Matt Owner', notificationPrefs: {} },
  { id: 'u_admin', role: 'admin', status: 'active', name: 'Ada Admin', notificationPrefs: {} },
  { id: 'u_am', role: 'manager', status: 'active', name: 'Ana Manager', notificationPrefs: {} },
  { id: 'u_am2', role: 'manager', status: 'active', name: 'Bo Manager', notificationPrefs: {} },
  // Due: last opened the app Nov 1 (37 days), on a clean at cl_a.
  { id: 'u_quiet', role: 'crew', status: 'active', name: 'Maria Lopez', createdAt: iso('2026-10-01T14:00:00Z') },
  // Not due: opened the app yesterday.
  { id: 'u_active', role: 'crew', status: 'active', name: 'Carl Active', createdAt: iso('2026-09-01T14:00:00Z') },
  // Not due: last app open Oct 20, but a clock-in on Dec 1.
  { id: 'u_punch', role: 'crew', status: 'active', name: 'Pat Punch', createdAt: iso('2026-09-01T14:00:00Z') },
  // Due: only a VOIDED punch since being added Oct 15.
  { id: 'u_voided', role: 'crew', status: 'active', name: 'Vic Voided', createdAt: iso('2026-10-15T14:00:00Z') },
  // Not due: added 18 days ago, never signed in.
  { id: 'u_new', role: 'crew', status: 'invited', name: 'Nia New', createdAt: iso('2026-11-20T14:00:00Z') },
  // Due: invited Nov 1 and never signed in (37 days).
  { id: 'u_never', role: 'crew', status: 'invited', name: 'Ned Never', createdAt: iso('2026-11-01T14:00:00Z') },
  // Skipped: disabled.
  { id: 'u_disabled', role: 'crew', status: 'disabled', name: 'Dee Disabled', createdAt: iso('2026-09-01T14:00:00Z') },
  // Not due: on time off now (Nov 20 – Dec 20).
  { id: 'u_leave', role: 'crew', status: 'active', name: 'Lea Leave', createdAt: iso('2026-09-01T14:00:00Z') },
  // Not due: time off ended Nov 15 (23 days ago).
  { id: 'u_back', role: 'crew', status: 'active', name: 'Bea Back', createdAt: iso('2026-09-01T14:00:00Z') },
  // Due: time off ended Nov 1 (37 days ago), no use on record.
  { id: 'u_backlong', role: 'crew', status: 'active', name: 'Bob Backlong', createdAt: iso('2026-09-01T14:00:00Z') },
  // Never due: a legacy row with no date and no activity.
  { id: 'u_legacy', role: 'crew', status: 'active', name: 'Leo Legacy' },
  // Not crew: a quiet office member is not this alert's business.
  { id: 'u_supply', role: 'supply_manager', status: 'active', name: 'Sue Supply', createdAt: iso('2026-09-01T14:00:00Z') },
]);

const baseState = (over = {}) => ({
  company: { id: 'co', timezone: TZ },
  users: users(),
  clients: [
    { id: 'cl_a', name: 'Alpha Tower', supervisorId: 'u_am' },
    { id: 'cl_b', name: 'Bravo Plaza', supervisorId: 'u_am2' },
  ],
  sites: [{ id: 's_a', clientId: 'cl_a' }, { id: 's_b', clientId: 'cl_b' }],
  timeOff: [
    { id: 'to1', userId: 'u_leave', startDate: '2026-11-20', endDate: '2026-12-20' },
    { id: 'to2', userId: 'u_back', startDate: '2026-11-10', endDate: '2026-11-15' },
    { id: 'to3', userId: 'u_backlong', startDate: '2026-10-20', endDate: '2026-11-01' },
    { id: 'to4', userId: 'u_quiet', startDate: '2027-02-01', endDate: '2027-02-05' }, // not started: changes nothing
  ],
  permissions: seedPermissions(), userPermissionOverrides: [],
  notifications: [], opsAlertEvents: [], opsSettings: {},
  ...over,
});

const hb = (user, tab, at) => ({ organization_id: ORG, org_user_id: user, tab, last_seen: iso(at) });
const punch = (id, user, at, status = 'completed') => ({ id, organization_id: ORG, user_id: user, clock_in_at: iso(at), status });
const job = (id, at, crewIds, clientId, siteId) => ({
  id, organization_id: ORG, start_at: iso(at), row_version: 1,
  data: { id, clientId, siteId, startAt: iso(at), crewIds, status: 'upcoming' },
});
const tables = () => ({
  client_heartbeats: [
    hb('u_quiet', 'p1', '2026-11-01T15:00:00Z'),
    // u_active: five devices, the newest last — with a 2-row cap the read must page to find it.
    hb('u_active', 'a1', '2026-10-01T15:00:00Z'), hb('u_active', 'a2', '2026-10-02T15:00:00Z'),
    hb('u_active', 'a3', '2026-10-03T15:00:00Z'), hb('u_active', 'a4', '2026-10-04T15:00:00Z'),
    hb('u_active', 'a5', '2026-12-07T15:00:00Z'),
    hb('u_punch', 'q1', '2026-10-20T15:00:00Z'),
    hb('u_other_org', 'x1', '2026-12-07T15:00:00Z'),
  ],
  time_entries: [
    punch('te1', 'u_punch', '2026-12-01T23:00:00Z'),
    punch('te2', 'u_voided', '2026-12-01T23:00:00Z', 'voided'),
    punch('te3', 'u_quiet', '2026-08-01T23:00:00Z'), // before the 60-day look-back
  ],
  jobs: [
    job('j1', '2026-11-25T23:00:00Z', ['u_quiet'], 'cl_a', 's_a'),
    job('j2', '2026-12-12T23:00:00Z', ['u_never'], null, 's_b'), // no clientId: its site's customer
    job('j3', '2027-03-01T23:00:00Z', ['u_backlong'], 'cl_b', 's_b'), // beyond 30 days ahead: no tie
  ],
});

// ── 1. the pure rules ───────────────────────────────────────────────────────────────
{
  ok('the window: Tue 8:10 AM New York is inside', Q.inCrewQuietWindow(NOW, {}, TZ));
  ok('the window: 8:00 AM sharp is inside', Q.inCrewQuietWindow(Date.parse('2026-12-08T13:00:00Z'), {}, TZ));
  ok('the window: 8:30 AM is outside (half an hour)', !Q.inCrewQuietWindow(Date.parse('2026-12-08T13:30:00Z'), {}, TZ));
  ok('the window: 7:59 AM is outside', !Q.inCrewQuietWindow(Date.parse('2026-12-08T12:59:00Z'), {}, TZ));
  ok('the window: Saturday 8:10 AM is outside', !Q.inCrewQuietWindow(Date.parse('2026-12-12T13:10:00Z'), {}, TZ));
  ok('the window follows office hours: opens 9:00 → 9:10 inside, 8:10 outside',
    Q.inCrewQuietWindow(Date.parse('2026-12-08T14:10:00Z'), { officeHoursStart: '09:00', officeHoursEnd: '17:00' }, TZ)
    && !Q.inCrewQuietWindow(NOW, { officeHoursStart: '09:00', officeHoursEnd: '17:00' }, TZ));

  const st = baseState();
  const cands = Q.crewQuietCandidates(st).map((u) => u.id);
  ok('candidates: crew with access only (invited in, disabled and office out)',
    cands.includes('u_never') && !cands.includes('u_disabled') && !cands.includes('u_supply') && !cands.includes('u_owner'),
    cands.join(','));

  const user = (id) => st.users.find((u) => u.id === id);
  const since = (id, act = {}) => Q.quietSinceMs(user(id), { ...act, timeOff: st.timeOff, now: NOW, tz: TZ });
  ok('since: the latest of app use and clock-in',
    since('u_punch', { lastSeenAt: '2026-10-20T15:00:00Z', lastPunchAt: '2026-12-01T23:00:00Z' }) === Date.parse('2026-12-01T23:00:00Z'));
  ok('since: never used → the day they were added', since('u_never') === Date.parse('2026-11-01T14:00:00Z'));
  ok('since: time off going on today → now', since('u_leave') === NOW);
  ok('since: ended time off → the start of its last day (org zone)',
    since('u_backlong') === Date.parse('2026-11-01T04:00:00Z'), new Date(since('u_backlong')).toISOString());
  ok('since: time off not started yet changes nothing', since('u_quiet', { lastSeenAt: '2026-11-01T15:00:00Z' }) === Date.parse('2026-11-01T15:00:00Z'));
  ok('since: a legacy row with nothing known is NaN', Number.isNaN(since('u_legacy')));
  ok('couldBeQuiet: added 18 days ago → no read needed', !Q.couldBeQuiet(user('u_new'), { timeOff: st.timeOff, now: NOW, tz: TZ }));
  ok('couldBeQuiet: on time off → no read needed', !Q.couldBeQuiet(user('u_leave'), { timeOff: st.timeOff, now: NOW, tz: TZ }));
  ok('couldBeQuiet: no date at all → their activity decides', Q.couldBeQuiet(user('u_legacy'), { timeOff: st.timeOff, now: NOW, tz: TZ }));

  const recips = Q.crewQuietRecipients(st, ['cl_a', 'cl_a', 'cl_b']);
  ok('recipients: each building\'s account manager + Admins + Super Admins, deduped',
    recips.length === 4 && ['u_am', 'u_am2', 'u_owner', 'u_admin'].every((r) => recips.includes(r)), recips.join(','));
  const none = Q.crewQuietRecipients(st, []);
  ok('recipients: no building → the Admins and Super Admins only', none.length === 2 && none.includes('u_owner') && none.includes('u_admin'), none.join(','));
  const adminSup = baseState({ clients: [{ id: 'cl_a', name: 'A', supervisorId: 'u_admin' }] });
  ok('recipients: an Admin who is also the account manager is named once', Q.crewQuietRecipients(adminSup, ['cl_a']).length === 2);
  const goneSup = baseState({ clients: [{ id: 'cl_a', name: 'A', supervisorId: 'u_disabled' }] });
  ok('recipients: a building whose manager is not a valid supervisor falls to the office', Q.crewQuietRecipients(goneSup, ['cl_a']).length === 2);
}

// ── 2. the cron's half, with the real reads through the fake ───────────────────────────
resetWorld({ tables: tables() });
world.maxRows = 2; // as PostgREST's db-max-rows: an unpaged read would miss u_active's newest device
const alerts = await crewQuietAlertsFor(baseState(), NOW);
const markers = alerts.filter((a) => a.kind === Q.CREW_QUIET_MARKER_KIND);
const named = markers.map((a) => a.refId).sort();
ok('due: exactly the four quiet cleaners', JSON.stringify(named) === JSON.stringify(['u_backlong', 'u_never', 'u_quiet', 'u_voided']), named.join(','));
ok('the markers carry no bell (markerOnly, nobody to fan to)', markers.every((m) => m.markerOnly === true && m.userIds.length === 0));
ok('reads: the heartbeats were paged (a complete read under a 2-row cap)',
  world.log.filter((q) => q.table === 'client_heartbeats').length > 2, String(world.log.filter((q) => q.table === 'client_heartbeats').length));
ok('reads: clock-ins only for those not seen inside 29 days (never u_active)',
  world.log.filter((q) => q.table === 'time_entries').every((q) => !JSON.stringify(q).includes('u_active')));
ok('reads: a cleaner\'s cleans only for the cleaners due',
  world.log.filter((q) => q.table === 'jobs').every((q) => ['u_quiet', 'u_voided', 'u_never', 'u_backlong'].some((u) => JSON.stringify(q).includes(u))));

const lists = alerts.filter((a) => a.kind === Q.CREW_QUIET_LIST_KIND);
const ones = alerts.filter((a) => a.kind === Q.CREW_QUIET_ONE_KIND);
ok('a big morning: the owner and the admin (4 each) get ONE list each',
  lists.length === 2 && lists.every((l) => l.userIds.length === 1) && lists.map((l) => l.userIds[0]).sort().join() === 'u_admin,u_owner',
  JSON.stringify(lists.map((l) => l.userIds)));
const forQuiet = ones.find((a) => a.refId === undefined && a.id.includes('u_quiet'));
ok('…while Alpha Tower\'s account manager (1 due) gets Maria\'s own alert', forQuiet && forQuiet.userIds.join() === 'u_am', JSON.stringify(forQuiet && forQuiet.userIds));
const forNever = ones.find((a) => a.id.includes('u_never'));
ok('…and Bravo Plaza\'s manager gets Ned\'s (his clean names only the site)', forNever && forNever.userIds.join() === 'u_am2', JSON.stringify(forNever && forNever.userIds));
ok('a cleaner whose every reader got a list has no single alert', !ones.some((a) => a.id.includes('u_voided') || a.id.includes('u_backlong')));
ok('a clean 3 months out ties no building (Bob\'s list-only)', !ones.some((a) => a.id.includes('u_backlong')));

// ── 3. the whole raise through run(): the real apply step, fan-out and log ─────────────
function makeRun(stateRef, { logged = [], writes = [] } = {}) {
  return {
    now: NOW,
    readState: async () => ({ state: structuredClone(stateRef.current), version: stateRef.version }),
    writeState: async (next, version) => {
      if (version !== stateRef.version) return false;
      writes.push(next); stateRef.current = structuredClone(next); stateRef.version += 1; return true;
    },
    compute: (state, now) => crewQuietAlertsFor(state, now),
    dispatch: async () => ({ claimed: 0, sent: 0 }),
    pushReady: () => true,
    pushToUser: async () => { throw new Error('a quiet-cleaner alert must never push to a userId directly'); },
    logAuto: async (rows) => { logged.push(...rows); return rows; },
    report: () => {},
  };
}
resetWorld({ tables: tables() });
const ref = { current: baseState(), version: 1 };
const logged = [];
const out1 = await run(false, makeRun(ref, { logged }));
const after = ref.current;
const rowsFor = (uid) => after.notifications.filter((n) => n.userId === uid);
ok('run: raised the 4 markers + 2 singles + 2 lists', out1.raised === 8, JSON.stringify(out1));
const amRow = rowsFor('u_am')[0];
ok('the account manager\'s bell says the approved words',
  rowsFor('u_am').length === 1 && amRow.eventKey === 'crewQuiet'
  && amRow.title === 'Maria Lopez hasn’t used the app in 30 days'
  && amRow.body === 'Last used it Nov 1. If they’ve left, turn them off in Team.'
  && amRow.url === '/settings/team/u_quiet',
  JSON.stringify(amRow));
const am2Row = rowsFor('u_am2')[0];
ok('never signed in: "Not used since they were added on Nov 1"',
  am2Row && am2Row.body === 'Not used since they were added on Nov 1. If they’ve left, turn them off in Team.', JSON.stringify(am2Row));
const ownerRows = rowsFor('u_owner');
ok('the owner gets one list row, opening the Team list',
  ownerRows.length === 1 && ownerRows[0].title === '4 cleaners haven’t used the app in 30 days'
  && ownerRows[0].body === 'Bob Backlong, Maria Lopez, Ned Never and 1 more. If they’ve left, turn them off in Team.'
  && ownerRows[0].url === '/settings/team',
  JSON.stringify(ownerRows));
ok('no cleaner gets a bell row', after.notifications.every((n) => !['u_quiet', 'u_never', 'u_voided', 'u_backlong'].includes(n.userId)));
const qm = after.opsAlertEvents.filter((e) => e.kind === 'crewQuiet');
ok('one memory marker per cleaner named, keyed by refId', qm.length === 4 && qm.every((e) => e.refId && e.firedAt));
ok('the log: one row per cleaner named, none for the per-reader bells',
  logged.length === 4 && logged.every((r) => r.after.kind === 'crewQuiet' && r.auto === true)
  && logged.some((r) => r.summary.startsWith('Maria Lopez hasn’t used the app in 30 days — Last used it Nov 1')),
  JSON.stringify(logged.map((r) => r.summary)));
const bobLog = logged.find((r) => r.summary.startsWith('Bob Backlong'));
ok('no use inside the 60 days kept: "No use on record in the last 60 days"',
  bobLog && bobLog.summary.endsWith('No use on record in the last 60 days. If they’ve left, turn them off in Team.'), bobLog && bobLog.summary);

// The next tick in the same window, and the next mornings: nothing (once per quiet stretch).
const writesBefore = ref.version;
const out2 = await run(false, { ...makeRun(ref), now: NOW + 5 * 60000 });
ok('the next tick in the window raises nothing and writes nothing', out2.raised === 0 && ref.version === writesBefore, JSON.stringify(out2));
const out3 = await run(false, { ...makeRun(ref), now: NOW + DAY, compute: (s) => crewQuietAlertsFor(s, NOW + DAY) });
ok('the next morning: the same quiet cleaners are not named again', out3.raised === 0, JSON.stringify(out3));

// Maria comes back on Dec 10, then goes quiet again: named again 30 days on (Tue 2027-01-12).
const LATER = Date.parse('2027-01-12T13:10:00.000Z');
// Everyone not named on Dec 8 keeps using the app, so only the named cleaners are in question.
const busy = ['u_active', 'u_punch', 'u_new', 'u_back'].map((u) => hb(u, 'z1', '2027-01-11T15:00:00Z'));
resetWorld({ tables: { ...tables(), client_heartbeats: [...busy, hb('u_quiet', 'p1', '2026-12-10T15:00:00Z')] } });
const again = await crewQuietAlertsFor(ref.current, LATER);
const againNamed = again.filter((a) => a.kind === 'crewQuiet').map((a) => a.refId);
ok('a new stretch after coming back rings again — and only hers', againNamed.join() === 'u_quiet', againNamed.join(','));
// Without that return, the Nov 1 heartbeat has been reaped (60 days): no re-ring.
resetWorld({ tables: { ...tables(), client_heartbeats: busy } });
const reaped = await crewQuietAlertsFor(ref.current, LATER);
ok('a reaped heartbeat does not make an old stretch ring twice', reaped.filter((a) => a.kind === 'crewQuiet').length === 0, JSON.stringify(reaped.map((a) => a.id)));

// ── 4. three or fewer: one alert each, to every reader ────────────────────────────────
{
  resetWorld({ tables: tables() });
  const st = baseState();
  st.users = st.users.filter((u) => u.id !== 'u_backlong'); // 3 due
  const three = await crewQuietAlertsFor(st, NOW);
  const singles = three.filter((a) => a.kind === Q.CREW_QUIET_ONE_KIND);
  ok('3 due: no list, three single alerts', !three.some((a) => a.kind === Q.CREW_QUIET_LIST_KIND) && singles.length === 3);
  const maria = singles.find((a) => a.id.includes('u_quiet'));
  ok('3 due: Maria\'s reaches her account manager AND the owner and admin',
    maria && ['u_am', 'u_owner', 'u_admin'].every((r) => maria.userIds.includes(r)) && maria.userIds.length === 3, JSON.stringify(maria && maria.userIds));
}

// ── 5. outside the window it reads nothing; a failed read skips the alert ──────────────
{
  resetWorld({ tables: tables() });
  const off = await crewQuietAlertsFor(baseState(), Date.parse('2026-12-08T15:00:00Z')); // 10:00 AM
  ok('outside the morning window: no alerts and NO reads', off.length === 0 && world.log.length === 0, String(world.log.length));
  resetWorld({ tables: tables() });
  world.failWhen = (q) => q.table === 'time_entries';
  let threw = false;
  try { await crewQuietAlertsFor(baseState(), NOW); } catch { threw = true; }
  ok('a failed clock-in read throws (the cron skips the alert, never judges on partial data)', threw);
}

// ── 6. the apply step: markerOnly, and the memory's retention ─────────────────────────
{
  const st = baseState();
  const applied = applyOpsAlert(st, { id: 'oa_crewQuiet_u_quiet_2026-12-08', kind: 'crewQuiet', refId: 'u_quiet', markerOnly: true, recipientScope: 'users', userIds: ['u_owner'], title: 'x' }, { now: NOW });
  ok('markerOnly: the marker lands, no bell row (even with a userId named)', applied && applied.notifications.length === 0 && applied.opsAlertEvents.length === 1);
  // A month and a half later the marker is still kept (no 48-hour horizon) while she is crew.
  const st2 = { ...st, opsAlertEvents: applied.opsAlertEvents };
  const later = applyOpsAlert(st2, { id: 'oa_other', kind: 'shiftMissed', clientId: 'cl_a', recipientScope: 'supervisor', title: 't' }, { now: NOW + 45 * DAY });
  ok('the memory outlives the 48-hour horizon', later.opsAlertEvents.some((e) => e.kind === 'crewQuiet' && e.refId === 'u_quiet'));
  const st3 = { ...st2, users: st2.users.map((u) => (u.id === 'u_quiet' ? { ...u, status: 'disabled' } : u)) };
  const pruned = applyOpsAlert(st3, { id: 'oa_other2', kind: 'shiftMissed', clientId: 'cl_a', recipientScope: 'supervisor', title: 't' }, { now: NOW + DAY });
  ok('…and is dropped once the cleaner is disabled', !pruned.opsAlertEvents.some((e) => e.kind === 'crewQuiet'));
  const twice = applyOpsAlert(st2, { id: 'oa_crewQuiet_u_quiet_2027-01-12', kind: 'crewQuiet', refId: 'u_quiet', markerOnly: true, recipientScope: 'users', userIds: [] }, { now: LATER });
  ok('one memory per cleaner: a new stretch supersedes the old marker',
    twice.opsAlertEvents.filter((e) => e.kind === 'crewQuiet').map((e) => e.id).join() === 'oa_crewQuiet_u_quiet_2027-01-12');
}

// ── 7. the switch: office tiers, behind the Team page's key; the words and the icon ────
{
  const item = NOTIFICATION_GROUPS.flatMap((g) => g.items.map((i) => ({ ...i, group: g.id }))).find((i) => i.key === 'crewQuiet');
  ok('the switch sits in the HR group, office tiers only, needing settings.team.view',
    item && item.group === 'hr' && item.roleAllowlist.join() === 'owner,admin,manager' && item.requiresPermission === 'settings.team.view' && !item.defaultOff);
  ok('the switch has its words', english('notifPrefs.crewQuiet') === 'A cleaner hasn’t used the app in 30 days');
  ok('the bell list knows its icon', EVENT_META.crewQuiet && EVENT_META.crewQuiet.icon === 'user');
  // A muted Admin gets nothing; the others still do.
  resetWorld({ tables: tables() });
  const muted = baseState();
  muted.users = muted.users.map((u) => (u.id === 'u_admin' ? { ...u, notificationPrefs: { crewQuiet: false } } : u));
  const r2 = { current: muted, version: 1 };
  await run(false, makeRun(r2));
  ok('an Admin who turned it off gets no row; the owner still does',
    r2.current.notifications.filter((n) => n.userId === 'u_admin').length === 0
    && r2.current.notifications.filter((n) => n.userId === 'u_owner').length === 1);
}

if (fails.length) {
  console.error(`✗ crew-quiet alerts: ${fails.length} failed, ${pass} passed`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✓ crew-quiet alerts: ${pass} passed`);
}
