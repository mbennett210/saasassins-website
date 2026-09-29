// Multi-block recurring series: every block must be DESCRIBED, EDITABLE and
// accounted for on delete.
//
// ══ THE DEFECT ════════════════════════════════════════════════════════════════
// A weekly series can hold several "schedule blocks" — day-specific times + crew in
// ONE series. Only the days that DIFFER from the master carry a `dayOverrides` entry;
// the block that owns the master job has none, because it IS the default.
//
// Every series-level reader walked `dayOverrides` directly, so the default block was
// invisible. For a Wed 10:00 + Mon/Fri 1:00 series whose anchor landed on a Monday,
// the stored shape is daysOfWeek [1,3,5] with an override for Wed ONLY, and the
// summary rendered:
//
//     "Weekly on Mon, Wed, Fri — ongoing · Wed 10:00 AM–11:30 AM"
//
// Open the Monday 1:00 AM occurrence and the ONLY time named on the page is 10:00 AM —
// the one time that clean does not run at. The calendar was right the whole time
// (it reads materialized rows), which is what made it read as a display quirk rather
// than three surfaces sharing one broken reconstruction.
//
// The edit path had the mirror problem: the block editor existed but was reachable
// only via "this & all future", and even there the day chips were LOCKED — the copy
// told users to delete the series and recreate it to change which days run.
//
//   node scripts/test-series-day-set.mjs
import { readFileSync } from 'node:fs';
import { describeRecurrence, seriesBlocksOf, blockDayLabel, blockTimeLabel } from '../src/lib/recurrence.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// The user-reported series, in both storage orientations. Which block owns the master
// depends only on the calendar day the series was anchored on, so BOTH must describe
// identically — that asymmetry is the whole bug.
// Master start 08:00Z = 01:00 in the org zone (America/Los_Angeles).
const masterMonAnchor = {
  startAt: '2026-07-27T08:00:00.000Z', endAt: '2026-07-27T09:00:00.000Z', crewIds: ['u-night'],
  recurrence: {
    frequency: 'weekly', daysOfWeek: [1, 3, 5], endType: 'never',
    dayOverrides: { 3: { startTime: '10:00', endTime: '11:30', crewIds: ['u-day'] } },
  },
};
// Same series, anchored on the Wednesday instead: now Mon/Fri carry the overrides.
const masterWedAnchor = {
  startAt: '2026-07-29T17:00:00.000Z', endAt: '2026-07-29T18:30:00.000Z', crewIds: ['u-day'],
  recurrence: {
    frequency: 'weekly', daysOfWeek: [1, 3, 5], endType: 'never',
    dayOverrides: {
      1: { startTime: '01:00', endTime: '02:00', crewIds: ['u-night'] },
      5: { startTime: '01:00', endTime: '02:00', crewIds: ['u-night'] },
    },
  },
};

// ── 🔴 the default block must be named, not just the overrides ──────────
{
  const a = seriesBlocksOf(masterMonAnchor);
  ok('Mon-anchored series reconstructs 2 blocks', a.length === 2);
  ok('  ...the DEFAULT block (Mon+Fri) is present with the master\'s times',
    a.some((b) => b.days.join() === '1,5' && b.startTime === '01:00' && b.endTime === '02:00'));
  ok('  ...and carries the master\'s crew',
    a.find((b) => b.days.join() === '1,5')?.crewIds.join() === 'u-night');
  ok('  ...the override block (Wed) keeps its own time + crew',
    a.some((b) => b.days.join() === '3' && b.startTime === '10:00' && b.crewIds.join() === 'u-day'));

  const b = seriesBlocksOf(masterWedAnchor);
  ok('Wed-anchored series reconstructs 2 blocks', b.length === 2);
  ok('🔴 both orientations describe the SAME schedule (the shipped asymmetry)',
    JSON.stringify(a.map(({ key, ...r }) => r).sort((x, y) => x.days[0] - y.days[0]))
    === JSON.stringify(b.map(({ key, ...r }) => r).sort((x, y) => x.days[0] - y.days[0])));
}

