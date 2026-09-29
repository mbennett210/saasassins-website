// A crew member's whole day in one place: today's assigned cleans with inline
// clock-in/out, a running-timer banner while on the clock, expandable read-only
// service instructions, and a short upcoming list. Merges the former Clock hub +
// MySchedule page into one crew surface (Swept replacement, Phase 2 → IA
// consolidation). Clock state is a component-local projection (timeApi.mine),
// never the synced blob. See CLEANSPACE_SWEPT.md §5.2 + UI_RULES.md Rule 20.
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../components/Icon';
import StubRecoveryBanner from '../components/StubRecoveryBanner';
import EmptyState from '../components/EmptyState';
import CleaningAreasEditor from '../components/CleaningAreasEditor';
import AccountNotesPanel from '../components/AccountNotesPanel';
import CleanChecklist from '../components/CleanChecklist';
import ClockControl from '../components/ClockControl';
import MediaGallery from '../components/MediaGallery';
import { useFromHere } from '../hooks/useFromHere';
import { useSelector, shallowEqual } from '../store';
import { useAuth } from '../hooks/useAuth';
import {
  selectTodayCleansForUser, selectJobsForUser, selectClockContextForJob,
  selectSiteById, selectClientById, selectEffectiveExpectedCleanMins, selectCleaningAreasForSite,
  selectJobById,
} from '../store/selectors';
import * as timeApi from '../lib/timeApi';
import * as driveApi from '../lib/driveApi';
import { fmtTimeRange, fmtDate, fmtDuration, fmtTime, dayKey, addDaysKey, startOfDayKey } from '../lib/dates';

const UPCOMING_DAYS = 14;
const UPCOMING_CAP = 25;

// Effective per-clean state for the Today timeline. An OPEN punch (clocked in, no
// clock-out) means the crew is on the clock now; a CLOSED punch means done. With no
// punch we fall back to the job's own schedule status. Drives the rail node + the
// status chip. Kept in sync with ClockControl, which advances job.status on punch.
function cleanStatus(job, entry) {
  if (entry?.clock_out_at) return 'done';
  if (entry) return 'now';
  if (job.status === 'in_progress') return 'now';
  if (job.status === 'done') return 'done';
  if (job.status === 'missed') return 'missed';
  return 'upcoming';
}

// The gold "now" marker on the timeline — a live wall-clock label + a rule that
// sits between the last finished clean and the next one still to do.
function NowLine({ now }) {
  return (
    <div className="myday-tl-now" aria-hidden="true">
      <span className="myday-tl-now-label">Now {fmtTime(now)}</span>
      <span className="myday-tl-now-line" />
    </div>
  );
}

// ── §8 0.4: this page subscribes per-value, not to the whole snapshot ─────────
//
// MyDay is the CREW HOME SCREEN — 36 of 43 users live here, and the jobs realtime
// stream dispatches constantly. On useStore() every one of those dispatches re-rendered
// this whole tree, and the useMemo below was keyed on `state` so it never once helped:
// a new snapshot identity per dispatch meant the memo missed every time.
//
// The rule for the comparers, verified against each selector's RETURN value by
// scripts/test-selector-benefit.mjs rather than assumed:
//   selectSiteById / selectClientById        -> an existing element or null  -> Object.is
//   selectEffectiveExpectedCleanMins         -> a number                     -> Object.is
//   selectCleaningAreasForSite               -> the stored array or EMPTY_ARRAY -> Object.is
//   selectTodayCleansForUser / ForUser       -> .filter().sort(), FRESH       -> shallowEqual
//   selectClockContextForJob                 -> a built object, FRESH         -> shallowEqual
// An allocating selector with the default comparer re-renders on every dispatch, i.e.
// exactly the useStore() behaviour this is replacing — a migration that buys nothing.
//
// Every parameterised selector is wrapped in useCallback so its IDENTITY is stable;
// useSelector keys its cache on (snapshot, selector, isEqual), so an inline arrow
// rebuilt each render would miss the cache every time.

