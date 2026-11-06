import { Link, Outlet, useLocation } from 'react-router-dom';
import { LIGHT_LOGO_URL, SIDEBAR_LOGO_URL } from '../brand/logo.js';
import { IDENTITY } from '../brand/identity.generated.js';
import Badge from '../components/Badge';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import { useFromHere } from '../hooks/useFromHere';
import {
  hubNavMain, hubNavBottom, hubNavTabs, hubNavHref, hubNavActive, buildingPath, sectionPath,
} from '../pages/hub/hubNav';
import { HUB_BELL } from '../pages/hub/hubSlots';
import { useHubUpdates } from '../pages/hub/hubUpdates';
import { hubPreviewBanner, hubPreviewActsAsCustomer } from '../lib/hubPreview';

// THE CUSTOMER HUB'S SHELL — deliberately NOT AppLayout (the client hub redesign, Matt's design,
// plan §3.1, 2026-10-08).
//
// A client login has no office nav, no global search and no shared store: AppLayout's nav is a
// list of pages the server refuses them, and StoreProvider would sit behind it retrying a 403. So
// the hub has its own chrome, from Matt's boards, in our theme (UI_RULES §121, §129):
//   · DESKTOP (the office shell's breakpoint, over 640px): a dark sidebar — the software's mark,
//     the building's sections (pages/hub/hubNav.js, the ONE list) with the Requests count and the
//     "On site" pill, a divider, then Messages and Account;
//   · PHONE: Home carries a top bar (the mark and the bell); every page has the bottom tabs
//     (Home · Messages · Account, the same list), and Home a "New request" button above them.
//   · the © footer is the company's (decision D1: the mark is the software's, the footer the
//     company's).
// Each page draws its own heading: Home its greeting and the property switcher, a section page
// "‹ Back to Dashboard", its title and the building.
//
// THE BUILDING IN VIEW comes from HubRoot: the URL's building when it is one of this login's (the
// server's scope, through the view), its Home read (the crew band, the counts) and the building
// to send the nav to off a building's page (the remembered one, else the first). A building the
// login cannot see is "Building not found" here, before any section asks the server.
//
// TWO KINDS OF "NO CUSTOMER SIGNED IN" (the outlet context carries both), and ONE derived flag:
//   · `demo` — the login-free demo (a demo build only, HubRoot). There is no session to sign out
//     of, so the way out goes back to the office demo, and a strip says it is a preview. Its writes
//     are the demo's own (lib/hubDemo.js), so they stay live for Daniel to try.
//   · `preview` — the OFFICE's "Preview as customer" (plan §3.7, UI_RULES §151): a staff member
//     using one building's hub. The banner says so in one sentence with "Exit preview". Since
//     2026-10-09 it ACTS as the building's customer (lib/hubPreview.js HUB_PREVIEW_ACTS_AS_CUSTOMER):
//     every write works and is real, so the banner says that.
//   · `readOnly` = preview && !the switch — the ONE flag every write control reads (no screen
//     decides on its own): compose, New request, reopen, photos, the bell's "seen", the email
//     switches. True only for the read-only preview (the switch off), where each is drawn disabled
//     with HUB_PREVIEW_NOTE and the server refuses the writes anyway (403 preview-read-only). A
//     slot or a card is handed `readOnly` as a prop for the same reason. (Change password stays off
//     in ANY preview or the demo: there is no login to change — HubAccount's own rule.)
const PRODUCT = IDENTITY.product.name;

