import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { useFromHere } from '../hooks/useFromHere';
import { useQboBook } from '../hooks/useQboBook';
import { VariantC, VariantD } from '../components/dashboardLayouts';
import EmptyState from '../components/EmptyState';
import FilterSelect from '../components/FilterSelect';
import Icon from '../components/Icon';
import { bookCountLabel, windowFromParam, periodDates } from '../lib/qboView';
import { WINDOWS, DEFAULT_WINDOW } from '../data/dashboardLayoutPreview';
import { ALL_TIME_START, MONTH_TO_DATE, isDayKey, rangeKind, recentMonths, spanKey } from '../lib/pnlRange';
import { fmtDate, fmtDateLong, todayIso, todayKey } from '../lib/dates';
import { useT } from '../i18n/react';

// The Account-Manager Dashboard as a LIVE, full-page surface: Super Admin (owner) lands on
// variant C, the KPI Cockpit (App.jsx HomeRoute → pages/OwnerHome, which adds the "Owner cockpit ·
// Manager view" switch). Variant D, the Health Triage, is the Property P&L page (`/pnl`,
// pages/PropertyPnl, gated financials.view): the manager view redesign (D1 / D3, 2026-10-09)
// moved the manager's home to pages/ManagerHome and kept this board one tile away. PropertyPnl
// passes `title` + `back`, which replace the greeting with the page's own name and back pill.
// Admin keeps the operational pages/Dashboard.jsx; crew have no dashboard.view and are
// redirected to /my-day.
//
// Data comes from useQboBook (lib/qboApi → lib/qboView): with QuickBooks NOT connected (or the
// caller lacking financials.view) it renders the design-phase preview layouts, exactly as
// today, no banner (CS-013 / decision 3). Once connected it renders ONLY the live, linked
// properties in the caller's scope — never a mix — or an empty state. A sandbox connection is
// labelled test data, and every live view shows the as-of time + report basis (decision 3).
//
// THE PERIOD PICKER (Matt, 2026-10-04: "see the performance from August, from September, from
// July, or from this month only … I want to be able to edit the dates"): a searchable list —
// this month, 30 / 60 / 90 days and 12 months (S111 ②, QB-10), then the twelve calendar months
// before this one — beside the period's first and last day, which can be edited; editing either
// makes it a span of those dates. Kept in the URL (`?window=`, replace, dropped at the 30-day
// default) so Back and a shared link keep it; the grammar is lib/pnlRange.js, shared with the
// server. It applies to the preview and the live book alike; switching keeps the book on screen,
// labelled with ITS period, until the new period's figures land ("Updating…").

// Personal courtesy greeting, intentionally on the reader's own clock, matching
// pages/Dashboard.jsx (every business date stays org-time).
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// How long the date fields wait after a keystroke before asking for the new span, so typing a
// date one digit at a time asks QuickBooks once, not once per digit.
const DATE_COMMIT_MS = 500;

const monthName = (m) => fmtDate(`${m}-01`, { month: 'long', year: 'numeric' });

function PeriodPicker({ value, onChange }) {
  const t = useT();
  const today = todayKey();
  const kind = rangeKind(value);
  const dates = periodDates(value) || { start: '', end: '' };

  const options = useMemo(() => {
    const list = [
      { value: MONTH_TO_DATE, label: t('acctDash.range.mtd') },
      ...WINDOWS.map((w) => ({ value: w.key, label: t(w.labelKey) })),
      ...recentMonths().map((m) => ({ value: m, label: monthName(m) })),
    ];
    // A span of the reader's dates, or a month older than the list (a whole month typed by
    // hand, or a shared link), is shown as itself rather than as the first row.
    if (!list.some((o) => o.value === value)) {
      list.push({ value, label: kind === 'month' ? monthName(value) : t('acctDash.period.custom') });
    }
    return list;
  }, [t, value, kind]);

  // The date fields hold what is being typed; a whole, in-range date commits after a pause.
  const [draft, setDraft] = useState(dates);
  useEffect(() => { setDraft({ start: dates.start, end: dates.end }); }, [dates.start, dates.end]);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const edit = (which, v) => {
    const next = { ...draft, [which]: v };
    setDraft(next);
    clearTimeout(timer.current);
    let { start, end } = next;
    // Half-typed, before all-time, or a start after today: wait for a real date.
    if (!isDayKey(start) || !isDayKey(end) || start < ALL_TIME_START || end < ALL_TIME_START || start > today) return;
    if (end > today) end = today;
    if (which === 'start' && start > end) end = start;
    if (which === 'end' && end < start) start = end;
    timer.current = setTimeout(() => onChange(spanKey(start, end)), DATE_COMMIT_MS);
  };

  return (
    <div className="acct-dash-period">
      <div className="acct-dash-period-select">
        <FilterSelect ariaLabel={t('acctDash.windowLabel')} value={value} onChange={onChange} options={options} />
      </div>
      <div className="acct-dash-dates">
        <input
          type="date" className="input" aria-label={t('acctDash.period.from')}
          min={ALL_TIME_START} max={today} value={draft.start}
          onChange={(e) => edit('start', e.target.value)}
        />
        <span className="acct-dash-dates-sep" aria-hidden>–</span>
        <input
          type="date" className="input" aria-label={t('acctDash.period.to')}
          min={ALL_TIME_START} max={today} value={draft.end}
          onChange={(e) => edit('end', e.target.value)}
        />
      </div>
    </div>
  );
}

