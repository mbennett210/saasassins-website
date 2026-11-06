// Shift check-in (/check-in) — Matt's "Shift Check-in" board (Account Manager Hub, 2026-10-07):
// today's visits in the buildings in view, with who has arrived, who is late and who has not
// checked in, and a Call button on the problem rows. Plan docs/plans/2026-10-09-manager-view-
// redesign.md §1 and S2/S3.
//
// THE RULES ARE NOT THIS SCREEN'S. Every status comes from lib/managerToday (built on the
// attendance engine): "late" is past the start with nobody clocked in, still inside Matt's
// missed-shift mark (ALR-11, opsSettings.missedAfterStartMins) — a label only, no new alert.
// "No check-in" is the report's no-punch state. A called-out visit is its own quiet line,
// never "no check-in". Gate: time.approve (who approves time watches attendance), office only.
//
// Desktop draws a table (Property · Crew · Status · call); a phone the same rows as cards
// (.mobile-stack, UI_RULES §24). Problems first. The Call button rings the first cleaner on the
// visit (plan S3: nothing marks a crew lead).
import { useMemo } from 'react';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import ListPager from '../components/ListPager';
import PhoneLink from '../components/PhoneLink';
import { StatCard } from './reports/reportKit';
import {
  ManagerScopeFilter, TodayGate, TodayHead, crewLine, useMgrParam, visitBadge, visitLabel, shortName,
} from '../components/ManagerTodayKit';
import { useManagerToday } from '../hooks/useManagerToday';
import { usePagedRows } from '../hooks/usePagedRows';
import { problemsFirst, VISIT_STATUS } from '../lib/managerToday';
import { useT } from '../i18n/react';

const PROBLEM = new Set([VISIT_STATUS.LATE, VISIT_STATUS.NO_CHECK_IN]);

// The visit's state in words — one line on the phone card and in the desktop Status cell.
function statusText(t, v) {
  switch (v.status) {
    case VISIT_STATUS.IN_PROGRESS: return t('shiftCheck.status.onSite', { time: v.arrivedAt });
    case VISIT_STATUS.LATE: return t('shiftCheck.status.late', { count: v.minutesPast });
    case VISIT_STATUS.NO_CHECK_IN: return t('shiftCheck.status.noCheckIn');
    case VISIT_STATUS.DONE: return v.arrivedAt ? t('shiftCheck.status.done', { time: v.arrivedAt }) : t('shiftCheck.status.doneMarked');
    case VISIT_STATUS.CALLED_OUT: return visitBadge(t, v)[1];
    default: return t('shiftCheck.status.upcoming', { time: v.startAt });
  }
}

const TONE = {
  [VISIT_STATUS.IN_PROGRESS]: 'is-on',
  [VISIT_STATUS.LATE]: 'is-late',
  [VISIT_STATUS.NO_CHECK_IN]: 'is-missing',
  [VISIT_STATUS.CALLED_OUT]: 'is-quiet',
};

function CallButton({ visit }) {
  const t = useT();
  const who = visit.crew?.[0];
  if (!who) return null;
  const name = shortName(who.name) || who.name || '';
  if (!who.phone) return <span className="text-xs text-muted">{t('shiftCheck.noPhone', { name })}</span>;
  return (
    <PhoneLink phone={who.phone} className="btn-icon mgt-call" title={t('shiftCheck.call', { name })} ariaLabel={t('shiftCheck.call', { name })}>
      <Icon name="phone" size={16} />
    </PhoneLink>
  );
}

export default function ShiftCheckIn() {
  const t = useT();
  // The owner's pick of an Operations Manager's team rides in too (the Operations view's band).
  const [mgrId, setMgrId, opsManagerId] = useMgrParam({ teamPick: true });
  const today = useManagerToday({ mgrId, opsManagerId });
  const rows = useMemo(() => problemsFirst(today.visits || []), [today.visits]);
  const pager = usePagedRows(rows, { param: 'page', resetKey: `${mgrId}|${opsManagerId || ''}` });
  const counts = today.counts;

  const sub = today.asOf
    ? [t('mgrToday.asOf', { time: today.asOf }), counts ? t('mgrToday.propertyCount', { count: counts.properties }) : null].filter(Boolean).join(' · ') // i18n-ok: a separator between two catalog lines
    : null;

  return (
    <div className="page mgt-page">
      <TodayHead title={t('shiftCheck.title')} sub={sub} />
      <ManagerScopeFilter value={mgrId} onChange={setMgrId} opsManagerId={opsManagerId} />
      <TodayGate today={today}>{() => (<>
        <div className="stat-grid mgt-tiles">
          <StatCard label={t('shiftCheck.tile.onSite')} value={counts.onSite} tone={counts.onSite > 0 ? 'success' : null} />
          <StatCard label={t('shiftCheck.tile.late')} value={counts.late} tone={counts.late > 0 ? 'warn' : null} />
          <StatCard label={t('shiftCheck.tile.noCheckIn')} value={counts.noCheckIn} tone={counts.noCheckIn > 0 ? 'danger' : null} />
        </div>
        {rows.length === 0 ? (
          <EmptyState icon={<Icon name="schedule" size={28} />} title={t('mgrToday.noVisits')} message={t('mgrToday.noVisitsHint')} />
        ) : (
          <>
            <div className="table-wrap mobile-stack mgt-checkin">
              <table>
                <thead>
                  <tr>
                    <th>{t('shiftCheck.col.property')}</th>
                    <th>{t('shiftCheck.col.crew')}</th>
                    <th>{t('shiftCheck.col.status')}</th>
                    <th><span className="sr-only">{t('shiftCheck.col.call')}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {pager.pageRows.map((v) => {
                    const [variant] = visitBadge(t, v);
                    return (
                      <tr key={v.jobId} className={`mgt-checkin-row ${TONE[v.status] || ''}`}>
                        <td className="cell-primary">
                          <span className={`mgt-dot is-${variant}`} aria-hidden="true" />
                          <span className="mgt-checkin-name">{visitLabel(t, v)}</span>
                        </td>
                        <td data-label={t('shiftCheck.col.crew')} className="mgt-checkin-crew">{crewLine(t, v)}</td>
                        <td data-label={t('shiftCheck.col.status')} className="mgt-checkin-status">{statusText(t, v)}</td>
                        <td className="cell-actions mgt-checkin-call">{PROBLEM.has(v.status) ? <CallButton visit={v} /> : null}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <ListPager pager={pager} noun={t('pager.noun.visits')} />
          </>
        )}
      </>)}</TodayGate>
    </div>
  );
}
