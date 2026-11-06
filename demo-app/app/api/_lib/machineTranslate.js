// Google Cloud Translation (the v2 "Basic" REST API), the ONE place the server asks it anything
// (CS-193, CS-851). Two callers: the translation store (_lib/translateStore.js — every Spanish and
// Creole line the app shows that is not bundled, and every checklist and inspection line, each
// translated once and kept) and an HR warning's own words (hr-warnings, read on demand, kept
// nowhere).
//
// 🔴 THE KEY. `GOOGLE_TRANSLATE_API_KEY` is SERVER-ONLY (never a VITE_ variable) and leaves this
// module only in the request header Google reads (`X-Goog-Api-Key`) — never in a URL (a failed
// fetch's message carries its URL), never in a log line, never in a response. A failure is
// reported as a fixed code; Google's own error text is not passed on.
//
// 🔴 OFF UNTIL SET. With no key `machineConfigured()` is false and a call throws
// `machine-translation-off`; nothing is ever invented in its place (no echo of the English as if
// it were Spanish). The callers then show the English.
//
// 🔴 BOUNDED. A request is at most BATCH lines and BATCH_CHARS characters (Google's v2 takes up to
// 128 strings; stay well inside it), and each request is abandoned after TIMEOUT_MS so a slow
// Google can never hold a save or a cron past its own limit.
export const MACHINE_LANGUAGES = Object.freeze(['es', 'ht']);   // Google: es = Spanish, ht = Haitian Creole
const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
export const BATCH = 100;
export const BATCH_CHARS = 30000;
export const TIMEOUT_MS = 8000;

export function machineConfigured(env = process.env) {
  return typeof env.GOOGLE_TRANSLATE_API_KEY === 'string' && env.GOOGLE_TRANSLATE_API_KEY.trim().length > 0;
}

// Google answers HTML-escaped text even in `format: 'text'` for a few characters; undo the ones a
// line can carry so "Don't" does not come back as "Don&#39;t".
function unescape(s) {
  return String(s ?? '')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

export class MachineTranslateError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}

// The requests a list of lines makes: at most BATCH lines and BATCH_CHARS characters each, in order.
export function batchesOf(texts) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const t of texts) {
    const n = String(t).length;
    if (cur.length && (cur.length >= BATCH || chars + n > BATCH_CHARS)) { out.push(cur); cur = []; chars = 0; }
    cur.push(t);
    chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// Translate `texts` (English) into `lang`. Returns the translations, index-aligned with `texts`.
// `fetchImpl` is injected by the offline tests; production uses the platform fetch.
export async function machineTranslate(texts, lang, { env = process.env, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (!machineConfigured(env)) throw new MachineTranslateError('machine-translation-off', 503);
  if (!MACHINE_LANGUAGES.includes(lang)) throw new MachineTranslateError('bad-language', 400);
  const key = env.GOOGLE_TRANSLATE_API_KEY.trim();
  const out = [];
  for (const q of batchesOf(texts)) {
    let res;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
        body: JSON.stringify({ q, source: 'en', target: lang, format: 'text' }),
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
    } catch {
      throw new MachineTranslateError('machine-translation-unreachable', 502);
    } finally {
      if (timer) clearTimeout(timer);
    }
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      // 400/403 here is almost always the key (wrong, restricted, API not enabled) — said as a
      // code someone can act on, never Google's text.
      throw new MachineTranslateError(res.status === 403 || res.status === 400 ? 'machine-translation-refused' : 'machine-translation-failed', 502);
    }
    const got = json?.data?.translations;
    if (!Array.isArray(got) || got.length !== q.length) throw new MachineTranslateError('machine-translation-failed', 502);
    for (const t of got) out.push(unescape(t?.translatedText));
  }
  return out;
}
