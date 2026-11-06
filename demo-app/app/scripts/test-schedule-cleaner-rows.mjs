// CS-721 — the Schedule's Cleaner view groups a week's visits by cleaner in one pass.
//
// `selectScheduleRowsByCleaner` filtered the WHOLE week once per team member: users × visits,
// 1,540 × 3,850 ≈ 5.9 million crew checks at Matt's size, about 0.7 s of the Cleaner view's
// ~2.8 s render on a desktop (S128 full-app pass, F11-04; the rest was per-call date formatting,
// which lib/dates now caches). It now buckets each visit under its crew once and hands every
// cleaner their bucket: the SAME rows — every cleaner with a visit, their visits by start, their
// minutes, the Unassigned lane on top — compared here against the per-person walk it replaces,
// across standing quirks (no crew, inactive crew, done / cancelled visits, a repeated visit id,
// a repeated team member).
//
// Offline. Run: node scripts/test-schedule-cleaner-rows.mjs
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);
const { selectScheduleRowsByCleaner, effectiveCrewIdSet, selectEffectiveJobStatus } = await import('../src/store/selectors.js');

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// The per-person walk the selector replaced (its rows are the contract).
function walk(s, jobs, users) {
  const crewByJob = new Map(jobs.map((j) => [j.id, effectiveCrewIdSet(s, j)]));
  const activeIds = new Set((users || []).map((u) => u.id));
  const mins = (j) => Math.max(0, Math.round((new Date(j.endAt).getTime() - new Date(j.startAt).getTime()) / 60000));
  const rows = users
    .map((u) => {
      const js = jobs.filter((j) => crewByJob.get(j.id)?.has(u.id)).sort((a, b) => a.startAt.localeCompare(b.startAt));
      return { user: u, jobs: js, totalMinutes: js.reduce((sum, j) => sum + mins(j), 0) };
    })
    .filter((row) => row.jobs.length > 0)
    .sort((a, b) => (a.user.name || '').localeCompare(b.user.name || ''));
  const orphan = jobs
    .filter((j) => {
      const st = selectEffectiveJobStatus(j);
      if (st === 'done' || st === 'cancelled') return false;
      const set = crewByJob.get(j.id);
      if (!set || set.size === 0) return true;
      for (const id of set) if (activeIds.has(id)) return false;
      return true;
    })
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  if (orphan.length) rows.unshift({ user: null, unassigned: true, jobs: orphan, totalMinutes: orphan.reduce((sum, j) => sum + mins(j), 0) });
  return rows;
}
const shape = (rows) => JSON.stringify(rows.map((r) => [r.unassigned ? 'UNASSIGNED' : r.user.id, r.jobs.map((j) => j.id), r.totalMinutes]));

// Matt's size: 1,540 people (some inactive or repeated), a week of 3,850 visits.
let x = 5;
const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
const users = Array.from({ length: 1540 }, (_, i) => ({ id: `u${i}`, name: `${['Ana', 'Luis', 'Rosa', 'Kim', ''][i % 5]} ${String(i).padStart(4, '0')}`, status: i % 97 === 0 ? 'inactive' : 'active' }));
users.push({ ...users[10] }); // the same person twice in the roster
const activeUsers = users.filter((u) => u.status === 'active');
const t0 = Date.parse('2026-10-12T04:00:00.000Z');
const jobs = Array.from({ length: 3850 }, (_, i) => {
  const start = t0 + Math.floor(rnd() * 7 * 24) * 3600000;
  const crewN = rnd() < 0.05 ? 0 : 1 + Math.floor(rnd() * 3);
  return {
    id: `j${i}`, startAt: new Date(start).toISOString(), endAt: new Date(start + (1 + Math.floor(rnd() * 4)) * 1800000).toISOString(),
    status: pick(['upcoming', 'upcoming', 'in_progress', 'done', 'cancelled']),
    crewIds: Array.from({ length: crewN }, () => `u${Math.floor(rnd() * 1560)}`), // some ids are nobody on the roster
  };
});
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
jobs.push({ ...jobs[3], crewIds: ['u1', 'u2'] }); // a repeated visit id
const s = { jobs, users };

const want = walk(s, jobs, activeUsers);
const got = selectScheduleRowsByCleaner(s, jobs, activeUsers);
ok(`the rows are the per-person walk's (${got.length} rows)`, shape(got) === shape(want));
ok('the Unassigned lane is on top', got[0] && got[0].unassigned === true);
ok('a repeated team member gets their own row with the same visits', shape(selectScheduleRowsByCleaner(s, jobs, users)) === shape(walk(s, jobs, users)));
ok('no visits, no rows', selectScheduleRowsByCleaner(s, [], activeUsers).length === 0);
ok('a small week matches too', shape(selectScheduleRowsByCleaner(s, jobs.slice(0, 40), activeUsers.slice(0, 30))) === shape(walk(s, jobs.slice(0, 40), activeUsers.slice(0, 30))));

// One pass, not users × visits.
const time = (fn) => { const a = performance.now(); for (let i = 0; i < 3; i++) fn(); return (performance.now() - a) / 3; };
const walkMs = time(() => walk(s, jobs, activeUsers));
const oneMs = time(() => selectScheduleRowsByCleaner(s, jobs, activeUsers));
console.log(`  1,540 people × 3,850 visits: per-person walk ${walkMs.toFixed(0)} ms · selector ${oneMs.toFixed(0)} ms`);
ok(`the selector groups in one pass, far cheaper than the walk (${oneMs.toFixed(0)} ms vs ${walkMs.toFixed(0)} ms)`, oneMs * 5 < walkMs);

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\nschedule cleaner rows: ${pass}/${pass} passed`);
}
