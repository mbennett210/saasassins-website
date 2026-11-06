// ONE PRINTED CODE, A VIEW PER PERSON (QR Wave 1, 2026-10-16; Matt: "the QR code opens a different
// view depending on who is logged in"; UI_RULES §172).
//
// Every label on a wall is the same link, `/scan/<token>`. What it opens depends on who is signed
// in ON THIS BROWSER:
//
//   not signed in, the login-free demo, or ?view=public  →  the public page (as before), plus ONE
//                                                           "… team or customer? Sign in" line that
//                                                           comes back to this code
//   a customer login                                      →  /hub/scan?code=<token>   (EP-387 decides)
//   an OFFICE login (the claim's role, lib/roles)         →  /areas/scan?code=<token> (EP-386 decides)
//   a cleaner, or a staff login with no role claim        →  /my-day/scan?code=<token> (EP-386 decides)
//
// and the scan pages send the person on: a cleaner to today's checklist there — or, not on today's
// clean there, the offer to fill in for someone on it, and with no checklist there, the building's
// last inspection and open tickets (QR Wave 2, §176); an office login to the area's own page (QR
// Wave 2, Matt's QR-17 / QR-20, 2026-10-16: the last clean, the photo, open requests, who's on
// site, Start inspection / New request; Open customer went 2026-11-03); the Supply Manager to that building's
// supply orders (QR-19); anyone the server refuses to the public page. The server still decides
// what a person may open; this module only decides where the browser goes next, from the session's
// CLAIM (the same trust root the server gates on — THE LAW II.11), never from anything the page
// could be told. A claim-less login keeps the cleaner's page, which decides by the person on
// screen (an office one lands on the area page there too: one rule, staffScanDestination).
//
// PURE and node-safe (explicit `.js` imports, nothing heavy): the public page, a stranger's phone,
// loads it, so it must not pull the office's libraries in. lib/roles is the ONE list of office tiers
// (never a hand copy here), and the public page already loads it (scanCodesApi → qcApi → timeApi).
import { isScanToken } from './areaScan.js';
import { crewPaths } from './crewPaths.js';
import { isOfficeRole } from './roles.js';

// The customer hub's scan page (Home's "Scan site QR code" opens it). Defined here, re-exported by
// pages/hub/hubNav.js, so the hub's nav and this rule spell it once.
export const HUB_SCAN_PATH = '/hub/scan';

// `?code=` on both scan pages: the token a phone camera's link carried in. `?view=public` on the
// public page: a signed-in person asking for the page a stranger sees.
export const SCAN_CODE_PARAM = 'code';
export const SCAN_VIEW_PARAM = 'view';
export const SCAN_VIEW_PUBLIC = 'public';

const enc = (v) => encodeURIComponent(String(v));

export const publicScanPath = (token, { view = null } = {}) => `/scan/${enc(token)}${view === SCAN_VIEW_PUBLIC ? `?${SCAN_VIEW_PARAM}=${SCAN_VIEW_PUBLIC}` : ''}`;
export const hubScanPath = (code = null) => (code ? `${HUB_SCAN_PATH}?${SCAN_CODE_PARAM}=${enc(code)}` : HUB_SCAN_PATH);

// THE OFFICE'S SCAN (QR Wave 2, QR-17..QR-21). The office's own scanner (pages/OfficeScan, inside the
// office shell; the Scan button on the manager's Home, the phone menu and the desktop sidebar), and
// the page one area of one location has (pages/AreaPage, UI_RULES §175). Both under /areas: the
// scanner is `/areas/scan`, an area `/areas/<location id>/<area id>` — never a clash (two segments
// against three).
export const OFFICE_SCAN_PATH = '/areas/scan';
export const officeScanPath = (code = null) => (code ? `${OFFICE_SCAN_PATH}?${SCAN_CODE_PARAM}=${enc(code)}` : OFFICE_SCAN_PATH);
export const areaPagePath = (siteId, areaId) => `/areas/${enc(siteId)}/${enc(areaId)}`;
// The Supply Manager's landing (QR-19: "That building's supply orders and deliveries"): the Supplies
// page's Order Queue filtered to the building by its Customer filter (`?cust=`), on the Supply
// Manager's own first tab, the one their Home opens on (lib/supplies SUPPLY_MANAGER_TABS[0]: only
// approved orders reach them, Matt S131). Spelled here so this module stays light; the suite holds
// the two equal.
export const SUPPLY_SCAN_STATUS = 'approved';
export const supplyScanPath = (clientId) => `/supplies?cust=${enc(clientId)}&status=${SUPPLY_SCAN_STATUS}`;

// The role the login's CLAIM carries (app_metadata, THE LAW II.11): what the server gates on, never
// the store's roster. null for no session or a claim-less login.
export function scanClaimRole(session) {
  const role = session?.user?.app_metadata?.role;
  return typeof role === 'string' && role ? role : null;
}

export const SCAN_LANDING = Object.freeze({ LOADING: 'loading', PUBLIC: 'public', REDIRECT: 'redirect' });

