// THE CLIENT HUB'S NAVIGATION — the one list (the client hub redesign, plan §3.1, 2026-10-08).
//
// The desktop sidebar and the phone's bottom tabs both read this list, so the two can never
// offer different places. Matt's boards: the sidebar runs Home, Requests, Crew status,
// Checklists, Inspections, Invoices, Documents, then a divider and Messages and Account; the
// phone's tabs are Home · Messages · Account, and every other section is a tile on Home (his
// note s1: "Every tile on Home is 1 tap away").
//
// An entry:
//   key        unique; `section` too when it is a building's section page (/hub/b/:id/<section>)
//   label      the words (the hub stays English: LANG-8)
//   icon       an Icon name (components/Icon.jsx)
//   place      'main' (above the divider) or 'bottom' (below it), ordered by `order`
//   tab        true = also a phone bottom tab, ordered by `tabOrder`
//   section    the path segment after /hub/b/:id ('' = the building's Home); null = not a
//              building's page (`path` names it instead)
//   badge      (ctx) => { text, variant } | null — ctx is the layout's outlet context
//   switchNote true = named in the Properties page's "Switching properties updates …" line
//
// ── ADDING A SECTION: one entry, below. ──────────────────────────────────────
//   Builder B: Messages — { key: 'messages', label: 'Messages', icon: 'messaging', place: 'bottom',
//              order: 10, tab: true, tabOrder: 20, section: 'messages', badge: … }
//   Builder C: Invoices and Documents — { …, place: 'main', order: 60 / 70, section: 'invoices' /
//              'documents', switchNote: true }
// (No placeholder entries: a section is listed the day its page exists.)

import { hubUnreadFor } from '../../lib/hubMessages.js';

// The building's Home and its sections — ONE spelling of the paths, shared with the emails'
// hubTicketPath / hubInspectionPath (lib/clientHubEmails.js) for the record pages.
export const buildingPath = (id) => `/hub/b/${encodeURIComponent(id)}`;
export const sectionPath = (id, section) => (section ? `${buildingPath(id)}/${section}` : buildingPath(id));
// One area of a building (QR-16, QR Wave 2): the page a customer's scan of that area's code opens —
// when it was last cleaned, the photo, what was done, the next clean, and "Make a request about this
// area" (pages/hub/HubArea). Not a section: reached by a scan, with its own back arrow.
export const areaPath = (buildingId, areaId) => `${buildingPath(buildingId)}/areas/${encodeURIComponent(areaId)}`;
// Its "Make a request about this area" opens the building's New request form with the area in the
// history state, `{ area: { id, label } }` (HubNewTicket). → `{ id, label }` or null (anything
// else). The form's text starts with the area's name ("Lobby & entrance: ") and the request sends
// the area's id as `siteAreaId`.
export function hubRequestArea(state) {
  const a = state && typeof state === 'object' ? state.area : null;
  const id = a && typeof a.id === 'string' ? a.id.trim() : '';
  const label = a && typeof a.label === 'string' ? a.label.trim() : '';
  return id && label ? { id, label } : null;
}
export const hubAreaPrefill = (area) => (area?.label ? `${area.label}: ` : '');
export const PROPERTIES_PATH = '/hub/properties';
export const ACCOUNT_PATH = '/hub/account';
// The QR scan (the Cleaner Hub, D5 — Builder D): Home's dashed "Scan site QR code" opens it; a code
// for one of the customer's buildings lands on that area's own page (areaPath). Not a section (no nav
// entry): a tool reached from Home, with its own back arrow. Spelled ONCE, in lib/scanLanding (a
// printed code opened by a signed-in customer comes here too, as `?code=`: UI_RULES §172).
export { HUB_SCAN_PATH } from '../../lib/scanLanding.js';