// Read-only service instructions for one clean (expected time + access + cleaning
// areas), shown inline when the crew expands a card.
function ServiceInstructions({ job }) {
  const site = useSelector(useCallback((s) => (job.siteId ? selectSiteById(s, job.siteId) : null), [job.siteId]));
  const client = useSelector(useCallback(
    (s) => (job.clientId ? selectClientById(s, job.clientId) : (job.siteId ? selectClientById(s, selectSiteById(s, job.siteId)?.clientId) : null)),
    [job.clientId, job.siteId],
  ));
  const expectedMins = useSelector(useCallback(
    (s) => selectEffectiveExpectedCleanMins(s, { clientId: client?.id, siteId: job.siteId }),
    [client?.id, job.siteId],
  ));
  // Access instructions are per-site (site.accessNotes). Mirrors JobDetail.
  const access = site?.accessNotes || '';
  const areas = useSelector(useCallback((s) => selectCleaningAreasForSite(s, job.siteId), [job.siteId]));
  return (
    <div className="myday-instructions">
      <dl className="detail-dl">
        <div><dt>Expected time</dt><dd>{expectedMins != null ? fmtDuration(expectedMins) : <span className="text-muted">Not set</span>}</dd></div>
        {access ? <div><dt>Access</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{access}</dd></div> : null}
      </dl>
      <AccountNotesPanel client={client} />
      {areas.length > 0
        ? <CleaningAreasEditor value={areas} readOnly />
        : <p className="text-muted text-xs">No cleaning instructions set for this site yet.</p>}
      {/* Manager-uploaded reference media (site-wide cleaning_instruction scope) —
          read-only, hidden when the site has none (CREW_AUDIT #18). */}
      {job.siteId && (
        <MediaGallery
          siteId={job.siteId}
          clientId={client?.id || null}
          scope="cleaning_instruction"
          label="Reference photos & video"
          hint={null}
          readOnly
          hideWhenEmpty
        />
      )}
    </div>
  );
}

// The mapped drive to the next clean. Appears on a FINISHED card once the crew
// clocks out and another clean at a different site is still ahead today. Just the
// number — deliberately says nothing about pay (Daniel, 2026-07-29): the office
// decides what a leg pays, and telling a cleaner "you're on paid drive time"
// invites pacing to the number. Renders beside ClockControl, never inside it
// (Rule 20 keeps that control dumb), and self-hides entirely when the route can't
// be estimated, so a failed lookup leaves no empty scaffolding behind.
function DriveHint({ fromSiteId, toSiteId }) {
  const sites = useSelector(useCallback((s) => s.sites, []));
  const [est, setEst] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const e = await driveApi.estimate({ fromSiteId, toSiteId, sites });
        if (alive) setEst(e);
      } catch { /* non-blocking — the card just carries no estimate */ }
    })();
    return () => { alive = false; };
  }, [fromSiteId, toSiteId, sites]);
  const mins = est?.durationMinutes;
  if (!Number.isFinite(mins)) return null;
  return (
    <div className="myday-drive-hint">
      <Icon name="schedule" size={14} />
      <span>Estimated time: {mins} {mins === 1 ? 'minute' : 'minutes'}</span>
    </div>
  );
}

