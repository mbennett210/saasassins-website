// Two of Matt's 2026-09-29 calls that are about what a screen SHOWS:
//
//   QB-6  the gross-profit bands, verbatim: "Bonus on gross profit is tracked as: - Above 22%:
//         meets target. - Between 14% and 22%: needs to be on yellow warning. - Below 14%:
//         needs to be on red." They replace the 35 / 32 placeholder, which put every real
//         account in the red.
//   PAY-6 "Should drive time between buildings be paid? — (b) No. we dont use this." While
//         `opsSettings.payDriveTime` is off the drive-time surfaces are HIDDEN; the DATA stays.
//
// Bands are asserted against the SOURCE constants, never a restated 22 or 14 (THE LAW II.3).
//
//   node app/scripts/test-gp-bands-and-drive.mjs
import { readFileSync } from 'node:fs';
import { GPM_TARGET_PCT, GPM_WATCH_PCT, PREVIEW_ACCOUNTS, healthOf, healthLabel } from '../src/data/dashboardLayoutPreview.js';
import { healthOf as viewHealthOf, healthLabel as viewHealthLabel, buildPreviewBook } from '../src/lib/qboView.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ══════════════════════════ QB-6 · the gross-profit bands ══════════════════════════
{
  eq('the target band is 22%', GPM_TARGET_PCT, 22);
  eq('the watch floor is 14%', GPM_WATCH_PCT, 14);
  ok('the target is above the watch floor', GPM_TARGET_PCT > GPM_WATCH_PCT);

  // Matt's three bands, at and around each edge.
  eq('above the target is green', healthOf(GPM_TARGET_PCT + 0.1), 'green');
  eq('AT the target is green ("above 22%: meets target")', healthOf(GPM_TARGET_PCT), 'green');
  eq('just under the target is amber', healthOf(GPM_TARGET_PCT - 0.1), 'amber');
  eq('mid-band is amber', healthOf((GPM_TARGET_PCT + GPM_WATCH_PCT) / 2), 'amber');
  eq('AT the watch floor is amber ("between 14% and 22%")', healthOf(GPM_WATCH_PCT), 'amber');
  eq('just under the watch floor is red ("below 14%")', healthOf(GPM_WATCH_PCT - 0.1), 'red');
  eq('a loss-making account is red', healthOf(-5), 'red');
  eq('zero margin is red', healthOf(0), 'red');

  eq('the labels follow the bands', [healthLabel(30), healthLabel(18), healthLabel(5)],
    ['On target', 'Watch', 'Below target']);

  // The view-model routes through the SAME rule (its only job is the null case).
  eq('the view-model agrees on every band',
    [viewHealthOf(30), viewHealthOf(18), viewHealthOf(5)], ['green', 'amber', 'red']);
  eq('…and a property with no income is NEUTRAL, never 0% red', viewHealthOf(null), 'neutral');
  eq('…with its own label', viewHealthLabel(null), 'No income');

  // 🔴 The placeholder is GONE, not merely unused (II.5).
  const preview = read('../src/data/dashboardLayoutPreview.js');
  ok('the single GPM_THRESHOLD constant is deleted', !/export const GPM_THRESHOLD\b/.test(preview));
  ok('…and the bare 32 amber floor with it', !/gpm >= 32/.test(preview));
  ok('the bands are read by name, not inline', /gpm >= GPM_TARGET_PCT \? 'green' : \(gpm >= GPM_WATCH_PCT \? 'amber' : 'red'\)/.test(preview));
  const view = read('../src/lib/qboView.js');
  ok('the view-model no longer imports the deleted constant', !/GPM_THRESHOLD/.test(view));

  // The book view-model carries BOTH lines, so a layout can draw either.
  const book = buildPreviewBook({ rangeKey: 'd30' });
  eq('the book carries the green line', book.gpmThreshold, GPM_TARGET_PCT);
  eq('…and the watch floor', book.gpmWatch, GPM_WATCH_PCT);

  // Every account's health is consistent with its own margin, and the design fixture still
  // previews all three bands — under the old numbers the layout picker could only show red.
  for (const a of book.accounts) {
    ok(`${a.name}: health matches its margin`, a.health === viewHealthOf(a.gpm), `${a.gpm} → ${a.health}`);
  }
  const bands = new Set(book.accounts.map((a) => a.health));
  ok('the design fixture still exercises green, amber and red',
    ['green', 'amber', 'red'].every((b) => bands.has(b)), [...bands].join(','));
  ok('and every fixture account carries a margin', PREVIEW_ACCOUNTS.every((a) => Number.isFinite(a.gpm)));
}

