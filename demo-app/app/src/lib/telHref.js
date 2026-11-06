// THE ONE DIAL NORMALIZATION (UI_RULES §28, click-to-dial): a phone number as people write it →
// the `tel:` href a phone dials — the digits only, with a leading + kept for an international
// number (a + anywhere else is dropped) — or null when there is no digit to dial ("TBD", blank).
// Read by components/PhoneLink (every click-to-dial number) and lib/areaScan (QR-31: whether the
// public page has a number to show at all). PURE, no imports.
export function telHref(phone) {
  if (typeof phone !== 'string' && typeof phone !== 'number') return null;
  const s = String(phone).trim();
  const digits = s.replace(/\D/g, '');
  return digits ? `tel:${s.startsWith('+') ? '+' : ''}${digits}` : null;
}
