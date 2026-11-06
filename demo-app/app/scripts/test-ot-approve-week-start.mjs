// CS-659 — overtime approval follows the ORG's workweek start, end to end.
//
// Production stores `opsSettings.payWeekStartDay = 1` (Monday; Matt's PAY-19 (b), set 2026-10-03).
// The Approvals read builds its overtime units on that week start, so every unit's weekKey is a
// MONDAY — and `POST /time/ot-approve` refused any key that was not a Sunday (`invalid-week`).
// Unapproved overtime is HELD by the pay run (otLedger: an approved punch's OT pays only up to
// the unit's approved total), so no hour past 40 was ever paid. The demo stub copied the check.
//
// Driven through the REAL handlers (api/time + api/payroll) over scripts/fake-supabase.mjs — no
// network, no credentials. Pins:
//   1. Monday-week org: the approvals read's unit is a Monday key; approving it SUCCEEDS, one
//      row is stored, and the pay run then PAYS the overtime (regular 40 h + 10 h OT, nothing
//      held) — ONCE: approving the same unit again stores the same total and pays the same.
//   2. A Sunday key under a Monday week is refused (`invalid-week`), as is a malformed or
//      impossible calendar key; nothing is written.
//   3. A scoped manager approves a Monday unit at their own customer.
//   4. The rule is symmetric: a Sunday-week org accepts the Sunday key and refuses a Monday one.
//   5. ONE rule (lib/payroll `isPayWeekKey` + `payWeekStartDayOf`) for the route AND the demo stub —
//      pinned at both call sites, since the stub (lib/timeApi.js) cannot load in bare Node.
//
//   node app/scripts/test-ot-approve-week-start.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';
import { seedPermissions } from '../src/lib/roles.js';
import * as payrollLib from '../src/lib/payroll.js';
import { addDaysKey, dayOfWeekKey } from '../src/lib/dates.js';

const ORG = '00000000-0000-0000-0000-000000000001';
const TZ = 'America/New_York';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };

installFakeSupabase();
const time = (await import('../api/time/[...path].js')).default;
const payroll = (await import('../api/payroll/[...path].js')).default;

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const { payPeriodRange, isPayWeekKey, payWeekStartDayOf } = payrollLib;

// ── people ─────────────────────────────────────────────────────────────────────
const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', pay: { type: 'none' } },
  mgr: { id: 'u_mgr', role: 'manager', pay: { type: 'salary' } },
  crew: { id: 'u_crew', role: 'crew', pay: { type: 'hourly', hourlyRate: 22 } },
};
const roster = Object.entries(PEOPLE).map(([k, p]) => ({ id: p.id, email: `${k}@example.test`, role: p.role, status: 'active', name: k, pay: p.pay }));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [`tok-${k}`, {
  id: `auth-${k}`, email: `${k}@example.test`, app_metadata: { role: p.role, org_user_id: p.id, org_id: ORG },
}]));

const H = 3600e3;
const OT_MULT = 1.5;
const RATE = PEOPLE.crew.pay.hourlyRate;

// One APPROVED 50-hour punch (the ledger reads duration_minutes) inside the PREVIOUS weekly
// period, so the period has ended whatever day the suite runs on. The period is computed from
// the setting under test with the pay calendar's own function — never a restated date.
function worldFor(weekStartDay) {
  const prev = payPeriodRange('weekly', -1, new Date(), TZ, weekStartDay);
  const inAt = new Date(Date.parse(prev.fromIso) + 26 * H).toISOString();
  const outAt = new Date(Date.parse(inAt) + 8 * H).toISOString();
  const punch = {
    id: 'te_ot', organization_id: ORG, user_id: 'u_crew', client_id: 'cl_a', site_id: 'st_a', job_id: 'j_a',
    user_name: 'crew', client_name: 'A', site_name: 'Main',
    clock_in_at: inAt, clock_out_at: outAt, duration_minutes: 3000,
    status: 'completed', approval_status: 'approved', approved_by: 'u_owner', approved_at: outAt,
    geofence_result: 'inside', source: 'crew_mobile', edited: false, job_cancelled_at: null,
    note: null, override_reason: null, expected_minutes_snapshot: 120, row_version: 1, edit_history: [], updated_at: outAt,
  };
  const state = {
    users: roster, permissions: seedPermissions(), userPermissionOverrides: [], company: { timezone: TZ },
    clients: [{ id: 'cl_a', name: 'A', supervisorId: 'u_mgr' }, { id: 'cl_b', name: 'B', supervisorId: null }],
    sites: [{ id: 'st_a', clientId: 'cl_a', name: 'Main' }],
    opsSettings: { payPeriodCadence: 'weekly', payWeekStartDay: weekStartDay, payDriveTime: false, otMultiplier: OT_MULT },
    payrollLines: [],
  };
  resetWorld({
    tables: { org_state: [{ organization_id: ORG, state, version: 3 }], time_entries: [punch], payroll_runs: [], time_ot_approvals: [], jobs: [] },
    logins,
  });
  return { prev };
}

