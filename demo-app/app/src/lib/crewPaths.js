// The cleaner's phone app (Matt's "Cleaner Hub" design, 2026-10-13; plan
// docs/plans/2026-10-13-cleaner-hub.md): ONE place builds every path into it, so the screens,
// the notifications written for a cleaner and the QR scan cannot drift apart. Pure and
// node-safe: the server imports it to write a cleaner's deep links.
//
// Every screen lives under /my-day, the crew's home since the Swept build: the route is
// ALWAYS_GRANTED (`time.clock`), the crew are sent there from `/`, and the service worker keeps
// it on the phone (vite-plugins/sw-precache.mjs OFFLINE_SCREENS).
const enc = (v) => encodeURIComponent(String(v));

export const CREW_HOME_PATH = '/my-day';

export const crewPaths = Object.freeze({
  home: () => CREW_HOME_PATH,
  stops: () => `${CREW_HOME_PATH}/stops`,
  clock: (jobId) => `${CREW_HOME_PATH}/clock/${enc(jobId)}`,
  // `areaId` (optional): the location's cleaning area a scanned QR code names, so the checklist page
  // can bring that area's section into view (the QR scan, Builder D; the page reads `?area=`).
  checklist: (jobId, areaId) => `${CREW_HOME_PATH}/checklist/${enc(jobId)}${areaId ? `?area=${enc(areaId)}` : ''}`,
  hours: () => `${CREW_HOME_PATH}/hours`,
  supplies: (clientId) => (clientId ? `${CREW_HOME_PATH}/supplies?b=${enc(clientId)}` : `${CREW_HOME_PATH}/supplies`),
  // One of the cleaner's own supply orders (S131): the bells a cleaner gets about their order open it
  // (lib/supplyFlow supplyOrderLinkFor), as do Request Supplies' last order and history
  // (pages/crew/CrewSupplyOrder, Builder C).
  supplyOrder: (requestId) => `${CREW_HOME_PATH}/supplies/orders/${enc(requestId)}`,
  requests: () => `${CREW_HOME_PATH}/requests`,
  request: (ticketId) => `${CREW_HOME_PATH}/requests/${enc(ticketId)}`,
  // `code` (optional): the token a phone camera's link carried in — `/scan/<token>`, opened by a
  // signed-in staff member, comes here (lib/scanLanding, UI_RULES §172) and the page resolves it at
  // once, exactly as it does a code its own camera reads.
  scan: (code) => (code ? `${CREW_HOME_PATH}/scan?code=${enc(code)}` : `${CREW_HOME_PATH}/scan`),
});

// True for a path inside the cleaner's app (the home and every screen under it).
export function isCrewAppPath(pathname) {
  const p = String(pathname || '');
  return p === CREW_HOME_PATH || p.startsWith(`${CREW_HOME_PATH}/`);
}
