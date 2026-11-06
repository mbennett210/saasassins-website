// The SERVER's translation catalogs (CS-193, LANG-4, CS-851). The browser loads Spanish and Creole
// lazily (src/i18n/runtime.js); the server renders alerts for people who are not looking, in THEIR
// language, inside a cron or a route, synchronously — so it registers every catalog at load.
// Imported for its side effect by the modules every alert writer passes through: `_lib/orgState.js`
// (every bell row a server path writes is committed through it) and `_lib/push/store.js` (the
// push-only reminders and digests, which write no bell row). test-i18n-alerts.mjs drives the real
// fan-outs and pins both imports.
//
// 🔴 THE LINES THE BUNDLE LACKS (CS-851). Nobody re-runs a translation pass any more: an English
// line added or reworded after es.js / ht.js were written is OWED (api/_lib/i18nSource.js
// pendingLines — missing, or its English moved on per the source map). The server translates the
// owed lines itself (translatePendingLines → translateAll: the store first, Google for what it
// lacks) and:
//   • serves them to the app: GET /api/i18n/lines (EP-411, api/i18n/[...path].js);
//   • merges them over its own catalogs before it renders anything for a person
//     (ensureStoredLines, awaited by readOrgState — every server path that writes a bell row,
//     a push or a text reads the shared record first, for the recipient and their language);
//     they come from the build's FILL ROW, one read per process;
//   • fills the store and that row ahead of use from the ops-alerts cron, once per build
//     (_lib/translateFill.js).
//
// The merged lines are cached PER PROCESS, not per request. That is safe here and nowhere near the
// II.7 trap (one user's authorization snapshot served to another): they are the app's own words,
// the same for every reader. They come from ONE row per build (`machine_translation_fills`, written
// by the fill), so a process makes one small read; once every owed line is in, it never re-reads,
// and until then at most every STORED_LINES_RETRY_MS.
import { registerCatalog, catalogOf, SOURCE_CATALOG } from '../../src/i18n/core.js';
import es from '../../src/i18n/catalog/es.js';
import ht from '../../src/i18n/catalog/ht.js';
import sources from '../../src/i18n/catalog/sources.js';
import { createHash } from 'node:crypto';
import { pendingLines, entryForms, sourceHashOf } from './i18nSource.js';
import { translateAll } from './translateStore.js';
import { getSupabase } from './supabase.js';
import { reportError } from './monitor.js';

export const BUNDLED = Object.freeze({ es, ht });
export const SERVER_LANGUAGES = Object.freeze(Object.keys(BUNDLED));
export const STORED_LINES_RETRY_MS = 2 * 60 * 1000;
export const FILLS_TABLE = 'machine_translation_fills';
export const FILL_RETENTION_DAYS = 30;

registerCatalog('es', es);
registerCatalog('ht', ht);

export { userLanguage } from '../../src/i18n/languages.js';
export { translate, renderText, msg } from '../../src/i18n/core.js';

// The lines `lang` is owed by this build (the catalogs are fixed per build, so computed once).
const pendingByLang = new Map();
export function pendingFor(lang) {
  if (!BUNDLED[lang]) return [];
  if (!pendingByLang.has(lang)) {
    pendingByLang.set(lang, pendingLines({ en: SOURCE_CATALOG, bundled: BUNDLED[lang], sources, lang }));
  }
  return pendingByLang.get(lang);
}
const stringsOf = (pending) => pending.flatMap((p) => entryForms(p.value).map(([, text]) => text));

// { key: text | { one, other } } for every owed key whose every form has a translation — a plural
// comes through whole or not at all (half a plural would read English for some counts).
function assemble(pending, lineFor) {
  const lines = {};
  for (const { key, value } of pending) {
    const forms = entryForms(value);
    const got = forms.map(([, text]) => lineFor(text));
    if (got.some((g) => typeof g !== 'string' || !g)) continue;
    lines[key] = forms.length === 1 && forms[0][0] === null ? got[0] : Object.fromEntries(forms.map(([form], i) => [form, got[i]]));
  }
  return lines;
}

// This process's catalogs: the server's lines over what is registered (the bundle, or the bundle
// with lines merged before) — a changed key's line replaces the bundle's out-of-date one. Nothing
// to merge = nothing re-registered.
function mergeLines(lang, lines) {
  if (!lines || !Object.keys(lines).length) return;
  registerCatalog(lang, { ...(catalogOf(lang) || BUNDLED[lang]), ...lines });
}

// The build this process is: its deployment and what it owes. Two processes of one deployment
// always agree, so they read and write the same fill row; a new deployment fills again (once).
let fingerprint = null;
export function owedFingerprint() {
  if (!fingerprint) {
    const parts = SERVER_LANGUAGES.flatMap((lang) => pendingFor(lang).map((p) => `${lang}:${p.key}:${sourceHashOf(p.value)}`)).sort();
    fingerprint = createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex').slice(0, 16);
  }
  return fingerprint;
}
export function fillBuildId(env = process.env) {
  const deploy = String(env.VERCEL_DEPLOYMENT_ID || env.VERCEL_GIT_COMMIT_SHA || 'local').slice(0, 120);
  return `${deploy}:${owedFingerprint()}`;
}