// What `/scan/<token>` does, for whoever holds the phone.
//   token       the path's token (a malformed one shows the public page's own "no longer active")
//   configured  sign-in is configured (false in the login-free demo and a local build)
//   loading     the session is still being read
//   signedIn    a session exists on this browser
//   customer    that session is a customer login (lib/clientHub isClientSession: the claim)
//   role        the claim's role (scanClaimRole): an office tier goes to the office's scanner
//   view        the `?view=` value
export function scanLanding({ token, configured = false, loading = false, signedIn = false, customer = false, role = null, view = null } = {}) {
  if (!isScanToken(token)) return { kind: SCAN_LANDING.PUBLIC };
  if (view === SCAN_VIEW_PUBLIC) return { kind: SCAN_LANDING.PUBLIC };
  if (!configured) return { kind: SCAN_LANDING.PUBLIC };
  if (loading) return { kind: SCAN_LANDING.LOADING };
  if (!signedIn) return { kind: SCAN_LANDING.PUBLIC };
  if (customer) return { kind: SCAN_LANDING.REDIRECT, to: hubScanPath(token) };
  return { kind: SCAN_LANDING.REDIRECT, to: isOfficeRole(role) ? officeScanPath(token) : crewPaths.scan(token) };
}

// The public card's one Sign-in line: only where sign-in exists and nobody is signed in here.
export function scanShowsSignIn({ configured = false, loading = false, signedIn = false } = {}) {
  return configured === true && !loading && !signedIn;
}

// Where Sign in leaves from and comes back to: Login lands on `state.from.pathname`, so after
// signing in the person returns to THIS code and is sent on by scanLanding.
export function scanSignInState(token) {
  return { from: { pathname: publicScanPath(token) } };
}

// Where a signed-in STAFF member's scan lands, once the server has said where the code is (EP-386).
// The camera inside a page and a `?code=` link take the same road, on every scan page.
//   loc             the resolve's answer: { siteId, clientId, areaId, siteName, building, area }
//   token           the code's token (for the public page)
//   office          the effective user is an office role (lib/roles isOfficeRole). The owner's
//                   View-as a cleaner is a cleaner here: they land on that cleaner's checklist.
//   supply          the effective user is a SUPPLY MANAGER (lib/navData isSupplyRole: the role)
//   canSeeCustomer  the effective user holds `clients.view` (the area page's own gate)
//   canSeeSupplies  the effective user holds `supplies.view` (the Supplies page's own gate)
//   clean           a cleaner's clean there today (lib/scanCodes crewCleanAtLocation), or null
//   hasChecklist    that cleaner has a checklist on that clean (lib/crewChecklist checklistFor,
//                   covers included); the page knows, this module takes no store
// → { kind: 'area' | 'supplies' | 'public' | 'checklist', to } | { kind: 'crewArea', place }
export function staffScanDestination({ loc = null, token, office = false, supply = false, canSeeCustomer = false, canSeeSupplies = false, clean = null, hasChecklist = true } = {}) {
  const publicPage = { kind: 'public', to: publicScanPath(token, { view: SCAN_VIEW_PUBLIC }) };
  // QR-19: the Supply Manager (an office tier, so before the office branch) → that building's supply
  // orders and deliveries — by role, whatever else they were granted.
  if (supply) return canSeeSupplies && loc?.clientId ? { kind: 'supplies', to: supplyScanPath(loc.clientId) } : publicPage;
  // QR-17 / QR-20: an Account Manager, an Operations Manager, an Admin, the Super Admin → the area page.
  if (office) return canSeeCustomer && loc?.siteId && loc?.areaId ? { kind: 'area', to: areaPagePath(loc.siteId, loc.areaId) } : publicPage;
  // A CLEANER (QR Wave 2, UI_RULES §176): on today's clean there with a checklist → that checklist,
  // at the scanned area (QR-12: "just open the checklist; they clock in separately"); otherwise the
  // page asks the server what they find there today (EP-420) and crewAreaDestination decides.
  if (clean && hasChecklist) return { kind: 'checklist', to: crewPaths.checklist(clean.id, loc?.areaId || null) };
  return { kind: 'crewArea', place: loc?.building || loc?.siteName || '' };
}

// A cleaner's road once the server has said what they find at the code's location TODAY (EP-420,
// QR Wave 2; Matt's QR-12 and QR-14, UI_RULES §176):
//   answer        EP-420's { onClean, fillIn, info }
//   hasChecklist  the cleaner has a checklist on `answer.onClean` (checklistFor, covers included)
// → { kind: 'checklist', to, jobId } — on a clean there with a checklist (after a fill-in too: the
//     covered cleaner's checklist, "Covering for …")
//   | { kind: 'info', info, place, area } — on a clean there with NO checklist: the building's last
//     inspection and open tickets ("or the last inspection done, or any open tickets")
//   | { kind: 'fillIn', state, candidates, place } — not on a clean there: the offer
//     ("Filling in for someone?") or why there is none (lib/scanFillIn FILL_IN_STATE)
export function crewAreaDestination({ loc = null, answer = null, hasChecklist = false } = {}) {
  const place = loc?.building || loc?.siteName || '';
  const job = answer?.onClean && typeof answer.onClean.id === 'string' ? answer.onClean : null;
  if (job && hasChecklist) return { kind: 'checklist', to: crewPaths.checklist(job.id, loc?.areaId || null), jobId: job.id };
  if (job) return { kind: 'info', info: answer.info || null, place, area: loc?.area || null };
  const f = answer?.fillIn && typeof answer.fillIn === 'object' ? answer.fillIn : {};
  return { kind: 'fillIn', state: typeof f.state === 'string' ? f.state : 'noClean', candidates: Array.isArray(f.candidates) ? f.candidates : [], place };
}
