// What a failed request SAYS to the person, in their language (CS-193). PURE.
//
// An API error carries English from the server (`err.message`) and, for the cases a screen
// handles on purpose, a `code`. A code the caller knows maps to a translated sentence. For
// anything else the English reader keeps exactly the server's words, as before; a reader in
// another language gets the screen's own translated sentence for what failed, with the
// server's words after it in brackets — the detail is still there for whoever they show it
// to, and the part they act on is in their language.
//
//   t          — the screen's translator (src/i18n/react.jsx useT)
//   err        — the thrown error ({ message, code?, payload?: { code } })
//   fallbackKey — the catalog key for "what failed", e.g. 'clock.error.clockInFailed'
//   known      — { [code]: key | (err) => message } for the codes this screen understands
export function errorText(t, err, fallbackKey, known = {}) {
  const code = err?.code || err?.payload?.code || null;
  const hit = code ? known[code] : null;
  if (hit) return typeof hit === 'function' ? t(hit(err)) : t(hit);
  const detail = typeof err?.message === 'string' ? err.message.trim() : '';
  if (t.lang === 'en') return detail || t(fallbackKey);
  return detail ? `${t(fallbackKey)} (${detail})` : t(fallbackKey);
}
