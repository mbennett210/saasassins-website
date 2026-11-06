// Code that assumes `state.jobs` is the WHOLE table — it has not been since E6, and since
// CS-676 it never will be.
//
// ══ THE ROOT CAUSE ════════════════════════════════════════════════════════════
// E6 made the app boot on a ~-45/+100 day WINDOW of jobs and backfill the rest detached;
// CS-676 (2026-10-13) dropped the backfill — every launch downloaded every clean ever, by
// OFFSET pages — so the window IS the jobs baseline, and a screen that needs more loads
// exactly that (a date range, one series by id, one customer's cleans, some ids). That
// made "state.jobs is everything" permanently false, and code that assumes the old
// invariant is wrong. Three confirmed defects came from it before:
//
//   1. JobDetail offered "this & all future" whenever the master was missing, and
//      UPDATE_JOB_SERIES then patched the occurrences while SILENTLY SKIPPING the
//      master's recurrence re-sync — so the edit was quietly undone at the next top-up.
//   2. Schedule's isPerDaySeries / JobDetail's isWeeklySeries read false on a missing
//      master and routed to the crew-flattening branch (fixed in dfaadfa).
//   3. DELETE_CLIENT cascaded with `state.jobs.filter(...)`, so deleting an account
//      during the windowed phase removed only its in-window jobs — and the backfill
//      merge then RESURRECTED the rest, because rows that were never in windowSnapshot
//      cannot be classified as locally-removed. (Customers are archived, never deleted,
//      since CS-663; the archive takes a customer's upcoming cleans off the same windowed
//      `state.jobs`, so the screens offer it only once every clean has loaded.)
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