// One of today's cleans: header (site → JobDetail + time/expected), the shared
// ClockControl + a Service-instructions toggle in the foot row, and the
// read-only instructions expanded inline.
function TodayCleanCard({ job, userId, entry, onChange, nextJob, isNext }) {
  const navigate = useNavigate();
  const nav = useFromHere();
  const [showInstructions, setShowInstructions] = useState(false);
  const [showPhotos, setShowPhotos] = useState(false);
  const site = useSelector(useCallback((s) => (job.siteId ? selectSiteById(s, job.siteId) : null), [job.siteId]));
  const client = useSelector(useCallback(
    (s) => (job.clientId ? selectClientById(s, job.clientId) : (job.siteId ? selectClientById(s, selectSiteById(s, job.siteId)?.clientId) : null)),
    [job.clientId, job.siteId],
  ));
  // Builds an object, so it needs shallowEqual — with the default comparer this alone
  // would re-render every card on every dispatch and undo the whole migration.
  const ctx = useSelector(useCallback((s) => selectClockContextForJob(s, job, userId), [job, userId]), shallowEqual);
  // One location per customer (S23 collapse): the customer name is the identity;
  // the site's generic name is not surfaced. Title = customer, sub = the address.
  const sub = site?.address || '';
  // The paid leg only exists once this clean is closed and the next one is
  // somewhere else — same-site back-to-back cleans aren't a drive.
  const showDrive = !!entry?.clock_out_at && !!nextJob?.siteId && !!job.siteId && nextJob.siteId !== job.siteId;

  const isOpen = !!entry && !entry.clock_out_at;
  const status = cleanStatus(job, entry);
  const timeParts = fmtTime(job.startAt).split(' ');   // org-zone "10:00 AM" → gutter h:mm + AM/PM
  const nodeClass = status === 'now' ? ' is-now' : status === 'done' ? ' is-done' : status === 'missed' ? ' is-missed' : '';
  const windowLabel = fmtTimeRange(job.startAt, job.endAt);

  // The whole card opens the clean's detail — crew tap it to see everything. A tap on
  // any inner control (the clock, the toggles, the checklist, or the expanded
  // instructions / photos) is left to that control, guarded by closest().
  const openDetail = (e) => {
    if (e.target.closest('button, a, input, textarea, select, label, [role="button"], .myday-tl-action, .myday-card-toggles, .myday-instructions, .myday-photos, .clean-checklist')) return;
    navigate(`/schedule/${job.id}`, { state: nav });
  };

  return (
    <div className="myday-tl-item">
      <div className="myday-tl-time">
        <span className="myday-tl-time-h">{timeParts[0]}</span>
        {timeParts[1] ? <span className="myday-tl-time-ap">{timeParts[1]}</span> : null}
      </div>
      <span className={`myday-tl-node${nodeClass}`} aria-hidden="true" />
      <div className={`card clock-card myday-tl-card myday-tl-card-click${status === 'now' ? ' is-now' : ''}`} onClick={openDetail}>
        <div className="myday-tl-head">
          <div className="myday-tl-headmain">
            <button className="btn btn-link myday-site" onClick={() => navigate(`/schedule/${job.id}`, { state: nav })}>
              {client?.name || site?.name || 'Clean'}
            </button>
            {sub ? <div className="text-muted text-sm">{sub}</div> : null}
          </div>
          {status === 'now' ? <span className="myday-chip myday-chip-now">Now</span>
            : status === 'done' ? <span className="myday-chip myday-chip-done">Done</span>
            : status === 'missed' ? <span className="myday-chip myday-chip-missed">Missed</span>
            : isNext ? <span className="myday-chip myday-chip-next">Next</span>
            : null}
        </div>

        {/* On-site (once clocked in) + the scheduled time window. */}
        <div className="myday-chips">
          {isOpen ? (
            <span className="myday-chip myday-chip-onsite"><Icon name="check" size={13} /> On site</span>
          ) : null}
          <span className="myday-chip myday-chip-time">{windowLabel}</span>
        </div>

        {/* The account's bound checklist for THIS clean — self-hides when none is set
            and none was ever completed here. Crew tick it and it stamps job_id. */}
        <CleanChecklist job={job} client={client} />

        {/* The clock action, sized for a gloved thumb (full-width bar). */}
        <div className="myday-tl-action">
          <ClockControl job={job} ctx={ctx} entry={entry} onChange={onChange} size="lg" />
        </div>

        <div className="myday-card-toggles">
          <button className="btn btn-link" onClick={() => setShowInstructions((v) => !v)} aria-expanded={showInstructions}>
            {showInstructions ? 'Hide instructions' : 'Service instructions'}
          </button>
          {job.siteId ? (
            <button className="btn btn-link" onClick={() => setShowPhotos((v) => !v)} aria-expanded={showPhotos}>
              {showPhotos ? 'Hide photos' : 'Photos'}
            </button>
          ) : (
            // Media is keyed by site — show the reason instead of silently hiding (#17).
            <button className="btn btn-link" disabled title="Set a site on this clean to attach photos">
              Photos
            </button>
          )}
        </div>

        {showDrive && <DriveHint fromSiteId={job.siteId} toSiteId={nextJob.siteId} />}
        {showInstructions && <ServiceInstructions job={job} />}
        {showPhotos && job.siteId && (
          <div className="myday-photos">
            <MediaGallery
              siteId={job.siteId}
              clientId={job.clientId || site?.clientId || null}
              scope="clean"
              refId={job.id}
              label="Before / after photos"
              hint="Snap before/after shots of this clean. Tap Upload and choose Camera. Images up to 10MB, video up to 200MB."
            />
          </div>
        )}
      </div>
    </div>
  );
}

