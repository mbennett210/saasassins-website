// Resolve a public-folder asset (a leading-slash path like '/cleanspace-logo.png') against the Vite base path.
// The per-client product build runs at base '/', so these are no-ops there; the marketing demo runs under
// '/polishpoint/' (VITE_BASE_PATH), where a bare '/asset.png' would 404 at the site root. Vite rewrites asset
// imports and index.html references for the base, but NOT runtime string src="/..." values, so those pass here.
const BASE = (import.meta.env.BASE_URL || '/').replace(/\/$/, '');

export function assetUrl(p) {
  if (typeof p !== 'string' || !p.startsWith('/')) return p;
  return BASE + p;
}
