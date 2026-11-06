// What the browser files from the inbound mail buffer, and from where it polls
// (components/InboundListener.jsx). Pure and Node-safe: the reducer and the listener share it.
//
// The server's inbound cursor is `org_state.inboundIngestSeq`, the highest `inbound_emails.seq` the
// ingest cron (api/inbox/ingest.js) has threaded into the shared record. The cron is the one writer
// of the buffer (api/_lib/gmailPoll.js runs only inside it) and threads what it buffered in the same
// run, so a buffered email at or below that number is already in the record, or was deleted from it
// since.
//
// 🔴 CS-968 (2026-11-03): the listener polled from its OWN cursor (a localStorage number, 0 on a new
// browser), and RECEIVE_EMAIL / RECEIVE_MARKETING_REPLY skipped a reply only while a message (or a
// reply row) with its Message-ID was still stored. So a reply whose thread was deleted came back,
// with a bell row, the next time a browser that hadn't polled since opened the app. The record keeps
// no list of what was filed (nothing ever-growing in org_state); the cursor is enough: the browser
// never files an email at or below it, and the reducer checks again against the state the action
// lands on (a tab that filed it on a stale copy drops it when its save meets the newer record).

export function ingestedThrough(state) {
  const n = Number(state?.inboundIngestSeq);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// True when the buffered email `seq` was already threaded by the server. An email with no seq
// (the Settings → Integrations simulation, the Marketing "Simulate a reply") is never skipped.
export function alreadyIngested(state, seq) {
  const n = Number(seq);
  return Number.isFinite(n) && n > 0 && n <= ingestedThrough(state);
}

// Where the listener's next poll starts: past its own cursor and past the server's.
export function pollFrom(localCursor, state) {
  return Math.max(Number(localCursor) || 0, ingestedThrough(state));
}

// One poll's answer → the actions the listener dispatches, in buffer order. `ACTIONS` is the
// store's action map, passed in so this module never imports the reducer (which imports it).
//
// Each buffered email is routed so it's handled exactly once:
//   • landed on a per-user personal inbox (Settings → Connected Inboxes)
//     → RECEIVE_EMAIL: threads into the 1:1 Messaging conversation
//   • anything else (the shared marketing rotation inboxes, or unknown)
//     → RECEIVE_MARKETING_REPLY: correlates to an enrollment, halts the drip, routes the contact.
// Personal and marketing inboxes are always distinct addresses, so the `toInboxEmail` the backend
// records on each reply is an unambiguous router.
export function inboundActions(res, state, ACTIONS) {
  if (!res || !Array.isArray(res.emails)) return [];
  // The personal mailboxes' addresses come from the SERVER (the inbox_accounts table, piggybacked
  // on the poll response): the blob's connectedInboxes was EMPTY in prod, so this fork matched
  // nothing and diverted every inbound message to marketing (the 2026-06-21 Messaging blackout).
  // Blob fallback only for an older-deploy server response that omits the field.
  const personalInboxes = new Set(
    (Array.isArray(res.personalInboxes) && res.personalInboxes.length
      ? res.personalInboxes
      : (state?.connectedInboxes || []).map((i) => i.email))
      .map((e) => (e || '').toLowerCase())
      .filter(Boolean)
  );
  const out = [];
  for (const email of res.emails) {
    if (alreadyIngested(state, email.seq)) continue;
    const landedOn = (email.toInboxEmail || '').toLowerCase();
    if (landedOn && personalInboxes.has(landedOn)) {
      out.push({
        type: ACTIONS.RECEIVE_EMAIL,
        seq: email.seq,
        messageId: email.messageId || undefined,
        fromEmail: email.fromEmail,
        toInboxEmail: email.toInboxEmail,
        subject: email.subject,
        body: email.body,
        inReplyTo: email.inReplyTo,
        references: email.references,
        receivedAt: email.receivedAt || undefined,
      });
    } else {
      out.push({
        type: ACTIONS.RECEIVE_MARKETING_REPLY,
        seq: email.seq,
        id: email.messageId || undefined,
        enrollmentId: email.enrollmentId || null,
        fromEmail: email.fromEmail,
        subject: email.subject,
        body: email.body,
        receivedAt: email.receivedAt || undefined,
      });
    }
  }
  return out;
}
