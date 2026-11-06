// FilterSpec[] for the Quality hub's TEMPLATES tab — the same engine as the records tab,
// Schedule and Variance (lib/filters), composed to the one facet a template list supports
// since checklists became per-customer (R2, plan step 5).
//
// The templates list is a COMPLETE client-side list (qcApi.listTemplates reads every row),
// so unlike inspectionFilters this spec carries a `match()` and the engine filters in the
// browser through applyFilters. What it matches is the SHARED rule the server's query and
// the demo stub both use (lib/inspections templateMatchesFilters) — the Customer column a
// row shows and the rows a customer's filter keeps can then never disagree.
//
// ctx = { customers: [{ id, name }] } — the roster is passed IN rather than read from the
// store, so this module imports only the pure rule module and stays node-loadable (the
// offline suite drives the matching directly instead of eyeballing it in a browser).
import { templateMatchesFilters } from '../inspections.js';
import { customerLabel } from '../customerNumber.js';

// The "filed under nobody" row. A sentinel, not a client id: '' is already the engine's
// "no constraint" value, and null cannot ride in a URL.
export const TEMPLATE_STARTERS = '__starters';

export const templateFilterSpecs = [
  {
    key: 'cust',
    label: 'Customer',
    kind: 'single',
    // '' = no constraint, so useUrlFilters drops the param and the URL stays clean.
    defaultValue: '',
    options: (ctx) => [
      { value: '', label: 'All customers' },
      { value: TEMPLATE_STARTERS, label: 'Starters (no customer)' },
      ...((ctx && ctx.customers) || []).map((c) => ({ value: c.id, label: customerLabel(c) || c.id })),
    ],
    // Filtering by customer is a question ABOUT CHECKLISTS: an inspection template is
    // company-wide, so it belongs to no customer and is not a starter either. Both
    // branches therefore pin kind='checklist', and a non-default filter hides inspections
    // — which is what the operator asked for by picking a customer.
    match: (t, value) => templateMatchesFilters(t, value === TEMPLATE_STARTERS
      ? { kind: 'checklist', starters: true }
      : { kind: 'checklist', clientId: value }),
  },
];
