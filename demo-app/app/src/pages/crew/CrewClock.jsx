// Clock In / Clock Out (`/my-day/clock/:jobId`) — the Cleaner Hub's ClockIn and ClockOut boards
// (Matt, 2026-10-13; plan docs/plans/2026-10-13-cleaner-hub.md, brief A §4). ONE screen per clean:
// it is Clock In until the cleaner is on the clock there, then Clock Out, then a short summary.
//
// It draws hooks/useClockActions — the ONE clock, the same one components/ClockControl draws — so
// the window (CS-052), the booked-off ask (CS-693), the checklist lock (R4-R6, UI_RULES §131), the
// double punch, the 409 / 503 answers and the toasts are written once.
//
//   🔴 D1 / PAY-17 (Matt, 2026-09-30; Daniel 2026-10-13 "Keep Sept 30 rule"): outside the ring the
//   Clock In button STAYS LIVE. The punch is recorded, held until the account manager approves it,
//   and the manager is alerted. Matt's board drew "Clock In — locked"; that is not built.
//   D9: the Before / After photos sit on the Clock Out screen (and stay on the clean's page), so the
//   customer hub's visit photos keep arriving.
//   D8: in the owner's View-as a cleaner every write control is off (the server would record the
//   owner); the shell's one line says so.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import MediaGallery from '../../components/MediaGallery';
import EmptyState from '../../components/EmptyState';
import { ClockTimeOffDialog } from '../../components/ClockControl';
import { CrewPageHead } from '../../components/CrewChrome';
import { useFromHere } from '../../hooks/useFromHere';
import { useAuth } from '../../hooks/useAuth';
import { useCrewPreview } from '../../hooks/useCrewPreview';
import { useClockActions } from '../../hooks/useClockActions';
import { useGeoPresence } from '../../hooks/useGeoPresence';
import { useCrewPunches, useNowTick, useCrewDay } from '../../hooks/useCrewDay';
import { useSelector, useJobsLoader, shallowEqual } from '../../store';
import { selectJobById, selectSiteById, selectClientById, selectClockContextForJob } from '../../store/selectors';
import * as driveApi from '../../lib/driveApi';
import { drivePayEnabled } from '../../lib/driveTime';
import { crewPaths } from '../../lib/crewPaths';
import { checklistFor, GATE } from '../../lib/crewChecklist';
import { punchByJob, checklistProgress, PRESENCE } from '../../lib/crewHome';
import { crewAutoCloseNoteKey } from '../../lib/autoClose';
import { fmtTime, fmtDuration, fmtDate } from '../../lib/dates';
import { useT } from '../../i18n/react';

const clientOfJob = (s, job) => (job
  ? (job.clientId ? selectClientById(s, job.clientId) : (job.siteId ? selectClientById(s, selectSiteById(s, job.siteId)?.clientId) : null))
  : null);

// The mapped drive to the next clean, under "Next stop". Just the number — deliberately says
// nothing about pay (Daniel, 2026-07-29): the office decides what a leg pays. 🔴 PAY-21: with drive
// time switched OFF the whole surface goes (lib/driveTime drivePayEnabled, the predicate Variance,
// Reports, Operations and the pay run share). Self-hides when the route can't be estimated.
function DriveHint({ fromSiteId, toSiteId }) {
  const t = useT();
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
    <span className="crew-clock-drive">
      <Icon name="schedule" size={14} /> {t('myDay.driveEstimate', { count: mins })}
    </span>
  );
}

// Where the phone is against the clean's ring (CSS only): the building at the centre, the phone a
// dot — near the middle inside, on the edge outside. Nothing for a location with no ring.
function Ring({ presence }) {
  const tone = presence.state === PRESENCE.INSIDE ? 'is-inside' : presence.state === PRESENCE.OUTSIDE ? 'is-outside' : 'is-unknown';
  return (
    <div className={`crew-clock-ring ${tone}`} aria-hidden="true">
      <span className="crew-clock-ring-centre"><Icon name="building" size={24} /></span>
      {presence.state !== PRESENCE.UNKNOWN && <span className="crew-clock-ring-dot" />}
    </div>
  );
}

// The perimeter line under the ring / at the top of Clock Out.
function PerimeterStatus({ presence }) {
  const t = useT();
  if (presence.state === PRESENCE.NO_CENTRE || presence.state === PRESENCE.OFF) return null;
  const [tone, icon, key] = presence.state === PRESENCE.INSIDE ? ['is-ok', 'mapPin', 'crewStops.line.inside']
    : presence.state === PRESENCE.OUTSIDE ? ['is-held', 'warning', 'crewClock.status.outside']
      : presence.locating ? ['is-quiet', 'mapPin', 'crewStops.line.locating'] : ['is-held', 'warning', 'crewClock.status.unknown'];
  return (
    <p className={`crew-clock-status ${tone}`} role="status">
      <Icon name={icon} size={18} /> <span>{t(key)}</span>
    </p>
  );
}

