// app-routes — every surface App.jsx routes to: the one list the browser sweeps share.
//
// reskin-sweep (lint:reskin), responsive-sweep (lint:responsive) and style-snapshot once kept hand lists
// of routes, and hand lists go stale: by 2026-09-24 the last two still swept `/complaints` (a route
// App.jsx no longer declares, so it rendered the not-found page) and `/contacts/<id>` (a redirect), and
// never swept `/drafts`, `/reports`, `/time`, `/login`, a conversation, a saved quote or either public
// page. Reading App.jsx means a new route is swept the day it lands. A route that takes a parameter fails
// here until it has a seeded demo id below, and a sweep fails when that id's page says "not found": an
// empty detail page has no layout to break or colour to leak, so it would pass vacuously.
// test-app-routes.mjs holds all of this in CI.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseRoutes } from './search-lint.mjs';
import { IDENTITY } from '../src/brand/identity.generated.js';

const APP_JSX = fileURLToPath(new URL('../src/App.jsx', import.meta.url));
const readApp = () => fs.readFileSync(APP_JSX, 'utf8');

// The seeded demo ids (src/data/seed.js, src/data/demoStubs.js) for the routes that take a parameter. A
// route lists more than one path when a value renders a different state: `/quotes/new` is the empty
// editor behind "New quote".
export const PARAMS = {
  '/schedule/:jobId': ['/schedule/j_seed_today-2'],
  // The Cleaner Hub's checklist page (Brief B): the crew demo's own Las Olas clean.
  '/my-day/checklist/:jobId': ['/my-day/checklist/j_seed_cs-today-1'],
  // The Cleaner Hub's Clock In / Clock Out screen (brief A), on the same clean of the manager's day.
  '/my-day/clock/:jobId': ['/my-day/clock/j_seed_today-2'],
  // Coral Bay HOA too: the client hub redesign's Documents and Messages tabs are swept on it.
  '/clients/:clientId': ['/clients/cl_seed_evergreen', '/clients/cl_seed_mtbaker'],
  '/invoices/:invoiceId': [`/invoices/${IDENTITY.monogram}-1001`], // the seed numbers invoices by the brand's monogram
  '/quotes/:id': ['/quotes/quote_aventura', '/quotes/new'],
  '/messaging/:conversationId': ['/messaging/cv_seed_c1'],
  '/settings/team/:userId': ['/settings/team/u_seed_kyler'],
  '/quote/:token': ['/quote/tokquote_aventura'],
  '/inspect/:token': ['/inspect/tok_ir_lasolas'],
  // The satisfaction survey's public page (Matt's approved messages, 2026-10-19), on the demo's one
  // sample link (src/lib/surveysApi.js DEMO_SURVEY_TOKEN): an open survey, the rating and comment form.
  '/survey/:token': ['/survey/demoSurveySampleLink0000000000000000000001'],
  // The three answers a code can give (src/data/demoScanCodes.js): cleaned hours ago, cleaned over a
  // day ago (the same calm card since QR-28: no warning), and never cleaned yet.
  '/scan/:token': [
    '/scan/demoCoralBayLobby000000000000001',
    '/scan/demoCoralBayRestrooms00000000001',
    '/scan/demoCoralBayFloors00000000000001',
  ],
  // QR Wave 2 (UI_RULES §175): the office's area page on Coral Bay HOA's Clubhouse — the lobby (cleaned a
  // few hours ago, its photo, an open request, the manager's day on site) and the hall floors (no clean
  // on record).
  '/areas/:siteId/:areaId': ['/areas/st_seed_mtb-clbhs/area_lobby', '/areas/st_seed_mtb-clbhs/area_floors'],
  // The customer hub (Phase 2 Wave 2 Round 2), on the demo's seeded customer contact
  // (src/data/demoStubs.js DEMO_CLIENT_USER): Coral Bay HOA and its seeded records. The
  // redesign (2026-10-08) sweeps Home in two crew states — Coral Bay on site, Flagler Townhomes
  // with its visit done (the manager's day, data/demoManagerDay.js) — and every section page.
  '/hub/b/:buildingId': ['/hub/b/cl_seed_mtbaker', '/hub/b/cl_seed_salishan'],
  '/hub/b/:buildingId/visit': ['/hub/b/cl_seed_mtbaker/visit'],
  '/hub/b/:buildingId/tickets': ['/hub/b/cl_seed_mtbaker/tickets'],
  '/hub/b/:buildingId/checklists': ['/hub/b/cl_seed_mtbaker/checklists'],
  '/hub/b/:buildingId/inspections': ['/hub/b/cl_seed_mtbaker/inspections'],
  '/hub/b/:buildingId/history': ['/hub/b/cl_seed_mtbaker/history'],
  // Builder C: Coral Bay's invoices (the demo QuickBooks book, every state) and its documents (the
  // master agreement, a COI, the W-9); Bayshore's show an EXPIRED certificate.
  '/hub/b/:buildingId/invoices': ['/hub/b/cl_seed_mtbaker/invoices'],
  '/hub/b/:buildingId/documents': ['/hub/b/cl_seed_mtbaker/documents', '/hub/b/cl_seed_olympic/documents'],
  '/hub/b/:buildingId/messages': ['/hub/b/cl_seed_mtbaker/messages'],
  '/hub/b/:buildingId/tickets/new': ['/hub/b/cl_seed_mtbaker/tickets/new'],
  '/hub/b/:buildingId/tickets/:ticketId': ['/hub/b/cl_seed_mtbaker/tickets/pr_coralbay_windows'],
  '/hub/b/:buildingId/checklists/:checklistId': ['/hub/b/cl_seed_mtbaker/checklists/cr_coralbay_floors_2'],
  '/hub/b/:buildingId/inspections/:inspectionId': ['/hub/b/cl_seed_mtbaker/inspections/ir_coralbay_fail'],
  // One area's page (QR-16, QR Wave 2), on the Clubhouse's demo areas: cleaned hours ago, and never.
  '/hub/b/:buildingId/areas/:areaId': ['/hub/b/cl_seed_mtbaker/areas/area_lobby', '/hub/b/cl_seed_mtbaker/areas/area_floors'],
  // The Cleaner Hub (Builder C, 2026-10-13): a client request routed to Demo Crew (the seeded book's
  // Las Olas lobby streaks, src/data/demoStubs.js). A cleaner's own page: a sweep drawn as anyone not on
  // that ticket sees "This request isn't on your list anymore." (its layout still swept).
  '/my-day/requests/:ticketId': ['/my-day/requests/pr_lasolas_lobby'],
  // One supply order's page (S131, src/data/demoStubs.js): Keisha's orders at Coral Bay HOA (her stop in
  // the demo's day) — the partly delivered one (a line delivered with its photo, a backorder, a comment,
  // Mark Completed held back), the one waiting for approval, and the completed one with its invoice.
  '/supplies/orders/:id': ['/supplies/orders/sr_seed_prc-partial', '/supplies/orders/sr_seed_prc-wait', '/supplies/orders/sr_seed_lomg-week'],
  // One of the cleaner's own supply orders (S131 Builder C): Keisha's partly delivered order at Coral Bay
  // HOA (a line delivered, a line backordered with its ETA) and her order waiting for approval. The
  // sweep's viewer is the office, which the crew door lets read any order.
  '/my-day/supplies/orders/:id': ['/my-day/supplies/orders/sr_seed_prc-partial', '/my-day/supplies/orders/sr_seed_prc-wait'],
};
// The catch-all's page, reached through a path no route declares.
export const NOT_FOUND = '/no-such-page';

