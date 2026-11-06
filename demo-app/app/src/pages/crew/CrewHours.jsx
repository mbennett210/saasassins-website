// My Hours — a cleaner's own time in a pay period, VIEW ONLY (Matt's Cleaner Hub board "My Hours";
// plan docs/plans/2026-10-13-cleaner-hub.md, brief C §3). PHONE FIRST: designed at 390 × 844.
//
// Back + "My Hours" + "Pay period Sep 29 – Oct 12"; the summary card ("This period so far" ·
// "23.5 hrs" · "2 days approved · today in progress"); a row per day worked (the day, its hours or
// "Clocked in 6:00 PM" while on the clock, Approved / Pending approval / In progress); "Hours are
// reviewed and approved by your account manager."; ‹ Previous period / Next period › (never into
// the future). NOTHING here is editable. The figures are the server's (GET /api/time/my-hours,
// EP-381 — the pay period worked out from the org's own payroll settings, lib/myHours); the period
// shown lives in the URL (`?p=`, 0 = this one), so Back returns to it. Every word is a catalog line
// (`myHours.*`, UI_RULES §140). With no signal the phone's last answer shows, said as such.
import { useSearchParams } from 'react-router-dom';
import Icon from '../../components/Icon';
import Badge from '../../components/Badge';
import { useBackTarget } from '../../hooks/useBackTarget';
import { useMyHours, formatHours } from '../../hooks/useMyHours';
import { crewPaths } from '../../lib/crewPaths';
import { hoursOneDecimal, myHoursOffset, MY_HOURS_STATUS } from '../../lib/myHours';
import { useT } from '../../i18n/react';

// Each day's chip: its words and its badge colour (literal keys, UI_RULES §140).
const DAY_CHIP = {
  [MY_HOURS_STATUS.approved]: { key: 'myHours.status.approved', variant: 'green' },
  [MY_HOURS_STATUS.pending]: { key: 'myHours.status.pending', variant: 'amber' },
  [MY_HOURS_STATUS.inProgress]: { key: 'myHours.status.inProgress', variant: 'blue' },
};

function HoursHead({ sub }) {
  const t = useT();
  const { href, label, goBack } = useBackTarget(crewPaths.home());
  return (
    <header className="my-hours-head">
      <a className="my-hours-back" href={href} onClick={goBack} aria-label={label || t('back.back')}>
        <Icon name="chevronLeft" size={20} />
      </a>
      <div className="my-hours-head-text">
        <h1 className="my-hours-head-title">{t('myHours.title')}</h1>
        {sub ? <p className="my-hours-head-sub">{sub}</p> : null}
      </div>
    </header>
  );
}

export default function CrewHours() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const offset = myHoursOffset(params.get('p'));
  const { data, loading, error, offline, savedAt, refresh } = useMyHours(offset);
  const go = (next) => {
    const p = new URLSearchParams(params);
    if (next > 0) p.set('p', String(next)); else p.delete('p');
    setParams(p, { replace: true });
  };
  const hrs = (minutes) => formatHours(hoursOneDecimal(minutes), t.lang);
  // This period's answer, or the phone's copy of it; never another period's figures.
  const shown = data && data.offset === offset ? data : null;
  const current = offset === 0;
  const sub = shown ? t('myHours.period', { from: shown.fromIso, to: shown.toIso }) : null;
  const summaryLine = shown
    ? t(shown.inProgress ? 'myHours.summary.approvedDaysToday' : 'myHours.summary.approvedDays', { count: shown.approvedDays })
    : '';

  return (
    <div className="page page-narrow my-hours-page">
      <HoursHead sub={sub} />
      {savedAt && shown ? <p className="my-hours-note" role="status">{t('myHours.offlineKept', { at: savedAt })}</p> : null}

      {!shown ? (
        loading ? <p className="text-muted text-sm">{t('common.loading')}</p>
          : offline ? <p className="my-hours-note" role="status">{t('myHours.offlineNone')}</p>
            : (
              <div className="my-hours-failed" role="alert">
                <p>{t('myHours.loadFailed')}</p>
                {error ? <button type="button" className="btn btn-primary" onClick={refresh}>{t('crewRequests.tryAgain')}</button> : null}
              </div>
            )
      ) : (
        <>
          <section className="card my-hours-summary" aria-label={current ? t('myHours.summary.current') : t('myHours.summary.past')}>
            <p className="my-hours-summary-label">{current ? t('myHours.summary.current') : t('myHours.summary.past')}</p>
            <p className="my-hours-summary-total">{t('myHours.summary.hours', { hours: hrs(shown.totalMinutes) })}</p>
            <p className="my-hours-summary-line">{summaryLine}</p>
          </section>

          <h2 className="my-hours-section">{current ? t('myHours.days.current') : t('myHours.days.past')}</h2>
          {shown.days.length === 0 ? (
            <p className="my-hours-empty">{t('myHours.empty')}</p>
          ) : (
            <ul className="my-hours-days">
              {shown.days.map((d) => {
                const chip = DAY_CHIP[d.status] || DAY_CHIP[MY_HOURS_STATUS.pending];
                return (
                  <li key={d.dayKey} className={`card my-hours-day${d.status === MY_HOURS_STATUS.inProgress ? ' is-live' : ''}`}>
                    <div className="my-hours-day-text">
                      <p className="my-hours-day-name">{d.isToday ? t('myHours.dayToday', { day: d.dayIso }) : t('myHours.day', { day: d.dayIso })}</p>
                      <p className="my-hours-day-sub">
                        {d.status === MY_HOURS_STATUS.inProgress && d.openSince
                          ? t('myHours.clockedIn', { at: d.openSince })
                          : t('myHours.dayHours', { hours: hrs(d.minutes) })}
                      </p>
                    </div>
                    <Badge variant={chip.variant}>{t(chip.key)}</Badge>
                  </li>
                );
              })}
            </ul>
          )}

          <p className="card my-hours-footer">{t('myHours.footer')}</p>

          <nav className="my-hours-pager" aria-label={t('myHours.title')}>
            <button type="button" className="btn btn-outline" disabled={!shown.hasOlder} onClick={() => go(offset + 1)}>
              <Icon name="chevronLeft" size={16} /> {t('myHours.previous')}
            </button>
            <button type="button" className="btn btn-outline" disabled={!shown.hasNewer} onClick={() => go(offset - 1)}>
              {t('myHours.next')} <Icon name="chevronRight" size={16} />
            </button>
          </nav>
        </>
      )}
    </div>
  );
}
