// The Schedule's "Today" view (/schedule?view=Today) — Matt's "Today's Schedule" board (Account
// Manager Hub, 2026-10-07): today's visits in two groups, Day and Evening (plan S1: split by the
// start, before 3:00 PM is Day), each row the time, the customer and where it stands (Done ·
// In progress · No check-in · Late · Upcoming · Called out). A row opens the visit.
//
// The statuses come from lib/managerToday (the attendance engine's rules, ALR-11) through
// hooks/useManagerToday — never from job.status alone, which says nothing about who clocked
// in. The page's own facet filters still apply: a visit shows only when the Schedule's filtered
// job set holds it (`jobIds`). It is the default view for a manager (Schedule.jsx).
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import Badge from './Badge';
import EmptyState from './EmptyState';
import Icon from './Icon';
import ListPager from './ListPager';
import { ManagerScopeFilter, TodayGate, useMgrParam, visitBadge, visitLabel } from './ManagerTodayKit';
import { useManagerToday } from '../hooks/useManagerToday';
import { usePagedRows } from '../hooks/usePagedRows';
import { useFromHere } from '../hooks/useFromHere';
import { VISIT_GROUP, VISIT_STATUS, countVisits } from '../lib/managerToday';
import { fmtTime } from '../lib/dates';
import { useT } from '../i18n/react';

const TONE = { [VISIT_STATUS.NO_CHECK_IN]: 'is-missing', [VISIT_STATUS.LATE]: 'is-late' };

function TodayGroup({ title, visits, param }) {
  const t = useT();
  const nav = useFromHere();
  const pager = usePagedRows(visits, { param });
  return (
    <section className="card mgt-group">
      <h2 className="mgt-group-title">{title}</h2>
      {visits.length === 0 ? (
        <p className="text-sm text-muted">{t('mgrToday.groupEmpty')}</p>
      ) : (
        <>
          <ul className="mgt-sched-list">
            {pager.pageRows.map((v) => {
              const [variant, word] = visitBadge(t, v);
              return (
                <li key={v.jobId}>
                  <Link to={`/schedule/${v.jobId}`} state={nav} className={`mgt-sched-row ${TONE[v.status] || ''}`}>
                    <span className="mgt-sched-time">{fmtTime(v.startAt)}</span>
                    <span className="mgt-sched-name">{visitLabel(t, v)}</span>
                    <Badge variant={variant}>{word}</Badge>
                  </Link>
                </li>
              );
            })}
          </ul>
          <ListPager pager={pager} noun={t('pager.noun.visits')} />
        </>
      )}
    </section>
  );
}

export default function ScheduleToday({ jobIds = null }) {
  const t = useT();
  // The owner's pick of an Operations Manager's team rides in too (the Operations view's tile).
  const [mgrId, setMgrId, opsManagerId] = useMgrParam({ teamPick: true });
  const today = useManagerToday({ mgrId, opsManagerId });
  // The Schedule's facets (location, cleaner, label…) narrow the list like every other view.
  const visits = useMemo(
    () => (today.visits || []).filter((v) => !jobIds || jobIds.has(v.jobId)),
    [today.visits, jobIds],
  );
  const counts = useMemo(() => countVisits(visits), [visits]);
  const day = useMemo(() => visits.filter((v) => v.group === VISIT_GROUP.DAY), [visits]);
  const evening = useMemo(() => visits.filter((v) => v.group === VISIT_GROUP.EVENING), [visits]);

  return (
    <div className="mgt-sched">
      <ManagerScopeFilter value={mgrId} onChange={setMgrId} opsManagerId={opsManagerId} />
      <TodayGate today={today}>{() => (<>
        <p className="text-sm text-muted mgt-sched-sub">
          {[t('mgrToday.visitCount', { count: counts.total }), t('mgrToday.propertyCount', { count: counts.properties }), today.asOf ? t('mgrToday.asOf', { time: today.asOf }) : null].filter(Boolean).join(' · ') /* i18n-ok: a separator between catalog lines */}
        </p>
        {visits.length === 0 ? (
          <div className="card dash-card">
            <EmptyState icon={<Icon name="schedule" size={28} />} title={t('mgrToday.noVisits')} message={t('mgrToday.noVisitsHint')} />
          </div>
        ) : (
          <div className="mgt-groups">
            <TodayGroup title={t('mgrToday.group.day')} visits={day} param="tdpage" />
            <TodayGroup title={t('mgrToday.group.evening')} visits={evening} param="tepage" />
          </div>
        )}
      </>)}</TodayGate>
    </div>
  );
}
