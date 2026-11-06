import { useEffect } from 'react';
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import Badge from '../../components/Badge';
import Icon from '../../components/Icon';
import { useFromHere } from '../../hooks/useFromHere';
import { resultLabel } from '../../lib/inspections';
import { HUB_PREVIEW_NOTE } from '../../lib/hubPreview';
import { english } from '../../i18n/core';
import { HUB_BELL, hubActions } from './hubSlots';
import { sectionPath, PROPERTIES_PATH, HUB_SECTIONS, HUB_SCAN_PATH } from './hubNav';
import { useHub, useHubRefresh, hubGreeting, hubShortDay } from './hubData';
import HubCrewBand from './HubCrewBand';
import HubAlertsRow from './HubAlertsRow';
import { HubManagerCard, HubManagerLine, hasHubManager } from './HubAccountManager';
import HubTile from './HubTile';
import HubInvoicesTile from './HubInvoicesTile';
import HubDocumentsTile from './HubDocumentsTile';
import HubResolveTile from './HubResolveTile';

// HOME — one property at a time (the client hub redesign, Matt's boards mobile-01 / web-01,
// plan §3.1, 2026-10-08). Top to bottom:
//   · desktop: "Good afternoon, Jordan", "<group> · <building>" and "Your Account Manager · Dana K."
//     with their photo; then the property switcher, Message, Call and the bell. Phone: the switcher
//     row, then "Your Account Manager" with round Message and Call, or, with no manager, the Message
//     + Call row (HUB-19, ./HubAccountManager.jsx; the phone's top bar — the mark and the bell — is
//     the layout's).
//   · Crew on the way's alerts row until this phone has them on or it is closed (./HubAlertsRow.jsx,
//     Daniel's pick 2026-11-03);
//   · the crew status band (lib/hubVisit.js), tap 2 to the visit timeline;
//   · the dashed "Scan site QR code" (the Cleaner Hub, D5 — Matt: "Add this on the client hub as
//     well"), as the cleaner's Home draws it: a code at one of their buildings opens its Checklists;
//   · the tiles: Requests, the average time to resolve (the Oct 6 call, plan 2026-10-11 §4),
//     Checklists, Inspections (and Invoices and Documents, Builder C), each one tap from its page
//     (Matt's note s1). History, which the boards don't draw (decision D3), is a row under them on
//     a phone; the desktop has it in the sidebar.
//   · the phone's "New request" button.
// Everything comes from GET /api/hub/home (or the demo's twin), read ONCE per building by
// HubRoot, so the sidebar's counts and this page agree; it is re-read here every minute.
//
// `?tab=checklists|inspections|history|tickets` — the old building page's tabs, still in links
// sent before the redesign — lands on that section's page.
//
// ── THE TILE GRID: one entry per tile, in the order drawn. ────────────────────
//   Builder C: Invoices and Documents — { key: 'invoices', Tile: HubInvoicesTile }, { key:
//   'documents', Tile: HubDocumentsTile, wide: true } (a Tile gets { building, home, preview, readOnly }
//   and draws the shared frame, ./HubTile.jsx).
const TILES = [
  { key: 'requests', Tile: RequestsTile },
  // The average time to resolve the building's requests (Matt, the Oct 6 call): beside Requests from
  // the desktop up; a full-width row on a phone (a wide slot the stylesheet narrows from 641px, the
  // grid's dense flow lifting Checklists up beside Requests), so no tile is left alone in a row.
  { key: 'resolve', Tile: HubResolveTile, wide: true },
  { key: 'checklists', Tile: ChecklistsTile },
  { key: 'inspections', Tile: InspectionsTile },
  // Builder C: each reads its own answer, so a slow QuickBooks never holds Home up. Documents is a
  // full-width row on a phone (Matt's mobile-01) and an ordinary tile from the desktop up (web-01).
  { key: 'invoices', Tile: HubInvoicesTile },
  { key: 'documents', Tile: HubDocumentsTile, wide: true },
];

