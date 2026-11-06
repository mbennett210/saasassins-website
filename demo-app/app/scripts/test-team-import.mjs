// Settings → Team → Import team — one row is one team member (task #466 from Clean Corner's queue;
// offline).
//
// WHY. Matt's team enters its own people (kickoff 2026-09-10 §H), "hundreds and hundreds" at go
// live (the 2026-11-03 call), and Invite Member adds them one at a time. Daniel's picks (2026-11-03):
// the Account column LINKS a cleaner to that customer (users[].worksAt; what they see still comes
// from their cleans), and every row needs an email: the import makes each login and emails the
// set-password link as it runs. This suite holds src/lib/teamImport.js (the plan, the ops, the size
// check, the run), src/lib/worksAt.js and the store's IMPORT_TEAM action, through the REAL reducer
// and the real CSV reader, plus the screens that read the link.
//
//   node app/scripts/test-team-import.mjs
//
// ok(label, cond) — the CONDITION is second in this file.
import { readFileSync } from 'node:fs';
import { loadStore } from './deletion-core.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const read = (p) => { try { return readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };

const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
// Every module is imported defensively, so a tree without the import reports each missing piece
// as a failed check instead of dying on the first import.
let ti = {}; let wa = {}; let csv = {}; let budget = {}; let tables = {}; let core = {}; let picker = {}; let sp = {}; let sample = {}; let roles = {};
try { ti = await import('../src/lib/teamImport.js'); } catch (e) { fails.push(`src/lib/teamImport.js loads (${e.message.split('\n')[0]})`); }
try { wa = await import('../src/lib/worksAt.js'); } catch (e) { fails.push(`src/lib/worksAt.js loads (${e.message.split('\n')[0]})`); }
try { csv = await import('../src/lib/csv.js'); } catch (e) { fails.push(`src/lib/csv.js loads (${e.message.split('\n')[0]})`); }
try { budget = await import('../src/lib/stateBudget.js'); } catch { /* reported below */ }
try { tables = await import('../src/store/tableSlices.js'); } catch { /* reported below */ }
try { core = await import('../src/i18n/core.js'); } catch { /* reported below */ }
try { picker = await import('../src/lib/pickerOptions.js'); } catch { /* reported below */ }
try { sp = await import('../src/store/syncProblems.js'); } catch { /* reported below */ }
try { sample = await import('./team-import-sample.mjs'); } catch { /* reported below */ }
try { roles = await import('../src/lib/roles.js'); } catch { /* reported below */ }
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => { throw new Error(`${name} is missing`); });
const english = (m) => (core.english && m ? core.english(m.$t, m.p) : '');
const keysOf = (list) => (Array.isArray(list) ? list.map((m) => m && m.$t) : []);
const clone = (x) => JSON.parse(JSON.stringify(x));
let idn = 0;
const newIdT = (p = 'id') => `${p}_t${(idn += 1)}`;

const IMPORT = ACTIONS.IMPORT_TEAM;
ok('the store has ONE team import action per run, IMPORT_TEAM', typeof IMPORT === 'string');
const applyOps = (state, ops) => reducer(state, { type: IMPORT, ops });
const serialize = (s) => fn(tables, 'serializeSharedBlob')(s);

const base = () => clone(INITIAL_STATE);
const OWNER_ID = 'u_seed_kyler';
const permsFor = (state, userId = OWNER_ID) => fn(ti, 'teamImportPermissions')({
  actor: state.users.find((u) => u.id === userId), permissions: state.permissions, overrides: state.userPermissionOverrides,
});
function load(text) {
  const parsed = fn(csv, 'parseCsv')(text);
  return { ...parsed, mapping: fn(ti, 'guessTeamMapping')(parsed.headers) };
}
function plan(text, state, perms = permsFor(state), extra = {}) {
  const f = load(text);
  return fn(ti, 'planTeamImport')({ rows: f.rows, mapping: f.mapping, state, perms, live: true, ...extra });
}
const opsOf = (p) => fn(ti, 'buildTeamImportOps')(p, { newId: newIdT });
const imported = (text, state, perms) => applyOps(state, opsOf(plan(text, state, perms)));
const H = 'First name,Last name,Employee ID,Email,Phone,Role,Pay rate,Account\n';
const userBy = (s, email) => s.users.find((u) => (u.email || '').toLowerCase() === email);

// ── A. reading a payroll export ───────────────────────────────────────────────────────────
{
  const headers = ['First Name', 'Last Name', 'Emp #', 'E-mail', 'Cell', 'Position', 'Rate ($/hr)', 'Building', 'SSN', 'Bank Routing', 'Date of Birth'];
  const m = fn(ti, 'guessTeamMapping')(headers);
  const want = { 0: 'firstName', 1: 'lastName', 2: 'employeeId', 3: 'email', 4: 'phone', 5: 'role', 6: 'pay', 7: 'account' };
  ok('A1 a payroll export maps without renaming (Emp #, E-mail, Cell, Position, Rate ($/hr), Building)', JSON.stringify(m) === JSON.stringify(want), JSON.stringify(m));
  ok('A2 private columns are never guessed (SSN, bank routing, date of birth)', m[8] === undefined && m[9] === undefined && m[10] === undefined);
  ok('A3 isPrivateHeader names them', ['SSN', 'Social Security #', 'Bank Routing', 'DOB', 'Tax ID'].every((h) => fn(ti, 'isPrivateHeader')(h)) && !fn(ti, 'isPrivateHeader')('Account #'));
  const m2 = fn(ti, 'guessTeamMapping')(['Employee Name', 'Employee Number', 'Email Address', 'Hourly Rate', 'Customer #', 'Job Title']);
  ok('A4 one Name column, "Customer #" as the account', m2[0] === 'name' && m2[1] === 'employeeId' && m2[2] === 'email' && m2[3] === 'pay' && m2[4] === 'account' && m2[5] === 'role', JSON.stringify(m2));
  const ready = fn(ti, 'teamMappingReady');
  ok('A5 a file must map a name and an email', ready({ 0: 'firstName', 1: 'email' }).name && ready({ 0: 'firstName', 1: 'email' }).email && !ready({ 0: 'employeeId' }).name && !ready({ 0: 'name' }).email);
}

