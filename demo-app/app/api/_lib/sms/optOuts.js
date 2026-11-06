// THE NUMBERS THAT SAID STOP — the server's reads and writes of `sms_opt_outs` (migration
// 20261028120000_customer_texting.sql; Daniel, 2026-10-28: "Yes, add the Reply STOP
// functionality."). Service role only; every query is pinned to the org (CLEANSPACE_ORG_ID).
//
// One row per number, keyed by the number in E.164 (src/lib/alertDelivery.js toE164, the one
// normalizer), as the marketing suppression list is keyed by email: one number suppresses every
// contact and hub login that shares it.
//   · written by the inbound text route (api/_lib/sms/inbound.js) on a STOP reply, and by the
//     one send step (api/_lib/customerMessages/send.js) when Twilio refuses a text with 21610;
//   · read by the send step before every customer text (a number here is never texted), and by
//     the office's screens (GET /api/client-messages/text-status, the thread's textBack);
//   · deleted by a START / UNSTOP reply.
// Never reaped: a consent record holds until the number texts START.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { toE164 } from '../../../src/lib/alertDelivery.js';
import { OPT_OUT_SOURCE } from '../../../src/lib/texting.js';

const ORG = CLEANSPACE_ORG_ID;
export const OPT_OUTS_TABLE = 'sms_opt_outs';
const COLUMNS = 'phone, opted_out_at, source, keyword';
const IN_CHUNK = 100;
const SOURCES = new Set(Object.values(OPT_OUT_SOURCE));

const sb = () => getSupabase();
const fail = (what, error) => { throw Object.assign(new Error(`${OPT_OUTS_TABLE} ${what} failed: ${error.message}`), { code: error.code }); };

// One number's opt-out ({ phone, opted_out_at, source, keyword }), or null when it may be texted.
// THROWS when the list cannot be read: the send step then texts nothing (fail closed).
export async function readOptOut(phone) {
  const e164 = toE164(typeof phone === 'string' ? phone : '');
  if (!e164) return null;
  const { data, error } = await sb().from(OPT_OUTS_TABLE).select(COLUMNS)
    .eq('organization_id', ORG).eq('phone', e164).limit(1);
  if (error) fail('read', error);
  return (data || [])[0] || null;
}

// The opt-outs among `phones` (any shapes), as a Map E.164 -> row. Throws on a read failure.
export async function readOptOuts(phones = []) {
  const out = new Map();
  const unique = [...new Set(phones.map((p) => toE164(typeof p === 'string' ? p : '')).filter(Boolean))];
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const { data, error } = await sb().from(OPT_OUTS_TABLE).select(COLUMNS)
      .eq('organization_id', ORG).in('phone', unique.slice(i, i + IN_CHUNK));
    if (error) fail('read', error);
    for (const r of data || []) out.set(r.phone, r);
  }
  return out;
}

// Record a number as opted out (a second STOP refreshes the date). `source` is one of
// OPT_OUT_SOURCE; `keyword` the word it sent, for a reply. → true when written, false for
// something that is not a number or not a known source (nothing is written). Throws on a write
// failure.
export async function recordOptOut({ phone, source, keyword = null, at = new Date().toISOString() } = {}) {
  const e164 = toE164(typeof phone === 'string' ? phone : '');
  if (!e164 || !SOURCES.has(source)) return false;
  const word = keyword ? String(keyword).trim().toUpperCase().slice(0, 20) || null : null;
  const { error } = await sb().from(OPT_OUTS_TABLE).upsert({
    organization_id: ORG, phone: e164, opted_out_at: at, source, keyword: word, updated_at: at,
  }, { onConflict: 'organization_id,phone' });
  if (error) fail('write', error);
  return true;
}

// A START / UNSTOP reply: the number may be texted again. Throws on a write failure.
export async function clearOptOut(phone) {
  const e164 = toE164(typeof phone === 'string' ? phone : '');
  if (!e164) return false;
  const { error } = await sb().from(OPT_OUTS_TABLE).delete().eq('organization_id', ORG).eq('phone', e164);
  if (error) fail('delete', error);
  return true;
}
