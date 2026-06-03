import { useMemo } from 'react';
import { computeTokens, toCss, BASE } from './themeEngine';
import './miniApp.css';

// MiniApp — a compact, faithful PolishPoint app surface, ported from
// Client-theme-picker/shared/MiniApp.jsx (the canonical theme-picker mini app).
// Themed entirely from each swatchboard's design language via themeEngine, scoped
// so multiple instances (desktop + mobile) coexist. Rendered at real proportions
// and scaled into device frames by ScaledPreview.
//
// Props: scope (CSS selector e.g. '.ppd-blue'), theme ('blue'|'forge'|'midnight'
// |'pink'), overrides, brandName, brandInitials, screen, device ('desktop'|'mobile').

const SCHEDULE = [
  { time: '9:00 AM', client: 'Metro Medical Center', service: 'Janitorial · Main Hospital', status: 'In Progress' },
  { time: '11:30 AM', client: 'Lakeside Office Park', service: 'Floor Care · Main Campus', status: 'Pending' },
  { time: '2:00 PM', client: 'Pacific Ridge Corp', service: 'Janitorial · HQ', status: 'Pending' },
  { time: '4:30 PM', client: 'Greenfield HOA', service: 'Window Cleaning · Bldg A', status: 'Pending' },
];
const REV_WEEK = [48, 72, 36, 88, 64, 22, 10];
const CLIENTS = [
  { name: 'Metro Medical Center', contact: 'Pat Ramirez', freq: 'Weekly', status: 'Active', revenue: 4800, initials: 'MM', av: 1 },
  { name: 'Lakeside Office Park', contact: 'Morgan Choi', freq: 'Monthly', status: 'Active', revenue: 2200, initials: 'LO', av: 2 },
  { name: 'Pacific Ridge Corp', contact: 'Kim Nelson', freq: 'Bi-Weekly', status: 'Active', revenue: 3400, initials: 'PR', av: 5 },
  { name: 'Greenfield HOA', contact: 'Sasha Lin', freq: 'Monthly', status: 'Active', revenue: 1100, initials: 'GH', av: 4 },
  { name: 'Harbor Distillery', contact: 'Jordan Price', freq: 'Weekly', status: 'Active', revenue: 2900, initials: 'HD', av: 3 },
];
const INVOICES = [
  { num: 'INV-0044', client: 'Metro Medical Center', issued: 'Apr 18', due: 'May 02', amount: 4800, status: 'Paid', av: 1, initials: 'MM' },
  { num: 'INV-0043', client: 'Lakeside Office Park', issued: 'Apr 15', due: 'Apr 29', amount: 2200, status: 'Pending', av: 2, initials: 'LO' },
  { num: 'INV-0042', client: 'Pacific Ridge Corp', issued: 'Apr 10', due: 'Apr 24', amount: 3400, status: 'Overdue', av: 5, initials: 'PR' },
  { num: 'INV-0041', client: 'Greenfield HOA', issued: 'Apr 08', due: 'Apr 22', amount: 1100, status: 'Paid', av: 4, initials: 'GH' },
];
const PIPELINE = {
  'New Lead': [
    { name: 'Northgate Apartments', value: 3200, contact: 'D. Wallace', initials: 'NA', av: 1 },
    { name: 'Ridgewood Dental', value: 900, contact: 'K. Park', initials: 'RD', av: 2 },
  ],
  Qualified: [{ name: 'Baker Street Foods', value: 2400, contact: 'M. Ortiz', initials: 'BS', av: 5 }],
  Quoted: [
    { name: 'Summit Coworking', value: 4100, contact: 'J. Torres', initials: 'SC', av: 3 },
    { name: 'Willow Creek Church', value: 1400, contact: 'R. Singh', initials: 'WC', av: 4 },
  ],
  Won: [{ name: 'Harbor Distillery', value: 2900, contact: 'J. Price', initials: 'HD', av: 3 }],
};
const THREADS = [
  { name: 'Pat Ramirez', preview: "I'll meet you at the dock at 7.", av: 1, initials: 'PR' },
  { name: 'Morgan Choi', preview: 'Can we reschedule to Thursday?', av: 2, initials: 'MC' },
  { name: 'Kim Nelson', preview: 'Following up on INV-0040.', av: 5, initials: 'KN' },
];

