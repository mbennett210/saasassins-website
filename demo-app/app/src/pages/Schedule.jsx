import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Avatar from '../components/Avatar';
import Badge from '../components/Badge';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import NewJobModal from '../components/NewJobModal';
import SeriesScopeModal from '../components/SeriesScopeModal';
import FilterBar from '../components/filters/FilterBar';
import { useUrlFilters } from '../hooks/useUrlFilters';
import { useIsMobile } from '../hooks/useIsMobile';
import { useToast } from '../components/Toast';
import { seriesFromDate, STARTED_SERIES_MOVE_BLOCK } from '../lib/seriesScope';
import { applyFilters, rangeBounds } from '../lib/filters/applyFilters';
import { scheduleFilterSpecs } from '../lib/filters/scheduleFilters';
import { useDispatch, useStore, useJobsHydrated, useJobsLoader, useJobsRange, useGetState } from '../store';
import { ACTIONS } from '../store/reducer';
import { HORIZON_DAYS } from '../lib/recurrence.js';
import { jobsWindowBounds } from '../lib/jobsWindow';
import { useAuth } from '../hooks/useAuth';
import { useCanEditJobs } from '../hooks/usePermission';
import {
  selectJobs, selectClientById, selectServiceById,
  selectActiveUsers, selectJobsForUser, selectSeriesJobs, selectSeriesMaster,
  selectConflictJobIds, selectCrewConflicts, selectEffectiveJobStatus, selectEffectiveCrewForJob,
  selectScheduleRowsByCleaner, selectIsJobUnassignedActionable,
} from '../store/selectors';
import ConfirmDialog from '../components/ConfirmDialog';
import * as timeApi from '../lib/timeApi';
import { currentWeekMinutesByUser, otStatus, payWeekStartDayOf, currentPayWeekWindow } from '../lib/payroll';
// ── Manager view (Builder A, 2026-10-09): the "Today" view — today's visits by status ──
import ScheduleToday from '../components/ScheduleToday';
import { useT } from '../i18n/react';

// Compact crew line for a schedule row: the first names of the named crew.
const crewLine = (effectiveCrew) =>
  effectiveCrew.map(({ user }) => user.name.split(' ')[0]).join(', ');
import {
  fmtDate, fmtDateLong, fmtTimeRange, sameDay, startOfWeek, startOfMonth, addDays,
  composeIso, splitIso, dayKey, todayKey, startOfDayKey, addMonthsKey, monthOfKey, dayOfMonthKey,
  addDaysKey, diffDaysKey,
} from '../lib/dates';

// 'Today' (the manager view, 2026-10-09) is today's visits with where each stands — the
// default for a manager; the owner and admins keep Day, and crew never get it (their today
// is My Day). `?view=Today` deep-links it.
const TODAY_VIEW = 'Today';
const VIEWS = [TODAY_VIEW, 'Day', 'Week', 'Month', 'Cleaner'];
const CALENDAR_VIEWS = VIEWS.filter((v) => v !== TODAY_VIEW);

// The calendar cursor is an INSTANT pinned to org-zone midnight, and every read of
// it goes back through dayKey() in the org zone. Building it from local calendar
// fields (`new Date(y, m-1, d)`) made the cursor mean a different day on a Manila
// screen than a Seattle one — the URL's ?d= would resolve to two different days.
const toIsoDay = (d) => dayKey(d);
const fromIsoDay = (s) => startOfDayKey(s);

// Module-level throttle for the perpetual-series top-up. The rolling horizon advances
// ~daily, so re-running the sweep on every Schedule mount (i.e. every navigation to the
// page) is wasteful: when something IS due it mints occurrences → per-row public.jobs
// broadcasts to every connected client, and with several tabs open they race to top up
// the same tail. Cap it to once per hour per tab — far more frequent than the daily
// horizon movement needs, but enough to end the per-navigation storm. Module-level so it
// persists across unmount/remount (a component ref would reset every mount). sync.js's
// flush content-guard separately suppresses the org_state write when a top-up finds
// nothing due; this also avoids the reducer scan + the multi-tab mint race.
const TOP_UP_THROTTLE_MS = 3600000; // 1h
let lastTopUpAt = 0;
// TOP_UP mints from the cleans in memory, so every existing occurrence it could mint over must
// be loaded first (CS-676: the app holds the jobs WINDOW, not the table): it loads [now, until +
// this margin] before it dispatches. The margin reaches one monthly period past the edge, so
// an occurrence deleted near it is still bracketed by a later one and is not minted again.
const TOP_UP_LOAD_MARGIN_MS = 35 * 86400000;
// (The former module-level extend-on-navigate high-water mark lived here. It
// never reset, so a month visited EARLIER in the session permanently blocked
// minting for series created LATER — "I plotted it and it isn't showing",
// 2026-07-30. The effect below is now cheap-idempotent instead: TOP_UP's own
// (seriesId,startAt) dedup makes a re-dispatch a no-op, and the content guard
// suppresses the no-op's write, so a light time throttle is all it needs.)

// Stable empties for the gated view memos — a hidden view's memo must return the
// SAME identity every render or downstream memos keyed on it bust for nothing.
const NO_JOBS = [];
const NO_WEEK = [];

