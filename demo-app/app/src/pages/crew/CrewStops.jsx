// My Stops Today (`/my-day/stops`) — the Cleaner Hub's Stops board (Matt, 2026-10-13; plan
// docs/plans/2026-10-13-cleaner-hub.md, brief A §3). A card per clean today, in the order a cleaner
// works them (lib/crewHome stopRows: an open punch first — last night's carryover first of all —
// then what is still to do by time, then what is done), and the next fortnight under them.
//
// Each card: the place, its state, its time; where the cleaner is (the phone's live read before the
// punch, the SERVER's verdict after it — PAY-17: outside the ring the time is HELD for approval,
// never locked, D1); the checklist's progress; View / Preview checklist and Clock in / Clock out;
// "Details" → the clean's page (instructions, door codes, photos) with its referrer; the
// building's supplies line. Every word is a catalog line (CS-193); every path is lib/crewPaths.
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Icon from '../../components/Icon';
import EmptyState from '../../components/EmptyState';
import CrewSupplyNote from '../../components/CrewSupplyNote';
import { CrewPageHead } from '../../components/CrewChrome';
import { useFromHere } from '../../hooks/useFromHere';
import { useOnMyWay } from '../../hooks/useOnMyWay';
import { useCrewPreview } from '../../hooks/useCrewPreview';
import { useToast } from '../../components/Toast';
import { useAuth } from '../../hooks/useAuth';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { useOnsiteSupplies } from '../../hooks/useOnsiteSupplies';
import { useClockOutGate } from '../../hooks/useCleanChecklist';
import { useGeoPresence } from '../../hooks/useGeoPresence';
import { useCrewPunches, useNowTick, useCrewDay, UPCOMING_DAYS } from '../../hooks/useCrewDay';
import { useSelector, shallowEqual } from '../../store';
import { selectSiteById, selectClientById, selectJobById } from '../../store/selectors';
import { crewPaths } from '../../lib/crewPaths';
import { checklistFor, GATE } from '../../lib/crewChecklist';
import { stopRows, siteLine, STOP, SITE_LINE_KEYS, SITE_LINE_TONE } from '../../lib/crewHome';
import { fmtTimeRange, fmtDate, fmtTime, fmtDuration } from '../../lib/dates';
import { crewAutoCloseNoteKey } from '../../lib/autoClose';
import { useT } from '../../i18n/react';

const clientOfJob = (s, job) => (job
  ? (job.clientId ? selectClientById(s, job.clientId) : (job.siteId ? selectClientById(s, selectSiteById(s, job.siteId)?.clientId) : null))
  : null);

function StateChip({ state, carryover = false }) {
  const t = useT();
  const key = carryover ? 'myDay.stillClockedIn'
    : state === STOP.NOW ? 'crewStops.state.inProgress'
    : state === STOP.DONE ? 'myDay.chip.done'
      : state === STOP.MISSED ? 'myDay.chip.missed'
        : 'crewStops.state.upcoming';
  return <span className={`crew-stop-chip is-${state}`}>{t(key)}</span>;
}

// Where the cleaner is, for one stop: the server's verdict on their punch, else the live read.
function SiteLine({ job, entry, live }) {
  const t = useT();
  const presence = useGeoPresence(live ? job : null);
  const line = siteLine({ entry, presence: live ? presence : null });
  if (!line) return null;
  const key = presence.locating && !entry ? 'crewStops.line.locating' : SITE_LINE_KEYS[line];
  return (
    <p className={`crew-stop-line ${SITE_LINE_TONE[line] || ''}`}>
      <Icon name="mapPin" size={15} /> <span>{t(key)}</span>
    </p>
  );
}

// The checklist's progress for THIS cleaner on this clean: the shared gate (hooks/useCleanChecklist),
// on their punch or — not clocked in yet — as it would be.
function ChecklistProgress({ gate, hasChecklist }) {
  const t = useT();
  if (!hasChecklist) {
    return (
      <div className="crew-stop-progress is-none">
        <span>{t('crewStops.checklist')}</span><span>{t('crewStops.noChecklist')}</span>
      </div>
    );
  }
  const total = gate?.total || 0;
  const done = gate?.state === GATE.DONE ? total : Math.min(gate?.done || 0, total);
  const started = total > 0;
  return (
    <div className="crew-stop-progress">
      <div className="crew-stop-progress-row">
        <span>{t('crewStops.checklist')}</span>
        <span className={started ? 'is-started' : ''}>{started ? t('crewStops.checklistProgress', { done, total }) : t('crewStops.notStarted')}</span>
      </div>
      <div className="crew-stop-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total || 1} aria-valuenow={started ? done : 0}>
        <span className="crew-stop-bar-fill" style={{ width: `${started ? Math.round((done / total) * 100) : 0}%` }} />
      </div>
    </div>
  );
}

