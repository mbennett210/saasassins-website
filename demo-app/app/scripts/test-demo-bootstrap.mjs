// Node unit test for the demo-sandbox bootstrap's PURE decision layer
// (lib/demoSandbox.js). lib/demoBootstrap.js wires these to localStorage + the real
// data builders; the logic that decides WHEN to refresh the time-ledger and WHICH
// stub keys to backfill lives here so it is testable headlessly (same split as
// opsAlerts.js vs OpsAlertScheduler.jsx).
//
// Guards the milestone-2 demo-visibility fix. The persistent sandbox seeds ONCE on
// marker-absence and previously never backfilled newer stub data into an already-
// seeded browser, so a returning browser showed two symptoms:
//   1. Payroll $0.00 / 0 hours — the seeded time-ledger is dated to first load and
//      never rolled forward, so it aged out of Payroll's fixed biweekly pay window.
//   2. Empty Checklists / Inspections — a browser first seeded before the QC stubs
//      existed never received them.
// refreshLedgerEntries fixes (1); missingStubKeys fixes (2). The manager's day (today's visits,
// placed around now and placed again when it is over two hours old) has its own helpers, tested
// at the end. Run:
//   node app/scripts/test-demo-bootstrap.mjs
import { refreshLedgerEntries, missingStubKeys, DEMO_LEDGER_STALE_MS } from '../src/lib/demoSandbox.js';
// Read as a namespace so a missing export FAILS its checks below instead of crashing the file.
import * as sandbox from '../src/lib/demoSandbox.js';

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

