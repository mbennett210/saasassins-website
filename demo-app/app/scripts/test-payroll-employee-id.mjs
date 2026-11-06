// THE EMPLOYEE ID — PAY-9 (Matt, 2026-09-29: put each person's payroll-system employee ID in
// the file) with CS-382 (neither payroll file carried it) and CS-229 (nothing stopped two
// people sharing one).
//
// What it pins:
//   · the pure rules in src/lib/employeeId.js — reading, the comparison key, who already
//     holds an id, the refusal sentence, the EMP-#### mint, and the duplicate scan;
//   · the pay run's CSV carries an Employee ID column, populated from the row;
//   · `computePayRun`'s file rows carry it, so a CLOSED run's stored file keeps it;
//   · Reports › Hours by cleaner carries it too (the other payroll-equivalent export);
//   · the SERVER refuses a save that creates a duplicate — for everyone, the owner
//     included, because it is data integrity and not authority — while a roster that ALREADY
//     holds one is not the caller's to answer for;
//   · the two entry points (the HR card, the invite form) run the shared rules.
//
//   node app/scripts/test-payroll-employee-id.mjs
import { readFileSync } from 'node:fs';
import {
  employeeIdOf, employeeIdKey, employeeIdOwner, employeeIdRefusal, nextEmployeeId,
  duplicateEmployeeIds, employeeIdCounts, worsenedEmployeeIds,
} from '../src/lib/employeeId.js';
import { payrollPayCsv } from '../src/lib/payroll.js';
import { protectedFieldViolations, protectedFingerprint } from '../api/_lib/orgStateGuard.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── the pure rules ───────────────────────────────────────────────────────────
{
  eq('employeeIdOf reads hr.employeeId', employeeIdOf({ hr: { employeeId: 'EMP-0007' } }), 'EMP-0007');
  eq('…trimmed', employeeIdOf({ hr: { employeeId: '  EMP-0007 ' } }), 'EMP-0007');
  eq('…no HR record → empty (a normal state, not a warning)', employeeIdOf({}), '');
  eq('…no user → empty', employeeIdOf(null), '');
  eq('…a non-string is ignored', employeeIdOf({ hr: { employeeId: 7 } }), '');

  eq('the key folds case', employeeIdKey('EMP-0007'), employeeIdKey('emp-0007'));
  eq('the key folds surrounding space', employeeIdKey(' EMP-0007 '), 'emp-0007');
  eq('an empty id has an empty key', employeeIdKey('   '), '');

  const roster = [
    { id: 'u1', name: 'Andre Baptiste', hr: { employeeId: 'EMP-0006' } },
    { id: 'u2', name: 'Tomas Rivera', hr: { employeeId: 'EMP-0007' } },
    { id: 'u3', name: 'No Id' },
  ];
  eq('the holder of an id is found', employeeIdOwner(roster, 'EMP-0007')?.id, 'u2');
  eq('…case-insensitively', employeeIdOwner(roster, 'emp-0007')?.id, 'u2');
  eq('…and a free id has no holder', employeeIdOwner(roster, 'EMP-9999'), null);
  eq('a member re-saving their OWN id is not a duplicate', employeeIdOwner(roster, 'EMP-0007', 'u2'), null);
  eq('an EMPTY id is never a duplicate (several members may have none)', employeeIdOwner(roster, '', null), null);

  ok('the refusal NAMES who holds it', (employeeIdRefusal(roster, 'EMP-0007', 'u1') || '').includes('Tomas Rivera'),
    String(employeeIdRefusal(roster, 'EMP-0007', 'u1')));
  eq('no refusal for a free id', employeeIdRefusal(roster, 'EMP-9999', 'u1'), null);
  eq('no refusal for an empty id', employeeIdRefusal(roster, '', 'u1'), null);

  eq('the mint takes the max EMP-#### + 1, zero-padded', nextEmployeeId(roster), 'EMP-0008');
  eq('…an empty roster starts at 1', nextEmployeeId([]), 'EMP-0001');
  eq('…a non-EMP id is not counted', nextEmployeeId([{ hr: { employeeId: 'PAYCHEX-42' } }]), 'EMP-0001');
  eq('…and the mint it produces is free on that roster', employeeIdOwner(roster, nextEmployeeId(roster)), null);

  eq('a clean roster has no duplicates', duplicateEmployeeIds(roster).length, 0);
  eq('a duplicate is reported once, as its key',
    duplicateEmployeeIds([...roster, { id: 'u4', name: 'Clone', hr: { employeeId: 'emp-0007' } }]).join(','), 'emp-0007');
  eq('members with NO id are not duplicates of each other',
    duplicateEmployeeIds([{ id: 'a' }, { id: 'b' }, { id: 'c', hr: {} }]).length, 0);
  eq('the counts are per comparison key', employeeIdCounts([...roster, { id: 'u4', hr: { employeeId: 'emp-0007' } }]).get('emp-0007'), 2);
  eq('members with no id are not counted', employeeIdCounts([{ id: 'a' }, { id: 'b' }]).size, 0);

  // Only what a save makes WORSE, counted by holders (the server rule's input).
  const dirtyRoster = [{ id: 'a', hr: { employeeId: 'X' } }, { id: 'b', hr: { employeeId: 'X' } }];
  eq('an unchanged dirty roster is not worsened', worsenedEmployeeIds(dirtyRoster, dirtyRoster).length, 0);
  eq('a THIRD holder of the same id IS worse',
    worsenedEmployeeIds(dirtyRoster, [...dirtyRoster, { id: 'c', hr: { employeeId: 'x' } }]).join(','), 'x');
  eq('a brand-new collision is worse', worsenedEmployeeIds([{ id: 'a', hr: { employeeId: 'X' } }], [{ id: 'a', hr: { employeeId: 'X' } }, { id: 'b', hr: { employeeId: 'X' } }]).join(','), 'x');
  eq('REPAIRING a duplicate is never refused',
    worsenedEmployeeIds(dirtyRoster, [{ id: 'a', hr: { employeeId: 'X' } }, { id: 'b', hr: { employeeId: 'Y' } }]).length, 0);
}

