// The words of the hub's Invoices and Documents (the client hub redesign, Builder C, Wave B; Matt's
// boards mobile-05 / mobile-06 / web-04 / web-05 and Home's tiles) — PURE, so the pages, the Home
// tiles and scripts/test-hub-paperwork.mjs read one rule. The hub stays English (LANG-8). Money is
// the server's INTEGER CENTS, shown by lib/money moneyCents; days are the server's org-zone day
// keys, shown by lib/dates fmtDate (which anchors a bare day at the org's noon).
import { fmtDate } from '../../lib/dates.js';
import { moneyCents } from '../../lib/money.js';
import { HUB_INVOICE_STATE, HUB_INVOICE_STATE_SENTENCES, INVOICE_STATUS } from '../../lib/hubInvoices.js';
import { AGREEMENT_DOCUMENT_ID, CUSTOMER_DOCUMENT_KIND } from '../../lib/customerDocuments.js';

const shortDay = (day) => (day ? fmtDate(day, { month: 'short', day: 'numeric' }) : '');
const longDay = (day) => (day ? fmtDate(day, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

// ── Invoices ─────────────────────────────────────────────────────────────────
// Matt's words, verbatim (his note s2: no pay button here, by design).
export const INVOICE_BANNER = 'View-only here — billing and payment are handled through QuickBooks.';

export const INVOICE_BADGE = Object.freeze({
  [INVOICE_STATUS.open]: { variant: 'amber', label: 'Open' },
  [INVOICE_STATUS.overdue]: { variant: 'red', label: 'Overdue' },
  [INVOICE_STATUS.paid]: { variant: 'green', label: 'Paid' },
});

// A row still owed (open or overdue) is tinted on the desktop table and edged on the phone card.
export const invoiceOwed = (r) => !!r && r.status !== INVOICE_STATUS.paid;

// "Due Oct 13", or for a paid one "Paid Sep 2" ("Paid" when QuickBooks names no payment day).
export function invoiceDueLine(r) {
  if (!r) return '';
  if (r.status === INVOICE_STATUS.paid) return r.paidDay ? `Paid ${shortDay(r.paidDay)}` : 'Paid';
  return r.dueDay ? `Due ${shortDay(r.dueDay)}` : '';
}
// The phone card's line: "Issued Sep 29 · Due Oct 13".
export const invoiceDaysLine = (r) => [r?.issuedDay ? `Issued ${shortDay(r.issuedDay)}` : '', invoiceDueLine(r)].filter(Boolean).join(' · ');
// "Partly paid · $480.50 still due" — what is still owed on a partly paid invoice; '' otherwise.
export const invoicePartlyLine = (r) => (r?.partlyPaid ? `Partly paid · ${moneyCents(r.balanceCents)} still due` : '');
export const invoiceIssuedDay = (r) => shortDay(r?.issuedDay);

// The page's sentence for a state that has no rows (lib/hubInvoices.js, the server's own words).
export const invoiceStateSentence = (state) => HUB_INVOICE_STATE_SENTENCES[state] || HUB_INVOICE_STATE_SENTENCES[HUB_INVOICE_STATE.unavailable];

// Home's tile: "1 open ($1,160.00) · 2 paid · via QuickBooks"; a short line when QuickBooks can't
// show this building's yet (the page says why in full).
const TILE_SHORT = Object.freeze({
  [HUB_INVOICE_STATE.notConnected]: 'Not connected yet',
  [HUB_INVOICE_STATE.notLinked]: 'Not set up for this building yet',
  [HUB_INVOICE_STATE.unsupportedDimension]: 'Not set up for this building yet',
  [HUB_INVOICE_STATE.unavailable]: "QuickBooks isn't answering right now",
});
export function invoicesTileLine(data) {
  if (!data) return '';
  if (data.state !== HUB_INVOICE_STATE.ready) return TILE_SHORT[data.state] || TILE_SHORT[HUB_INVOICE_STATE.unavailable];
  if (!data.total) return 'No invoices in the last 12 months';
  const s = data.summary || {};
  const open = s.openCount ? `${s.openCount} open (${moneyCents(s.openCents)})` : 'Nothing owed';
  return `${open} · ${s.paidCount || 0} paid · via QuickBooks`;
}

// ── Documents ────────────────────────────────────────────────────────────────
// Matt's note line, verbatim.
export const DOCUMENTS_NOTE = "These documents are specific to this property. Switch properties to see that location's paperwork.";
export const AGREEMENT_NO_FILE = 'Signed copy not on file yet.';

// Each card's icon and tint (the board: the agreement indigo, the COI green, the W-9 amber).
const LOOK = Object.freeze({
  agreement: { icon: 'forms', tone: 'blue' },
  [CUSTOMER_DOCUMENT_KIND.coi]: { icon: 'check', tone: 'green' },
  [CUSTOMER_DOCUMENT_KIND.w9]: { icon: 'folder', tone: 'amber' },
  [CUSTOMER_DOCUMENT_KIND.other]: { icon: 'paperclip', tone: 'slate' },
});

// The cards in the order drawn: the agreement first, then the documents as the server ordered
// them. The agreement's line is "Started <day>" (the board's "Signed" — the contract has no signed
// day, plan §3.6); with no signed copy on file it says so and offers nothing to open. A document
// is "Valid through <day>" (and Expired after it, the org's day, judged on the server) or "On file".
export function hubDocumentCards(data) {
  const cards = [];
  const a = data?.agreement;
  if (a) {
    cards.push({
      id: AGREEMENT_DOCUMENT_ID, look: LOOK.agreement, title: a.title,
      line: a.hasFile ? (a.startedDay ? `Started ${longDay(a.startedDay)}` : 'On file') : AGREEMENT_NO_FILE,
      expired: false, canOpen: !!a.hasFile,
    });
  }
  for (const d of Array.isArray(data?.documents) ? data.documents : []) {
    let line = 'On file';
    if (d.validUntil) line = d.expired ? `Was valid through ${longDay(d.validUntil)}` : `Valid through ${longDay(d.validUntil)}`;
    cards.push({ id: d.id, look: LOOK[d.kind] || LOOK.other, title: d.title, line, expired: !!d.expired, canOpen: true });
  }
  return cards;
}

// Home's tile: the names it has, each once — "Service agreement · COI · W-9".
const SHORT_NAME = Object.freeze({ [CUSTOMER_DOCUMENT_KIND.coi]: 'COI', [CUSTOMER_DOCUMENT_KIND.w9]: 'W-9' });
export function documentsTileLine(data) {
  if (!data) return '';
  const names = [];
  if (data.agreement) names.push('Service agreement');
  for (const d of Array.isArray(data.documents) ? data.documents : []) {
    const name = SHORT_NAME[d.kind] || d.title;
    if (name && !names.includes(name)) names.push(name);
  }
  return names.length ? names.join(' · ') : 'No documents yet';
}
