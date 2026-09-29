// "This & all future" must never reach an occurrence that has ALREADY STARTED.
//
// ══ THE DEFECT (2026-09-02) ══════════════════════════════════════════════════
// An office desktop opened tonight's occurrence at 22:23, chose "this & future",
// and the app hard-deleted the clean that had started at 20:00 (9 rows, one
// series) — then again at 23:54 (22 rows). The tombstones reached the crew's
// phones within a minute via the backstop poll and their in-progress cleans
// vanished from My Day ("NW Dental disappeared from Linda's cleans"). Root cause:
// the reducers scope series ops by `startAt >= fromDate`, and every dispatch site
// passed the opened occurrence's OWN startAt, so a started occurrence was always
// in range.
//
// Two layers:
//   D1 — lib/seriesScope.js clamps fromDate to NOW at DISPATCH time (reducers stay
//        replay-idempotent), used by every "this & future" site; series MOVES of a
//        started occurrence are refused (a clamped anchor computes the wrong shift).
//   D2 — api/state/jobs-delta.js refuses to hard-delete a clean with a non-voided
//        punch (time_entries.job_id is ON DELETE SET NULL → orphaned payroll).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { seriesFromDate } from '../src/lib/seriesScope.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0; const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── D1: the clamp itself ─────────────────────────────────────────────────────
{
  const now = '2026-09-03T05:23:30.000Z'; // 22:23:30 Pacific, Sept 2
  const future = seriesFromDate({ startAt: '2026-09-04T03:00:00.000Z' }, now);
  ok('🔴 a future occurrence keeps its own startAt as fromDate', future.fromDate === '2026-09-04T03:00:00.000Z' && future.started === false);
  const started = seriesFromDate({ startAt: '2026-09-03T03:00:00.000Z' }, now); // 20:00 Pacific tonight
  ok('🔴 a STARTED occurrence is clamped to now (excluded from the series op)', started.fromDate === now && started.started === true);
  const exact = seriesFromDate({ startAt: now }, now);
  ok('  ...starting exactly now counts as started', exact.started === true && exact.fromDate === now);
  const none = seriesFromDate({}, now);
  ok('  ...a job with no startAt is never "started"', none.started === false && none.fromDate === '');
  const bad = seriesFromDate({ startAt: 'not-a-date' }, now);
  ok('  ...an unparseable startAt is never "started"', bad.started === false);
  ok('  ...defaults to the wall clock when now is omitted', seriesFromDate({ startAt: '2000-01-01T00:00:00.000Z' }).started === true);
}

// ── D1: every dispatch site routes through the clamp ─────────────────────────
{
  const jd = read('src/pages/JobDetail.jsx');
  ok('🔴 JobDetail imports seriesFromDate', /import \{ seriesFromDate, STARTED_SERIES_NOTE \} from '\.\.\/lib\/seriesScope';/.test(jd));
  ok('🔴 JobDetail series edit clamps fromDate (both branches)', (jd.match(/fromDate: scope\.fromDate/g) || []).length === 2);
  ok('🔴 JobDetail series delete clamps fromDate', /DELETE_JOB_SERIES, seriesId: job\.seriesId, fromDate: range\.fromDate/.test(jd));
  ok('  ...and no JobDetail series op passes the raw occurrence startAt', !/fromDate: job\.startAt/.test(jd));

  const nj = read('src/components/NewJobModal.jsx');
  ok('🔴 NewJobModal series edit clamps fromDate', /fromDate: scope\.fromDate,/.test(nj) && !/fromDate: initialData\.startAt/.test(nj));
  ok('🔴 NewJobModal refuses a day MOVE of a started occurrence', /if \(scope\.started && dayShift\) \{\s*setSubmitError\(STARTED_SERIES_MOVE_BLOCK\);\s*return;/.test(nj));

  const sc = read('src/pages/Schedule.jsx');
  ok('🔴 Schedule drag refuses a series move of a started occurrence', /if \(scope === 'future' && seriesFromDate\(job\)\.started\) \{\s*toast\.error\(STARTED_SERIES_MOVE_BLOCK\);\s*return;/.test(sc));

  const red = read('src/store/reducer.js');
  ok('🔴 reducers stay replay-idempotent: no wall clock inside the series ops',
    !/case ACTIONS\.DELETE_JOB_SERIES:[\s\S]{0,600}Date\.now\(\)/.test(red) && !/const eligible = \(j\) => [\s\S]{0,200}Date\.now\(\)/.test(red));
}

// ── D2: the server refuses to delete a punched clean ─────────────────────────
{
  const st = read('api/_lib/time/store.js');
  ok('🔴 store exports jobIdsWithPunches', /export async function jobIdsWithPunches\(jobIds\)/.test(st));
  ok('  ...that ignores voided punches', /\.in\('job_id', ids\.slice\(i, i \+ 200\)\)\s*\.neq\('status', 'voided'\)/.test(st));

  const jd = read('api/state/jobs-delta.js');
  ok('🔴 jobs-delta imports the punch check', /import \{ jobIdsWithPunches \} from '\.\.\/_lib\/time\/store\.js';/.test(jd));
  ok('🔴 jobs-delta strips punched ids from `removed` BEFORE writing', /toWrite = \{ changed: toWrite\.changed, removed: toWrite\.removed\.filter\(\(id\) => !punched\.has\(id\)\) \};[\s\S]*await writeJobsDelta\(/.test(jd));
  ok('  ...and alarms on it', /reportError\('jobs\.delta_removed_punched_rows'/.test(jd));
  ok('  ...and reports the protected ids in the 200 (never a 4xx — that wedges the tab)', /protected: protectedIds/.test(jd));
  ok('  ...and a failed check fails CLOSED', /return res\.status\(500\)\.json\(\{ error: e\.message \|\| 'Punch check failed' \}\)/.test(jd));
}

console.log(`\nseries started guard: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
