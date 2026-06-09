// Server-side module price catalog — the SOURCE OF TRUTH for what a module costs.
//
// The browser only ever sends add-on *ids*; prices are resolved here so a tampered
// client can never set its own amount. Amounts are in cents (USD), one-time. Keep
// names + amounts in sync with src/demo/modules.catalog.js (display side).
//
// The Core platform is the mandatory base line item — buildLineItems() always
// prepends it, so every checkout charges Core + whatever add-ons were selected.
//
// Underscore-prefixed → Vercel treats this as a shared helper, not an endpoint.

const CORE_ID = 'core';

const MODULES = {
  core:        { name: 'PolishPoint Core Platform',           amount: 200000 },
  marketing:   { name: 'Marketing — Warm Outreach & Reviews', amount: 150000 },
  leadscraper: { name: 'AI Lead Scraper',                     amount: 150000 },
  forms:       { name: 'Forms & Lead Capture',                amount: 75000 },
  invoicing:   { name: 'Invoicing + Quoting',                 amount: 75000 },
  quickbooks:  { name: 'QuickBooks Integration',              amount: 50000 },
  inventory:   { name: 'Inventory & Key Tracking',            amount: 50000 },
  fieldops:    { name: 'Field Ops',                           amount: 80000 },
  ems:         { name: 'Employee Management System',          amount: 50000 },
  migration:   { name: 'Data Migration',                      amount: 50000 },
};

// Build Stripe Checkout line items from a list of add-on ids using SERVER-SIDE
// prices. Core is always included first as the base line item. Tolerates ['id']
// or [{ id }] shapes, ignores any client-sent amount, drops unknown ids, and
// de-dupes (so a client that also sends 'core' can't double-charge it).
// Returns { lineItems, ids }.
function buildLineItems(moduleIds) {
  const ids = [];
  const lineItems = [];
  const seen = new Set();
  const list = [CORE_ID, ...(Array.isArray(moduleIds) ? moduleIds : [])];
  for (const raw of list) {
    const id = typeof raw === 'string' ? raw : raw && raw.id;
    if (!id || seen.has(id)) continue;
    const mod = MODULES[id];
    if (!mod) continue;
    seen.add(id);
    ids.push(id);
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: mod.amount, // server price — client cannot influence this
        product_data: { name: mod.name, metadata: { moduleId: id } },
      },
    });
  }
  return { lineItems, ids };
}

module.exports = { MODULES, buildLineItems };
