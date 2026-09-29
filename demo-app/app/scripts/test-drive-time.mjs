// Headless unit checks for the drive-time engine (src/lib/driveTime.js).
// Run: node scripts/test-drive-time.mjs
import {
  deriveDriveSegments, applyDriveEstimates, applyDriveOverrides, buildDriveReport,
  runDriveReport, collectSitePairs, isSegmentPayable, segmentPaidMinutes,
  stubDriveEstimate, driveEstimateKey, driveSegmentKey,
  driveFlagBadgeVariant, driveFlagLabel,
  DEFAULT_DRIVE_MAX_GAP_MINS, payrollLegFetchWindow, legsDepartingIn, PAYROLL_SHIFT_LOOKBACK_MS,
} from '../src/lib/driveTime.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.error(`FAIL ${name}\n  got : ${g}\n  want: ${w}`); }
};

// entry factory — the neutral camelCase shape the report engines consume.
const mk = (id, { userId = 'u1', userName = 'Ann', siteId = 's1', siteName = 'Site 1', clientId = 'c1', clientName = 'Acme', inAt, outAt = null, status = 'completed', approvalStatus = 'approved' } = {}) => ({
  id, userId, userName, siteId, siteName, clientId, clientName,
  clockInAt: inAt, clockOutAt: outAt, status, approvalStatus,
});
const D = (h, m = 0, day = 6) => `2026-07-0${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

// ── derivation: the core shape ───────────────────────────────────────────────
const twoCleans = [
  mk('e1', { inAt: D(8), outAt: D(10) }),
  mk('e2', { siteId: 's2', siteName: 'Site 2', inAt: D(10, 25), outAt: D(12) }),
];
const segs = deriveDriveSegments(twoCleans);
eq('one segment between two cleans', segs.length, 1);
eq('segment minutes = clock-out -> clock-in gap', segs[0].actualMinutes, 25);
eq('segment key is the entry pair', segs[0].key, driveSegmentKey('e1', 'e2'));
eq('segment carries both sites', [segs[0].fromSiteId, segs[0].toSiteId], ['s1', 's2']);
eq('segment starts at the clock-out', segs[0].startAt, D(10));

// ── the day's first and last legs are never recorded ─────────────────────────
eq('single clean of the day -> no segment', deriveDriveSegments([mk('e1', { inAt: D(8), outAt: D(10) })]).length, 0);
eq('empty input', deriveDriveSegments([]).length, 0);
eq('null input', deriveDriveSegments(null).length, 0);
// Three cleans = exactly two legs (home->first and last->home are unrepresentable).
const three = deriveDriveSegments([
  mk('e1', { inAt: D(8), outAt: D(10) }),
  mk('e2', { siteId: 's2', inAt: D(10, 20), outAt: D(12) }),
  mk('e3', { siteId: 's3', inAt: D(12, 30), outAt: D(14) }),
]);
eq('three cleans -> two legs', three.map((s) => s.actualMinutes), [20, 30]);

// ── the gap cap is what separates a drive from going home ────────────────────
const longGap = [mk('e1', { inAt: D(8), outAt: D(10) }), mk('e2', { siteId: 's2', inAt: D(14), outAt: D(16) })];
eq('4h gap exceeds the 3h default cap', deriveDriveSegments(longGap).length, 0);
eq('...but is a segment with a wider cap', deriveDriveSegments(longGap, { maxGapMins: 300 })[0].actualMinutes, 240);
eq('default cap constant', DEFAULT_DRIVE_MAX_GAP_MINS, 180);
eq('gap exactly at the cap is kept', deriveDriveSegments(longGap, { maxGapMins: 240 }).length, 1);

// ── midnight crossing (night crew) — no calendar-day logic ───────────────────
const overnight = [
  mk('e1', { inAt: '2026-07-06T21:00:00.000Z', outAt: '2026-07-06T23:40:00.000Z' }),
  mk('e2', { siteId: 's2', inAt: '2026-07-07T00:10:00.000Z', outAt: '2026-07-07T02:00:00.000Z' }),
];
eq('drive across midnight is one segment', deriveDriveSegments(overnight).map((s) => s.actualMinutes), [30]);

// ── auto-close: synthetic clock-OUT can't start a drive, real clock-IN can end one ──
const autoPrev = [
  mk('e1', { inAt: D(8), outAt: D(10), status: 'auto_closed' }),
  mk('e2', { siteId: 's2', inAt: D(10, 20), outAt: D(12) }),
];
eq('auto_closed PREV starts no segment', deriveDriveSegments(autoPrev).length, 0);
const autoNext = [
  mk('e1', { inAt: D(8), outAt: D(10) }),
  mk('e2', { siteId: 's2', inAt: D(10, 20), outAt: D(12), status: 'auto_closed' }),
];
eq('auto_closed NEXT still ends a segment', deriveDriveSegments(autoNext).map((s) => s.actualMinutes), [20]);

// ── voided rows are TRANSPARENT (they restore the real leg, not break it) ────
const withVoid = [
  mk('e1', { inAt: D(8), outAt: D(10) }),
  mk('eX', { siteId: 's9', inAt: D(10, 5), outAt: D(10, 7), status: 'voided' }),  // wrong-job punch
  mk('e2', { siteId: 's2', inAt: D(10, 25), outAt: D(12) }),
];
const voidSegs = deriveDriveSegments(withVoid);
eq('voided middle row -> ONE real leg', voidSegs.length, 1);
eq('voided row is invisible, real gap preserved', voidSegs[0].actualMinutes, 25);
eq('voided row is not an endpoint', [voidSegs[0].fromEntryId, voidSegs[0].toEntryId], ['e1', 'e2']);
eq('no_show is transparent too', deriveDriveSegments([
  mk('e1', { inAt: D(8), outAt: D(10) }),
  mk('eY', { inAt: D(10, 5), outAt: D(10, 6), status: 'no_show' }),
  mk('e2', { siteId: 's2', inAt: D(10, 25), outAt: D(12) }),
]).length, 1);

// ── open rows: no drive OUT of one, but a drive INTO one ─────────────────────
eq('open PREV (no clock-out) -> no segment', deriveDriveSegments([
  mk('e1', { inAt: D(8), outAt: null, status: 'in_progress' }),
  mk('e2', { siteId: 's2', inAt: D(10, 20) }),
]).length, 0);
const intoOpen = deriveDriveSegments([
  mk('e1', { inAt: D(8), outAt: D(10) }),
  mk('e2', { siteId: 's2', inAt: D(10, 20), outAt: null, status: 'in_progress' }),
]);
eq('drive INTO a still-open clean is recorded', intoOpen.length, 1);
eq('...and marked open', intoOpen[0].toOpen, true);

// ── malformed / degenerate pairs ─────────────────────────────────────────────
eq('overlapping rows (in before out) -> no segment', deriveDriveSegments([
  mk('e1', { inAt: D(8), outAt: D(10) }),
  mk('e2', { siteId: 's2', inAt: D(9, 30), outAt: D(11) }),
]).length, 0);
eq('zero-length gap -> no segment', deriveDriveSegments([
  mk('e1', { inAt: D(8), outAt: D(10) }),
  mk('e2', { siteId: 's2', inAt: D(10), outAt: D(11) }),
]).length, 0);
eq('entry with no clock-in is skipped', deriveDriveSegments([
  mk('e1', { inAt: D(8), outAt: D(10) }),
  mk('e2', { siteId: 's2', inAt: null, outAt: D(11) }),
]).length, 0);

// ── cleaners never pair with each other ──────────────────────────────────────
eq('two cleaners do not pair', deriveDriveSegments([
  mk('e1', { userId: 'u1', inAt: D(8), outAt: D(10) }),
  mk('e2', { userId: 'u2', userName: 'Bob', siteId: 's2', inAt: D(10, 20), outAt: D(12) }),
]).length, 0);
const twoDrivers = deriveDriveSegments([
  mk('a1', { userId: 'u1', inAt: D(8), outAt: D(10) }),
  mk('a2', { userId: 'u1', siteId: 's2', inAt: D(10, 20), outAt: D(12) }),
  mk('b1', { userId: 'u2', userName: 'Bob', inAt: D(8), outAt: D(9) }),
  mk('b2', { userId: 'u2', userName: 'Bob', siteId: 's2', inAt: D(9, 40), outAt: D(11) }),
]);
eq('each cleaner gets their own leg', twoDrivers.map((s) => [s.userId, s.actualMinutes]), [['u2', 40], ['u1', 20]]);

// ── deterministic ordering on identical timestamps ───────────────────────────
const tiedA = deriveDriveSegments([
  mk('zz', { inAt: D(8), outAt: D(10) }),
  mk('aa', { inAt: D(8), outAt: D(9) }),
  mk('e3', { siteId: 's2', inAt: D(10, 30), outAt: D(12) }),
]);
const tiedB = deriveDriveSegments([
  mk('e3', { siteId: 's2', inAt: D(10, 30), outAt: D(12) }),
  mk('aa', { inAt: D(8), outAt: D(9) }),
  mk('zz', { inAt: D(8), outAt: D(10) }),
]);
eq('same-instant clock-ins derive deterministically', tiedA.map((s) => s.key), tiedB.map((s) => s.key));

// ── estimates + the >15% flag ────────────────────────────────────────────────
const legs = deriveDriveSegments(twoCleans);                     // 25-minute leg, s1 -> s2
const lookup = { [driveEstimateKey('s1', 's2')]: { durationMinutes: 20, distanceMeters: 9000, source: 'google' } };
const opts = { flagPct: 15, graceMins: 5 };
// allowed = round(20 * 1.15 + 5) = 28  ->  25 is inside
eq('within estimate+15%+grace is on target', applyDriveEstimates(legs, lookup, opts)[0].flag, 'on_target');
eq('allowed minutes computed', applyDriveEstimates(legs, lookup, opts)[0].allowedMinutes, 28);
eq('over-minutes reported vs the raw estimate', applyDriveEstimates(legs, lookup, opts)[0].overMinutes, 5);
eq('over-percent reported', applyDriveEstimates(legs, lookup, opts)[0].overPct, 25);
const tight = { [driveEstimateKey('s1', 's2')]: { durationMinutes: 10, source: 'google' } };
// allowed = round(10 * 1.15 + 5) = 17  ->  25 is over
eq('beyond estimate+15%+grace flags over', applyDriveEstimates(legs, tight, opts)[0].flag, 'over');
eq('grace floor stops a short-hop false flag', applyDriveEstimates(
  deriveDriveSegments([mk('e1', { inAt: D(8), outAt: D(10) }), mk('e2', { siteId: 's2', inAt: D(10, 8), outAt: D(11) })]),
  { [driveEstimateKey('s1', 's2')]: { durationMinutes: 4 } }, opts,
)[0].flag, 'on_target');
eq('zero-pct config flags anything past the grace', applyDriveEstimates(legs, tight, { flagPct: 0, graceMins: 0 })[0].flag, 'over');
eq('missing estimate -> no_estimate (never an implicit zero)', applyDriveEstimates(legs, {}, opts)[0].flag, 'no_estimate');
eq('missing estimate carries no over-minutes', applyDriveEstimates(legs, {}, opts)[0].overMinutes, null);
eq('lookup may be a Map', applyDriveEstimates(legs, new Map(Object.entries(lookup)), opts)[0].estimateMinutes, 20);
eq('lookup may be a function', applyDriveEstimates(legs, (f, t) => (f === 's1' && t === 's2' ? { durationMinutes: 20 } : null), opts)[0].estimateMinutes, 20);
eq('estimates are DIRECTIONAL (b->a miss stays unestimated)', applyDriveEstimates(legs, { [driveEstimateKey('s2', 's1')]: { durationMinutes: 20 } }, opts)[0].flag, 'no_estimate');

// same-site + siteless
const sameSite = deriveDriveSegments([
  mk('e1', { inAt: D(8), outAt: D(10) }),
  mk('e2', { inAt: D(10, 40), outAt: D(12) }), // same s1
]);
eq('same site both ends -> same_site', applyDriveEstimates(sameSite, {}, opts)[0].flag, 'same_site');
eq('same site estimate is zero', applyDriveEstimates(sameSite, {}, opts)[0].estimateMinutes, 0);
const siteless = deriveDriveSegments([
  mk('e1', { siteId: null, inAt: D(8), outAt: D(10) }),
  mk('e2', { siteId: null, inAt: D(10, 40), outAt: D(12) }),
]);
eq('two siteless cleans are NOT "same site"', applyDriveEstimates(siteless, {}, opts)[0].flag, 'no_estimate');

// ── manager overrides ────────────────────────────────────────────────────────
eq('no override -> paid = actual', applyDriveOverrides(legs, [])[0].paidMinutes, 25);
eq('excluded -> paid 0', applyDriveOverrides(legs, [{ fromEntryId: 'e1', toEntryId: 'e2', excluded: true, reason: 'Personal errand' }])[0].paidMinutes, 0);
eq('adjusted -> paid the ruling', applyDriveOverrides(legs, [{ fromEntryId: 'e1', toEntryId: 'e2', paidMinutes: 15, reason: 'Traffic disputed' }])[0].paidMinutes, 15);
eq('override marks the row adjusted', applyDriveOverrides(legs, [{ fromEntryId: 'e1', toEntryId: 'e2', paidMinutes: 15, reason: 'x' }])[0].adjusted, true);
eq('override never rewrites the recorded actual', applyDriveOverrides(legs, [{ fromEntryId: 'e1', toEntryId: 'e2', paidMinutes: 15, reason: 'x' }])[0].actualMinutes, 25);
eq('negative override clamps to 0', applyDriveOverrides(legs, [{ fromEntryId: 'e1', toEntryId: 'e2', paidMinutes: -5, reason: 'x' }])[0].paidMinutes, 0);
eq('override for another pair does not apply', applyDriveOverrides(legs, [{ fromEntryId: 'zz', toEntryId: 'yy', excluded: true }])[0].paidMinutes, 25);

// ── payability: BOTH bounding cleans gate the travel ─────────────────────────
const paidLeg = applyDriveOverrides(legs, [])[0];
eq('approved both ends is payable', isSegmentPayable(paidLeg, { approvedOnly: true }), true);
eq('pending end blocks the payroll gate', isSegmentPayable({ ...paidLeg, toApprovalStatus: 'pending' }, { approvedOnly: true }), false);
eq('...but the operational lens still counts it', isSegmentPayable({ ...paidLeg, toApprovalStatus: 'pending' }, { approvedOnly: false }), true);
eq('rejected end is never payable', isSegmentPayable({ ...paidLeg, fromApprovalStatus: 'rejected' }, { approvedOnly: false }), false);
eq('voided end is never payable', isSegmentPayable({ ...paidLeg, toStatus: 'voided' }, { approvedOnly: false }), false);
eq('excluded segment pays nothing', segmentPaidMinutes({ ...paidLeg, paidMinutes: 0 }, { approvedOnly: true }), 0);
eq('paid minutes honor the override', segmentPaidMinutes({ ...paidLeg, paidMinutes: 15 }, { approvedOnly: true }), 15);

// ── report assembly ──────────────────────────────────────────────────────────
const many = runDriveReport([
  mk('e1', { inAt: D(8), outAt: D(10) }),
  mk('e2', { siteId: 's2', siteName: 'Site 2', inAt: D(10, 45), outAt: D(12) }),   // 45 min, est 10 -> over
  mk('e3', { siteId: 's3', siteName: 'Site 3', inAt: D(12, 12), outAt: D(14) }),   // 12 min, est 10 -> on target
], {
  estimates: {
    [driveEstimateKey('s1', 's2')]: { durationMinutes: 10, source: 'google' },
    [driveEstimateKey('s2', 's3')]: { durationMinutes: 10, source: 'google' },
  },
  config: { flagPct: 15, graceMins: 5 },
});
eq('worst overage sorts first', many.rows.map((r) => r.flag), ['over', 'on_target']);
eq('summary segment count', many.summary.segmentCount, 2);
eq('summary total drive minutes', many.summary.totalDriveMinutes, 57);
eq('summary payable minutes (no overrides)', many.summary.payableDriveMinutes, 57);
eq('summary flagged count', many.summary.flaggedCount, 1);
eq('summary estimate coverage %', many.summary.estimateCoverage, 100);
eq('summary total over-minutes', many.summary.totalOverMinutes, 37);
eq('summary cleaner count', many.summary.cleanerCount, 1);
const partial = runDriveReport([
  mk('e1', { inAt: D(8), outAt: D(10) }),
  mk('e2', { siteId: 's2', inAt: D(10, 45), outAt: D(12) }),
  mk('e3', { siteId: 's3', inAt: D(12, 12), outAt: D(14) }),
], { estimates: { [driveEstimateKey('s1', 's2')]: { durationMinutes: 10 } }, config: { flagPct: 15, graceMins: 5 } });
eq('partial coverage reported honestly', partial.summary.estimateCoverage, 50);
eq('unestimated leg counted', partial.summary.noEstimateCount, 1);
const overridden = runDriveReport(twoCleans, {
  overrides: [{ fromEntryId: 'e1', toEntryId: 'e2', paidMinutes: 10, reason: 'Stopped for coffee' }],
  config: { flagPct: 15, graceMins: 5 },
});
eq('payable reflects the override', overridden.summary.payableDriveMinutes, 10);
eq('actual is untouched in the summary', overridden.summary.totalDriveMinutes, 25);
eq('adjusted count', overridden.summary.adjustedCount, 1);
eq('empty report summary', buildDriveReport([]).summary.segmentCount, 0);
eq('empty report coverage is null (not 0%)', buildDriveReport([]).summary.estimateCoverage, null);

// ── site-pair collection for the estimate batch ──────────────────────────────
eq('pairs deduped + directional', collectSitePairs([
  { fromSiteId: 's1', toSiteId: 's2' }, { fromSiteId: 's1', toSiteId: 's2' }, { fromSiteId: 's2', toSiteId: 's1' },
]).length, 2);
eq('same-site + siteless pairs are not looked up', collectSitePairs([
  { fromSiteId: 's1', toSiteId: 's1' }, { fromSiteId: null, toSiteId: 's2' }, { fromSiteId: 's1', toSiteId: null },
]).length, 0);

// ── stub estimate (demo / no-key fallback) ───────────────────────────────────
eq('stub estimate needs both coords', stubDriveEstimate({ lat: 47.6, lng: -122.3 }, {}), null);
const stub = stubDriveEstimate({ lat: 47.6062, lng: -122.3321 }, { lat: 47.6740, lng: -122.1215 }); // Seattle -> Bellevue-ish
eq('stub estimate is a plausible drive', stub.durationMinutes > 15 && stub.durationMinutes < 45, true);
eq('stub estimate is labelled as a stub', stub.source, 'estimate_stub');

// ── display vocabulary ───────────────────────────────────────────────────────
eq('over is red', driveFlagBadgeVariant('over'), 'red');
eq('on target is green', driveFlagBadgeVariant('on_target'), 'green');
eq('unknowable states stay slate', [driveFlagBadgeVariant('no_estimate'), driveFlagBadgeVariant('same_site')], ['slate', 'slate']);
eq('labels', [driveFlagLabel('over'), driveFlagLabel('on_target'), driveFlagLabel('same_site'), driveFlagLabel('no_estimate')],
  ['Over estimate', 'On target', 'Same site', 'No estimate']);

// ── payroll mode: a leg belongs to the pay period it DEPARTS in (Reports fix #4) ──
// A pay period is read on its own. Read from only the punches clocked in inside the
// period, a leg that crosses the boundary (clock out 23:50 on the last day, clock in
// 00:20 the next) was paid in NEITHER period — each read held one end of the pair — and
// a leg after a clean begun the evening before the period never derived at all.
// payrollLegFetchWindow widens the punch read (18h back, the gap cap forward) and
// legsDepartingIn keeps the legs that start inside the period, so each is paid once.
{
  const A = { fromIso: '2026-09-01T00:00:00.000Z', toIso: '2026-09-07T23:59:59.999Z' };
  const B = { fromIso: '2026-09-08T00:00:00.000Z', toIso: '2026-09-14T23:59:59.999Z' };
  const gapCap = 90;
  const punches = [
    // straddles the A|B seam: departs 23:50 in A, arrives 00:20 in B
    mk('p1', { inAt: '2026-09-07T21:50:00.000Z', outAt: '2026-09-07T23:50:00.000Z' }),
    mk('p2', { siteId: 's2', inAt: '2026-09-08T00:20:00.000Z', outAt: '2026-09-08T02:20:00.000Z' }),
    // an overnight clean begun 17h before A opens, then a drive inside A
    mk('q1', { userId: 'u2', inAt: '2026-08-31T07:00:00.000Z', outAt: '2026-09-01T00:30:00.000Z' }),
    mk('q2', { userId: 'u2', siteId: 's2', inAt: '2026-09-01T01:00:00.000Z', outAt: '2026-09-01T03:00:00.000Z' }),
  ];
  const fetched = (w) => punches.filter((e) => e.clockInAt >= w.fromIso && e.clockInAt <= w.toIso);
  const legsFor = (period) => legsDepartingIn(
    deriveDriveSegments(fetched(payrollLegFetchWindow({ ...period, maxGapMins: gapCap })), { maxGapMins: gapCap }),
    period,
  ).map((l) => l.key);
  const a = legsFor(A);
  const b = legsFor(B);
  const seam = driveSegmentKey('p1', 'p2');
  const overnight = driveSegmentKey('q1', 'q2');
  eq('payroll: the seam leg is paid in the period it departs (A)', a.includes(seam), true);
  eq('payroll: …and not again in the period it arrives (B)', b.includes(seam), false);
  eq('payroll: a leg after a clean begun the evening before the period is still paid', a.includes(overnight), true);
  eq('payroll: across both periods every leg is paid exactly once', [...a, ...b].sort(), [overnight, seam].sort());
  // The defect, for contrast: each period read on its own window pays the seam leg nowhere.
  const naive = (period) => deriveDriveSegments(fetched(period), { maxGapMins: gapCap }).map((l) => l.key);
  eq('payroll (control): a per-period read pays the seam leg in neither period', [...naive(A), ...naive(B)].includes(seam), false);
  eq('payroll: the look-back outlasts a long overnight clean', PAYROLL_SHIFT_LOOKBACK_MS >= 17.5 * 3600 * 1000, true);
  const w = payrollLegFetchWindow({ ...A, maxGapMins: gapCap });
  eq('payroll: the fetch window runs the gap cap past the period end', Date.parse(w.toIso) - Date.parse(A.toIso), gapCap * 60000);
  eq('payroll: a leg departing at the last instant is in; one a millisecond later is out',
    [legsDepartingIn([{ startAt: A.toIso }], A).length, legsDepartingIn([{ startAt: B.fromIso }], A).length], [1, 0]);
}

console.log(`\ndrive-time: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
