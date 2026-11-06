// QuickBooks Online — the business RULES shared by the server route (api/quickbooks), the demo
// stub (lib/qboApi.js) and the Settings screens. PURE and node-safe: no React, no store, no
// network, no import.meta, so the server imports it with the .js extension (DEV_PLAYBOOK 3.4.16)
// and the offline suites run it headlessly.
import { splitNumberedName, quickBooksNumber } from './customerNumber.js';

// The QuickBooks dimensions a property can be linked on. The API's `department` is what
// QuickBooks shows as a Location.
export const QBO_DIMENSIONS = Object.freeze(['customer', 'class', 'department']);

// ── ONE DIMENSION PER COMPANY (CS-565) ───────────────────────────────────────
// A QuickBooks transaction can carry a customer AND a class AND a location, so property A linked
// to the customer and property B linked to the class each received the full amount, and the
// owner's book tiles summed both, above the company's own total. So a company's property links
// live on ONE dimension: PUT links refuses another (409 dimension_mismatch), the P&L counts only
// this one, and the Link dialog offers only this one once a property is linked.
//
// `links` are one company's (realm's) link rows, server ({ entity_type }) or client
// ({ entityType }) shaped. Links made before the rule may be mixed: the MAJORITY wins, a tie goes
// customer → class → location (QB-2: each building is a customer). null = nothing linked yet.
export function realmDimension(links) {
  const counts = new Map();
  for (const l of Array.isArray(links) ? links : []) {
    const type = l && (l.entity_type ?? l.entityType);
    if (QBO_DIMENSIONS.includes(type)) counts.set(type, (counts.get(type) || 0) + 1);
  }
  let best = null;
  for (const dim of QBO_DIMENSIONS) {
    if ((counts.get(dim) || 0) > (best ? counts.get(best) : 0)) best = dim;
  }
  return best;
}

// ── THE "NEEDS MATCHING" LIST (QB-12) ────────────────────────────────────────
// Matt, 2026-09-29: "When a QuickBooks customer doesn't match an account in the app? (a) Put it
// on a 'needs matching' list for your analyst." Buildings are QuickBooks CUSTOMERS (QB-2), some
// of them jobs under a parent customer (a management company).

// Every customer id BELOW a linked one: its money already reaches a property through that link
// (report.js attributeToLinked gives a sub-customer's amounts to its nearest linked parent), so
// it does not need matching. Cycle-safe.
export function coveredByLinks(entities, linkedIds) {
  const linked = new Set((linkedIds || []).map(String));
  const children = new Map();
  for (const e of entities || []) {
    if (!e || e.parentId == null) continue;
    const p = String(e.parentId);
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(String(e.id));
  }
  const covered = new Set();
  const stack = [...linked];
  while (stack.length) {
    for (const kid of children.get(stack.pop()) || []) {
      if (!covered.has(kid) && !linked.has(kid)) { covered.add(kid); stack.push(kid); }
    }
  }
  return covered;
}

// The list: QuickBooks customers that are ACTIVE, have ACTIVITY in the window (`activeIds`, a Set
// of customer ids with money on their own P&L column; null = not known yet, then every active
// one is listed), and reach no property — neither linked themselves nor under a linked parent.
// `entities` is the COMPLETE customer list ({ id, name, active, parentId }). Rows carry the
// number QuickBooks gives the customer (its name's four digits) and its parent's name; numbered
// customers first, by number, then the rest by name. `counts` says what was left out and why.
export function needsMatching({ entities, linkedIds, activeIds = null }) {
  const all = (entities || []).filter((e) => e && e.id != null);
  const byId = new Map(all.map((e) => [String(e.id), e]));
  const linked = new Set((linkedIds || []).map(String));
  const covered = coveredByLinks(all, [...linked]);
  const counts = { total: all.length, active: 0, linked: 0, covered: 0, quiet: 0, unmatched: 0 };
  const customers = [];
  for (const e of all) {
    if (e.active === false) continue;
    counts.active += 1;
    const id = String(e.id);
    if (linked.has(id)) { counts.linked += 1; continue; }
    if (covered.has(id)) { counts.covered += 1; continue; }
    if (activeIds && !activeIds.has(id)) { counts.quiet += 1; continue; }
    const parent = e.parentId != null ? byId.get(String(e.parentId)) : null;
    customers.push({
      id, name: e.name || id, number: quickBooksNumber(e.name),
      parentId: parent ? String(parent.id) : null, parentName: parent ? (parent.name || null) : null,
    });
  }
  counts.unmatched = customers.length;
  customers.sort((a, b) => {
    if (a.number && b.number) return a.number.localeCompare(b.number);
    if (a.number || b.number) return a.number ? -1 : 1;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });
  return { customers, counts };
}

