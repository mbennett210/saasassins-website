// The clock-status heal planner: heal 'upcoming' cleans that have a real punch
// (open → in_progress, else → done); leave everything else; flag a manager-marked
// 'missed' with a punch for review instead of silently overriding it.
import { planHeal } from './heal-clocked-job-status.mjs';
let pass = 0; const fails = [];
const ok = (l, c) => { if (c) pass += 1; else fails.push(l); };
const pm = (o) => new Map(Object.entries(o));

// upcoming + closed punch → done
{
  const { heal, flaggedMissed } = planHeal([{ id: 'j1', status: 'upcoming' }], pm({ j1: { hasOpen: false } }));
  ok('🔴 upcoming + closed punch → done', heal.length === 1 && heal[0].to === 'done' && !flaggedMissed.length);
}
// upcoming + open punch → in_progress
{
  const { heal } = planHeal([{ id: 'j2', status: 'upcoming' }], pm({ j2: { hasOpen: true } }));
  ok('🔴 upcoming + OPEN punch → in_progress', heal.length === 1 && heal[0].to === 'in_progress');
}
// upcoming with NO punch → untouched
ok('upcoming with no punch → not healed', planHeal([{ id: 'j3', status: 'upcoming' }], pm({})).heal.length === 0);
// already done/cancelled/in_progress → untouched even with a punch
{
  const jobs = [{ id: 'jd', status: 'done' }, { id: 'jc', status: 'cancelled' }, { id: 'jp', status: 'in_progress' }];
  const { heal } = planHeal(jobs, pm({ jd: { hasOpen: false }, jc: { hasOpen: false }, jp: { hasOpen: true } }));
  ok('done/cancelled/in_progress are left alone', heal.length === 0);
}
// stored 'missed' + punch → flagged, NOT healed
{
  const { heal, flaggedMissed } = planHeal([{ id: 'jm', status: 'missed' }], pm({ jm: { hasOpen: false } }));
  ok('🔴 manager-marked missed + punch → flagged for review, not auto-changed', heal.length === 0 && flaggedMissed.length === 1 && flaggedMissed[0].id === 'jm');
}
console.log(`\nheal planner: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
