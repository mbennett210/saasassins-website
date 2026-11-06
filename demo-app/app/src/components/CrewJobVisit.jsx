import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import ClockControl from './ClockControl';
import MediaGallery from './MediaGallery';
import CleanChecklist from './CleanChecklist';
import CrewSupplyNote from './CrewSupplyNote';
import { useOnsiteSupplies } from '../hooks/useOnsiteSupplies';
import * as timeApi from '../lib/timeApi';
import { fmtTime, fmtDuration } from '../lib/dates';
import { useT } from '../i18n/react';

// Crew "Guided Visit" — the step timeline that replaces the stale "Start" button on
// JobDetail. The real geofence clock-in (ClockControl) IS the start: it verifies the
// crew is on site, records the time entry, and advances job.status to in_progress. One
// ClockControl is mounted at whichever clock step is active (clock-in at step 1 when
// clocked out; clock-out at step 5 once clocked in), so the two never double-render.
//
// Photos split BEFORE / AFTER: each clean's media carries a phase tag in the media
// `areaId` field ('before' | 'after') — an existing column that already flows through
// list/upload/stub/backend, so no schema change. Step 2's "Add photos" pops the camera
// straight into the Before section; step 4's into the After section (via each gallery's
// openRef). Admin/desktop reads the same two areaIds (see JobDetail).
//
// Clock state is a component-local projection (timeApi.mine), same as My Day — the store
// holds only the job.status side effect the punch dispatches, never the entry.
// Every word is a catalog line in the cleaner's language (CS-193).
function Step({ n, icon, state, name, sub, children }) {
  return (
    <div className={`visit-step is-${state}`}>
      <div className="visit-rail">
        <div className="visit-dot">{state === 'done' ? <Icon name="check" size={15} /> : icon || n}</div>
        <div className="visit-line" />
      </div>
      <div className="visit-body">
        <div className="visit-name">{name}</div>
        {sub ? <div className="visit-sub">{sub}</div> : null}
        {children}
      </div>
    </div>
  );
}

export default function CrewJobVisit({ job, ctx, site, client, userId }) {
  const t = useT();
  const [entry, setEntry] = useState(null);
  // Imperative picker triggers for the two galleries — a step's "Add photos" pops the
  // matching gallery's native camera/file picker directly (no section-toggle).
  const beforePicker = useRef(null);
  const afterPicker = useRef(null);
  // Actual-progress state (drives the step checkmarks): photo counts per phase + checklist.
  const [beforeCount, setBeforeCount] = useState(0);
  const [afterCount, setAfterCount] = useState(0);
  const [checklist, setChecklist] = useState({ hasChecklist: false, complete: false });
  // The building's supplies line (the delivery step, 2026-10-12, S6): only for a building the
  // cleaner cleans TODAY — the read answers for no other, so an upcoming visit shows none.
  const supplies = useOnsiteSupplies();

  const reload = useCallback(async () => {
    if (!job) return;
    try {
      const mine = await timeApi.mine({ userId });
      const forJob = (mine || []).filter((e) => e.job_id === job.id);
      const open = forJob.find((e) => !e.clock_out_at);
      const latest = [...forJob].sort((a, b) => (a.clock_in_at < b.clock_in_at ? 1 : -1))[0] || null;
      setEntry(open || latest);
    } catch {
      /* best-effort projection — leave any prior entry in place */
    }
  }, [job?.id, userId]);
  useEffect(() => { reload(); }, [reload]);

  const isOpen = !!entry && !entry.clock_out_at;
  const isDone = !!entry && !!entry.clock_out_at;
  const clockedIn = isOpen || isDone;
  const camIcon = <Icon name="camera" size={15} />;
  const clockIcon = <Icon name="schedule" size={15} />;
  // photos + clean are live once you're on the clock; done after clock-out; else waiting.
  const midState = isOpen ? 'current' : isDone ? 'done' : 'upcoming';
  // Steps check themselves off on ACTUAL progress, not just the clock: a before/after photo
  // added, or the checklist completed. Step 3 falls back to clock-driven when no checklist
  // is bound (nothing to complete → the clean reads done at clock-out).
  const step2State = beforeCount > 0 ? 'done' : (isOpen ? 'current' : 'upcoming');
  const step3State = checklist.hasChecklist
    ? (checklist.complete ? 'done' : (isOpen ? 'current' : 'upcoming'))
    : midState;
  const step4State = afterCount > 0 ? 'done' : (isOpen ? 'current' : 'upcoming');
  const clientId = job.clientId || site?.clientId || null;

  return (
    <div className="card visit-card">
      <h3 className="dash-card-title">{t('visit.title')}</h3>
      <CrewSupplyNote entry={clientId ? supplies.get(clientId) : null} />
      <div className="visit-steps">
        <Step
          n="1"
          state={clockedIn ? 'done' : 'current'}
          name={t('visit.step.clockIn')}
          sub={clockedIn ? t('visit.step.clockInSince', { time: fmtTime(entry.clock_in_at) }) : t('visit.step.clockInSub')}
        >
          {!clockedIn && (
            <div className="visit-action">
              <ClockControl job={job} ctx={ctx} entry={entry} onChange={reload} size="lg" />
            </div>
          )}
        </Step>

        <Step n="2" icon={camIcon} state={step2State} name={t('visit.step.before')} sub={t('visit.step.beforeSub')}>
          {isOpen && (
            <button type="button" className="btn btn-gold visit-inline" onClick={() => beforePicker.current?.()}>
              <Icon name="camera" size={14} /> {t('visit.addPhotos')}
            </button>
          )}
        </Step>

        <Step n="3" icon="3" state={step3State} name={t('visit.step.clean')} sub={site?.address ? t('visit.step.cleanSubAt', { address: site.address }) : t('visit.step.cleanSub')}>
          <CleanChecklist job={job} client={client} variant="button" onStatus={setChecklist} clockedIn={isOpen} />
        </Step>

        <Step n="4" icon={camIcon} state={step4State} name={t('visit.step.after')} sub={t('visit.step.afterSub')}>
          {isOpen && (
            <button type="button" className="btn btn-gold visit-inline" onClick={() => afterPicker.current?.()}>
              <Icon name="camera" size={14} /> {t('visit.addPhotos')}
            </button>
          )}
        </Step>

        <Step
          n="5"
          icon={clockIcon}
          state={isDone ? 'done' : isOpen ? 'current' : 'upcoming'}
          name={t('visit.step.clockOut')}
          sub={isDone ? t('visit.step.clockedOut', { duration: fmtDuration(entry.duration_minutes) }) : t('visit.step.clockOutSub')}
        >
          {isOpen && (
            <div className="visit-action">
              <ClockControl job={job} ctx={ctx} entry={entry} onChange={reload} size="lg" />
            </div>
          )}
        </Step>
      </div>

      {/* Two separate storage areas, shown once the visit is underway. The step "Add
          photos" buttons pop the picker straight into the matching one. */}
      {job.siteId && clockedIn && (
        <div className="visit-photos">
          <div className="visit-photo-area">
            <MediaGallery
              siteId={job.siteId} clientId={clientId} scope="clean" refId={job.id} areaId="before"
              label={t('visit.step.before')} hint={t('visit.beforeHint')}
              openRef={beforePicker} onCount={setBeforeCount}
            />
          </div>
          <div className="visit-photo-area">
            <MediaGallery
              siteId={job.siteId} clientId={clientId} scope="clean" refId={job.id} areaId="after"
              label={t('visit.step.after')} hint={t('visit.afterHint')}
              openRef={afterPicker} onCount={setAfterCount}
            />
          </div>
        </div>
      )}
    </div>
  );
}
