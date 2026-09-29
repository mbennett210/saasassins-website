// The org_state authority digest is CRYPTOGRAPHIC (SHA-256) — a regression guard
// for the S79 fix.
//
// WHY IT MATTERS. api/state/org-state.js SKIPS the whole field-authorization guard
// when an incoming save's `protectedFingerprint` equals the digest stored on the last
// commit (`authorityChanged = committed === null || committed !== fingerprint`). The
// digest is a pure function of blob fields any authenticated login can read (org_state
// SELECT is open) and it carries free-form strings (emails, permission ids). So the
// digest's collision-resistance is a SECURITY BOUNDARY: a second preimage that matches
// the stored digest lets a forged matrix / role / status / email save slide through
// with no guard run. The previous digest was FNV-1a + a second 32-bit multiplicative
// hash + a length tag — 64 bits of invertible state, forgeable in an estimated ~2^32
// work (meet-in-the-middle). SHA-256 makes that infeasible.
//
// A real MITM collision is ~2^32 work — far too slow for an offline suite — so per the
// task guidance we ASSERT THE ALGORITHM: the digest is the SHA-256 hex of the canonical
// payload, it covers every field protectedFieldViolations inspects, and it stays off
// the hot path for non-authority churn. The format + known-answer checks below FAIL on
// the pre-fix FNV digest (base36 `h1h2:len`, not 64-char hex).
//
//   node scripts/test-protected-fingerprint.mjs
import { createHash } from 'node:crypto';
import { protectedFingerprint } from '../api/_lib/orgStateGuard.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const sha256hex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

// A realistic authority-bearing state. sites[0] carries a 2-id standing crew (so we can
// test order-insensitivity) and a parent account; clients[0] carries none.
const base = () => ({
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', email: 'owner@cs.co', name: 'Owner' },
    { id: 'u_crew', role: 'crew', status: 'active', email: 'crew@cs.co', name: 'Crew' },
  ],
  permissions: [{ id: 'invoices.view', roles: ['owner'] }],
  userPermissionOverrides: [],
  sites: [{ id: 's1', clientId: 'c1', standingCrewIds: ['u_a', 'u_b'] }],
  clients: [{ id: 'c1', standingCrewIds: [] }],
  company: { id: 'co', name: 'Clean Space', timezone: 'America/Los_Angeles' },
  timeOff: [],
});
const edit = (fn) => { const s = base(); fn(s); return s; };
const fp = protectedFingerprint;

// ── A. FORMAT: a 64-char lowercase hex string (fails on the FNV `h1h2:len`) ──
ok('empty state → 64-char lowercase hex', HEX64.test(fp({})));
ok('populated state → 64-char lowercase hex', HEX64.test(fp(base())));
ok('every authority edit still yields 64-char hex',
  [edit((s) => { s.users[1].role = 'owner'; }), edit((s) => { s.company.timezone = 'UTC'; }),
    edit((s) => { s.permissions = null; }), edit((s) => { s.timeOff = [{ id: 't', userId: 'u_crew' }]; })]
    .every((s) => HEX64.test(fp(s))));

// ── B. ALGORITHM: exactly SHA-256 over the canonical authority payload ───────
// Known answers built from the DOCUMENTED projection, not by calling the module's
// internals: the 12-tuple [users, permissions??null, overrides??null, assign(sites),
// assign(clients), clientIds, parentage, timezone??null, timeOff??null, payrollLines,
// reimbursements, payConfig] — users projected to [id, role, status, email??null],
// clientIds the sorted account-id existence set (S85), and the three MONEY slices (S87)
// projected to their pay-affecting fields only: a payroll line to [id,[userId,periodKey,
// kind,category,amount,taxable]] (sorted by id), a reimbursement to [id,[userId,amount,
// status,periodKey]], the pay-run config to [otMultiplier,payPeriodCadence,payWeekStartDay,
// payDriveTime] — so a userName stamp or a display field is authority-neutral. If the hash
// function OR the payload framing drifts, these break. On the pre-fix digest they already
// do (base36, not hex). MONEY = [], [], [null,null,null,null] for a state carrying none.
// Key-order-stable JSON, matching the guard's canonical() — the user tuple's pay/hr and
// the WHOLE opsSettings go through it, so jsonb key order never changes the digest.
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x)) ?? 'undefined';
// A user projects to [id, role, status, email??null, canon(pay??null), canon(hr??null),
// disabledAt??null, canon(clockRules??null)]
// (2026-09-23: pay/hr/disabledAt added — money/PII. 2026-09-27: clockRules added — it turns
// the clock-out checklist block and the clock-in geofence off for that one person, so the
// guard judges it and the digest must move. name/phone/prefs stay OUT.)
const urow = (id, role, status, email = null, pay = null, hr = null, disabledAt = null, clockRules = null) =>
  [id, role, status, email, canon(pay), canon(hr), disabledAt, canon(clockRules)];
