import { mockVars } from '../brandTheme';
import '../demo.css';

// Abbreviated, self-contained PolishPoint dashboard mock used only inside the
// checkout preview modal's device frames. It's fully themed from a palette's real
// tokens (mockVars) so a prospect sees what their platform looks like in each
// brand, without us having to reskin the live app. `variant` switches between the
// desktop (sidebar + grid) and mobile (stacked) layouts.

const STATS = [
  { label: 'This week', value: '$4,820', delta: '▲ 12%' },
  { label: 'Jobs today', value: '7', delta: '▲ 2' },
  { label: 'Open invoices', value: '3', delta: '$1,140' },
];

const SCHEDULE = [
  { time: '9:00', who: 'Acme Offices', tag: 'Done' },
  { time: '11:30', who: 'Riverside Dental', tag: 'En route' },
  { time: '2:15', who: 'Lumen Studios', tag: 'Scheduled' },
];

const BARS = [42, 60, 38, 72, 55, 88, 64];

export default function MockDashboard({ themeKey, variant = 'desktop' }) {
  const mobile = variant === 'mobile';

  const chart = (
    <div className="pp-mock-card">
      <span className="pp-mock-card-h">Revenue · last 7 days</span>
      <div className="pp-mock-bars">
        {BARS.map((h, i) => <i key={i} style={{ height: `${h}%` }} />)}
      </div>
    </div>
  );

  const schedule = (
    <div className="pp-mock-card">
      <span className="pp-mock-card-h">Today’s schedule</span>
      <div className="pp-mock-list">
        {(mobile ? SCHEDULE.slice(0, 2) : SCHEDULE).map((s, i) => (
          <div key={i} className="pp-mock-li">
            <span className="pp-mock-av" />
            <span className="pp-mock-li-text"><b>{s.time}</b> · {s.who}</span>
            <span className="pp-mock-badge">{s.tag}</span>
          </div>
        ))}
      </div>
    </div>
  );

  const stats = (n) => (
    <div className="pp-mock-stats">
      {STATS.slice(0, n).map((s) => (
        <div key={s.label} className="pp-mock-stat">
          <span className="pp-mock-stat-label">{s.label}</span>
          <span className="pp-mock-stat-num">{s.value}</span>
          <span className="pp-mock-stat-delta">{s.delta}</span>
        </div>
      ))}
    </div>
  );

  if (mobile) {
    return (
      <div className="pp-mock pp-mock-mobile" style={mockVars(themeKey)}>
        <div className="pp-mock-topbar">
          <span className="pp-mock-burger" aria-hidden="true"><i /><i /><i /></span>
          <span className="pp-mock-title">Dashboard</span>
          <span className="pp-mock-avatar" />
        </div>
        <div className="pp-mock-body">
          <button className="pp-mock-btn pp-mock-btn-block" type="button" tabIndex={-1}>+ New job</button>
          {stats(2)}
          {chart}
          {schedule}
        </div>
      </div>
    );
  }

  return (
    <div className="pp-mock pp-mock-desktop" style={mockVars(themeKey)}>
      <aside className="pp-mock-side">
        <div className="pp-mock-brand"><span className="pp-mock-logo" />PolishPoint</div>
        <div className="pp-mock-nav">
          {['Dashboard', 'Schedule', 'Contacts', 'Pipeline', 'Invoices'].map((n, i) => (
            <span key={n} className={`pp-mock-navitem${i === 0 ? ' is-active' : ''}`}><i />{n}</span>
          ))}
        </div>
      </aside>
      <div className="pp-mock-main">
        <div className="pp-mock-top">
          <span className="pp-mock-title">Dashboard</span>
          <button className="pp-mock-btn" type="button" tabIndex={-1}>+ New job</button>
        </div>
        {stats(3)}
        <div className="pp-mock-grid">
          {chart}
          {schedule}
        </div>
      </div>
    </div>
  );
}
