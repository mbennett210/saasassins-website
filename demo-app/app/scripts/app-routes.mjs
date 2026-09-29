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
  '/clients/:clientId': ['/clients/cl_seed_evergreen'],
  '/invoices/:invoiceId': [`/invoices/${IDENTITY.monogram}-1001`], // the seed numbers invoices by the brand's monogram
  '/quotes/:id': ['/quotes/quote_aventura', '/quotes/new'],
  '/messaging/:conversationId': ['/messaging/cv_seed_c1'],
  '/settings/team/:userId': ['/settings/team/u_seed_kyler'],
  '/quote/:token': ['/quote/tokquote_aventura'],
  '/inspect/:token': ['/inspect/tok_ir_lasolas'],
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
 * found", "Quote not found.", "Document not found", "Report not found").
 */
export function missingRecord() {
  return /\bnot found\b/i.test(document.body.innerText || '');
}
