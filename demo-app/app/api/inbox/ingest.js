// GET /api/inbox/ingest — server-side inbound pipeline, runs WITHOUT a browser
// tab. Driven by a Vercel Cron (see vercel.json). Each run:
//   1. polls every connected inbox's Gmail and buffers new replies, then
//   2. routes each buffered reply into the shared org-state document — personal
//      connected inbox → 1:1 email thread, shared marketing inbox → marketing
//      reply (drip-halt + routing + marketingReplyAssigned) — and CAS-writes it
//      back. A DB trigger fans the change out to open clients over Realtime, so
//      inbound email AND marketing replies land even when nobody has the app open.
//
// The ingest cursor (last buffered `seq` threaded) lives in the org state
// itself (`state.inboundIngestSeq`). Threading is idempotent (dedup by
// Message-ID), so overlap with the client-side InboundListener is harmless.

import { getInboundSince, listAccountEmails } from '../_lib/accounts.js';
import { pollDueInboxes } from '../_lib/gmailPoll.js';
import { readOrgState, writeOrgState } from '../_lib/orgState.js';
import { ingestInboundEmail } from '../_lib/ingestEmail.js';
import { ingestMarketingReply } from '../_lib/ingestMarketingReply.js';

const MAX_PER_RUN = 200;
const CAS_RETRIES = 5;

function toEmail(r) {
  return {
    seq: r.seq,
    fromEmail: r.from_email,
    toInboxEmail: r.to_inbox_email,
    subject: r.subject,
    body: r.body,
    messageId: r.rfc_message_id,
    inReplyTo: r.in_reply_to,
    references: r.references_header,
  };
}

// Thread all buffered replies past the stored cursor into the org state,
// retrying on a CAS conflict (an open tab saving at the same moment).
async function ingestPending() {
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const { state, version } = await readOrgState();
    const cursor = Number(state.inboundIngestSeq) || 0;
    const rows = await getInboundSince(cursor, MAX_PER_RUN);
    if (!rows.length) return { ingested: 0, cursor };

    // Route each message by the inbox it landed on: a personal connected inbox
    // → a 1:1 email thread in Messaging; anything else → a marketing reply
    // (halts the drip, routes/tags the contact, fans out marketingReplyAssigned).
    // Both paths are idempotent by message-id, so cron/tab overlap is harmless.
    //
    // ⚠️ The personal set comes from the inbox_accounts TABLE — the same rows
    // the poller polls — never from the blob's `connectedInboxes`. The blob
    // copy was EMPTY in production, so this gate matched nothing and diverted
    // 100% of inbound mail away from Messaging from 2026-06-21 (the frozen
    // "End of shift reporting" thread) until caught on 2026-07-30.
    const personalInboxes = new Set(await listAccountEmails());
    let next = state;
    let maxSeq = cursor;
    for (const r of rows) {
      // Per-row fault isolation: the cursor lives in the state being built, so
      // a throw here used to re-throw on EVERY tick forever — one malformed
      // row permanently wedged ALL ingest. Log, skip, advance.
      try {
        const em = toEmail(r);
        const landedOn = (em.toInboxEmail || '').toLowerCase();
        next = (landedOn && personalInboxes.has(landedOn))
          ? ingestInboundEmail(next, em)
          : ingestMarketingReply(next, em);
      } catch (rowErr) {
        console.error(`[inbox/ingest] row seq=${r.seq} failed, skipping:`, rowErr?.message || rowErr);
      }
      if (r.seq > maxSeq) maxSeq = r.seq;
    }
    next = { ...next, inboundIngestSeq: maxSeq };

    const ok = await writeOrgState(next, version);
    if (ok) return { ingested: rows.length, cursor: maxSeq };
    // Version moved under us — re-read and retry on the fresh state.
  }
  throw new Error('org_state write kept conflicting (too much concurrent activity)');
}

export default async function handler(req, res) {
  // Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Fail CLOSED (like
  // /api/push/dispatch): with no secret configured the endpoint refuses to run
  // rather than accepting unauthenticated calls that could force inbox ingest.
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.status(secret ? 401 : 500).json({ ok: false, error: secret ? 'Unauthorized' : 'CRON_SECRET is not configured' });
    return;
  }
  try {
    await pollDueInboxes();          // Gmail → buffer (server-side, no tab)
    const result = await ingestPending(); // buffer → conversations
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    // HARD-fail (500): the cron fires every minute regardless, so retry
    // semantics are identical — but a 200-with-ok:false made a month-long
    // ingest outage invisible to Vercel's cron monitoring. Red means red.
    res.status(500).json({ ok: false, error: err.message });
  }
}
