// The weekly OT ledger (spec §4.2) — PURE, no backend. Proves computeWeekLedger walks
// the 40 h line over WORKED minutes (approved or pending), allocates each OT unit's
// APPROVED minutes to that unit's approved OT items in walk order, holds the rest, and
// pays an unapproved item nothing. The equality case pins that with everything approved
// (and OT fully approved) it agrees, per user, with lib/payroll.attributeWeeklyOt.
//
//   node scripts/test-ot-ledger.mjs
import { computeWeekLedger, entryFromRow, otApprovalFromRow } from '../src/lib/otLedger.js';
import { OT_WEEKLY_MINUTES, attributeWeeklyOt } from '../src/lib/payroll.js';

const TZ = 'America/New_York';
let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// ── builders (neutral camelCase, what timeApi.rollup / the variance mapper produce) ──
const isoAt = (s) => new Date(s).toISOString();
function labor({ id, userId = 'u1', userName, clientId = 'cl_a', inAt, mins, approved = false, status = 'completed', cancelled = false }) {
  const clockInAt = isoAt(inAt);
  const clockOutAt = new Date(Date.parse(clockInAt) + mins * 60000).toISOString();
  return {
    id, userId, userName: userName || userId, clientId, siteId: null,
    durationMinutes: mins, clockInAt, clockOutAt,
    approvalStatus: approved ? 'approved' : 'pending', status,
    jobCancelledAt: cancelled ? clockOutAt : null,
  };
}
function seg({ key, userId = 'u1', toClientId = 'cl_a', toEntryId = 'te_to', fromEntryId = 'te_from', startAt, mins, fromApproved = false, toApproved = false, fromStatus = 'completed', toStatus = 'completed' }) {
  const startIso = isoAt(startAt);
  return {
    key, userId, userName: userId,
    startAt: startIso, endAt: new Date(Date.parse(startIso) + mins * 60000).toISOString(),
    fromEntryId, toEntryId, fromSiteId: null, toSiteId: null,
    toClientId, actualMinutes: mins, paidMinutes: mins,
    fromStatus, toStatus,
    fromApprovalStatus: fromApproved ? 'approved' : 'pending',
    toApprovalStatus: toApproved ? 'approved' : 'pending',
  };
}
const ot = (userId, weekKey, clientId, minutes) => ({ userId, weekKey, clientId, approvedOtMinutes: minutes });
const unitOf = (ledger, userId, weekKey, clientId) => ledger.otUnits.find((u) => u.userId === userId && u.weekKey === weekKey && u.clientId === clientId);
const itemOf = (ledger, id) => ledger.items.find((it) => it.id === id);

// ═══ 1. DST week (America/New_York, fall-back Sun 2026-11-01) ════════════════════
// Two punches in the same pay week either side of the 2 AM fall-back must bucket into
// the ONE week 2026-11-01, and the 40 h line is minute-based (DST doesn't add minutes).
{
  const entries = [
    labor({ id: 'a', inAt: '2026-11-01T14:00:00-04:00', mins: 24 * 60 }), // Sun (EDT)
    labor({ id: 'b', inAt: '2026-11-05T14:00:00-05:00', mins: 24 * 60 }), // Thu (EST) — 48 h total
  ];
  const led = computeWeekLedger({ entries, driveSegments: [], otApprovals: [], tz: TZ });
  ok('DST week: both punches bucket into 2026-11-01', itemOf(led, 'a').weekKey === '2026-11-01' && itemOf(led, 'b').weekKey === '2026-11-01', JSON.stringify(led.items.map((i) => [i.id, i.weekKey])));
  const u = unitOf(led, 'u1', '2026-11-01', 'cl_a');
  ok('DST week: 48 h worked → 8 h due OT at the unit', u && u.dueMinutes === 48 * 60 - OT_WEEKLY_MINUTES, JSON.stringify(u));
}