// ── B. small rules ────────────────────────────────────────────────────────────────────────
{
  const pr = fn(ti, 'readPayRate');
  const r = (v) => pr(v);
  ok('B1 pay: 15.50, $15.50, $15.50/hr, 15.5 per hour, 16 an hour, 1,050.00', r('15.50').rate === 15.5 && r('$15.50').rate === 15.5 && r('$15.50/hr').rate === 15.5
    && r('15.5 per hour').rate === 15.5 && r('16 an hour').rate === 16 && r('1,050.00').rate === 1050);
  ok('B2 pay: rounded to the cent, $0 is a rate, blank is none', r('15.555').rate === 15.56 && r('0').rate === 0 && r('').rate === null && !r('').invalid);
  ok('B3 pay: a negative or unreadable rate is invalid', r('-5').invalid && r('fifteen').invalid && r('15-16').invalid && r('$').invalid);
  ok('B4 pay: above $100 an hour is flagged high', r('150').high && !r('99.99').high);
  const rr = fn(ti, 'readTeamRole');
  const all = ['crew', 'manager', 'manager:operations', 'supply_manager', 'admin'];
  ok('B5 roles: blank, cleaner, janitor, porter, "Day Porter" read as Crew', ['', 'cleaner', 'Janitor', 'PORTER', 'Day Porter', 'crew member'].every((w) => rr(w, all).value === 'crew'));
  ok('B6 roles: the levels by name', rr('Account Manager', all).value === 'manager' && rr('Operations Manager', all).value === 'manager:operations'
    && rr('Supply Manager', all).value === 'supply_manager' && rr('Admin', all).value === 'admin');
  ok('B7 roles: Super Admin never; an unknown word is never guessed; a level you can\'t give is refused',
    rr('Super Admin', all).problem === 'superAdmin' && rr('Owner', all).problem === 'superAdmin' && rr('Crew Lead', all).problem === 'unknown' && rr('Admin', ['crew']).problem === 'notAllowed');
}

// ── C. who may import what (the server's rules, mirrored) ────────────────────────────────
{
  const s = base();
  const owner = permsFor(s, 'u_seed_kyler');
  const admin = permsFor(s, 'u_seed_heather');
  const crew = permsFor(s, 'u_seed_crew1');
  ok('C1 a Super Admin imports, sets pay and HR, and gives every level but Super Admin',
    owner.canImport && owner.canPay && owner.canHr && !owner.choices.includes('owner') && owner.choices.includes('crew') && owner.choices.includes('admin'));
  ok('C2 a cleaner never imports (a crew save drops a new member)', crew.canImport === false && crew.choices.length === 0);
  const adminHoldsRates = roles.can && roles.can(s.users.find((u) => u.id === 'u_seed_heather'), 'payroll.rates.edit', s.permissions, s.userPermissionOverrides);
  ok('C3 an Admin\'s pay column follows payroll.rates.edit (CS-003)', admin.canImport && admin.canPay === !!adminHoldsRates);
  const paredOff = clone(s);
  paredOff.userPermissionOverrides = [{ userId: 'u_seed_mgr1', grants: [], revokes: ['settings.team.edit'] }];
  ok('C4 a manager pared off "Edit team" can\'t import', permsFor(paredOff, 'u_seed_mgr1').canImport === false && permsFor(s, 'u_seed_mgr1').canImport === true);
}

