import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import ClockControl from './ClockControl';
import MediaGallery from './MediaGallery';
import CleanChecklist from './CleanChecklist';
import * as timeApi from '../lib/timeApi';
import { fmtTime, fmtDuration } from '../lib/dates';

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
  const [entry, setEntry] = useState(null);
  // Imperative picker triggers for the two galleries — a step's "Add photos" pops the
  // matching gallery's native camera/file picker directly (no section-toggle).
  const beforePicker = useRef(null);
  const afterPicker = useRef(null);
  // Actual-progress state (drives the step checkmarks): photo counts per phase + checklist.
  const [beforeCount, setBeforeCount] = useState(0);
  const [afterCount, setAfterCount] = useState(0);
  const [checklist, setChecklist] = useState({ hasChecklist: false, complete: false });

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
      <h3 className="dash-card-title">Visit checklist</h3>
      <div className="visit-steps">
        <Step
          n="1"
          state={clockedIn ? 'done' : 'current'}
          name="Clock in & start"
          sub={clockedIn ? `On the clock since ${fmtTime(entry.clock_in_at)}` : "Verify you're on site — this starts the clean and your time."}
        >
          {!clockedIn && (
            <div className="visit-action">
              <ClockControl job={job} ctx={ctx} entry={entry} onChange={reload} size="lg" />
            </div>
          )}
        </Step>

        <Step n="2" icon={camIcon} state={step2State} name="Before photos" sub="Snap the space before you start.">
          {isOpen && (
            <button type="button" className="btn btn-gold visit-inline" onClick={() => beforePicker.current?.()}>
              <Icon name="camera" size={14} /> Add photos
            </button>
          )}
        </Step>

        <Step n="3" icon="3" state={step3State} name="Do the clean" sub={site?.address ? `${site.address} · see instructions below.` : 'See the instructions below.'}>
          <CleanChecklist job={job} client={client} variant="button" onStatus={setChecklist} />
        </Step>

        <Step n="4" icon={camIcon} state={step4State} name="After photos" sub="Show the finished result.">
          {isOpen && (
            <button type="button" className="btn btn-gold visit-inline" onClick={() => afterPicker.current?.()}>
              <Icon name="camera" size={14} /> Add photos
            </button>
          )}
        </Step>

        <Step
          n="5"
          icon={clockIcon}
          state={isDone ? 'done' : isOpen ? 'current' : 'upcoming'}
          name="Clock out"
          sub={isDone ? `Clocked out · ${fmtDuration(entry.duration_minutes)}` : 'Wraps the clean and marks it done.'}
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
              label="Before photos" hint="The space before you start — images up to 10MB, video up to 200MB."
              openRef={beforePicker} onCount={setBeforeCount}
            />
          </div>
          <div className="visit-photo-area">
            <MediaGallery
              siteId={job.siteId} clientId={clientId} scope="clean" refId={job.id} areaId="after"
              label="After photos" hint="The finished result — images up to 10MB, video up to 200MB."
              openRef={afterPicker} onCount={setAfterCount}
            />
          </div>
        </div>
      )}
    </div>
  );
}
