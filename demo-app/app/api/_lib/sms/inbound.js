// A TEXT TO OUR NUMBER — what the inbound route (api/sms/[...path].js) does with one, once Twilio's
// signature has been checked (Daniel, 2026-10-28: "Yes, add the Reply STOP functionality." and,
// for replies, "Customer thread, texted back").
//
//   · STOP and its siblings (src/lib/texting.js SMS_KEYWORDS, or Twilio's OptOutType): the number
//     goes on the opted-out list (sms_opt_outs), and the one send step never texts it again.
//     START / UNSTOP takes it off. HELP is Twilio's to answer. None of them is a thread line.
//     Twilio's Messaging Service answers all three with its own reply; this route answers nothing.
//   · Anything else is a message from a customer. Its building is found from the NEWEST text the
//     app sent to that number (the sent log, customer_messages: a reminder, an On my way, an
//     office reply), else from the contacts (and customers) with that number. Exactly one building
//     → a customer line in its thread, marked as a text from that number, under the contact's name
//     when one is known, waiting on the office with its bell (api/_lib/clientHub/messages.js
//     postTextMessage). No building, several, or an archived one → the office is emailed the
//     number and the words, so nothing is lost and nothing lands in the wrong customer's thread.
//   · Pictures sent by text are not kept: the line keeps the words and says a picture came.
//   · The same text delivered twice (Twilio retries) is one line: its id is minted from the
//     MessageSid. A flood from one number stops making lines at INBOUND_TEXT_RATE an hour; STOP and
//     START are never limited.
//
// Throws on a failure the caller should answer as one (the opt-out write, the book's read); the
// route then emails the office what it could not file, and answers Twilio with an error so it
// retries.
import crypto from 'node:crypto';
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { readProtectedSlices } from '../orgState.js';
import { hit } from '../rateLimit.js';
import { sendTransactional } from '../email.js';
import { recordOptOut, clearOptOut } from './optOuts.js';
import { postTextMessage } from '../clientHub/messages.js';
import { toE164 } from '../../../src/lib/alertDelivery.js';
import { isArchivedCustomer } from '../../../src/lib/customerStatus.js';
import { HUB_MESSAGE_BODY_MAX } from '../../../src/lib/hubMessages.js';
import { IDENTITY } from '../../../src/brand/identity.generated.js';
import {
  SMS_KEYWORD, SMS_KEYWORDS, OPT_OUT_SOURCE, INBOUND_TEXT_RATE, smsKeyword, inboundTextBody, displayPhone,
} from '../../../src/lib/texting.js';

const ORG = CLEANSPACE_ORG_ID;
// How many of the newest texts the app sent to a number are read to find its building.
const SENT_LOOKBACK = 10;

// The word a STOP reply sent, as the opted-out list keeps it: the reply itself when it is one of
// the keywords, else the kind Twilio named (OptOutType).
function stopWord(body, optOutType) {
  const word = String(body ?? '').trim().replace(/[.!]+$/, '').trim().toUpperCase();
  if (SMS_KEYWORDS.stop.includes(word)) return word;
  return String(optOutType || 'STOP').trim().toUpperCase().slice(0, 20) || 'STOP';
}

