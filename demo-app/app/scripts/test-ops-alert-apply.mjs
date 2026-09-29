// applyOpsAlert (lib/opsAlertApply) — the shared pure applier used by the reducer's
// RAISE_OPS_ALERT AND the server cron (app/api/cron/ops-alerts). Locks recipient
// routing (crew vs account-supervisor vs manager-bench blanket) and the no-op
// contract (missing id/kind, or already-raised). Retention is covered separately by
// test-ops-alert-retention (through the reducer). Pure, offline.
//
// No import-resolver hook here: opsAlertApply.js and the modules it pulls now carry
// explicit `.js` on every relative import (CS-011), so they load under plain Node the
// same way the serverless cron does. A hook that appended `.js` used to mask that crash
// (CS-065 / CS-308); test-api-cold-import.mjs is the standing backstop.
import assert from 'node:assert/strict';
const { applyOpsAlert } = await import('../src/lib/opsAlertApply.js');

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };

const state = (over = {}) => ({
  users: [
    { id: 'u_owner', name: 'Matt', role: 'owner', status: 'active', notificationPrefs: {} },
    { id: 'u_admin', name: 'Yolanda', role: 'admin', status: 'active', notificationPrefs: {} },
    { id: 'u_sup', name: 'Renata', role: 'manager', status: 'active', notificationPrefs: {} },
    { id: 'u_other', name: 'Other Mgr', role: 'manager', status: 'active', notificationPrefs: {} },
    { id: 'u_crew', name: 'Tomas', role: 'crew', status: 'active', notificationPrefs: {} },
  ],
  clients: [
    { id: 'cl_sup', name: 'Las Olas', supervisorId: 'u_sup' },
    { id: 'cl_none', name: 'No Sup Co', supervisorId: null },
  ],
  permissions: {}, userPermissionOverrides: [],
  notifications: [], opsAlertEvents: [], opsSettings: { shiftAlertLookbackHours: 24 },
  ...over,
});
const recips = (res) => new Set((res.notifications || []).map((n) => n.userId));

console.log('applyOpsAlert routing + no-op contract:');

ok('missing id or kind -> null (no-op)', () => {
  assert.equal(applyOpsAlert(state(), { kind: 'shiftMissed' }), null);
  assert.equal(applyOpsAlert(state(), { id: 'x' }), null);
});

ok('already-raised id -> null (idempotent)', () => {
  const s = state({ opsAlertEvents: [{ id: 'oa_dup', kind: 'shiftMissed', firedAt: new Date().toISOString() }] });
  const res = applyOpsAlert(s, { id: 'oa_dup', kind: 'shiftMissed', recipientScope: 'supervisor', clientId: 'cl_sup', title: 't', body: 'b', url: '/x' });
  assert.equal(res, null);
});

ok('shift alert (missed/late) WITH a valid SPOC -> the supervisor AND the owner (single-login safety net)', () => {
  const res = applyOpsAlert(state(), { id: 'oa1', kind: 'shiftMissed', recipientScope: 'supervisor', clientId: 'cl_sup', title: 't', body: 'b', url: '/x' });
  const r = recips(res);
  assert.ok(r.has('u_sup'), 'the account supervisor is notified');
  assert.ok(r.has('u_owner'), 'the owner is ALSO notified — missed/late must reach the one shared owner login even when the account is supervised by a (login-less) manager');
  assert.ok(!r.has('u_other'), 'a non-supervisor NON-owner manager is still NOT notified');
  assert.ok(res.opsAlertEvents.some((e) => e.id === 'oa1'), 'the dedup marker is recorded');
});

ok('shift alert with an OWNER as SPOC -> the owner gets exactly ONE row (union dedup)', () => {
  const s = state({ clients: [{ id: 'cl_ownsup', name: 'Owner-run', supervisorId: 'u_owner' }] });
  const res = applyOpsAlert(s, { id: 'oa1b', kind: 'shiftMissed', recipientScope: 'supervisor', clientId: 'cl_ownsup', title: 't', body: 'b', url: '/x' });
  const ownerRows = (res.notifications || []).filter((n) => n.userId === 'u_owner').length;
  assert.equal(ownerRows, 1, 'the owner is not double-notified when they are the SPOC');
});

ok('non-shift supervisor alert (inspection) WITH a valid SPOC -> the supervisor ALONE (owner NOT auto-added)', () => {
  const res = applyOpsAlert(state(), { id: 'oa_insp', kind: 'inspectionDue', recipientScope: 'supervisor', clientId: 'cl_sup', title: 't', body: 'b', url: '/x' });
  const r = recips(res);
  assert.ok(r.has('u_sup'), 'the account supervisor is notified');
  assert.ok(!r.has('u_owner'), 'the owner safety-net is shift-only — a non-shift alert keeps SPOC-alone routing (NOTIF-02)');
});

ok('checklist ESCALATION (supervisor scope) -> the supervisor AND the owner, never the crew', () => {
  // CS-404: the escalation used to reach the SPOC alone. Clean Space runs on one shared
  // owner login, so an account supervised by a login-less manager sent it to no device.
  // Same union as the shift alerts; the cleaner already had their own nudge.
  const res = applyOpsAlert(state(), {
    id: 'oa_ck_esc', kind: 'checklistDue', recipientScope: 'supervisor', clientId: 'cl_sup',
    crewIds: ['u_crew'], missingUserIds: ['u_crew'], title: 't', body: 'b', url: '/x',
  });
  const r = recips(res);
  assert.ok(r.has('u_sup'), 'the account supervisor is notified');
  assert.ok(r.has('u_owner'), 'the owner is ALSO notified — the escalation must reach the one shared login');
  assert.ok(!r.has('u_other'), 'a non-supervisor NON-owner manager is still NOT notified');
  assert.ok(!r.has('u_crew'), 'the escalation is the office tier — the cleaner already got their own nudge');
});

ok('checklist escalation with an OWNER as SPOC -> exactly ONE owner row (union dedup)', () => {
  const s = state({ clients: [{ id: 'cl_ownsup', name: 'Owner-run', supervisorId: 'u_owner' }] });
  const res = applyOpsAlert(s, { id: 'oa_ck_esc2', kind: 'checklistDue', recipientScope: 'supervisor', clientId: 'cl_ownsup', title: 't', body: 'b', url: '/x' });
  assert.equal((res.notifications || []).filter((n) => n.userId === 'u_owner').length, 1);
});

ok('supervisor scope with NO SPOC -> blankets the manager bench (time-critical, not silent)', () => {
  const res = applyOpsAlert(state(), { id: 'oa2', kind: 'shiftMissed', recipientScope: 'supervisor', clientId: 'cl_none', title: 't', body: 'b', url: '/x' });
  const r = recips(res);
  assert.ok(r.has('u_other'), 'a non-supervisor manager IS notified when the account has no SPOC');
  assert.ok(r.has('u_owner'), 'the owner is in the blanket too');
});

ok('crew scope -> the named crew, not the manager bench', () => {
  const res = applyOpsAlert(state(), { id: 'oa3', kind: 'checklistDue', recipientScope: 'crew', crewIds: ['u_crew'], title: 't', body: 'b', url: '/x' });
  const r = recips(res);
  assert.ok(r.has('u_crew'), 'the assigned crew member is notified');
  assert.ok(!r.has('u_sup') && !r.has('u_other'), 'managers are not notified on the crew nudge');
});

console.log(`\napplyOpsAlert: ${pass} passed`);