export default function HubHome() {
  const { buildingId } = useParams();
  const [searchParams] = useSearchParams();
  const { hub, building, home, homeRead, preview, readOnly, viewerKey } = useHub();
  const tab = searchParams.get('tab');
  useHubRefresh(() => homeRead?.reload?.());
  // Coming back to Home re-reads it (the layout keeps the last answer on screen meanwhile).
  useEffect(() => { if (homeRead?.data) homeRead.reload(); }, []);

  if (tab && HUB_SECTIONS().includes(tab)) return <Navigate to={sectionPath(buildingId, tab)} replace />;
  if (!building) return <p className="text-muted">Loading…</p>;

  const viewer = hub?.viewer || {};
  const group = (hub?.groups || []).find((g) => (g.buildingIds || []).includes(building.id));
  const count = (hub?.buildings || []).length;
  // The building as Home's own read has it (read again every minute, so a new manager or a new
  // photo shows without a reload), else the view's until that read lands: the same manager, so
  // nothing moves when it does.
  const fresh = home?.building && home.building.id === building.id ? home.building : building;
  const managed = hasHubManager(fresh);

  return (
    <div className="hub-page hub-home">
      <header className="hub-home-head">
        <div className="hub-home-greet hub-only-desktop">
          <h1 className="hub-title">{hubGreeting(viewer.firstName)}</h1>
          <div className="hub-head-sub text-sm">{group ? `${group.name} · ${building.name}` : building.name}</div>
          <HubManagerLine building={fresh} />
        </div>
        <h1 className="sr-only hub-only-phone">{building.name}</h1>
        <div className="hub-home-tools">
          <PropertySwitcher building={building} count={count} />
          <HubManagerCard building={fresh} preview={preview} readOnly={readOnly} />
          <div className={`hub-actions hub-home-actions${managed ? ' hub-only-desktop' : ''}`}>
            {hubActions().map((a) => <a.Component key={a.key} building={fresh} preview={preview} readOnly={readOnly} />)}
          </div>
          {HUB_BELL.length > 0 && (
            <div className="hub-home-bell hub-only-desktop">
              {HUB_BELL.map((a) => <a.Component key={a.key} building={building} preview={preview} readOnly={readOnly} />)}
            </div>
          )}
        </div>
      </header>

      {homeRead?.error && !home ? (
        <div className="card hub-card">
          <p className="text-sm">{homeRead.error}</p>
          <button type="button" className="btn btn-outline" onClick={homeRead.reload}>Try again</button>
        </div>
      ) : (
        <>
          <HubAlertsRow viewerKey={viewerKey} preview={!!preview} />
          <HubCrewBand crew={home?.crew} buildingId={building.id} />
          <ScanButton />
          <div className="hub-tiles">
            {TILES.map((t) => (
              <div key={t.key} className={`hub-tile-slot${t.wide ? ' is-wide' : ''}`}><t.Tile building={building} home={home} preview={preview} readOnly={readOnly} /></div>
            ))}
            <div className="hub-tile-slot is-wide hub-only-phone"><HistoryRow building={building} /></div>
          </div>
        </>
      )}

      <NewRequestFab building={building} readOnly={readOnly} />
    </div>
  );
}

// "Bayside Tower, Suite 400 · 4 properties ⌄" → the Properties page. With one building there is
// nothing to switch to: the name alone, no count and no chevron (plan §3.1).
function PropertySwitcher({ building, count }) {
  const nav = useFromHere();
  if (count <= 1) {
    return (
      <div className="hub-switch is-single">
        <Icon name="mapPin" size={16} />
        <span className="hub-switch-name">{building.name}</span>
      </div>
    );
  }
  return (
    <Link className="hub-switch" to={PROPERTIES_PATH} state={nav} aria-label={`${building.name}. Switch between your ${count} properties`}>
      <Icon name="mapPin" size={16} />
      <span className="hub-switch-name">{building.name}</span>
      <span className="hub-switch-count text-xs">{count} properties</span>
      <Icon name="chevronDown" size={16} />
    </Link>
  );
}

// Requests: "1 new · 1 in progress", and "1 needs your reply"; else "No open requests".
function RequestsTile({ building, home }) {
  const r = home?.requests;
  const parts = r ? [r.received ? `${r.received} new` : '', r.working ? `${r.working} in progress` : ''].filter(Boolean) : [];
  return (
    <HubTile to={sectionPath(building.id, 'tickets')} icon="forms" tone="amber" title="Requests" cta="View all →">
      {!r ? 'Loading…' : (
        <>
          {parts.length ? parts.join(' · ') : (r.needsInfo ? '' : 'No open requests')}
          {r.needsInfo > 0 && <span className="hub-tile-flag"><Badge variant="amber">{r.needsInfo} {r.needsInfo === 1 ? 'needs' : 'need'} your reply</Badge></span>}
        </>
      )}
    </HubTile>
  );
}

