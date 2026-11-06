// My Hours — a cleaner's own time in a pay period (Matt's Cleaner Hub, "My Hours"; plan
// docs/plans/2026-10-13-cleaner-hub.md, brief C §3). VIEW ONLY.
//
//   A. the pure rule (src/lib/myHours.js myHoursPeriod), the ONE rule the route and the demo stub
//      share: the period is the PAYROLL's own (lib/payroll payPeriodRange, asserted against it,
//      never a restated date) for weekly, biweekly and semi-monthly; a punch counts on the ORG-zone
//      day it clocked in (a punch at 11:30 PM Eastern is that day, not the UTC one — at a period
//      edge that decides which period it is in); a voided punch, a no-show and a legacy rejected
//      one never count; a day reads Approved only when every punch on it is, In progress while one
//      is open (its elapsed time so far), else Pending; `offset` steps back, never forward.
//   B. the route, GET /api/time/my-hours (EP-381), through the REAL `api/time` handler over the
//      loopback Supabase fake: SELF by the login's claim; a crew `userId` is ignored; an office
//      login reads another person only while holding `time.view` (403 without it); the period
//      comes from the FULL opsSettings the server reads (the crew's view of the record has no
//      cadence); the read is COMPLETE (past PostgREST's 1,000-row cap), never the 100-row `mine`.
//
// REGRESSION (THE LAW II.3): on the tree before My Hours there is no lib/myHours and no route, so
// every check here fails (the counts are in the build report).
//
//   node app/scripts/test-my-hours.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

// A fixed clock: Wednesday Oct 7 2026, 6:30 PM Eastern.
const NOW = '2026-10-07T22:30:00.000Z';
{
  const RealDate = Date;
  const at = { now: RealDate.parse(NOW) };
  globalThis.__clock = at;
  globalThis.Date = class FixedDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(at.now); else super(...a); }
    static now() { return at.now; }
  };
}