// ── D. the plan: new people ──────────────────────────────────────────────────────────────
const FILE = H
  + 'Rosa,Delgado,10234,Rosa.Delgado@Example.com,(954) 555-0142,Crew,15.50,0001\n'
  + 'Jean,Pierre,10235,jean.pierre@example.com,,Janitor,$16.00/hr,Lakeside Office Park\n'
  + 'Kim,Nguyen,10236,kim.nguyen@example.com,,Account Manager,,\n'
  + 'Lu,Noid,,lu.noid@example.com,,,14,0002; 0004 Coral Bay HOA\n';
{
  const s = base();
  const p = plan(FILE, s);
  const [rosa, jean, kim, lu] = p.rows;
  ok('D1 four new people, no problems', p.counts.create === 4 && p.counts.error === 0, JSON.stringify(p.counts));
  ok('D2 Rosa: crew, her pay, her customer by number, her email lower-cased', rosa.status === 'create' && rosa.email === 'rosa.delgado@example.com'
    && rosa.ops[0].user.role === 'crew' && rosa.ops[0].user.pay.hourlyRate === 15.5 && JSON.stringify(rosa.ops[0].user.worksAt) === '["cl_seed_evergreen"]'
    && rosa.ops[0].user.hr.employeeId === '10234' && rosa.ops[0].user.initials === 'RD' && rosa.ops[0].user.phone === '(954) 555-0142');
  ok('D3 Jean: "Janitor" is crew, "$16.00/hr" is 16, the customer by name', jean.ops[0].user.role === 'crew' && jean.ops[0].user.pay.hourlyRate === 16 && jean.ops[0].user.worksAt[0] === 'cl_seed_lakeside');
  ok('D4 Kim: an Account Manager with no pay and no link', kim.ops[0].user.role === 'manager' && !('pay' in kim.ops[0].user) && !('worksAt' in kim.ops[0].user));
  ok('D5 Lu: two customers in one cell ("0002; 0004 Coral Bay HOA")', JSON.stringify(lu.ops[0].user.worksAt) === '["cl_seed_lakeside","cl_seed_mtbaker"]');
  ok('D6 Lu: a blank employee ID gets the next EMP-#### past the roster, with a note', lu.ops[0].user.hr.employeeId === 'EMP-0014' && lu.ops[0].mintedEmployeeId === true
    && keysOf(lu.warnings).includes('teamImport.warn.idMinted'));
  ok('D7 each new row says it emails the set-password link (live)', p.rows.every((r) => keysOf(r.changes).includes('teamImport.chg.invite')));
  const local = plan(FILE, s, permsFor(s), { live: false });
  ok('D8 the login-free demo says no email', local.rows.every((r) => !keysOf(r.changes).includes('teamImport.chg.invite')));
  ok('D9 the plan writes nothing', JSON.stringify(s) === JSON.stringify(base()));
  const ops = opsOf(p);
  ok('D10 ops carry caller-minted ids, status Active (as Invite Member saves them)', ops.length === 4 && ops.every((o) => /^u_t\d+$/.test(o.user.id) && o.user.status === 'active'));
  const after = applyOps(s, ops);
  const r2 = userBy(after, 'rosa.delgado@example.com');
  ok('D11 the store adds them with the default notification settings', after.users.length === s.users.length + 4 && r2 && Object.keys(r2.notificationPrefs || {}).length >= 10);
  ok('D12 a replayed action adds nobody twice', applyOps(after, ops).users.length === after.users.length);
  const again = plan(FILE, after);
  ok('D13 the same file again: every row unchanged (it converges)', again.counts.unchanged === 4 && again.counts.create === 0 && again.counts.update === 0, JSON.stringify(again.counts));
}

// ── E. rows the import refuses ───────────────────────────────────────────────────────────
{
  const s = base();
  const f = H
    + 'Ana,Sinemail,29001,,,Crew,15,0001\n'
    + 'Bo,Bad,29002,bo.bad,,Crew,15,0001\n'
    + 'Cy,One,29003,cy@example.com,,Crew,15,0001\n'
    + 'Cy,Two,29004,CY@example.com,,Crew,15,0001\n'
    + 'Di,Same,29003,di@example.com,,Crew,15,0001\n'
    + 'Ed,Boss,29005,ed@example.com,,Super Admin,,\n'
    + 'Flo,Lead,29006,flo@example.com,,Crew Lead,15,\n'
    + 'Gus,Rate,29007,gus@example.com,,Crew,fifteen,\n'
    + ',,29008,noname@example.com,,Crew,15,\n'
    + 'Hal,Other,EMP-0006,hal@example.com,,Crew,15,\n'
    + 'Tomas,Rivera,EMP-0099,tomas@cleanspaceonline.com,,Crew,,\n';
  const p = plan(f, s);
  const k = (i) => keysOf(p.rows[i].errors);
  ok('E1 no email', k(0).includes('teamImport.err.noEmail'));
  ok('E2 not an email', k(1).includes('teamImport.err.emailInvalid'));
  ok('E3 the first of two rows with one email is kept; the second names it', p.rows[2].status === 'create' && k(3).includes('teamImport.err.duplicateEmail') && p.rows[3].errors[0].p.row === 4);
  ok('E4 an employee ID earlier in the file', k(4).includes('teamImport.err.duplicateEmployeeId'));
  ok('E5 Super Admin from a file', k(5).includes('teamImport.err.roleSuperAdmin'));
  ok('E6 an unknown role', k(6).includes('teamImport.err.roleUnknown'));
  ok('E7 an unreadable pay rate', k(7).includes('teamImport.err.payInvalid'));
  ok('E8 no name', k(8).includes('teamImport.err.noName'));
  ok('E9 an employee ID someone else on the team holds, with another email', k(9).includes('teamImport.err.idOtherMember') && /Andre Baptiste/.test(english(p.rows[9].errors[0])));
  ok('E10 a member on file by email whose employee ID differs', k(10).includes('teamImport.err.idMismatch') && /EMP-0007/.test(english(p.rows[10].errors[0])));
  ok('E11 a row in error carries no ops', p.rows.filter((r) => r.status === 'error').every((r) => r.ops.length === 0) && p.counts.error === 10, JSON.stringify(p.counts));
  const limited = { ...permsFor(s), choices: ['crew'] };
  const p2 = plan(`${H}Ivy,Admin,29009,ivy@example.com,,Admin,,\n`, s, limited);
  ok('E12 a level the importer couldn\'t pick on Invite Member is refused', keysOf(p2.rows[0].errors).includes('teamImport.err.roleNotAllowed'));
  const none = plan(`${H}Ivy,Admin,29009,ivy@example.com,,Crew,,\n`, s, { ...permsFor(s), canImport: false });
  ok('E13 without the key, nothing imports', none.counts.error === 1 && keysOf(none.rows[0].errors).includes('teamImport.err.notPermitted'));
}