// One row of the Upcoming list. Extracted from an inline .map so it can resolve its own
// site/client through useSelector — otherwise the parent would still need the whole
// snapshot just to render these two labels, which is what the migration is removing.
function UpcomingItem({ job, onOpen }) {
  const site = useSelector(useCallback((s) => (job.siteId ? selectSiteById(s, job.siteId) : null), [job.siteId]));
  const client = useSelector(useCallback(
    (s) => (job.clientId ? selectClientById(s, job.clientId) : (job.siteId ? selectClientById(s, selectSiteById(s, job.siteId)?.clientId) : null)),
    [job.clientId, job.siteId],
  ));
  return (
    <button className="myday-upcoming-item" onClick={onOpen}>
      <div>
        <div className="myday-upcoming-site">{client?.name || site?.name || '—'}</div>
        <div className="text-muted text-xs">{fmtDate(job.startAt)} · {fmtTimeRange(job.startAt, job.endAt)}</div>
      </div>
      <Icon name="chevronRight" size={16} />
    </button>
  );
}

// An OPEN shift that isn't one of today's cleans (a clean that ran past midnight,
// or a forgotten clock-out). Renders just enough to identify it and a Clock-out
// button — the crew must be able to close any open shift regardless of the day.
function CarryoverClockCard({ entry, onChange }) {
  const navigate = useNavigate();
  const nav = useFromHere();
  const job = useSelector(useCallback((s) => (entry.job_id ? selectJobById(s, entry.job_id) : null), [entry.job_id]));
  const mins = Math.max(0, Math.round((Date.now() - new Date(entry.clock_in_at).getTime()) / 60000));
  const title = entry.client_name || entry.site_name || 'Clean';
  return (
    <div className="card clock-card">
      <div className="clock-card-head">
        <div>
          {job ? (
            <button className="btn btn-link myday-site" onClick={() => navigate(`/schedule/${job.id}`, { state: nav })}>{title}</button>
          ) : <strong className="myday-site">{title}</strong>}
          <div className="text-muted text-sm">
            Clocked in {fmtDate(entry.clock_in_at, { weekday: 'short', month: 'short', day: 'numeric' })} · in since {fmtTime(entry.clock_in_at)} · {fmtDuration(mins)} elapsed
          </div>
        </div>
      </div>
      <div className="clock-card-foot">
        <ClockControl job={job} ctx={null} entry={entry} onChange={onChange} />
      </div>
    </div>
  );
}

