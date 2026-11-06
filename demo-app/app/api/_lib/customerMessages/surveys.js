// THE SATISFACTION SURVEY'S LINKS AND ANSWERS (Matt's approved messages, 2026-10-19) —
// `customer_surveys` (migration 20261019120000_customer_messages.sql). Service role only.
//
// 🔴 THE TOKEN IS THE CAPABILITY (BUILD_INTEGRITY §2): 32 bytes from the CSPRNG
// (crypto.randomBytes), base64url in the link the customer's email carries; the table keeps only
// its SHA-256, so a read of the table cannot answer a survey. A token of the wrong shape is
// refused before any read. A link works for SURVEY_LINK_DAYS; its answer may be changed a few
// times (SURVEY_MAX_ANSWERS) while it works, each change a compare-and-swap on `answer_count`.
import { randomBytes, createHash } from 'node:crypto';
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { appPublicUrl } from '../appUrl.js';
import { SURVEY_LINK_DAYS } from '../../../src/lib/customerMessages.js';

const ORG = CLEANSPACE_ORG_ID;
const TABLE = 'customer_surveys';
export const SURVEY_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const SURVEY_MAX_ANSWERS = 5;
export const SURVEY_COMMENT_MAX = 1000;
// Kept: an answered survey two years (the customer's page shows it); an unanswered one 30 days
// past its expiry.
export const SURVEY_ANSWERED_KEEP_DAYS = 730;
export const SURVEY_UNANSWERED_KEEP_DAYS = 30;
const DAY = 864e5;

export const hashSurveyToken = (token) => createHash('sha256').update(String(token)).digest('hex');
export const surveyLink = (token) => `${appPublicUrl()}/survey/${token}`;

// A new survey for the message about to be sent: the row first (so a link that reaches the
// customer always has one), then the link. → { token, link }. Throws when the row can't be written
// (the run then records the message failed and sends nothing).
export async function mintSurvey({ messageId, clientId, contactId = null, now = new Date() }) {
  const token = randomBytes(32).toString('base64url');
  const { error } = await getSupabase().from(TABLE).insert({
    organization_id: ORG,
    token_hash: hashSurveyToken(token),
    message_id: messageId,
    client_id: clientId,
    contact_id: contactId,
    sent_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SURVEY_LINK_DAYS * DAY).toISOString(),
  });
  if (error) throw new Error(`${TABLE} insert failed: ${error.message}`);
  return { token, link: surveyLink(token) };
}

// The survey a token opens, or null (unknown, malformed). Throws on a read failure.
export async function surveyByToken(token) {
  if (!SURVEY_TOKEN_RE.test(String(token || ''))) return null;
  const { data, error } = await getSupabase().from(TABLE)
    .select('id, client_id, sent_at, expires_at, rating, comment, answered_at, answer_count')
    .eq('organization_id', ORG).eq('token_hash', hashSurveyToken(token)).maybeSingle();
  if (error) throw new Error(`${TABLE} read failed: ${error.message}`);
  return data || null;
}

export const surveyState = (row, now = Date.now()) => (!row ? null
  : Date.parse(row.expires_at) <= now ? 'expired'
    : row.answered_at ? 'answered' : 'open');

// PURE. A rating and comment as the page sends them → { rating, comment } or { error, code }.
export function surveyAnswer(body) {
  const rating = Number(body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { error: 'Choose a rating from 1 to 5.', code: 'survey-rating' };
  const raw = body?.comment == null ? '' : String(body.comment);
  const comment = raw.replace(/\s+$/g, '').replace(/^\s+/g, '');
  if (comment.length > SURVEY_COMMENT_MAX) return { error: `Keep the comment under ${SURVEY_COMMENT_MAX} characters.`, code: 'survey-comment' };
  return { rating, comment: comment || null };
}

// Record an answer: a compare-and-swap on the row's answer_count, only while the link works and
// fewer than SURVEY_MAX_ANSWERS answers were given. → 'saved' | 'expired' | 'limit' | 'conflict'.
export async function answerSurvey(row, { rating, comment }, now = new Date()) {
  if (Date.parse(row.expires_at) <= now.getTime()) return 'expired';
  if ((row.answer_count || 0) >= SURVEY_MAX_ANSWERS) return 'limit';
  const { data, error } = await getSupabase().from(TABLE)
    .update({ rating, comment, answered_at: now.toISOString(), answer_count: (row.answer_count || 0) + 1 })
    .eq('organization_id', ORG).eq('id', row.id).eq('answer_count', row.answer_count || 0)
    .gt('expires_at', now.toISOString())
    .select('id');
  if (error) throw new Error(`${TABLE} answer failed: ${error.message}`);
  return Array.isArray(data) && data.length === 1 ? 'saved' : 'conflict';
}

// The customer's surveys, newest first (the office's customer page): when each was sent and, if
// answered, the rating, the comment and when. Never the token or its hash.
export async function surveysForClient(clientId, { limit = 20 } = {}) {
  const { data, error } = await getSupabase().from(TABLE)
    .select('id, sent_at, expires_at, rating, comment, answered_at')
    .eq('organization_id', ORG).eq('client_id', clientId)
    .order('sent_at', { ascending: false }).order('id', { ascending: true })
    .range(0, Math.max(0, Math.min(100, limit) - 1));
  if (error) throw new Error(`${TABLE} read failed: ${error.message}`);
  return (data || []).map((r) => ({ id: r.id, sentAt: r.sent_at, expiresAt: r.expires_at, rating: r.rating ?? null, comment: r.comment ?? null, answeredAt: r.answered_at ?? null }));
}

// THE RETENTION (THE LAW II.8). Best-effort.
export async function reapSurveys(now = new Date()) {
  try {
    const sb = getSupabase();
    const unanswered = new Date(now.getTime() - SURVEY_UNANSWERED_KEEP_DAYS * DAY).toISOString();
    const answered = new Date(now.getTime() - SURVEY_ANSWERED_KEEP_DAYS * DAY).toISOString();
    const a = await sb.from(TABLE).delete().eq('organization_id', ORG).is('answered_at', null).lt('expires_at', unanswered);
    const b = await sb.from(TABLE).delete().eq('organization_id', ORG).lt('answered_at', answered);
    if (a.error || b.error) throw new Error((a.error || b.error).message);
    return true;
  } catch (e) {
    console.error('[customer-messages] survey retention delete failed:', e?.message || e);
    return false;
  }
}
