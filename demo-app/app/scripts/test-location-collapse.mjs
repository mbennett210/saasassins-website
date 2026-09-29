// migrateV52toV53 collapses the multi-Site-per-Client model to ONE location per
// customer. This exercises the migration's BEHAVIOR (test-persist-chain only checks
// that the hop is wired). It is failing-first by construction: before the fix
// `migrateV52toV53` did not exist, so the import is undefined and every assertion
// throws.
//
// The sharp edges it pins (the four the plan flagged):
//   1. survivor = coords-bearing first  → a geofenced account never collapses onto a
//      coordless location (which would silently disable clock-in, geo.js no_site_coords)
//   2. keys re-home to the survivor, NEVER null (v52's null-key strip would eat them)
//   3. a 0-site CUSTOMER gains a location; a 0-site VENDOR does not
//   4. idempotent: migrate(migrate(x)) deep-equals migrate(x)
//
//   node scripts/test-location-collapse.mjs
//
// The transform lives in lib/location.js (a leaf that only pulls address.js), so it
// imports cleanly in raw Node — unlike persist.js, whose Vite-style extensionless
// deps Node can't resolve. persist.js's migrateV52toV53 just calls this function.
import { collapseToSingleLocationV53 } from '../src/lib/location.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const fixture = () => ({
  version: 52,
  services: [{ id: 'svc_jan', defaultDurationMins: 90 }],
  clients: [
    // multi-site customer: a coordless OLDER site + a coords-bearing NEWER site.
    { id: 'cl_a', type: 'customer', name: 'Multi Co', serviceId: 'svc_jan', primaryContactId: 'ct_a', street: '1 A St', city: 'Miami', state: 'FL', zip: '33101' },
    // 0-site vendor: gets NO location.
    { id: 'cl_v', type: 'vendor', name: 'Vendor Co', serviceId: 'svc_jan' },
    // 0-site customer: gets ONE synthesized location.
    { id: 'cl_p', type: 'customer', name: 'Prospect Co', serviceId: 'svc_jan', primaryContactId: 'ct_p', street: '2 B St', city: 'Tampa', state: 'FL', zip: '33602' },
  ],
  sites: [
    { id: 'st_a1', clientId: 'cl_a', name: 'Coordless', accessNotes: '', expectedCleanMins: 60, createdAt: '2020-01-01T00:00:00.000Z' },
    { id: 'st_a2', clientId: 'cl_a', name: 'Geo', lat: 26.1, lng: -80.1, expectedCleanMins: 120, createdAt: '2021-01-01T00:00:00.000Z' },
  ],
  jobs: [{ id: 'j1', clientId: 'cl_a', siteId: 'st_a1' }],
  invoices: [{ id: 'inv1', clientId: 'cl_a', siteId: 'st_a1' }],
  keys: [
    { id: 'k1', clientId: 'cl_a', siteId: 'st_a1', siteName: 'Coordless' },
    { id: 'k2', clientId: 'cl_a', siteId: 'st_gone', siteName: 'Dangling' }, // points at no site
  ],
});

const out = collapseToSingleLocationV53(fixture());

// 1. exactly one site per client; the survivor is the COORDS-bearing one (st_a2),
//    even though st_a1 is older — coords-first is the top sort key.
const aSites = out.sites.filter((s) => s.clientId === 'cl_a');
ok('cl_a collapses to exactly one location', aSites.length === 1);
ok('  ...and it is the coords-bearing survivor (st_a2)', aSites[0] && aSites[0].id === 'st_a2');

// 2. dependents re-home to the survivor.
ok('job re-homed to the survivor', out.jobs[0].siteId === 'st_a2');
ok('invoice re-homed to the survivor', out.invoices[0].siteId === 'st_a2');
const k1 = out.keys.find((k) => k.id === 'k1');
const k2 = out.keys.find((k) => k.id === 'k2');
ok('key on the dropped site re-homes to the survivor', k1 && k1.siteId === 'st_a2');
ok('  ...and its denormalized siteName refreshes', k1 && k1.siteName === 'Geo');
ok('key with a DANGLING siteId falls back to the client survivor', k2 && k2.siteId === 'st_a2');
ok('NO key is left with a null siteId (v52 strip would eat it)', out.keys.every((k) => !!k.siteId));

// 3. a 0-site customer gains one location; a vendor gains none.
const pSites = out.sites.filter((s) => s.clientId === 'cl_p');
ok('0-site customer gains exactly one location', pSites.length === 1);
ok('  ...synthesized from its address (expected mins from the service default)',
  pSites[0] && pSites[0].expectedCleanMins === 90 && pSites[0].address === '2 B St, Tampa FL 33602');
ok('  ...with the deterministic id st_loc_<clientId>', pSites[0] && pSites[0].id === 'st_loc_cl_p');
// A createdAt-less client (cl_p) must get a DETERMINISTIC createdAt (null), never the
// wall clock — a Date.now() fallback in buildClientLocation was the exact defect that
// made assertion #4 (idempotency) fail ~1-in-5. This pins it DETERMINISTICALLY: a
// reintroduced clock read fails EVERY run, not just when it straddles a millisecond.
ok('  ...and a deterministic createdAt (null, never the wall clock)', pSites[0] && pSites[0].createdAt === null);
ok('vendor gains NO location', out.sites.filter((s) => s.clientId === 'cl_v').length === 0);
ok('total surviving sites is 2 (cl_a + cl_p, not the vendor)', out.sites.length === 2);

// billing defaults land default-safe on every client.
ok('billing defaults backfilled on every client',
  out.clients.every((c) => c.paymentTerms === 'net30' && c.billingSameAsLocation === true && c.taxExempt === false));

// version.
ok('output is version 53', out.version === 53);

// 4. idempotency.
const once = collapseToSingleLocationV53(fixture());
const twice = collapseToSingleLocationV53(collapseToSingleLocationV53(fixture()));
ok('migrate(migrate(x)) deep-equals migrate(x)', JSON.stringify(once) === JSON.stringify(twice));

console.log(`\nlocation collapse: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
