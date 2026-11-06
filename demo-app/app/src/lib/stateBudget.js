// The shared record's SAVE CEILING, in one place the browser and the server both read.
//
// The company's shared record (org_state) is saved whole on every save, and the save route
// refuses a body over MAX_STATE_BYTES (api/state/org-state.js: a 413, and then EVERY save in the
// org is refused until the record shrinks). The server writer (api/_lib/orgState.js) enforces the
// same number. It used to live only in api/_lib/blobBudget.js, which the browser cannot load
// (it measures with node's Buffer), so nothing on the page could check a big change BEFORE
// sending it. It lives here now, pure and loadable everywhere; blobBudget.js re-exports it, so
// the server's imports are unchanged.
//
// ⚠️ The number is a ceiling, not headroom. If the record ever approaches it, that is the
// backend re-assessment's decision (moving slices into tables), not a number to raise.
export const MAX_STATE_BYTES = 3_500_000;

// What one save adds around the record itself: `{"state":…,"baseVersion":…,"build":…,"tab":…}`.
// Generous on purpose — the route measures the whole request body.
export const SAVE_ENVELOPE_BYTES = 200;

// 🔴 A BULK IMPORT MAY NOT FILL THE RECORD TO ITS CEILING. Everyday work keeps adding to it
// (notes, messages, review answers, notifications), and an import that stopped one byte short
// would leave the very next save — anyone's — refused for the whole company. So an import may
// take the record to 90% of the ceiling at most; the last 10% (350 KB) is kept for the office's
// ordinary work. Measured 2026-10-03: a building with one contact costs about 2 KB, so this
// still holds well over a thousand buildings beside today's record (S113's measure: 184,865
// bytes in production for 13 customers).
export const IMPORT_ALLOWED_SHARE = 0.9;
export const IMPORT_ALLOWED_BYTES = Math.floor(MAX_STATE_BYTES * IMPORT_ALLOWED_SHARE);

// UTF-8 length of a string, as the server will count it (content-length). `.length` counts
// UTF-16 code units, which UNDERSTATES any accented name — the wrong direction for a ceiling.
export function utf8Length(str) {
  const s = String(str ?? '');
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) { n += 4; i += 1; } // a surrogate pair is one 4-byte character
    else n += 3;
  }
  return n;
}

// "1.9 MB" / "184 KB" — how a size reads on screen.
export function formatStateBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1_000_000) return `${(b / 1_000_000).toFixed(b >= 10_000_000 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(b / 1000))} KB`;
}
