// Crew resolution — the ONE rule that decides who a clean is assigned to.
// 2026-09-19 model (feat/crew 008f5f2, "crew comes only from the schedule"):
// crew is EXACTLY what the schedule names in job.crewIds. There is no standing /
// regular crew and no crewExcludedIds — every clean is created and edited with its
// cleaners named. Consolidated in lib/crewResolve.js; this pins the rule AND asserts
// every twin still routes through the shared module so it can never re-fork.
//
//   node scripts/test-crew-resolve.mjs
import { readFileSync } from 'node:fs';
import { resolveJobCrewIds, isUserJobCrew } from '../src/lib/crewResolve.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── crew = exactly job.crewIds ───────────────────────────────────────────────
{
  const job = { crewIds: ['u_a', 'u_b'] };
  ok('crew is exactly the named set', resolveJobCrewIds(job).size === 2 && isUserJobCrew(job, 'u_a') && isUserJobCrew(job, 'u_b'));
  ok('someone NOT named is not on the clean', !isUserJobCrew(job, 'u_c'));
  ok('resolveJobCrewIds and isUserJobCrew agree', [...resolveJobCrewIds(job)].every((id) => isUserJobCrew(job, id)));
}

// ── empty / missing crewIds → nobody (no standing fallback) ──────────────────
ok('empty crewIds → empty set (no standing regulars)', resolveJobCrewIds({ crewIds: [] }).size === 0);
ok('missing crewIds → empty set', resolveJobCrewIds({}).size === 0);
ok('a nobody-named clean assigns no one', !isUserJobCrew({ crewIds: [] }, 'u_a'));
ok('falsy ids are filtered out', resolveJobCrewIds({ crewIds: ['u_a', null, '', undefined] }).size === 1);

// ── null-safety ──────────────────────────────────────────────────────────────
ok('missing job/user is safe', !isUserJobCrew(null, 'u') && !isUserJobCrew({ crewIds: ['u'] }, null));
ok('a non-array crewIds is safe', resolveJobCrewIds({ crewIds: 'nope' }).size === 0);

// ── 🔒 LOCKSTEP: every twin routes through the shared resolver ───────────────
const selectors = read('../src/store/selectors.js');
const server = read('../api/_lib/time/store.js');
const notifs = read('../src/lib/notifications.js');
ok('selectors.js imports the shared resolver', /from '\.\.\/lib\/crewResolve'/.test(selectors));
ok('  isJobAssignedToUser uses isUserJobCrew', /isJobAssignedToUser[\s\S]{0,400}isUserJobCrew\(/.test(selectors));
ok('  selectJobsForUser uses isUserJobCrew', /selectJobsForUser[\s\S]{0,400}isUserJobCrew\(/.test(selectors));
ok('  effectiveCrewIdSet uses resolveJobCrewIds', /effectiveCrewIdSet[\s\S]{0,300}resolveJobCrewIds\(/.test(selectors));
ok('  selectEffectiveCrewForJob uses resolveJobCrewIds', /selectEffectiveCrewForJob[\s\S]{0,400}resolveJobCrewIds\(/.test(selectors));
ok('🔴 no assignment predicate still does `standingCrewIds…includes(userId)) return true`',
  !/standingCrewIds \|\| \[\]\)\.includes\(userId\)\)\s*return true/.test(selectors));
ok('server clock-in gate imports + uses the shared resolver',
  /from '\.\.\/\.\.\/\.\.\/src\/lib\/crewResolve\.js'/.test(server)
  && /isAssignedToJob\(job, userId[\s\S]{0,200}isUserJobCrew\(/.test(server));
ok('notification fan-out uses resolveJobCrewIds', /resolveJobCrewIds\(job\)/.test(notifs));

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\ncrew resolution: ${pass}/${pass} passed`);