// The next clean today after this one (the one to go to once this one is done).
function useNextStop(job, userId, now) {
  const { cleans } = useCrewDay(userId, now);
  return useMemo(() => {
    if (!job) return null;
    const start = Date.parse(job.startAt);
    return cleans.find((j) => j.id !== job.id && j.status !== 'done' && j.status !== 'cancelled' && Date.parse(j.startAt) >= start) || null;
  }, [cleans, job]);
}

// The clean's Before / After photos (plan D9: the customer hub's visit page reads them), the visit's
// own two galleries (scope `clean`, the job's id, the phase as the area). Read-only in the preview.
function CleanPhotos({ job, site, readOnly }) {
  const t = useT();
  if (!job?.siteId) return null;
  return (
    <section className="crew-clock-photos">
      <MediaGallery
        siteId={job.siteId}
        clientId={job.clientId || site?.clientId || null}
        scope="clean"
        refId={job.id}
        areaId="before"
        label={t('visit.step.before')}
        hint={t('visit.beforeHint')}
        readOnly={readOnly}
      />
      <MediaGallery
        siteId={job.siteId}
        clientId={job.clientId || site?.clientId || null}
        scope="clean"
        refId={job.id}
        areaId="after"
        label={t('visit.step.after')}
        hint={t('visit.afterHint')}
        readOnly={readOnly}
      />
    </section>
  );
}

function NextStop({ job, next }) {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const name = useSelector(useCallback((s) => (next ? clientOfJob(s, next)?.name || (next.siteId ? selectSiteById(s, next.siteId)?.name : null) : null), [next]));
  const payDrive = useSelector(useCallback((s) => drivePayEnabled(s.opsSettings || {}), []));
  if (!next) return null;
  const showDrive = payDrive && !!job?.siteId && !!next.siteId && next.siteId !== job.siteId;
  return (
    <button type="button" className="card crew-clock-next" onClick={() => navigate(crewPaths.clock(next.id), { state: nav })}>
      <Icon name="chevronRight" size={18} />
      <span className="crew-clock-next-text">
        <span className="crew-clock-next-cap">{t('crewClock.nextStop')}</span>
        <span className="crew-clock-next-name">{t('crewClock.nextStopLine', { place: name || t('myDay.cleanFallback'), time: fmtTime(next.startAt) })}</span>
        {showDrive && <DriveHint fromSiteId={job.siteId} toSiteId={next.siteId} />}
      </span>
    </button>
  );
}

