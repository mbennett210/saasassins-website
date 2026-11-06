// THE SOFTWARE'S OWN SIGN-IN EMAILS — "Set up your … account" (an invite: a new team member, or a
// customer's hub login) and "Reset your … password". The words only; the link, the sending and the
// texted twin live in api/_lib/users.js (deliverSetPasswordLink), which imports this.
//
// SHARED (2026-10-20): moved here from api/_lib/users.js so the Review section's Drafts preview
// (src/data/emailDrafts.js) renders the very email the server sends. Browser- and node-safe.
import { DOC } from '../brand/doc.js';
import { IDENTITY } from '../brand/identity.generated.js';

// The same escaping as api/_lib/email.js escapeHtml (& < > " ').
const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// A "set your password" email: { subject, html }. `kind`: 'invite' (a new member, or a customer's hub
// login) or 'reset'. It is the SOFTWARE's own sign-in mail, so it names the product (IDENTITY.product:
// the company's name when the brand pack names no product, UI_RULES §129): "Set up your Clean Corner
// account". Pure, so test-product-name.mjs reads it under a throwaway pack.
export function setPasswordEmail(link, kind) {
  const app = IDENTITY.product.name;
  return {
    subject: kind === 'invite' ? `Set up your ${app} account` : `Reset your ${app} password`,
    html: setPasswordEmailHtml(link, kind),
  };
}

function setPasswordEmailHtml(link, kind) {
  const safe = escapeHtml(link);
  const isInvite = kind === 'invite';
  const app = escapeHtml(IDENTITY.product.name);
  const intro = isInvite
    ? `You've been added to <strong>${app}</strong>. Set your password to finish setting up your account and sign in.`
    : `A password reset was requested for your <strong>${app}</strong> account. Set a new password below.`;
  const cta = isInvite ? 'Set your password' : 'Set a new password';
  const footer = isInvite
    ? `Weren't expecting this? You can safely ignore this email.`
    : `Didn't request this? You can ignore this email — your password won't change.`;
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:${DOC.body};line-height:1.55">
  <p>${intro}</p>
  <p style="font-size:13px;color:${DOC.muted}">This link can be used once and expires shortly.</p>
  <p style="margin:22px 0">
    <a href="${safe}" style="background:${DOC.brand};color:${DOC.onBrand};text-decoration:none;padding:11px 20px;border-radius:6px;display:inline-block;font-weight:600">${cta}</a>
  </p>
  <p style="font-size:12px;color:${DOC.muted}">If the button doesn't work, paste this link into your browser:<br>${safe}</p>
  <p style="font-size:12px;color:${DOC.muted}">${footer}</p>
</div>`;
}
