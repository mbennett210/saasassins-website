// CS-851 — the BROWSER side of "the system translates everything": the server's lines for what
// this build's bundle lacks (GET /api/i18n/lines) are fetched once per session and build, merged
// over the bundled catalog, and kept on the device so they still show offline; English shows only
// until that first fetch; the demo (no server) skips quietly. Drives src/i18n/serverLines.js with
// a fake storage, session and fetch, and the merge through the real core.js; pins the runtime and
// LanguageSync wiring (the runtime reads Vite's import.meta.env, so node cannot load it).
//
// Offline. Run: node scripts/test-i18n-client-lines.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const read = (p) => { try { return readFileSync(new URL(p, import.meta.url), 'utf8'); } catch { return ''; } };

let SL = null;
try { SL = await import('../src/i18n/serverLines.js'); } catch (e) { fails.push(`0: src/i18n/serverLines.js loads — ${e.message}`); }
const core = await import('../src/i18n/core.js');
const en = core.SOURCE_CATALOG;
const es = (await import('../src/i18n/catalog/es.js')).default;

function memoryStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}
// A key the bundle lacks, a plural it lacks, and a key it has.
const owedKey = Object.keys(en).find((k) => typeof en[k] === 'string' && !(k in es) && !k.startsWith('public'));
const owedPlural = Object.keys(en).find((k) => typeof en[k] === 'object' && !(k in es));
const bundledKey = 'common.save';

if (SL) {
  const local = memoryStorage();
  const session = memoryStorage();
  const answers = [];
  let asked = 0;
  const fetchLines = async (lang) => {
    asked += 1;
    return { lang, lines: {
      [owedKey]: 'LÍNEA DEL SERVIDOR',
      [owedPlural]: Object.fromEntries(Object.keys(en[owedPlural]).map((f) => [f, `PLURAL ${f} {count}`])),
      'no.such.key': 'junk',
      [bundledKey]: { one: 'wrong shape' },
    } };
  };
  const onLines = (l) => answers.push(l);
  const base = { lang: 'es', build: 1111, fetchLines, storage: local, session, en, onLines };

  const first = await SL.refreshServerLines(base);
  ok('C1: the first refresh asks the server and hands the lines over', asked === 1 && answers.length === 1 && first?.[owedKey] === 'LÍNEA DEL SERVIDOR', JSON.stringify(first)?.slice(0, 200));
  ok('C2: only keys the English has, each shaped like its English, are taken (junk dropped)',
    !('no.such.key' in (first || {})) && !(bundledKey in (first || {})) && typeof first?.[owedPlural] === 'object'
    && Object.keys(en[owedPlural]).every((f) => first[owedPlural][f] === `PLURAL ${f} {count}`));
  ok('C3: the lines are kept on the device for THIS build', SL.readCachedLines(local, 'es', 1111)?.[owedKey] === 'LÍNEA DEL SERVIDOR');
  await SL.refreshServerLines(base);
  ok('C4: once per session and build: a second refresh in the session asks nothing', asked === 1);
  const newSession = memoryStorage();
  await SL.refreshServerLines({ ...base, session: newSession });
  ok('C5: a new session asks again (once)', asked === 2);
  ok('C6: another build never reads this build\'s copy (its English may have moved on) — and the stale copy is cleared',
    SL.readCachedLines(local, 'es', 2222) === null && SL.readCachedLines(local, 'es', 1111) === null);
  // offline
  const local2 = memoryStorage();
  SL.writeCachedLines(local2, 'es', 1111, { [owedKey]: 'GUARDADA EN EL TELÉFONO' });
  let offlineCalls = 0;
  const offline = await SL.refreshServerLines({ ...base, storage: local2, session: memoryStorage(), fetchLines: async () => { offlineCalls += 1; throw new Error('Failed to fetch'); } });
  ok('C7: offline the fetch fails quietly and the device\'s copy stays (it still shows)', offline === null && offlineCalls === 1
    && SL.readCachedLines(local2, 'es', 1111)?.[owedKey] === 'GUARDADA EN EL TELÉFONO');
  const demo = await SL.refreshServerLines({ ...base, storage: memoryStorage(), session: memoryStorage(), fetchLines: async () => null });
  ok('C8: the demo (no server: fetchLines answers null) skips quietly', demo === null);
  let enAsked = 0;
  await SL.refreshServerLines({ ...base, lang: 'en', fetchLines: async () => { enAsked += 1; return { lines: {} }; } });
  ok('C9: English is never asked for', enAsked === 0);
  const full = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} };
  const quota = await SL.refreshServerLines({ ...base, storage: full, session: memoryStorage() });
  ok('C10: a full device storage still shows the lines this session', quota?.[owedKey] === 'LÍNEA DEL SERVIDOR');

  // The merge: what the runtime registers is the bundle with the server's lines over it.
  ok('C11: English shows for an owed key until the lines land', core.translate('es', owedKey) === core.english(owedKey) || !core.hasCatalog('es'));
  core.registerCatalog('es', { ...es, ...first });
  ok('C12: …and the server\'s line once they do, the bundle\'s own lines untouched',
    core.translate('es', owedKey) === 'LÍNEA DEL SERVIDOR' && core.translate('es', bundledKey) === es[bundledKey]);
  ok('C13: a plural from the server is picked by the count', core.translate('es', owedPlural, { count: 2 }) === 'PLURAL other 2');
}

// ── the wiring ────────────────────────────────────────────────────────────────────────────
const runtime = read('../src/i18n/runtime.js');
ok('W1: the runtime merges the device\'s copy for this build as soon as the bundled catalog loads',
  /readCachedLines\(storageOf\('local'\), code, APP_BUILD\)/.test(runtime) && /bundled\.set\(code, dict\)/.test(runtime));
ok('W2: …and registers the bundle with the server\'s lines over it, never one without the other',
  /registerCatalog\(code, \{ \.\.\.bundled\.get\(code\), \.\.\.\(serverLines\.get\(code\) \|\| \{\}\) \}\)/.test(runtime));
ok('W3: the session fetch goes through serverLines.refreshServerLines with this build\'s id',
  /refreshLines\(\{[\s\S]*build: APP_BUILD[\s\S]*onLines: \(lines\) => applyServerLines\(code, lines\)/.test(runtime));
const sync = read('../src/components/LanguageSync.jsx');
ok('W4: signed in, LanguageSync refreshes the lines of the language on screen', /if \(!me\?\.id \|\| !shown \|\| shown === SOURCE_LANGUAGE\) return;/.test(sync)
  && /ensureCatalog\(shown\)\.then\(\(\) => refreshServerLines\(shown, fetchLines\)\)/.test(sync));
ok('W5: …and an office tab, every language its roster reads (it writes their bell rows)',
  /ensureCatalog\(lang\)\.then\(\(\) => refreshServerLines\(lang, fetchLines\)\)/.test(sync));
const api = read('../src/lib/i18nApi.js');
ok('W6: the client asks GET /api/i18n/lines with the language only, and answers null with no server (the demo)',
  /if \(!BACKEND\) return null;\s*return api\(`\/i18n\/lines\?lang=\$\{encodeURIComponent\(lang\)\}`\);/.test(api));

console.log(`\ntest-i18n-client-lines: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