// ── F. the Account column ────────────────────────────────────────────────────────────────
{
  const s = base();
  s.clients.push({ id: 'cl_dup1', name: 'Harbor Point', type: 'customer' }, { id: 'cl_dup2', name: 'Harbor Point', type: 'customer' });
  s.clients.push({ id: 'cl_arch', name: 'Old Mill Lofts', type: 'customer', statusOverride: 'archived' });
  s.clients.push({ id: 'cl_inact', name: 'Quiet Pines', type: 'customer', statusOverride: 'inactive' });
  const f = H
    + 'A,One,30001,a1@example.com,,Crew,15,Nowhere Plaza\n'
    + 'A,Two,30002,a2@example.com,,Crew,15,Harbor Point\n'
    + 'A,Three,30003,a3@example.com,,Crew,15,0001 Coral Bay HOA\n'
    + 'A,Four,30004,a4@example.com,,Crew,15,Sunshine Supply Co\n'
    + 'A,Five,30005,a5@example.com,,Crew,15,Old Mill Lofts\n'
    + 'A,Six,30006,a6@example.com,,Crew,15,Quiet Pines\n'
    + 'A,Seven,30007,a7@example.com,,Account Manager,,0001\n'
    + 'A,Eight,30008,a8@example.com,,Crew,15,#4\n'
    + 'A,Nine,30009,a9@example.com,,Crew,15,las olas medical group\n';
  const p = plan(f, s);
  const w = (i) => keysOf(p.rows[i].warnings);
  const linked = (i) => p.rows[i].ops[0]?.user?.worksAt || [];
  ok('F1 unknown customer: a note, added unlinked', w(0).includes('teamImport.warn.accountNotFound') && p.rows[0].status === 'create' && !linked(0).length);
  ok('F2 two customers share the name: a note, unlinked', w(1).includes('teamImport.warn.accountAmbiguous') && !linked(1).length);
  ok('F3 the number and the name are different customers: a note, unlinked', w(2).includes('teamImport.warn.accountMismatch') && !linked(2).length);
  ok('F4 a vendor, an archived and an inactive customer are never linked', ['teamImport.warn.accountInactive'].every((k) => w(3).includes(k) && w(4).includes(k) && w(5).includes(k)) && !linked(3).length && !linked(4).length && !linked(5).length);
  ok('F5 a non-cleaner\'s account is left out with a note', w(6).includes('teamImport.warn.accountNotCrew') && !linked(6).length);
  ok('F6 "#4" is customer 0004; a name matches whatever its case', linked(7)[0] === 'cl_seed_mtbaker' && linked(8)[0] === 'cl_seed_evergreen');
}

// ── G. people already on the team: blanks only ───────────────────────────────────────────
{
  const s = base();
  // Andre (crew, EMP-0006, $22, no link) and Matt (owner, pay "none").
  s.users = s.users.map((u) => (u.id === 'u_seed_crew1' ? { ...u, phone: '' } : u));
  const f = H
    + 'Andre,Baptiste,EMP-0006,andre@cleanspaceonline.com,(954) 555-0100,Admin,15,0004\n'
    + 'Matt,Giunco,EMP-0001,matt@cleanspaceonline.com,,,30,0001\n';
  const p = plan(f, s);
  const [andre, matt] = p.rows;
  ok('G1 matched by employee ID: a fill, never a new person', andre.status === 'update' && andre.ops[0].op === 'fillUser' && keysOf(andre.changes).includes('teamImport.chg.matchedId'));
  ok('G2 the role on file is kept (with a note), the pay on file is kept (with a note)', keysOf(andre.warnings).includes('teamImport.warn.roleKept') && keysOf(andre.warnings).includes('teamImport.warn.payKept') && !('pay' in andre.ops[0].patch));
  ok('G3 the blank phone and the empty link are filled', andre.ops[0].patch.phone === '(954) 555-0100' && JSON.stringify(andre.ops[0].patch.worksAt) === '["cl_seed_mtbaker"]');
  ok('G4 pay "none" is no pay: filled; a Super Admin isn\'t linked to a customer', matt.ops[0].patch.pay?.hourlyRate === 30 && keysOf(matt.warnings).includes('teamImport.warn.accountNotCrew'));
  const after = applyOps(s, opsOf(p));
  const a = after.users.find((u) => u.id === 'u_seed_crew1');
  const m = after.users.find((u) => u.id === 'u_seed_kyler');
  ok('G5 applied: Andre keeps his role, email and $22; gains the phone and the link', a.role === 'crew' && a.email === 'andre@cleanspaceonline.com' && a.pay.hourlyRate === 22 && a.phone === '(954) 555-0100' && a.worksAt[0] === 'cl_seed_mtbaker');
  ok('G6 applied: Matt\'s pay is set to hourly 30', m.pay.type === 'hourly' && m.pay.hourlyRate === 30);
  const ops = opsOf(p);
  const changed = clone(s);
  changed.users = changed.users.map((u) => (u.id === 'u_seed_crew1' ? { ...u, phone: '(305) 000-0000', worksAt: ['cl_seed_lakeside'] } : u));
  const late = applyOps(changed, ops).users.find((u) => u.id === 'u_seed_crew1');
  ok('G7 a value set between the preview and the save is never overwritten', late.phone === '(305) 000-0000' && JSON.stringify(late.worksAt) === '["cl_seed_lakeside"]');
  const again = plan(f, after);
  ok('G8 the same file again: both unchanged', again.counts.unchanged === 2, JSON.stringify(again.counts));
  const noHr = clone(s);
  noHr.users = noHr.users.map((u) => (u.id === 'u_seed_crew2' ? { ...u, hr: {} } : u));
  const p3 = plan(`${H}Tomas,Rivera,10777,tomas@cleanspaceonline.com,,Crew,,\n`, noHr);
  ok('G9 a member with no employee ID gets the file\'s', p3.rows[0].ops[0]?.patch?.employeeId === '10777'
    && applyOps(noHr, opsOf(p3)).users.find((u) => u.id === 'u_seed_crew2').hr.employeeId === '10777');
  const p4 = plan(`${H}Tomas,Rivera,10777,tomas@cleanspaceonline.com,,Crew,,\n`, noHr, { ...permsFor(noHr), canHr: false });
  ok('G10 …unless the importer can\'t edit HR records (a note instead)', !p4.rows[0].ops.length && keysOf(p4.rows[0].warnings).includes('teamImport.warn.hrNotAllowed'));
  const p5 = plan(`${H}Matt,Giunco,EMP-0001,matt@cleanspaceonline.com,,,30,\n`, s, { ...permsFor(s), ownPay: false });
  ok('G11 your own pay only as the server allows it', !p5.rows[0].ops.length && keysOf(p5.rows[0].warnings).includes('teamImport.warn.ownPay'));
}