// The Requests count (open requests), amber while one is waiting on the customer.
const requestsBadge = (ctx) => {
  const r = ctx?.home?.requests;
  if (!r) return null;
  const open = (r.received || 0) + (r.working || 0) + (r.needsInfo || 0);
  return open ? { text: String(open), variant: r.needsInfo ? 'amber' : 'slate' } : null;
};
// "On site" on Crew status while someone is there.
const onSiteBadge = (ctx) => (ctx?.home?.crew?.state === 'on_site' ? { text: 'On site', variant: 'green' } : null);
// Messages: the building in view's unread lines, from the bell's answer (ctx.updates, the layout's
// one read of GET /api/hub/updates — pages/hub/hubUpdates.js).
const messagesBadge = (ctx) => {
  const n = hubUnreadFor(ctx?.updates, ctx?.building?.id || ctx?.currentId);
  return n ? { text: n > 99 ? '99+' : String(n), variant: 'amber' } : null;
};

export const HUB_NAV = Object.freeze([
  { key: 'home', label: 'Home', icon: 'dashboard', place: 'main', order: 10, tab: true, tabOrder: 10, section: '', switchNote: true },
  { key: 'requests', label: 'Requests', icon: 'forms', place: 'main', order: 20, section: 'tickets', badge: requestsBadge, switchNote: true },
  { key: 'visit', label: 'Crew status', icon: 'mapPin', place: 'main', order: 30, section: 'visit', badge: onSiteBadge, switchNote: true },
  { key: 'checklists', label: 'Checklists', icon: 'check', place: 'main', order: 40, section: 'checklists', switchNote: true },
  { key: 'inspections', label: 'Inspections', icon: 'star', place: 'main', order: 50, section: 'inspections', switchNote: true },
  // Builder C (plan §3.5 / §3.6): read-only invoices from QuickBooks, and the property's documents.
  { key: 'invoices', label: 'Invoices', icon: 'invoices', place: 'main', order: 60, section: 'invoices', switchNote: true },
  { key: 'documents', label: 'Documents', icon: 'folder', place: 'main', order: 70, section: 'documents', switchNote: true },
  { key: 'history', label: 'History', icon: 'schedule', place: 'main', order: 80, section: 'history', switchNote: true },
  { key: 'messages', label: 'Messages', icon: 'messaging', place: 'bottom', order: 10, tab: true, tabOrder: 20, section: 'messages', badge: messagesBadge },
  { key: 'account', label: 'Account', icon: 'user', place: 'bottom', order: 20, tab: true, tabOrder: 30, section: null, path: ACCOUNT_PATH },
]);

const byOrder = (k) => (a, b) => (a[k] ?? 0) - (b[k] ?? 0);
export const hubNavMain = () => HUB_NAV.filter((e) => e.place === 'main').sort(byOrder('order'));
export const hubNavBottom = () => HUB_NAV.filter((e) => e.place === 'bottom').sort(byOrder('order'));
export const hubNavTabs = () => HUB_NAV.filter((e) => e.tab).sort(byOrder('tabOrder'));
// The building's sections (every entry with a section segment), for "the same section of that
// building" when the Properties page switches.
export const HUB_SECTIONS = () => HUB_NAV.filter((e) => typeof e.section === 'string' && e.section).map((e) => e.section);

// Where an entry goes, for the building in view (or the remembered one, off a building's page).
export function hubNavHref(entry, buildingId) {
  if (entry.section === null || entry.section === undefined) return entry.path || '/hub';
  return buildingId ? sectionPath(buildingId, entry.section) : '/hub';
}

// Which entry a path belongs to: a building's section (its list and its records), its Home, or a
// path of its own. The longest match wins, so /hub/b/x/tickets/new is Requests.
export function hubNavActive(entry, pathname) {
  const p = String(pathname || '');
  if (entry.section === null || entry.section === undefined) return !!entry.path && (p === entry.path || p.startsWith(`${entry.path}/`));
  const m = /^\/hub\/b\/[^/]+(?:\/([^/]+))?/.exec(p);
  if (!m) return false;
  return entry.section === '' ? !m[1] : m[1] === entry.section;
}

// The building a path is about (decoded), or null.
export function hubBuildingIdOf(pathname) {
  const m = /^\/hub\/b\/([^/]+)/.exec(String(pathname || ''));
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return null; }
}

// The section a path is on (for switching buildings to the same section), or ''.
export function hubSectionOf(pathname) {
  const m = /^\/hub\/b\/[^/]+\/([^/?#]+)/.exec(String(pathname || ''));
  return m && HUB_SECTIONS().includes(m[1]) ? m[1] : '';
}
