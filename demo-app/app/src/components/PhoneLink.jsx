// Tap-to-call phone link — the app's canonical click-to-dial affordance.
// Renders a display phone string as a `tel:` anchor so a crew member on a
// phone can one-tap dial the on-site contact. The href is stripped to digits
// (and a leading +) for dialing by the ONE rule, lib/telHref, while the
// human-formatted number stays as the visible label. Renders nothing when
// there's no phone, so callers own the em-dash / "not set" fallback. See
// UI_RULES.md ("Click-to-dial", §28).
//
// `children` (optional) replaces the visible number — an icon-only Call button (the manager's
// Shift check-in, 2026-10-09) — and then `ariaLabel` names it for a screen reader, since the
// number is no longer read out. Callers pass `title` / `ariaLabel` in the reader's language.
import { telHref } from '../lib/telHref';

export default function PhoneLink({ phone, className = 'linklike', onClick, title, ariaLabel, children }) {
  if (!phone) return null;
  const href = telHref(phone);
  if (!href) return <span className="text-muted">{phone}</span>;
  return (
    <a className={className} href={href} onClick={onClick} title={title || `Call ${phone}`} aria-label={ariaLabel || undefined}>
      {children || phone}
    </a>
  );
}
