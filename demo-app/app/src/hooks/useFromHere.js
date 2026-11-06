import { useLocation } from 'react-router-dom';
import { useT } from '../i18n/react';
import { HUB_NAV, PROPERTIES_PATH, ACCOUNT_PATH, HUB_SCAN_PATH } from '../pages/hub/hubNav';

// The back pill's word for the page a link leaves, as a CATALOG KEY (CS-193): the label is
// rendered in the reader's language when the link is made, and travels in history state.
function deriveFromLabel(pathname) {
  if (pathname === '/' || pathname === '/dashboard') return 'nav.dashboard';
  if (pathname === '/contacts' || pathname === '/clients') {
    // The top-level list is the Customers hub (companies). People live under a
    // customer, so the breadcrumb back to this list reads 'Customers'.
    return 'nav.customers';
  }
  if (pathname === '/schedule') return 'nav.schedule';
  // The Quality hub. Its route is still `/inspections` (kept after the variance deep-link it
  // was named for was removed), but the page, the nav and the tab bar all say Quality — and
  // with no case here the back pill off a clean read "← Schedule", the label of the page it
  // had just left, which is the one thing a back arrow must never say.
  if (pathname === '/inspections') return 'nav.quality';
  // Builder C (the manager view redesign, 2026-10-09): Client Requests; Supplies, whose rows (and,
  // since By building, its buildings) open a customer's page.
  if (pathname === '/requests') return 'nav.clientRequests';
  // S131: the Accounts page opens a customer's page; its back pill names Accounts.
  if (pathname === '/team-accounts') return 'nav.teamAccounts';
  if (pathname === '/supplies') return 'nav.supplies';
  if (pathname === '/pipeline') return 'nav.pipeline';
  if (pathname === '/invoices') return 'nav.invoices';
  if (pathname === '/messaging') return 'nav.messaging';
  if (pathname === '/settings/team') return 'back.team';
  if (pathname === '/settings/account') return 'back.account';
  if (pathname === '/settings/company') return 'back.company';
  if (pathname === '/settings/services') return 'back.services';
  if (pathname === '/settings/tags') return 'back.tags';
  if (pathname === '/settings/roles') return 'back.roles';
  if (pathname === '/settings/notifications') return 'back.reminders';
  if (pathname === '/settings/integrations') return 'back.integrations';
  // ── the manager view redesign (Builder B): the P&L board's own page (D3) ──
  if (pathname === '/pnl') return 'nav.propertyPnl';
  // ── Manager view (Builder A, 2026-10-09): the today screens a visit or a checklist opens from.
  if (pathname === '/check-in') return 'nav.shiftCheckIn';
  if (pathname === '/checklists') return 'nav.checklistsToday';
  // The QR codes page (Matt, 2026-10-30; UI_RULES §183): a customer opened from it backs out to it.
  if (pathname === '/qr-codes') return 'nav.qrCodes';
  // ── the Cleaner Hub (brief A, 2026-10-13): a cleaner's Home and Today's Stops. Without these a
  // clean opened from Home read "← Schedule" on its page (DetailHeader's own label, CS-552).
  if (pathname === '/my-day') return 'crewShell.home';
  if (pathname === '/my-day/stops') return 'crewStops.title';
  // S131 Builder C: an order opened from Request Supplies (its last order, its history) backs out to it.
  if (pathname === '/my-day/supplies') return 'crewSupplies.title';
  // QR Wave 2: the office's scanner (an area opened from a camera scan backs out to it to scan the
  // next code; lib/scanLanding OFFICE_SCAN_PATH) and an area's page, which opens a ticket, an
  // inspection and the customer's page.
  if (pathname === '/areas/scan') return 'officeScan.title';
  if (/^\/areas\/[^/]+\/[^/]+$/.test(pathname)) return 'areaPage.backLabel';
  return null;
}

// The CUSTOMER hub's back words. What a client reads stays English (LANG-8, Matt 2026-09-29),
// so these are literals and never catalog lines the translator would be sent: a property
// manager whose phone is set to Spanish still reads an English hub, back pill included.
// A building's Home is "Back to Dashboard" (Matt's boards); a section is its nav label, from the
// hub's ONE nav list (pages/hub/hubNav.js), so a section added there is named here too.
function hubFromLabel(pathname) {
  if (pathname === '/hub' || /^\/hub\/b\/[^/]+$/.test(pathname)) return 'Back to Dashboard'; // i18n-ok: client-facing, English only (LANG-8)
  if (pathname === PROPERTIES_PATH) return 'Your Properties'; // i18n-ok: client-facing, English only (LANG-8)
  if (pathname === ACCOUNT_PATH) return 'Account'; // i18n-ok: client-facing, English only (LANG-8)
  // The QR scan page (QR Wave 2): an area's page opened from its camera backs out to it.
  if (pathname === HUB_SCAN_PATH) return 'Scan site QR code'; // i18n-ok: client-facing, English only (LANG-8)
  const section = /^\/hub\/b\/[^/]+\/([^/]+)$/.exec(pathname)?.[1];
  if (section === 'visit') return "Today's Visit"; // i18n-ok: client-facing, English only (LANG-8)
  if (section) return HUB_NAV.find((e) => e.section === section)?.label || null;
  return null;
}

export function useFromHere() {
  const t = useT();
  const { pathname, search } = useLocation();
  const hub = hubFromLabel(pathname);
  const key = hub ? null : deriveFromLabel(pathname);
  return { from: `${pathname}${search}`, fromLabel: hub || (key ? t(key) : null) };
}
