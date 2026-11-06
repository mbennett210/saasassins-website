// The Hours Approval queue, grouped by PERSON (the manager view redesign, 2026-10-09; plan
// docs/plans/2026-10-09-manager-view-redesign.md S4–S6, brief C §1).
//
// Matt's answered rule stands: EVERY clock-in and clock-out is approved before payroll (S106).
// Only the screen groups the punches; each approval is still the per-punch
// `timeApi.approveEntries` call. What this pins:
//   1. a person's totals are the sum of THEIR punches, and the reg/OT split is the approvals
//      read's own `ot_minutes` (the shared lib/otLedger walk), never a 40-hour rule of the screen's;
//   2. a person with ANY flag (punchFlagMessages) is a "Review" person (S5);
//   3. "Approve all" never sends a flagged person's punches — not even their clean ones — and
//      counts what it skipped (S6);
//   4. the batch is cut at the server's own per-call cap, one constant on both sides;
//   5. "due" is the pay period's last day from the stored pay settings (S4: never "Friday");
//   6. the page drives the grouping and the plan, not a second reading of them.
//
// Every function is read off the module at run time, so on a tree without them each check
// FAILS with a count instead of the file dying on a missing export.
//
//   node app/scripts/test-approvals-by-person.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as TA from '../src/lib/filters/timeApprovals.js';
import { payPeriodRange } from '../src/lib/payroll.js';
import { english } from '../src/i18n/core.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n');
const TZ = 'America/New_York';

let pass = 0;
const fails = [];
// ok(label, fn): fn returns a truthy value to pass; a throw is a fail with its message.
const ok = (label, fn, detail = () => '') => {
  let good = false;
  let why = '';
  try { good = !!fn(); } catch (e) { why = e.message; }
  if (good) pass += 1;
  else fails.push(`${label}${why ? `\n      threw: ${why}` : ''}${!why && detail() ? `\n      ${detail()}` : ''}`);
};
const has = (name) => typeof TA[name] === 'function';
const need = (name) => { if (!has(name)) throw new Error(`lib/filters/timeApprovals.js has no ${name}()`); return TA[name]; };

// A pending punch as /api/time/approvals returns it: snake_case, closed, with ot_minutes.
let seq = 0;
const punch = (userId, name, clientId, clientName, dur, extra = {}) => ({
  id: `e${++seq}`, row_version: 1, user_id: userId, user_name: name,
  client_id: clientId, client_name: clientName, site_id: `s_${clientId}`, site_name: `${clientName} site`,
  clock_in_at: extra.clock_in_at || `2026-10-0${(seq % 8) + 1}T22:00:00.000Z`,
  clock_out_at: '2026-10-09T02:00:00.000Z',
  duration_minutes: dur, ot_minutes: 0, approval_status: 'pending', status: 'closed',
  geofence_result: 'inside', geofence_result_out: 'inside',
  ...extra,
});

const manager = { id: 'mgr1', role: 'manager' };
const rows = [
  // Priya: two clean punches at one building.
  punch('u_priya', 'Priya N.', 'cl_a', 'Huizenga Park', 240),
  punch('u_priya', 'Priya N.', 'cl_a', 'Huizenga Park', 210),
  // Keisha: one clean punch and one OFF-SITE punch at another building.
  punch('u_keisha', 'Keisha B.', 'cl_b', 'Lime Tree', 300),
  punch('u_keisha', 'Keisha B.', 'cl_c', 'Coral Ridge', 180, { geofence_result_out: 'outside', clock_out_distance_m: 400 }),
  // Denise: overtime from the ledger (her ONLY flag is the OT chip).
  punch('u_denise', 'Denise K.', 'cl_c', 'Coral Ridge', 480, { ot_minutes: 120 }),
  // Tomas: two buildings, clean.
  punch('u_tomas', 'Tomas R.', 'cl_a', 'Huizenga Park', 120),
  punch('u_tomas', 'Tomas R.', 'cl_b', 'Lime Tree', 90),
  // The manager's OWN punch: nobody but a Super Admin approves it (the own-time rule).
  punch('mgr1', 'Dana K.', 'cl_a', 'Huizenga Park', 60),
];

