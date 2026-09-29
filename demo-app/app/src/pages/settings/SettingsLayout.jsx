// Settings shell. `/settings` renders the hub (SettingsHub); every child route
// renders FULL-WIDTH beneath a back link.
//
// The old shell carried a flat row of 12 pills on every settings page. It is gone —
// see `settingsNav.js` for the reasoning. The nav now lives on the landing page,
// which means a settings page gets the whole content width instead of sharing it
// with a permanent navigation strip.
//
// 🔴 THE SHELL DOES NOT RENDER THE SUB-PAGE'S TITLE. Every settings page already
// renders its own `page-head` with its own h1 and description — adding one here
// printed "Availability" twice, with two descriptions under it. The shell owns the
// way BACK; the page owns what it is called.
//
// It also renders no centred head. A centred title was right above the old centred pill
// row and wrong above left-aligned card groups. The `.settings-page-head` class that did
// the centring was deleted 2026-07-27 (playbook audit §5.2): it had ZERO consumers. This
// comment previously claimed "Marketing still uses it" — Marketing.jsx says the opposite
// in its own comment, and that false claim is the reason a grep made the class look live.
import { Outlet, useLocation } from 'react-router-dom';
import BackLink from '../../components/BackLink';
import { findSettingsEntry } from './settingsNav';

export default function SettingsLayout() {
  const { pathname } = useLocation();
  const onHub = !findSettingsEntry(pathname);
  // A nested detail route (e.g. /settings/team/:userId) renders its OWN DetailHeader
  // with the back pill, so the shell must not add a second back link on top of it
  // (UI_RULES §108 — one back pill per page).
  const isDetail = pathname.replace(/^\/+settings\/?/, '').split('/').filter(Boolean).length > 1;

  return (
    <div className="settings-shell">
      {onHub ? (
        <div className="page-head">
          <div className="page-head-text">
            <h1 className="page-head-title">Settings</h1>
            <p className="page-sub">Everything you can configure, grouped by what it affects.</p>
          </div>
        </div>
      ) : isDetail ? null : (
        // 🔴 THE HUB IS NOT THE ONLY ROUTE IN — that claim used to be here and it was
        // stale. `Purchasing.jsx` links straight to `/settings/suppliers` (and passes a
        // referrer correctly), but this hardcoded `<Link to="/settings">` threw it away,
        // so "Manage" led to a back arrow that said "Settings" and went somewhere the
        // user had never been. Now the referrer wins and `/settings` is only the fallback
        // for a direct URL or refresh. Daniel, 2026-07-28.
        <BackLink to="/settings" label="Settings" className="set-back" />
      )}
      <div className="settings-content">
        <Outlet />
      </div>
    </div>
  );
}