const statusVariant = (s) => ({ Paid: 'green', Active: 'green', Pending: 'amber', 'In Progress': 'blue', Overdue: 'red', Inactive: 'slate' }[s] || 'slate');
const money = (n) => '$' + n.toLocaleString();

function NavIcon({ name }) {
  const paths = {
    dashboard: <g><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></g>,
    schedule: <path d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75" />,
    clients: <path d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />,
    invoices: <path d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />,
    messaging: <path d="M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />,
    settings: <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.991l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124M15 12a3 3 0 11-6 0 3 3 0 016 0z" />,
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

const NAV = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'clients', label: 'Clients' },
  { key: 'invoices', label: 'Invoices' },
  { key: 'messaging', label: 'Messaging' },
  { key: 'crm', label: 'CRM Pipeline' },
  { key: 'reminders', label: 'Reminders' },
  { key: 'settings', label: 'Settings' },
];
const getNavIconKey = (k) => (k === 'crm' ? 'clients' : k === 'reminders' ? 'schedule' : k);

function MiniSidebar({ active, brandName, brandInitials }) {
  return (
    <aside className="ma-sidebar">
      <div className="ma-brand">
        <div className="ma-brand-logo">{brandInitials}</div>
        <div className="ma-brand-txt">
          <div className="ma-brand-nm">{brandName}</div>
          <div className="ma-brand-kicker">PLATFORM</div>
        </div>
      </div>
      <nav className="ma-nav">
        {NAV.map((n) => (
          <div key={n.key} className={`ma-nav-btn ${active === n.key ? 'active' : ''}`}>
            <NavIcon name={getNavIconKey(n.key)} /><span>{n.label}</span>
          </div>
        ))}
      </nav>
      <div className="ma-sidebar-foot">
        <div className="ma-user">
          <div className="ma-user-av">AM</div>
          <div><div className="ma-user-nm">Alex Morgan</div><div className="ma-user-rl">Owner</div></div>
        </div>
      </div>
    </aside>
  );
}

function Badge({ children, variant }) { return <span className={`ma-badge ${variant}`}>{children}</span>; }
function Avatar({ variant, initials }) { return <div className={`ma-av av-${variant}`}>{initials}</div>; }

