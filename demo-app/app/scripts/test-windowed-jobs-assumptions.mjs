// Code that assumes `state.jobs` is the WHOLE table — it has not been since E6.
//
// ══ THE ROOT CAUSE ════════════════════════════════════════════════════════════
// E6 made the app boot on a ~-45/+100 day WINDOW of jobs and backfill the rest
// detached. That was correct for SCALE — it is what made the app interactive on mobile.
// But it converted "state.jobs is everything" from true to false, and a lot of code
// still assumes the old invariant. Three confirmed defects came from it:
//
//   1. JobDetail offered "this & all future" whenever the master was missing, and
//      UPDATE_JOB_SERIES then patched the occurrences while SILENTLY SKIPPING the
//      master's recurrence re-sync — so the edit was quietly undone at the next top-up.
//   2. Schedule's isPerDaySeries / JobDetail's isWeeklySeries read false on a missing
//      master and routed to the crew-flattening branch (fixed in dfaadfa).
//   3. DELETE_CLIENT cascades with `state.jobs.filter(...)`, so deleting an account
//      during the windowed phase removed only its in-window jobs — and the backfill
//      merge then RESURRECTED the rest, because rows that were never in windowSnapshot
//      cannot be classified as locally-removed.
//
// The rule this suite enforces: a lookup over state.jobs that comes back empty means
// NOT LOADED, never NOT EXISTS — and the safe response is to restrict, not to proceed.
//
//   node scripts/test-windowed-jobs-assumptions.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── the window is real ──────────────────────────────────────────────────
{
  const sync = read('../src/store/sync.js');
  ok('boot loads a WINDOW, not the whole table', /function bootWindowRange\(\)/.test(sync));
  ok('  ...and the full set backfills detached', /completeJobsHydration\(\)/.test(sync));
  ok('  ...with jobsReady FALSE until it lands', /jobsReady stays FALSE/.test(sync));
}

