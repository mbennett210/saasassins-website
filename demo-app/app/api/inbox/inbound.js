// GET /api/inbox/inbound?since=<seq>
// Client-facing inbound poll (src/components/InboundListener.jsx). Returns buffered
// inbound rows past the caller's cursor, FOR THE MAILBOXES THAT CALLER MAY READ, so the
// browser can thread them in. The Gmail poll itself belongs to the cron
// (api/inbox/ingest.js, every minute) and no longer runs here.
//
// AUTH (SEC-03): requireAuthority — previously ungated, and this route RETURNS EMAIL
// CONTENT. It was a bare session check until 2026-09-23, so a member set to Disabled kept
// reading the company's inbound mail (authz.js ROSTER STATUS).
//
// ── 🔴 SCOPED PER MAILBOX (CS-016, 2026-09-29) ──────────────────────────────────────
// requireAuthority alone still returned EVERY connected mailbox's mail to EVERY login:
// `since=0` dumped the whole buffer, personal Gmail included, so crew could read managers'
// private mail. The rows a caller gets are now exactly:
//     · the mailboxes they OWN (inbox_accounts.owner_user_id — stamped at connect), plus
//     · every mailbox, if they hold `messaging.manageInboxes` (owner/admin/manager by
//       default) — the office does read the shared mailboxes in Messaging.
// A caller with neither gets an empty list and an advancing cursor, never a 403: the
// listener polls on a timer in every tab, and a 403 loop would be noise, not a signal.
//
// AND THE POLL IS GONE FROM HERE. Every call used to run pollDueInboxes(), so Gmail
// polling was driven by whichever tab called first (per-account 60 s window) instead of by
// the cron — a read endpoint with a write-shaped side effect, and one that let any login
// drive the company's Gmail API quota. `/api/inbox/ingest` runs every minute
// (app/vercel.json crons), which is the same cadence the throttle allowed anyway.
import { requireAuthority, holdsPermission } from '../_lib/authz.js';
import { getInboundSince, getInboundCeiling, listAccountEmails, listAccountsOwnedBy } from '../_lib/accounts.js';

export default async function handler(req, res) {
  const a = await requireAuthority(req, res);
  if (!a) return;
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed', emails: [] });
    return;
  }
  const since = Number(req.query.since) || 0;
  try {
    // FAILS CLOSED on the permission read: holdsPermission answers false when the matrix
    // can't be read, so an unreadable matrix narrows the scope to owned mailboxes.
    const seesAll = await holdsPermission(a, 'messaging.manageInboxes');
    // personalInboxes rides along so the client fork routes on DB truth — the blob's
    // connectedInboxes was EMPTY in prod and silently diverted all inbound mail away from
    // Messaging (2026-06-21 → 2026-07-30). Scoped the same way as the rows.
    const owned = seesAll ? null : (await listAccountsOwnedBy(a.orgUserId)).map((r) => (r.email || '').toLowerCase()).filter(Boolean);
    const personalInboxes = seesAll ? await listAccountEmails() : owned;

    const rows = await getInboundSince(since, 100, owned);
    // The cursor comes from the UNFILTERED page, so a caller who may see none of it still
    // moves past it instead of re-scanning the buffer on every tick.
    const cursor = await getInboundCeiling(since, 100);
    res.status(200).json({
      ok: true,
      personalInboxes,
      scope: seesAll ? 'all' : 'owned',
      cursor,
      emails: rows.map((r) => ({
        seq: r.seq,
        fromEmail: r.from_email,
        toInboxEmail: r.to_inbox_email,
        subject: r.subject,
        body: r.body,
        messageId: r.rfc_message_id,
        inReplyTo: r.in_reply_to,
        references: r.references_header,
      })),
    });
  } catch (err) {
    // Soft-fail — the listener simply retries on its next tick.
    res.status(200).json({ ok: false, error: err.message, cursor: since, emails: [] });
  }
}