export default function Schedule() {
  const state = useStore();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const nav = useFromHere();
  const t = useT();
  const { currentUser } = useAuth();
  // Gate the affordances on what the server will actually keep (jobsGuard): owner +
  // admin by role (the UI still asks them for the key), a manager by schedule.edit in
  // the committed matrix + their overrides, and never crew, whatever they are granted
  // (owner's call, 2026-09-23).
  // A crew user granted schedule.edit via a per-user override used to get the New Job
  // button while the server silently DROPPED every create with HTTP 200 — a phantom
  // series only their tab ever showed (2026-07-30). useCanEditJobs is that claim-role
  // gate, shared with Job Detail and Time off: the current user's role IS the claim
  // role whenever the login carries one.
  const canCreate = useCanEditJobs();
  const jobsHydrated = useJobsHydrated();
  const jobsLoader = useJobsLoader();
  const getState = useGetState();

  // Until the jobs window has loaded, a schedule edit cannot be mirrored to
  // public.jobs (mirrorJobs no-ops while !jobsReady) — so a move/reschedule made
  // now looks saved but is dropped on refresh. That is exactly the "nothing saves"
  // report from a manager on a slow international link (Lauren, 2026-08-12), the
  // same phantom-success class as the 2026-07-30 claim-role note above. We pause
  // the edit affordances until the window lands (below); this flag only decides
  // whether to SURFACE why, and it waits a beat so a normal fast boot — which
  // loads it in a second or two — never flashes the banner.
  const [hydrationStalled, setHydrationStalled] = useState(false);
  useEffect(() => {
    if (jobsHydrated) { setHydrationStalled(false); return undefined; }
    const t = setTimeout(() => setHydrationStalled(true), 4000);
    return () => clearTimeout(t);
  }, [jobsHydrated]);

  // Keep never-ending recurring jobs perpetual: each visit extends their tail to
  // the rolling horizon. Idempotent — a no-op (stable state) when nothing is due.
  // GATED on the jobs window AND on the stretch it mints into being loaded: topping up a
  // series against cleans not in memory would append duplicates of them (the masters it
  // mints from load with the window — store/sync.js loadJobsBaseline).
  useEffect(() => {
    if (!jobsHydrated) return;
    // GATED on schedule.edit: materializing occurrences IS creating jobs, so it must
    // require the permission that creates jobs. It did not, and `schedule.view` is in
    // ALWAYS_GRANTED — so whichever user mounted /schedule first in a given hour
    // authored the tail for every never-ending series, and a crew member reaching the
    // page by bookmark or a bell-notification link was routinely that user. The
    // server-side jobs guard drops creates from anyone who may not edit the schedule
    // (crew always, a manager pared back), so leaving this ungated would
    // silently stop the schedule rolling forward whenever a crew tab won the race —
    // with the symptom (missing occurrences) surfacing weeks later. Managers live on
    // this page, so the sweep still runs constantly.
    if (!canCreate) return;
    const now = Date.now();
    if (now - lastTopUpAt < TOP_UP_THROTTLE_MS) return; // throttled (see TOP_UP_THROTTLE_MS)
    // Set only once we are actually going to dispatch — returning early above must not
    // burn the hour for the manager who mounts the page next (a failed load gives it back).
    lastTopUpAt = now;
    jobsLoader.ensureRange(now, now + HORIZON_DAYS * 86400000 + TOP_UP_LOAD_MARGIN_MS)
      .then(() => dispatch({ type: ACTIONS.TOP_UP_RECURRING_SERIES }))
      .catch(() => { lastTopUpAt = 0; });
  }, [dispatch, jobsHydrated, canCreate, jobsLoader]);

  const [searchParams, setSearchParams] = useSearchParams();
  // Functional updater — a snapshot-built URLSearchParams raced concurrent
  // param writes inside router transitions and dropped the other write (the
  // filter-lost-on-view-switch half of the 2026-07-30 range report).
  const setParam = (key, value, defaultValue) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value === '' || value == null || value === defaultValue) next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  };

  // Clamp to a real view: a stale/removed value in ?view= (e.g. an old
  // ?view=Agenda bookmark after those tabs were dropped) falls back to the
  // viewer's default view (Today for a manager, else Day) rather than rendering
  // a blank body with no active tab. The default is left out of the URL.
  const isCrewViewer = currentUser?.role === 'crew';
  const views = isCrewViewer ? CALENDAR_VIEWS : VIEWS;
  const defaultView = currentUser?.role === 'manager' ? TODAY_VIEW : 'Day';
  const view = views.includes(searchParams.get('view')) ? searchParams.get('view') : defaultView;
  const setView = (v) => setParam('view', v, defaultView);
  const refDate = searchParams.get('d') ? fromIsoDay(searchParams.get('d')) : new Date();
  const todayIso = todayKey();
  const setRefDate = (d) => setParam('d', toIsoDay(d), todayIso);
  const refDayKey = toIsoDay(refDate); // stable per calendar day (refDate is a fresh Date each render)

  // EXTEND-ON-NAVIGATE: never-ending series materialize only HORIZON_DAYS (90)
  // ahead by default. When the cursor nears/passes the materialized edge, ask
  // TOP_UP to build through the viewed range plus a month. Same laws as the
  // mount sweep above: gated on full hydration AND schedule.edit. Re-dispatch
  // is CHEAP-IDEMPOTENT (TOP_UP's (seriesId,startAt) dedup mints nothing new;
  // the flush content guard suppresses the resulting no-op write), so there is
  // no high-water mark to go stale — the old module-level mark never reset and
  // silently blocked minting for series created later in the session. Deps
  // include state.jobs so a series created while PARKED on a far month gets
  // its tail minted immediately; the 5s ref-throttle bounds dispatch rate.
  const lastExtendAtRef = useRef(0);
  useEffect(() => {
    if (!jobsHydrated || !canCreate) return;
    const DAY = 86400000;
    const spanDays = view === 'Month' ? 31 : (view === 'Day' || view === TODAY_VIEW) ? 1 : 7;
    // Org-zone day math (fromIsoDay pins the key to org midnight) — the old
    // `${key}T00:00:00Z` was UTC, a 7-8h skew inside the buffer.
    const viewedEndMs = fromIsoDay(refDayKey).getTime() + spanDays * DAY;
    const BUFFER = 14 * DAY;
    if (viewedEndMs + BUFFER <= Date.now() + HORIZON_DAYS * DAY) return; // well inside — nothing to build
    const nowMs = Date.now();
    if (nowMs - lastExtendAtRef.current < 5000) return;
    lastExtendAtRef.current = nowMs;
    const untilMs = viewedEndMs + 30 * DAY;
    // Everything it could mint over must be in memory first (see TOP_UP_LOAD_MARGIN_MS).
    jobsLoader.ensureRange(nowMs, untilMs + TOP_UP_LOAD_MARGIN_MS)
      .then(() => dispatch({ type: ACTIONS.TOP_UP_RECURRING_SERIES, untilMs }))
      .catch(() => { lastExtendAtRef.current = 0; });
  }, [dispatch, jobsHydrated, canCreate, view, refDayKey, state.jobs, jobsLoader]);
  const [modalOpen, setModalOpen] = useState(false);
  // Global search "New job" deep-link: ?new=1 opens the new-job modal once, then strips the
  // param. Gated like the New Job button itself: canCreate AND
  // jobsHydrated (the button is disabled until the job set has loaded, so the deep-link
  // waits — the param stays in the URL until then).
  useEffect(() => {
    if (searchParams.get('new') && canCreate && jobsHydrated) {
      setModalOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, canCreate, jobsHydrated, setSearchParams]);
  // Reschedule modal: { job, scope } where scope is null | 'single' | 'future'.
  const [reschedule, setReschedule] = useState(null);
  // Deferred series-scope prompt shared by the Reschedule button and Week drag-drop.
  // { kind: 'reschedule' | 'drag', job, targetDate? } — resolved by SeriesScopeModal.
  const [seriesPrompt, setSeriesPrompt] = useState(null);

  // Shared, URL-persisted faceted filters (location / cleaner / label / status /
  // service / date-range / crew-size / recurrence). See CLEANSPACE_SWEPT.md §2.6.
  const filters = useUrlFilters(scheduleFilterSpecs);
  const isMobile = useIsMobile();
  const toast = useToast();
  // ⚠️ Keyed on the filter pipeline's PROVEN read-set, not the whole snapshot.
  // useStore() returns a fresh snapshot identity on EVERY dispatch, so `[state]`
  // here meant every unrelated dispatch (a notification, a message, a key event)
  // recomputed the ~19k-job × 8-spec filter pipeline below — ~150k predicate
  // evaluations a pop, the measured Schedule jank. The specs read exactly:
  //   options — selectVisibleSitesFor (sites, clients, jobs, user) ·
  //             selectClientById (clients) · selectActiveUsers (users) ·
  //             state.tags · selectServices (services)
  //   match   — selectEffectiveTagIds (sites, clients)
  // ctx.state stays the live snapshot object; every path the specs read into it
  // is in this dep list, so it can never be observably stale. If a spec grows a
  // new slice read, ADD IT HERE or that filter facet goes stale.
  const filterCtx = useMemo(
    () => ({ state, user: currentUser }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.jobs, state.sites, state.clients, state.users, state.tags, state.services, currentUser],
  );

  // ── Date-range → Cleaner plumbing ──────────────────────────────────────────
  // A custom from/to range can't render on a cursor-pinned calendar grid, so it
  // displays on the Cleaner view — the only view that un-windows to the whole span
  // when a range is active. "Is a custom range set" drives two behaviours:
  const customRange = filters.values.range;
  const customRangeActive = !!(customRange && (customRange.from || customRange.to));

  // (1) Surface it — the MOMENT a user enters custom dates on a calendar view, jump
  // to Cleaner so the range actually shows something (it silently did nothing on the
  // default Day view before — 2026-08-04 report). Fire only on the transition INTO
  // a custom range (ref-guarded) so they can still click back to Day/Week/Month with
  // the range applied as a plain filter, rather than being yanked to Cleaner again.
  const prevCustomRangeRef = useRef(false);
  useEffect(() => {
    const wasActive = prevCustomRangeRef.current;
    prevCustomRangeRef.current = customRangeActive;
    // Today is cursor-pinned too (it is always today), so a range entered there moves on as well.
    if (customRangeActive && !wasActive && (view === TODAY_VIEW || view === 'Day' || view === 'Week' || view === 'Month')) {
      setView('Cleaner');
    }
    // setView is a fresh closure each render; the ref transition is the real guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customRangeActive, view]);

  // (2) Materialize never-ending series through a far-future range end, or a
  // range view shows nothing past the 90-day horizon. Same gates + shared 5s throttle
  // as the extend-on-navigate effect above.
  useEffect(() => {
    if (!jobsHydrated || !canCreate) return;
    const to = rangeBounds(customRange || null).to;
    if (!to) return;
    const DAY = 86400000;
    const untilMs = to.getTime() + 7 * DAY;
    if (untilMs <= Date.now() + HORIZON_DAYS * DAY) return; // within the horizon — nothing to build
    const nowMs = Date.now();
    if (nowMs - lastExtendAtRef.current < 5000) return;
    lastExtendAtRef.current = nowMs;
    jobsLoader.ensureRange(nowMs, untilMs + TOP_UP_LOAD_MARGIN_MS)
      .then(() => dispatch({ type: ACTIONS.TOP_UP_RECURRING_SERIES, untilMs }))
      .catch(() => { lastExtendAtRef.current = 0; });
  }, [dispatch, jobsHydrated, canCreate, customRange, state.jobs, jobsLoader]);

  // Week DnD state
  const [draggingId, setDraggingId] = useState(null);
  const [dropTargetDay, setDropTargetDay] = useState(null);
  // A drag-drop reschedule that would double-book the job's (effective) crew is
  // held here for a confirm gate rather than committed silently.
  const [dropConflict, setDropConflict] = useState(null); // { move, conflicts } — move: {kind:'single'|'series', …}

  const jobsAll = selectJobs(state);
  const users = selectActiveUsers(state);
  const scope = currentUser?.role === 'crew' ? selectJobsForUser(state, currentUser.id) : jobsAll;

  const filteredJobs = useMemo(
    () => applyFilters(scope, filters.values, scheduleFilterSpecs, filterCtx),
    [scope, filters.values, filterCtx],
  );

  // The Today view keeps the page's facets: it shows a visit only when the filtered set holds
  // it. Null (no narrowing) when no facet is set, so the common case builds nothing.
  const todayJobIds = useMemo(
    () => (view === TODAY_VIEW && filters.activeCount > 0 ? new Set(filteredJobs.map((j) => j.id)) : null),
    [view, filters.activeCount, filteredJobs],
  );

  // Count of cleans nobody is assigned to that still need someone, across the
  // current filtered set — the "someone needs to be scheduled" backlog. Uses the
  // SAME predicate as the Unassigned filter facet + By-Cleaner lane, so clicking
  // the chip shows exactly the rows it counted. Manager-only.
  const unassignedCount = useMemo(
    () => (canCreate
      ? filteredJobs.filter((j) => selectIsJobUnassignedActionable(state, j)).length
      : 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canCreate, filteredJobs, state.jobs, state.users, state.sites, state.clients],
  );

  // ── ONE O(N) day-bucketing pass; every view reads its cells by key ─────────
  // The pre-fix chain re-filtered ALL filtered jobs per visible day, per view,
  // per render: dayJobs (1×N) + weekJobs (7×N) + monthGrid (42×N) sameDay()
  // calls — ~50×N un-cached Intl day-key resolutions ≈ a MEASURED 4.0s per
  // toggle at 5k jobs (scratch bench, desktop), the reported 5-10s freeze.
  // All memos are keyed on refDayKey (stable per calendar day), never refDate —
  // refDate is a FRESH Date every render, so keying on it busted everything
  // unconditionally. Hidden views compute nothing (gated on `view`).
  const jobsByDay = useMemo(() => {
    const m = new Map();
    for (const j of filteredJobs) {
      const k = dayKey(j.startAt);
      const arr = m.get(k);
      if (arr) arr.push(j); else m.set(k, [j]);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.startAt.localeCompare(b.startAt));
    return m;
  }, [filteredJobs]);

  const dayJobs = useMemo(() => jobsByDay.get(refDayKey) || NO_JOBS, [jobsByDay, refDayKey]);
  const dayConflictJobIds = useMemo(() => selectConflictJobIds(state, dayJobs), [state, dayJobs]);

  const weekDays = useMemo(() => {
    const start = startOfWeek(fromIsoDay(refDayKey));
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [refDayKey]);
  const weekJobs = useMemo(() => {
    if (view !== 'Week') return NO_WEEK;
    return weekDays.map((d) => ({ date: d, jobs: jobsByDay.get(dayKey(d)) || NO_JOBS }));
  }, [view, weekDays, jobsByDay]);
  // Per-day conflicts unioned across the week (overlap only happens within a day).
  const weekConflictJobIds = useMemo(() => {
    const ids = new Set();
    for (const { jobs } of weekJobs) for (const id of selectConflictJobIds(state, jobs)) ids.add(id);
    return ids;
  }, [state, weekJobs]);

  const monthGrid = useMemo(() => {
    if (view !== 'Month') return NO_WEEK;
    const gridStart = startOfWeek(startOfMonth(fromIsoDay(refDayKey)));
    const refMonth = monthOfKey(refDayKey);
    return Array.from({ length: 42 }, (_, i) => {
      const d = addDays(gridStart, i);
      const k = dayKey(d);
      return { date: d, sameMonth: monthOfKey(k) === refMonth, jobs: jobsByDay.get(k) || NO_JOBS };
    });
  }, [view, refDayKey, jobsByDay]);

  // By-cleaner view: if a date-range facet is active it already windowed
  // filteredJobs; otherwise default to the visible week so the grouped view
  // isn't the entire history. The nav arrows shift this week.
  const rangeActive = !!(filters.values.range && (filters.values.range.preset || filters.values.range.from || filters.values.range.to));
  const groupWindowJobs = useMemo(() => {
    if (view !== 'Cleaner') return NO_JOBS;
    if (rangeActive) return filteredJobs;
    const ws = startOfWeek(fromIsoDay(refDayKey));
    const start = ws.getTime();
    const end = addDays(ws, 7).getTime();
    return filteredJobs.filter((j) => {
      const t = new Date(j.startAt).getTime();
      return t >= start && t < end;
    });
  }, [view, filteredJobs, rangeActive, refDayKey]);
  const cleanerRows = useMemo(() => selectScheduleRowsByCleaner(state, groupWindowJobs, users), [state, groupWindowJobs, users]);

  // ── The days on screen are LOADED (CS-676) ───────────────────────────────────
  // The app holds the jobs window (src/lib/jobsWindow.js, −45/+100 days), never the whole
  // table; a week, month or range outside it is fetched when the calendar moves there. Day
  // keys in the org zone, so the ask is the same all day (padded a day each side, so a clean
  // starting just past midnight still lands in its cell); an open-ended range runs to the
  // window's edge.
  const viewRange = useMemo(() => {
    let fromKey;
    let toKey; // exclusive
    if (view === TODAY_VIEW) { fromKey = todayIso; toKey = addDaysKey(todayIso, 1); }
    else if (view === 'Day') { fromKey = refDayKey; toKey = addDaysKey(refDayKey, 1); }
    else if (view === 'Month') { fromKey = dayKey(startOfWeek(startOfMonth(fromIsoDay(refDayKey)))); toKey = addDaysKey(fromKey, 42); }
    else if (view === 'Cleaner' && rangeActive) {
      const rb = rangeBounds(customRange || null);
      const win = jobsWindowBounds();
      fromKey = dayKey(rb.from || new Date(win.fromMs));
      toKey = addDaysKey(dayKey(rb.to || new Date(win.toMs)), 1);
    } else { fromKey = dayKey(startOfWeek(fromIsoDay(refDayKey))); toKey = addDaysKey(fromKey, 7); } // Week, Cleaner
    return { from: startOfDayKey(addDaysKey(fromKey, -1)).getTime(), to: startOfDayKey(addDaysKey(toKey, 1)).getTime() };
  }, [view, refDayKey, todayIso, rangeActive, customRange]);
  const viewLoad = useJobsRange(viewRange.from, viewRange.to);

  // Approaching-40h lens for the By-Cleaner view: this week's CLOCKED labor per
  // cleaner (operational — approved or not), flagged at 36h/40h. Manager-only
  // (the rollup route is manager-gated); crew skip the fetch. Component-local
  // projection (useState), never the synced blob (§2.1).
  const isManager = currentUser?.role !== 'crew';
  const [weekClocked, setWeekClocked] = useState(null); // Map userId -> { minutes }
  // The ORG's workweek (lib/payroll's one reader), the week the pay run pays overtime on — a
  // hard-coded Sunday counted a different week in production's Monday week (CS-055).
  const weekStartDay = payWeekStartDayOf(state.opsSettings);
  useEffect(() => {
    if (!isManager || view !== 'Cleaner') return undefined;
    let cancelled = false;
    const now = new Date();
    const week = currentPayWeekWindow(now, { weekStartDay });
    timeApi.rollup({ fromIso: week.fromIso, toIso: week.toIso })
      .then((entries) => { if (!cancelled) setWeekClocked(currentWeekMinutesByUser(entries, { now: now.getTime(), weekStartDay })); })
      .catch(() => { if (!cancelled) setWeekClocked(null); });
    return () => { cancelled = true; };
  }, [isManager, view, weekStartDay]);

  const shiftRef = (dir) => {
    // Stepped on the org's calendar, not the device's — setDate/setMonth read local
    // fields, and setMonth() also overflows (Jan 31 + 1mo → March) rather than clamps.
    if (view === 'Month') setRefDate(startOfDayKey(addMonthsKey(dayKey(refDate), dir)));
    else setRefDate(addDays(refDate, view === 'Day' ? dir : 7 * dir)); // Week, Cleaner
  };

  const viewTitle = useMemo(() => {
    if (view === TODAY_VIEW) return t('schedToday.title');
    if (view === 'Day') return fmtDateLong(refDate.toISOString());
    if (view === 'Month') return fmtDate(refDate.toISOString(), { month: 'long', year: 'numeric' });
    // Cleaner un-windows to the whole span when a range/preset is active — name
    // that window, not the week it would otherwise show.
    if (view === 'Cleaner' && rangeActive) {
      const { from, to } = rangeBounds(customRange || null);
      if (from && to) return `${fmtDate(from.toISOString(), { month: 'short', day: 'numeric' })} – ${fmtDate(to.toISOString(), { month: 'short', day: 'numeric', year: 'numeric' })}`;
      if (from) return `From ${fmtDate(from.toISOString(), { month: 'short', day: 'numeric', year: 'numeric' })}`;
      if (to) return `Through ${fmtDate(to.toISOString(), { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    // Week + Cleaner (no range) — show the week window.
    const s = startOfWeek(refDate); const e = addDays(s, 6);
    return `${fmtDate(s.toISOString(), { month: 'short', day: 'numeric' })} – ${fmtDate(e.toISOString(), { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }, [view, refDate, customRange, rangeActive, t]);

  // Compact date for the mobile header (Direction 4): Day → "Tue, Sep 15", Month →
  // "Sep 2026"; the Week/Cleaner range titles are already short enough to reuse.
  const viewTitleShort = useMemo(() => {
    if (view === 'Day') return fmtDate(refDate.toISOString(), { weekday: 'short', month: 'short', day: 'numeric' });
    if (view === 'Month') return fmtDate(refDate.toISOString(), { month: 'short', year: 'numeric' });
    return viewTitle;
  }, [view, refDate, viewTitle]);

  // Week DnD handlers
  const onWeekDragStart = (e, job) => {
    if (!canCreate) return;
    e.dataTransfer.setData('text/plain', job.id);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingId(job.id);
  };
  const onWeekDragEnd = () => { setDraggingId(null); setDropTargetDay(null); };
  const onColDragOver = (e, dayIso) => {
    if (!canCreate) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetDay(dayIso);
  };
  const onColDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDropTargetDay(null);
  };
  const isSeriesJob = (job, s = state) => !!(job.seriesId && selectSeriesJobs(s, job.seriesId).length > 1);
  // A per-day (multi-day / block) weekly series carries per-day crews + times in
  // recurrence.dayOverrides (or runs on >1 weekday). The quick paths here edit
  // through a single crew/time — so "this & all future" would flatten every day.
  // Restrict those to "just this one"; whole-series edits go through the job's
  // block-aware Edit (JobDetail). A single-day series has neither and is safe.
  // 🔴 FAILS SAFE WHEN THE SERIES IS NOT LOADED.
  //
  // The app holds the jobs WINDOW (−45/+100 days, store/sync.js), not the table, so a
  // series' occurrences past it — and, for a series older than the window, its master —
  // are in memory only once the series is loaded (promptSeriesScope below loads it before
  // asking). The old code read a missing master as "not per-day", the DANGEROUS direction:
  // it OFFERED "this & all future", which patches a single uniform crew across every
  // occurrence and flattens the per-day crews in recurrence.dayOverrides. Unknown means
  // "assume per-day": a false positive restricts the user to "just this one" (whole-series
  // edits stay in JobDetail's block-aware editor); a false negative silently loses every
  // day's crew assignment.
  const isPerDaySeries = (job, s = state) => {
    if (!job.seriesId) return false;
    // Not loaded → the whole-series path is unsafe regardless of shape: UPDATE_JOB_SERIES and
    // DELETE_JOB_SERIES build their target set from state.jobs, so an occurrence not in memory
    // would be silently left behind. The same rule JobDetail's scope modal applies.
    if (!jobsLoader.isSeriesLoaded(job.seriesId)) return true;
    const m = selectSeriesMaster(s, job.seriesId);
    if (!m) return true; // master missing → assume the risky shape
    const r = m.recurrence;
    if (!r || r.frequency !== 'weekly') return false;
    return (r.dayOverrides && Object.keys(r.dayOverrides).length > 0)
      || (Array.isArray(r.daysOfWeek) && r.daysOfWeek.length > 1);
  };

  // A series visit's move or reschedule asks "just this one, or all future?" — after its
  // SERIES is loaded (CS-676): the answer decides a target set that must hold every
  // occurrence, and the master decides whether "all future" is safe at all. A series that
  // could not be loaded still offers "just this one". `single()` runs the one-visit path:
  // a series of one visit needs no question.
  const promptSeriesScope = async (job, prompt, single) => {
    let loaded = true;
    try { await jobsLoader.ensureSeries(job.seriesId); } catch { loaded = false; }
    const s = getState();
    if (loaded && !isSeriesJob(job, s)) { single(); return; }
    setSeriesPrompt({ ...prompt, job, disableFuture: !loaded || isPerDaySeries(job, s), disableReason: loaded ? null : 'load-failed' });
  };

  const onColDrop = (e, targetDate) => {
    e.preventDefault();
    const jobId = e.dataTransfer.getData('text/plain');
    setDraggingId(null);
    setDropTargetDay(null);
    // !jobsHydrated: the card is un-draggable in that state (see draggable= below),
    // so this is belt-and-suspenders — a move can't be mirrored until the window
    // lands, and letting one through here is the phantom "saved, then gone" path.
    if (!canCreate || !jobId || !jobsHydrated) return;
    const job = getState().jobs.find((j) => j.id === jobId);
    if (!job) return;
    if (splitIso(job.startAt).date === toIsoDay(targetDate)) return; // same day → no move
    // A series occurrence can't move silently — ask "just this one, or all future?"
    // FIRST (the conflict set depends on that answer), then apply.
    if (job.seriesId) { promptSeriesScope(job, { kind: 'drag', targetDate }, () => applyDragMove(job, targetDate, 'single')); return; }
    applyDragMove(job, targetDate, 'single');
  };

  // Crew double-books for a move: just this occurrence ('single') or every still-
  // upcoming occurrence of the series ('future'). Same-series jobs move together, so
  // they're never counted as conflicting with each other. Confirm-gate, don't block.
  // Read from the live state: it runs after a series load.
  const moveConflicts = (job, targetDate, scope) => {
    const s = getState();
    const dayShift = diffDaysKey(splitIso(job.startAt).date, toIsoDay(targetDate));
    const occ = scope === 'future'
      ? s.jobs.filter((j) => j.seriesId === job.seriesId && j.status === 'upcoming' && j.startAt >= job.startAt)
      : [job];
    const seen = new Set();
    const out = [];
    for (const o of occ) {
      const os = splitIso(o.startAt); const oe = splitIso(o.endAt);
      const nd = addDaysKey(os.date, dayShift);
      const crew = selectEffectiveCrewForJob(s, o).map((c) => c.user.id);
      for (const c of selectCrewConflicts(s, crew, composeIso(nd, os.time), composeIso(nd, oe.time), o.id)) {
        // Time-off conflicts carry no job (c.timeOff instead) — see selectCrewConflicts.
        if (scope === 'future' && c.job?.seriesId === job.seriesId) continue;
        const k = `${c.job ? c.job.id : `off_${c.timeOff?.id}`}|${c.userName}`;
        if (!seen.has(k)) { seen.add(k); out.push(c); }
      }
    }
    return { dayShift, conflicts: out };
  };

  const applyDragMove = (job, targetDate, scope) => {
    // A series move anchors on the dragged occurrence; one that has already
    // STARTED can't be the anchor (Sept 2: a "this & future" op from tonight's
    // in-progress clean rewrote/deleted it). Refuse, don't clamp — a clamped
    // anchor would compute the wrong day shift for every future occurrence.
    if (scope === 'future' && seriesFromDate(job).started) {
      toast.error(STARTED_SERIES_MOVE_BLOCK);
      return;
    }
    const { dayShift, conflicts } = moveConflicts(job, targetDate, scope);
    if (!dayShift) return; // same-day (defensive)
    const move = scope === 'future'
      ? { kind: 'series', seriesId: job.seriesId, jobId: job.id, fromDate: job.startAt, targetDayKey: toIsoDay(targetDate) }
      : { kind: 'single', jobId: job.id, startAt: job.startAt, endAt: job.endAt, targetIso: toIsoDay(targetDate) };
    if (conflicts.length) { setDropConflict({ move, conflicts }); return; }
    dispatchMove(move);
  };

  const dispatchMove = (move) => {
    if (move.kind === 'series') {
      // Absolute target (not a relative dayShift): adoptRemote replays recorded
      // actions after any peer's save, and a replayed relative shift DOUBLE-
      // moved the series. The reducer derives the shift from where the anchor
      // sits now and no-ops once the move has applied.
      // anchorId: the dragged visit, so a replay knows EXACTLY whether the move applied.
      dispatch({ type: ACTIONS.UPDATE_JOB_SERIES, seriesId: move.seriesId, fromDate: move.fromDate, patch: {}, targetDayKey: move.targetDayKey, anchorId: move.jobId });
    } else {
      const s = splitIso(move.startAt); const en = splitIso(move.endAt);
      dispatch({ type: ACTIONS.UPDATE_JOB, id: move.jobId, patch: { startAt: composeIso(move.targetIso, s.time), endAt: composeIso(move.targetIso, en.time) } });
    }
  };

  const commitDrop = () => {
    if (!dropConflict) return;
    dispatchMove(dropConflict.move);
  };

  // Reschedule button: series occurrences prompt for scope first; one-offs open direct.
  const openReschedule = (job) => {
    // Guard the same as drag: a reschedule dispatched before the window lands
    // can't be mirrored and is lost on refresh. The button is disabled in that state;
    // this backstops a stray call.
    if (!jobsHydrated) return;
    if (job.seriesId) promptSeriesScope(job, { kind: 'reschedule' }, () => setReschedule({ job, scope: null }));
    else setReschedule({ job, scope: null });
  };

  // Resolve the shared scope prompt into the concrete action for its origin.
  const onSeriesScopePick = (scope) => {
    const p = seriesPrompt;
    setSeriesPrompt(null);
    if (!p) return;
    if (p.kind === 'reschedule') setReschedule({ job: p.job, scope });
    else applyDragMove(p.job, p.targetDate, scope);
  };

  // Month cell click → Day view (set both params atomically)
  const monthCellClick = (date) => {
    const next = new URLSearchParams(searchParams);
    const iso = toIsoDay(date);
    if (iso === todayIso) next.delete('d'); else next.set('d', iso);
    // Day is the default view only for the owner / admin; a manager's default is Today.
    if (defaultView === 'Day') next.delete('view'); else next.set('view', 'Day');
    setSearchParams(next, { replace: true });
  };

  // Compact one-line clean row for the grouped (Cleaner) view.
  const fmtMins = (m) => {
    const h = Math.floor(m / 60), mm = m % 60;
    if (!h) return `${mm}m`;
    return mm ? `${h}h ${mm}m` : `${h}h`;
  };
  const statusBadge = (eff) => {
    if (eff === 'done') return <Badge variant="green">Done</Badge>;
    if (eff === 'in_progress') return <Badge variant="amber">In Progress</Badge>;
    if (eff === 'missed') return <Badge variant="red">Missed</Badge>;
    if (eff === 'cancelled') return <Badge variant="slate">Cancelled</Badge>;
    return <Badge variant="blue">Upcoming</Badge>;
  };
  const renderSchedRow = (job, ownerId) => {
    const client = selectClientById(state, job.clientId);
    const service = selectServiceById(state, job.serviceId);
    const crew = selectEffectiveCrewForJob(state, job);
    // The lane is already grouped under a cleaner, so repeating that cleaner's own
    // name on every row is noise. Show only CO-crew (everyone else on a shared
    // clean); a solo clean shows nothing. The Unassigned lane (no ownerId) keeps
    // its red flag. This aside rides at the end of the description column, so it
    // never becomes a floating middle column that drags out of alignment.
    const coCrew = ownerId ? crew.filter((c) => c.user.id !== ownerId) : crew;
    let aside = null;
    if (crew.length === 0) {
      // Red only while it still needs someone; a done/cancelled clean with no crew
      // reads muted. The Cancelled/Done badge beside it says why.
      aside = <span className={`sched-row-with${selectIsJobUnassignedActionable(state, job) ? ' sched-unassigned' : ''}`}>Unassigned</span>;
    } else if (coCrew.length > 0) {
      aside = <span className="sched-row-with">with {crewLine(coCrew)}</span>;
    }
    return (
      <div key={job.id} className="sched-row clickable" onClick={() => navigate(`/schedule/${job.id}`, { state: nav })}>
        <span className="sched-row-time">{fmtDate(job.startAt, { weekday: 'short', month: 'short', day: 'numeric' })} · {fmtTimeRange(job.startAt, job.endAt)}</span>
        <span className="sched-row-main">
          <span className="sched-row-desc"><strong>{client?.name || '—'}</strong> <span className="sched-row-svc">· {service?.name || '—'}</span></span>
          {aside}
        </span>
        {statusBadge(selectEffectiveJobStatus(job))}
      </div>
    );
  };

  // New Job — brand GOLD (was btn-success green). Desktop: labeled button in the
  // page head. Mobile (Approach 2): a compact gold + in the toolbar's Filters row,
  // injected via FilterBar's `action` slot so tabs + Filters + New Job share one row
  // instead of a full-width green bar.
  const newJobTitle = !jobsHydrated ? 'Still loading the full schedule. Try again in a moment' : undefined;
  const newJobFull = canCreate ? (
    <button type="button" className="btn btn-gold sched-newjob" disabled={!jobsHydrated} title={newJobTitle} onClick={() => setModalOpen(true)}>
      <span>New Job</span>
    </button>
  ) : null;
  const newJobIcon = canCreate ? (
    <button type="button" className="btn btn-gold sched-newjob sched-newjob-icon" disabled={!jobsHydrated} title={newJobTitle} aria-label="New Job" onClick={() => setModalOpen(true)}>
      <Icon name="plus" size={18} />
    </button>
  ) : null;

  return (
    <>
      {!isMobile && (
        <div className="page-head">
          <div className="page-head-text">
            <h1>Schedule</h1>
          </div>
          {newJobFull && <div className="page-head-actions">{newJobFull}</div>}
        </div>
      )}

      {canCreate && !jobsHydrated && hydrationStalled && (
        <div className="callout callout-warning text-sm" style={{ marginBottom: 12 }}>
          <strong>Still loading your full schedule.</strong> Hold off on moving, rescheduling, or
          creating jobs until this finishes. A change made right now will not save and will disappear on refresh.
          This can take longer on a slow connection and clears on its own.
        </div>
      )}

      {jobsHydrated && !viewLoad.ready && (
        <div className={`callout ${viewLoad.error ? 'callout-warning' : 'callout-info'} text-sm mb-14`} role="status">
          {viewLoad.error ? (
            <>
              {t('jobsLoad.rangeFailed')}{' '}
              <button type="button" className="btn btn-outline" onClick={viewLoad.retry}>{t('common.retry')}</button>
            </>
          ) : t('jobsLoad.range')}
        </div>
      )}

      <div className="schedule-toolbar">
        <div className="tab-container tab-container-line">
          {views.map((v) => (
            <button key={v} className={`tab-btn ${view === v ? 'active' : ''}`} onClick={() => setView(v)} type="button">{v === TODAY_VIEW ? t('schedToday.tab') : v}</button>
          ))}
        </div>
        <div className="schedule-nav">
          {unassignedCount > 0 && (
            <button
              type="button"
              className={`chip chip-danger ${filters.values.assign === 'unassigned' ? 'on' : ''}`}
              aria-pressed={filters.values.assign === 'unassigned'}
              title="Show only cleans nobody is assigned to"
              onClick={() => {
                const on = filters.values.assign === 'unassigned';
                // ONE atomic URL write for both keys. filters.setValue + setView are
                // two separate setSearchParams calls, and React Router's functional
                // updater reads `prev` from the LAST RENDER — so two writes in one
                // handler both start from the same stale params and the second
                // navigate() drops the first (seen in the browser: the view switched,
                // the facet was lost). Same encoding setParam/setValue use.
                setSearchParams((prev) => {
                  const next = new URLSearchParams(prev);
                  if (on) {
                    next.delete('assign');
                  } else {
                    next.set('assign', 'unassigned');
                    // Land on Cleaner — its Unassigned lane is where these cleans
                    // show. Note the count spans the whole filtered set while Cleaner
                    // is week-windowed unless a range is set (Agenda, the one
                    // un-windowed view, was removed).
                    next.set('view', 'Cleaner');
                  }
                  return next;
                }, { replace: true });
              }}
            >
              <Icon name="warning" size={13} /> {unassignedCount} unassigned
            </button>
          )}
          {view === TODAY_VIEW ? (
            /* Today is always today: no date to step, just its title. */
            <span className="schedule-title">{viewTitle}</span>
          ) : isMobile ? (
            /* Direction 4 mobile: ‹ [compact date] › — arrows flank the date, no Today
               (the arrows step; the range/date already reads as "today" when it is). */
            <>
              <button className="btn-icon sched-nav-arrow" aria-label="Previous" onClick={() => shiftRef(-1)}><Icon name="chevronLeft" size={16} /></button>
              {viewTitle && <span className="schedule-title">{viewTitleShort}</span>}
              <button className="btn-icon sched-nav-arrow" aria-label="Next" onClick={() => shiftRef(1)}><Icon name="chevronRight" size={16} /></button>
            </>
          ) : (
            <>
              {viewTitle && <span className="schedule-title">{viewTitle}</span>}
              <div className="schedule-nav-controls">
                <button className="btn-icon btn-icon-primary" aria-label="Previous" onClick={() => shiftRef(-1)}><Icon name="chevronLeft" size={16} /></button>
                <button className="btn btn-primary btn-sm" onClick={() => setRefDate(new Date())}>Today</button>
                <button className="btn-icon btn-icon-primary" aria-label="Next" onClick={() => shiftRef(1)}><Icon name="chevronRight" size={16} /></button>
              </div>
            </>
          )}
        </div>
        {isMobile && (
          <FilterBar
            specs={scheduleFilterSpecs}
            values={filters.values}
            setValue={filters.setValue}
            clearAll={filters.clearAll}
            activeCount={filters.activeCount}
            ctx={filterCtx}
            action={newJobIcon}
          />
        )}
      </div>

      {!isMobile && (
        <FilterBar
          specs={scheduleFilterSpecs}
          values={filters.values}
          setValue={filters.setValue}
          clearAll={filters.clearAll}
          activeCount={filters.activeCount}
          ctx={filterCtx}
        />
      )}

      {view === TODAY_VIEW && <ScheduleToday jobIds={todayJobIds} />}

      {view === 'Day' && (
        <div className="card dash-card tl-day-card">
          {dayJobs.length === 0 ? (viewLoad.ready && (
            <EmptyState icon={<Icon name="schedule" size={28} />} title="No jobs scheduled" message={canCreate ? 'Add your first job to start planning the day.' : 'Check back soon nothing to do yet.'} action={canCreate && <button className="btn btn-primary" disabled={!jobsHydrated} title={!jobsHydrated ? 'Still loading the full schedule try again in a moment' : undefined} onClick={() => setModalOpen(true)}>New Job</button>} />
          )) : (
            <div className="tl-track">
              <div className="tl-line" />
              {dayJobs.map((job) => {
                const client = selectClientById(state, job.clientId);
                const service = selectServiceById(state, job.serviceId);
                const crew = selectEffectiveCrewForJob(state, job);
                const hasConflict = dayConflictJobIds.has(job.id);
                return (
                  <div key={job.id} className={`tl-item ${job.status}`}>
                    <div className="tl-dot" />
                    <div className="tl-time">
                      {fmtTimeRange(job.startAt, job.endAt)}
                      {job.seriesId && <Icon name="repeat" size={10} className="series-badge" />}
                      {hasConflict && <Icon name="warning" size={10} className="conflict-dot" />}
                    </div>
                    <div className="tl-card clickable" onClick={() => navigate(`/schedule/${job.id}`, { state: nav })}>
                      <div className="tl-card-head">
                        <div className="tl-card-title">
                          <strong>{client?.name || '—'}</strong> &mdash; {service?.name || '—'}
                        </div>
                        <div className="tl-card-meta">
                          {job.status === 'done' && <Badge variant="green">Done</Badge>}
                          {job.status === 'in_progress' && <Badge variant="amber">In Progress</Badge>}
                          {(job.status === 'missed' || (job.status !== 'done' && job.status !== 'in_progress' && job.status !== 'cancelled' && new Date(job.startAt) < new Date())) && <Badge variant="red">Missed</Badge>}
                          {job.status === 'cancelled' && <Badge variant="slate">Cancelled</Badge>}
                        </div>
                        {/* R4 (THEME_CLEANSPACE.md §2): the row action gets its OWN reserved
                            trailing slot so the status badges (in .tl-card-meta) share one axis
                            and the Reschedule buttons share another — never commingled. */}
                        <div className="tl-card-action">
                          {canCreate && job.status === 'upcoming' && (
                            <button className="btn btn-sm btn-outline" disabled={!jobsHydrated}
                              title={!jobsHydrated ? 'Still loading the full schedule. Try again in a moment' : undefined}
                              onClick={(e) => { e.stopPropagation(); openReschedule(job); }}>
                              Reschedule
                            </button>
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-muted">
                        {crew.length === 0 ? <span className={selectIsJobUnassignedActionable(state, job) ? 'sched-unassigned' : undefined}>Unassigned</span> : crewLine(crew)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {view === 'Week' && (
        <div className="week-grid">
          {weekJobs.map(({ date, jobs }) => {
            const dayIso = toIsoDay(date);
            const isDropTarget = dropTargetDay === dayIso;
            return (
              <div key={date.toISOString()}
                className={`week-col ${sameDay(date, new Date()) ? 'today' : ''} ${isDropTarget ? 'drag-over' : ''}`}
                onDragOver={(e) => onColDragOver(e, dayIso)}
                onDragLeave={onColDragLeave}
                onDrop={(e) => onColDrop(e, date)}
              >
                <div className="week-col-head">
                  <div className="text-xs text-muted">{fmtDate(date.toISOString(), { weekday: 'short' })}</div>
                  <div className="text-sm font-semi">{dayOfMonthKey(dayKey(date))}</div>
                </div>
                <div className="week-col-body">
                  {jobs.length === 0 ? (
                    <div className="text-xs text-muted" style={{ padding: 6 }}>—</div>
                  ) : jobs.map((j) => {
                    const client = selectClientById(state, j.clientId);
                    const hasConflict = weekConflictJobIds.has(j.id);
                    return (
                      <div key={j.id}
                        className={`week-card ${j.status} ${draggingId === j.id ? 'is-dragging' : ''} clickable`}
                        // Not draggable until the full set hydrates: a move can't be
                        // mirrored while !jobsReady and would be lost on refresh.
                        draggable={canCreate && jobsHydrated && j.status === 'upcoming'}
                        onDragStart={(e) => onWeekDragStart(e, j)}
                        onDragEnd={onWeekDragEnd}
                        onClick={() => navigate(`/schedule/${j.id}`, { state: nav })}
                      >
                        <div className="text-xs font-semi">
                          {fmtTimeRange(j.startAt, j.endAt)}
                          {j.seriesId && <Icon name="repeat" size={9} className="series-badge" />}
                          {hasConflict && <Icon name="warning" size={9} className="conflict-dot" />}
                        </div>
                        <div className="text-sm">{client?.name || '—'}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === 'Month' && (
        <div className="month-grid">
          {/* Header labels are derived from the first week's actual grid dates (the grid
              starts on startOfWeek() = Monday), so they can NEVER drift from where the grid
              starts. A hardcoded weekday order is what previously shifted every day one column
              off its true weekday. Don't reintroduce one. */}
          {monthGrid.slice(0, 7).map(({ date }) => (
            <div key={date.toISOString()} className="month-head">
              {fmtDate(date.toISOString(), { weekday: 'short' })}
            </div>
          ))}
          {monthGrid.map(({ date, sameMonth, jobs }) => (
            <div key={date.toISOString()}
              className={`month-cell ${!sameMonth ? 'muted' : ''} ${sameDay(date, new Date()) ? 'today' : ''}`}
              onClick={() => monthCellClick(date)}
              style={{ cursor: 'pointer' }}
            >
              <div className="month-cell-date">{dayOfMonthKey(dayKey(date))}</div>
              <div className="month-cell-jobs">
                {jobs.slice(0, 3).map((j) => {
                  const client = selectClientById(state, j.clientId);
                  return (
                    <div key={j.id} className={`month-job ${j.status}`}
                      onClick={(e) => { e.stopPropagation(); navigate(`/schedule/${j.id}`, { state: nav }); }}
                    >
                      {j.seriesId && <Icon name="repeat" size={8} className="series-badge" />}
                      {client?.name || '—'}
                    </div>
                  );
                })}
                {jobs.length > 3 && <div className="month-cell-more text-xs text-muted">+{jobs.length - 3} more</div>}
                {jobs.length > 0 && <span className="month-cell-count" aria-label={`${jobs.length} clean${jobs.length === 1 ? '' : 's'}`}>{jobs.length}</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'Cleaner' && (
        cleanerRows.length === 0 ? (viewLoad.ready && (
          <div className="card dash-card">
            <EmptyState icon={<Icon name="schedule" size={28} />} title="No assigned cleans in this window" message="Adjust the filters or pick a date range." />
          </div>
        )) : (
          <div className="sched-groups">
            {cleanerRows.map((row) => (
              row.unassigned ? (
                <div key="__unassigned__" className="card sched-group sched-group-unassigned">
                  <div className="sched-group-head">
                    <div className="sched-group-title sched-group-cleaner">
                      <span className="sched-unassigned-badge"><Icon name="warning" size={16} /></span>
                      <strong className="sched-unassigned">Unassigned — nobody scheduled</strong>
                    </div>
                    <div className="sched-group-meta">
                      <span>{row.jobs.length} clean{row.jobs.length === 1 ? '' : 's'}</span>
                      <span>{fmtMins(row.totalMinutes)} scheduled</span>
                    </div>
                  </div>
                  <div className="sched-rows">{row.jobs.map((job) => renderSchedRow(job))}</div>
                </div>
              ) : (
                <div key={row.user.id} className="card sched-group">
                  <div className="sched-group-head">
                    <div className="sched-group-title sched-group-cleaner">
                      <Avatar user={row.user} size="sm" />
                      <strong>{row.user.name}</strong>
                    </div>
                    <div className="sched-group-meta">
                      <span>{row.jobs.length} clean{row.jobs.length === 1 ? '' : 's'}</span>
                      <span>{fmtMins(row.totalMinutes)} scheduled</span>
                      {(() => {
                        const mins = weekClocked?.get(row.user.id)?.minutes;
                        if (!Number.isFinite(mins) || mins <= 0) return null;
                        const st = otStatus(mins);
                        const label = `${fmtMins(mins)} clocked this wk`;
                        if (st === 'over') return <Badge variant="red">{label} · OT</Badge>;
                        if (st === 'approaching') return <Badge variant="amber">{label} · nearing 40h</Badge>;
                        return <span>{label}</span>;
                      })()}
                    </div>
                  </div>
                  <div className="sched-rows">{row.jobs.map((job) => renderSchedRow(job, row.user.id))}</div>
                </div>
              )
            ))}
          </div>
        )
      )}

      <NewJobModal open={modalOpen} onClose={() => setModalOpen(false)} />
      {reschedule && (
        <NewJobModal
          open
          onClose={() => setReschedule(null)}
          mode="edit"
          initialData={reschedule.job}
          seriesScope={reschedule.scope}
        />
      )}
      <SeriesScopeModal
        open={!!seriesPrompt}
        intent="edit"
        disableFuture={!!seriesPrompt?.disableFuture}
        disableReason={seriesPrompt?.disableReason || null}
        onClose={() => setSeriesPrompt(null)}
        onPick={onSeriesScopePick}
      />
      <ConfirmDialog
        open={!!dropConflict}
        title="Scheduling conflict"
        confirmLabel="Reschedule anyway"
        cancelLabel="Keep as-is"
        onConfirm={commitDrop}
        onClose={() => setDropConflict(null)}
        message={dropConflict && (
          <>
            Moving this clean conflicts with:
            <ul className="conflict-list">
              {dropConflict.conflicts.map((c, i) => {
                if (c.timeOff) {
                  return (
                    <li key={i}>
                      {c.userName} has time off that day{c.timeOff.reason ? ` (${c.timeOff.reason})` : ''}
                    </li>
                  );
                }
                const cl = selectClientById(state, c.job.clientId);
                return (
                  <li key={i}>
                    {c.userName}. {cl?.name || 'another job'} {fmtTimeRange(c.job.startAt, c.job.endAt)}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      />
    </>
  );
}
