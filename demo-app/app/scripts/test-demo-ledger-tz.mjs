// Node unit test: the demo seed + demo time-ledger compose their times in the ORG
// zone, not the machine's — so the demo reads the same on a Pacific laptop and an
// Eastern one (spec §10, wave W1-R). Before this, seed.js `atTime`/`daysAgo` and
// demoTimeLedger.js `at()` built instants with `new Date(y, mo, d, h, m)` (machine-
// LOCAL), so the seeded job times and the ledger's clock-ins landed on different
// instants under a different process TZ, and Variance's "last night" mis-grouped
// (seed.js:80 documents the collapse from 6 cleans/2 flagged → 1/0 when the org zone
// and the laptop zone differed).
//
// The org zone is Eastern (Daniel's call, CS-029: "This is an East coast company").
// So the invariant is: same reference instant, org zone = company.timezone → the
// seeded instants and the "last night" clean set are byte-identical no matter where
// the process runs. This re-execs itself under several TZ values (like
// test-dates-tz.mjs) and requires every zone to agree.
//
// FAILS on pre-W1-R code: DEFAULT_ORG_TIMEZONE is America/Los_Angeles (not New_York),
// and the machine-local composition makes the fingerprints diverge across TZs.
//   node app/scripts/test-demo-ledger-tz.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installResolveShim } from './deletion-core.mjs';

// A fixed reference instant (summer, clear of the 2026 DST switches on Mar 8 / Nov 1),
// so both children build their story rows against the SAME "now".
const FIXED_NOW = '2026-07-15T18:00:00.000Z';
const DEVICE_ZONES = ['America/Los_Angeles', 'America/New_York', 'UTC'];

// The demo's org zone (what the app sets via setOrgTimezone(company.timezone)) and the
// noon-to-noon "last night" window (Variance.jsx resolvePeriod) — distinct clean job ids
// whose clock-in falls in [yesterday 12:00, min(now, today 12:00)] of the org zone.
function lastNightCleans(rows, now, dates, orgTz) {
  dates.setOrgTimezone(orgTz);
  const todayK = dates.dayKey(now, orgTz);
  const from = dates.composeIso(dates.addDaysKey(todayK, -1), '12:00', orgTz);
  const todayNoon = dates.composeIso(todayK, '12:00', orgTz);
  const to = now.toISOString() < todayNoon ? now.toISOString() : todayNoon;
  const jobs = new Set();
  for (const r of rows) {
    const t = r.clock_in_at;
    if (t && t >= from && t <= to && r.job_id) jobs.add(r.job_id);
  }
  return [...jobs].sort();
}

async function childFingerprint() {
  installResolveShim();
  const dates = await import('../src/lib/dates.js');
  const { INITIAL_STATE } = await import('../src/data/seed.js');
  const { buildDemoLedgerEntries } = await import('../src/data/demoTimeLedger.js');
  const now = new Date(FIXED_NOW);

  // Seed job times (atTime) + createdAt (daysAgo) — must not depend on the process zone.
  const jobsFp = (INITIAL_STATE.jobs || [])
    .map((j) => ({ id: j.id, startAt: j.startAt, endAt: j.endAt, createdAt: j.createdAt }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  // Demo ledger clock-ins/outs (the `at` helper) — the Variance data source.
  const rows = buildDemoLedgerEntries(now);
  const ledgerFp = rows
    .map((r) => ({ id: r.id, in: r.clock_in_at, out: r.clock_out_at }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const orgTz = INITIAL_STATE.company.timezone;
  return {
    tz: process.env.TZ || '(unset)',
    orgTz,
    defaultTz: dates.DEFAULT_ORG_TIMEZONE,
    jobsFp,
    ledgerFp,
    lastNight: lastNightCleans(rows, now, dates, orgTz),
  };
}

// ---------------------------------------------------------------------------
// Child: emit the fingerprint under whatever TZ the parent handed us.
// ---------------------------------------------------------------------------
if (process.env.__TZ_CHILD) {
  const fp = await childFingerprint();
  process.stdout.write('FP ' + JSON.stringify(fp));
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent: constant checks (org default = Eastern), then cross-zone agreement.
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

installResolveShim();
const dates = await import('../src/lib/dates.js');
const { INITIAL_STATE } = await import('../src/data/seed.js');

// The org default is the single source of truth for "what zone does scheduling resolve
// in when nothing else says otherwise" — Eastern (CS-029), asserted against the constant.
ok(dates.DEFAULT_ORG_TIMEZONE === 'America/New_York',
  `DEFAULT_ORG_TIMEZONE is America/New_York (got ${dates.DEFAULT_ORG_TIMEZONE})`);
ok(INITIAL_STATE.company.timezone === 'America/New_York',
  `seed company.timezone is America/New_York (got ${INITIAL_STATE.company.timezone})`);
ok(INITIAL_STATE.company.timezone === dates.DEFAULT_ORG_TIMEZONE,
  'seed company.timezone stays in lockstep with DEFAULT_ORG_TIMEZONE');

const self = fileURLToPath(import.meta.url);
const results = new Map();
let spawnFailed = false;
for (const tz of DEVICE_ZONES) {
  const r = spawnSync(process.execPath, [self], { env: { ...process.env, TZ: tz, __TZ_CHILD: '1' }, encoding: 'utf8' });
  if (r.status !== 0) { spawnFailed = true; console.error(`  ✗ child TZ=${tz} exited ${r.status}\n${r.stderr || ''}`); continue; }
  const line = (r.stdout || '').split('FP ')[1];
  try { results.set(tz, JSON.parse(line)); }
  catch { spawnFailed = true; console.error(`  ✗ child TZ=${tz} gave no fingerprint: ${(r.stdout || '').slice(0, 200)}`); }
}
ok(!spawnFailed && results.size === DEVICE_ZONES.length, 'every device-TZ child produced a fingerprint');

if (results.size) {
  const [baseTz, base] = [...results.entries()][0];
  const jobsBase = JSON.stringify(base.jobsFp);
  const ledgerBase = JSON.stringify(base.ledgerFp);
  const nightBase = JSON.stringify(base.lastNight);
  for (const [tz, r] of results) {
    ok(JSON.stringify(r.jobsFp) === jobsBase, `seed job times match across TZ (${tz} vs ${baseTz})`);
    ok(JSON.stringify(r.ledgerFp) === ledgerBase, `demo ledger clock-ins match across TZ (${tz} vs ${baseTz})`);
    ok(JSON.stringify(r.lastNight) === nightBase, `"last night" cleans match across TZ (${tz} vs ${baseTz})`);
  }
  // The window must actually contain the seeded "last night" story, or the check is vacuous.
  ok(base.lastNight.length >= 6, `"last night" holds the seeded story (>=6 cleans; got ${base.lastNight.length})`);
  console.log(`  base TZ=${baseTz}: ${base.lastNight.length} "last night" cleans, orgTz=${base.orgTz}`);
}

console.log(`demo ledger tz: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