// The tail = [payrollLines, reimbursements, opsSettings-canonical] for a state carrying none.
const TAIL0 = [[], [], canon(null)];
ok('empty state IS sha256(canonical empty payload)',
  fp({}) === sha256hex(JSON.stringify([[], null, null, [], [], [], [], null, null, ...TAIL0])));
ok('a one-user state IS sha256(canonical payload) — pins the tuple, drops name',
  fp({ users: [{ id: 'u1', role: 'owner', status: 'active', email: 'a@b.co', name: 'X' }] })
    === sha256hex(JSON.stringify([[urow('u1', 'owner', 'active', 'a@b.co')], null, null, [], [], [], [], null, null, ...TAIL0])));
ok('a null email projects to null in the tuple',
  fp({ users: [{ id: 'u1', role: 'crew', status: 'active' }] })
    === sha256hex(JSON.stringify([[urow('u1', 'crew', 'active', null)], null, null, [], [], [], [], null, null, ...TAIL0])));
ok('pay + the HR record are pinned in the user tuple, canonical (money/PII, 2026-09-23)',
  fp({ users: [{ id: 'u1', role: 'crew', status: 'active', email: 'a@b.co', name: 'X', pay: { type: 'hourly', hourlyRate: 20 }, hr: { employeeId: 'E1', hireDate: '2025-01-02' } }] })
    === sha256hex(JSON.stringify([[urow('u1', 'crew', 'active', 'a@b.co', { type: 'hourly', hourlyRate: 20 }, { employeeId: 'E1', hireDate: '2025-01-02' })], null, null, [], [], [], [], null, null, ...TAIL0])));
ok('clockRules are pinned in the user tuple, canonical (the per-cleaner clock exemptions, 2026-09-27)',
  fp({ users: [{ id: 'u1', role: 'crew', status: 'active', name: 'X', clockRules: { geofenceOff: true, checklistBlockOff: true } }] })
    === sha256hex(JSON.stringify([[urow('u1', 'crew', 'active', null, null, null, null, { geofenceOff: true, checklistBlockOff: true })], null, null, [], [], [], [], null, null, ...TAIL0])));
ok('the clientIds set pins account EXISTENCE (id only, sorted)',
  fp({ clients: [{ id: 'c2', name: 'B' }, { id: 'c1', name: 'A' }] })
    === sha256hex(JSON.stringify([[], null, null, [], [], ['c1', 'c2'], [], null, null, ...TAIL0])));
// S87 money slices: the projection pins the pay-affecting fields and DROPS display /
// provenance (label, note, description, userName), so a userName stamp never moves it.
ok('a payroll line pins its MONEY projection, dropping label/note/userName',
  fp({ payrollLines: [{ id: 'pl1', userId: 'u1', periodKey: 'p1', kind: 'earning', category: 'bonus', amount: 50, taxable: true, label: 'x', note: 'y', userName: 'z' }] })
    === sha256hex(JSON.stringify([[], null, null, [], [], [], [], null, null, [['pl1', ['u1', 'p1', 'earning', 'bonus', 50, true]]], [], canon(null)])));
ok('a reimbursement pins its MONEY projection, dropping description/userName',
  fp({ reimbursements: [{ id: 'r1', userId: 'u1', amount: 25, status: 'pending', periodKey: 'p1', description: 'd', userName: 'z' }] })
    === sha256hex(JSON.stringify([[], null, null, [], [], [], [], null, null, [], [['r1', ['u1', 25, 'pending', 'p1']]], canon(null)])));
ok('the WHOLE opsSettings is pinned, canonical — pay-run config + geofence/variance (2026-09-23)',
  fp({ opsSettings: { otMultiplier: 2, payPeriodCadence: 'weekly', defaultGeofenceRadiusM: 300 } })
    === sha256hex(JSON.stringify([[], null, null, [], [], [], [], null, null, [], [], canon({ otMultiplier: 2, payPeriodCadence: 'weekly', defaultGeofenceRadiusM: 300 })])));

// ── C. DETERMINISM: the same state always digests the same ───────────────────
ok('stable across two fresh builds of the same state', fp(base()) === fp(base()));
ok('stable across a JSON round-trip (jsonb hands values back as data, not identity)',
  fp(base()) === fp(JSON.parse(JSON.stringify(base()))));