function Dashboard() {
  return (
    <>
      <div className="ma-page-head">
        <h1>Dashboard</h1>
        <div className="ma-switcher">
          <div className="ma-sw-btn active">Overview</div>
          <div className="ma-sw-btn">Metrics</div>
        </div>
      </div>
      <div className="ma-hero">
        <h2>Good morning, Alex</h2>
        <div className="ma-hero-sub">Monday, April 20, 2026</div>
        <div className="ma-hero-stats">
          <div><div className="ma-stat-val">4</div><div className="ma-stat-lbl">Jobs Today</div></div>
          <div><div className="ma-stat-val">$11,500</div><div className="ma-stat-lbl">Collected</div></div>
          <div><div className="ma-stat-val">7</div><div className="ma-stat-lbl">Clients</div></div>
          <div><div className="ma-stat-val">2</div><div className="ma-stat-lbl">Overdue</div></div>
        </div>
      </div>
      <div className="ma-cols">
        <div className="ma-card">
          <div className="ma-card-title">Today's Schedule</div>
          {SCHEDULE.slice(0, 3).map((s, i) => (
            <div key={i} className="ma-sched">
              <div className="ma-sched-line"><strong>{s.time}</strong> — {s.client} <Badge variant={statusVariant(s.status)}>{s.status}</Badge></div>
              <div className="ma-sched-meta">{s.service}</div>
            </div>
          ))}
        </div>
        <div className="ma-card">
          <div className="ma-card-title">Weekly Revenue</div>
          <div className="ma-chart">
            {REV_WEEK.map((p, i) => (
              <div key={i} className="ma-bar-wrap">
                <div className="ma-bar" style={{ height: `${Math.max(p, 4)}%` }} />
                <div className="ma-bar-lbl">{['M', 'T', 'W', 'T', 'F', 'S', 'S'][i]}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function SchedulePage() {
  return (
    <>
      <div className="ma-page-head"><h1>Schedule</h1><div style={{ flex: 1 }} /><div className="ma-btn primary">+ New Job</div></div>
      <div className="ma-card">
        <div className="ma-card-title">Monday, April 20</div>
        {SCHEDULE.map((s, i) => (
          <div key={i} className="ma-sched">
            <div className="ma-sched-line"><strong>{s.time}</strong> — {s.client} <Badge variant={statusVariant(s.status)}>{s.status}</Badge></div>
            <div className="ma-sched-meta">{s.service}</div>
          </div>
        ))}
      </div>
    </>
  );
}

function ClientsPage() {
  return (
    <>
      <div className="ma-page-head"><h1>Clients</h1><div style={{ flex: 1 }} /><div className="ma-btn primary">+ New Client</div></div>
      <div className="ma-card-flat">
        <table className="ma-table">
          <thead><tr><th>Client</th><th>Contact</th><th>Freq</th><th>Status</th><th className="r">Revenue</th></tr></thead>
          <tbody>
            {CLIENTS.map((c, i) => (
              <tr key={i}>
                <td className="ma-name"><Avatar variant={c.av} initials={c.initials} />{c.name}</td>
                <td>{c.contact}</td>
                <td>{c.freq}</td>
                <td><Badge variant={statusVariant(c.status)}>{c.status}</Badge></td>
                <td className="r money">{money(c.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function MessagingPage() {
  return (
    <>
      <div className="ma-page-head"><h1>Messaging</h1></div>
      <div className="ma-msg">
        <div className="ma-msg-list">
          <div className="ma-msg-head">CONVERSATIONS</div>
          {THREADS.map((t, i) => (
            <div key={i} className={`ma-msg-item ${i === 0 ? 'active' : ''}`}>
              <Avatar variant={t.av} initials={t.initials} />
              <div><div className="ma-msg-nm">{t.name}</div><div className="ma-msg-pv">{t.preview}</div></div>
            </div>
          ))}
        </div>
        <div className="ma-msg-thread">
          <div className="ma-msg-thead"><Avatar variant={1} initials="PR" /><div className="ma-msg-nm">Pat Ramirez</div></div>
          <div className="ma-msg-body">
            <div className="ma-bubble them">Hey — confirming tomorrow at 7 AM?</div>
            <div className="ma-bubble me">Yes, Sam and Riley are on. We'll be at Dock B.</div>
            <div className="ma-bubble them">I'll meet you at the loading dock at 7.</div>
          </div>
          <div className="ma-msg-composer"><div className="ma-input">Type a message...</div><div className="ma-btn primary">Send</div></div>
        </div>
      </div>
    </>
  );
}

function InvoicesPage() {
  return (
    <>
      <div className="ma-page-head">
        <h1>Invoices</h1>
        <div className="ma-switcher"><div className="ma-sw-btn active">All</div><div className="ma-sw-btn">Unpaid</div><div className="ma-sw-btn">Paid</div></div>
        <div style={{ flex: 1 }} /><div className="ma-btn primary">+ New Invoice</div>
      </div>
      <div className="ma-cols">
        <div className="ma-card"><div className="ma-card-title">Outstanding</div><div className="ma-stat-val">$5,600</div><div className="ma-stat-lbl">Across 2 invoices</div></div>
        <div className="ma-card"><div className="ma-card-title">Collected (30d)</div><div className="ma-stat-val">$11,500</div><div className="ma-stat-lbl">+18% vs last mo</div></div>
        <div className="ma-card"><div className="ma-card-title">Overdue</div><div className="ma-stat-val" style={{ color: 'var(--badge-red)' }}>$3,400</div><div className="ma-stat-lbl">1 invoice · 5 days</div></div>
      </div>
      <div className="ma-card-flat">
        <table className="ma-table">
          <thead><tr><th>Invoice</th><th>Client</th><th>Issued</th><th>Due</th><th>Status</th><th className="r">Amount</th></tr></thead>
          <tbody>
            {INVOICES.map((inv, i) => (
              <tr key={i}>
                <td className="ma-name" style={{ fontFamily: 'ui-monospace, monospace', fontSize: '9px' }}>{inv.num}</td>
                <td className="ma-name"><Avatar variant={inv.av} initials={inv.initials} />{inv.client}</td>
                <td>{inv.issued}</td>
                <td>{inv.due}</td>
                <td><Badge variant={statusVariant(inv.status)}>{inv.status}</Badge></td>
                <td className="r money">{money(inv.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CRMPage() {
  const cols = Object.keys(PIPELINE);
  return (
    <>
      <div className="ma-page-head"><h1>CRM Pipeline</h1><div style={{ flex: 1 }} /><div className="ma-btn primary">+ New Lead</div></div>
      <div className="ma-kanban">
        {cols.map((col) => (
          <div key={col} className="ma-col">
            <div className="ma-col-head"><span>{col}</span><span className="ma-col-count">{PIPELINE[col].length}</span></div>
            {PIPELINE[col].map((d, i) => (
              <div key={i} className="ma-deal">
                <div className="ma-deal-name">{d.name}</div>
                <div className="ma-deal-meta"><Avatar variant={d.av} initials={d.initials} />{d.contact}</div>
                <div className="ma-deal-val">{money(d.value)}</div>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

const SCREENS = { schedule: SchedulePage, clients: ClientsPage, messaging: MessagingPage, invoices: InvoicesPage, crm: CRMPage };
const MOBILE_TABS = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'clients', label: 'Clients' },
  { key: 'invoices', label: 'Invoices' },
];

export default function MiniApp({ scope, theme, overrides, brandName = 'PolishPoint', brandInitials = 'PP', screen, device = 'desktop' }) {
  const css = useMemo(() => toCss(computeTokens(theme, overrides || {}), scope), [scope, theme, overrides]);
  const kind = (BASE[theme] || BASE.blue).kind;
  const Screen = SCREENS[screen] || Dashboard;
  const content = <Screen />;

  if (device === 'mobile') {
    return (
      <>
        <style dangerouslySetInnerHTML={{ __html: css }} />
        <div className={`mini-app ma-mobile ${scope.slice(1)}`} data-minitheme-kind={kind}>
          <div className="ma-topbar">
            <span className="ma-mob-burger" aria-hidden="true"><i /><i /><i /></span>
            <span className="ma-mob-title">{brandName}</span>
            <span className="ma-mob-av">AM</span>
          </div>
          <main className="ma-main">{content}</main>
          <div className="ma-tabbar">
            {MOBILE_TABS.map((tab) => (
              <div key={tab.key} className={(screen || 'dashboard') === tab.key ? 'active' : ''}>
                <NavIcon name={getNavIconKey(tab.key)} /><span>{tab.label}</span>
              </div>
            ))}
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div className={`mini-app ${scope.slice(1)}`} data-minitheme-kind={kind}>
        <MiniSidebar active={screen || 'dashboard'} brandName={brandName} brandInitials={brandInitials} />
        <main className="ma-main">{content}</main>
      </div>
    </>
  );
}
