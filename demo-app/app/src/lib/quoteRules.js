// A quote's life after it leaves the office — the ONE set of rules the quotes route
// (api/quotes), its store (api/_lib/quotes/store.js), the demo stub (lib/quotesApi) and the
// screens (pages/Quotes.jsx, pages/QuoteEditor.jsx) read. PURE, no imports.

export const QUOTE_STATUS = Object.freeze({ draft: 'draft', sent: 'sent', signed: 'signed', void: 'void' });

// 🔴 CS-028: ONLY A DRAFT IS EVER DELETED. Once a quote is sent it is a record: the customer
// holds a link to it, and a SIGNED one is an executed agreement with its signed PDF — so it is
// voided, never deleted (the list used to offer Delete on a signed quote, its dialog saying it
// "permanently deletes the signed document"). The server holds it with the status predicate ON
// the delete, so a send landing in the same moment wins.
export const QUOTE_DELETABLE_STATUSES = Object.freeze([QUOTE_STATUS.draft]);
export const isQuoteDeletable = (quote) => !!quote && QUOTE_DELETABLE_STATUSES.includes(quote.status);
// What can be voided: anything that went out and is not void already (a draft is deleted instead).
export const isQuoteVoidable = (quote) => !!quote && (quote.status === QUOTE_STATUS.sent || quote.status === QUOTE_STATUS.signed);

// The refusal, as the route answers it (409). An API body stays English (UI_RULES §140).
export const QUOTE_NOT_DELETABLE = Object.freeze({
  code: 'quote-not-deletable',
  error: 'This quote was sent, so it is kept as a record. Void it instead of deleting it.',
});

// 🔴 CS-664: WHY A SENT QUOTE WAS NOT EMAILED (the route's `why` beside `emailed: false`). The live
// app has no sending mailbox, so Send emailed nothing while the screen said "Sent to X for
// signature". The quote is still marked sent — its signing link works — and the editor hands the
// office that link to send themselves (components/QuoteLinkModal.jsx).
//   not-set-up    no sending mailbox is connected (or it needs reconnecting): every send is skipped
//   no-recipient  the contact has no email address on file
//   failed        the mailbox tried and the send failed
export const QUOTE_NOT_EMAILED = Object.freeze({ notSetUp: 'not-set-up', noRecipient: 'no-recipient', failed: 'failed' });
// The editor's sentence for each reason (a catalog key; the editor fills in the contact's name).
export const QUOTE_NOT_EMAILED_KEYS = Object.freeze({
  [QUOTE_NOT_EMAILED.notSetUp]: 'quoteSend.notSetUp',
  [QUOTE_NOT_EMAILED.noRecipient]: 'quoteSend.noRecipient',
  [QUOTE_NOT_EMAILED.failed]: 'quoteSend.failed',
});
export const quoteNotEmailedKey = (why) => QUOTE_NOT_EMAILED_KEYS[why] || QUOTE_NOT_EMAILED_KEYS[QUOTE_NOT_EMAILED.notSetUp];

// What the customer's signing page says about THEIR copy (CS-664) — a promise of an email only
// when one can go: `canEmail` is the page's read of whether the office can send at all (GET
// /api/public/pay/:token `copy_by_email`), `emailed` is whether this signature's copy actually
// went (the sign answer). A catalog key, read through english() (the customer's page, LANG-8).
export function publicCopyLineKey({ justSigned = false, emailed = false } = {}) {
  if (justSigned) return emailed ? 'publicQuote.copyEmailed' : 'publicQuote.copyBelow';
  return 'publicQuote.signedBelow';
}