// ══════════════════════════ PAY-6 · the drive surfaces hide ════════════════════════
{
  const variance = read('../src/pages/Variance.jsx');
  // The predicate moved into lib/driveTime when PAY-6's MONEY half landed, so the page reads
  // that ONE rule rather than restating `!== false` (test-drive-pay-off owns the pay side).
  ok('the page reads the setting through the shared rule', /const payDriveTime = drivePayEnabled\(/.test(variance));
  ok('…and keeps no restated copy of the predicate', !/payDriveTime\s*!==\s*false/.test(variance));
  ok('a ?view=drive link falls back to labor while drive pay is off',
    /const view = \(payDriveTime && searchParams\.get\('view'\) === 'drive'\) \? 'drive' : 'labor';/.test(variance));
  ok('the Drive time TAB is not offered', /\{payDriveTime && \(/.test(variance));
  ok('the OT watch skips the paid-drive read', /if \(drivePayEnabled\(ops\)\) \{/.test(variance));
  ok('…and the setting is a dependency of that load', /ops\.payDriveTime, state\.sites\]/.test(variance));

  // The Hours report's drive column was already gated on the same setting — pinned so it stays.
  const hours = read('../src/pages/reports/HoursReport.jsx');
  ok('Reports › Hours gates its drive column on the same shared rule', /drivePayEnabled\(state\.opsSettings/.test(hours));
  ok('…and passes it to the column builder', /hoursColumns\(payDrive\)/.test(hours));

  // The drawer's line needs no gate of its own now that the pricer honours the setting: the
  // figure is real, so it self-hides at zero. The MONEY half is test-drive-pay-off.mjs's.
  const drawer = read('../src/pages/payroll/PayrollLineDrawer.jsx');
  ok('the pay drawer still explains paid drive', /Includes \{fmtHours\(current\.driveMinutes\)\} paid drive/.test(drawer));
  ok('…reading the ROW, never the setting', /the figure is REAL/.test(drawer));

  // ── PAY-21: the two surfaces PAY-6 left showing ──────────────────────────
  const ops = read('../src/pages/settings/Operations.jsx');
  ok('PAY-21: Settings → Operations reads the one shared rule',
    /drivePayEnabled\(ops\)/.test(ops), 'no drivePayEnabled(ops) in Operations.jsx');
  ok('PAY-21: …and the whole Drive-time CARD is behind it',
    /\{driveSurfaces && \(\s*\n?\s*<form className="card detail-card" onSubmit=\{saveDrive\}>/.test(ops),
    'the Drive time card is not gated');
  ok('PAY-21: …while the TOGGLE that turns it back on stays reachable (it lives on the Payroll card)',
    /form\.payDriveTime/.test(ops.split('onSubmit={savePayroll}')[1] || ''));
  ok('PAY-21: …and Operations restates no copy of the predicate', !/payDriveTime\s*!==\s*false/.test(ops));

  // The crew's drive hint moved with the Cleaner Hub (brief A) to the Clock screen's "Next stop".
  const myday = read('../src/pages/crew/CrewClock.jsx');
  ok('PAY-21: the crew drive hint reads the same rule', /drivePayEnabled\(/.test(myday));
  ok('PAY-21: …and is not shown while drive time is off',
    /showDrive\s*=\s*[^;]*drivePayEnabled|drivePayEnabled\([^)]*\)\s*&&[^;]*showDrive|payDrive\s*&&/.test(myday),
    'the DriveHint is still unconditional');
  ok('PAY-21: …and the Clock screen restates no copy of the predicate', !/payDriveTime\s*!==\s*false/.test(myday));

  // Turning it back ON is ONE toggle and nothing else: the setting has a single writer (the
  // Payroll card's save), nothing per-leg is stored, and every gate above is a pure read —
  // so the surfaces come back with no backfill and no second switch to remember.
  {
    const writers = (ops.match(/payDriveTime: !!form\.payDriveTime/g) || []).length;
    eq('PAY-21: the setting has exactly one writer', writers, 1);
    const payrollSave = ops.slice(ops.indexOf('const savePayroll'), ops.indexOf('const saveAlerts'));
    ok('PAY-21: …and it is the Payroll card’s save', /payDriveTime: !!form\.payDriveTime/.test(payrollSave));
    const drive = read('../src/lib/driveTime.js');
    ok('PAY-21: nothing per-leg is stored, so a flip needs no backfill',
      !/localStorage|persist|\.insert\(|\.update\(/.test(drive));
  }
}

console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error('  ✗ ' + f);
process.exitCode = fails.length === 0 ? 0 : 1;
