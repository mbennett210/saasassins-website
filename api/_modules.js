// Server-side module price catalog — the SOURCE OF TRUTH for what a module costs.
//
// The browser only ever sends module *ids*; prices are resolved here so a tampered
// client can never set its own amount. Amounts are in cents (USD), one-time. Keep
// names + amounts in sync with features.html on polishpointdev.com (each row's
// data-mod, data-name and data-price), the page that shows buyers these prices.
//
// CRM, Sales Pipeline and Messaging & SMS are in every build: buildLineItems()
// always adds them. A module with amount 0 is recorded on the order but gets no
// line of its own on Stripe's page; the CRM line names the two that are included.
//
// Underscore-prefixed → Vercel treats this as a shared helper, not an endpoint.

const CORE_ID = 'crm';
const ALWAYS_IDS = [CORE_ID, 'pipeline', 'messaging'];

const MODULES = {
  crm:        { name: 'CRM', line: 'CRM, with Sales Pipeline and Messaging & SMS', amount: 199700 },
  pipeline:   { name: 'Sales Pipeline', amount: 0 },
  salesauto:  { name: 'Sales Automation', amount: 99700 },
  messaging:  { name: 'Messaging & SMS', amount: 0 },
  drip:       { name: 'Drip Email Marketing', amount: 149700 },
  fieldops:   { name: 'Field Ops', amount: 99700 },
  workorders: { name: 'Work Orders & Assets', amount: 49700 },
  keys:       { name: 'Key Tracking', amount: 49700 },
  employee:   { name: 'Employee Management', amount: 99700 },
  qc:         { name: 'Quality Control & Inspections', amount: 49700 },
  invoicing:  { name: 'Invoicing & Quoting', amount: 99700 },
  esign:      { name: 'E-Signature & Documents', amount: 59700 },
  acct:       { name: 'Accounting Sync', amount: 49700 },
  portal:     { name: 'Customer Portal', amount: 89700 },
  afterhours: { name: 'After-hours shift coverage routing', amount: 99700 },
  coldemail:  { name: 'Cold Email Sales Agent', amount: 299700 },
  purchasing: { name: 'Purchasing & Supplier Automation', amount: 74700 },
  inventory:  { name: 'Inventory Tracking', amount: 49700 },
  migration:  { name: 'Data Migration', amount: 99700 },
  a2p:        { name: 'A2P Setup for Texting/SMS', amount: 59700 },
};

// Build Stripe Checkout line items from a list of module ids using SERVER-SIDE
// prices. The modules in every build always come first. Tolerates ['id'] or
// [{ id }] shapes, ignores any client-sent amount, drops unknown ids, and de-dupes
// (so a client that also sends 'crm' can't double-charge it).
// Returns { lineItems, ids }.
function buildLineItems(moduleIds) {
  const ids = [];
  const lineItems = [];
  const seen = new Set();
  const list = [...ALWAYS_IDS, ...(Array.isArray(moduleIds) ? moduleIds : [])];
  for (const raw of list) {
    const id = typeof raw === 'string' ? raw : raw && raw.id;
    if (!id || seen.has(id)) continue;
    const mod = MODULES[id];
    if (!mod) continue;
    seen.add(id);
    ids.push(id);
    if (!mod.amount) continue; // included: on the order's record, no line of its own
    lineItems.push({
      quantity: 1,
      price_data: {
        currency: 'usd',
        unit_amount: mod.amount, // server price — client cannot influence this
        product_data: { name: mod.line || mod.name, metadata: { moduleId: id } },
      },
    });
  }
  return { lineItems, ids };
}

module.exports = { MODULES, CORE_ID, buildLineItems };