const ORG = '00000000-0000-0000-0000-000000000021';
const TZ = 'America/New_York';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch { return {}; } };
const mh = await tryImport('../src/lib/myHours.js');
const { payPeriodRange } = await import('../src/lib/payroll.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const time = (await import('../api/time/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const period = typeof mh.myHoursPeriod === 'function' ? mh.myHoursPeriod : () => ({});
const S = mh.MY_HOURS_STATUS || { approved: 'approved', pending: 'pending', inProgress: 'inProgress' };

// ── the punches (Eastern times in the comments) ──────────────────────────────
const punch = (id, o) => ({
  id, organization_id: ORG, user_id: 'u_c1', client_id: 'cl_a', site_id: 'st_a', job_id: `j_${id}`,
  status: 'completed', approval_status: 'pending', row_version: 0, ...o,
});
const C1 = [
  // Mon Oct 5: 6–10 PM and 10:30 PM–2 AM — the second is Oct 6 in UTC, Oct 5 in the org's zone.
  punch('e1', { clock_in_at: '2026-10-05T22:00:00.000Z', clock_out_at: '2026-10-06T02:00:00.000Z', duration_minutes: 240, approval_status: 'approved' }),
  punch('e2', { clock_in_at: '2026-10-06T02:30:00.000Z', clock_out_at: '2026-10-06T06:00:00.000Z', duration_minutes: 210, approval_status: 'approved' }),
  // Tue Oct 6: one approved, one still waiting → the day is Pending.
  punch('e3', { clock_in_at: '2026-10-06T22:00:00.000Z', clock_out_at: '2026-10-07T02:00:00.000Z', duration_minutes: 240, approval_status: 'approved' }),
  punch('e4', { clock_in_at: '2026-10-07T02:30:00.000Z', clock_out_at: '2026-10-07T06:30:00.000Z', duration_minutes: 240, approval_status: 'pending' }),
  // a DELETED punch (voided) the same day: never counts
  punch('e5', { clock_in_at: '2026-10-06T15:00:00.000Z', clock_out_at: '2026-10-06T17:00:00.000Z', duration_minutes: 120, status: 'voided' }),
  // Wed Oct 7, today: clocked in at 6:00 PM, still on the clock (30 min so far)
  punch('e6', { clock_in_at: '2026-10-07T22:00:00.000Z', clock_out_at: null, duration_minutes: null, status: 'in_progress' }),
  // a no-show and a legacy rejected punch today: never count
  punch('e7', { clock_in_at: '2026-10-07T13:00:00.000Z', clock_out_at: '2026-10-07T14:00:00.000Z', duration_minutes: 60, status: 'no_show' }),
  punch('e8', { clock_in_at: '2026-10-07T12:00:00.000Z', clock_out_at: '2026-10-07T13:00:00.000Z', duration_minutes: 60, approval_status: 'rejected' }),
  // long before this period
  punch('e9', { clock_in_at: '2026-09-01T22:00:00.000Z', clock_out_at: '2026-09-02T02:00:00.000Z', duration_minutes: 240, approval_status: 'approved' }),
];
const BIWEEKLY_MON = { payPeriodCadence: 'biweekly', payWeekStartDay: 1 };

// ── A. the rule ──────────────────────────────────────────────────────────────
{
  const p = period({ entries: C1, opsSettings: BIWEEKLY_MON, now: Date.parse(NOW), offset: 0, tz: TZ });
  const want = payPeriodRange('biweekly', 0, new Date(NOW), TZ, 1);
  eq('A1 biweekly: the period is the payroll\'s own (from)', p.from, want.fromKey);
  eq('A2 …(to)', p.to, want.toKey);
  eq('A3 the worked days, in order, each on its ORG-zone day (10:30 PM Mon is Monday)', (p.days || []).map((d) => d.dayKey), ['2026-10-05', '2026-10-06', '2026-10-07']);
  eq('A4 Monday: every punch approved → Approved, 7.5 h', (p.days || [])[0] && [p.days[0].status, p.days[0].minutes], [S.approved, 450]);
  eq('A5 Tuesday: one punch still waiting → Pending (the voided punch not counted)', (p.days || [])[1] && [p.days[1].status, p.days[1].minutes], [S.pending, 480]);
  eq('A6 today: an open punch → In progress, its time so far', (p.days || [])[2] && [p.days[2].status, p.days[2].minutes, p.days[2].openSince, p.days[2].isToday], [S.inProgress, 30, '2026-10-07T22:00:00.000Z', true]);
  eq('A7 the totals: approved / pending / in progress / all', [p.approvedMinutes, p.pendingMinutes, p.inProgressMinutes, p.totalMinutes], [690, 240, 30, 960]);
  eq('A8 days approved, and "today in progress"', [p.approvedDays, p.inProgress], [1, true]);
  eq('A9 this period has nothing newer; an older one exists', [p.hasNewer, p.hasOlder], [false, true]);
  ok('A10 no-show, rejected and voided punches never count (no minutes from e5 / e7 / e8)', p.totalMinutes === 960);
}
{
  // The period before, and the most a cleaner can page back.
  const p1 = period({ entries: C1, opsSettings: BIWEEKLY_MON, now: Date.parse(NOW), offset: 1, tz: TZ });
  const want = payPeriodRange('biweekly', -1, new Date(NOW), TZ, 1);
  eq('A11 offset 1 is the period before', [p1.from, p1.to], [want.fromKey, want.toKey]);
  ok('A12 …with none of this period\'s days', !(p1.days || []).some((d) => d.dayKey >= '2026-10-05'), JSON.stringify(p1.days));
  eq('A13 offset is a whole number 0..max, never forward', [mh.myHoursOffset?.(-3), mh.myHoursOffset?.('x'), mh.myHoursOffset?.(2.7), mh.myHoursOffset?.(500)], [0, 0, 2, mh.MY_HOURS_MAX_OFFSET]);
  const far = period({ entries: [], opsSettings: BIWEEKLY_MON, now: Date.parse(NOW), offset: 999, tz: TZ });
  eq('A14 …and the furthest period says there is nothing older', [far.offset, far.hasOlder, far.hasNewer], [mh.MY_HOURS_MAX_OFFSET, false, true]);
}
{
  // WEEKLY on a Sunday week, at the period's edge: 11:30 PM Saturday Eastern is 3:30 AM Sunday UTC.
  const MON = Date.parse('2026-10-05T16:00:00.000Z');
  const edge = [
    punch('w1', { clock_in_at: '2026-10-04T03:30:00.000Z', clock_out_at: '2026-10-04T05:00:00.000Z', duration_minutes: 90, approval_status: 'approved' }),
    punch('w2', { clock_in_at: '2026-10-04T04:30:00.000Z', clock_out_at: '2026-10-04T06:00:00.000Z', duration_minutes: 90 }),
  ];
  const ops = { payPeriodCadence: 'weekly', payWeekStartDay: 0 };
  const p0 = period({ entries: edge, opsSettings: ops, now: MON, offset: 0, tz: TZ });
  const p1 = period({ entries: edge, opsSettings: ops, now: MON, offset: 1, tz: TZ });
  const w0 = payPeriodRange('weekly', 0, new Date(MON), TZ, 0);
  eq('A15 weekly: the payroll\'s week', [p0.from, p0.to], [w0.fromKey, w0.toKey]);
  eq('A16 a punch at 11:30 PM Saturday (org zone) is NOT in the week that starts Sunday', (p0.days || []).map((d) => d.dayKey), ['2026-10-04']);
  eq('A17 …it is Saturday\'s, in the week before', (p1.days || []).map((d) => [d.dayKey, d.minutes]), [['2026-10-03', 90]]);
}
{
  // SEMI-MONTHLY (Clean Space's cadence): 1st–15th, 16th–end, in the org zone.
  const OCT13 = Date.parse('2026-10-13T15:00:00.000Z');
  const ops = { payPeriodCadence: 'semimonthly', payWeekStartDay: 1 };
  const rows = [
    punch('s1', { clock_in_at: '2026-10-01T03:00:00.000Z', clock_out_at: '2026-10-01T05:00:00.000Z', duration_minutes: 120, approval_status: 'approved' }), // Sep 30, 11 PM
    punch('s2', { clock_in_at: '2026-10-01T05:00:00.000Z', clock_out_at: '2026-10-01T06:00:00.000Z', duration_minutes: 60 }),                               // Oct 1, 1 AM
  ];
  const p0 = period({ entries: rows, opsSettings: ops, now: OCT13, offset: 0, tz: TZ });
  const p1 = period({ entries: rows, opsSettings: ops, now: OCT13, offset: 1, tz: TZ });
  eq('A18 semi-monthly: the payroll\'s half-month', [p0.from, p0.to], [payPeriodRange('semimonthly', 0, new Date(OCT13), TZ, 1).fromKey, payPeriodRange('semimonthly', 0, new Date(OCT13), TZ, 1).toKey]);
  eq('A19 …and the half before', [p1.from, p1.to], [payPeriodRange('semimonthly', -1, new Date(OCT13), TZ, 1).fromKey, payPeriodRange('semimonthly', -1, new Date(OCT13), TZ, 1).toKey]);
  eq('A20 11 PM on Sep 30 (org zone) is in the September half, 1 AM Oct 1 in October\'s', [(p0.days || []).map((d) => d.dayKey), (p1.days || []).map((d) => d.dayKey)], [['2026-10-01'], ['2026-09-30']]);
  eq('A21 an unknown cadence reads as the payroll\'s default (biweekly)', period({ entries: [], opsSettings: { payPeriodCadence: 'fortnightly' }, now: OCT13, tz: TZ }).cadence, 'biweekly');
}
{
  // A closed punch with no stored duration counts its clock-out − clock-in.
  const p = period({ entries: [punch('d1', { clock_in_at: '2026-10-07T12:00:00.000Z', clock_out_at: '2026-10-07T13:45:00.000Z', duration_minutes: null })], opsSettings: BIWEEKLY_MON, now: Date.parse(NOW), tz: TZ });
  eq('A22 a closed punch with no duration counts out − in', p.totalMinutes, 105);
  eq('A23 hours to one decimal', [mh.hoursOneDecimal?.(450), mh.hoursOneDecimal?.(480), mh.hoursOneDecimal?.(1415)], [7.5, 8, 23.6]);
}

// ── B. the route ─────────────────────────────────────────────────────────────
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },
  mgr2: { id: 'u_mgr2', role: 'manager', claim: false },
  c1: { id: 'u_c1', role: 'crew', claim: true },
  c2: { id: 'u_c2', role: 'crew', claim: true },
};
const emailOf = (k) => `${k}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {},
}]));
const C2 = [
  punch('f1', { user_id: 'u_c2', clock_in_at: '2026-10-06T13:00:00.000Z', clock_out_at: '2026-10-06T16:00:00.000Z', duration_minutes: 180, approval_status: 'approved' }),
];

function buildWorld({ entries = [...C1, ...C2], opsSettings = BIWEEKLY_MON, overrides = [] } = {}) {
  resetWorld({
    tables: {
      org_state: [{
        organization_id: ORG, version: 3,
        state: {
          users: roster, permissions: seedPermissions(), userPermissionOverrides: overrides,
          company: { timezone: TZ }, clients: [{ id: 'cl_a', name: 'Coral Bay', supervisorId: 'u_mgr' }],
          sites: [{ id: 'st_a', clientId: 'cl_a', name: 'Clubhouse' }], opsSettings,
        },
      }],
      time_entries: entries.map((e) => ({ ...e })),
    },
    logins,
  });
}

async function call({ method = 'GET', path, token, query = {} }) {
  const req = Readable.from([]);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { subpath: path, ...query };
  req.body = {};
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 8000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(time(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const myHours = (who, query = {}) => call({ path: 'my-hours', token: who ? `tok-${who}` : null, query });
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;
const ruleFor = (rows, o = {}) => period({ entries: rows, opsSettings: BIWEEKLY_MON, now: Date.parse(NOW), tz: TZ, ...o });

{
  buildWorld();
  const r = await myHours('c1');
  eq('B1 a cleaner reads their own period (200)', r.status, 200);
  eq('B2 …exactly the rule over THEIR punches (another cleaner\'s never counted)', r.body && [r.body.from, r.body.to, r.body.totalMinutes, r.body.approvedDays], [ruleFor(C1).from, ruleFor(C1).to, ruleFor(C1).totalMinutes, ruleFor(C1).approvedDays]);
  eq('B3 …day by day', (r.body?.days || []).map((d) => [d.dayKey, d.minutes, d.status]), (ruleFor(C1).days || []).map((d) => [d.dayKey, d.minutes, d.status]));
  ok('B4 the answer carries no punch rows, ids or other people', r.body && !('entries' in r.body) && !JSON.stringify(r.body).includes('u_c2') && !JSON.stringify(r.body).includes('"e1"'), JSON.stringify(r.body)?.slice(0, 200));
  const asOther = await myHours('c1', { userId: 'u_c2' });
  eq('B5 a CREW login naming someone else still reads themselves', asOther.body?.totalMinutes, ruleFor(C1).totalMinutes);
  const office = await myHours('mgr', { userId: 'u_c2' });
  eq('B6 an office login holding time.view previews that cleaner (the owner\'s View-as)', [office.status, office.body?.totalMinutes], [200, ruleFor(C2).totalMinutes]);
  const owner = await myHours('owner', { userId: 'u_c1' });
  eq('B7 …the owner too', owner.body?.totalMinutes, ruleFor(C1).totalMinutes);
  const older = await myHours('c1', { offset: '1' });
  eq('B8 ?offset=1 is the period before', [older.body?.from, older.body?.to], [ruleFor(C1, { offset: 1 }).from, ruleFor(C1, { offset: 1 }).to]);
  const junk = await myHours('c1', { offset: 'soon' });
  eq('B9 a malformed offset is this period', junk.body?.from, ruleFor(C1).from);
  const bad = await myHours('mgr', { userId: 'u_c2),or(x' });
  eq('B10 a malformed userId is a 400', bad.status, 400);
  const anon = await myHours(null);
  eq('B11 no session → 401', anon.status, 401);
  const reads = world.log.filter((q) => q.table === 'time_entries');
  ok('B12 every punch read asks for ONE person\'s punches, in the query', reads.length > 0 && reads.every((q) => (q.eq?.user_id && typeof q.eq.user_id === 'string') || (Array.isArray(q.in?.user_id) && q.in.user_id.length === 1)), JSON.stringify(reads.slice(0, 2)));
}
{
  // An office login WITHOUT time.view (pared back in Roles) may not preview someone's hours.
  buildWorld({ overrides: [{ userId: 'u_mgr2', grants: [], revokes: ['time.view'] }] });
  const r = await myHours('mgr2', { userId: 'u_c1' });
  eq('B13 an office login without time.view naming someone → 403', r.status, 403);
  const self = await myHours('mgr2');
  eq('B14 …but reads their own hours', self.status, 200);
}
{
  // The cadence comes from the FULL opsSettings the server reads (semi-monthly here).
  buildWorld({ opsSettings: { payPeriodCadence: 'semimonthly', payWeekStartDay: 1 } });
  const r = await myHours('c1');
  const want = payPeriodRange('semimonthly', 0, new Date(NOW), TZ, 1);
  eq('B15 the period follows the org\'s cadence (semi-monthly)', [r.body?.cadence, r.body?.from, r.body?.to], ['semimonthly', want.fromKey, want.toKey]);
}
{
  // COMPLETE: 1,100 punches this period past a 1,000-row cap all count (never the newest 100).
  const many = Array.from({ length: 1100 }, (_, i) => punch(`m${i}`, {
    clock_in_at: new Date(Date.parse('2026-10-06T12:00:00.000Z') + i * 1000).toISOString(),
    clock_out_at: new Date(Date.parse('2026-10-06T12:01:00.000Z') + i * 1000).toISOString(), duration_minutes: 1,
  }));
  buildWorld({ entries: many });
  world.maxRows = 1000;
  const r = await myHours('c1');
  eq('B16 every punch in the period counts, past the 1,000-row cap', [r.status, r.body?.totalMinutes], [200, 1100]);
}

console.log(`\ntest-my-hours: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
if (fails.length) process.exit(1);