// ═══ 2. one cleaner's OT split across two customers, walk order ═══════════════════
// Mon 30 h at cl_a, Tue 20 h at cl_b (50 h total, week of Sun 2026-06-07). The 40 h line
// falls inside the Tue punch: cl_a all regular, cl_b 10 h regular + 10 h OT → OT is a
// cl_b unit only.
{
  const entries = [
    labor({ id: 'mon', clientId: 'cl_a', inAt: '2026-06-08T08:00:00-04:00', mins: 30 * 60, approved: true }),
    labor({ id: 'tue', clientId: 'cl_b', inAt: '2026-06-09T08:00:00-04:00', mins: 20 * 60, approved: true }),
  ];
  const led = computeWeekLedger({ entries, driveSegments: [], otApprovals: [], tz: TZ });
  const ua = unitOf(led, 'u1', '2026-06-07', 'cl_a');
  const ub = unitOf(led, 'u1', '2026-06-07', 'cl_b');
  ok('two customers: cl_a has 0 OT due', ua && ua.dueMinutes === 0, JSON.stringify(ua));
  ok('two customers: cl_b has 10 h OT due', ub && ub.dueMinutes === 10 * 60, JSON.stringify(ub));
  ok('two customers: the OT lands on the cl_b (Tue) item', itemOf(led, 'tue').otMinutes === 10 * 60 && itemOf(led, 'mon').otMinutes === 0, `${itemOf(led, 'mon').otMinutes}/${itemOf(led, 'tue').otMinutes}`);
}

// ═══ 3. approval below / above due ═══════════════════════════════════════════════
// 50 h approved at one customer → 10 h OT due. Approve 6 h: 6 h payable, 4 h held.
{
  const entries = [labor({ id: 'x', inAt: '2026-06-08T00:00:00-04:00', mins: 50 * 60, approved: true })];
  const below = computeWeekLedger({ entries, driveSegments: [], otApprovals: [ot('u1', '2026-06-07', 'cl_a', 6 * 60)], tz: TZ });
  const bx = itemOf(below, 'x');
  ok('approval below due: 6 h payable OT, 4 h held', bx.payableOtMinutes === 6 * 60 && bx.heldOtMinutes === 4 * 60, JSON.stringify(bx));
  ok('approval below due: payable regular = 40 h (the item is approved)', bx.payableRegularMinutes === OT_WEEKLY_MINUTES, `${bx.payableRegularMinutes}`);
  const ub = unitOf(below, 'u1', '2026-06-07', 'cl_a');
  ok('approval below due: awaiting = 10 h − 6 h', ub.dueMinutes === 10 * 60 && ub.approvedMinutes === 6 * 60 && ub.awaitingMinutes === 4 * 60, JSON.stringify(ub));
  // Approve MORE than due: all 10 h payable, none held, awaiting 0.
  const above = computeWeekLedger({ entries, driveSegments: [], otApprovals: [ot('u1', '2026-06-07', 'cl_a', 99 * 60)], tz: TZ });
  const ax = itemOf(above, 'x');
  ok('approval above due: all 10 h payable, 0 held', ax.payableOtMinutes === 10 * 60 && ax.heldOtMinutes === 0, JSON.stringify(ax));
  ok('approval above due: awaiting = 0', unitOf(above, 'u1', '2026-06-07', 'cl_a').awaitingMinutes === 0, JSON.stringify(unitOf(above, 'u1', '2026-06-07', 'cl_a')));
}

// ═══ 4. pending items count toward 40 h but pay nothing ══════════════════════════
// Mon 30 h APPROVED, Tue 20 h PENDING. The pending punch pushes the week to 50 h, so the
// approved Mon punch is entirely regular (correct — approving Tue later never moves OT
// onto an already-paid punch). Tue is worked (counts) but pays $0 (pending).
{
  const entries = [
    labor({ id: 'mon', inAt: '2026-06-08T00:00:00-04:00', mins: 30 * 60, approved: true }),
    labor({ id: 'tue', inAt: '2026-06-09T00:00:00-04:00', mins: 20 * 60, approved: false }),
  ];
  const led = computeWeekLedger({ entries, driveSegments: [], otApprovals: [ot('u1', '2026-06-07', 'cl_a', 99 * 60)], tz: TZ });
  const mon = itemOf(led, 'mon');
  const tue = itemOf(led, 'tue');
  ok('pending counts toward 40 h: Mon (approved) is all regular, no OT moved onto it', mon.regularMinutes === 30 * 60 && mon.otMinutes === 0 && mon.payableRegularMinutes === 30 * 60, JSON.stringify(mon));
  ok('pending pays nothing: Tue has 10 h OT in the walk but 0 payable regular AND 0 payable OT', tue.otMinutes === 10 * 60 && tue.payableRegularMinutes === 0 && tue.payableOtMinutes === 0, JSON.stringify(tue));
  ok('pending: the unit still shows 10 h due (worked OT), awaiting the punch+OT approval', unitOf(led, 'u1', '2026-06-07', 'cl_a').dueMinutes === 10 * 60, JSON.stringify(unitOf(led, 'u1', '2026-06-07', 'cl_a')));
}