// A quiet loading placeholder while the first live pull is in flight.
function DashSkeleton() {
  return (
    <div className="acct-dash-skel" aria-hidden>
      <div className="acct-dash-skel-tiles">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skel-box skel-tile" />)}
      </div>
      <div className="skel-box skel-panel" />
    </div>
  );
}

export default function AccountDashboard({ variant, title = null, back = null }) {
  const t = useT();
  const { currentUser } = useAuth();
  const nav = useFromHere();
  const [searchParams, setSearchParams] = useSearchParams();
  const win = windowFromParam(searchParams.get('window'));
  const setPeriod = (key) => {
    const next = new URLSearchParams(searchParams);
    if (key === DEFAULT_WINDOW) next.delete('window'); else next.set('window', key);
    setSearchParams(next, { replace: true });
  };
  const { phase, book, error, refresh, updating } = useQboBook({ window: win });
  // C's cockpit opens on the most at-risk account; VariantC falls back to it when cSel is unset
  // or no longer in the book (e.g. after the preview→live swap), so no reset effect is needed.
  const [cSel, setCSel] = useState(null);

  const firstName = currentUser?.name?.split(' ')[0] || '';
  const isLive = book.status === 'ok';
  const count = isLive ? book.count : book.accounts.length;
  const isOwner = currentUser?.role === 'owner';
  // C2/C3: while the first live pull is in flight show a NEUTRAL sub-header — no preview count
  // ("Your book, 20 accounts") flashing above the skeleton. The clause is empty until real.
  const loading = phase === 'live-loading';
  const countLabel = bookCountLabel({ loading, count });

  let body;
  if (loading) {
    body = <DashSkeleton />;
  } else if (phase === 'error') {
    body = (
      <EmptyState
        icon={<Icon name="warning" size={22} />}
        title="Couldn’t load QuickBooks"
        message={error?.message || 'The profit & loss feed is unavailable right now.'}
        action={<button type="button" className="btn btn-primary" onClick={refresh}>Try again</button>}
      />
    );
  } else if (isLive && count === 0) {
    body = (
      <EmptyState
        icon={<Icon name="chart" size={22} />}
        title="No properties are linked to QuickBooks yet"
        message={isOwner
          ? 'Link a property to a QuickBooks customer, class or location to see its profit & loss here.'
          : 'Once your properties are linked to QuickBooks, their profit & loss will appear here.'}
        action={isOwner
          ? <Link className="btn btn-primary" to="/settings/integrations" state={nav}>Go to Integrations</Link>
          : null}
      />
    );
  } else {
    body = variant === 'D'
      ? <VariantD book={book} />
      : <VariantC book={book} cSel={cSel} onSel={setCSel} />;
  }

  return (
    <>
      {back}
      <div className="page-head"><h1>{title || 'Dashboard'}</h1></div>

      <div className="acct-dash">
        <div className="acct-dash-head">
          <div className="acct-dash-greet-wrap">
            {!title && <div className="acct-dash-greet">{greeting()}{firstName ? `, ${firstName}` : ''}</div>}
            <div className="acct-dash-sub">{fmtDateLong(todayIso())}{countLabel ? ` · ${countLabel}` : ''}</div>
          </div>
          <div className="acct-dash-side">
            <PeriodPicker value={win} onChange={setPeriod} />
            {isLive && (
              <div className="acct-dash-meta">
                {updating && <span className="acct-dash-asof">{t('acctDash.updating')}</span>}
                {book.sandbox && <span className="badge amber">QuickBooks sandbox · test data</span>}
                {book.basis && <span className="acct-dash-basis">{book.basis} basis</span>}
              </div>
            )}
          </div>
        </div>

        {body}
      </div>
    </>
  );
}