// ── 🔴 describeRecurrence names every block when given the master ───────
{
  const withMaster = describeRecurrence(masterMonAnchor.recurrence, masterMonAnchor);
  ok('🔴 the 1:00 AM block is named (it was invisible)', /Mon, Fri 1:00 AM–2:00 AM/.test(withMaster));
  ok('  ...alongside the 10:00 AM block', /Wed 10:00 AM–11:30 AM/.test(withMaster));
  ok('  ...and the frequency line still leads', /^Weekly on Mon, Wed, Fri/.test(withMaster));
  ok('both orientations produce the same description',
    describeRecurrence(masterWedAnchor.recurrence, masterWedAnchor) === withMaster);

  // A uniform series must not repeat itself — the header already shows its time.
  const uniform = { frequency: 'weekly', daysOfWeek: [1, 3], endType: 'never' };
  ok('a single-block series gets no redundant per-block tail',
    describeRecurrence(uniform, masterMonAnchor) === 'Weekly on Mon, Wed. Ongoing');

  // Callers with no master in hand still get the frequency + end rule.
  ok('no-master callers still get a description', describeRecurrence(masterMonAnchor.recurrence).startsWith('Weekly on Mon, Wed, Fri'));
}

// ── timeOverride rebases the DEFAULT block ─────────────────────────────
// After a series-level time edit the master keeps its original times (it is history),
// so reading them would show a time the series no longer runs at.
{
  const m = {
    startAt: '2026-07-27T08:00:00.000Z', endAt: '2026-07-27T09:00:00.000Z', crewIds: [],
    recurrence: {
      frequency: 'weekly', daysOfWeek: [1, 3], endType: 'never',
      timeOverride: { startTime: '06:00', endTime: '07:00' },
    },
  };
  const blocks = seriesBlocksOf(m);
  ok('🔴 timeOverride wins over the historical master times',
    blocks.length === 1 && blocks[0].startTime === '06:00' && blocks[0].endTime === '07:00');
}

// ── grouping merges days that resolve identically ──────────────────────
{
  const m = {
    startAt: '2026-07-27T08:00:00.000Z', endAt: '2026-07-27T09:00:00.000Z', crewIds: ['u-1'],
    recurrence: {
      frequency: 'weekly', daysOfWeek: [1, 3], endType: 'never',
      // An explicit override that happens to equal the default must NOT split the block.
      dayOverrides: { 3: { startTime: '01:00', endTime: '02:00', crewIds: ['u-1'] } },
    },
  };
  ok('an override equal to the default merges into one block', seriesBlocksOf(m).length === 1);
  ok('label helpers render a block', blockDayLabel([1, 5]) === 'Mon, Fri' && blockTimeLabel({ startTime: '01:00', endTime: '02:00' }) === '1:00 AM–2:00 AM');
  ok('non-weekly series have no blocks', seriesBlocksOf({ startAt: '2026-07-27T08:00:00.000Z', recurrence: { frequency: 'monthly' } }) === null);
}

