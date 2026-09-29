// One canonical location per customer.
//
// Clean Space collapsed the old multi-Site-per-Client model to exactly ONE
// location per customer (2026-09-10). The location record is still a `site`
// internally — it stays the operational key for jobs, keys, geofencing, variance,
// and media, and maps to the server's `site_id` column at go-live — but there is
// now exactly one per client and no add/remove-site UX.
//
// These helpers are the SINGLE source of the location + billing shape, shared by
// the seed (data/seed.js), the v53 store migration (store/persist.js), and
// ADD_CLIENT (store/reducer.js), so a customer minted by any path is identical.

import { composeAddress } from './address.js';

// Build the single location (a `site`) for a customer from its account address.
// `id` is deterministic (`st_loc_<clientId>`) so a re-run or a failed save can
// never mint a second location for the same customer. Geofence coords are null
// until the address is geocoded server-side (inert in the local demo); the site's
// own expected clean time defaults to the customer's service duration so variance
// always has a baseline. Every field is a pure function of the input (no wall
// clock, no random) so collapseToSingleLocationV53 can reuse this builder and
// stay idempotent for the go-live data-op.
export function buildClientLocation(client, services = []) {
  const svc = (services || []).find((x) => x && x.id === client.serviceId);
  const expectedCleanMins =
    svc && typeof svc.defaultDurationMins === 'number' ? svc.defaultDurationMins : 60;
  const street = client.street || '';
  const city = client.city || '';
  const state = client.state || '';
  const zip = client.zip || '';
  return {
    id: `st_loc_${client.id}`,
    clientId: client.id,
    siteContactId: client.primaryContactId ?? null,
    name: 'Main Location',
    address: composeAddress({ street, city, state, zip }),
    street,
    city,
    state,
    zip,
    accessNotes: '',
    cleaningAreas: [],
    lat: null,
    lng: null,
    geofenceEnabled: true,
    expectedCleanMins,
    // Mirror the account's createdAt; fall back to null, NEVER the wall clock, so
    // the builder is pure. A Date.now() here made migrate(migrate(x)) differ from
    // migrate(x) on any createdAt-less client (v53 collapse / go-live data-op).
    // Live adds (ADD_CLIENT, seed) always pass a real createdAt, so this is the
    // legacy-migration edge only.
    createdAt: client.createdAt || null,
  };
}

// A vendor is not a customer and never gets a clean, so it gets no location.
export const clientGetsLocation = (client) => !!client && client.type !== 'vendor';

// Customer-level billing settings shown in the Overview "Billing information"
// section. Defaults are safe for a fresh customer; `applyBillingDefaults` fills
// only the absent keys so a migration preserves any value already set.
export const CLIENT_BILLING_DEFAULTS = {
  billingEmail: null,
  billingSameAsLocation: true,
  billingStreet: '',
  billingCity: '',
  billingState: '',
  billingZip: '',
  paymentTerms: 'net30',
  poRequired: false,
  poNumber: '',
  taxExempt: false,
  taxRateOverride: null,
};

export function applyBillingDefaults(client) {
  const out = { ...client };
  for (const [k, v] of Object.entries(CLIENT_BILLING_DEFAULTS)) {
    if (out[k] === undefined) out[k] = v;
  }
  return out;
}

// Collapse a multi-Site-per-Client state to ONE location per customer. Pure and
// idempotent. Drives the v53 store migration (persist.js migrateV52toV53) and is the
// reusable transform for the go-live server-side data-op. Rules:
//  - survivor per client: coords-bearing first (so a geofenced account never
//    collapses onto a coordless location and silently disables clock-in), then
//    oldest, then lowest id;
//  - jobs/invoices/keys re-home onto the survivor (a dangling siteId falls back to
//    the row's own client survivor); keys never end null;
//  - a 0-site CUSTOMER gains one synthesized location, a vendor gains none;
//  - billing fields are backfilled default-safe.
export function collapseToSingleLocationV53(state) {
  const s = state || {};
  const clients = Array.isArray(s.clients) ? s.clients : [];
  const sites = Array.isArray(s.sites) ? s.sites : [];
  const services = Array.isArray(s.services) ? s.services : [];
  const hasCoords = (st) => Number.isFinite(st?.lat) && Number.isFinite(st?.lng);

  const byClient = new Map();
  for (const st of sites) {
    if (!st || !st.clientId) continue;
    if (!byClient.has(st.clientId)) byClient.set(st.clientId, []);
    byClient.get(st.clientId).push(st);
  }
  const survivorByClient = new Map();
  for (const [clientId, arr] of byClient) {
    const survivor = arr.slice().sort((a, b) => {
      const c = (hasCoords(b) ? 1 : 0) - (hasCoords(a) ? 1 : 0);
      if (c) return c;
      const t = new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
      if (t) return t;
      return String(a.id).localeCompare(String(b.id));
    })[0];
    survivorByClient.set(clientId, survivor.id);
  }

  const nextSites = sites.filter((st) => survivorByClient.get(st.clientId) === st.id);

  for (const c of clients) {
    if (!c || survivorByClient.has(c.id) || !clientGetsLocation(c)) continue;
    const loc = buildClientLocation(c, services);
    nextSites.push(loc);
    survivorByClient.set(c.id, loc.id);
  }

  const siteById = new Map(sites.map((st) => [st.id, st]));
  const nameById = new Map(nextSites.map((st) => [st.id, st.name || '']));
  const survFor = (siteId, clientId) => {
    const st = siteById.get(siteId);
    const cid = st ? st.clientId : clientId;
    return survivorByClient.get(cid) ?? siteId ?? null;
  };
  const jobs = Array.isArray(s.jobs)
    ? s.jobs.map((j) => { const sid = survFor(j.siteId, j.clientId); return sid === j.siteId ? j : { ...j, siteId: sid }; })
    : s.jobs;
  const invoices = Array.isArray(s.invoices)
    ? s.invoices.map((inv) => { const sid = survFor(inv.siteId, inv.clientId); return sid === inv.siteId ? inv : { ...inv, siteId: sid }; })
    : s.invoices;
  const keys = Array.isArray(s.keys)
    ? s.keys.map((k) => { const sid = survFor(k.siteId, k.clientId); return sid === k.siteId ? k : { ...k, siteId: sid, siteName: nameById.get(sid) ?? k.siteName }; })
    : s.keys;

  const nextClients = clients.map((c) => applyBillingDefaults(c));

  return { ...s, version: 53, sites: nextSites, jobs, invoices, keys, clients: nextClients };
}
