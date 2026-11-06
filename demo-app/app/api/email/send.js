// POST /api/email/send — the app's own transactional email, out of the Google mailbox
// marked as the SYSTEM SENDER (api/_lib/systemSender.js). The delivery backend for
// src/lib/email.js sendEmail(): staff invites (AddUserModal, Team → Resend invitation) and the
// Settings → Integrations test card land here. This is a DIFFERENT path from marketing
// sequences (per-user Gmail via /api/inbox/:id/send) — nothing here touches that engine.
//
// ── 🔴 NOT AN OPEN RELAY ANY MORE (CS-015, 2026-09-29) ───────────────────────────────
// It was requireAuthority only, so ANY login on the team — every crew member — could send
// mail from the company's mailbox, to an arbitrary `to` (an array passed the old regex
// after String()), with unbounded cc/bcc, an HTML body and custom MIME headers. The only
// brake was 30 per 10 min per user per warm instance, and recipients were not counted.
// Three things changed:
//   1. A PERMISSION, not just team membership. Exactly the two capabilities whose screens
//      reach this route: `integrations.manage` (the test card) or `settings.team.edit`
//      (inviting and re-inviting a member). Crew hold neither.
//   2. A RECIPIENT CAP — _lib/email.js MAX_RECIPIENTS, counted across to + cc + bcc, and
//      `to` must be one address, not a list.
//   3. CALLER HEADERS ARE STRIPPED to the two threading headers. Everything else a caller
//      asked for is dropped, and buildMime refuses a name that restates a header it owns
//      (CS-075).
// The From needs no allowlist now: Gmail sends as the authenticated mailbox, so the set of
// addresses this server can send as is exactly {the system sender} and a requested From can
// only ever become a Reply-To (_lib/email.js resolveFromAndReplyTo).
//
// Response mirrors the contract documented in src/lib/email.js:
//   200 → { id, status: 'sent', from, replyTo? }
//   4xx/5xx → { error } (the client adapter surfaces it as failureReason)

import { requireAnyPermission } from '../_lib/authz.js';
import { resolveFromAndReplyTo, sendTransactional, MAX_RECIPIENTS } from '../_lib/email.js';
import { allow } from '../_lib/rateLimit.js';

// The only headers a caller may set on system mail: enough to thread a reply, nothing more.
const ALLOWED_HEADERS = new Set(['in-reply-to', 'references']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  // A member of the team (a Disabled member can't send the company's mail — authz.js ROSTER
  // STATUS) who ALSO holds one of the two capabilities whose screens reach this route. Fails
  // closed on an unreadable matrix.
  const a = await requireAnyPermission(req, res, ['integrations.manage', 'settings.team.edit']);
  if (!a) return;
  const { user } = a;

  // Per-user volume cap, kept next to the recipient cap: one compromised or scripted
  // session cannot burn the mailbox's sending reputation for everyone. Generous enough that
  // no human workflow reaches it.
  if (!allow(req, res, { bucket: 'email-send', id: user.id, limit: 30, windowMs: 10 * 60_000 })) return;

  const { to, from, subject, body, replyTo, cc, bcc, headers, tags } = req.body || {};
  // ONE recipient in `to`. An array used to pass: `/^.+@.+\..+$/.test(String(['a@b.co',…]))`
  // is true for a comma-joined list, which is how one call addressed thousands.
  if (typeof to !== 'string' || !/^[^\s,;]+@[^\s,;]+\.[^\s,;]+$/.test(to.trim())) {
    res.status(400).json({ error: `Invalid recipient: ${typeof to === 'string' && to ? to : '(missing)'}` });
    return;
  }
  if (!subject) {
    res.status(400).json({ error: 'Subject is required' });
    return;
  }
  if (!body || !String(body).trim()) {
    res.status(400).json({ error: 'Body is empty' });
    return;
  }
  const extra = [...(Array.isArray(cc) ? cc : [cc]), ...(Array.isArray(bcc) ? bcc : [bcc])].filter(Boolean);
  if (1 + extra.length > MAX_RECIPIENTS) {
    res.status(400).json({ error: `Too many recipients (${1 + extra.length}); the limit is ${MAX_RECIPIENTS}.` });
    return;
  }

  const safeHeaders = {};
  if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (v != null && ALLOWED_HEADERS.has(String(k).toLowerCase())) safeHeaders[k] = v;
    }
  }

  const resolved = await resolveFromAndReplyTo({ from, replyTo });
  const result = await sendTransactional({
    to: to.trim(),
    from: resolved.from,
    replyTo: resolved.replyTo,
    subject,
    body,
    cc,
    bcc,
    headers: safeHeaders,
    tags,
  });

  if (!result.ok) {
    // 503 when no sending mailbox is set up at all, 502 when Gmail rejected the send —
    // the caller surfaces the error (test card / reminderFailed alert).
    res.status(result.skipped ? 503 : 502).json({ error: result.error || 'Email send failed' });
    return;
  }
  res.status(200).json({
    id: result.id,
    status: 'sent',
    from: resolved.from,
    ...(resolved.replyTo ? { replyTo: resolved.replyTo } : {}),
  });
}
