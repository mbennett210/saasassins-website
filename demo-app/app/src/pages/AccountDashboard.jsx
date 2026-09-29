import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { PREVIEW_ACCOUNTS, accountsByRisk } from '../data/dashboardLayoutPreview';
import { VariantC, VariantD } from '../components/dashboardLayouts';
import { fmtDateLong, todayIso } from '../lib/dates';

// The Account-Manager Dashboard as a LIVE, full-page home surface, varied by role
// (App.jsx HomeRoute): Super Admin (owner) lands on variant C, the KPI Cockpit; Manager
// lands on variant D, the Health Triage. Admin keeps the operational pages/Dashboard.jsx;
// crew have no dashboard.view and are redirected to /my-day.
//
// It renders the shared variant components (components/dashboardLayouts.jsx, the same
// renderers the client-review picker previews) over the design-phase preview data
// (data/dashboardLayoutPreview.js). When the real QuickBooks Online feed lands, swap
// the data source in those components; this page (chrome + selection state) is
// unaffected.

// Personal courtesy greeting, intentionally on the reader's own clock, matching
// pages/Dashboard.jsx (every business date stays org-time).
function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// Fixed reporting window for the live dashboard: the standing 30-day book view. The
// range switcher (Today/10d/15d/30d/All-time) lives on the client-review PICKER only,
// not on the dashboard itself, to keep the home page clean.
const RANGE = 'd30';

export default function AccountDashboard({ variant }) {
  const { currentUser } = useAuth();
  // C's cockpit opens on the most at-risk account (worst GPM first) so the problem
  // account is in view without a click. D groups everything, so it ignores this.
  const [cSel, setCSel] = useState(() => accountsByRisk()[0]?.id || PREVIEW_ACCOUNTS[0].id);

  const firstName = currentUser?.name?.split(' ')[0] || '';

  return (
    <>
      <div className="page-head"><h1>Dashboard</h1></div>

      <div className="acct-dash">
        <div className="acct-dash-head">
          <div className="acct-dash-greet-wrap">
            <div className="acct-dash-greet">{greeting()}{firstName ? `, ${firstName}` : ''}</div>
            <div className="acct-dash-sub">{fmtDateLong(todayIso())} · Your book, {PREVIEW_ACCOUNTS.length} accounts</div>
          </div>
        </div>

        {variant === 'D'
          ? <VariantD range={RANGE} />
          : <VariantC range={RANGE} cSel={cSel} onSel={setCSel} />}
      </div>
    </>
  );
}
