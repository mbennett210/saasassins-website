// GET /api/email/health — can the app send its own email, and as whom.
// Backs src/lib/email.js getEmailHealth(), consumed by Settings → Integrations.
//
// ── REWRITTEN FOR GOOGLE (CS-012, CS-039, CS-280, 2026-09-29) ───────────────────────
// This used to ask Resend GET /domains for a sending-domain verification status, with a
// DNS fallback that probed `resend._domainkey.<domain>` and `send.<domain>`. There is no
// Resend account in this build any more (Daniel, 2026-09-29: email goes through Google),
// and there never was a verified one: the records it probed do not exist in public DNS for
// billing.cleanspaceonline.com (G7 `dig`, V 2026-09-25) — the CS-280 claim.
//
// Under Google there is no domain for the app to verify. DKIM, SPF and DMARC belong to the
// Workspace domain and are configured once in Google Admin, outside this product; a mailbox
// either connected with a live refresh token or it did not. So health is now exactly:
// is a sending mailbox marked, which one, is its token still good, and where the choice
// lives (an env pin, or the owner's pick in Settings).
//
// The returned shape keeps `status` in the vocabulary the Integrations badge already maps
// ('verified' | 'pending' | 'failed' | 'not_started'), so nothing downstream has to branch
// on a new word: a live mailbox reads 'verified', a mailbox whose token expired reads
// 'failed', and no mailbox at all reads 'not_started'.

import { requireAuthority } from '../_lib/authz.js';
import { systemSenderStatus } from '../_lib/systemSender.js';
import { defaultFrom, verifiedDomain } from '../_lib/email.js';

const REASON_TEXT = {
  'no-sender': 'No sending mailbox chosen yet. Connect a Google mailbox and mark it as the sender in Settings → Integrations.',
  'not-provisioned': 'Email sending has not been provisioned on this deployment yet.',
  'pinned-missing': 'SYSTEM_SENDER_EMAIL names a mailbox that is not connected. Connect that Google account, or clear the pin.',
  'sender-inactive': 'The sending mailbox needs to be reconnected — Google stopped accepting its access.',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  // A member of the team, not just any session (authz.js ROSTER STATUS).
  if (!(await requireAuthority(req, res))) return;

  const sender = await systemSenderStatus();
  const status = sender.configured ? 'verified' : (sender.reason === 'sender-inactive' ? 'failed' : 'not_started');

  res.status(200).json({
    provider: 'google',
    status,
    configured: sender.configured,
    // The sending identity. `verifiedDomain` stays in the payload under its old name (the
    // Settings card reads it) but now means "the domain the app's mail leaves from", which
    // under Google is the mailbox's own — there is nothing separate to verify.
    verifiedDomain: sender.configured ? await verifiedDomain() : null,
    defaultFrom: sender.configured ? await defaultFrom() : null,
    senderEmail: sender.email,
    senderInboxId: sender.inboxId,
    senderSource: sender.source,
    pinned: sender.pinned,
    // Google owns these for the Workspace domain; the app has no say and reports none
    // rather than inventing a status. Kept so the client shape is unchanged.
    dkimRecords: [],
    spfStatus: null,
    dmarcStatus: null,
    lastCheckedAt: new Date().toISOString(),
    ...(sender.reason ? { failureReason: REASON_TEXT[sender.reason] || sender.reason } : {}),
    ...(sender.lastError ? { senderLastError: sender.lastError } : {}),
  });
}
