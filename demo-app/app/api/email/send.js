// POST /api/email/send — system transactional email via Resend (NOTIF-01).
// The delivery backend for src/lib/email.js sendEmail(): reminder emails
// (booking confirmation / post-service), user invites, and the Integrations
// test card all land here. This is a DIFFERENT path from marketing sequences
// (per-user Gmail via /api/inbox/:id/send) — nothing here touches that engine.
//
// Auth: requireAuthority — a team member's Supabase session (the SPA attaches it via
// lib/authHeader.js); a member set to Disabled is refused (authz.js ROSTER STATUS; this
// was a bare session check until 2026-09-23). `body.from` is a REQUEST, not an
// instruction: it is honoured only when it matches an env-configured address
// (RESEND_DEFAULT_FROM / RESEND_ALLOWED_FROM), otherwise the send goes out as the
// verified default with the requested address preserved as Reply-To (see _lib/email.js
// resolveFromAndReplyTo). Every crew member reaches this route, so the From can never
// be taken on trust from the body or from the blob the callers derive it from.
//
// Response mirrors the contract documented in src/lib/email.js:
//   200 → { id, status: 'sent', from, replyTo? }
//   4xx/5xx → { error } (the client adapter surfaces it as failureReason)

import { requireAuthority } from '../_lib/authz.js';
import { resolveFromAndReplyTo, sendTransactional } from '../_lib/email.js';
import { allow } from '../_lib/rateLimit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  // A member of the team, not just any session: a Disabled member can't send the
  // company's mail (authz.js ROSTER STATUS).
  const a = await requireAuthority(req, res);
  if (!a) return;
  const { user } = a;

  // The From is now allowlisted, but the SEND VOLUME was never bounded — the audit
  // flagged both together (#3). Per-user, so one compromised or scripted session
  // cannot burn the domain's sending reputation for everyone. Generous enough that
  // no human workflow reaches it: invites and reminder retries are single sends.
  if (!allow(req, res, { bucket: 'email-send', id: user.id, limit: 30, windowMs: 10 * 60_000 })) return;

  const { to, from, subject, body, replyTo, cc, bcc, headers, tags } = req.body || {};
  if (!to || !/^.+@.+\..+$/.test(String(to))) {
    res.status(400).json({ error: `Invalid recipient: ${to || '(missing)'}` });
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

  const resolved = resolveFromAndReplyTo({ from, replyTo });
  const result = await sendTransactional({
    to,
    from: resolved.from,
    replyTo: resolved.replyTo,
    subject,
    body,
    cc,
    bcc,
    headers,
    tags,
  });

  if (!result.ok) {
    // 503 when the provider isn't configured at all, 502 when Resend rejected
    // the send — the caller surfaces the error (test card / reminderFailed alert).
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
