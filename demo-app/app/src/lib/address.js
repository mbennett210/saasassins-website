// Structured location address. `street` / `city` / `state` / `zip` are the
// editable source of truth on a site; `address` is kept as a composed one-line
// string so every existing consumer that reads `site.address` (ClientDetail
// Sites, JobDetail, InvoiceDetail, MyDay, geocoding) keeps working unchanged.
// parseAddress best-effort splits a legacy combined string back into the fields
// when an older site (created before structured fields) is opened for edit.

// { street, city, state, zip } → "123 Main St, Seattle WA 98101"
export function composeAddress({ street, city, state, zip } = {}) {
  const cityStateZip = [
    [(city || '').trim(), (state || '').trim()].filter(Boolean).join(' '),
    (zip || '').trim(),
  ].filter(Boolean).join(' ').trim();
  return [(street || '').trim(), cityStateZip].filter(Boolean).join(', ');
}

// "123 Main St, Seattle WA 98101" → { street, city, state, zip }. Lossy by
// design (only used to pre-fill the editor for legacy sites); a fresh site
// always carries the discrete fields, so this never runs on imported data.
export function parseAddress(address) {
  const out = { street: '', city: '', state: '', zip: '' };
  if (!address || typeof address !== 'string') return out;
  const parts = address.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return out;
  out.street = parts[0];
  const tail = parts.slice(1).join(', ');
  const m = tail.match(/^(.*?)\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*$/);
  if (m) { out.city = m[1].trim(); out.state = m[2].toUpperCase(); out.zip = m[3]; }
  else if (tail) { out.city = tail; }
  return out;
}
