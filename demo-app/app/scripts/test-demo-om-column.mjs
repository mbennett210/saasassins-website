// test-demo-om-column — the DEMO gets the Operations Manager column (CS-858, plan
// docs/plans/2026-10-16-om-permission-column.md §7: "the demo shows the column, with Gabriel Ortiz
// (OM) resolving through it").
//
// A stored permission row wins over the code default (lib/roles can()), so a browser that saved its
// matrix before the column existed would give every Operations Manager NOTHING on every key. So:
//   1. the seed's matrix names the OM column wherever it names the manager (seedPermissions);
//   2. the demo's Operations Manager — Gabriel Ortiz — resolves through that column: a key taken off
//      the OM column is his to lose while his account managers keep it;
//   3. the v59 → v60 store hop gives a browser seeded before the same matrix, through the SAME pure
//      transform the release data-op runs on production (lib/roles withOpsManagerColumn), so the
//      demo and production cannot drift; seed version and STORAGE_KEY move in lockstep;
//   4. loadState() carries a v59 blob — under the previous key or the current one — to the seed's
//      version with the column in place.
//
// Imports are dynamic, so the pre-change tree reports each check as failed instead of dying.
// Offline. Run: node scripts/test-demo-om-column.mjs
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond) — stated, because this repo's suites disagree.
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const show = (v) => JSON.stringify(v);

// persist.js reads window.localStorage at call time: a memory stand-in, set before it loads.
const memory = new Map();
globalThis.window = {
  localStorage: {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => { memory.set(k, String(v)); },
    removeItem: (k) => { memory.delete(k); },
    key: (i) => [...memory.keys()][i] ?? null,
    get length() { return memory.size; },
  },
};

const R = await import('../src/lib/roles.js');
const { INITIAL_STATE } = await import('../src/data/seed.js');
const P = await import('../src/store/persist.js');
const OM_COL = 'operations_manager';
const can = (u, k, m) => { try { return R.can(u, k, m, []) === true; } catch { return false; } };

// ── 1. the seed's matrix ─────────────────────────────────────────────────────────────────────
{
  const rows = INITIAL_STATE.permissions || [];
  ok(`1. the seed's matrix names the OM column on every row naming the manager, and nowhere else (${rows.filter((p) => p.roles.includes(OM_COL) !== p.roles.includes('manager')).map((p) => p.id).join(', ') || 'none off'})`,
    rows.length > 50 && rows.every((p) => p.roles.includes(OM_COL) === p.roles.includes('manager')) && rows.some((p) => p.roles.includes(OM_COL)));
}

// ── 2. Gabriel Ortiz resolves through it ─────────────────────────────────────────────────────
{
  const om = (INITIAL_STATE.users || []).find((u) => u.role === 'manager' && u.managerLevel === 'operations');
  const am = (INITIAL_STATE.users || []).find((u) => u.role === 'manager' && om && u.opsManagerId === om.id);
  ok(`2. the demo's Operations Manager is Gabriel Ortiz, with an account manager reporting to him (${om?.name} / ${am?.name})`, om?.name === 'Gabriel Ortiz' && !!am);
  const pared = (INITIAL_STATE.permissions || []).map((p) => (p.id === 'time.approve' ? { ...p, roles: p.roles.filter((r) => r !== OM_COL) } : p));
  ok('2. 🔴 a key taken off the OM column is Gabriel\'s to lose, while his account manager keeps it',
    !!om && !!am && can(om, 'time.approve', INITIAL_STATE.permissions) && !can(om, 'time.approve', pared) && can(am, 'time.approve', pared));
  const given = (INITIAL_STATE.permissions || []).map((p) => (p.id === 'payroll.rates.edit' ? { ...p, roles: [...p.roles, OM_COL] } : p));
  ok('2. 🔴 …and a key given to the OM column alone is his, not theirs', !!om && !!am && can(om, 'payroll.rates.edit', given) && !can(am, 'payroll.rates.edit', given));
}

// ── 3. the v59 → v60 hop ─────────────────────────────────────────────────────────────────────
{
  const hop = typeof P.migrateV59toV60 === 'function' ? P.migrateV59toV60 : null;
  ok('3. store/persist has the v59 → v60 hop', !!hop);
  ok(`3. the transform bumps the seed past v59, with STORAGE_KEY in lockstep (seed ${INITIAL_STATE.version})`, INITIAL_STATE.version > 59
    && readFileSync(new URL('../src/store/persist.js', import.meta.url), 'utf8').includes(`const STORAGE_KEY = 'pp.store.v${INITIAL_STATE.version}';`));
  const old = R.seedPermissions().map((p) => ({ ...p, roles: p.roles.filter((r) => r !== OM_COL) }));
  const custom = old.map((p) => (p.id === 'quotes.delete' ? { ...p, roles: ['owner'] } : p));
  const v59 = { version: 59, users: INITIAL_STATE.users, clients: [], permissions: custom };
  const out = hop ? hop(v59) : null;
  ok('3. …lands on the seed\'s version', out?.version === INITIAL_STATE.version);
  const tx = typeof R.withOpsManagerColumn === 'function' ? R.withOpsManagerColumn(custom).permissions : undefined;
  ok('3. 🔴 a browser saved before the column gets it on every manager row — through the SAME transform the release data-op runs',
    !!out && Array.isArray(tx) && show(out.permissions) === show(tx) && out.permissions.every((p) => p.roles.includes(OM_COL) === p.roles.includes('manager')));
  ok('3. …a row the viewer took the manager off stays without the OM column (their choice is copied, not overridden)',
    !!out && show(out.permissions.find((p) => p.id === 'quotes.delete')?.roles) === show(['owner']));
  ok('3. …the rest of the state is left as it was', !!out && out.users === v59.users && out.clients === v59.clients);
  ok('3. …idempotent', !!hop && !!out && show(hop({ ...out, version: 59 }).permissions) === show(out.permissions));
  ok('3. …and a state with no stored matrix stays without one (the code defaults apply)', !!hop && !('permissions' in hop({ version: 59, users: [], clients: [] })));
}

// ── 4. loadState carries a v59 blob to the seed's version ────────────────────────────────────
{
  const old = R.seedPermissions().map((p) => ({ ...p, roles: p.roles.filter((r) => r !== OM_COL) }));
  const blob = JSON.stringify({ ...INITIAL_STATE, version: 59, permissions: old });
  memory.clear();
  memory.set('pp.store.v59', blob);
  const fromPrev = P.loadState();
  ok(`4. a v59 blob under the previous key (pp.store.v59) loads at the seed's version with the column (${fromPrev?.version})`,
    fromPrev?.version === INITIAL_STATE.version && (fromPrev?.permissions || []).some((p) => p.roles.includes(OM_COL))
    && fromPrev.permissions.every((p) => p.roles.includes(OM_COL) === p.roles.includes('manager')));
  memory.clear();
  memory.set(`pp.store.v${INITIAL_STATE.version}`, blob);
  const fromCur = P.loadState();
  ok(`4. …and a v59 blob under the current key too (${fromCur?.version})`, fromCur?.version === INITIAL_STATE.version
    && (fromCur?.permissions || []).every((p) => p.roles.includes(OM_COL) === p.roles.includes('manager')));
  memory.clear();
}

console.log(`\ntest-demo-om-column: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