// ── the window is real, and it is all a launch reads ────────────────────
{
  const sync = read('../src/store/sync.js');
  const jobsSync = read('../src/store/jobsSync.js');
  ok('boot loads the WINDOW (src/lib/jobsWindow.js), not the whole table',
    /const \{ fromMs, toMs \} = jobsWindowBounds\(\);/.test(sync) && /fetchJobsInRange\(fromMs, toMs\)/.test(sync));
  ok('  ...plus the series masters (TOP_UP mints from them)', /fetchSeriesMasters\(\)/.test(sync));
  ok('🔴 ...and nothing reads the whole table any more', !/fetchAllJobs|completeJobsHydration/.test(sync + jobsSync));
  ok('🔴 no jobs read pages by OFFSET (keyset only)', !/\.range\(/.test(jobsSync));
  ok('more is loaded on demand: a range, a series, a customer, some ids',
    ['ensureJobsRange', 'ensureSeries', 'ensureClientJobs', 'ensureJobsByIds'].every((f) => new RegExp(`async function ${f}\\(`).test(sync)));
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
  // past +100 days are outside the window, so both the delete set and the edit set are
  // partial. Hence one gate for both operations, on THE SERIES BEING LOADED (every
  // occurrence, by series id — useSeriesJobs).
  // Matched on SHAPE, not on the exact literal: further restrictions may be added after
  // these two (a twice-in-a-day series closes the edit path, below), but `!seriesLoad.ready`
  // and `!seriesMaster` must remain the LEADING, unconditional disjuncts — so neither
  // can be made intent-specific and quietly re-exempt delete.
  ok('🔴 JobDetail gates "all future" on its series being loaded AND a visible master',
    /disableFuture=\{!!job\?\.seriesId && \(\s*!seriesLoad\.ready \|\| !seriesMaster\b/.test(jd));
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
  ok('  ...and the series load is actually sourced', /const seriesLoad = useSeriesJobs\(job\?\.seriesId \|\| null\)/.test(jd));

  // The write-side reads that make the gate necessary.
  const red2 = read('../src/store/reducer.js');
  ok('DELETE_JOB_SERIES builds its target set from the windowed array',
    /const removed = state\.jobs\.filter\(\(j\) => \{/.test(red2));
  ok('  ...and locates the cap target with a windowed find',
    /const survivingMaster = state\.jobs\.find\(/.test(red2));
  ok('  ...the cap is what stops TOP_UP regenerating the tail', /endType: 'date', endDate: capDate/.test(red2));

  // Schedule's quick paths carry the same precondition.
  const sched2 = read('../src/pages/Schedule.jsx');
  ok('🔴 Schedule also refuses the whole-series path until the series is loaded',
    /if \(!jobsLoader\.isSeriesLoaded\(job\.seriesId\)\) return true;/.test(sched2));
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

// ── 🔴 3. a read must not resurrect a deleted account's jobs ────────────
{
  const sync = read('../src/store/sync.js');
  ok('🔴 orphaned jobs are filtered before the merge',
    /all\.filter\(\(j\) => !j\.clientId \|\| liveClientIds\.has\(j\.clientId\)\)/.test(sync));
  ok('  🔴 ...but NOT when the client list is empty (absence != deletion)',
    /liveClientIds\.size === 0\s*\n\s*\? all/.test(sync));
  ok('  🔴 ...and the baseline is the FILTERED set, so no bulk delete is triggered',
    /lastSyncedJobs = authoritative;/.test(sync));
  ok('  ...while the cursor comes from the table\'s high-water, read before the window', /jobsCursor = floor;/.test(sync));
  ok('  🔴 ...and rows fetched on demand are orphan-filtered the same way',
    /function adoptFetchedJobs\(rows\) \{[\s\S]{0,700}?liveClientIds\.size === 0 \|\| liveClientIds\.has\(j\.clientId\)/.test(sync));

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

// ── 🔴 4. the device's cache is NEVER the jobs baseline ─────────────────
// Same empty-baseline failure as 3f22431, reached through the offline door: with no jobs
// record (IndexedDB evicts per record under quota pressure, so doc-present/jobs-absent is
// real), an old flag read "complete", bootFromCache armed the mirror against [] and the
// next save re-upserted the whole table. Since CS-676 no cache arms the mirror at all: it
// is what to paint while the server answers, and the window from the table is the
// baseline, merged onto it (edits made in the gap kept).
{
  const sync = read('../src/store/sync.js');
  const boot = (sync.match(/async function bootFromCache\([\s\S]*?\n  \}/) || [])[0] || '';
  ok('bootFromCache found', boot.length > 0);
  ok('🔴 a boot from the cache keeps the mirror gated and loads the window',
    /jobsReady = false;[\s\S]{0,120}?loadJobsBaseline\(\);/.test(boot));
  ok('🔴 ...and nothing in it arms the mirror', !/jobsReady = true/.test(boot) && !/signalJobsReady\(\)/.test(boot));
  ok('  ...the cached cleans are the merge snapshot', /windowSnapshot = jobs;/.test(boot));
  const cache = read('../src/store/offlineCache.js');
  ok('the cache no longer reports a "complete" flag anyone could arm on', !/jobsWindowed/.test(cache));
  // An OLDER bundle on the same device still reads its own flag: a record without it reads
  // there as the complete table, so the write side keeps stamping it.
  ok('🔴 ...but every jobs record is still WRITTEN windowed, for older bundles on the device',
    /cacheJobs\(jobsInWindow\(jobs, from, to\), at, \{ windowed: true, from, to \}\)/.test(sync));
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
  ok('Dashboard loads the 61 days the trend reads (CS-676) and passes THAT readiness',
    /const trendDays = useJobsDays\(addDaysKey\(todayK, -61\), todayK\);/.test(dash) && /jobsFullyLoaded: trendDays\.ready/.test(dash));
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

// ── 🔴 7. EVERY whole-series entry point waits for ITS series ───────────
// The reducer's target sets (UPDATE_JOB_SERIES eligibleIds, DELETE_JOB_SERIES removed)
// are built from state.jobs and are therefore only correct when every occurrence of the
// series is loaded. Rather than rewrite the reducer, every UI path that can reach the
// 'future' scope loads the series first (by series id — never the table) and is gated on
// it. This asserts the closure holds — a new entry point that dispatches
// UPDATE_JOB_SERIES / DELETE_JOB_SERIES without that gate reopens the hole.
{
  const jd = read('../src/pages/JobDetail.jsx');
  const sched = read('../src/pages/Schedule.jsx');
  const njm = read('../src/components/NewJobModal.jsx');

  ok('JobDetail gates its scope modal on the series load', /!seriesLoad\.ready \|\| !seriesMaster/.test(jd));
  ok('Schedule gates its quick paths on the series load', /if \(!jobsLoader\.isSeriesLoaded\(job\.seriesId\)\) return true;/.test(sched));
  ok('  ...its one prompt loads the series before it asks',
    /const promptSeriesScope = async \(job, prompt, single\) => \{[\s\S]{0,200}?await jobsLoader\.ensureSeries\(job\.seriesId\)/.test(sched)
    && /disableFuture: !loaded \|\| isPerDaySeries\(job, s\)/.test(sched));
  ok('  ...and both quick paths go through it (drag and reschedule)',
    (sched.match(/promptSeriesScope\(job, \{ kind: '(drag|reschedule)'/g) || []).length === 2);
  // NewJobModal never decides scope itself — it receives it from Schedule's gated picker.
  ok('NewJobModal takes seriesScope as a PROP (it does not choose)', /seriesScope = null \}/.test(njm));
  ok('  ...supplied by Schedule\'s gated reschedule flow', /seriesScope=\{reschedule\.scope\}/.test(sched));

  // The hooks must actually be sourced, or the gates are undefined-and-falsy.
  ok('JobDetail sources the series load', /const seriesLoad = useSeriesJobs\(/.test(jd));
  ok('Schedule sources the jobs loader', /const jobsLoader = useJobsLoader\(\)/.test(sched));

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
  ok('ARCHIVE_CLIENT plans over state.jobs (so it CAN miss an out-of-window clean)',
    /archiveSchedulePlan\(state\.jobs \|\| \[\], client\.id/.test(red));
  const detail = read('../src/pages/ClientDetail.jsx');
  const list = read('../src/pages/Clients.jsx');
  ok('…so the customer page and the Customers bulk bar offer it only once every clean has loaded',
    /const canArchive = canArchiveClient && canEditJobs && jobsHydrated;/.test(detail)
    && /const canBulkArchive = canArchiveClients && canEditJobs && jobsHydrated;/.test(list));
}

// ── a customer's history: loaded by customer, never called empty before it is asked ─────
// The app holds the jobs window, so "this customer has no cleans in state" says nothing until
// their history has been read (CS-676) — the same lie as the dead-link and the trend cases.
{
  const cd = read('../src/pages/ClientDetail.jsx');
  ok('the customer page loads the customer\'s cleans by customer', /const historyLoad = useClientJobs\(client\?\.id \|\| null\);/.test(cd));
  ok('🔴 ...and says "No service history" only once that history has been read',
    /historyLoad\.ready \? <EmptyState icon=\{<Icon name="schedule" size=\{28\} \/>\} title="No service history"/.test(cd));
}

console.log(`\nwindowed jobs assumptions: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