async function call(handler, { method = 'POST', path, who = 'owner', body, query = {} }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = { authorization: `Bearer tok-${who}` };
  req.query = { subpath: path, ...query };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200, status(c) { this.statusCode = c; return this; }, setHeader() { return this; },
        json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 260)}`;
const approvalsRead = (who = 'owner') => call(time, { method: 'GET', path: 'approvals', who });
const otApprove = (items, who = 'owner') => call(time, { path: 'ot-approve', who, body: { items } });
const preview = (offset) => call(payroll, { method: 'GET', path: 'preview', query: { offset: String(offset) } });
const crewRow = (r) => (r.body?.rows || []).find((x) => x.userId === 'u_crew') || null;

// ═══ 1. Monday-week org: approve → paid, once ════════════════════════════════════
{
  const MONDAY = 1;
  const { prev } = worldFor(MONDAY);
  const a = await approvalsRead();
  const unit = (a.body?.overtime || []).find((u) => u.userId === 'u_crew' && u.clientId === 'cl_a');
  ok('Monday week: the approvals read lists the cleaner\'s overtime unit', a.status === 200 && !!unit, show(a));
  ok('…keyed on the org\'s week start (a Monday, the period\'s first day)', unit && unit.weekKey === prev.fromKey && dayOfWeekKey(unit.weekKey) === MONDAY,
    `weekKey=${unit?.weekKey} period=${prev.fromKey}`);
  ok('…10 h awaiting (50 h worked, the 40 h line)', unit && unit.dueMinutes === 600 && unit.awaitingMinutes === 600, JSON.stringify(unit));

  const before = await preview(-1);
  ok('before approval the pay run HOLDS the overtime (0 OT paid, 600 min held)',
    before.status === 200 && crewRow(before)?.current?.otMinutes === 0 && before.body?.rolledForward?.otHeldMinutes === 600, show(before));

  const r = await otApprove([{ userId: unit?.userId, weekKey: unit?.weekKey, clientId: unit?.clientId, minutes: unit?.dueMinutes }]);
  const res = r.body?.results?.[0];
  ok('Approve overtime on the Monday unit SUCCEEDS', r.status === 200 && res?.ok === true && res.approvedMinutes === 600, show(r));
  const rows = world.tables.time_ot_approvals || [];
  ok('…one approval row, on the Monday key, the unit total', rows.length === 1 && rows[0].week_key === prev.fromKey && rows[0].approved_ot_minutes === 600, JSON.stringify(rows));

  const after = await preview(-1);
  const row = crewRow(after);
  const wantGross = Math.round(((2400 / 60) * RATE + (600 / 60) * RATE * OT_MULT) * 100) / 100;
  ok('after approval the pay run PAYS it: 40 h regular + 10 h OT, nothing held',
    after.status === 200 && row?.current?.regularMinutes === 2400 && row?.current?.otMinutes === 600 && after.body?.rolledForward?.otHeldMinutes === 0, show(after));
  ok(`…priced at the OT multiplier (gross ${wantGross})`, row && row.gross === wantGross, `gross=${row?.gross}`);

  const again = await otApprove([{ userId: 'u_crew', weekKey: prev.fromKey, clientId: 'cl_a', minutes: 600 }]);
  const rows2 = world.tables.time_ot_approvals || [];
  const after2 = await preview(-1);
  ok('approving the SAME unit again stores the same TOTAL (one row, still 600)',
    again.body?.results?.[0]?.ok === true && rows2.length === 1 && rows2[0].approved_ot_minutes === 600, JSON.stringify(rows2));
  ok('…and the pay run pays the overtime ONCE (still 600 min, same gross)',
    crewRow(after2)?.current?.otMinutes === 600 && crewRow(after2)?.gross === wantGross, show(after2));

  const read2 = await approvalsRead();
  ok('…and the unit no longer waits on the Overtime tab',
    !(read2.body?.overtime || []).some((u) => u.userId === 'u_crew' && u.weekKey === prev.fromKey), JSON.stringify(read2.body?.overtime));
}

// ═══ 2. a misaligned or malformed key is refused, nothing written ═════════════════
{
  const { prev } = worldFor(1);
  const sunday = addDaysKey(prev.fromKey, -1);
  const r = await otApprove([{ userId: 'u_crew', weekKey: sunday, clientId: 'cl_a', minutes: 600 }]);
  ok('Monday week: a SUNDAY key is refused (invalid-week)', r.body?.results?.[0]?.ok === false && r.body.results[0].code === 'invalid-week', show(r));
  for (const bad of ['2026-13-02', '2026-02-30', 'garbage', '', 20261012, null]) {
    const rb = await otApprove([{ userId: 'u_crew', weekKey: bad, clientId: 'cl_a', minutes: 60 }]);
    ok(`a malformed key (${JSON.stringify(bad)}) is refused (invalid-week)`, rb.body?.results?.[0]?.code === 'invalid-week', show(rb));
  }
  ok('…and nothing was written', (world.tables.time_ot_approvals || []).length === 0, JSON.stringify(world.tables.time_ot_approvals));
}

// ═══ 3. a scoped manager approves a Monday unit at their own customer ══════════════
{
  const { prev } = worldFor(1);
  const r = await otApprove([{ userId: 'u_crew', weekKey: prev.fromKey, clientId: 'cl_a', minutes: 600 }], 'mgr');
  ok('a manager approves the Monday unit at their own customer', r.status === 200 && r.body?.results?.[0]?.ok === true, show(r));
  const out = await otApprove([{ userId: 'u_crew', weekKey: prev.fromKey, clientId: 'cl_b', minutes: 600 }], 'mgr');
  ok('…and is still refused at a customer that is not theirs (out-of-scope)', out.body?.results?.[0]?.code === 'out-of-scope', show(out));
}

// ═══ 4. the rule is the org's, not Monday's: a Sunday-week org ════════════════════
{
  const { prev } = worldFor(0);
  ok('Sunday week: the period starts on a Sunday', dayOfWeekKey(prev.fromKey) === 0, prev.fromKey);
  const yes = await otApprove([{ userId: 'u_crew', weekKey: prev.fromKey, clientId: 'cl_a', minutes: 600 }]);
  ok('Sunday week: the Sunday key is accepted', yes.body?.results?.[0]?.ok === true, show(yes));
  const no = await otApprove([{ userId: 'u_crew', weekKey: addDaysKey(prev.fromKey, 1), clientId: 'cl_a', minutes: 600 }]);
  ok('Sunday week: a Monday key is refused', no.body?.results?.[0]?.code === 'invalid-week', show(no));
}

// ═══ 5. ONE rule, pure, and both callers use it ═════════════════════════════════════
{
  ok('lib/payroll exports isPayWeekKey + payWeekStartDayOf', typeof isPayWeekKey === 'function' && typeof payWeekStartDayOf === 'function');
  if (typeof isPayWeekKey === 'function' && typeof payWeekStartDayOf === 'function') {
    // 2026-10-04 is a Sunday; each following day is the next week-start value.
    for (let d = 0; d <= 6; d += 1) {
      const key = addDaysKey('2026-10-04', d);
      ok(`isPayWeekKey: ${key} starts a week that starts on day ${d}`, isPayWeekKey(key, d) === true);
      ok(`isPayWeekKey: ${key} does not start a day-${(d + 1) % 7} week`, isPayWeekKey(key, (d + 1) % 7) === false);
    }
    ok('payWeekStartDayOf reads the stored setting', payWeekStartDayOf({ payWeekStartDay: 1 }) === 1 && payWeekStartDayOf({ payWeekStartDay: 6 }) === 6);
    ok('payWeekStartDayOf defaults to Sunday (unset, null, out of range, not an integer)',
      [undefined, null, {}, { payWeekStartDay: 7 }, { payWeekStartDay: -1 }, { payWeekStartDay: '1' }, { payWeekStartDay: 1.5 }]
        .every((o) => payWeekStartDayOf(o) === 0));
  }
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const route = strip(readFileSync(new URL('../api/time/[...path].js', import.meta.url), 'utf8'));
  const stub = strip(readFileSync(new URL('../src/lib/timeApi.js', import.meta.url), 'utf8'));
  const otBranch = (src, marker) => { const i = src.indexOf(marker); return i < 0 ? '' : src.slice(i, i + 2200); };
  const routeOt = otBranch(route, "action === 'ot-approve'");
  const stubOt = otBranch(stub, 'function stubApproveOvertime');
  ok('the route\'s ot-approve judges the key with the shared rule', /isPayWeekKey\(/.test(routeOt) && /payWeekStartDayOf\(/.test(routeOt), routeOt.slice(0, 200));
  ok('…reading the week start from the org\'s opsSettings', /opsSettings:state->opsSettings/.test(routeOt), routeOt.slice(0, 300));
  ok('the demo stub\'s ot-approve uses the same rule', /isPayWeekKey\(/.test(stubOt) && /payWeekStartDayOf\(/.test(stubOt), stubOt.slice(0, 200));
  ok('no Sunday-only week check survives in either', !/dayOfWeekKey\([^)]*weekKey\)\s*!==\s*0/.test(route + stub));
}

console.log(`\not-approve-week-start: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
}
