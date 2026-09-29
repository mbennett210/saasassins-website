// Disabling a member records WHEN (users[].disabledAt), because the pay run and the
// delete guard need it: a disabled member stays on every pay run they were still
// employed in, and a salaried member's pay is owed until the period they left is paid
// out — a salaried member has no punches to show either (pay-run follow-up to the
// deletion audit, 2026-09-22). Offline: pure reducer.
//   node app/scripts/test-user-status.mjs
//
// reducer.js uses Vite-style extensionless relative imports, so register a resolve
// hook (append .js on ERR_MODULE_NOT_FOUND) before importing it (cf. test-supplies.mjs).
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);
const { reducer, ACTIONS } = await import('../src/store/reducer.js');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

const base = {
  users: [
    { id: 'u1', name: 'Ann Admin', role: 'admin', status: 'active', pay: { type: 'salary', salaryPerPeriod: 2400 } },
    { id: 'o1', name: 'Owner', role: 'owner', status: 'active' },
  ],
};
const u1 = (s) => s.users.find((u) => u.id === 'u1');
const update = (s, patch) => reducer(s, { type: ACTIONS.UPDATE_USER, id: 'u1', patch });

const off = update(base, { status: 'disabled' });
ok(typeof u1(off).disabledAt === 'string' && !Number.isNaN(Date.parse(u1(off).disabledAt)), 'DIS-A: disabling a member records when (disabledAt)');
const resaved = update(off, { status: 'disabled', name: 'Ann B. Admin' });
ok(u1(resaved).disabledAt === u1(off).disabledAt, 'DIS-B: saving an already-disabled member keeps the original date');
const back = update(resaved, { status: 'active' });
ok(u1(back).disabledAt === null, 'DIS-C: re-enabling clears it');
const renamed = update(base, { name: 'Ann C. Admin' });
ok(!('disabledAt' in u1(renamed)), 'DIS-D: an edit that leaves status alone adds nothing');
ok(base.users[0].disabledAt === undefined, 'DIS-E: the prior state is not mutated');

console.log(`\n${pass}/${pass + fail} user-status assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
console.log('');