export default function MyDay() {
  const navigate = useNavigate();
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const userId = currentUser?.id;

  const [entries, setEntries] = useState(null); // null = loading
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  // Buffered offline clock punches not yet synced to the server (0/0 in stub mode).
  const [pending, setPending] = useState({ unsynced: 0, failed: 0 });

  const load = useCallback(async () => {
    if (!userId) return;
    setError(null);
    try {
      const [entriesResult, total, unsynced] = await Promise.all([
        // No sinceIso: an OPEN punch from a shift that crossed midnight must come
        // back so the crew can always clock out (overnight cleans). listMine unions
        // ALL still-open rows on top of the recent window, so a forgotten/overnight
        // open shift is always returned even if newer punches have buried it.
        timeApi.mine({ userId }),
        timeApi.pendingPunchCount({ includeFailed: true }),
        timeApi.pendingPunchCount(),
      ]);
      setEntries(entriesResult);
      setPending({ unsynced, failed: Math.max(0, total - unsynced) });
    } catch (e) {
      setError(e.message || 'Could not load your clock status.');
    }
  }, [userId]);
  useEffect(() => { load(); }, [load]);

  // Refresh clock state when buffered offline punches sync (their synthesized ids are
  // swapped for real server rows) or when the network returns.
  useEffect(() => {
    const onFlushed = () => load();
    window.addEventListener('cleanspace:time-queue-flushed', onFlushed);
    window.addEventListener('online', onFlushed);
    return () => {
      window.removeEventListener('cleanspace:time-queue-flushed', onFlushed);
      window.removeEventListener('online', onFlushed);
    };
  }, [load]);

  // Live tick for the running-timer banner (30s — minute-resolution display).
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  // shallowEqual on both: each ends in .filter()/.sort(), so the default Object.is would
  // never match and this page would re-render on every dispatch — the exact useStore()
  // behaviour being replaced. shallowEqual compares the job objects by reference, and
  // those keep identity across dispatches that do not touch them.
  //
  // `now` ticks every 30s for the running-timer banner, which changes the selector
  // identity. That is fine: the cache still runs isEqual across snapshots, so an
  // unchanged list returns the previous reference and no re-render follows.
  const cleans = useSelector(
    useCallback((s) => selectTodayCleansForUser(s, userId, now), [userId, now]),
    shallowEqual,
  );
  const upcoming = useSelector(
    useCallback((s) => {
      // Tomorrow through the next UPCOMING_DAYS, on the ORG's calendar — the crew's
      // "today" (above) and "upcoming" must split on the same org midnight.
      const todayK = dayKey(now);
      const from = startOfDayKey(addDaysKey(todayK, 1)).getTime();
      const to = startOfDayKey(addDaysKey(todayK, 1 + UPCOMING_DAYS)).getTime();
      return selectJobsForUser(s, userId)
        .filter((j) => {
          const t = new Date(j.startAt).getTime();
          return Number.isFinite(t) && t >= from && t < to && j.status !== 'cancelled';
        })
        .sort((a, b) => a.startAt.localeCompare(b.startAt))
        .slice(0, UPCOMING_CAP);
    }, [userId, now]),
    shallowEqual,
  );

  const entryByJob = useMemo(() => {
    const map = new Map();
    for (const e of entries || []) {
      const ex = map.get(e.job_id);
      if (!ex || (!e.clock_out_at && ex.clock_out_at) || new Date(e.clock_in_at) > new Date(ex.clock_in_at)) map.set(e.job_id, e);
    }
    return map;
  }, [entries]);

  const openEntry = useMemo(() => (entries || []).find((e) => !e.clock_out_at) || null, [entries]);
  const openMinutes = openEntry ? Math.max(0, Math.round((now - new Date(openEntry.clock_in_at).getTime()) / 60000)) : null;

  // OPEN shifts that aren't in today's list — a clean that started yesterday and
  // ran past midnight, or a forgotten clock-out. They must always be clock-out-able,
  // so they get their own "Still clocked in" section rather than vanishing at 00:00.
  const todayJobIds = useMemo(() => new Set(cleans.map((j) => j.id)), [cleans]);
  const carryoverOpen = useMemo(
    () => (entries || []).filter((e) => !e.clock_out_at && !todayJobIds.has(e.job_id)),
    [entries, todayJobIds],
  );

  // Timeline derivations (Direction B): which clean is "Next", where the gold now-line
  // sits (above the first clean not yet finished), and the scheduled on-site total
  // shown beside the Today head.
  const nextIndex = useMemo(
    () => cleans.findIndex((j) => cleanStatus(j, entryByJob.get(j.id) || null) === 'upcoming'),
    [cleans, entryByJob],
  );
  const nowLineIndex = useMemo(() => {
    const i = cleans.findIndex((j) => cleanStatus(j, entryByJob.get(j.id) || null) !== 'done');
    return i === -1 ? cleans.length : i;
  }, [cleans, entryByJob]);
  const todayTotalMin = useMemo(
    () => cleans.reduce((a, j) => {
      const m = (new Date(j.endAt).getTime() - new Date(j.startAt).getTime()) / 60000;
      return a + (Number.isFinite(m) && m > 0 ? m : 0);
    }, 0),
    [cleans],
  );

  return (
    <div className="page page-narrow">
      <div className="page-head">
        <h1>My Day</h1>
        <p className="page-sub">Today’s cleans and your clock. You must be at the location to clock in.</p>
      </div>

      {openEntry && (
        <div className="clock-banner" role="status">
          <Icon name="schedule" size={18} />
          <div className="clock-banner-body">
            <div className="clock-banner-title">On the clock. {openEntry.client_name || openEntry.site_name || 'this location'}</div>
            <div className="clock-banner-time">{fmtDuration(openMinutes)} elapsed · in since {fmtTime(openEntry.clock_in_at)}</div>
          </div>
        </div>
      )}

      {/* Demo-period history stranded on this phone (Sept 1 recovery) */}
      <StubRecoveryBanner />

      {/* Buffered offline punches. FAILED (terminal) ones need a manager — they are
          kept on the device (never dropped) but can't auto-replay. Unsynced ones just
          wait for connectivity. Both self-hide at 0 and refresh on flush/online/clock. */}
      {pending.failed > 0 && (
        <div className="card" role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', marginBottom: 12 }}>
          <Icon name="warning" size={16} />
          <span className="text-sm" style={{ color: 'var(--danger)' }}>
            {pending.failed} clock {pending.failed === 1 ? 'punch' : 'punches'} couldn’t sync. Please tell your manager so your time is recorded.
          </span>
        </div>
      )}
      {pending.unsynced > 0 && (
        <div className="clock-banner" role="status" style={{ marginBottom: 12 }}>
          <Icon name="schedule" size={18} />
          <div className="clock-banner-body">
            <div className="clock-banner-title">{pending.unsynced} clock {pending.unsynced === 1 ? 'punch' : 'punches'} waiting to sync</div>
            <div className="clock-banner-time">Saved on this device. They’ll sync automatically when you’re back online.</div>
          </div>
        </div>
      )}

      {carryoverOpen.length > 0 && (
        <>
          <div className="section-head"><h3>Still clocked in</h3></div>
          <div className="clock-list">
            {carryoverOpen.map((e) => (
              <CarryoverClockCard key={e.id} entry={e} onChange={load} />
            ))}
          </div>
        </>
      )}

      <div className="section-head myday-today-head">
        <h3>Today</h3>
        {cleans.length > 0 && (
          <span className="myday-daymeta">
            {cleans.length} {cleans.length === 1 ? 'clean' : 'cleans'}
            {todayTotalMin > 0 ? ` · ${fmtDuration(todayTotalMin)}` : ''}
          </span>
        )}
      </div>
      {/* Clock-status fetch failure is NON-blocking: the cleans list comes from the
          local store and stays fully usable. A transient signal drop in the field
          must never read as "no work today" (CREW_AUDIT #3). Only clock state
          (running timers / clocked-in badges) is degraded until Retry succeeds. */}
      {error && (
        <div className="card" role="alert" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 16px', marginBottom: 12 }}>
          <span className="text-sm" style={{ color: 'var(--danger)' }}>{error} Your cleans are still listed below.</span>
          <button className="btn btn-outline" onClick={load}>Retry</button>
        </div>
      )}
      {entries === null && !error ? (
        <div className="card" style={{ padding: 24 }}>Loading…</div>
      ) : cleans.length === 0 ? (
        <EmptyState icon={<Icon name="schedule" size={28} />} title="Nothing scheduled today" message="When you’re assigned a clean for today, it shows here with a clock-in button." />
      ) : (
        <div className="myday-tl">
          {cleans.map((job, i) => (
            <Fragment key={job.id}>
              {nowLineIndex === i && <NowLine now={now} />}
              <TodayCleanCard
                job={job} userId={userId}
                entry={entryByJob.get(job.id) || null} onChange={load}
                nextJob={cleans[i + 1] || null}
                isNext={i === nextIndex}
              />
            </Fragment>
          ))}
          {nowLineIndex === cleans.length && <NowLine now={now} />}
        </div>
      )}

      <div className="section-head" style={{ marginTop: 24 }}><h3>Upcoming</h3></div>
      {upcoming.length === 0 ? (
        <p className="text-muted text-sm" style={{ padding: '4px 2px' }}>No upcoming cleans in the next {UPCOMING_DAYS} days.</p>
      ) : (
        <div className="myday-upcoming">
          {upcoming.map((job) => (
            <UpcomingItem
              key={job.id}
              job={job}
              onOpen={() => navigate(`/schedule/${job.id}`, { state: nav })}
            />
          ))}
        </div>
      )}
    </div>
  );
}