const concrete = (p) => {
  if (!p.includes('/:')) return [p];
  if (!PARAMS[p]) throw new Error(`app-routes: no demo id for the route ${p}; add it to PARAMS in scripts/app-routes.mjs`);
  return PARAMS[p];
};

/** Every path to sweep, sorted: the page routes, each parameter route's demo paths, the public pages and the catch-all. */
export function appRoutes(appSrc = readApp()) {
  const { pageRoutes, paramRoutes, publicPaths } = parseRoutes(appSrc);
  const out = [...pageRoutes.keys(), ...[...paramRoutes, ...publicPaths].flatMap(concrete)];
  if (/<Route\s+path="\*"/.test(appSrc)) out.push(NOT_FOUND);
  return [...new Set(out)].sort();
}

/** The paths that render outside the app shell (no `.main` to wait for): the login and the public pages. */
export function publicRoutes(appSrc = readApp()) {
  return [...new Set([...parseRoutes(appSrc).publicPaths].flatMap(concrete))].sort();
}

/** PARAMS keys App.jsx no longer declares (a removed or redirected route); test-app-routes.mjs fails on one. */
export function staleParams(appSrc = readApp()) {
  const { paramRoutes, publicPaths } = parseRoutes(appSrc);
  const live = new Set([...paramRoutes, ...publicPaths]);
  return Object.keys(PARAMS).filter((p) => !live.has(p));
}

/** The demo paths, whose page must find its record. */
export const DEMO_PATHS = new Set(Object.values(PARAMS).flat().filter((p) => p !== '/quotes/new'));

/**
 * Run in the page (page.evaluate): true when a detail page could not find its record. Each one says so in
 * its heading or error ("Company not found", "Invoice not found", "Job not found", "Team member not
 * found", "Quote not found.", "Document not found", "Report not found"); the QR scan page says "This code
 * is no longer active." (src/lib/areaScan.js).
 */
export function missingRecord() {
  return /\bnot found\b|\bthis code is no longer active\b/i.test(document.body.innerText || '');
}
