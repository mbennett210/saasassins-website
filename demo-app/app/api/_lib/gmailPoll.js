// Shared Gmail polling. For each connected inbox due for a refresh, pull new
// INBOX messages since its history cursor and buffer them in `inbound_emails`.
// Used by BOTH the client-facing inbound endpoint (api/inbox/inbound.js) and
// the server-side cron ingest (api/inbox/ingest.js), so the polling logic
// lives in one place.
//
// ⚠️ The poll used to keep ONLY replies to mail the app itself had sent
// (matched against a 30-day rolling sent-id window). These are the office's
// human mailboxes — a crew member emailing a fresh "End of shift report" was
// discarded HERE, before it was even stored, which is why zero inbound rows
// landed after 2026-06-21 while 3 reports/day were being sent. Everything in
// INBOX now buffers (Gmail's own spam filtering has already run — SPAM/
// PROMOTIONS never carry the INBOX label); the ingest layer owns routing.

import {
  listAccountsDueForPoll,
  getFreshAccessToken,
  bufferInbound,
  updateAccountPollState,
} from './accounts.js';
import {
  gmailHistoryList,
  gmailListRecent,
  gmailGetMessage,
  gmailGetProfile,
  parseInboundMessage,
} from './google.js';

// Resolve candidate message ids for one inbox since its history cursor.
async function collectNewMessageIds(account, accessToken) {
  if (account.history_id) {
    const history = await gmailHistoryList(accessToken, account.history_id);
    if (!history.expired) {
      const ids = (history.messages || [])
        .filter((m) => (m.labelIds || []).includes('INBOX'))
        .map((m) => m.id);
      return { ids, historyId: history.historyId };
    }
    // Cursor too old — re-baseline from recent inbox mail.
    const recent = await gmailListRecent(accessToken, 'in:inbox newer_than:2d');
    const profile = await gmailGetProfile(accessToken);
    return { ids: recent.map((m) => m.id), historyId: profile.historyId };
  }
  // No cursor yet — set a baseline and ingest nothing this pass.
  const profile = await gmailGetProfile(accessToken);
  return { ids: [], historyId: profile.historyId };
}

async function pollInbox(account) {
  const accessToken = await getFreshAccessToken(account);
  const { ids, historyId } = await collectNewMessageIds(account, accessToken);

  if (ids.length) {
    const rows = [];
    for (const messageId of [...new Set(ids)]) {
      const full = await gmailGetMessage(accessToken, messageId, { format: 'full' });
      const parsed = parseInboundMessage(full);
      // INBOX-only is the spam gate (Gmail already filtered); fresh mail and
      // replies BOTH buffer — the header comment records why the old
      // replies-only filter was the June-21 blackout.
      if (!parsed.labelIds.includes('INBOX')) continue;
      rows.push({
        gmail_message_id: messageId,
        rfc_message_id: parsed.messageId,
        to_inbox_email: account.email,
        from_email: parsed.fromEmail,
        subject: parsed.subject,
        body: parsed.body,
        in_reply_to: parsed.inReplyTo,
        references_header: parsed.references,
        received_at: new Date().toISOString(),
      });
    }
    await bufferInbound(rows);
  }
  await updateAccountPollState(account.id, { historyId, lastError: null });
}

// Refresh every connected inbox that hasn't been polled within the throttle
// window (60s). Failures are isolated per-inbox so one bad token can't stall
// the rest.
export async function pollDueInboxes() {
  const due = await listAccountsDueForPoll(60 * 1000);
  await Promise.allSettled(due.map(async (account) => {
    try {
      await pollInbox(account);
    } catch (err) {
      await updateAccountPollState(account.id, { lastError: err.message });
    }
  }));
}
