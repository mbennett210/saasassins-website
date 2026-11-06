// CUSTOMER NUMBERS — "0001 Ball Harbor Village" (GO-2, CS-068). THE one rule, pure and node-safe:
// the reducer (ADD_CLIENT / UPDATE_CLIENT), every screen that names or edits a customer, the
// QuickBooks link and the Customers page's CSV import (the tool Clean Space's own team uses to
// enter its buildings — they do the data entry, not us: kickoff 2026-09-10 §H) all read it, so no
// two of them can disagree.
//
// Matt, 2026-09-29 (GO-2): "Four digits plus the name, like '0001 Ball Harbor Village'. Match
// what we have in QuickBooks now. That's the name and IDs we use across all platforms." The
// kickoff (2026-09-10, E): "auto-assign the next customer code by scanning existing customers…
// Never delete customers — reactivating a former customer keeps the same ID."
//
//   · STORED as `client.customerNumber`, a four-digit STRING ("0001": the zeros are part of it).
//     Additive and default-safe in the shared record: absent or null = no number yet.
//   · SOURCES, in order: the linked QuickBooks customer's own number (the four digits its name
//     starts with — never invented when QuickBooks has none), else the office types it. A new
//     customer is OFFERED the next number (the highest in use + 1).
//   · UNIQUE across the book, inactive customers included: a number stays its customer's while
//     they are away and comes back with them, so nobody else may take it and auto-next never
//     re-issues it.
//   · This replaces the app's own sequential "Contact #" (#1042), which no other platform knew —
//     the kickoff's "swap the app's customer-ID numbering to Clean Space's convention".

export const CUSTOMER_NUMBER_DIGITS = 4;
const STORED = /^\d{4}$/;

// Is `v` a stored customer number ("0001"…"9999")?
export function isCustomerNumber(v) {
  return typeof v === 'string' && STORED.test(v) && v !== '0000';
}

// What the office typed → the stored form. "42" → "0042"; "" / null → null (no number);
// anything else — letters, five digits, 0000 — → undefined (refused; never guessed at).
export function normalizeCustomerNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  if (!/^\d{1,4}$/.test(s)) return undefined;
  const n = s.padStart(CUSTOMER_NUMBER_DIGITS, '0');
  return n === '0000' ? undefined : n;
}

// A customer name as Clean Space writes it everywhere — "0001 Ball Harbor Village" — split into
// its number and the rest. A name that does not start with four digits and a space has no number
// (`number: null`): QuickBooks' number is READ from the name, never made up.
export function splitNumberedName(name) {
  const s = String(name ?? '');
  const m = /^\s*(\d{4})\s+(\S.*?)\s*$/.exec(s);
  if (!m || m[1] === '0000') return { number: null, name: s.trim() };
  return { number: m[1], name: m[2] };
}
export const quickBooksNumber = (name) => splitNumberedName(name).number;

// How the office names a customer: "0001 Ball Harbor Village", or the name alone when there is no
// number yet. A name that already starts with its own number is not doubled.
export function customerLabel(client) {
  const name = String(client?.name ?? '').trim();
  const num = isCustomerNumber(client?.customerNumber) ? client.customerNumber : null;
  if (!num) return name;
  if (splitNumberedName(name).number === num) return name;
  return name ? `${num} ${name}` : num;
}

// The customer (other than `selfId`) that holds `number` — inactive customers included.
export function customerNumberHolder(clients, number, selfId = null) {
  if (!isCustomerNumber(number)) return null;
  return (clients || []).find((c) => c && c.id !== selfId && c.customerNumber === number) || null;
}

// The number to OFFER a new customer: the highest in use + 1 (every customer counted, inactive
// ones too), 0001 on an empty book; null past 9999 (the office types one).
export function nextCustomerNumber(clients) {
  let max = 0;
  for (const c of clients || []) {
    if (isCustomerNumber(c?.customerNumber)) max = Math.max(max, Number(c.customerNumber));
  }
  return max >= 9999 ? null : String(max + 1).padStart(CUSTOMER_NUMBER_DIGITS, '0');
}

// What is wrong with a typed number, for the screen to say in words: null when it may be saved
// (a free number, the customer's own, or none at all), { code: 'invalid' }, or
// { code: 'taken', number, holder } naming the customer that has it.
export function customerNumberProblem(clients, raw, selfId = null) {
  const n = normalizeCustomerNumber(raw);
  if (n === null) return null;
  if (n === undefined) return { code: 'invalid' };
  const holder = customerNumberHolder(clients, n, selfId);
  return holder ? { code: 'taken', number: n, holder } : null;
}

// THE REDUCER'S RULE — what a customer may store (ADD_CLIENT, UPDATE_CLIENT, and the Customers page's CSV import). A
// valid, free number is kept; an invalid one, or none, is null. A TAKEN number is refused (null)
// — a typed or QuickBooks number is somebody's real ID, so it is never silently changed —
// EXCEPT the auto-offered one (`bump`): two offices creating customers at once were both offered
// the same next number (CS-098's race, replayed through the reducer on sync), and a number that is
// not yet anyone's elsewhere moves on to the next free one.
export function resolveCustomerNumber(clients, requested, { selfId = null, bump = false } = {}) {
  const n = normalizeCustomerNumber(requested);
  if (!n) return null;
  if (!customerNumberHolder(clients, n, selfId)) return n;
  return bump ? nextCustomerNumber((clients || []).filter((c) => c && c.id !== selfId)) : null;
}

// Linking a property to a QuickBooks customer brings that customer's number (QuickBooks is the
// record): { number, conflict } — number null when QuickBooks has none; conflict = the OTHER
// customer that already holds it (then nothing is applied, and the screen names them).
export function numberFromQuickBooks(clients, clientId, qboName) {
  const number = quickBooksNumber(qboName);
  if (!number) return { number: null, conflict: null };
  return { number, conflict: customerNumberHolder(clients, number, clientId) };
}

// For linked properties made before numbers existed (production's first four): which customers
// should take their QuickBooks customer's number — missing, or different (QuickBooks wins) —
// and which cannot because another customer holds it. `links` are client-shaped link rows
// ({ clientId, entityType, entityName, counted }); only counted customer links take part.
export function quickBooksNumberPlan(clients, links) {
  const byId = new Map((clients || []).map((c) => [c?.id, c]));
  const apply = [];
  const conflicts = [];
  const claimed = new Set();
  for (const l of links || []) {
    if (!l || l.entityType !== 'customer' || l.counted === false) continue;
    const client = byId.get(l.clientId);
    if (!client) continue;
    const { number, conflict } = numberFromQuickBooks(clients, l.clientId, l.entityName);
    if (!number || client.customerNumber === number) continue;
    if (conflict || claimed.has(number)) { conflicts.push({ clientId: l.clientId, number, holderId: conflict?.id || null }); continue; }
    claimed.add(number);
    apply.push({ clientId: l.clientId, number, from: client.customerNumber || null });
  }
  return { apply, conflicts };
}