// ── H. the store's write point ───────────────────────────────────────────────────────────
{
  const s = base();
  const added = reducer(s, { type: ACTIONS.ADD_USER, user: { id: 'u_x', name: 'X', email: 'x@example.com', role: 'crew', worksAt: ['cl_seed_evergreen', 'nope', 'cl_seed_evergreen'] } });
  ok('H1 ADD_USER keeps only customers on file, once each', JSON.stringify(added.users.find((u) => u.id === 'u_x').worksAt) === '["cl_seed_evergreen"]');
  const cleared = reducer(added, { type: ACTIONS.UPDATE_USER, id: 'u_x', patch: { worksAt: [] } });
  ok('H2 UPDATE_USER with none drops the field (sparse)', !('worksAt' in cleared.users.find((u) => u.id === 'u_x')));
  const junk = reducer(s, { type: ACTIONS.ADD_USER, user: { id: 'u_y', name: 'Y', email: 'y@example.com', worksAt: ['nope'] } });
  ok('H3 nothing on file = no field', !('worksAt' in junk.users.find((u) => u.id === 'u_y')));
  const step = fn(ti, 'teamImportStepAction');
  const meanwhile = reducer(s, { type: ACTIONS.ADD_USER, user: { id: 'u_other', name: 'Z', email: 'late@example.com', role: 'crew', hr: { employeeId: 'EMP-0014' } } });
  ok('H4 an add whose email someone added since the preview is skipped', step(meanwhile, { op: 'addUser', user: { id: 'u_new', email: 'LATE@example.com', name: 'Late' } }, ACTIONS) === null);
  const reMint = step(meanwhile, { op: 'addUser', mintedEmployeeId: true, user: { id: 'u_new', email: 'n@example.com', name: 'N', hr: { employeeId: 'EMP-0014' } } }, ACTIONS);
  ok('H5 an employee ID the import minted, taken since: minted again', reMint?.user?.hr?.employeeId === 'EMP-0015', JSON.stringify(reMint?.user?.hr));
  const dropped = step(meanwhile, { op: 'addUser', user: { id: 'u_new', email: 'n@example.com', name: 'N', hr: { employeeId: 'emp-0014' } } }, ACTIONS);
  ok('H6 a file\'s employee ID taken since: left off, never a duplicate (the save is never refused for it)', dropped && !dropped.user.hr.employeeId);
  ok('H7 an op the step doesn\'t know does nothing', step(s, { op: 'deleteUser', id: 'u_seed_crew1' }, ACTIONS) === null);
}

// ── I. the size check, before any login is made ──────────────────────────────────────────
{
  const s = base();
  const p = plan(FILE, s);
  const prep = fn(ti, 'prepareTeamImport')({ state: s, plan: p, newId: newIdT, applyOps, serialize });
  ok('I1 measured the way sync posts it, and it fits', prep.verdict && prep.verdict.fits && prep.verdict.members === 4 && prep.refusal === null && prep.verdict.after > prep.verdict.before);
  const big = clone(s);
  const room = (budget.IMPORT_ALLOWED_BYTES || 0) - (prep.verdict?.before || 0);
  big.company = { ...big.company, filler: 'x'.repeat(Math.max(0, room - 1500)) };
  const refused = fn(ti, 'prepareTeamImport')({ state: big, plan: plan(FILE, big), newId: newIdT, applyOps, serialize });
  ok('I2 an import past 90% of the limit is refused in words, before anything runs', refused.verdict && !refused.verdict.fits && refused.refusal?.$t === 'teamImport.tooLarge'
    && /3\.5 MB/.test(english(refused.refusal)));
  const nothing = fn(ti, 'prepareTeamImport')({ state: s, plan: { rows: [] }, newId: newIdT, applyOps, serialize });
  ok('I3 nothing to import says so', nothing.refusal?.$t === 'teamImport.nothingToDo');
}