// A name compared loosely: case, punctuation and spacing ignored ("Ball Harbor Village, LLC"
// still differs from "Ball Harbor" — only the spelling noise goes).
const loose = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The app customer a QuickBooks customer most likely IS — offered, never applied: first the one
// carrying the same four-digit number (GO-2), else the one with the same name once the number is
// set aside. A customer already linked to QuickBooks (`linkedClientIds`) is never suggested, and
// neither is a vendor.
export function suggestAccountFor(qboName, clients, linkedClientIds = []) {
  const taken = new Set(linkedClientIds || []);
  const open = (clients || []).filter((c) => c && !taken.has(c.id) && c.type !== 'vendor');
  const number = quickBooksNumber(qboName);
  if (number) {
    const byNumber = open.find((c) => c.customerNumber === number);
    if (byNumber) return byNumber;
  }
  const want = loose(splitNumberedName(qboName).name);
  if (!want) return null;
  return open.find((c) => loose(c.name) === want) || null;
}

// The reverse view: the app's customers with no QuickBooks link at all. `isActive(client)` says
// which count (the screen passes the app's own status rule): a lead or a vendor is not a
// building QuickBooks bills yet.
export function accountsWithoutQuickBooks(clients, linkedClientIds, { isActive = () => true } = {}) {
  const linked = new Set(linkedClientIds || []);
  return (clients || []).filter((c) => c && c.type !== 'vendor' && !linked.has(c.id) && isActive(c));
}

// The ACTIVITY read is a P&L over the window, summarized by customer and filtered to a chunk of
// ids at a time (one whole-book report timed out, CS-598). A chunk keeps each customer with its
// own sub-customers (a parent and its jobs in one report, so its roll-up column always follows its
// own), packed up to `size` ids; a family larger than `size` is split on its own. Active customers
// only. Ids sorted numerically inside a chunk, so a chunk's cache key is stable.
export const ACTIVITY_CHUNK = 150;
export function activityChunks(entities, size = ACTIVITY_CHUNK) {
  const active = (entities || []).filter((e) => e && e.id != null && e.active !== false);
  const ids = new Set(active.map((e) => String(e.id)));
  const parentOf = new Map(active.map((e) => [String(e.id), e.parentId != null ? String(e.parentId) : null]));
  const rootOf = (id) => {
    const seen = new Set();
    let cur = id;
    while (parentOf.get(cur) && ids.has(parentOf.get(cur)) && !seen.has(cur)) { seen.add(cur); cur = parentOf.get(cur); }
    return cur;
  };
  const families = new Map();
  for (const id of ids) {
    const root = rootOf(id);
    if (!families.has(root)) families.set(root, []);
    families.get(root).push(id);
  }
  const num = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  const chunks = [];
  let current = [];
  for (const root of [...families.keys()].sort(num)) {
    const family = families.get(root).sort(num);
    if (family.length > size) {
      if (current.length) { chunks.push(current); current = []; }
      for (let i = 0; i < family.length; i += size) chunks.push(family.slice(i, i + size));
      continue;
    }
    if (current.length + family.length > size) { chunks.push(current); current = []; }
    current.push(...family);
  }
  if (current.length) chunks.push(current);
  return chunks.map((c) => c.sort(num));
}
