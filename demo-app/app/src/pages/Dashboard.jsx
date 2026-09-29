import { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Badge from '../components/Badge';
import StatCard from '../components/StatCard';
import Avatar from '../components/Avatar';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import DashboardLayoutReview from '../components/DashboardLayoutReview';
import { useStore, useDispatch, useJobsHydrated } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { usePermission, useCanEditJobs } from '../hooks/usePermission';
import {
  selectCompany, selectActiveUsers, selectActiveClients, selectInvoices, selectJobs,
  selectClientById, selectServiceById, selectContactById,
  selectAgingBuckets,
  selectDashboardStats, selectJobsForUser, selectStaleLeads, selectUnansweredThreads,
  selectOutstandingQuotes, selectRevenueThisMonth, selectVarianceYesterday, selectReviews,
  selectMissedCleansThisMonth, selectLaborHoursThisWeek, selectDashboardTrends, selectComplaintKpisFromWorkOrders,
} from '../store/selectors';
import { listProblems } from '../lib/qcApi';
import * as timeApi from '../lib/timeApi';
import { fmtRelative, fmtTime, fmtTimeRange, fmtDate, fmtDateLong, money, sameDay, todayIso, dayKey, addDaysKey, startOfWeekKey, dayOfWeekKey } from '../lib/dates';

const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The greeting is a personal courtesy to whoever is reading, so it intentionally
// stays on the reader's own clock — unlike every business date, which is org-time.
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function formattedToday() {
  return fmtDateLong(todayIso()); // the business's today
}

export default function Dashboard() {
  const state = useStore();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const canInvoices = usePermission('invoices.view');
  const canSchedule = useCanEditJobs(); // the Schedule quick action: for whoever may schedule, never crew
  // Drill-down gates — a stat card is only a link when the viewer can reach its
  // list view; otherwise it renders as the plain presentational card.
  const canScheduleView = usePermission('schedule.view');
  const canVariance = usePermission('variance.view');
  const canQuotes = usePermission('quotes.view');
  // Complaints are now Work Orders (Quality hub) — the "Open Complaints" tile drills into
  // the Work Orders queue, gated by qc.view (the same perm that reveals the Quality nav).
  const canWorkOrders = usePermission('qc.view');
  const canContacts = usePermission('contacts.view');

  // Time-driven overdue sweep: 'overdue' is a derived invoice status no action
  // persists, so detect + notify newly-overdue invoices on mount. Idempotent
  // (one-shot per invoice via overdueNotifiedAt), mirroring the Schedule page's
  // TOP_UP_RECURRING_SERIES. The push-dispatch cron then carries these to phones.
  useEffect(() => { dispatch({ type: ACTIONS.MARK_INVOICES_OVERDUE }); }, [dispatch]);

  const company = selectCompany(state);
  const team = selectActiveUsers(state);
  const clients = selectActiveClients(state);
  const invoices = selectInvoices(state);
  const jobs = selectJobs(state);

  const isCrew = currentUser?.role === 'crew';
  const userJobs = isCrew && currentUser ? selectJobsForUser(state, currentUser.id) : jobs;

  const today = new Date();
  const todaysJobs = useMemo(() => userJobs.filter((j) => sameDay(j.startAt, today)).sort((a, b) => a.startAt.localeCompare(b.startAt)), [userJobs]);
  const upcoming = useMemo(() => userJobs.filter((j) => new Date(j.startAt) > new Date() && j.status === 'upcoming').sort((a, b) => a.startAt.localeCompare(b.startAt)).slice(0, 5), [userJobs]);

  const stats = selectDashboardStats(state);
  // Age-split receivables — the "Past Due 30+" card needs the 30+ slice specifically,
  // not every overdue balance. Same helper the AR aging panel on /invoices uses, so the
  // two surfaces cannot disagree.
  const aging = selectAgingBuckets(state);

  const outstandingQuotes = selectOutstandingQuotes(state);
  const revenueMonth = selectRevenueThisMonth(state);

  // Live Google review count + rating (Places API via /api/settings/google-reviews).
  const [googleReviews, setGoogleReviews] = useState(null);
  useEffect(() => {
    let alive = true;
    fetch('/api/settings/google-reviews')
      .then((r) => r.json())
      .then((d) => { if (alive && d && d.count != null) setGoogleReviews(d); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  // Open-complaints KPI is sourced from Work Orders (type:complaint) — relational, fetched
  // via qcApi, not the blob. null = still loading (tile shows "—"). Only the non-crew
  // layout renders the complaint tiles, so crew skip the fetch entirely.
  const [complaintWorkOrders, setComplaintWorkOrders] = useState(null);
  useEffect(() => {
    if (isCrew) return undefined;
    let alive = true;
    listProblems({ type: 'complaint' })
      .then((rows) => { if (alive) setComplaintWorkOrders(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (alive) setComplaintWorkOrders([]); });
    return () => { alive = false; };
  }, [isCrew]);

  // New business = clients added in the last 30 days (app-computed from the CRM).
  const newClients30d = useMemo(() => {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return clients.filter((c) => {
      const t = c.createdAt ? new Date(c.createdAt).getTime() : NaN;
      return Number.isFinite(t) && t >= cutoff;
    }).length;
  }, [clients]);

  // Financial Snapshot: when an external snapshot exists (pushed by the Google
  // Sheet via the inbound webhook) it is the source of truth; otherwise fall
  // back to the values computed from the local store.
  const snap = state.financialSnapshot;
  const cents = (v) => (typeof v === 'number' ? v / 100 : null);
  const num = (v) => (typeof v === 'number' ? v : null);
  const pick = (snapCents, computed) => (snap && snapCents != null ? cents(snapCents) : computed);
  const snapAgo = snap?.updated_at ? fmtRelative(snap.updated_at) : null;
  const sheetSource = snap ? (
    <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 500, color: 'var(--color-neutral-500)' }}>Source: Google Sheet{snapAgo ? ` · updated ${snapAgo}` : ''}</span>
  ) : null;

  // Goals — actual + target from the sheet; targets fall back to the agreed values.
  const goals = [
    { label: 'New business (30d)', actual: newClients30d, target: num(snap?.new_business_goal_count) ?? 10, fmt: (n) => `${Math.round(n)}` },
    { label: 'Google reviews', actual: googleReviews?.count ?? (num(snap?.google_reviews_actual) ?? 0), target: num(snap?.google_reviews_goal) ?? 100, fmt: (n) => String(Math.round(n)), rating: googleReviews?.rating },
    { label: 'Indeed reviews', actual: num(selectReviews(state).indeedActual) ?? 0, target: num(snap?.indeed_reviews_goal) ?? 50, fmt: (n) => String(Math.round(n)) },
  ];
  // Financial — from the sheet; computed fallback until the sheet is wired.
  const fin = {
    revenue: pick(snap?.revenue_current_month_cents, revenueMonth),
    mrr: cents(snap?.mrr_cents),
    quotes: pick(snap?.outstanding_quotes_cents, outstandingQuotes.value),
    ar: pick(snap?.ar_cents, stats.outstanding),
    // 🔴 THE LABEL SAYS "30+", SO THE NUMBER MUST MEAN 30+. The server snapshot field is
    // correctly past_due_30_cents, but the local fallback was `stats.overdue` — EVERY
    // overdue balance, including an invoice one day late. So whenever the snapshot was
    // absent (local/demo, or before it is first computed) the card overstated the 30-day
    // figure, silently, on the Dashboard someone reads to decide who to chase.
    // agingBuckets already splits this correctly; 30+ is d31_60 + d61plus.
    pastDue: pick(snap?.past_due_30_cents, aging.d31_60.amount + aging.d61plus.amount),
  };
  const variance = selectVarianceYesterday(state);
  // Complaint KPIs (open count, per-100 ratio, trend, yesterday-delta) computed over the
  // fetched Work Orders. complaintsLoading gates the tile's "—" placeholder.
  const complaintsLoading = complaintWorkOrders == null;
  const complaintKpis = useMemo(
    () => selectComplaintKpisFromWorkOrders(state, complaintWorkOrders),
    [state, complaintWorkOrders],
  );

  // Missed-cleans KPI is clock-in-aware: ask which cleans someone really clocked into over
  // the 30d count + the -60..-30 trend window. The server reads EVERY punch in the window
  // and answers with job ids (timeApi.coveredJobIds) — this used to read the history list,
  // which caps at the newest 500 punches, so at full volume most cleans looked unclocked
  // and the KPI over-counted "missed". Held in component state per timeApi's projection
  // model (never dispatched into the synced blob). null until loaded (or on a failed read)
  // so the card shows a neutral placeholder instead of a wrong count.
  const [coveredJobIds, setCoveredJobIds] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const fromIso = new Date(Date.now() - 61 * 24 * 60 * 60 * 1000).toISOString();
        const ids = await timeApi.coveredJobIds({ fromIso, toIso: new Date().toISOString() });
        if (alive) setCoveredJobIds(new Set(ids));
      } catch { /* leave null so the card stays neutral rather than showing a wrong count */ }
    })();
    return () => { alive = false; };
  }, []);

  // Q17 KPIs (were coded but rendered nowhere) + computed prior-period trends
  // that replace the old hardcoded arrows. See selectors §"WS-A".
  const missedCleans = coveredJobIds ? selectMissedCleansThisMonth(state, coveredJobIds) : null;
  const laborHours = selectLaborHoursThisWeek(state);
  // The missed-cleans trend compares against -60..-30 days (outside the boot window) and
  // needs the punch history, so it is omitted until the full job set AND the entries have
  // landed rather than computed against a partial basis (UI_RULES §40).
  const trends = selectDashboardTrends(state, { jobsFullyLoaded: useJobsHydrated(), coveredJobIds, entriesLoaded: !!coveredJobIds });

  // Short "vs prior period" trend-line text for a stat card. Color (up/down) is
  // carried separately by trendDirection; this is the numeric delta in words.
  const vsPrior = (delta, unit, period) =>
    delta === 0 ? `no change vs prior ${period}` : `${delta > 0 ? '+' : ''}${delta}${unit} vs prior ${period}`;
  const collectedTrendText = trends.collected.delta === 0
    ? 'no change vs last month'
    : `${trends.collected.delta > 0 ? '+' : '−'}${money(Math.abs(trends.collected.delta))} vs last month`;
  const companiesTrendText = trends.companies.current === 0
    ? 'no new companies (30d)'
    : `+${trends.companies.current} new in last 30d`;

  // Week revenue bucketed by day of the week (paid amounts)
  const weekRevenue = useMemo(() => {
    // Bucket by ORG calendar day. payment.date is a day-key, so match on the key
    // string — parsing it as a Date would drop it into the previous day's bar in a
    // negative-offset zone.
    const startK = startOfWeekKey(dayKey(today));
    const days = Array.from({ length: 7 }, (_, i) => {
      const key = addDaysKey(startK, i);
      return { day: DOW_SHORT[dayOfWeekKey(key)], dateKey: key, total: 0 };
    });
    invoices.forEach((inv) => {
      (inv.payments || []).forEach((p) => {
        const pk = String(p.date || '').slice(0, 10);
        const bucket = days.find((d) => d.dateKey === pk);
        if (bucket) bucket.total += Number(p.amount) || 0;
      });
    });
    const max = Math.max(1, ...days.map((d) => d.total));
    return days.map((d) => ({ ...d, height: Math.round((d.total / max) * 100) }));
  }, [invoices]);

  // Follow-ups — "what needs your attention" rollup.
  const staleLeads = useMemo(
    () => selectStaleLeads(state, { daysStale: 7 }),
    [state]
  );
  const unansweredThreads = useMemo(
    () => selectUnansweredThreads(state, { hoursStale: 24 }),
    [state]
  );
  // Merge + interleave, cap at 5 items by oldest-first (most urgent).
  const followUps = useMemo(() => {
    const items = [
      ...staleLeads.map((c) => ({
        kind: 'lead',
        id: `lead-${c.id}`,
        title: `${c.firstName} ${c.lastName}`,
        subtitle: c.lifecycle === 'lead' ? 'Lead' : 'Prospect',
        at: c.updatedAt || c.createdAt,
        href: c.companyId ? `/clients/${c.companyId}` : '/contacts',
      })),
      ...unansweredThreads.map((c) => ({
        kind: 'thread',
        id: `thread-${c.id}`,
        title: 'New message awaiting reply',
        subtitle: c.channel?.toUpperCase() || 'SMS',
        preview: c.lastPreview,
        contactId: c.contactId,
        at: c.lastInboundAt,
        href: `/messaging/${c.id}`,
      })),
    ];
    items.sort((a, b) => new Date(a.at) - new Date(b.at));
    return items.slice(0, 5);
  }, [staleLeads, unansweredThreads]);

  return (
    <>
      <div className="page-head"><h1>Dashboard</h1></div>

      {/* Client-review affordance: choose the Account-Manager Dashboard layout
          (self-gates to owner/admin; collapses to a quiet line once chosen). */}
      <DashboardLayoutReview />

      <div className="dash-hero">
            <h1>{greeting()}, {currentUser?.name?.split(' ')[0] || company.owner}</h1>
            <div className="sub">{formattedToday()}</div>
            <div className="dash-hero-stats">
              <div className="dash-hero-stat">
                <div className="val">{todaysJobs.length}</div>
                <div className="lbl">Jobs Today</div>
              </div>
              {!isCrew && (
                <>
                  <div className="dash-hero-stat">
                    <div className="val">{money(stats.collected)}</div>
                    <div className="lbl">Collected</div>
                  </div>
                  <div className="dash-hero-stat">
                    <div className="val">{stats.activeClients}</div>
                    <div className="lbl">Active Companies</div>
                  </div>
                </>
              )}
              <div className="dash-hero-stat">
                <div className="val">{upcoming.length}</div>
                <div className="lbl">Upcoming</div>
              </div>
            </div>
          </div>

          {!isCrew && (
            <>
              <div className="dash-section-title">Goals{sheetSource}</div>
              <div className="stat-grid">
                {goals.map((g) => {
                  const pct = g.target > 0 ? Math.min(100, Math.round((g.actual / g.target) * 100)) : 0;
                  return (
                    <div key={g.label} className="card" style={{ padding: '16px 18px' }}>
                      <div className="text-xs text-muted" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.04em' }}>{g.label}</div>
                      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-body)', marginTop: 4 }}>
                        {g.fmt(g.actual)}{g.rating ? <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--rating-star)', marginLeft: 6 }}>★{g.rating}</span> : null} <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--color-neutral-500)' }}>/ {g.fmt(g.target)}</span>
                      </div>
                      <div style={{ height: 6, background: 'var(--color-neutral-100)', borderRadius: 99, marginTop: 10, overflow: 'hidden' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? 'var(--color-semantic-success-500)' : 'var(--color-link)' }} />
                      </div>
                      <div className="text-xs text-muted" style={{ marginTop: 5 }}>{pct}% of goal</div>
                    </div>
                  );
                })}
              </div>

              <div className="dash-section-title">Operational Performance</div>
              <div className="stat-grid">
                <StatCard
                  value={stats.activeClients}
                  label="Current Companies"
                  trend={companiesTrendText}
                  trendDirection={trends.companies.direction}
                  to={canContacts ? '/contacts' : undefined}
                  navState={nav}
                />
                <StatCard
                  value={complaintsLoading ? '—' : complaintKpis.open}
                  label="Open Complaints"
                  trend={`${complaintKpis.ratio.toFixed(1)} per 100 cleans`}
                  trendDirection={complaintKpis.trend.direction}
                  to={canWorkOrders ? '/inspections?tab=workorders' : undefined}
                  navState={nav}
                />
                <StatCard
                  value={missedCleans ? missedCleans.count : '—'}
                  label="Missed Cleans (30d)"
                  // No arrow while the prior period is only partly loaded, or before the
                  // punch history has loaded; the impact figure shows once it has.
                  trend={missedCleans
                    ? (trends.missedCleans
                      ? `${vsPrior(trends.missedCleans.delta, '', '30d')} · ~${money(missedCleans.revenueImpact)} impact`
                      : `~${money(missedCleans.revenueImpact)} impact`)
                    : undefined}
                  trendDirection={missedCleans && trends.missedCleans ? trends.missedCleans.direction : undefined}
                  to={canScheduleView ? '/schedule?status=missed&view=Month' : undefined}
                  navState={nav}
                />
                <StatCard
                  value={`${laborHours}h`}
                  label="Labor Hours (7d)"
                  trend={vsPrior(trends.laborHours.delta, 'h', '7d')}
                  trendDirection={trends.laborHours.direction}
                  to={canVariance ? '/variance' : undefined}
                  navState={nav}
                />
                {canVariance ? (
                  <Link className="stat-card stat-card-link" to="/variance" state={nav}>
                    <Icon name="chevronRight" size={14} className="stat-card-chevron" />
                    <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                      <div>
                        <div className="stat-val">{variance.newClients}</div>
                        <div className="stat-label">Companies</div>
                      </div>
                      <div>
                        <div className="stat-val">{complaintsLoading ? '—' : complaintKpis.yesterdayDelta}</div>
                        <div className="stat-label">Complaints</div>
                      </div>
                    </div>
                    <div className="stat-label" style={{ marginTop: 8, opacity: 0.65 }}>Variance (vs yesterday)</div>
                  </Link>
                ) : (
                  <div className="stat-card">
                    <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap' }}>
                      <div>
                        <div className="stat-val">{variance.newClients}</div>
                        <div className="stat-label">Companies</div>
                      </div>
                      <div>
                        <div className="stat-val">{complaintsLoading ? '—' : complaintKpis.yesterdayDelta}</div>
                        <div className="stat-label">Complaints</div>
                      </div>
                    </div>
                    <div className="stat-label" style={{ marginTop: 8, opacity: 0.65 }}>Variance (vs yesterday)</div>
                  </div>
                )}
              </div>
            </>
          )}

          {!isCrew && canInvoices && (
            <>
              <div className="dash-section-title">Financial Snapshot{sheetSource}</div>
              <div className="stat-grid">
                {/* Collected carries a REAL month-over-month trend (computed from
                    logged payments). The point-in-time balances below have no
                    historical series in the store, so they carry no trend arrow
                    rather than a fabricated one (see UI_RULES §39). */}
                <StatCard value={money(fin.revenue)} label="Collected (this month)" trend={collectedTrendText} trendDirection={trends.collected.direction} to="/invoices?status=paid" navState={nav} />
                <StatCard value={fin.mrr != null ? money(fin.mrr) : '—'} label="MRR / Recurring" to="/invoices" navState={nav} />
                <StatCard value={money(fin.quotes)} label="Open Quotes ($)" to={canQuotes ? '/quotes' : undefined} navState={nav} />
                <StatCard value={money(fin.ar)} label="Accounts Receivable" to="/invoices?status=pending" navState={nav} />
                <StatCard value={money(fin.pastDue)} label="Past Due 30+" to="/invoices?status=overdue" navState={nav} />
              </div>
            </>
          )}

          <div className="dash-cols">
            <div>
              <div className="card dash-card">
                <div className="dash-card-title">{isCrew ? 'Your Schedule Today' : "Today's Schedule"}</div>
                {todaysJobs.length === 0 ? (
                  <EmptyState message="No jobs scheduled today." />
                ) : todaysJobs.map((job) => {
                  const client = selectClientById(state, job.clientId);
                  const service = selectServiceById(state, job.serviceId);
                  return (
                    <div key={job.id} className="sched-block clickable" onClick={() => navigate(`/schedule/${job.id}`, { state: nav })}>
                      <strong>{fmtTime(job.startAt)}</strong> · {client?.name || '—'}
                      {job.status === 'done' && <Badge variant="green">Done</Badge>}
                      {job.status === 'in_progress' && <Badge variant="amber">In Progress</Badge>}
                      {(job.status === 'missed' || (job.status !== 'done' && job.status !== 'in_progress' && new Date(job.startAt) < new Date())) && <Badge variant="red">Missed</Badge>}
                      <div className="text-xs text-muted">{service?.name || '—'}</div>
                    </div>
                  );
                })}
              </div>
              <div className="card dash-card">
                <div className="dash-card-title">Quick Actions</div>
                <div className="quick-actions">
                  {canSchedule && (
                    <button className="qa-btn" onClick={() => navigate('/schedule')}>
                      <span className="qa-icon"><Icon name="schedule" size={16} /></span>Schedule
                    </button>
                  )}
                  {canInvoices && (
                    <button className="qa-btn" onClick={() => navigate('/invoices')}>
                      <span className="qa-icon"><Icon name="invoices" size={16} /></span>Invoices
                    </button>
                  )}
                  <button className="qa-btn" onClick={() => navigate('/contacts')}>
                    <span className="qa-icon"><Icon name="clients" size={16} /></span>Customers
                  </button>
                  <button className="qa-btn" onClick={() => navigate('/messaging')}>
                    <span className="qa-icon"><Icon name="messaging" size={16} /></span>Messages
                  </button>
                </div>
              </div>
            </div>
            <div>
              <div className="card dash-card">
                <div className="dash-card-title-row">
                  <div className="dash-card-title">Follow-ups</div>
                  {(staleLeads.length + unansweredThreads.length) > followUps.length && (
                    <span className="text-xs text-muted">
                      {followUps.length} of {staleLeads.length + unansweredThreads.length}
                    </span>
                  )}
                </div>
                {followUps.length === 0 ? (
                  <EmptyState message="You're all caught up. Nothing waiting on you." />
                ) : (
                  <div className="followup-list">
                    {followUps.map((item) => {
                      const contactForThread = item.kind === 'thread' && item.contactId
                        ? selectContactById(state, item.contactId) : null;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          className="followup-row"
                          onClick={() => navigate(item.href, { state: nav })}
                        >
                          <span className={`followup-icon followup-icon-${item.kind}`}>
                            <Icon name={item.kind === 'lead' ? 'user' : 'messaging'} size={14} />
                          </span>
                          <span className="followup-body">
                            <span className="followup-primary">
                              {item.kind === 'thread' && contactForThread
                                ? `${contactForThread.firstName} ${contactForThread.lastName}`
                                : item.title}
                            </span>
                            <span className="followup-secondary text-xs text-muted">
                              {item.kind === 'thread' && item.preview
                                ? `"${item.preview.slice(0, 60)}${item.preview.length > 60 ? '…' : ''}"`
                                : item.subtitle}
                              {' · '}
                              <span>{fmtRelative(item.at)}</span>
                            </span>
                          </span>
                          <Icon name="chevronRight" size={12} />
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              {!isCrew && (
                <div className="card dash-card">
                  <div className="dash-card-title">Weekly Revenue (Paid)</div>
                  <div className="rev-chart">
                    {weekRevenue.map((d) => (
                      <div key={d.day} className="rev-bar-wrap">
                        <div className="rev-bar bar-primary" style={{ height: `${d.height}%` }} title={money(d.total)} />
                        <div className="rev-bar-lbl">{d.day}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div className="card dash-card">
                <div className="dash-card-title">{isCrew ? 'Your Upcoming' : 'Team'}</div>
                {isCrew ? (
                  upcoming.length === 0 ? (
                    <EmptyState message="No upcoming jobs." />
                  ) : upcoming.map((j) => {
                    const client = selectClientById(state, j.clientId);
                    return (
                      <div key={j.id} className="sched-block clickable" onClick={() => navigate(`/schedule/${j.id}`, { state: nav })}>
                        <strong>{fmtDate(j.startAt, { month: 'short', day: 'numeric' })}</strong> · {fmtTimeRange(j.startAt, j.endAt)}
                        <div className="text-xs text-muted">{client?.name}</div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    {team.slice(0, 5).map((t) => (
                      <div key={t.id} style={{ textAlign: 'center' }}>
                        <Avatar initials={t.initials} variant={t.avatar} size="md" />
                        <div className="text-xs" style={{ marginTop: 4 }}>{t.name.split(' ')[0]}</div>
                        <div className="text-xs text-muted">{t.status}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
    </>
  );
}