// ── CS-382: the pay run's CSV carries it ─────────────────────────────────────
{
  const rows = [
    { userName: 'Andre Baptiste', employeeId: 'EMP-0006', payTypeLabel: 'Hourly', regularMinutes: 2400, otMinutes: 0, base: 880, byCategory: {}, gross: 880 },
    { userName: 'No Id', payTypeLabel: 'Hourly', regularMinutes: 600, otMinutes: 0, base: 200, byCategory: {}, gross: 200 },
  ];
  const lines = payrollPayCsv(rows, { fromIso: '2026-09-16T00:00:00Z', toIso: '2026-09-30T00:00:00Z' }).split('\n');
  const head = lines[0].split(',').map((c) => c.replace(/^"|"$/g, ''));
  eq('the header names the Employee ID column', head[1], 'Employee ID');
  eq('…right beside the name it identifies', head[0], 'Cleaner');
  ok('the row carries the id', lines[1].startsWith('"Andre Baptiste","EMP-0006","Hourly"'), lines[1]);
  ok('a member with no id gets an EMPTY cell, not a placeholder',
    lines[2].startsWith('"No Id","","Hourly"'), lines[2]);
  eq('every row has the same cell count as the header',
    new Set(lines.map((l) => l.split('","').length)).size, 1);

  // The retired hours-only builder is GONE (II.5) — it had no caller left, so PAY-9's column
  // would have landed on dead code.
  const payrollSrc = read('../src/lib/payroll.js');
  ok('the dead `payrollCsv` builder is deleted', !/export function payrollCsv\b/.test(payrollSrc));
  ok('…and the deletion is recorded where it stood', /payrollCsv` was DELETED/.test(payrollSrc));
}

// ── the run's file rows carry it, so a CLOSED run keeps it ───────────────────
{
  const payRunSrc = read('../src/lib/payRun.js');
  ok('computePayRun puts employeeId on the CSV source rows',
    /employeeId: employeeIdOf\(usersById\.get\(r\.userId\)\)/.test(payRunSrc));
  ok('…read through the shared rule, not a hand-rolled hr lookup',
    /from '\.\/employeeId\.js'/.test(payRunSrc));
}

// ── the OTHER payroll file: Reports › Hours by cleaner ───────────────────────
{
  const hours = read('../src/pages/reports/HoursReport.jsx');
  ok('the Hours report has an Employee ID column', /label: 'Employee ID'/.test(hours));
  ok('…populated from the roster through the shared rule',
    /employeeId: employeeIdOf\(usersById\.get\(r\.userId\)\)/.test(hours));
  ok('…and the column sits second, beside the cleaner', hours.indexOf("label: 'Employee ID'") < hours.indexOf("label: 'Regular (h)'"));
}

// ── CS-229: the SERVER refuses a save that CREATES a duplicate ───────────────
{
  const member = (id, role, employeeId) => ({
    id, role, status: 'active', name: id, email: `${id}@cs.co`,
    pay: { type: 'hourly', hourlyRate: 20 }, ...(employeeId === undefined ? {} : { hr: { employeeId } }),
  });
  const base = () => ({
    users: [member('u_owner', 'owner', 'EMP-0001'), member('u_a', 'crew', 'EMP-0006'), member('u_b', 'crew', 'EMP-0007')],
    permissions: [], userPermissionOverrides: [], sites: [], clients: [],
    company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  });
  const facts = { removal: { payState: {}, recentHours: new Set() } };
  const withEdit = (fn) => { const s = base(); fn(s); return s; };
  const dupRefused = (next, role, self) => protectedFieldViolations(base(), next, role, self, facts)
    .some((v) => /same employee ID/.test(v));

  const collide = withEdit((s) => { s.users.find((u) => u.id === 'u_a').hr = { employeeId: 'EMP-0007' }; });
  ok('a save that makes two people share an id is REFUSED for the owner', dupRefused(collide, 'owner', 'u_owner'));
  ok('…and for an admin', dupRefused(collide, 'admin', 'u_owner'));
  ok('…and for a manager', dupRefused(collide, 'manager', 'u_a'));
  ok('…and for crew', dupRefused(collide, 'crew', 'u_a'));

  const caseOnly = withEdit((s) => { s.users.find((u) => u.id === 'u_a').hr = { employeeId: 'emp-0007' }; });
  ok('a duplicate that differs only in CASE is refused too', dupRefused(caseOnly, 'owner', 'u_owner'));
  const spaceOnly = withEdit((s) => { s.users.find((u) => u.id === 'u_a').hr = { employeeId: ' EMP-0007 ' }; });
  ok('…and one that differs only in space', dupRefused(spaceOnly, 'owner', 'u_owner'));

  const freeId = withEdit((s) => { s.users.find((u) => u.id === 'u_a').hr = { employeeId: 'PAYCHEX-42' }; });
  ok('a FREE id is accepted', !dupRefused(freeId, 'owner', 'u_owner'));
  const cleared = withEdit((s) => { s.users.find((u) => u.id === 'u_a').hr = {}; });
  ok('CLEARING an id is accepted (several members may have none)', !dupRefused(cleared, 'owner', 'u_owner'));
  const newHire = withEdit((s) => { s.users.push(member('u_new', 'crew', 'EMP-0008')); });
  ok('a new member with a free id is accepted', !dupRefused(newHire, 'owner', 'u_owner'));
  const newHireDupe = withEdit((s) => { s.users.push(member('u_new', 'crew', 'EMP-0006')); });
  ok('a new member REUSING an id is refused', dupRefused(newHireDupe, 'owner', 'u_owner'));
  ok('an unrelated save is never refused for it', !dupRefused(base(), 'crew', 'u_a'));

  // A roster that ALREADY holds a duplicate is not this caller's to answer for — otherwise
  // every save would be refused until someone repaired data through a path the guard also
  // refused. Only a NEW duplicate is.
  const dirty = () => {
    const s = base();
    s.users.find((u) => u.id === 'u_b').hr = { employeeId: 'EMP-0006' };   // committed collision
    return s;
  };
  const dirtyThenRename = () => { const s = dirty(); s.users.find((u) => u.id === 'u_a').name = 'Renamed'; return s; };
  ok('a PRE-EXISTING duplicate does not refuse an unrelated save',
    !protectedFieldViolations(dirty(), dirtyThenRename(), 'owner', 'u_owner', facts).some((v) => /same employee ID/.test(v)));
  // Holders are COUNTED, not just keys: adding a THIRD person to an already-duplicated id
  // worsens it, and a key-only comparison would have waved that through.
  const dirtyPlusThird = () => { const s = dirty(); s.users.find((u) => u.id === 'u_owner').hr = { employeeId: 'EMP-0006' }; return s; };
  ok('…but adding a THIRD holder to that same duplicated id still is',
    protectedFieldViolations(dirty(), dirtyPlusThird(), 'owner', 'u_owner', facts).some((v) => /same employee ID/.test(v)));
  const dirtyPlusOther = () => { const s = dirty(); s.users.push(member('u_new', 'crew', 'EMP-0001')); return s; };
  ok('…and a NEW collision on a different id is refused on a dirty roster too',
    protectedFieldViolations(dirty(), dirtyPlusOther(), 'owner', 'u_owner', facts).some((v) => /same employee ID/.test(v)));

  // 🔴 A rule whose input is missing from the fingerprint never runs: the write endpoint skips
  // the guard when the digest matches. `hr` is in the user tuple, so this already holds —
  // asserted because the whole rule depends on it.
  ok('the fingerprint MOVES when an employee id changes',
    protectedFingerprint(base()) !== protectedFingerprint(collide));
}

// ── the two entry points run the shared rules ────────────────────────────────
{
  const card = read('../src/components/EmployeeHrFieldsCard.jsx');
  ok('the HR card refuses a duplicate through the shared rule', /employeeIdRefusal\(/.test(card));
  ok('…blocks its own Save', /disabled=\{!!dupRefusal\}/.test(card));
  ok('…and shows the refusal on the field', /error=\{dupRefusal \|\| undefined\}/.test(card));
  // CS-229's other half: the card seeded useState once, so a second member's profile showed
  // the first member's record — and saving it wrote their employee id onto this person.
  ok('…and it reseeds when the member on screen changes',
    /useEffect\(\(\) => \{ setHr\(\{ \.\.\.\(user\.hr \|\| \{\}\) \}\); \}, \[user\.id, user\.hr\]\);/.test(card));

  const invite = read('../src/components/AddUserModal.jsx');
  ok('the invite form mints through the shared rule', /import \{ nextEmployeeId \} from '\.\.\/lib\/employeeId'/.test(invite));
  ok('…and keeps no private copy of the mint', !/function nextEmployeeId/.test(invite));
}

console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error('  ✗ ' + f);
process.exitCode = fails.length === 0 ? 0 : 1;