// ═══ 1. totals are the sum of the person's punches; reg/OT are the read's ═══════════
ok('A1 pendingByPerson exists', () => has('pendingByPerson'));
{
  const people = () => need('pendingByPerson')(rows, manager);
  const byId = () => new Map(people().map((p) => [p.userId, p]));
  ok('A2 one row per cleaner (5 people for 8 punches)', () => people().length === 5, () => JSON.stringify(people().map((p) => p.userId)));
  for (const uid of ['u_priya', 'u_keisha', 'u_denise', 'u_tomas', 'mgr1']) {
    ok(`A3 ${uid}: worked = Σ duration_minutes of their punches`, () => {
      const p = byId().get(uid);
      const own = rows.filter((r) => r.user_id === uid);
      return p.punches === own.length && p.workedMinutes === own.reduce((s, r) => s + r.duration_minutes, 0);
    }, () => JSON.stringify(byId().get(uid)));
    ok(`A4 ${uid}: OT = Σ ot_minutes (the approvals read), reg = worked − OT`, () => {
      const p = byId().get(uid);
      const own = rows.filter((r) => r.user_id === uid);
      const ot = own.reduce((s, r) => s + r.ot_minutes, 0);
      return p.otMinutes === ot && p.regMinutes === p.workedMinutes - ot;
    }, () => JSON.stringify(byId().get(uid)));
  }
  ok('A5 Denise\'s 8h with 2h OT reads 6h reg + 2h OT', () => {
    const d = byId().get('u_denise');
    return d.regMinutes === 360 && d.otMinutes === 120;
  });
  ok('A6 one building is named, two are counted', () => {
    const m = byId();
    return m.get('u_priya').places.length === 1 && m.get('u_priya').places[0].name === 'Huizenga Park'
      && m.get('u_tomas').places.length === 2;
  }, () => JSON.stringify([...byId().values()].map((p) => [p.userId, p.places])));
  ok('A7 people are ordered by name', () => people().map((p) => p.userName).join('|') === 'Dana K.|Denise K.|Keisha B.|Priya N.|Tomas R.',
    () => people().map((p) => p.userName).join('|'));
  ok('A8 a person\'s punches keep every row (none dropped, none shared)', () => {
    const all = people().flatMap((p) => p.rows.map((r) => r.id)).sort();
    return JSON.stringify(all) === JSON.stringify(rows.map((r) => r.id).sort());
  });
}

// ═══ 2. any flag makes a Review person (S5) ═════════════════════════════════════════
{
  const byId = () => new Map(need('pendingByPerson')(rows, manager).map((p) => [p.userId, p]));
  ok('B1 one off-site punch flags Keisha', () => byId().get('u_keisha').flagged === true);
  ok('B2 …and the flag is counted per punch (1 of 2)', () => byId().get('u_keisha').flaggedPunches === 1);
  ok('B3 overtime alone flags Denise (the OT chip is a flag)', () => byId().get('u_denise').flagged === true);
  ok('B4 clean punches leave Priya and Tomas unflagged', () => !byId().get('u_priya').flagged && !byId().get('u_tomas').flagged);
  ok('B5 the person\'s chips are their punches\' chips, each once', () => {
    const k = byId().get('u_keisha');
    const want = [...new Set(k.rows.flatMap((r) => TA.punchFlags(r)))];
    return want.length > 0 && JSON.stringify(k.flags.map((m) => english(m))) === JSON.stringify(want);
  }, () => JSON.stringify(byId().get('u_keisha').flags));
  ok('B6 flagged = some punch has punchFlagMessages (the queue\'s own flag set)', () => {
    for (const p of need('pendingByPerson')(rows, manager)) {
      if (p.flagged !== p.rows.some((r) => TA.punchFlagMessages(r).length > 0)) return false;
    }
    return true;
  });
}

// ═══ 3. Approve all never sends a flagged punch (S6) ═══════════════════════════════
ok('C1 approveAllPlan exists', () => has('approveAllPlan'));
{
  const plan = () => need('approveAllPlan')(need('pendingByPerson')(rows, manager));
  const flaggedIds = new Set(rows.filter((r) => TA.punchFlagMessages(r).length > 0).map((r) => r.id));
  ok('C2 no flagged punch is in the batch', () => plan().items.every((i) => !flaggedIds.has(i.entryId)), () => JSON.stringify(plan().items));
  ok('C3 Keisha\'s CLEAN punch is not sent either: a flagged person waits whole', () => {
    const keishaClean = rows.find((r) => r.user_id === 'u_keisha' && TA.punchFlagMessages(r).length === 0);
    return !plan().items.some((i) => i.entryId === keishaClean.id);
  });
  ok('C4 Priya\'s and Tomas\'s punches are all sent', () => {
    const want = rows.filter((r) => r.user_id === 'u_priya' || r.user_id === 'u_tomas').map((r) => r.id).sort();
    return JSON.stringify(plan().items.map((i) => i.entryId).sort()) === JSON.stringify(want);
  }, () => JSON.stringify(plan().items));
  ok('C5 the manager\'s own punch is never sent (the own-time rule)', () => !plan().items.some((i) => rows.find((r) => r.id === i.entryId)?.user_id === 'mgr1'));
  ok('C6 it says how many it skipped: 2 people need a look', () => plan().skipped === 2, () => JSON.stringify({ skipped: plan().skipped }));
  ok('C7 …and how many it approves: 2 people', () => plan().people.length === 2);
  ok('C8 each item carries the version the manager saw', () => plan().items.every((i) => i.version === 1));
  ok('C9 a Super Admin\'s Approve all includes their own clean punch', () => {
    const p = need('approveAllPlan')(need('pendingByPerson')(rows, { id: 'mgr1', role: 'owner' }));
    return p.items.some((i) => rows.find((r) => r.id === i.entryId)?.user_id === 'mgr1');
  });
  ok('C10 everyone flagged → nothing sent, all counted as skipped', () => {
    const only = rows.filter((r) => r.user_id === 'u_keisha' || r.user_id === 'u_denise');
    const p = need('approveAllPlan')(need('pendingByPerson')(only, manager));
    return p.items.length === 0 && p.skipped === 2;
  });
}