export default function HubLayout({
  viewerName = '', viewerKey = '', hub = null, loading = false, error = '', onRetry = null,
  demo = false, preview = null, onExitPreview = null,
  building = null, buildingId = null, currentId = null, home = null,
}) {
  const { pathname } = useLocation();
  const nav = useFromHere();
  // The bell's answer, read once for the hub (pages/hub/hubUpdates.js): the Messages badge reads it.
  const updates = useHubUpdates(viewerKey);
  const navId = building?.id || currentId || null;
  const homeData = home?.data || null;
  const isHome = !!building && pathname === buildingPath(building.id);
  const previewing = !!preview;
  const readOnly = previewing && !hubPreviewActsAsCustomer();
  // The previewed building's name: the server's, once the view is in; the entry point's until then.
  const previewName = (Array.isArray(hub?.buildings) && hub.buildings[0]?.name) || preview?.name || '';
  const ctx = {
    hub, loading, error, onRetry, preview: previewing, readOnly, demo, exitPreview: onExitPreview, viewerKey,
    buildings: Array.isArray(hub?.buildings) ? hub.buildings : [],
    building, buildingId, currentId,
    home: homeData, homeRead: home,
    updates: updates.data,
  };

  const item = (e, cls) => {
    const active = hubNavActive(e, pathname);
    const badge = typeof e.badge === 'function' ? e.badge(ctx) : null;
    const to = hubNavHref(e, navId);
    return (
      <Link key={e.key} className={`${cls}${active ? ' is-active' : ''}`} to={to} state={nav} aria-current={active ? 'page' : undefined}>
        <Icon name={e.icon} size={cls === 'hub-tab' ? 22 : 18} />
        <span className={`${cls}-label`}>{e.label}</span>
        {badge && cls === 'hub-nav-item' && <span className="hub-nav-badge"><Badge variant={badge.variant}>{badge.text}</Badge></span>}
        {badge && cls === 'hub-tab' && <span className="hub-tab-badge">{badge.text}<span className="sr-only"> new</span></span>}
      </Link>
    );
  };

  // A building named in the URL that this login cannot see, once the view is in.
  const unknown = !loading && !error && buildingId && !building;

  return (
    <div className={`hub-shell${previewing || demo ? ' is-preview' : ''}`}>
      <aside className="hub-side" aria-label="Customer hub">
        {/* the software's logo for the dark rail (UI_RULES §129); the © footer is the company's */}
        <div className="hub-side-brand"><img className="hub-logo" src={SIDEBAR_LOGO_URL} alt={PRODUCT} /></div>
        <nav className="hub-nav">{hubNavMain().map((e) => item(e, 'hub-nav-item'))}</nav>
        <div className="hub-nav-rule" role="separator" />
        <nav className="hub-nav hub-nav-bottom">{hubNavBottom().map((e) => item(e, 'hub-nav-item'))}</nav>
      </aside>

      <div className="hub-body">
        {previewing ? (
          <div className="hub-preview text-sm" role="region" aria-label="Preview">
            <span className="hub-preview-text">{hubPreviewBanner(previewName)}</span>
            {onExitPreview && <button type="button" className="btn btn-outline" onClick={onExitPreview}>Exit preview</button>}
          </div>
        ) : demo && (
          <div className="hub-preview text-sm">
            <Badge variant="amber">Preview</Badge>
            <span className="hub-preview-text">{viewerName ? `You're seeing the customer hub as ${viewerName}.` : "You're seeing the customer hub."}</span>
            <Link className="btn btn-outline" to="/">Back to the office</Link>
          </div>
        )}
        {isHome && (
          <header className="hub-topbar">
            <img className="hub-topbar-logo" src={LIGHT_LOGO_URL} alt={PRODUCT} />
            <div className="hub-topbar-end">
              {HUB_BELL.map((a) => <a.Component key={a.key} building={building} preview={previewing} readOnly={readOnly} />)}
            </div>
          </header>
        )}
        <main className="hub-main">
          {unknown ? (
            <EmptyState
              icon={<Icon name="building" size={28} />}
              title="Building not found"
              message="This building isn't one of yours, or it has been removed."
              action={currentId ? <Link className="btn btn-primary" to={sectionPath(currentId, '')}>Go to your dashboard</Link> : null}
            />
          ) : <Outlet context={ctx} />}
        </main>
        <footer className="hub-foot text-xs">© 2026 {IDENTITY.name}</footer>
      </div>

      <nav className="hub-tabs" aria-label="Customer hub">{hubNavTabs().map((e) => item(e, 'hub-tab'))}</nav>
    </div>
  );
}