// The thread line's id: a UUID minted from Twilio's MessageSid, so a redelivered text is the same
// line (the insert's 23505 answers the line already there).
export function textLineId(messageSid) {
  const sid = typeof messageSid === 'string' ? messageSid.trim() : '';
  if (!sid) return crypto.randomUUID();
  const h = crypto.createHash('sha256').update(`sms-in:${sid}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const contactName = (c) => [c?.firstName, c?.lastName].map((x) => String(x || '').trim()).filter(Boolean).join(' ') || null;
const sameNumber = (raw, e164) => !!raw && toE164(String(raw)) === e164;

// The buildings a number belongs to, newest-sent first. → { building, contactId } | { candidates }.
async function matchBuilding(from, book) {
  const byId = new Map(book.clients.map((c) => [c.id, c]));
  const eligible = (id) => {
    const c = byId.get(id);
    return c && !isArchivedCustomer(c) ? c : null;
  };
  // 1. The newest texts the app sent to this number: the first one sent to a customer still in
  //    the book decides. One sent to an archived customer decides too — it is not filed there.
  const { data, error } = await getSupabase().from('customer_messages')
    .select('id, client_id, contact_id, sent_at')
    .eq('organization_id', ORG).eq('channel', 'sms').eq('status', 'sent').eq('recipient', from)
    .order('sent_at', { ascending: false }).limit(SENT_LOOKBACK);
  if (error) throw new Error(`sent-log read failed: ${error.message}`);
  const newest = (data || []).find((r) => r.client_id && byId.has(r.client_id));
  if (newest) {
    const building = eligible(newest.client_id);
    return building ? { building, contactId: newest.contact_id || null } : { candidates: [byId.get(newest.client_id)] };
  }
  // 2. The contacts (and customers) with this number.
  const contacts = book.contacts.filter((c) => c.companyId && sameNumber(c.phone, from));
  const ids = new Set([
    ...contacts.map((c) => c.companyId),
    ...book.clients.filter((c) => sameNumber(c.phone, from)).map((c) => c.id),
  ].filter((id) => byId.has(id)));
  const buildings = [...ids].map(eligible).filter(Boolean);
  if (buildings.length === 1 && ids.size === 1) return { building: buildings[0], contactId: null };
  return { candidates: [...ids].map((id) => byId.get(id)) };
}

// The name a texted line is filed under: the contact the matched text went to, else the one
// contact in that building with this number.
function nameFor({ building, contactId, from, contacts }) {
  if (contactId) {
    const c = contacts.find((x) => x.id === contactId);
    if (c && sameNumber(c.phone, from)) return contactName(c);
  }
  const here = contacts.filter((c) => c.companyId === building.id && sameNumber(c.phone, from));
  return here.length === 1 ? contactName(here[0]) : null;
}

// The office's email for a text that could not be filed in one customer's thread.
export async function emailOffice({ from, body, candidates = [], why, company = null }) {
  const to = String(company?.email || IDENTITY.company.email || '').trim();
  if (!to) return { ok: false, error: 'no office address' };
  const number = displayPhone(from);
  const where = candidates.length > 1
    ? `It came from a number on more than one customer (${candidates.map((c) => c.name || c.id).join(', ')}), so it was not put in any of their threads.`
    : candidates.length === 1
      ? `The newest text to this number went to ${candidates[0].name || 'a customer'}, which is archived, so it was not put in its thread.`
      : 'No customer or contact has this number, so it was not put in any customer\'s thread.';
  const lines = [
    `A text came in from ${number}.`,
    '',
    body || '(no words)',
    '',
    where,
    why ? `(${why})` : null,
    'To have the next text from this number land in a customer\'s thread, put the number on that customer\'s contact.',
  ].filter((x) => x !== null);
  return sendTransactional({ to, subject: `Text from ${number}`, body: lines.join('\n') });
}

// One incoming text. `params` is Twilio's form, already verified. → what was done, for the log.
export async function handleInboundText(params = {}, { now = Date.now() } = {}) {
  const from = toE164(String(params.From || ''));
  if (!from) return { kind: 'ignored', reason: 'no-number' };
  const at = new Date(now).toISOString();

  const keyword = smsKeyword(params.Body, params.OptOutType);
  if (keyword === SMS_KEYWORD.stop) {
    await recordOptOut({ phone: from, source: OPT_OUT_SOURCE.reply, keyword: stopWord(params.Body, params.OptOutType), at });
    return { kind: 'stop' };
  }
  if (keyword === SMS_KEYWORD.start) {
    await clearOptOut(from);
    return { kind: 'start' };
  }
  if (keyword === SMS_KEYWORD.help) return { kind: 'help' };

  if (!hit(`sms-in:${from}`, INBOUND_TEXT_RATE).ok) return { kind: 'ignored', reason: 'rate-limited' };
  const body = inboundTextBody(params.Body, params.NumMedia, HUB_MESSAGE_BODY_MAX);
  if (!body) return { kind: 'ignored', reason: 'empty' };

  const slices = await readProtectedSlices('clients:state->clients,contacts:state->contacts,company:state->company');
  const book = {
    clients: Array.isArray(slices?.clients) ? slices.clients.filter((c) => c && c.id) : [],
    contacts: Array.isArray(slices?.contacts) ? slices.contacts.filter((c) => c && c.id) : [],
  };
  const company = slices?.company && typeof slices.company === 'object' ? slices.company : null;
  const match = await matchBuilding(from, book);
  if (!match.building) {
    const sent = await emailOffice({ from, body, candidates: match.candidates || [], company });
    return { kind: 'emailed', ok: !!sent?.ok, candidates: (match.candidates || []).length };
  }
  const name = nameFor({ building: match.building, contactId: match.contactId, from, contacts: book.contacts });
  const out = await postTextMessage({ id: textLineId(params.MessageSid), building: match.building, phone: from, name, body, now });
  return { kind: out.replay ? 'replay' : 'line', clientId: match.building.id, at };
}