// ── J. the run: logins, then the roster, 25 people at a time ─────────────────────────────
{
  const s = base();
  const rows = fn(sample, 'teamSampleRows')(60);
  const text = [fn(sample, 'teamSampleCsv') && sample.SAMPLE_HEADERS.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const p = plan(text, s);
  ok('J0 the 60-row sample plans clean', p.counts.create === 60 && p.counts.error === 0, JSON.stringify(p.counts));
  // A fill for Andre rides with the first run.
  const ops = [...opsOf(p), { op: 'fillUser', line: 99, id: 'u_seed_crew1', patch: { worksAt: ['cl_seed_evergreen'] } }];
  let store = s;
  const dispatched = [];
  const dispatch = (a) => { dispatched.push(a); store = reducer(store, a); };
  let live = 0; let peak = 0;
  const calls = [];
  const createLogin = async (email, role, mintedId) => {
    calls.push({ email, role, mintedId });
    live += 1; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 1));
    live -= 1;
    if (email === rows[5][3]) throw new Error('This email belongs to another organization.');
    if (email === rows[6][3]) return { invited: true, adopted: true, orgUserId: 'u_orphan_adopted' };
    if (email === rows[7][3]) return { invited: false, why: 'failed', link: 'https://example.test/one-time' };
    return { invited: true, orgUserId: mintedId };
  };
  const progress = [];
  const res = await fn(ti, 'runTeamImport')({
    ops, live: true, createLogin, bindId: (r, id) => (r?.orgUserId || id), dispatch, actionType: IMPORT,
    getState: () => store, applyOps, onProgress: (x) => progress.push(x),
  });
  ok('J1 one login per new person, at most 3 at a time', calls.length === 60 && peak <= 3 && peak >= 2, `calls ${calls.length} peak ${peak}`);
  ok('J2 runs of 25: three actions (25, 25, 10), the fill in the first', dispatched.length === 3 && dispatched.every((a) => a.type === IMPORT)
    && dispatched[0].ops.length === 25 && dispatched[0].ops[0].op === 'fillUser' && dispatched[2].ops.length === 10, dispatched.map((a) => a.ops.length).join(','));
  ok('J3 a refused login is left off the roster, with the server\'s words', res.refused.length === 1 && /another organization/.test(res.refused[0].why) && !userBy(store, rows[5][3]));
  ok('J4 an orphan login is adopted: the server\'s id is the roster id', userBy(store, rows[6][3])?.id === 'u_orphan_adopted' && res.added.find((x) => x.email === rows[6][3])?.adopted === true);
  ok('J5 an email that didn\'t go is reported, and the one-time link is never kept', res.added.find((x) => x.email === rows[7][3])?.invited === false
    && res.added.find((x) => x.email === rows[7][3])?.why === 'failed' && !JSON.stringify(res).includes('one-time') && !JSON.stringify(store).includes('one-time'));
  ok('J6 59 added, the fill counted, progress after each run', res.added.length === 59 && res.filled === 1 && progress.map((x) => x.done).join(',') === '25,50,60');
  ok('J7 every added person is Active with their pay and their link', res.added.every((x) => { const u = userBy(store, x.email); return u && u.status === 'active' && u.pay?.type === 'hourly' && (u.worksAt || []).length >= 1; }));
  // Stop after the first run.
  let store2 = s;
  const d2 = [];
  const res2 = await fn(ti, 'runTeamImport')({
    ops: opsOf(p), live: true, createLogin: async (e, r, id) => ({ invited: true, orgUserId: id }), bindId: (r, id) => (r?.orgUserId || id),
    dispatch: (a) => { d2.push(a); store2 = reducer(store2, a); }, actionType: IMPORT, getState: () => store2, applyOps, shouldStop: () => true,
  });
  ok('J8 "Stop after this run": the run on hand is saved, the rest left for next time', res2.stopped && res2.left === 35 && d2.length === 1 && res2.added.length === 25);
  const rerun = plan(text, store2);
  ok('J9 the same file again picks up the rest (the first 25 read unchanged)', rerun.counts.unchanged === 25 && rerun.counts.create === 35, JSON.stringify(rerun.counts));
  // The login-free demo: one action, no logins.
  let store3 = s; let d3 = 0; let loginCalls = 0;
  const res3 = await fn(ti, 'runTeamImport')({
    ops: opsOf(p), live: false, createLogin: async () => { loginCalls += 1; return {}; }, bindId: (r, id) => id,
    dispatch: (a) => { d3 += 1; store3 = reducer(store3, a); }, actionType: IMPORT, getState: () => store3, applyOps,
  });
  ok('J10 the demo: no logins, one action, everyone added', loginCalls === 0 && d3 === 1 && res3.added.length === 60 && res3.added.every((x) => x.invited === false));
  // Someone added a person by hand while the run was out.
  let store4 = s;
  const res4 = await fn(ti, 'runTeamImport')({
    ops: opsOf(plan(text, s)).slice(0, 3), live: true,
    createLogin: async (e, r, id) => {
      if (!userBy(store4, rows[1][3])) store4 = reducer(store4, { type: ACTIONS.ADD_USER, user: { id: 'u_by_hand', name: 'By Hand', email: rows[1][3], role: 'crew' } });
      return { invited: true, orgUserId: id };
    },
    bindId: (r, id) => (r?.orgUserId || id), dispatch: (a) => { store4 = reducer(store4, a); }, actionType: IMPORT, getState: () => store4, applyOps,
  });
  ok('J11 a person added by hand since the preview is skipped, never doubled', res4.skipped.length === 1 && res4.added.length === 2
    && store4.users.filter((u) => u.email === rows[1][3]).length === 1);
}

