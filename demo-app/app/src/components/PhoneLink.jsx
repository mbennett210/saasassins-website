// Tap-to-call phone link — the app's canonical click-to-dial affordance.
// Renders a display phone string as a `tel:` anchor so a crew member on a
// phone can one-tap dial the on-site contact. The href is stripped to digits
// (and a leading +) for dialing, while the human-formatted number stays as the
// visible label. Renders nothing when there's no phone, so callers own the
// em-dash / "not set" fallback. See UI_RULES.md ("Click-to-dial").
export default function PhoneLink({ phone, className = 'linklike', onClick, title }) {
  if (!phone) return null;
  const dial = String(phone).replace(/[^\d+]/g, '');
  if (!dial) return <span className="text-muted">{phone}</span>;
  return (
    <a className={className} href={`tel:${dial}`} onClick={onClick} title={title || `Call ${phone}`}>
      {phone}
    </a>
  );
}
