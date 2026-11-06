import TimeClockHistory from '../components/TimeClockHistory';
import { useT } from '../i18n/react';

// Manager Time Clock: every crew clock-in / clock-out, org-wide, newest first.
// The account, crew-member and job pages show the same history scoped to them;
// the Variance report analyses it against expected time. Route-gated time.view.
export default function TimeClock() {
  const t = useT();
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('timeClock.title')}</h1>
          <p className="page-sub">
            {t.rich('timeClock.intro')}
          </p>
        </div>
      </div>
      <TimeClockHistory title={t('timeClock.allPunches')} defaultPeriod="7d" showFacets />
    </div>
  );
}