// Checklists: today's saves summed ("7 of 8 done today"); none today, the last one ("Last: 8 of
// 8 · Oct 3"); none ever, "No checklists yet". "View today" opens today's one when there is one.
function ChecklistsTile({ building, home }) {
  const c = home?.checklists;
  const today = c?.today;
  let line = 'Loading…';
  if (c) {
    if (today?.count) line = `${today.done} of ${today.total} done today`;
    else if (c.last) line = `Last: ${c.last.done} of ${c.last.total} · ${hubShortDay(c.last.performedAt)}`;
    else line = 'No checklists yet';
  }
  const to = today?.onlyId
    ? `${sectionPath(building.id, 'checklists')}/${encodeURIComponent(today.onlyId)}`
    : sectionPath(building.id, 'checklists');
  return (
    <HubTile to={to} icon="check" tone="blue" title="Checklists" cta={today?.count ? 'View today →' : 'View all →'}>
      {line}
    </HubTile>
  );
}

// Inspections: "Last: 92% · Pass · Sep 27", the last four scores as bars (with the same in
// words for a screen reader), and the last report's photos. "View report →" opens it.
function InspectionsTile({ building, home }) {
  const i = home?.inspections;
  const last = i?.last;
  const to = last ? `${sectionPath(building.id, 'inspections')}/${encodeURIComponent(last.id)}` : sectionPath(building.id, 'inspections');
  const trend = (i?.trend || []).filter((t) => Number.isFinite(t.score));
  return (
    <HubTile to={to} icon="star" tone="green" title="Inspections" cta={last ? 'View report →' : 'View all →'}>
      {!i ? 'Loading…' : !last ? 'No inspections yet' : (
        <>
          <span className="hub-tile-line">
            Last: {last.score != null ? `${last.score}% · ` : ''}{resultLabel(last.result)} · {hubShortDay(last.performedAt)}
          </span>
          {trend.length > 1 && (
            <span className="hub-trend" role="img" aria-label={`The last ${trend.length} scores, oldest first: ${trend.map((t) => `${t.score}%`).join(', ')}`}>
              <span className="hub-trend-bars" aria-hidden>
                {trend.map((t, n) => (
                  <span key={`${t.performedAt}-${n}`} className={`hub-trend-bar${n === trend.length - 1 ? ' is-last' : ''}`} style={{ height: `${Math.max(12, Math.min(100, t.score))}%` }} />
                ))}
              </span>
              <span className="hub-trend-label text-xs">last {trend.length} visits</span>
            </span>
          )}
          {i.photos?.length > 0 && (
            <span className="hub-tile-photos">
              {i.photos.map((p) => <img key={p.id} className="hub-tile-photo" src={p.thumbUrl || p.url} alt={p.caption || 'Inspection photo'} loading="lazy" />)}
              {i.morePhotos > 0 && <span className="hub-tile-photo is-more">+{i.morePhotos}</span>}
            </span>
          )}
        </>
      )}
    </HubTile>
  );
}

// "Scan site QR code" (the Cleaner Hub, D5): the kit's one dashed slot (UI_RULES §125), as the
// cleaner's Home draws it. A read — it works in the office's preview too. English (LANG-8).
function ScanButton() {
  const nav = useFromHere();
  return (
    <Link className="add-tile hub-scan-button" to={HUB_SCAN_PATH} state={nav}>
      <Icon name="camera" size={18} />
      <span>{english('hubScan.button')}</span>
    </Link>
  );
}

// History (decision D3), on a phone, where there is no sidebar: a year of service.
function HistoryRow({ building }) {
  const nav = useFromHere();
  return (
    <Link className="card hub-row-tile" to={sectionPath(building.id, 'history')} state={nav}>
      <span className="hub-tile-icon is-slate" aria-hidden><Icon name="schedule" size={20} /></span>
      <span className="hub-row-tile-text">
        <span className="hub-tile-title">History</span>
        <span className="text-sm text-muted">The last 12 months of service</span>
      </span>
      <Icon name="chevronRight" size={20} />
    </Link>
  );
}

// The phone's "New request" button, over the bottom tabs, on Home only (Matt's mobile-01). In the
// office's READ-ONLY preview it stays where the customer sees it, disabled (UI_RULES §151); a
// preview acting as the customer raises a real request with it.
function NewRequestFab({ building, readOnly = false }) {
  const nav = useFromHere();
  if (readOnly) {
    return (
      <button type="button" className="hub-fab hub-only-phone" disabled aria-label={`New request. ${HUB_PREVIEW_NOTE}`} title={HUB_PREVIEW_NOTE}>
        <Icon name="plus" size={26} />
      </button>
    );
  }
  return (
    <Link className="hub-fab hub-only-phone" to={`${sectionPath(building.id, 'tickets')}/new`} state={nav} aria-label="New request">
      <Icon name="plus" size={26} />
    </Link>
  );
}