// ═══ 5. voided / rejected excluded ═══════════════════════════════════════════════
{
  const entries = [
    labor({ id: 'good', inAt: '2026-06-08T00:00:00-04:00', mins: 8 * 60, approved: true }),
    labor({ id: 'void', inAt: '2026-06-09T00:00:00-04:00', mins: 40 * 60, status: 'voided' }),
    { ...labor({ id: 'rej', inAt: '2026-06-10T00:00:00-04:00', mins: 40 * 60 }), approvalStatus: 'rejected' },
  ];
  const led = computeWeekLedger({ entries, driveSegments: [], otApprovals: [], tz: TZ });
  ok('voided / rejected are not worked items', led.items.length === 1 && led.items[0].id === 'good', JSON.stringify(led.items.map((i) => i.id)));
  ok('voided / rejected: no OT due (only 8 h worked)', (unitOf(led, 'u1', '2026-06-07', 'cl_a') || {}).dueMinutes === 0, JSON.stringify(led.otUnits));
}

// ═══ 6. drive legs: both ends approved vs one pending ════════════════════════════
// 39 h of approved labor + a 2 h drive leg (61-min gap counts as worked travel toward
// the 40 h line). The leg is attributed to its DESTINATION customer/entry.
{
  const base = [labor({ id: 'lab', clientId: 'cl_a', inAt: '2026-06-08T00:00:00-04:00', mins: 39 * 60, approved: true })];
  const bothApproved = seg({ key: 'seg1', toClientId: 'cl_b', toEntryId: 'te_dest', startAt: '2026-06-09T00:00:00-04:00', mins: 120, fromApproved: true, toApproved: true });
  const led1 = computeWeekLedger({ entries: base, driveSegments: [bothApproved], otApprovals: [ot('u1', '2026-06-07', 'cl_b', 99 * 60)], tz: TZ });
  const d1 = itemOf(led1, 'seg1');
  ok('drive leg: attributed to the destination customer + entry', d1 && d1.clientId === 'cl_b' && d1.entryId === 'te_dest' && d1.kind === 'drive', JSON.stringify(d1));
  ok('drive leg both-approved: 39 h + 2 h = 41 h → 1 h OT on the leg, payable when approved', d1.otMinutes === 60 && d1.payableOtMinutes === 60, JSON.stringify(d1));
  // Same leg but its DESTINATION punch is pending → the leg is worked (counts toward 40 h)
  // but not approved (pays no OT).
  const onePending = seg({ key: 'seg1', toClientId: 'cl_b', toEntryId: 'te_dest', startAt: '2026-06-09T00:00:00-04:00', mins: 120, fromApproved: true, toApproved: false });
  const led2 = computeWeekLedger({ entries: base, driveSegments: [onePending], otApprovals: [ot('u1', '2026-06-07', 'cl_b', 99 * 60)], tz: TZ });
  const d2 = itemOf(led2, 'seg1');
  ok('drive leg one-pending: still 1 h OT in the walk but 0 payable', d2.otMinutes === 60 && d2.payableOtMinutes === 0 && d2.approved === false, JSON.stringify(d2));
}

// ═══ 7. missing client → '' unit ═════════════════════════════════════════════════
{
  const entries = [{ ...labor({ id: 'noc', inAt: '2026-06-08T00:00:00-04:00', mins: 50 * 60, approved: true }), clientId: null }];
  const led = computeWeekLedger({ entries, driveSegments: [], otApprovals: [], tz: TZ });
  ok("no-customer punch buckets to the '' unit", itemOf(led, 'noc').clientId === '' && !!unitOf(led, 'u1', '2026-06-07', ''), JSON.stringify(led.otUnits));
}