export default function CrewClock() {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const { jobId } = useParams();
  const { currentUser } = useAuth();
  const userId = currentUser?.id || null;
  const { previewing } = useCrewPreview();
  const now = useNowTick();
  const { entries, load } = useCrewPunches(userId);

  // The clean — from the store's window, or asked for by id (a link into a clean outside it).
  const job = useSelector(useCallback((s) => selectJobById(s, jobId), [jobId]));
  const jobsLoader = useJobsLoader();
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (job || !jobId) return undefined;
    let alive = true;
    jobsLoader.ensureIds([jobId]).then(() => { if (alive) setAsked(true); }, () => { if (alive) setAsked(true); });
    return () => { alive = false; };
  }, [job, jobId, jobsLoader]);

  const client = useSelector(useCallback((s) => clientOfJob(s, job), [job]));
  const site = useSelector(useCallback((s) => (job?.siteId ? selectSiteById(s, job.siteId) : null), [job?.siteId]));
  const ctx = useSelector(useCallback((s) => (job ? selectClockContextForJob(s, job, userId) : null), [job, userId]), shallowEqual);
  const entry = useMemo(() => (entries ? punchByJob(entries).get(jobId) || null : null), [entries, jobId]);
  const presence = useGeoPresence(job);
  const checklistId = job && client && userId ? checklistFor({ client, job, userId }) : null;
  const next = useNextStop(job, userId, now);

  const actions = useClockActions({
    job, ctx, entry, onChange: load,
    // After a clock-in: the checklist when the cleaner has one here, else Home.
    onClockedIn: () => navigate(checklistId ? crewPaths.checklist(job.id) : crewPaths.home(), { state: nav }),
  });
  const {
    isOpen, isDone, busy, windowRefusal, opensAtText, askOff, setAskOff, startClockIn, doClockIn,
    finishClockOut, gate, draft, saveError, outState, clockOutLocked,
  } = actions;

  const place = client?.name || site?.name || entry?.client_name || t('myDay.cleanFallback');
  const shift = job ? t('crewClock.sub', { place, time: fmtTime(job.startAt) })
    : (entry ? t('myDay.carryoverMeta', { day: fmtDate(entry.clock_in_at, { weekday: 'short', month: 'short', day: 'numeric' }), time: fmtTime(entry.clock_in_at), duration: fmtDuration(Math.max(0, Math.round((now - Date.parse(entry.clock_in_at)) / 60000))) }) : null);

  // 🔴 A punch is always closable (overnight / forgotten shifts): an open punch on a clean the
  // phone cannot find any more still gets its Clock out, from the punch alone (the server resolves
  // the site from the entry's job). Only with no clean AND no punch is there nothing to show.
  if (!job && !entry) {
    return (
      <div className="crew-clock">
        <CrewPageHead title={t('clock.in')} />
        {asked && entries !== null ? (
          <EmptyState
            icon={<Icon name="schedule" size={28} />}
            title={t('crewClock.notFound.title')}
            message={t('crewClock.notFound.body')}
            action={<button type="button" className="btn btn-primary crew-shell-tap" onClick={() => navigate(crewPaths.stops(), { state: nav })}>{t('crewClock.seeStops')}</button>}
          />
        ) : <div className="card crew-clock-card">{t('common.loading')}</div>}
      </div>
    );
  }

  // ── done: the punch is closed ───────────────────────────────────────────────────────────────
  if (isDone) {
    const autoNoteKey = crewAutoCloseNoteKey(entry);
    return (
      <div className="crew-clock">
        <CrewPageHead title={t('crewClock.done.title')} sub={shift} />
        <div className="card crew-clock-card crew-clock-done" role="status">
          <span className="crew-clock-done-icon" aria-hidden="true"><Icon name="check" size={22} /></span>
          <div>
            <p className="crew-clock-done-line">{t.rich('clock.doneSummary', { duration: fmtDuration(entry.duration_minutes) })}</p>
            <p className="text-muted text-sm">{fmtTime(entry.clock_in_at)}–{fmtTime(entry.clock_out_at)}{entry.pending_sync ? ` ${t('clock.willSync')}` : ''}</p>
            {autoNoteKey && <p className="crew-stop-note text-xs" role="note">{t(autoNoteKey, { time: fmtTime(entry.clock_out_at) })}</p>}
          </div>
        </div>
        <CleanPhotos job={job} site={site} readOnly={previewing} />
        <NextStop job={job} next={next} />
        <button type="button" className="btn btn-outline crew-shell-tap crew-clock-wide" onClick={() => navigate(crewPaths.home())}>
          {t('crewClock.backHome')}
        </button>
      </div>
    );
  }

  // ── Clock Out ───────────────────────────────────────────────────────────────────────────────
  if (isOpen) {
    const mins = Math.max(0, Math.round((now - Date.parse(entry.clock_in_at)) / 60000));
    // The checklist's progress: the stored submission, else the unsaved draft on the phone (counted
    // by the page's own rule, lib/crewHome checklistProgress).
    const progress = checklistProgress({ gate, draft });
    const total = progress?.total || 0;
    const doneCount = progress?.done || 0;
    const left = Math.max(0, total - doneCount);
    const showChecklist = gate && gate.state !== GATE.NONE && gate.state !== GATE.OFF;
    return (
      <div className="crew-clock">
        <CrewPageHead title={t('clock.out')} sub={shift} />
        <PerimeterStatus presence={presence} />
        {presence.state === PRESENCE.OUTSIDE && <p className="crew-clock-body">{t('crewClock.outsideOutBody', { place })}</p>}

        {showChecklist && (
          (gate.state === GATE.DONE || progress?.ready) ? (
            <div className="card crew-clock-card crew-clock-check is-done" role="status">
              <span className="crew-clock-check-icon" aria-hidden="true"><Icon name="check" size={22} /></span>
              <div>
                <p className="crew-clock-check-title">{t('crewClock.checklistDone', { count: total })}</p>
                <p className="text-muted text-sm">{progress?.ready ? t('crewClock.draftReady') : t('crewClock.clearToGo')}</p>
              </div>
            </div>
          ) : (
            <div className="card crew-clock-card crew-clock-check is-locked" role="status">
              <span className="crew-clock-check-icon" aria-hidden="true"><Icon name="lock" size={22} /></span>
              <div className="crew-clock-check-main">
                <p className="crew-clock-check-title">
                  {total > 0 && left > 0 ? t('crewClock.checklistLeft', { count: left }) : t('crewClock.checklistNotStarted')}
                </p>
                {outState.hint && <p className="text-muted text-sm">{t(outState.hint)}</p>}
                {total > 0 && (
                  <div className="crew-stop-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={doneCount}>
                    <span className="crew-stop-bar-fill" style={{ width: `${Math.round((doneCount / total) * 100)}%` }} />
                  </div>
                )}
                <button type="button" className="btn btn-gold crew-shell-tap" onClick={() => navigate(crewPaths.checklist(jobId), { state: nav })}>
                  {t('clock.openChecklist')}
                </button>
              </div>
            </div>
          )
        )}

        <section className="card crew-clock-card crew-clock-summary">
          <h2 className="crew-clock-summary-title">{t('crewClock.summary')}</h2>
          <dl>
            <div><dt>{t('crewClock.clockedIn')}</dt><dd>{fmtTime(entry.clock_in_at)}</dd></div>
            <div><dt>{t('crewClock.clockingOut')}</dt><dd>{fmtTime(new Date(now).toISOString())}</dd></div>
            <div><dt>{t('crewClock.timeOnSite')}</dt><dd className="is-strong">{fmtDuration(mins)}</dd></div>
          </dl>
          {entry.pending_sync && <p className="text-muted text-xs">{t('clock.willSyncTitle')}</p>}
        </section>

        <button
          type="button"
          className="btn btn-primary crew-shell-tap crew-clock-wide crew-clock-go"
          disabled={busy || clockOutLocked || previewing}
          onClick={finishClockOut}
        >
          {clockOutLocked && <Icon name="lock" size={18} />} {t(outState.label)}
        </button>
        {saveError && <p className="crew-clock-why crew-clock-error text-sm" role="alert">{saveError}</p>}

        {/* D9: the Before / After photos, under the action (Matt's board puts the button right after
            the summary); they stay open after the clock-out too, below. */}
        <CleanPhotos job={job} site={site} readOnly={previewing} />
        <NextStop job={job} next={next} />
      </div>
    );
  }

  // ── Clock In ────────────────────────────────────────────────────────────────────────────────
  const ringShown = presence.state === PRESENCE.INSIDE || presence.state === PRESENCE.OUTSIDE || presence.state === PRESENCE.UNKNOWN;
  const held = presence.state === PRESENCE.OUTSIDE || (presence.state === PRESENCE.UNKNOWN && !presence.locating);
  const body = presence.state === PRESENCE.INSIDE ? t('crewClock.insideBody')
    : presence.state === PRESENCE.OUTSIDE ? t('crewClock.outsideBody', { place })
      : presence.state === PRESENCE.UNKNOWN && !presence.locating ? t('crewClock.unknownBody')
        : presence.state === PRESENCE.NO_CENTRE ? t('crewClock.noRing') : null;
  return (
    <div className="crew-clock">
      <CrewPageHead title={t('clock.in')} sub={shift} />
      {site?.address && (
        <p className="crew-clock-where">
          <Icon name="mapPin" size={16} /> <span className="user-select-text">{site.address}</span>
        </p>
      )}
      {ringShown && <Ring presence={presence} />}
      <PerimeterStatus presence={presence} />
      {body && <p className="crew-clock-body">{body}</p>}

      {windowRefusal ? (
        <>
          <button type="button" className="btn btn-primary crew-shell-tap crew-clock-wide crew-clock-go" disabled>
            <Icon name="clock" size={18} /> {t('clock.in')}
          </button>
          <p className="crew-clock-why text-sm" role="status">
            {windowRefusal === 'early' ? t('clock.window.opensAt', { time: opensAtText }) : t('clock.window.closed')}
          </p>
        </>
      ) : (
        <button
          type="button"
          className={`btn crew-shell-tap crew-clock-wide crew-clock-go ${held ? 'btn-gold' : 'btn-primary'}`}
          disabled={busy || previewing}
          onClick={startClockIn}
        >
          <Icon name="clock" size={18} /> {busy ? t('clock.locating') : t('clock.in')}
        </button>
      )}
      <ClockTimeOffDialog askOff={askOff} setAskOff={setAskOff} doClockIn={doClockIn} />

      {checklistId && (
        <div className="card crew-clock-card crew-clock-note">
          <Icon name="lock" size={18} />
          <span className="text-sm">{t('crewClock.checklistAfterIn')}</span>
          <button type="button" className="btn btn-link" onClick={() => navigate(crewPaths.checklist(job.id), { state: nav })}>
            {t('crewStops.previewChecklist')}
          </button>
        </div>
      )}
    </div>
  );
}