// ── 🔴 1. no whole-series EDIT without the master ───────────────────────
{
  const jd = read('../src/pages/JobDetail.jsx');
  // ⚠️ THIS ASSERTION WAS WRONG AND IS KEPT AS A CORRECTION, not deleted.
  //
  // It used to require that DELETE be EXEMPT from the gate, on the reasoning "deletes
  // need no recurrence re-sync". That is false. DELETE_JOB_SERIES performs a master
  // WRITE of its own: it caps the surviving master's recurrence at the deletion point
  // (endType:'date'), and the comment on that handler says why — without the cap, a
  // never-ending series RE-MATERIALISES the entire deleted tail on the next TOP_UP, so
  // "end this & all future" becomes a no-op after one Schedule mount. With the master
  // outside the boot window the cap is silently skipped, and a cancelled account's
  // cleans reappear for a year, reaching crew and the customer reminder scheduler.
  //
  // The precondition is also broader than the master: even WITH it loaded, occurrences
  // past +100 days are outside state.jobs, so both the delete set and the edit set are
  // partial. Hence one gate for both operations, on FULL HYDRATION.
  // Matched on SHAPE, not on the exact literal: further restrictions may be added after
  // these two (a twice-in-a-day series closes the edit path, below), but `!jobsHydrated`
  // and `!seriesMaster` must remain the LEADING, unconditional disjuncts — so neither
  // can be made intent-specific and quietly re-exempt delete.
  ok('🔴 JobDetail gates "all future" on full hydration AND a visible master',
    /disableFuture=\{!!job\?\.seriesId && \(\s*!jobsHydrated \|\| !seriesMaster\b/.test(jd));
  ok('  🔴 ...covering DELETE too — the old delete exemption is gone',
    !/showSeriesChoice !== 'delete' && !!job\?\.seriesId/.test(jd));
  // 🔴 A series cleaned twice in one day is inexpressible in `dayOverrides` (one entry
  // per weekday), so a series-wide edit would re-time BOTH cleans to one time and merge
  // them. 9 of 134 live weekly series do this. Edit is closed for them; DELETE is not,
  // because it works off materialized rows and needs no model.
  ok('🔴 a twice-in-a-day series cannot be edited series-wide',
    /showSeriesChoice === 'edit' && seriesRunsTwiceInADay/.test(jd)
    && /const seriesRunsTwiceInADay = useMemo/.test(jd));
  ok('  ...and that restriction never reaches DELETE',
    !/showSeriesChoice === 'delete' && seriesRunsTwiceInADay/.test(jd));
  ok('  ...with copy that says why', /twice-in-a-day/.test(jd));
  ok('  ...and jobsHydrated is actually sourced', /const jobsHydrated = useJobsHydrated\(\)/.test(jd));

  // The write-side reads that make the gate necessary.
  const red2 = read('../src/store/reducer.js');
  ok('DELETE_JOB_SERIES builds its target set from the windowed array',
    /const removed = state\.jobs\.filter\(\(j\) => \{/.test(red2));
  ok('  ...and locates the cap target with a windowed find',
    /const survivingMaster = state\.jobs\.find\(/.test(red2));
  ok('  ...the cap is what stops TOP_UP regenerating the tail', /endType: 'date', endDate: capDate/.test(red2));

  // Schedule's quick paths carry the same precondition.
  const sched2 = read('../src/pages/Schedule.jsx');
  ok('🔴 Schedule also refuses the whole-series path before hydration',
    /if \(!jobsHydrated\) return true;/.test(sched2));
  const modal = read('../src/components/SeriesScopeModal.jsx');
  ok('the modal actually honours disableFuture', /disableFuture = false/.test(modal) && /\{!disableFuture && \(/.test(modal));

  // The reducer's silent skip is what makes this necessary — pin that it is still silent,
  // so if someone makes it loud this guard can be revisited.
  const red = read('../src/store/reducer.js');
  ok('UPDATE_JOB_SERIES still finds the master via state.jobs (hence the UI guard)',
    /const masterRow = state\.jobs\.find\(\(j\) => j\.seriesId === action\.seriesId && j\.recurrence\)/.test(red));
  ok('  ...and skips the recurrence re-sync when it is absent', /if \(masterRow\) \{/.test(red));
}

// ── 🔴 2. the flattening guards fail safe (regression cover) ────────────
{
  const sched = read('../src/pages/Schedule.jsx');
  ok('Schedule treats an unknown master as per-day', /if \(!m\) return true;/.test(sched));
}

// ── 🔴 3. the backfill must not resurrect a deleted account's jobs ──────
{
  const sync = read('../src/store/sync.js');
  ok('🔴 orphaned jobs are filtered before the merge',
    /all\.filter\(\(j\) => !j\.clientId \|\| liveClientIds\.has\(j\.clientId\)\)/.test(sync));
  ok('  🔴 ...but NOT when the client list is empty (absence != deletion)',
    /liveClientIds\.size === 0\s*\n\s*\? all/.test(sync));
  ok('  🔴 ...and the baseline is the FILTERED set, so no bulk delete is triggered',
    /lastSyncedJobs = authoritative;/.test(sync));
  ok('  ...while the cursor still comes from the real read', /jobsCursor = maxRv\(all\)/.test(sync));

  // Simulate it.
  const all = [
    { id: 'j1', clientId: 'c_live' },
    { id: 'j2', clientId: 'c_deleted' },   // out-of-window job of a deleted account
    { id: 'j3', clientId: null },          // site-only job, no account
  ];
  const filter = (clientIds) => {
    const s = new Set(clientIds);
    return s.size === 0 ? all : all.filter((j) => !j.clientId || s.has(j.clientId));
  };
  const afterDelete = filter(['c_live']);
  ok('the deleted account\'s job is hidden', !afterDelete.some((j) => j.id === 'j2'));
  ok('  ...the live one survives', afterDelete.some((j) => j.id === 'j1'));
  ok('  ...and a job with no account is never treated as an orphan', afterDelete.some((j) => j.id === 'j3'));
  ok('🔴 an EMPTY client list drops nothing (the disengage-safe direction)',
    filter([]).length === all.length);
}

// ── 🔴 4. a MISSING cache record is not a COMPLETE jobs set ─────────────
// Same empty-baseline failure as 3f22431, reached through the offline door: with no
// jobs record, `jobs` is [] and the old flag said "complete", so bootFromCache armed the
// mirror against an empty baseline and the next save re-upserted the whole table.
// IndexedDB evicts per-record under quota pressure, so doc-present/jobs-absent is a real
// state, not a hypothetical.
{
  const cache = read('../src/store/offlineCache.js');
  ok('🔴 an absent jobs record reads as WINDOWED, not complete',
    /jobsWindowed: !jobsRec \|\| jobsRec\.windowed === true/.test(cache));
  ok('  ...the old collapse-to-false form is gone', !/jobsWindowed: jobsRec\?\.windowed === true/.test(cache));

  // The consumer's safe direction, pinned so the flag's meaning cannot invert.
  const sync = read('../src/store/sync.js');
  ok('windowed=true takes the ungated path (no mirroring yet)',
    /if \(cached\.jobsWindowed\) \{[\s\S]{0,300}?jobsReady = false;/.test(sync));
  ok('  ...and only a genuinely complete cache arms the mirror',
    /\} else \{[\s\S]{0,200}?jobsReady = true; \/\/ baseline is the cache/.test(sync));

  // Decision table.
  const windowed = (rec) => !rec || rec.windowed === true;
  ok('present + windowed:true  -> windowed', windowed({ windowed: true }) === true);
  ok('present + windowed:false -> complete (legacy pre-windowing record)', windowed({ windowed: false }) === false);
  ok('present + no flag        -> complete (legacy pre-windowing record)', windowed({}) === false);
  ok('🔴 ABSENT                -> windowed (the safe direction)', windowed(undefined) === true);
}

// ── 🔴 5. a trend must not be computed against half a prior period ──────
// selectDashboardTrends compares missed cleans -30..now against -60..-30, but the boot
// window starts at -45 — so up to HALF the prior period is missing and the arrow reports
// an improvement that did not happen, on a defect metric someone acts on. UI_RULES §40
// already governs this: no trend at all beats a fabricated one.
//
// UPDATE (f6115a8): the trend is now ALSO gated on `entriesLoaded` — the Missed Cleans KPI
// became clock-in-aware, so the delta is only honest once recent punches are loaded too.
// The gate is therefore a conjunction (jobsFullyLoaded && entriesLoaded), and the Dashboard
// guard adds a leading `missedCleans &&` check. The OMIT-by-default direction is unchanged.
{
  const sel = read('../src/store/selectors.js');
  ok('🔴 the trend selector takes a hydration flag', /selectDashboardTrends\(s, \{ jobsFullyLoaded = false, coveredJobIds = null, entriesLoaded = false \} = \{\}\)/.test(sel));
  ok('  🔴 ...defaulting to OMIT (a forgetful caller gets no arrow, not a wrong one)',
    /jobsFullyLoaded = false/.test(sel));
  ok('  ...and missedCleans is null when the basis is partial (jobs OR punches not loaded)',
    /missedCleans: \(jobsFullyLoaded && entriesLoaded\) \? makeTrend\(missedCur, missedPrior, 'decrease'\) : null/.test(sel));
  // Only that one trend reaches outside the window; the rest read blob slices.
  // (The complaints trend moved to selectComplaintKpisFromWorkOrders — sourced from Work
  // Orders, not the blob — so `companies` stands in as the unconditional-trend witness.)
  ok('the other trends are unconditional (they read non-windowed slices)',
    /laborHours: makeTrend\(/.test(sel) && /companies: makeTrend\(/.test(sel));

  const dash = read('../src/pages/Dashboard.jsx');
  ok('Dashboard passes the real hydration flag', /jobsFullyLoaded: useJobsHydrated\(\)/.test(dash));
  ok('🔴 ...and renders no arrow when the trend is null',
    /trendDirection=\{missedCleans && trends\.missedCleans \? trends\.missedCleans\.direction : undefined\}/.test(dash));
  ok('  ...while still showing the impact figure it CAN justify',
    /: `~\$\{money\(missedCleans\.revenueImpact\)\} impact`/.test(dash));
}

// ── 6. a crew id can outlive its user; do not render it as a person ─────
{
  const njm = read('../src/components/NewJobModal.jsx');
  ok('crewName returns null for an unresolvable id', /crewPool\.find\(\(u\) => u\.id === id\)\?\.name \|\| null/.test(njm));
  ok('  ...and the block summary drops it instead of printing "Unknown"',
    /\.map\(crewName\)\.filter\(Boolean\)/.test(njm));
  ok('  ...falling back to a truthful phrase when none resolve', /'no named crew'/.test(njm));
  // The selector every other surface uses already dropped unknowns — this was the gap.
  const sel2 = read('../src/store/selectors.js');
  ok('selectEffectiveCrewForJob already drops ids with no active user',
    /if \(user && user\.status === 'active'\) out\.push/.test(sel2));
}

// ── 🔴 7. EVERY whole-series entry point is hydration-gated ─────────────
// The reducer's target sets (UPDATE_JOB_SERIES eligibleIds, DELETE_JOB_SERIES removed)
// are built from state.jobs and are therefore only correct when the FULL set is loaded.
// Rather than rewrite the reducer, every UI path that can reach the 'future' scope is
// gated on hydration. This asserts the closure holds — a new entry point that dispatches
// UPDATE_JOB_SERIES / DELETE_JOB_SERIES without a gate reopens the hole.
{
  const jd = read('../src/pages/JobDetail.jsx');
  const sched = read('../src/pages/Schedule.jsx');
  const njm = read('../src/components/NewJobModal.jsx');

  ok('JobDetail gates its scope modal on hydration', /!jobsHydrated \|\| !seriesMaster/.test(jd));
  ok('Schedule gates its quick paths on hydration', /if \(!jobsHydrated\) return true;/.test(sched));
  ok('  ...and feeds that into both prompt sites',
    (sched.match(/disableFuture: isPerDaySeries\(job\)/g) || []).length === 2);
  // NewJobModal never decides scope itself — it receives it from Schedule's gated picker.
  ok('NewJobModal takes seriesScope as a PROP (it does not choose)', /seriesScope = null \}/.test(njm));
  ok('  ...supplied by Schedule\'s gated reschedule flow', /seriesScope=\{reschedule\.scope\}/.test(sched));

  // Both hooks must actually be sourced, or the gates are undefined-and-falsy.
  ok('JobDetail sources useJobsHydrated', /const jobsHydrated = useJobsHydrated\(\)/.test(jd));
  ok('Schedule sources useJobsHydrated', /const jobsHydrated = useJobsHydrated\(\)/.test(sched));

  // The closure claim: no OTHER file dispatches a whole-series action.
  const dispatchers = ['src/pages/JobDetail.jsx', 'src/pages/Schedule.jsx', 'src/components/NewJobModal.jsx'];
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = join(d, e.name);
    return e.isDirectory() ? walk(p) : (/\.jsx?$/.test(p) ? [p] : []);
  });
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  const rogue = walk(srcDir).filter((f) => {
    const rel = relative(srcDir, f).replace(/\\/g, '/');
    if (rel === 'store/reducer.js') return false;
    const s = readFileSync(f, 'utf8');
    return /ACTIONS\.(UPDATE|DELETE)_JOB_SERIES/.test(s)
      && !dispatchers.some((d) => d.endsWith(rel));
  }).map((f) => relative(srcDir, f).replace(/\\/g, '/'));
  ok(`🔴 no ungated file dispatches a whole-series action (${rogue.join(', ') || 'none'})`, rogue.length === 0);
}

// ── the generalisation, asserted where it is cheap to ───────────────────
// Every one of these three was "a lookup over a windowed collection came back empty and
// the code read that as authoritative". Pin the two central helpers so the assumption is
// visible to the next reader.
{
  const sel = read('../src/store/selectors.js');
  ok('selectSeriesMaster searches state.jobs (so it CAN miss)',
    /export const selectSeriesMaster = \(s, seriesId\) =>\s*\n\s*seriesId \? s\.jobs\.find/.test(sel));
  const red = read('../src/store/reducer.js');
  ok('DELETE_CLIENT still cascades over state.jobs (hence the merge-side filter)',
    /jobs: \(state\.jobs \|\| \[\]\)\.filter\(\(j\) => j\.clientId !== id\)/.test(red));
}

console.log(`\nwindowed jobs assumptions: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
