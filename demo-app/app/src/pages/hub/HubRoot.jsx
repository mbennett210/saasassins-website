import { useCallback, useEffect, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../../auth/AuthProvider';
import HubLayout from '../../layouts/HubLayout';
import InstallWelcome from '../../components/InstallWelcome';
import { fetchHubView, fetchHubHome } from '../../lib/clientHubApi';
import { isClientSession } from '../../lib/clientHub';
import { demoBackendsEngaged } from '../../lib/demoMode';
import { setOrgTimezone } from '../../lib/dates';
import { readHubPreview, clearHubPreview, hubPreviewExitPath } from '../../lib/hubPreview';
import { useHubRead, hubCurrentId, rememberHubCurrent } from './hubData';
import { hubBuildingIdOf } from './hubNav';

// THE CUSTOMER HUB'S ROOT — the gate, the one fetch, and the shell.
//
// 🔴 IT DOES NOT MOUNT StoreProvider. A customer login cannot read org_state (the CS-002
// policy flip made that read office-only) and every /api/state/* route refuses role 'client'
// outright, so booting the shared store here would mean a sync manager retrying a 403 every
// few seconds behind a screen that renders nothing from it. Every section reads its own
// /api/hub/* answer, already scoped and allowlisted server-side.
//
// The two gates are mirror images and together they partition every signed-in person:
//   · here, a STAFF session is sent back to the office app;
//   · in App.jsx's AuthedShell, a CUSTOMER session is sent here.
// Neither is a security boundary — the server's is (api/_lib/authz.js) — they are only what
// stops each audience landing on a screen that cannot work for them.
//
// 🔴 THE OFFICE'S PREVIEW (the client hub redesign, plan §3.7, decision D2): a STAFF session is
// admitted ONLY while this tab previews a building — the flag an entry point sets (the customer
// page's "Preview customer hub", the user menu's building picker; lib/hubPreview.js) and "Exit
// preview" clears. Then every hub call names that building (lib/clientHubApi.js) and the server
// decides: hub.users.view, that one building, acting as its stand-in customer (or read-only with
// HUB_PREVIEW_ACTS_AS_CUSTOMER off). A customer session ignores the flag (and drops a stale one).
// Without it, the redirect above stands.
//
// 🔴 THE DEMO'S WAY IN (Phase 2 Wave 2 Round 2). The login-free demo has no session at all, so
// it would always be sent away. In a DEMO build only — the static `import.meta.env.MODE`, which
// folds to false in `npm run build`, AND the runtime demoBackendsEngaged() — the hub opens as
// the demo's seeded customer contact (lib/hubDemo.js), and the header says it is a preview. The
// demo honours the office's preview too (the demo's twin answers as the server would). The
// production gate below is untouched.
//
// The view (the buildings, the viewer, their groups, the org's zone) is fetched here once per
// visit and rides the outlet context; the layout reads the building in view's Home, and each
// section page fetches its own. The ORG'S ZONE: there is no store to call setOrgTimezone, so the
// view's `timezone` sets it here, and every hub time renders as the building's wall clock.
//
// `viewerKey` names the per-viewer convenience the layout keeps in localStorage (the building
// last viewed, and whose bell the hub reads): the login's own client-user id from its claim, or the
// demo contact; a preview is keyed to its building (`preview:<id>`), so moving to another
// building's preview in this tab starts the bell clean (its one building is always the current one).
const HUB_DEMO = import.meta.env.MODE === 'demo' && demoBackendsEngaged();

export default function HubRoot() {
  const { configured, loading, session } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [view, setView] = useState(undefined); // undefined = loading
  const [error, setError] = useState('');

  const customer = !HUB_DEMO && isClientSession(session);
  const flag = readHubPreview();
  // The office's preview: the flag, on a staff session (or the demo) — never a customer's.
  const preview = flag && !customer && (HUB_DEMO || !!session) ? flag : null;
  const previewId = preview?.buildingId || null;
  const isClient = HUB_DEMO || customer || !!preview;

  // A customer session never previews: a flag left in this tab by a staff login is dropped.
  useEffect(() => { if (customer && flag) clearHubPreview(); }, [customer, flag]);

  const load = useCallback(async () => {
    setError('');
    try {
      const v = await fetchHubView();
      if (v?.timezone) setOrgTimezone(v.timezone);
      setView(v);
    } catch (e) {
      setView(null);
      setError(e?.message || 'Your buildings could not be loaded.');
    }
  }, []);

  // Re-read when the previewed building changes (a new entry from the office in this tab).
  useEffect(() => { if (isClient) load(); }, [isClient, previewId, load]);

  // The building in view: the URL's, when it is one of this login's (the server's scope, through
  // the view). Its Home read (the crew band, the tile counts) is made HERE, once per building, so
  // the sidebar's Requests count and "On site" pill show on every page of it, and Home reuses it.
  // Off a building's page (Properties, Account) it is the current building's, where the nav goes.
  const viewerKey = preview ? `preview:${previewId}` : HUB_DEMO ? 'demo' : (session?.user?.app_metadata?.client_user_id || session?.user?.id || '');
  const buildings = Array.isArray(view?.buildings) ? view.buildings : [];
  const urlId = hubBuildingIdOf(location.pathname);
  const building = urlId ? buildings.find((b) => b.id === urlId) || null : null;
  const currentId = hubCurrentId(buildings, { urlId, viewerKey });
  const homeId = building?.id || (urlId ? null : currentId);
  const home = useHubRead(() => (homeId ? fetchHubHome(homeId) : Promise.resolve(null)), [homeId, previewId]);
  useEffect(() => { if (building) rememberHubCurrent(viewerKey, building.id); }, [viewerKey, building?.id]);

  // "Exit preview": the flag goes, and the office opens the building's customer page.
  const exitPreview = useCallback(() => {
    clearHubPreview();
    navigate(hubPreviewExitPath(previewId), { replace: true });
  }, [navigate, previewId]);

  if (!HUB_DEMO) {
    if (configured && loading) return <div className="hub-shell"><div className="hub-main text-muted">Loading…</div></div>;
    if (configured && !session) return <Navigate to="/login" replace state={{ from: location }} />;
    // A staff login (or local mode, which has no claim at all) belongs in the office app — unless
    // this tab is previewing a building for it.
    if (!isClientSession(session) && !preview) return <Navigate to="/" replace />;
  }

  // The Home Screen welcome rides along: a phone's browser, until the app is on its Home Screen
  // (UI_RULES §178). In English: what a customer reads stays English (LANG-8). (A line comment, not a
  // JSX block one: the suites strip block comments, and this file names `/api/state/*` above.)
  return (
    <>
      <InstallWelcome englishOnly />
      <HubLayout
        viewerName={view?.viewer?.name || ''}
        viewerKey={viewerKey}
        hub={view}
        error={error}
        loading={view === undefined}
        onRetry={load}
        demo={HUB_DEMO}
        preview={preview}
        onExitPreview={exitPreview}
        building={building}
        buildingId={urlId}
        currentId={currentId}
        home={home}
      />
    </>
  );
}