// ── 🔴 reducer: the day set is reconciled against the MATERIALIZED rows ──
// The recurrence alone only governs what future top-ups generate. If the rows already
// on the board aren't reconciled too, a dropped day keeps showing cleans nobody will
// do and an added day shows nothing until the horizon rolls far enough.
{
  const src = read('../src/store/reducer.js');
  const body = (src.match(/case ACTIONS\.UPDATE_JOB_SERIES: \{[\s\S]*?\n    case ACTIONS\.SET_JOB_STATUS:/) || [])[0] || '';
  ok('UPDATE_JOB_SERIES body found', body.length > 0);
  ok('dayPlan is accepted', /const \{ timePatch, dayPlan \} = action;/.test(body));
  ok('  ...and the legacy dayPatches shape still works', /: action\.dayPatches;/.test(body));
  ok('the new day set drives the dense freeze', /dayPlan\?\.days\?\.length/.test(body));
  ok('  ...and is written back to daysOfWeek', /\.\.\.\(dayPlan \? \{ daysOfWeek: days \} : \{\}\)/.test(body));
  ok('🔴 rows on a dropped day are removed', /jobs: state\.jobs\.filter\(\(j\) => !droppedIds\.has\(j\.id\)\)/.test(body));
  // Sept 2: added-day mints route through applyTimeOffToOccurrence like every
  // other mint path (booked time off excludes the person from that day's row).
  ok('🔴 rows on an added day are materialized (time-off aware)',
    /additions\.push\(applyTimeOffToOccurrence\(state, \{/.test(body));
  ok('  ...only from fromDate forward', /if \(action\.fromDate && o\.startAt < action\.fromDate\) continue;/.test(body));
  ok('  ...never duplicating an existing occurrence', /if \(seenOcc\.has\(o\.startAt\)\) continue;/.test(body));
  ok('  ...resolving crew through the shared resolver',
    /crewIds: crewForOccurrence\(nextRecurrence, o\.startAt, masterRow\.crewIds\)/.test(body));
  // 🔴 Regression: expanding an added day against the recurrence's own horizon leaves a
  // permanent hole. TOP_UP appends only past the series' LATEST occurrence, so days that
  // stopped earlier can never catch up through the gap — Tuesdays into October against
  // Mondays that stop in August. The added day must stop where its siblings stop.
  ok('🔴 an added day is capped at the span the series already covers',
    /const genRecurrence = survivingTail\s*\n\s*\? \{ \.\.\.nextRecurrence, endType: 'date', endDate: survivingTail \}/.test(body));
  ok('  ...measured from the rows that SURVIVE the same edit',
    /eligibleRows\s*\n\s*\.filter\(\(j\) => !droppedIds\.has\(j\.id\)\)\s*\n\s*\.reduce\(\(max, j\) => \(j\.startAt > max \? j\.startAt : max\), ''\)/.test(body));
  // 🔴 The sharpest edge: removing a day can delete the row that CARRIES the
  // recurrence. A headless series stops rolling forward forever and reports nothing.
  ok('🔴 a master deleted by a day-drop re-homes its recurrence', /const masterDropped =/.test(body) && /const heirRow =/.test(body));
  ok('  ...onto the earliest survivor', /\.reduce\(\(a, b\) => \(a && a\.startAt <= b\.startAt \? a : b\), null\)/.test(body));
  ok('  ...including when the heir is itself a new occurrence',
    /additions\.map\(\(a\) => \(masterDropped && heirRow && a\.id === heirRow\.id/.test(body));
  ok('crew on newly added days count as new assignees for notifications',
    /const addedIds = new Set\(additions\.map\(\(a\) => a\.id\)\);/.test(body));
  // 🔴 Found on the LIVE write test: dropping the master's day deleted its row but left
  // Demo Crew holding a "New job assigned to you" bell row pointing at /schedule/<gone>.
  // Deleting rows carries DELETE_JOB_SERIES' obligation to scrub their dead links, and
  // this action deletes rows now too.
  ok('🔴 a dropped day scrubs its rows dead notification links',
    /const deadUrls = new Set\(\[\.\.\.droppedIds\]\.map\(\(rid\) => `\/schedule\/\$\{rid\}`\)\);/.test(body)
    && /notifications: \(state\.notifications \|\| \[\]\)\.filter\(\(n\) => !deadUrls\.has\(n\.url\)\)/.test(body));
  ok('  ...and only when something was actually dropped', /droppedIds\.size\s*\n?\s*\?\s*\{ notifications:/.test(body));
  // The freeze resolves each day through dayPatternOf (2026-09-23), the one resolution
  // seriesBlocksOf also uses, so it honors timeOverride (and crewOverride) by
  // construction; the seriesBlocksOf timeOverride case above exercises that function.
  ok('the dense freeze honors timeOverride',
    /: dayPatternOf\(\{ \.\.\.masterRow, recurrence: r \}, dow\);/.test(body)
    && /o\?\.startTime \|\| r\.timeOverride\?\.startTime \|\| splitIso\(master\.startAt\)\.time/.test(read('../src/lib/recurrence.js')));
}

// ── 🔴 JobDetail: all blocks visible, editable, and named on delete ─────
{
  const src = read('../src/pages/JobDetail.jsx');
  ok('the summary is given the master so the default block resolves',
    /describeRecurrence\(seriesMaster\.recurrence, seriesMaster\)/.test(src));
  ok('blocks come from the shared reconstruction', /seriesBlocksOf\(seriesMaster\)/.test(src));
  ok('🔴 view mode renders a per-block breakdown', /series-blocks-summary/.test(src));
  ok('  ...marking the block this occurrence belongs to', /b\.days\.includes\(thisDow\)/.test(src));
  ok('🔴 the day chips are no longer locked in the series editor',
    !/lockDays\s*\n?\s*\/>/.test(src) && !/lockDays\s+/.test(src));
  ok('the day-set edit dispatches a dayPlan', /dayPlan: \{ days, overrides, full \}/.test(src));
  ok('  ...guarded against a block with no days', /Every schedule block needs at least one day/.test(src));
  ok('  ...and against a block with no times', /Every schedule block needs a start and end time/.test(src));
  ok('the delete-and-recreate dead end is gone', !/delete the remaining series and recreate it/.test(src));
  // 🔴 dayOverrides holds ONE entry per weekday, so a site cleaned twice on a Tuesday is
  // inexpressible. 9 of 134 live weekly series do exactly that. The breakdown must not
  // render a per-day list that omits the second clean, and the series-wide edit must not
  // re-time both onto one time.
  // The withhold guard is now factored into `showSeriesBlocks` (reused by the Crew
  // field relabel), but it must still carry !seriesRunsTwiceInADay, and the breakdown
  // must still gate on it — drop either and a twice-in-a-day series renders a per-day
  // list that omits the second clean.
  ok('🔴 the breakdown is withheld when the model cannot represent the series',
    /showSeriesBlocks = !!\(job\.seriesId && seriesBlocks && seriesBlocks\.length > 1 && !seriesRunsTwiceInADay\)/.test(src)
    && /showSeriesBlocks && !editing/.test(src));

  // 🔴 The delete breakdown must describe what is REALLY removed. Building it from the
  // recurrence would lie whenever the master never loaded (boot window) or an
  // occurrence was edited off the pattern — so it reads the rows themselves, with the
  // same predicate the reducer deletes by — including the dispatch-time clamp that keeps
  // an already-STARTED occurrence out of scope (lib/seriesScope.js, 2026-09-02: a
  // "this & future" delete removed tonight's in-progress clean; the preview must not
  // count it either). See test-series-started-guard.mjs.
  ok('🔴 the delete summary is built from the materialized rows',
    /j\.seriesId === job\.seriesId && j\.status === 'upcoming' && j\.startAt >= seriesFromDate\(job\)\.fromDate/.test(src));
  ok('  ...naming days, times and crew per block', /series-delete-summary/.test(src) && /g\.crew\.length \? g\.crew\.join/.test(src));
  ok('  ...the site it belongs to', /series-delete-where/.test(src));
  ok('  ...and the count + span', /series-delete-count/.test(src));
  ok('  ...crew resolved through the effective-crew selector (drops departed users)',
    /selectEffectiveCrewForJob\(state, j\)\.map\(\(c\) => c\.user\.name\)/.test(src));
}

// ── SeriesScopeModal: the summary only shows where it is true ──────────
{
  const src = read('../src/components/SeriesScopeModal.jsx');
  ok('the modal accepts a summary', /summary = null/.test(src));
  // When "all future" isn't offered, nothing beyond this occurrence is destroyed —
  // showing the series breakdown there would describe an act that cannot happen.
  ok('🔴 ...and hides it when the future option is unavailable', /\{summary && !disableFuture && summary\}/.test(src));
}

const total = pass + fails.length;
console.log(`series day-set (multi-block recurring): ${pass}/${total} passed`);
for (const f of fails) console.log(`  FAIL: ${f}`);
process.exit(fails.length ? 1 : 0);
