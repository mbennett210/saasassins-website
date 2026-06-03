// Server-side module price catalog — the SOURCE OF TRUTH for what a module costs.
//
// The browser only ever sends module *ids*; prices are resolved here so a tampered
// client can never set its own amount. Amounts are in cents (USD), one-time. Keep
// names + amounts in sync with src/demo/modules.catalog.js (display side).
//
// Underscore-prefixed → Vercel treats this as a shared helper, not an endpoint.

const MODULES = {
  ipr: { name: 'Invoice & Payment Routing', amount: 40000 },
  quickbooks: { name: 'QuickBooks Integration', amount: 30000 },
  inventory: { name: 'Inventory Management', amount: 40000 },
  ems: { name: 'Employee Management System', amount: 80000 },
  fieldops: { name: 'Field Ops', amount: 60000 },
};

// Build Stripe Checkout line items from a list of module ids using SERVER-SIDE
// prices. Tolerates ['id'] or [{ id }] shapes, ignores any client-sent amount,
// drops unknown ids, and de-dupes. Returns { lineItems, ids }.
function buildLineItems(moduleIds) {
  const ids = [];
  const lineItems = [];
  const seen = new Set();
  const list = Array.isArray(moduleIds) ? moduleIds : [];
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
