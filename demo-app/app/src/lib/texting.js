// CUSTOMER TEXTING — the vocabulary and the pure rules (Daniel, 2026-10-28, once Twilio went live:
// "Yes, add the Reply STOP functionality." and, for replies, "Customer thread, texted back").
// Shared by the send step (api/_lib/customerMessages/send.js), the inbound text route
// (api/sms/[...path].js, api/_lib/sms/inbound.js), the customer thread's store
// (api/_lib/clientHub/messages.js) and the office's screens, so they cannot answer differently.
//
//   · STOP / START / HELP: a reply that is one of the keywords below (the whole text, any case) is
//     a keyword, not a message. STOP records the number as opted out (sms_opt_outs, keyed by the
//     number in E.164); START clears it; HELP is Twilio's to answer. Twilio's Messaging Service
//     answers all three itself, and its Advanced Opt-Out names the kind in `OptOutType`; the words
//     are recognised here too, so nothing rests on that setting.
//   · A reply that is not a keyword becomes a customer line in its building's thread, marked as a
//     text (`via` TEXT_VIA) from that number, and the office's answer there is texted back to it
//     (`officeReplyLogId`: one sent-log row per office line, so a line is texted at most once).
//
// PURE and node-safe (an explicit .js import, no browser globals, no backend).
import { toE164 } from './alertDelivery.js';

// `client_messages.via` for a line that came in as a text. Null is a line written in the hub.
export const TEXT_VIA = 'sms';

// `sms_opt_outs.source` — the migration's CHECK holds exactly these.
export const OPT_OUT_SOURCE = Object.freeze({
  reply: 'reply',       // the number texted a STOP keyword to ours
  carrier: 'carrier',   // a text to it was refused by Twilio with 21610 ("replied STOP")
});

// Twilio's default opt-out, opt-in and help keywords (the brief's list, Daniel, 2026-10-28).
export const SMS_KEYWORDS = Object.freeze({
  stop: Object.freeze(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']),
  start: Object.freeze(['START', 'UNSTOP']),
  help: Object.freeze(['HELP', 'INFO']),
});
export const SMS_KEYWORD = Object.freeze({ stop: 'stop', start: 'start', help: 'help' });
// Advanced Opt-Out's `OptOutType` parameter, when Twilio sends it.
const OPT_OUT_TYPE = Object.freeze({ STOP: SMS_KEYWORD.stop, START: SMS_KEYWORD.start, HELP: SMS_KEYWORD.help });

// Which keyword a reply is, or null when it is a message. The WHOLE text must be the keyword (any
// case, surrounding spaces and a trailing full stop or "!" ignored): "Stop by at 5" is a message.
export function smsKeyword(body, optOutType = null) {
  const named = OPT_OUT_TYPE[String(optOutType || '').trim().toUpperCase()];
  if (named) return named;
  const word = String(body ?? '').trim().replace(/[.!]+$/, '').trim().toUpperCase();
  if (!word) return null;
  for (const [kind, words] of Object.entries(SMS_KEYWORDS)) if (words.includes(word)) return kind;
  return null;
}

// A number as the office reads it: '+17542039207' → '(754) 203-9207'. A North American number
// in any shape reads the same; anything else is shown as given (never a guess).
export function displayPhone(raw) {
  const e164 = toE164(typeof raw === 'string' ? raw : '');
  if (e164 && /^\+1\d{10}$/.test(e164)) return `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`;
  return e164 || (typeof raw === 'string' ? raw.trim() : '');
}

// ── the office's answer, texted back ─────────────────────────────────────────
// The sent-log (customer_messages) template and id of one office line's text: one row per line,
// so a retried reply never texts twice.
export const OFFICE_REPLY_TEMPLATE = 'office_reply';
export const officeReplyLogId = (lineId) => `${OFFICE_REPLY_TEMPLATE}:${lineId}`;

// The sent log's `failure_reason` for a text the send step refused: the number is opted out. The
// sample-record refusal keeps the run's own words.
export const OPTED_OUT_REASON = 'opted-out';
export const SAMPLE_RECORD_REASON = 'sample record';
export const NOT_SET_UP_REASON = 'texting is not set up';

// How an office line's text went, as the office's screen says it (the `text.status` of a line).
export const TEXT_BACK = Object.freeze({
  sent: 'sent',               // texted
  sending: 'sending',         // claimed, the send not finished
  optedOut: 'opted-out',      // the number replied STOP: not texted
  notSetUp: 'not-set-up',     // texting is not set up: not texted
  sample: 'sample',           // a sample customer: never texted
  failed: 'failed',           // Twilio refused it
});
// One sent-log row (customer_messages) → { status, to } for the office line it belongs to.
export function textBackOf(row) {
  if (!row) return null;
  const to = row.recipient || null;
  if (row.status === 'sent') return { status: TEXT_BACK.sent, to };
  if (row.status === 'sending' || row.status === 'pending') return { status: TEXT_BACK.sending, to };
  if (row.status === 'refused') return { status: row.failure_reason === OPTED_OUT_REASON ? TEXT_BACK.optedOut : TEXT_BACK.sample, to };
  if (row.status === 'skipped') return { status: TEXT_BACK.notSetUp, to };
  return { status: TEXT_BACK.failed, to };
}

// ── an incoming text ─────────────────────────────────────────────────────────
// At most this many texts from one number become thread lines an hour (the hub's own rate for a
// login, lib/hubMessages HUB_MESSAGE_RATE). STOP and START are never limited.
export const INBOUND_TEXT_RATE = Object.freeze({ limit: 60, windowMs: 3600000 });
// Pictures sent by text are not kept: the line keeps the words and says a picture came.
export function pictureNote(count) {
  const n = Number(count) || 0;
  if (n <= 0) return '';
  return n === 1
    ? '(A picture came with this text. Pictures sent by text are not kept here.)'
    : `(${n} pictures came with this text. Pictures sent by text are not kept here.)`;
}
// The words a texted line keeps: the text, then the picture note; `max` is the thread's bound.
export function inboundTextBody(body, numMedia, max) {
  const words = String(body ?? '').replace(/\r\n?/g, '\n').trim();
  const note = pictureNote(numMedia);
  const all = [words, note].filter(Boolean).join(words && note ? '\n\n' : '');
  return max && all.length > max ? `${all.slice(0, max - 1)}…` : all;
}
