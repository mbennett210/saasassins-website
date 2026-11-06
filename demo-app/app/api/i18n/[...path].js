// Translation API (CS-193, CS-851). The system translates everything; no person approves a line.
//
//   GET  /api/i18n/lines?lang=es|ht  -> { lang, lines: { key: text | { one, other } } }   (EP-411)
//        The app's own lines this build's bundle lacks (an English key with no es/ht line, or one
//        whose English moved on since its line was written — api/_lib/i18nSource pendingLines),
//        translated by the server itself (api/_lib/i18n translatePendingLines → translateAll:
//        the store first, Google for what it lacks, stored once). The browser merges them over
//        its bundled catalog and keeps them on the device (src/i18n/serverLines.js).
//        AUTH: requireAuthority — ANY signed-in team member, cleaners included (they read the
//        app in their language too); a customer-hub login holds no staff authority (403). It
//        takes ONLY `lang`: the server picks the lines from its own catalogs, so this door can
//        never translate text a caller sends (any other query or body is ignored). Rate-limited
//        per login (LINES_RATE). Lines a translation could not be had for are left out (that
//        key shows English); a plural comes whole or not at all.
//
// Checklist and inspection wording is translated by its own save (POST /api/qc/templates/save,
// src/lib/checklistI18n fillSchemaTranslations); the editor's machine drafts (EP-270 / EP-271)
// and their Checked tick are retired (CS-850). The key (GOOGLE_TRANSLATE_API_KEY) is server-only
// and never logged or returned — see _lib/machineTranslate.js.
import { requireAuthority } from '../_lib/authz.js';
import { withRequestCache } from '../_lib/requestCache.js';
import { allow } from '../_lib/rateLimit.js';
import { translatePendingLines, SERVER_LANGUAGES } from '../_lib/i18n.js';

// Per login: a phone fetches once per session and build; a few reloads and a second language
// fit easily, a loop does not.
export const LINES_RATE = { limit: 30, windowMs: 10 * 60 * 1000 };

export default function handler(req, res) {
  return withRequestCache(() => i18nHandler(req, res));
}

async function i18nHandler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [group, action] = path;

  if (group === 'lines' && !action && req.method === 'GET') {
    const a = await requireAuthority(req, res); if (!a) return;   // writes the 401 / 403
    const lang = req.query?.lang;
    if (!SERVER_LANGUAGES.includes(lang)) return res.status(400).json({ error: `lang must be one of ${SERVER_LANGUAGES.join(', ')}`, code: 'bad-language' });
    if (!allow(req, res, { bucket: 'i18n-lines', id: a.orgUserId || a.email, ...LINES_RATE })) return;
    const { lines } = await translatePendingLines(lang);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(200).json({ lang, lines });
  }

  return res.status(404).json({ error: 'Not found' });
}