// "On my way": tells the customer the crew is heading there (Crew on the way, lib/crewOnTheWay.js):
// a notice in their hub's bell, an alert on their phones, and Matt's approved text. Only on a stop
// still to do, only when someone there can be told (useOnMyWay canTell), once per clean (then it
// says so); off in the owner's View-as (D8) and offline.
function OnMyWay({ jobId, job, name, onMyWay, disabled }) {
  const t = useT();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (onMyWay.sent.has(jobId)) {
    return <p className="crew-stop-line is-quiet"><Icon name="check" size={15} /> <span>{t('crewStops.onMyWaySent')}</span></p>;
  }
  const go = async () => {
    setBusy(true);
    try {
      await onMyWay.send(jobId, job);
      toast.success(t('crewStops.onMyWayDone', { place: name }));
    } catch (e) {
      const code = e?.payload?.code;
      toast.error(t(code === 'nobody' ? 'crewStops.onMyWayNobody' : code === 'opted-out' ? 'crewStops.onMyWayOptedOut' : 'crewStops.onMyWayFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn btn-outline crew-shell-tap crew-stop-onmyway" disabled={disabled || busy} onClick={go}>
      <Icon name="messaging" size={16} /> {busy ? t('crewStops.onMyWaySending') : t('crewStops.onMyWay')}
    </button>
  );
}

function StopCard({ row, userId, supplies, online, onMyWay, previewing }) {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const { job, entry, state } = row;
  const client = useSelector(useCallback((s) => clientOfJob(s, job), [job]));
  const site = useSelector(useCallback((s) => (job?.siteId ? selectSiteById(s, job.siteId) : null), [job?.siteId]));
  const name = client?.name || site?.name || entry?.client_name || entry?.site_name || t('myDay.cleanFallback');
  const gateEntry = useMemo(() => (job ? (entry || { user_id: userId }) : null), [job, entry, userId]);
  const { gate } = useClockOutGate({ job: state === STOP.DONE ? null : job, entry: state === STOP.DONE ? null : gateEntry, online });
  const hasChecklist = !!(job && client && checklistFor({ client, job, userId }));
  const clockedIn = state === STOP.NOW;
  const jobId = row.jobId;
  const go = (to) => navigate(to, { state: nav });
  const autoNoteKey = state === STOP.DONE ? crewAutoCloseNoteKey(entry) : null;

  return (
    <article className={`card crew-stop-card is-${state}`}>
      <div className="crew-stop-top">
        <h2 className="crew-stop-name">{name}</h2>
        <StateChip state={state} carryover={row.carryover} />
      </div>
      {row.carryover ? (
        <p className="crew-stop-time">
          {t('myDay.carryoverMeta', {
            day: fmtDate(entry.clock_in_at, { weekday: 'short', month: 'short', day: 'numeric' }),
            time: fmtTime(entry.clock_in_at),
            duration: fmtDuration(Math.max(0, Math.round((Date.now() - Date.parse(entry.clock_in_at)) / 60000))),
          })}
        </p>
      ) : (
        job ? <p className="crew-stop-time">{fmtTimeRange(job.startAt, job.endAt)}</p> : null
      )}

      {state !== STOP.DONE && <SiteLine job={job} entry={clockedIn ? entry : null} live={!clockedIn} />}
      {state === STOP.DONE && entry?.clock_out_at && (
        <p className="crew-stop-line is-quiet">
          <Icon name="check" size={15} /> <span>{t.rich('clock.doneSummary', { duration: fmtDuration(entry.duration_minutes) })}</span>
        </p>
      )}
      {autoNoteKey && <p className="crew-stop-note text-xs" role="note">{t(autoNoteKey, { time: fmtTime(entry.clock_out_at) })}</p>}

      {state !== STOP.DONE && job && <ChecklistProgress gate={gate} hasChecklist={hasChecklist} />}

      <CrewSupplyNote entry={client ? supplies?.get(client.id) : null} />

      {state === STOP.UPCOMING && job && jobId && onMyWay?.canTell?.has(jobId) && (
        <OnMyWay jobId={jobId} job={job} name={name} onMyWay={onMyWay} disabled={previewing || !online} />
      )}

      {state !== STOP.DONE && jobId && (
        <div className="crew-stop-actions">
          {hasChecklist && (
            <button type="button" className={`btn crew-shell-tap ${clockedIn ? 'btn-primary' : 'btn-outline'}`} onClick={() => go(crewPaths.checklist(jobId))}>
              {clockedIn ? t('crewStops.viewChecklist') : t('crewStops.previewChecklist')}
            </button>
          )}
          <button type="button" className={`btn crew-shell-tap ${clockedIn ? 'btn-outline' : 'btn-gold'}`} onClick={() => go(crewPaths.clock(jobId))}>
            {clockedIn ? t('clock.out') : t('clock.in')}
          </button>
        </div>
      )}
      {job && (
        <button type="button" className="btn btn-link crew-stop-details" onClick={() => go(`/schedule/${job.id}`)}>
          {t('crewStops.details')} <Icon name="chevronRight" size={14} />
        </button>
      )}
    </article>
  );
}

function ComingUpItem({ job }) {
  const navigate = useNavigate();
  const nav = useFromHere();
  const name = useSelector(useCallback((s) => clientOfJob(s, job)?.name || (job.siteId ? selectSiteById(s, job.siteId)?.name : null) || '—', [job]));
  return (
    <button type="button" className="crew-stop-upcoming" onClick={() => navigate(`/schedule/${job.id}`, { state: nav })}>
      <span className="crew-stop-upcoming-text">
        <span className="crew-stop-upcoming-name">{name}</span>
        <span className="text-muted text-xs">{fmtDate(job.startAt)} · {fmtTimeRange(job.startAt, job.endAt)}</span>
      </span>
      <Icon name="chevronRight" size={16} />
    </button>
  );
}

export default function CrewStops() {
  const t = useT();
  const navigate = useNavigate();
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const userId = currentUser?.id;
  const online = useOnlineStatus();
  const now = useNowTick();
  const { entries, error } = useCrewPunches(userId);
  const { cleans, upcoming } = useCrewDay(userId, now);
  const graceMins = useSelector(useCallback((s) => s.opsSettings?.autoCloseGraceMins, []));
  // The supplies line of every building on today's list, from ONE crew read (S6).
  const supplies = useOnsiteSupplies();
  const { previewing } = useCrewPreview();

  // An open punch whose clean is not on today's list (last night's) is looked up by id.
  const carryIds = useMemo(() => {
    const onList = new Set(cleans.map((j) => j.id));
    return (entries || []).filter((e) => !e.clock_out_at && e.job_id && !onList.has(e.job_id)).map((e) => e.job_id);
  }, [cleans, entries]);
  const carryJobs = useSelector(useCallback((s) => carryIds.map((id) => selectJobById(s, id)), [carryIds]), shallowEqual);
  const findJob = useCallback((id) => carryJobs[carryIds.indexOf(id)] || null, [carryIds, carryJobs]);
  const rows = useMemo(
    () => stopRows({ cleans, entries: entries || [], now, graceMins, findJob }),
    [cleans, entries, now, graceMins, findJob],
  );
  const count = cleans.filter((j) => j.status !== 'cancelled').length;
  // "On my way": one read for the stops still to do (EP-422).
  const onMyWay = useOnMyWay(rows.filter((r) => r.state === STOP.UPCOMING && r.jobId).map((r) => r.jobId));

  return (
    <div className="crew-stops">
      <CrewPageHead title={t('crewStops.title')} sub={t('crewStops.locations', { count })} />

      {!online && <div className="callout callout-warning crew-home-note" role="status">{t('crewHome.offline')}</div>}
      {error && (
        <div className="callout callout-warning crew-home-note" role="alert">
          <span className="text-sm">{t('myDay.error.clockStatus')} {t('myDay.error.stillListed')}</span>
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState icon={<Icon name="schedule" size={28} />} title={t('myDay.empty.title')} message={t('myDay.empty.message')} />
      ) : (
        <div className="crew-stop-list">
          {rows.map((row) => <StopCard key={row.key} row={row} userId={userId} supplies={supplies} online={online} onMyWay={onMyWay} previewing={previewing} />)}
        </div>
      )}

      <h2 className="crew-stop-section">{t('crewStops.comingUp')}</h2>
      {upcoming.length === 0 ? (
        <p className="text-muted text-sm">{t('myDay.noUpcoming', { days: UPCOMING_DAYS })}</p>
      ) : (
        <div className="crew-stop-upcoming-list">
          {upcoming.map((job) => <ComingUpItem key={job.id} job={job} />)}
        </div>
      )}

      <div className="crew-stop-qr">
        <p className="text-sm">{t('crewStops.qrNote')}</p>
        <button type="button" className="btn btn-outline crew-shell-tap" onClick={() => navigate(crewPaths.scan(), { state: nav })}>
          <Icon name="camera" size={18} /> {t('crewHome.scan')}
        </button>
      </div>
    </div>
  );
}
