import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Badge, { statusBadgeVariant } from '../components/Badge';
import StatCard from '../components/StatCard';
import Avatar from '../components/Avatar';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import {
  selectCompany, selectActiveUsers, selectActiveClients, selectInvoices, selectJobs,
  selectClientById, selectServiceById, selectSiteById, selectContactById,
  selectDashboardStats, selectJobsForUser, selectStaleLeads, selectUnansweredThreads,
  selectMissedCleansThisMonth, selectLaborHoursThisWeek,
  selectOutstandingQuotes, selectRevenueThisMonth,
} from '../store/selectors';
import { fmtRelative, fmtTime, fmtTimeRange, money, sameDay, startOfWeek } from '../lib/dates';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function formattedToday() {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export default function Dashboard() {
  const state = useStore();
  const navigate = useNavigate();
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const canInvoices = usePermission('invoices.view');
  const canSchedule = usePermission('schedule.edit');

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

  // Operations KPIs
  const missed = selectMissedCleansThisMonth(state);
  const laborHrs = selectLaborHoursThisWeek(state);
  const outstandingQuotes = selectOutstandingQuotes(state);
  const revenueMonth = selectRevenueThisMonth(state);

  // Week revenue bucketed by day of the week (paid amounts)
  const weekRevenue = useMemo(() => {
    const start = startOfWeek(today);
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start); d.setDate(d.getDate() + i);
      return { day: d.toLocaleDateString(undefined, { weekday: 'short' }), date: d, total: 0 };
    });
    invoices.forEach((inv) => {
      (inv.payments || []).forEach((p) => {
        const pd = new Date(p.date);
        days.forEach((d) => {
          if (sameDay(d.date, pd)) d.total += Number(p.amount) || 0;
        });
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
        subtitle: `${c.lifecycle === 'lead' ? 'Lead' : 'Prospect'}${c.stage ? ` · ${c.stage}` : ''}`,
        at: c.updatedAt || c.createdAt,
        href: `/contacts/${c.id}`,
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
                    <div className="lbl">Active Clients</div>
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
              <div className="dash-section-title">Operational Performance</div>
              <div className="stat-grid">
                <StatCard
                  value={missed.count}
                  label="Missed Cleans (30d)"
                  trend={missed.revenueImpact > 0 ? `${money(missed.revenueImpact)} impact` : 'Clean week'}
                  trendDirection={missed.count > 0 ? 'down' : 'up'}
                />
                <StatCard
                  value={`${laborHrs} hrs`}
                  label="Labor Hours (this week)"
                  trend={laborHrs > 0 ? `${(laborHrs / 7).toFixed(1)} hrs/day avg` : 'No completed jobs yet'}
                  trendDirection="up"
                />
              </div>
            </>
          )}

          {!isCrew && canInvoices && (
            <>
              <div className="dash-section-title">Financial Snapshot</div>
              <div className="stat-grid">
                <StatCard
                  value={money(revenueMonth)}
                  label="Revenue (this month)"
                  trendDirection="up"
                />
                <StatCard
                  value={money(stats.outstanding)}
                  label="Open Receivables"
                  trend={`${stats.outstandingCount} pending invoice${stats.outstandingCount === 1 ? '' : 's'}`}
                  trendDirection={stats.outstandingCount > 0 ? 'down' : 'up'}
                />
                <StatCard
                  value={money(stats.collected)}
                  label="$ Collected (all time)"
                  trendDirection="up"
                />
                <StatCard
                  value={money(outstandingQuotes.value)}
                  label="Outstanding Quotes"
                  trend={`${outstandingQuotes.count} quote${outstandingQuotes.count === 1 ? '' : 's'} sent`}
                  trendDirection={outstandingQuotes.count > 0 ? 'up' : 'down'}
                />
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
                  const site = selectSiteById(state, job.siteId);
                  return (
                    <div key={job.id} className="sched-block clickable" onClick={() => navigate(`/schedule/${job.id}`, { state: nav })}>
                      <strong>{fmtTime(job.startAt)}</strong> — {client?.name || '—'}
                      {job.status === 'done' && <Badge variant="green">Done</Badge>}
                      {job.status === 'in_progress' && <Badge variant="amber">In Progress</Badge>}
                      {(job.status === 'missed' || (job.status !== 'done' && job.status !== 'in_progress' && new Date(job.startAt) < new Date())) && <Badge variant="red">Missed</Badge>}
                      <div className="text-xs text-muted">{service?.name || '—'}{site ? ` · ${site.name}` : ''}</div>
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
                    <span className="qa-icon"><Icon name="clients" size={16} /></span>Contacts
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
                        <div className="rev-bar bar-blue" style={{ height: `${d.height}%` }} title={money(d.total)} />
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
                        <strong>{new Date(j.startAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</strong> · {fmtTimeRange(j.startAt, j.endAt)}
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
