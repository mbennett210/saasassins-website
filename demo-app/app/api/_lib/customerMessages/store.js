// THE CUSTOMER-MESSAGE SENT LOG AND THE SURVEYS — the server's reads and writes of
// `customer_messages` and `customer_surveys` (migration 20261019120000_customer_messages.sql).
// Service role only; every query is pinned to the org (CLEANSPACE_ORG_ID).
//
// "SENT ONCE" (the reminders engine, api/reminders/run.js). A message's id is its deterministic
// key (src/lib/reminderScheduler.js messageKey), the table's primary key with the org. A run
// CLAIMS a message before it sends it, and only the run whose claim landed sends:
//   · a new message:      INSERT … ON CONFLICT DO NOTHING (status 'sending'), which answers only
//                         the rows it inserted — two runs racing on one key, one inserts;
//   · a failed one:       UPDATE … WHERE status = 'failed' AND attempts = <what we read>
//                         (a compare-and-swap: a second run's update matches nothing);
//   · a queued one:       UPDATE … WHERE status = 'pending';
//   · an abandoned claim: UPDATE … WHERE status = 'sending' AND updated_at = <what we read>, only
//                         once STALE_SENDING_MS has passed (a run that died mid-send).
// This is the lease CS-119 left open ("send-before-record with no lease"): the claim is written
// BEFORE the send, so a crash after the send leaves a 'sending' row, never an unsent-looking gap.
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';

const ORG = CLEANSPACE_ORG_ID;
export const MESSAGES_TABLE = 'customer_messages';
export const SURVEYS_TABLE = 'customer_surveys';

// The statuses the migration's CHECK allows — one list, read by the migration's suite.
export const MESSAGE_STATUS = Object.freeze({
  pending: 'pending',
  sending: 'sending',
  sent: 'sent',
  failed: 'failed',
  refused: 'refused',
  skipped: 'skipped',
});
export const MESSAGE_STATUSES = Object.freeze(Object.values(MESSAGE_STATUS));
// A claim older than this belongs to a run that died: it may be claimed again.
export const STALE_SENDING_MS = 15 * 60 * 1000;
const IN_CHUNK = 100;

const sb = () => getSupabase();
const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const fail = (what, error) => { throw Object.assign(new Error(`${MESSAGES_TABLE} ${what} failed: ${error.message}`), { code: error.code }); };

// The stored rows for `ids`, as a Map id -> row. Throws on a read failure: the caller sends
// NOTHING it cannot prove unsent (fail closed — never "no record, so send").
export async function readMessages(ids = []) {
  const out = new Map();
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
  for (const part of chunks(unique, IN_CHUNK)) {
    const { data, error } = await sb().from(MESSAGES_TABLE)
      .select('id, template_key, status, attempts, updated_at, sent_at, payload, client_id, recipient, failure_reason')
      .eq('organization_id', ORG).in('id', part);
    if (error) fail('read', error);
    for (const r of data || []) out.set(r.id, r);
  }
  return out;
}

// One row as the table stores it. `row`: { id, templateKey, channel, clientId?, contactId?,
// jobId?, subjectId?, recipient?, status, attempts?, payload?, failureReason?, keepUntil }.
export function messageRow(row, nowIso = new Date().toISOString()) {
  return {
    organization_id: ORG,
    id: row.id,
    template_key: row.templateKey,
    channel: row.channel,
    client_id: row.clientId ?? null,
    contact_id: row.contactId ?? null,
    job_id: row.jobId ?? null,
    subject_id: row.subjectId ?? null,
    recipient: row.recipient ?? null,
    status: row.status,
    attempts: row.attempts ?? 1,
    payload: row.payload ?? null,
    failure_reason: row.failureReason ?? null,
    provider_message_id: null,
    created_at: nowIso,
    updated_at: nowIso,
    sent_at: row.status === MESSAGE_STATUS.sent ? nowIso : null,
    keep_until: row.keepUntil,
  };
}

// Insert rows that do not exist yet; a key already present is left exactly as it is. Answers
// the ids it INSERTED (for a 'sending' row: the claims this run won).
export async function insertNew(rows = [], nowIso = new Date().toISOString()) {
  const won = new Set();
  for (const part of chunks(rows, IN_CHUNK)) {
    const { data, error } = await sb().from(MESSAGES_TABLE)
      .upsert(part.map((r) => messageRow(r, nowIso)), { onConflict: 'organization_id,id', ignoreDuplicates: true })
      .select('id');
    if (error) fail('insert', error);
    for (const r of data || []) won.add(r.id);
  }
  return won;
}