// The fill row of this build: { lines, complete } | null. A failed read is reported and reads as none.
export async function readFillRow(buildId, { db = null, report = reportError } = {}) {
  try {
    const client = db || getSupabase();
    const { data, error } = await client.from(FILLS_TABLE).select('lines, complete').eq('build_id', buildId).maybeSingle();
    if (error) throw error;
    return data ? { lines: data.lines && typeof data.lines === 'object' ? data.lines : {}, complete: data.complete === true } : null;
  } catch (err) {
    report('i18n.fill-read', new Error(err?.code || 'fill-read-failed'), {});
    return null;
  }
}
// The fill writes its row (an upsert: a partial fill is finished by the next run) and, in the same
// breath, the rows of other builds older than FILL_RETENTION_DAYS go (retention at the write point).
export async function writeFillRow(buildId, lines, complete, { db = null, report = reportError, now = Date.now() } = {}) {
  try {
    const client = db || getSupabase();
    const { error } = await client.from(FILLS_TABLE).upsert(
      { build_id: buildId, lines, complete: complete === true, filled_at: new Date(now).toISOString() },
      { onConflict: 'build_id' },
    );
    if (error) throw error;
    const cutoff = new Date(now - FILL_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { error: reapErr } = await client.from(FILLS_TABLE).delete().lt('filled_at', cutoff).neq('build_id', buildId);
    if (reapErr) report('i18n.fill-reap', new Error(reapErr.code || 'fill-reap-failed'), {});
    return true;
  } catch (err) {
    report('i18n.fill-write', new Error(err?.code || 'fill-write-failed'), {});
    return false;
  }
}

const ownedKeys = (lang) => pendingFor(lang).filter((p) => storedLines.lines[lang]?.[p.key] != null).length;
const allIn = () => SERVER_LANGUAGES.every((lang) => ownedKeys(lang) === pendingFor(lang).length);

// The owed lines of `lang`. From memory when this process already holds them all (the fill row);
// otherwise translated now where the store lacks them (translateAll: the store, then Google),
// merged into this process's catalogs and returned. Never throws.
export async function translatePendingLines(lang, opts = {}) {
  const pending = pendingFor(lang);
  if (!pending.length) return { lines: {}, owed: 0 };
  if (!opts.skipMemory) {
    await ensureStoredLines({ db: opts.db || null });
    if (ownedKeys(lang) === pending.length) {
      return { lines: Object.fromEntries(pending.map((p) => [p.key, storedLines.lines[lang][p.key]])), owed: pending.length };
    }
  }
  const strings = stringsOf(pending);
  let out;
  try { out = await translateAll(lang, strings, opts); } catch { out = strings.map(() => null); }
  const byText = new Map(strings.map((s, i) => [s, out[i]]));
  const lines = assemble(pending, (text) => byText.get(text));
  mergeLines(lang, lines);
  storedLines.lines[lang] = { ...storedLines.lines[lang], ...lines };
  if (allIn()) storedLines.complete = true;
  return { lines, owed: pending.length };
}

// ── the stored lines, merged before any server render ────────────────────────────────────
const storedLines = { at: 0, complete: false, promise: null, lines: {} };
export async function ensureStoredLines({ force = false, db = null, now = Date.now(), env = process.env } = {}) {
  if (!force) {
    if (storedLines.complete) return storedLines.lines;
    if (storedLines.promise) return storedLines.promise;
    if (storedLines.at && now - storedLines.at < STORED_LINES_RETRY_MS) return storedLines.lines;
  }
  if (!SERVER_LANGUAGES.some((lang) => pendingFor(lang).length)) { storedLines.complete = true; return storedLines.lines; }
  const load = (async () => {
    storedLines.at = now;
    try {
      let client = db;
      if (!client) {
        try { client = getSupabase(); } catch { return storedLines.lines; }   // no database here (a script, a test)
      }
      const row = await readFillRow(fillBuildId(env), { db: client });
      for (const lang of SERVER_LANGUAGES) {
        const got = row?.lines?.[lang];
        if (!got || typeof got !== 'object') continue;
        // Only this build's owed keys, each shaped like its English (a line, or every plural form).
        const take = {};
        for (const { key, value } of pendingFor(lang)) {
          const v = got[key];
          const forms = entryForms(value);
          if (forms.length === 1 && forms[0][0] === null) { if (typeof v === 'string' && v) take[key] = v; continue; }
          if (v && typeof v === 'object' && forms.every(([f]) => typeof v[f] === 'string' && v[f])) take[key] = Object.fromEntries(forms.map(([f]) => [f, v[f]]));
        }
        storedLines.lines[lang] = { ...storedLines.lines[lang], ...take };
        mergeLines(lang, take);
      }
      storedLines.complete = allIn();
    } catch { /* never breaks a render: the English shows */ }
    return storedLines.lines;
  })();
  storedLines.promise = load;
  load.finally(() => { if (storedLines.promise === load) storedLines.promise = null; });
  return load;
}

// Test-only: the module holds process-wide state.
export function __resetStoredLines() {
  storedLines.at = 0; storedLines.complete = false; storedLines.promise = null; storedLines.lines = {};
  for (const lang of SERVER_LANGUAGES) registerCatalog(lang, BUNDLED[lang]);
}