// ── K. 1,000 people: time and bytes ──────────────────────────────────────────────────────
{
  const s = base();
  const text = fn(sample, 'teamSampleCsv')(1000);
  const t0 = Date.now();
  const p = plan(text, s);
  const t1 = Date.now();
  const prep = fn(ti, 'prepareTeamImport')({ state: s, plan: p, newId: newIdT, applyOps, serialize });
  const t2 = Date.now();
  ok('K1 a 1,000-row file plans clean', p.counts.create === 1000 && p.counts.error === 0, JSON.stringify(p.counts));
  ok('K2 it plans in under 2 s, and is measured in under 3 s', t1 - t0 < 2000 && t2 - t1 < 3000, `plan ${t1 - t0} ms, size ${t2 - t1} ms`);
  const per = prep.verdict?.perMember || 0;
  ok('K3 about 0.8 KB per person (the default notification settings are most of it)', per > 500 && per < 1200, `${per} bytes`);
  ok('K4 the shared record after 1,000 people still fits', prep.verdict?.fits === true, `${prep.verdict?.after} bytes`);
  console.log(`  measured: 1,000 people plan in ${t1 - t0} ms, size check ${t2 - t1} ms, ${per} bytes a person, record ${(prep.verdict?.before / 1e6).toFixed(2)} → ${(prep.verdict?.after / 1e6).toFixed(2)} MB`);
}

// ── L. files ─────────────────────────────────────────────────────────────────────────────
{
  const s = base();
  const tmpl = fn(ti, 'teamTemplateCsv')();
  const p = plan(tmpl, s);
  ok('L1 the template maps back exactly and plans clean against the demo seed', p.counts.error === 0 && p.counts.create + p.counts.update === 3, JSON.stringify(p.counts));
  const f = fn(sample, 'teamSampleCsv')(30, { problems: true });
  const parsed = load(f);
  const pp = fn(ti, 'planTeamImport')({ rows: parsed.rows, mapping: parsed.mapping, state: s, perms: permsFor(s), live: true });
  const out = fn(ti, 'teamProblemsCsv')({ plan: pp, headers: parsed.headers, render: english });
  ok('L2 the problems file has the rows with problems, their reasons, and never a private column', /Import result/.test(out) && /No email/.test(out) && !/SSN/.test(out) && !/xxx-xx/.test(out));
  ok('L3 the demo\'s 30-row file has one of every problem', pp.counts.error >= 7 && pp.counts.warning >= 6, JSON.stringify(pp.counts));
}

// ── M. where the link shows ──────────────────────────────────────────────────────────────
{
  const users = [
    { id: 'a', role: 'crew', status: 'active', worksAt: ['c1'] },
    { id: 'b', role: 'crew', status: 'disabled', worksAt: ['c1'] },
    { id: 'c', role: 'manager', status: 'active', worksAt: ['c1'] },
    { id: 'd', role: 'crew', status: 'active' },
  ];
  ok('M1 a customer\'s linked cleaners: active crew only', JSON.stringify(fn(wa, 'linkedCleanerIds')(users, 'c1')) === '["a"]');
  ok('M2 a link to a customer that is gone reads as nothing', fn(wa, 'worksAtClients')({ worksAt: ['c1', 'gone'] }, [{ id: 'c1' }]).length === 1);
  const pool = ['p1', 'p2', 'p3', 'p4'].map((id) => ({ id, name: id.toUpperCase() }));
  const rows = fn(picker, 'crewPickerRows')(pool, { leadIds: ['p4'], preferIds: ['p3', 'p4'] }).matches.map((u) => u.id).join(',');
  ok('M3 the picker: the people picked, then the ones who work here, then everyone else', rows === 'p4,p3,p1,p2', rows);
  ok('M4 typing still narrows first', fn(picker, 'crewPickerRows')(pool, { query: 'p1', preferIds: ['p3'] }).matches.map((u) => u.id).join(',') === 'p1');
  const said = fn(sp, 'describeRefusedAction')({ type: IMPORT, ops: [{}, {}, {}] }, base());
  ok('M5 a refused run is named in the "not saved" message', said.key === 'syncProblem.change.importTeam' && said.params.count === 3);
}

