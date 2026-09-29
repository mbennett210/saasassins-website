// In-app "Report an issue" → SaaSassins CRM Work Queue, via server-side proxy.
//
//   POST /api/support/report  { subject, description, priority, attachments, context }
//     → 200 { ok: true, ticketId, status, priority }
//
// WHY A PROXY (decided — see ../../../SUPPORT_BUTTON_HANDOFF.md): the CRM's
// public support API sends no CORS headers, and the portal token in the JS
// bundle would let anyone who views source file tickets as this client. So the
// browser posts same-origin, and THIS function holds the token (server env
// only) and forwards. Flat single-segment route on purpose — a [...path]
// catch-all 404s on deep paths in prod without a vercel.json rewrite.
//
// Identity is derived HERE from the session (requireAuthority → JWT claims),
// never from the body: submitterEmail is the claim's email, submitterName is
// the roster name for that identity (cosmetic, fail-soft). context.user and
// context.source are likewise server-authored in buildContext.
//
// ⚠ SUPPORT_PORTAL_TOKEN must never be logged or echoed — error logs carry the
// CRM's status code only, never the URL (the URL contains the token).
import { requireAuthority } from '../_lib/authz.js';
import { allow } from '../_lib/rateLimit.js';
import { readOrgState } from '../_lib/orgState.js';
import { clampPriority, sanitizeAttachments, buildContext, mapCrmFailure } from '../_lib/support/shape.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const a = await requireAuthority(req, res);
  if (!a) return;
  // Every role may report an issue — crew in the field hit bugs too. The rate
  // limit bounds a runaway client (per identity, not per IP: reporters are
  // authenticated, and site crews often share an IP).
  if (!allow(req, res, { bucket: 'support-report', id: a.orgUserId || a.email, limit: 5, windowMs: 10 * 60 * 1000 })) return;

  const token = process.env.SUPPORT_PORTAL_TOKEN;
  const base = (process.env.SUPPORT_API_BASE || '').replace(/\/$/, '');
  if (!token || !base) return res.status(503).json({ error: 'Support is not configured.' });

  const body = req.body || {};
  const subject = String(body.subject || '').trim().slice(0, 300);
  if (!subject) return res.status(400).json({ error: 'Please give the issue a short title.' });

  // Roster name for the claimed identity + identity provenance for triage.
  // Fail-soft: the name is display-only and a blob read must never block a bug
  // report. `identitySource` classifies how the reporter resolved — `claim-only`
  // (a valid claim with NO roster row) is the orphan-login lockout signature.
  let name = null;
  let identitySource = a.roleSource === 'blob' ? 'blob-fallback' : 'claim-only';
  try {
    const { state } = await readOrgState();
    const users = Array.isArray(state?.users) ? state.users : [];
    const byId = users.find((u) => u.id === a.orgUserId);
    const me = byId || users.find((u) => (u.email || '').toLowerCase() === (a.email || '').toLowerCase());
    name = me?.name || null;
    if (a.roleSource !== 'blob') identitySource = byId ? 'roster' : (me ? 'email-match' : 'claim-only');
  } catch { /* cosmetic only */ }
  const submitterName = name || (a.email ? a.email.split('@')[0] : null);

  const payload = {
    subject,
    description: String(body.description || '').trim(),
    priority: clampPriority(body.priority),
    submitterName,
    submitterEmail: a.email || null,
    attachments: sanitizeAttachments(body.attachments),
    context: buildContext(body.context, {
      name: submitterName,
      email: a.email,
      userId: a.orgUserId || undefined,
      role: a.role || undefined,
      roleSource: a.roleSource || undefined,
      identitySource,
    }),
  };

  let r;
  try {
    r = await fetch(`${base}/${encodeURIComponent(token)}/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    console.error('[support/report] CRM unreachable');
    return res.status(502).json({ error: 'Support is temporarily unavailable. Please try again shortly.' });
  }

  if (r.status === 201) {
    const data = await r.json().catch(() => ({}));
    const t = data?.ticket || {};
    return res.status(200).json({ ok: true, ticketId: t.id || null, status: t.status || null, priority: t.priority || null });
  }

  let crmError = null;
  try { crmError = (await r.json())?.error || null; } catch { /* non-JSON */ }
  console.error('[support/report] CRM responded', r.status);
  const mapped = mapCrmFailure(r.status, crmError);
  return res.status(mapped.status).json({ error: mapped.error });
}
