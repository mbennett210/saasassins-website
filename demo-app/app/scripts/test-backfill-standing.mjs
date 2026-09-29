// The Sept 3 backfill planner: materialize the old helper-supplement crew into
// explicit crewIds, and ONLY for those cleans. Pins the transform so a blind
// prod run can't over- or under-reach.
import { planBackfill } from './backfill-standing-into-crewids.mjs';

let pass = 0; const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const sameSet = (a, b) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

// account cl has regulars [ann, ben]; site st (under cl) adds regular [cara].
const state = {
  clients: [{ id: 'cl', standingCrewIds: ['ann', 'ben'] }, { id: 'cl2', standingCrewIds: [] }],
  sites: [{ id: 'st', clientId: 'cl', standingCrewIds: ['cara'] }],
  users: [],
};
const job = (id, crewIds, extra = {}) => ({ id, client_id: 'cl', site_id: 'st', status: 'upcoming', data: { crewIds, ...extra }, ...extra.top });

// helper-only clean → regulars appended (helper kept, regulars added, deduped)
{
  const plan = planBackfill(state, [job('j1', ['helper'])]);
  ok('🔴 helper-only clean is backfilled', plan.length === 1 && plan[0].id === 'j1');
  ok('  helper kept, site + account regulars appended', sameSet(plan[0].after, ['helper', 'ann', 'ben', 'cara']) && plan[0].after[0] === 'helper');
}
// clean that already names a regular → authoritative, untouched
ok('names a regular → NOT backfilled', planBackfill(state, [job('j2', ['ann', 'helper'])]).length === 0);
// unnamed clean → regulars already cover it, untouched
ok('empty crewIds → NOT backfilled', planBackfill(state, [job('j3', [])]).length === 0);
// helper-only at an account with NO regulars → nothing to add
ok('no regulars at the location → NOT backfilled', planBackfill(state, [{ id: 'j4', client_id: 'cl2', site_id: null, status: 'upcoming', data: { crewIds: ['helper'] } }]).length === 0);
// every regular excluded for this clean → leave as-is (office removed them on purpose)
ok('all regulars excluded → NOT backfilled', planBackfill(state, [job('j5', ['helper'], { crewExcludedIds: ['ann', 'ben', 'cara'] })]).length === 0);
// partial exclusion → only the non-excluded regulars are added
{
  const plan = planBackfill(state, [job('j6', ['helper'], { crewExcludedIds: ['ben'] })]);
  ok('partial exclusion → only non-excluded regulars added', plan.length === 1 && sameSet(plan[0].after, ['helper', 'ann', 'cara']));
}
// idempotent: re-running on an already-materialized clean is a no-op
ok('idempotent (already has all regulars) → NOT backfilled', planBackfill(state, [job('j7', ['helper', 'ann', 'ben', 'cara'])]).length === 0);

// The DB runner must page through ALL upcoming cleans — PostgREST caps a select at
// ~1000 rows, and there are ~3900 upcoming, so a single select silently backfilled
// only a third (Sept 3). Pin the pagination so that can't regress.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'backfill-standing-into-crewids.mjs'), 'utf8');
ok('🔴 the runner pages through all upcoming cleans (no 1000-row cap)', /\.range\(from, from \+ PAGE - 1\)/.test(src) && /if \(data\.length < PAGE\) break;/.test(src));

console.log(`\nbackfill planner: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