// ── N. the screens ───────────────────────────────────────────────────────────────────────
{
  const modal = read('../src/components/TeamImportModal.jsx');
  const team = read('../src/pages/settings/Team.jsx');
  const detail = read('../src/pages/settings/TeamDetail.jsx');
  const svc = read('../src/components/ServiceSetupCard.jsx');
  const cov = read('./test-i18n-coverage.mjs');
  ok('N1 the modal runs the one engine: size first, then runTeamImport; never a bare ADD_USER', /prepareTeamImport\(/.test(modal) && /runTeamImport\(/.test(modal) && !/ACTIONS\.ADD_USER/.test(modal) && /createTeamLogin/.test(modal) && /bindRosterId/.test(modal));
  ok('N2 the modal is the kit Modal, and a converted screen (UI_RULES §140)', /import Modal from '\.\/Modal'/.test(modal) && /'src\/components\/TeamImportModal\.jsx'/.test(cov));
  ok('N3 the pay column is offered only with "Edit pay rates"', /f\.key !== 'pay' \|\| perms\.canPay/.test(modal));
  ok('N4 Team: Import team beside Invite Member, for the "Edit team" key, and the Works at column', /<TeamImportModal/.test(team) && /canEdit && \(\s*<button[^\n]*setImportOpen\(true\)/.test(team) && /t\('worksAt\.label'\)/.test(team));
  ok('N5 a cleaner\'s page: the Works at field saves through the whitelist', /patch\.worksAt = worksAtOf\(current\)/.test(detail) && /<BuildingMultiPicker/.test(detail));
  // The card's cleaners come from the one selector the onboarding bar's Cleaners step shares (task 471).
  const sel = read('../src/store/selectors.js');
  ok('N6 a customer\'s page lists its linked cleaners, "not on a clean yet"', /selectAssignedCleanersForClient\(/.test(svc) && /worksAt\.notOnClean/.test(svc)
    && /export function selectAssignedCleanersForClient[\s\S]{0,400}cleanersLinkedTo\(/.test(sel));
  ok('N7 the three crew pickers pass the customer\'s cleaners', /preferIds=\{preferCrew\}/.test(read('../src/components/NewJobModal.jsx')) && /preferCrew=\{preferCrew\}/.test(read('../src/components/NewJobModal.jsx'))
    && /preferIds=\{preferCrew\}/.test(read('../src/components/ScheduleBlocksEditor.jsx')) && /preferIds=\{preferCrew\}/.test(read('../src/pages/JobDetail.jsx')));
  ok('N8 no raw colour in the modal', !/#[0-9a-fA-F]{3,6}\b/.test(modal));
  ok('N9 its ×, buttons and counts sit in their middle by code (components/Centred), the Team page\'s Import team too',
    (modal.match(/<Modal [^\n]*size="lg" centred>/g) || []).length === 2 && !/<button[^\n]*className="btn [^"]*"[^\n]*(?:\}|")>\{t\(/.test(modal)
    && /<span className="control-count"><Centred kind="ink"/.test(modal) && /<Centred>\{t\('teamImport\.title'\)\}<\/Centred>/.test(team));
  ok('N10 while the paste box has the cursor, a drag moves only its text (a non-passive touchmove, on the file step only)',
    /addEventListener\('touchmove', move, \{ passive: false \}\)/.test(modal) && /useHoldWhileTyping\(pasteRef, open && typing && step === STEP\.FILE\)/.test(modal)
    && /ref=\{pasteRef\}[^\n]*onFocus=\{\(\) => setTyping\(true\)\} onBlur=\{\(\) => setTyping\(false\)\}/.test(modal));
  // The preview: each fact in its own column, the notes under the row (Daniel's pick 2026-11-03,
  // "A · Each fact in its own column"), as the engine's rows carry them.
  ok('N11 the preview: Result, Team member (row and email under the name), Role, Employee ID, Pay, Works at; notes under the row (in the card on a phone)',
    /<th>\{t\('custImport\.col\.result'\)\}<\/th>\s*<th>\{t\('teamImport\.col\.member'\)\}<\/th>\s*<th>\{t\('teamImport\.field\.role'\)\}<\/th>\s*<th>\{t\('teamImport\.field\.employeeId'\)\}<\/th>\s*<th>\{t\('teamImport\.col\.pay'\)\}<\/th>\s*<th>\{t\('teamImport\.col\.worksAt'\)\}<\/th>/.test(modal)
    && /t\('teamImport\.rowEmail', \{ line: r\.line/.test(modal) && /\{noteList && !phone && <tr className="csv-note-row">/.test(modal) && /\{noteList && phone && <td data-label=\{t\('teamImport\.col\.notes'\)\}/.test(modal));
  {
    const s0 = base();
    const onFile = s0.users.find((u) => u.role === 'crew' && u.email && u.pay && u.pay.type && u.pay.type !== 'none');
    const p = plan(`${H}Rosa,Delgado,,rosa.d@example.com,,Crew,17.50,\n${onFile ? `${onFile.name},,,${onFile.email},,Crew,99,` : ''}\n`, s0);
    const [r = {}, m = {}] = p.rows || [];
    ok('N12 a preview row carries the role, the pay and whether pay is on file',
      r.status === 'create' && r.pay === 17.5 && r.payOnFile === false && english(r.role) === 'Crew'
      && !!onFile && m.pay === null && m.payOnFile === true && english(m.role) === 'Crew',
      JSON.stringify({ new: { role: r.role, pay: r.pay, payOnFile: r.payOnFile }, onFile: { role: m.role, pay: m.pay, payOnFile: m.payOnFile } }));
  }
  // The Team list's person cell (UI_RULES §191, Daniel's pick 2026-11-03 "B · Name with email under it"):
  // never the wrapping .flex-row, which dropped names under their photos.
  const css = read('../src/index.css');
  ok('N13 Team: the email under the name, one line that never wraps; no Email column',
    /className="table-name-link team-person"/.test(team) && /<span className="team-person-sub truncate"/.test(team) && !/<th>Email<\/th>/.test(team)
    && !/className="flex-row table-name-link"/.test(team) && /\.team-person \{[^}]*flex-wrap: nowrap/.test(css) && /\.team-person-text \{[^}]*min-width: 0/.test(css));
  ok('N14 Team: the initials centred by code (<Avatar centred>), and the name column\'s 330px a computer\'s only (a phone\'s card is the screen\'s width: at 320 it ran the page 361px wide)',
    /<Avatar user=\{u\} size="sm" centred \/>/.test(team)
    && /@media \(min-width: 641px\) \{\s*\.team-table td\.cell-primary \{ width: 330px; \}\s*\}/.test(css)
    && !/\n\.team-table td\.cell-primary \{ width/.test(css)
    && /@media \(min-width: 641px\) \{\s*\.team-preview tbody td \{ background/.test(css));
}

console.log(`\ntest-team-import: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
