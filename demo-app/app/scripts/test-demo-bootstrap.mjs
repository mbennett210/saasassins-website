// Node unit test for the demo-sandbox bootstrap's PURE decision layer
// (lib/demoSandbox.js). lib/demoBootstrap.js wires these to localStorage + the real
// data builders; the logic that decides WHEN to refresh the time-ledger and WHICH
// stub keys to backfill lives here so it is testable headlessly (same split as
// reminderScheduler.js vs ReminderScheduler.jsx).
//
// Guards the milestone-2 demo-visibility fix. The persistent sandbox seeds ONCE on
// marker-absence and previously never backfilled newer stub data into an already-
// seeded browser, so a returning browser showed two symptoms:
//   1. Payroll $0.00 / 0 hours — the seeded time-ledger is dated to first load and
//      never rolled forward, so it aged out of Payroll's fixed biweekly pay window.
//   2. Empty Checklists / Inspections — a browser first seeded before the QC stubs
//      existed never received them.
// refreshLedgerEntries fixes (1); missingStubKeys fixes (2). Run:
//   node app/scripts/test-demo-bootstrap.mjs
import { refreshLedgerEntries, missingStubKeys, DEMO_LEDGER_STALE_MS } from '../src/lib/demoSandbox.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-18T12:00:00.000Z').getTime();
const iso = (ms) => new Date(ms).toISOString();
const story = (id, atMs) => ({ id, user_id: 'u_crew', clock_in_at: iso(atMs), clock_out_at: iso(atMs), duration_minutes: 120, status: 'completed', approval_status: 'approved' });
// A fresh story stand-in (the real builder returns te_demo_* rows dated near now).
const freshStory = [story('te_demo_1', NOW - 2 * 60 * 60 * 1000), story('te_demo_2', NOW - DAY)];

// ── refreshLedgerEntries: stale story gets rebuilt ────────────────────────────
{
  const stale = [story('te_demo_1', NOW - 20 * DAY), story('te_demo_2', NOW - 21 * DAY)];
  const r = refreshLedgerEntries(stale, freshStory, NOW);
  ok(r.changed === true, 'A1: a story whose newest row is 20 days old is flagged stale and rebuilt');
  const newest = r.entries.reduce((m, e) => Math.max(m, new Date(e.clock_in_at).getTime()), 0);
  ok(NOW - newest < 3 * DAY, 'A2: after refresh the newest story row is recent (lands in the current pay period)');
}

// ── refreshLedgerEntries: fresh story is left alone (client interactions persist) ─
{
  const fresh = [story('te_demo_1', NOW - 6 * 60 * 60 * 1000)];
  const r = refreshLedgerEntries(fresh, freshStory, NOW);
  ok(r.changed === false, 'B1: a story newer than the stale window is NOT rebuilt (within-session approvals persist)');
  ok(r.entries === fresh, 'B2: unchanged ledger is returned as-is');
}

// ── refreshLedgerEntries: client-created punches always survive a rebuild ──────
{
  const mixed = [story('te_demo_1', NOW - 20 * DAY), { ...story('te_client_kept', NOW - 20 * DAY), id: 'te_client_kept' }];
  const r = refreshLedgerEntries(mixed, freshStory, NOW);
  ok(r.changed === true, 'C1: stale mixed ledger is rebuilt');
  ok(r.entries.some((e) => e.id === 'te_client_kept'), 'C2: a client-created punch (non te_demo_ id) is preserved through the rebuild');
  ok(r.entries.filter((e) => e.id.startsWith('te_demo_')).length === freshStory.length, 'C3: only the demo story rows are replaced');
}

// ── refreshLedgerEntries: empty / missing ledger seeds the fresh story ─────────
{
  const r = refreshLedgerEntries([], freshStory, NOW);
  ok(r.changed === true && r.entries.length === freshStory.length, 'D1: an empty ledger is (re)seeded with the fresh story');
  const r2 = refreshLedgerEntries(null, freshStory, NOW);
  ok(r2.changed === true, 'D2: a null/absent ledger is treated as needing a seed');
}

// ── missingStubKeys: only absent keys are returned ────────────────────────────
{
  const all = ['k_forms', 'k_quotes', 'k_qc_templates', 'k_qc_inspections', 'k_qc_checklists', 'k_qc_problems'];
  const present = new Set(['k_forms', 'k_quotes']); // an old browser has forms/quotes but no QC stubs
  const missing = missingStubKeys(all, (k) => present.has(k));
  ok(missing.length === 4, 'E1: exactly the four absent QC stub keys are flagged for backfill');
  ok(!missing.includes('k_forms') && missing.includes('k_qc_inspections'), 'E2: present keys are left alone, absent QC keys are returned');
  const none = missingStubKeys(all, () => true);
  ok(none.length === 0, 'E3: when every stub is present, nothing is backfilled (client edits untouched)');
}

// ── sanity: the stale window is long enough to survive a same-session reload ──
ok(DEMO_LEDGER_STALE_MS >= 2 * DAY, 'F1: stale window is at least 2 days (a same-day reload never rebuilds)');

console.log(`\n${pass}/${pass + fail} demo-sandbox assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
console.log('');