// Claim an existing row for a send: the compare-and-swap on what the run read. `prev` is the
// stored row (readMessages). → true when this run holds it now.
export async function claimExisting(prev, nowIso = new Date().toISOString()) {
  if (!prev?.id) return false;
  const patch = { status: MESSAGE_STATUS.sending, updated_at: nowIso };
  let q = sb().from(MESSAGES_TABLE).update(prev.status === MESSAGE_STATUS.pending ? patch : { ...patch, attempts: (prev.attempts || 0) + 1 })
    .eq('organization_id', ORG).eq('id', prev.id).eq('status', prev.status);
  if (prev.status === MESSAGE_STATUS.failed) q = q.eq('attempts', prev.attempts);
  else if (prev.status === MESSAGE_STATUS.sending) q = q.eq('updated_at', prev.updated_at);
  else if (prev.status !== MESSAGE_STATUS.pending) return false;
  const { data, error } = await q.select('id');
  if (error) fail('claim', error);
  return Array.isArray(data) && data.length === 1;
}

// The outcome of a claimed send. `outcome`: { status: 'sent' | 'failed' | 'refused' | 'skipped',
// providerMessageId?, failureReason?, recipient? }. Only the claim's own row ('sending') moves.
export async function finishMessage(id, outcome, nowIso = new Date().toISOString()) {
  const sent = outcome.status === MESSAGE_STATUS.sent;
  const { error } = await sb().from(MESSAGES_TABLE).update({
    status: outcome.status,
    updated_at: nowIso,
    sent_at: sent ? nowIso : null,
    provider_message_id: sent ? (outcome.providerMessageId ?? null) : null,
    failure_reason: sent ? null : String(outcome.failureReason || '').slice(0, 500) || null,
    ...(outcome.recipient !== undefined ? { recipient: outcome.recipient } : {}),
  }).eq('organization_id', ORG).eq('id', id).eq('status', MESSAGE_STATUS.sending);
  if (error) fail('finish', error);
}

// Settle rows that will never be sent, without a claim (a collapsed reschedule, not this
// customer's first clean): a pending or failed row moves to 'skipped'; an absent one is inserted
// as 'skipped'. A row already sent, sending or refused is left alone.
export async function settleSkipped(rows = [], nowIso = new Date().toISOString()) {
  if (!rows.length) return;
  await insertNew(rows.map((r) => ({ ...r, status: MESSAGE_STATUS.skipped, attempts: 0 })), nowIso);
  for (const part of chunks(rows.map((r) => r.id), IN_CHUNK)) {
    const { error } = await sb().from(MESSAGES_TABLE)
      .update({ status: MESSAGE_STATUS.skipped, updated_at: nowIso })
      .eq('organization_id', ORG).in('id', part).in('status', [MESSAGE_STATUS.pending, MESSAGE_STATUS.failed]);
    if (error) fail('settle', error);
  }
}

// Queue a message a route saw happen (a contract's change): status 'pending', its words' inputs
// in `payload`. A key already queued or sent is left as it is. Never throws: the route's own
// write must not fail because the queue did.
export async function queuePending(row) {
  try {
    await insertNew([{ ...row, status: MESSAGE_STATUS.pending, attempts: 0 }]);
    return true;
  } catch (e) {
    console.error(`[customer-messages] could not queue ${row?.templateKey || 'a message'}:`, e?.message || e);
    return false;
  }
}

// The queued messages left within `sinceIso` for `templateKeys`, oldest first.
export async function readPending(templateKeys = [], sinceIso) {
  if (!templateKeys.length) return [];
  const { data, error } = await sb().from(MESSAGES_TABLE)
    .select('id, template_key, status, attempts, updated_at, payload, client_id, created_at')
    .eq('organization_id', ORG).eq('status', MESSAGE_STATUS.pending)
    .in('template_key', templateKeys).gte('created_at', sinceIso)
    .order('created_at', { ascending: true }).order('id', { ascending: true })
    .range(0, 499);
  if (error) fail('pending read', error);
  return data || [];
}

// How many messages on `channel` went since `sinceIso` (the mailbox's daily ceiling).
export async function countSentSince(channel, sinceIso) {
  const { count, error } = await sb().from(MESSAGES_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', ORG).eq('channel', channel).eq('status', MESSAGE_STATUS.sent).gte('sent_at', sinceIso);
  if (error) fail('count', error);
  return count || 0;
}

// THE RETENTION (THE LAW II.8): every row past its keep_until. Best-effort.
export async function reapMessages(nowIso = new Date().toISOString()) {
  try {
    const { error } = await sb().from(MESSAGES_TABLE).delete().eq('organization_id', ORG).lt('keep_until', nowIso);
    if (error) throw new Error(error.message);
    return true;
  } catch (e) {
    console.error('[customer-messages] retention delete failed:', e?.message || e);
    return false;
  }
}
