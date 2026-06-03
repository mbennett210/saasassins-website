import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Badge, { statusBadgeVariant } from '../components/Badge';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import NewJobModal from '../components/NewJobModal';
import FormField from '../components/FormField';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import {
  selectJobs, selectClientById, selectServiceById, selectSiteById, selectServices,
  selectActiveUsers, selectUserById, selectJobsForUser,
} from '../store/selectors';
import { fmtTimeRange, sameDay, startOfWeek, startOfMonth, addDays, composeIso, splitIso } from '../lib/dates';

const STATUS_LABEL = { upcoming: 'Upcoming', in_progress: 'In Progress', done: 'Done', cancelled: 'Cancelled' };

const toIsoDay = (d) => {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const fromIsoDay = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export default function Schedule() {
  const state = useStore();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const canCreate = usePermission('schedule.edit');

  const [searchParams, setSearchParams] = useSearchParams();
  const setParam = (key, value, defaultValue) => {
    const next = new URLSearchParams(searchParams);
    if (value === '' || value == null || value === defaultValue) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const view = searchParams.get('view') || 'Day';
  const setView = (v) => setParam('view', v, 'Day');
  const refDate = searchParams.get('d') ? fromIsoDay(searchParams.get('d')) : new Date();
  const todayIso = toIsoDay(new Date());
  const setRefDate = (d) => setParam('d', toIsoDay(d), todayIso);
  const [modalOpen, setModalOpen] = useState(false);
  const [rescheduleJob, setRescheduleJob] = useState(null);
  const filterStatus = searchParams.get('status') || 'all';
  const filterUser = searchParams.get('user') || 'all';
  const filterService = searchParams.get('service') || 'all';

  // Week DnD state
  const [draggingId, setDraggingId] = useState(null);
  const [dropTargetDay, setDropTargetDay] = useState(null);

  const jobsAll = selectJobs(state);
  const services = selectServices(state);
  const users = selectActiveUsers(state);
  const scope = currentUser?.role === 'crew' ? selectJobsForUser(state, currentUser.id) : jobsAll;

  const filteredJobs = useMemo(() => scope.filter((j) => {
    if (filterStatus !== 'all' && j.status !== filterStatus) return false;
    if (filterService !== 'all' && j.serviceId !== filterService) return false;
    if (filterUser !== 'all' && !j.crewIds?.includes(filterUser)) return false;
    return true;
  }), [scope, filterStatus, filterUser, filterService]);

  const dayJobs = useMemo(() => filteredJobs.filter((j) => sameDay(j.startAt, refDate)).sort((a, b) => a.startAt.localeCompare(b.startAt)), [filteredJobs, refDate]);

  // Conflict set for day view
  const dayConflictJobIds = useMemo(() => {
    const ids = new Set();
    for (let i = 0; i < dayJobs.length; i++) {
      for (let k = i + 1; k < dayJobs.length; k++) {
        const a = dayJobs[i], b = dayJobs[k];
        if (a.status === 'cancelled' || b.status === 'cancelled') continue;
        if (a.startAt < b.endAt && a.endAt > b.startAt) {
          const shared = (a.crewIds || []).filter((id) => (b.crewIds || []).includes(id));
          if (shared.length > 0) { ids.add(a.id); ids.add(b.id); }
        }
      }
    }
    return ids;
  }, [dayJobs]);

  const weekDays = useMemo(() => {
    const start = startOfWeek(refDate);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [refDate]);
  const weekJobs = useMemo(() => {
    return weekDays.map((d) => ({ date: d, jobs: filteredJobs.filter((j) => sameDay(j.startAt, d)).sort((a, b) => a.startAt.localeCompare(b.startAt)) }));
  }, [weekDays, filteredJobs]);

  // Conflict set for week view
  const weekConflictJobIds = useMemo(() => {
    const ids = new Set();
    for (const { jobs } of weekJobs) {
      for (let i = 0; i < jobs.length; i++) {
        for (let k = i + 1; k < jobs.length; k++) {
          const a = jobs[i], b = jobs[k];
          if (a.status === 'cancelled' || b.status === 'cancelled') continue;
          if (a.startAt < b.endAt && a.endAt > b.startAt) {
            const shared = (a.crewIds || []).filter((id) => (b.crewIds || []).includes(id));
            if (shared.length > 0) { ids.add(a.id); ids.add(b.id); }
          }
        }
      }
    }
    return ids;
  }, [weekJobs]);

  const monthGrid = useMemo(() => {
    const start = startOfMonth(refDate);
    const gridStart = startOfWeek(start);
    return Array.from({ length: 42 }, (_, i) => {
      const d = addDays(gridStart, i);
      const sameMonth = d.getMonth() === refDate.getMonth();
      return { date: d, sameMonth, jobs: filteredJobs.filter((j) => sameDay(j.startAt, d)) };
    });
  }, [refDate, filteredJobs]);

  const shiftRef = (dir) => {
    const d = new Date(refDate);
    if (view === 'Day') d.setDate(d.getDate() + dir);
    else if (view === 'Week') d.setDate(d.getDate() + 7 * dir);
    else d.setMonth(d.getMonth() + dir);
    setRefDate(d);
  };

  const viewTitle = useMemo(() => {
    if (view === 'Day') return refDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    if (view === 'Week') {
      const s = startOfWeek(refDate); const e = addDays(s, 6);
      return `${s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    }
    return refDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  }, [view, refDate]);

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
  const onColDrop = (e, targetDate) => {
    e.preventDefault();
    const jobId = e.dataTransfer.getData('text/plain');
    setDraggingId(null);
    setDropTargetDay(null);
    if (!canCreate || !jobId) return;
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return;
    const s = splitIso(job.startAt);
    const targetIso = toIsoDay(targetDate);
    if (s.date === targetIso) return;
    const newStart = composeIso(targetIso, s.time);
    const eTime = splitIso(job.endAt);
    const newEnd = composeIso(targetIso, eTime.time);
    dispatch({ type: ACTIONS.UPDATE_JOB, id: jobId, patch: { startAt: newStart, endAt: newEnd } });
  };

  // Month cell click → Day view (set both params atomically)
  const monthCellClick = (date) => {
    const next = new URLSearchParams(searchParams);
    const iso = toIsoDay(date);
    if (iso === todayIso) next.delete('d'); else next.set('d', iso);
    next.delete('view');
    setSearchParams(next, { replace: true });
  };

  return (
    <>
      <div className="page-head">
        <h1>Schedule</h1>
      </div>

      <div className="schedule-toolbar">
        <div className="tab-container tab-container-line">
          {['Day', 'Week', 'Month'].map((v) => (
            <button key={v} className={`tab-btn ${view === v ? 'active' : ''}`} onClick={() => setView(v)} type="button">{v}</button>
          ))}
        </div>
        <div className="schedule-nav">
          <span className="schedule-title">{viewTitle}</span>
          <div className="schedule-nav-controls">
            <button className="btn-icon btn-icon-primary" aria-label="Previous" onClick={() => shiftRef(-1)}><Icon name="chevronLeft" size={16} /></button>
            <button className="btn btn-primary btn-sm" onClick={() => setRefDate(new Date())}>Today</button>
            <button className="btn-icon btn-icon-primary" aria-label="Next" onClick={() => shiftRef(1)}><Icon name="chevronRight" size={16} /></button>
          </div>
        </div>
      </div>

      <div className="filter-bar">
        <FormField label="Status" as="select" value={filterStatus} onChange={(e) => setParam('status', e.target.value, 'all')}
          options={[{ value: 'all', label: 'All statuses' }, { value: 'upcoming', label: 'Upcoming' }, { value: 'in_progress', label: 'In Progress' }, { value: 'done', label: 'Done' }, { value: 'cancelled', label: 'Cancelled' }]} />
        <FormField label="Service" as="select" value={filterService} onChange={(e) => setParam('service', e.target.value, 'all')}
          options={[{ value: 'all', label: 'All services' }, ...services.map((s) => ({ value: s.id, label: s.name }))]} />
        <FormField label="Team" as="select" value={filterUser} onChange={(e) => setParam('user', e.target.value, 'all')}
          options={[{ value: 'all', label: 'Everyone' }, ...users.map((u) => ({ value: u.id, label: u.name }))]} />
        {canCreate && (
          <button
            type="button"
            className="btn btn-success filter-bar-action"
            onClick={() => setModalOpen(true)}
          >
            New Job
          </button>
        )}
      </div>

      {view === 'Day' && (
        <div className="card dash-card">
          {dayJobs.length === 0 ? (
            <EmptyState icon={<Icon name="schedule" size={28} />} title="No jobs scheduled" message={canCreate ? 'Add your first job to start planning the day.' : 'Check back soon — nothing to do yet.'} action={canCreate && <button className="btn btn-primary" onClick={() => setModalOpen(true)}>New Job</button>} />
          ) : (
            <div className="tl-track">
              <div className="tl-line" />
              {dayJobs.map((job) => {
                const client = selectClientById(state, job.clientId);
                const service = selectServiceById(state, job.serviceId);
                const site = selectSiteById(state, job.siteId);
                const crew = (job.crewIds || []).map((id) => selectUserById(state, id)).filter(Boolean);
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
                          {canCreate && job.status === 'upcoming' && (
                            <button className="btn btn-outline btn-xs" onClick={(e) => { e.stopPropagation(); setRescheduleJob(job); }}>
                              Reschedule
                            </button>
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-muted">
                        {crew.map((u) => u.name.split(' ')[0]).join(', ') || 'Unassigned'}
                        {site ? ` • ${site.name}` : ''}
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
                  <div className="text-xs text-muted">{date.toLocaleDateString(undefined, { weekday: 'short' })}</div>
                  <div className="text-sm font-semi">{date.getDate()}</div>
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
                        draggable={canCreate && j.status === 'upcoming'}
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
          {['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d) => <div key={d} className="month-head">{d}</div>)}
          {monthGrid.map(({ date, sameMonth, jobs }) => (
            <div key={date.toISOString()}
              className={`month-cell ${!sameMonth ? 'muted' : ''} ${sameDay(date, new Date()) ? 'today' : ''}`}
              onClick={() => monthCellClick(date)}
              style={{ cursor: 'pointer' }}
            >
              <div className="month-cell-date">{date.getDate()}</div>
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
                {jobs.length > 3 && <div className="text-xs text-muted">+{jobs.length - 3} more</div>}
              </div>
            </div>
          ))}
        </div>
      )}

      <NewJobModal open={modalOpen} onClose={() => setModalOpen(false)} />
      {rescheduleJob && (
        <NewJobModal open={true} onClose={() => setRescheduleJob(null)} mode="edit" initialData={rescheduleJob} />
      )}
    </>
  );
}