// ── D. COVERAGE: every field protectedFieldViolations inspects moves the digest ─
// (independent of the payload reconstruction above — this asserts against the field
// actually changing, so a field silently dropped from the payload is caught here.)
const b0 = fp(base());
const moves = (label, fn) => ok(`moves on ${label}`, fp(edit(fn)) !== b0);
moves("a user's role", (s) => { s.users[1].role = 'manager'; });
moves("a user's status", (s) => { s.users[1].status = 'disabled'; });
moves("a user's email (claim-less logins are matched by it)", (s) => { s.users[1].email = 'evil@cs.co'; });
moves('the permission matrix', (s) => { s.permissions = [{ id: 'invoices.view', roles: ['owner', 'crew'] }]; });
moves('a per-user override', (s) => { s.userPermissionOverrides = [{ userId: 'u_crew', grants: ['invoices.view'], revokes: [] }]; });
moves("a site's standing crew", (s) => { s.sites[0].standingCrewIds = ['u_a', 'u_b', 'u_crew']; });
moves("an account's standing crew", (s) => { s.clients[0].standingCrewIds = ['u_crew']; });
moves('a site re-parent (authority via getAssignedScope)', (s) => { s.sites[0].clientId = 'c2'; });
moves('the company timezone', (s) => { s.company.timezone = 'America/New_York'; });
moves('a time-off entry', (s) => { s.timeOff = [{ id: 't1', userId: 'u_crew', startDate: '2026-09-23', endDate: '2026-09-23', kind: 'callout' }]; });
moves('adding a member', (s) => { s.users.push({ id: 'u_new', role: 'owner', status: 'active', email: 'n@cs.co' }); });
moves('removing a member', (s) => { s.users = s.users.filter((u) => u.id !== 'u_crew'); });
// S85: a customer removal is refused without clients.delete, so it must move the digest
// even for a crew-LESS account (assign(clients) can't see one). Adding one moves it too
// (a snapshot digest can't tell the two apart) — the accepted cost of the clientIds set.
moves('removing a customer (even crew-less — the clientIds set)', (s) => { s.clients = []; });
moves('adding a customer', (s) => { s.clients.push({ id: 'c2', standingCrewIds: [] }); });
// S87 money slices — each must move the digest, or its guard check silently stops firing.
moves('a payroll line (money on the pay run)', (s) => { s.payrollLines = [{ id: 'pl1', userId: 'u_crew', periodKey: 'p1', kind: 'earning', category: 'bonus', amount: 500, taxable: true }]; });
moves('a reimbursement approval (mints a pay line)', (s) => { s.reimbursements = [{ id: 'r1', userId: 'u_crew', amount: 20, status: 'approved', periodKey: 'p1' }]; });
moves('the OT multiplier (scales the pay run)', (s) => { s.opsSettings = { otMultiplier: 5 }; });
// Same-length substitution: a 5-char role swap ('owner'→'admin') must still move it —
// the digest is over content, not length (the old length tag alone never caught this).
ok('moves on a same-length role substitution',
  fp(edit((s) => { s.users[0].role = 'owner'; })) !== fp(edit((s) => { s.users[0].role = 'admin'; })));

// ── E. OFF THE HOT PATH: non-authority churn does NOT move the digest ────────
const staysFor = (label, fn) => ok(`ignores ${label}`, fp(edit(fn)) === b0);
staysFor('an ordinary company field (name)', (s) => { s.company.name = 'Renamed LLC'; });
staysFor("a member's profile field (name)", (s) => { s.users[1].name = 'Renamed'; });
staysFor('user array REORDERING (sorted by id)', (s) => { s.users.reverse(); });
staysFor('standing-crew REORDERING (set-sorted)', (s) => { s.sites[0].standingCrewIds = ['u_b', 'u_a']; });
staysFor('an entirely unrelated slice (jobs)', (s) => { s.jobs = [{ id: 'j1', crewIds: ['u_crew'] }]; });

// ── F. COLLISION SMOKE: distinct authority states → distinct digests ─────────
// A shared digest between two authority-differing states would skip the guard for one of
// them. sha256 must keep a diverse sample pairwise-distinct.
const sample = [
  base(),
  edit((s) => { s.users[1].role = 'manager'; }),
  edit((s) => { s.users[1].role = 'admin'; }),
  edit((s) => { s.users[1].status = 'disabled'; }),
  edit((s) => { s.users[1].email = 'x@cs.co'; }),
  edit((s) => { s.permissions = [{ id: 'invoices.view', roles: ['owner', 'crew'] }]; }),
  edit((s) => { s.userPermissionOverrides = [{ userId: 'u_crew', grants: ['invoices.view'], revokes: [] }]; }),
  edit((s) => { s.sites[0].clientId = 'c2'; }),
  edit((s) => { s.sites[0].standingCrewIds = ['u_a', 'u_b', 'u_crew']; }),
  edit((s) => { s.clients[0].standingCrewIds = ['u_crew']; }),
  edit((s) => { s.company.timezone = 'America/New_York'; }),
  edit((s) => { s.timeOff = [{ id: 't1', userId: 'u_crew' }]; }),
  edit((s) => { s.payrollLines = [{ id: 'pl1', userId: 'u_crew', periodKey: 'p1', kind: 'earning', category: 'bonus', amount: 500, taxable: true }]; }),
  edit((s) => { s.reimbursements = [{ id: 'r1', userId: 'u_crew', amount: 20, status: 'approved', periodKey: 'p1' }]; }),
  edit((s) => { s.opsSettings = { otMultiplier: 5 }; }),
  {},
];
ok(`${sample.length} distinct authority states → ${sample.length} distinct digests`,
  new Set(sample.map(fp)).size === sample.length);

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
console.log('');
process.exit(fails.length ? 1 : 0);