// ── the manager's day (data/demoManagerDay.js): placed again on its own, shorter clock ──────
// Today's visits, punches, saves and the customer's requests are placed around the moment the
// bootstrap built them, and placed again once that is two hours old or yesterday's — keeping
// every row the viewer made, and the replies they added to a request.
{
  const isDay = (e) => typeof e?.id === 'string' && e.id.startsWith('te_demo_md_');
  const refresh = sandbox.refreshLedgerEntries;
  const week = [story('te_demo_1', NOW - 20 * DAY), story('te_demo_md_x', NOW - 60 * 60 * 1000)];
  const r = refresh(week, freshStory, NOW, DEMO_LEDGER_STALE_MS, isDay);
  ok(r.changed === true, 'G1: a story whose own rows are 20 days old is rebuilt even though today\'s rows (placed elsewhere) are fresh');
  const r2 = refresh(week, freshStory, NOW);
  ok(r2.changed === false, 'G2: …which is exactly what a fresh today-row hid before (the age test must leave them out)');

  const stale = sandbox.managerDayStale;
  const MAX = sandbox.MANAGER_DAY_STALE_MS;
  ok(typeof stale === 'function' && Number.isFinite(MAX), 'H1: demoSandbox exports managerDayStale and its window');
  if (typeof stale === 'function') {
    const k = '2026-09-18';
    ok(stale(null, NOW, k) === true, 'H2: never placed → place it');
    ok(stale({ at: NOW - 30 * 60 * 1000, day: k }, NOW, k) === false, 'H3: placed half an hour ago today → leave it (the viewer\'s clicks stay)');
    ok(stale({ at: NOW - MAX - 60 * 1000, day: k }, NOW, k) === true, 'H4: placed more than the window ago → place it again');
    ok(stale({ at: NOW - 60 * 1000, day: '2026-09-17' }, NOW, k) === true, 'H5: placed yesterday (even a minute ago, across midnight) → place it again');
    ok(stale({ at: NOW + 10 * 60 * 1000, day: k }, NOW, k) === true, 'H6: a clock that went backwards → place it again');
  }

  const { replaceOwned, addMissing, moveOwnedRows, placeManagerDayInState, rekeyRefs, shiftTimes } = sandbox;
  ok([replaceOwned, addMissing, moveOwnedRows, placeManagerDayInState, rekeyRefs, shiftTimes].every((f) => typeof f === 'function'),
    'I1: demoSandbox exports the placing helpers');
  if (typeof replaceOwned === 'function') {
    const owns = (r0) => r0.id.startsWith('cr_md_');
    const out = replaceOwned([{ id: 'cr_md_a', v: 1 }, { id: 'cr_mine' }], [{ id: 'cr_md_a', v: 2 }, { id: 'cr_md_b' }], owns);
    ok(out.some((x) => x.id === 'cr_mine') && out.find((x) => x.id === 'cr_md_a')?.v === 2 && out.length === 3,
      'I2: replaceOwned swaps the plan\'s rows and keeps the viewer\'s');
    const add = addMissing([{ id: 't1', name: 'Edited by the office' }], [{ id: 't1', name: 'Seed' }, { id: 't2' }]);
    ok(add.length === 2 && add[0].name === 'Edited by the office', 'I3: addMissing adds an absent row and never overwrites a present one');
    const H = 60 * 60 * 1000;
    const t = { id: 'pr_md_a', created_at: iso(NOW - 3 * H), due_at: iso(NOW - H), status: 'in_progress', messages: [{ id: 'm0', created_at: iso(NOW - 3 * H) }] };
    const reply = { id: 'm_viewer', created_at: iso(NOW - 10 * 60 * 1000), body: 'On it' };
    const moved = moveOwnedRows([{ ...t, messages: [...t.messages, reply] }, { id: 'pr_mine', created_at: iso(NOW) }], [t, { id: 'pr_md_b', created_at: iso(NOW) }], 2 * H);
    const m = moved.find((x) => x.id === 'pr_md_a');
    ok(m && m.created_at === iso(NOW - H) && m.due_at === iso(NOW + H), 'I4: a request of the day moves with the clock (its deadline still an hour away, not an hour past)');
    ok(m && m.messages.length === 2 && m.messages[1].body === 'On it' && m.status === 'in_progress', 'I5: …keeping the reply and the status the viewer gave it');
    ok(moved.find((x) => x.id === 'pr_mine')?.created_at === iso(NOW), 'I6: …a request the viewer raised is never moved');
    ok(moved.some((x) => x.id === 'pr_md_b'), 'I7: …and one the browser never had is added');
    const st = placeManagerDayInState(
      { jobs: [{ id: 'j_seed_today-2', startAt: 'old' }, { id: 'j_mine' }], timeOff: [{ id: 'to_seed_andre-out', startDate: 'old' }, { id: 'to_mine' }], clients: [{ id: 'c' }] },
      { jobs: [{ id: 'j_seed_today-2', startAt: 'new' }], timeOff: [{ id: 'to_seed_andre-out', startDate: 'new' }] },
      { jobIds: ['j_seed_today-2', 'j_seed_ck-demo'], timeOffIds: ['to_seed_andre-out'] },
    );
    ok(st.jobs.length === 2 && st.jobs.find((j) => j.id === 'j_seed_today-2')?.startAt === 'new' && st.jobs.some((j) => j.id === 'j_mine'),
      'I8: the store\'s jobs: the plan\'s replaced, the viewer\'s kept');
    ok(st.timeOff.find((x) => x.id === 'to_seed_andre-out')?.startDate === 'new' && st.timeOff.some((x) => x.id === 'to_mine') && st.clients.length === 1,
      'I9: …the call-out too, and nothing else in the state is touched');
    const media = [{ id: 'a', ref_id: 'j_demo_22' }, { id: 'b', ref_id: 'x' }];
    const re = rekeyRefs(media, { j_demo_22: 'j_seed_cbay-w1' });
    ok(re[0].ref_id === 'j_seed_cbay-w1' && re[1].ref_id === 'x', 'I10: photos filed under a visit that moved are re-filed under its new id');
    ok(rekeyRefs(re, { j_demo_22: 'j_seed_cbay-w1' }) === re, 'I11: …and once re-filed, nothing changes again (the stub is not rewritten)');
  }
}

console.log(`\n${pass}/${pass + fail} demo-sandbox assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
console.log('');