// ═══ 8. equality with attributeWeeklyOt when EVERYTHING is approved ═══════════════
// All labor + drive approved, OT fully approved per unit → the ledger's payable reg/OT,
// summed per user, must equal attributeWeeklyOt's reg/OT (approvedOnly). The source of
// truth for the walk, so the two engines can never drift.
{
  const entries = [
    labor({ id: 'e1', userId: 'uA', clientId: 'cl_a', inAt: '2026-06-08T07:00:00-04:00', mins: 11 * 60, approved: true }),
    labor({ id: 'e2', userId: 'uA', clientId: 'cl_b', inAt: '2026-06-09T07:00:00-04:00', mins: 11 * 60, approved: true }),
    labor({ id: 'e3', userId: 'uA', clientId: 'cl_a', inAt: '2026-06-10T07:00:00-04:00', mins: 11 * 60, approved: true }),
    labor({ id: 'e4', userId: 'uA', clientId: 'cl_b', inAt: '2026-06-11T07:00:00-04:00', mins: 11 * 60, approved: true }),
    labor({ id: 'e5', userId: 'uB', clientId: 'cl_a', inAt: '2026-06-08T07:00:00-04:00', mins: 20 * 60, approved: true }),
  ];
  const drive = [seg({ key: 'sA', userId: 'uA', toClientId: 'cl_b', toEntryId: 'te_e4', startAt: '2026-06-11T20:00:00-04:00', mins: 45, fromApproved: true, toApproved: true })];
  // Fully approve every unit's OT.
  const led = computeWeekLedger({ entries, driveSegments: drive, otApprovals: [
    ot('uA', '2026-06-07', 'cl_a', 99 * 60), ot('uA', '2026-06-07', 'cl_b', 99 * 60), ot('uB', '2026-06-07', 'cl_a', 99 * 60),
  ], tz: TZ });
  const attr = attributeWeeklyOt(entries, { approvedOnly: true, tz: TZ, driveSegments: drive });
  for (const userId of ['uA', 'uB']) {
    const ledReg = led.items.filter((i) => i.userId === userId).reduce((s, i) => s + i.payableRegularMinutes, 0);
    const ledOt = led.items.filter((i) => i.userId === userId).reduce((s, i) => s + i.payableOtMinutes, 0);
    const attrReg = attr.filter((i) => i.userId === userId).reduce((s, i) => s + i.regularMinutes, 0);
    const attrOt = attr.filter((i) => i.userId === userId).reduce((s, i) => s + i.otMinutes, 0);
    ok(`equality (${userId}): payable regular == attributeWeeklyOt regular`, ledReg === attrReg, `ledger ${ledReg} vs attr ${attrReg}`);
    ok(`equality (${userId}): payable OT == attributeWeeklyOt OT`, ledOt === attrOt, `ledger ${ledOt} vs attr ${attrOt}`);
  }
}

// ═══ 9. the snake_case → neutral mappers the server uses ═════════════════════════
{
  const row = { id: 'r1', user_id: 'u1', user_name: 'Ann', client_id: 'cl_a', site_id: 's1', duration_minutes: 2460, clock_in_at: '2026-06-08T00:00:00-04:00', clock_out_at: '2026-06-09T17:00:00-04:00', approval_status: 'approved', status: 'completed', job_cancelled_at: null };
  const led = computeWeekLedger({ entries: [entryFromRow(row)], driveSegments: [], otApprovals: [], tz: TZ });
  ok('entryFromRow maps a snake_case row into a worked item', led.items.length === 1 && led.items[0].userId === 'u1' && led.items[0].minutes === 2460, JSON.stringify(led.items[0] || null));
  const a = otApprovalFromRow({ user_id: 'u1', week_key: '2026-06-07', client_id: '', approved_ot_minutes: 120 });
  ok('otApprovalFromRow maps a snake_case OT row', a.userId === 'u1' && a.weekKey === '2026-06-07' && a.clientId === '' && a.approvedOtMinutes === 120, JSON.stringify(a));
}

console.log(`\not-ledger: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
