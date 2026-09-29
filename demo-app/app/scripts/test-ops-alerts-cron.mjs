// Offline unit test for the ops-alert CRON's raise→dispatch orchestration
// (app/api/cron/ops-alerts.js `run`). CS-011: the cron is back on a 5-minute schedule
// and now flushes push IMMEDIATELY after it records ≥1 new alert, instead of leaving the
// bell rows to wait up to a minute for the every-minute /api/push/dispatch cron.
//
// `run(dryRun, deps)` is dependency-injected so this drives the orchestration with NO
// Supabase and NO VAPID — the DB reads/writes, the walker compute, the push core and the
// monitor are all fakes. Production calls run(dryRun) with every default. This suite is a
// "backend" suite (it imports ../api/…): run-tests.mjs runs it when app/api is present and
// skips it on a backend-stripped checkout, like every other backend suite. It reaches no
// live service (no client is created, nothing is sent), so it needs no LIVE_EFFECT entry.
//
//   node app/scripts/test-ops-alerts-cron.mjs
import assert from 'node:assert/strict';
import { run } from '../api/cron/ops-alerts.js';
import { opsAlertId } from '../src/lib/opsAlerts.js';

let pass = 0, fail = 0;
const ok = async (label, fn) => {
  try { await fn(); pass += 1; console.log(`  ✓ ${label}`); }
  catch (e) { fail += 1; console.error(`  ✗ ${label}\n      ${e && e.message ? e.message : e}`); }
};

const NOW = new Date('2026-09-25T20:00:00.000Z').getTime();

// A real (non-seed) shift-missed alert on a real account with a valid supervisor, so
// applyOpsAlert routes it to a bell row. The id is built from the SOURCE-OF-TRUTH minter
// (opsAlertId), never a restated literal (THE LAW II.3).
const MISSED_ID = opsAlertId('shiftMissed', 'j_real');
const dueAlert = () => ({
  id: MISSED_ID, kind: 'shiftMissed', recipientScope: 'supervisor',
  clientId: 'cl_real', jobId: 'j_real', crewIds: [],
});
const baseState = (over = {}) => ({
  users: [{ id: 'u_sup', name: 'Renata', role: 'manager', status: 'active', notificationPrefs: {} }],
  clients: [{ id: 'cl_real', name: 'Real Co', supervisorId: 'u_sup' }],
  permissions: {}, userPermissionOverrides: [],
  notifications: [], opsAlertEvents: [], opsSettings: {},
  ...over,
});

// Build an injected dependency set + a call log. `over` tunes the fakes per case.
function makeDeps(over = {}) {
  const calls = { read: 0, write: 0, dispatch: 0, report: [] };
  const stateSnapshot = over.state || baseState();
  const deps = {
    now: NOW,
    readState: async () => { calls.read += 1; return { state: JSON.parse(JSON.stringify(stateSnapshot)), version: 7 }; },
    writeState: async () => { calls.write += 1; return over.writeOk !== undefined ? over.writeOk : true; },
    compute: async () => (over.due !== undefined ? over.due : [dueAlert()]),
    dispatch: async () => { calls.dispatch += 1; if (over.dispatchThrows) throw new Error('push boom'); return over.dispatchResult || { claimed: 1, sent: 1 }; },
    pushReady: () => (over.pushReady !== undefined ? over.pushReady : true),
    report: (tag, err) => { calls.report.push([tag, err && err.message]); },
  };
  return { calls, deps };
}

console.log('ops-alert cron raise→dispatch orchestration:');

await ok('dispatches push IMMEDIATELY after recording ≥1 new alert', async () => {
  const { calls, deps } = makeDeps();
  const out = await run(false, deps);
  assert.equal(out.raised, 1, 'one alert raised');
  assert.equal(calls.dispatch, 1, 'the shared push core is invoked exactly once');
  assert.deepEqual(out.push, { claimed: 1, sent: 1 }, 'the dispatch outcome rides in the response');
  assert.equal(calls.write, 1, 'org_state was written once (the raise)');
});

await ok('dryRun NEVER dispatches (and never writes)', async () => {
  const { calls, deps } = makeDeps();
  const out = await run(true, deps);
  assert.ok(Array.isArray(out.would) && out.would.length === 1, 'dryRun returns what WOULD raise');
  assert.equal(out.raised, 0, 'dryRun raises nothing');
  assert.equal(calls.dispatch, 0, 'dryRun does not dispatch');
  assert.equal(calls.write, 0, 'dryRun does not write');
});

await ok('does NOT dispatch when the walkers surface nothing due', async () => {
  const { calls, deps } = makeDeps({ due: [] });
  const out = await run(false, deps);
  assert.equal(out.raised, 0);
  assert.equal(calls.dispatch, 0, 'no due alerts → no dispatch');
  assert.equal(calls.write, 0, 'no due alerts → no write');
  assert.equal(out.push, undefined, 'no push outcome when nothing raised');
});

await ok('does NOT dispatch when every due alert was already raised (idempotent no-op)', async () => {
  // The marker is already present → applyOpsAlert returns null → raised stays 0.
  const withMarker = baseState({ opsAlertEvents: [{ id: MISSED_ID, kind: 'shiftMissed', firedAt: new Date(NOW).toISOString() }] });
  const { calls, deps } = makeDeps({ state: withMarker });
  const out = await run(false, deps);
  assert.equal(out.raised, 0, 'nothing new raised');
  assert.equal(calls.dispatch, 0, 'an all-duplicate run does not dispatch');
  assert.equal(calls.write, 0, 'an all-duplicate run does not write');
});

await ok('SURVIVES a dispatch failure — the raise still succeeds, the error is reported', async () => {
  const { calls, deps } = makeDeps({ dispatchThrows: true });
  const out = await run(false, deps); // must not throw
  assert.equal(out.raised, 1, 'the alert is still recorded even though push failed');
  assert.equal(calls.dispatch, 1, 'dispatch was attempted');
  assert.ok(out.push && out.push.error, 'the dispatch failure is surfaced in the response, not thrown');
  assert.equal(calls.report.length, 1, 'the failure was logged through the monitor');
  assert.equal(calls.report[0][0], 'ops-alerts.push-flush', 'monitor tag identifies the flush');
});

await ok('skips dispatch when push is not configured (no VAPID), but still records the raise', async () => {
  const { calls, deps } = makeDeps({ pushReady: false });
  const out = await run(false, deps);
  assert.equal(out.raised, 1, 'the alert is recorded');
  assert.equal(calls.dispatch, 0, 'no VAPID → the core is never called');
  assert.deepEqual(out.push, { skipped: 'vapid_unconfigured' }, 'the response says why push was skipped');
});

console.log(`\nops-alert cron orchestration: ${pass}/${pass + fail} passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
