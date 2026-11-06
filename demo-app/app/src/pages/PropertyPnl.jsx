// Property P&L — the QuickBooks profit & loss per property, on its own page (the manager view
// redesign, Daniel's D3, 2026-10-09: "Keep it."). Until then it WAS the manager's home (the Health
// Triage board, AccountDashboard variant D); the manager now lands on pages/ManagerHome, whose
// "Property P&L" tile opens this page. Same board, same period picker (`?window=`), same data
// rules (useQboBook: the live book in the viewer's scope once QuickBooks is connected, else the
// preview) — only the page's name and its back pill are its own. Gated financials.view in
// App.jsx, the key the board's money already follows.
import BackLink from '../components/BackLink';
import AccountDashboard from './AccountDashboard';
import { useT } from '../i18n/react';

export default function PropertyPnl() {
  const t = useT();
  return (
    <AccountDashboard
      variant="D"
      title={t('nav.propertyPnl')}
      back={<div className="detail-head-top"><BackLink to="/" label={t('nav.dashboard')} /></div>}
    />
  );
}