// ═══ 4. the batch is cut at the server's own cap ═══════════════════════════════════
ok('D1 APPROVE_BATCH_MAX is exported', () => Number.isInteger(TA.APPROVE_BATCH_MAX) && TA.APPROVE_BATCH_MAX > 0);
ok('D2 chunkApproveItems cuts 450 into 200 · 200 · 50', () => {
  const items = Array.from({ length: 450 }, (_, i) => ({ entryId: `x${i}`, version: 1 }));
  const chunks = need('chunkApproveItems')(items);
  return chunks.length === 3 && chunks[0].length === TA.APPROVE_BATCH_MAX && chunks[2].length === 450 - 2 * TA.APPROVE_BATCH_MAX
    && chunks.flat().length === 450;
});
ok('D3 the approve route refuses above the SAME constant (one number, both sides)', () => {
  const src = read('api/time/[...path].js');
  // The punch-approve action only (ot-approve, the overtime route below it, keeps its own cap).
  const block = src.slice(src.indexOf("if (action === 'approve'"), src.indexOf("if (action === 'ot-approve'"));
  return /APPROVE_BATCH_MAX,?\s*\n?\}? from '\.\.\/\.\.\/src\/lib\/filters\/timeApprovals\.js'/.test(src)
    && /items\.length > APPROVE_BATCH_MAX\)/.test(block) && !/items\.length > \d+\)/.test(block);
});

// ═══ 5. due = the pay period's last day (S4) ═══════════════════════════════════════
ok('E1 pendingDueKey exists', () => has('pendingDueKey'));
{
  const semi = { payPeriodCadence: 'semimonthly', payWeekStartDay: 0 };
  const due = (args) => need('pendingDueKey')({ tz: TZ, ...args });
  ok('E2 semi-monthly, Oct 9 → the 15th', () => due({ rows: [], opsSettings: semi, now: new Date('2026-10-09T16:00:00Z') }) === '2026-10-15');
  ok('E3 semi-monthly, Oct 20 → the month\'s end', () => due({ rows: [], opsSettings: semi, now: new Date('2026-10-20T16:00:00Z') }) === '2026-10-31');
  ok('E4 the OLDEST pending punch decides: a punch on Oct 14 is due the 15th even on Oct 17', () => due({
    rows: [{ clock_in_at: '2026-10-16T22:00:00Z' }, { clock_in_at: '2026-10-14T22:00:00Z' }],
    opsSettings: semi, now: new Date('2026-10-17T16:00:00Z'),
  }) === '2026-10-15');
  ok('E5 it is payPeriodRange\'s own toKey (no second calendar)', () => {
    const now = new Date('2026-10-09T16:00:00Z');
    return due({ rows: [], opsSettings: { payPeriodCadence: 'weekly', payWeekStartDay: 1 }, now }) === payPeriodRange('weekly', 0, now, TZ, 1).toKey;
  });
  ok('E6 an unset cadence reads as biweekly, as the pay run reads it', () => {
    const now = new Date('2026-10-09T16:00:00Z');
    return due({ rows: [], opsSettings: {}, now }) === payPeriodRange('biweekly', 0, now, TZ, 0).toKey;
  });
}

// ═══ 6. the page drives the grouping and the plan ═════════════════════════════════
{
  const src = read('src/pages/Approvals.jsx');
  ok('F1 the To approve tab groups with pendingByPerson', () => /pendingByPerson\(/.test(src));
  ok('F2 Approve all runs approveAllPlan, never its own filter', () => /approveAllPlan\(/.test(src));
  ok('F3 every approve goes out in chunkApproveItems batches', () => /chunkApproveItems\(/.test(src));
  ok('F4 the header names the due day from pendingDueKey', () => /pendingDueKey\(/.test(src));
  ok('F5 a flagged person gets Review, not Approve', () => /flagged \?/.test(src) && /approvals\.person\.review/.test(src));
  ok('F6 the per-punch select-all bar is gone (replaced by the person rows; II.5)', () => !/approvals\.selectAllAria/.test(src) && !/appr-bulkbar/.test(src));
}

if (fails.length) {
  console.error(`\n✖ test-approvals-by-person: ${fails.length} failed, ${pass} passed\n`);
  for (const f of fails) console.error(`   ✖ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✓ test-approvals-by-person: ${pass} passed`);
}
