// CS-851 — the app's own wording is translated by the SYSTEM: what the deployed bundle lacks, the
// server translates itself, serves to the app and renders its own alerts with. No person runs a
// pass. Driven for real (the handler, readOrgState, the fan-out) with a fake Supabase and a FAKE
// Google, never the real API:
//
//   F. the source map (src/i18n/catalog/sources.js): every Spanish and Creole line records the
//      English it was translated from — a line with no record FAILS here; nothing is recorded for
//      a line no language holds; the file is what i18n:sources writes; i18n:import stamps what it
//      loads (and stamps a line loaded against old English as never matching);
//   P. what the bundle lacks (api/_lib/i18nSource pendingLines): an English key with no line, and
//      a line whose English moved on; English-only keys (LANG-8) never;
//   D. GET /api/i18n/lines (EP-411): a signed-out caller is refused (401), a customer login is
//      refused (403), a CLEANER gets the lines (200); the lines are exactly the owed keys, each
//      plural whole, from the server's own catalogs — text a caller sends is never translated, an
//      English-only line never reaches Google; asked again, the store answers; a bad language is a
//      400; it is rate-limited per login; a Google failure still answers 200 (that key: English);
//   A. alerts: a bell row the server writes for a Spanish cleaner reads the STORED line for a key
//      the bundle lacks (readOrgState merges the store before anything renders), English before.
//
// Offline. Run: node scripts/test-i18n-lines.mjs
import { Readable } from 'node:stream';
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000612';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
const KEY = 'AIzaFAKE-lines-key-0123456789';
delete process.env.GOOGLE_TRANSLATE_API_KEY;
const BLOCKED = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
globalThis.fetch = BLOCKED;
installFakeSupabase();

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const tryImport = async (p) => { try { return await import(p); } catch (e) { return { __error: e.message }; } };

const lib = await import('./i18n-lib.mjs');
const { en, es, ht } = await lib.loadCatalogs();
const SRC = await tryImport('../api/_lib/i18nSource.js');
const sourcesMod = await tryImport('../src/i18n/catalog/sources.js');
const sources = sourcesMod.default || null;
const gen = await tryImport('./i18n-sources.mjs');
const imp = await import('./i18n-import.mjs');
const { isEnglishOnly } = lib;
const have = !SRC.__error && !!sources;
ok('F0: the source map and its helpers load (src/i18n/catalog/sources.js, api/_lib/i18nSource.js)', have,
  `${SRC.__error || ''} ${sourcesMod.__error || ''}`);

// ── F. the source map ─────────────────────────────────────────────────────────────────────
if (have) {
  for (const [lang, dict] of [['es', es], ['ht', ht]]) {
    const unrecorded = Object.keys(dict).filter((k) => !SRC.sourceOf(sources, lang, k));
    ok(`F1: every ${lang}.js line records the English it was translated from (no source: ${unrecorded.slice(0, 6).join(', ') || 'none'})`, unrecorded.length === 0);
  }
  const orphan = Object.keys(sources).filter((k) => !(k in es) && !(k in ht));
  ok(`F2: nothing is recorded for a key no language holds (${orphan.slice(0, 6).join(', ') || 'none'})`, orphan.length === 0);
  const hex = new RegExp(`^[0-9a-f]{${SRC.SOURCE_HASH_CHARS}}$`);
  const bad = Object.entries(sources).filter(([, v]) => (typeof v === 'string' ? !hex.test(v) : !Object.values(v).every((x) => hex.test(x))));
  ok('F3: every record is a short sha256 (or one per language)', bad.length === 0, bad.slice(0, 3).map(([k]) => k).join(', '));
  if (!gen.__error) {
    const text = await gen.sourcesText();
    ok('F4: the file is exactly what `npm run i18n:sources` writes (nobody edits it by hand)',
      text === readFileSync(new URL('../src/i18n/catalog/sources.js', import.meta.url), 'utf8'));
  } else ok('F4: scripts/i18n-sources.mjs loads', false, gen.__error);
  // i18n:import keeps it current
  const key = 'crewHome.hero.allDone';
  const fresh = [{ row: 2, key, form: '', english: en[key], text: 'ES:hecho' }];
  const stale = [{ row: 2, key, form: '', english: 'Something older', text: 'ES:hecho' }];
  const plan1 = await imp.planImport({ rows: fresh, lang: 'es', en, current: {}, notes: lib.readCatalogNotes() });
  const plan2 = await imp.planImport({ rows: stale, lang: 'es', en, current: {}, notes: lib.readCatalogNotes(), allowStale: true });
  const st1 = typeof imp.sourceStamps === 'function' ? imp.sourceStamps('es', plan1.report.loaded, en) : null;
  const st2 = typeof imp.sourceStamps === 'function' ? imp.sourceStamps('es', plan2.report.loaded, en) : null;
  ok('F5: a line the import loads is stamped with today\'s English', st1?.get(`es:${key}`) === SRC.sourceHashOf(en[key]));
  ok('F6: a line loaded against OLD English (--allow-stale) is stamped as never matching, so the server re-translates it',
    st2?.get(`es:${key}`) === SRC.STALE_SOURCE && SRC.STALE_SOURCE !== SRC.sourceHashOf(en[key]));
  // …end to end: an import into a temporary catalog writes the map beside it
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'cs-i18n-lines-'));
  try {
    for (const f of ['en.js', 'ht.js']) copyFileSync(path.join(lib.CATALOG_DIR, f), path.join(tmp, f));
    writeFileSync(path.join(tmp, 'es.js'), 'export default {};\n');
    const csv = path.join(tmp, 'back.csv');
    writeFileSync(csv, `Key,Form,English,Spanish\n${key},,"${en[key]}",ES:hecho\n`);
    const { execFileSync } = await import('node:child_process');
    execFileSync(process.execPath, [fileURLToPath(new URL('./i18n-import.mjs', import.meta.url)), csv, '--lang', 'es', '--catalog-dir', tmp], { encoding: 'utf8' });
    const written = (await import(`${path.join(tmp, 'sources.js')}?t=${Date.now()}`)).default;
    ok('F7: i18n:import writes the source map beside the catalog, the loaded line stamped', SRC.sourceOf(written, 'es', key) === SRC.sourceHashOf(en[key])
      && SRC.sourceOf(written, 'ht', 'common.save') === SRC.sourceHashOf(en['common.save']), JSON.stringify(written[key]));
  } catch (e) { ok('F7: i18n:import writes the source map beside the catalog', false, e.message); }
  finally { rmSync(tmp, { recursive: true, force: true }); }
}

// ── P. what the bundle lacks ──────────────────────────────────────────────────────────────
if (have) {
  const pending = SRC.pendingLines({ en, bundled: es, sources, lang: 'es' });
  const lacks = Object.keys(en).filter((k) => !isEnglishOnly(k) && !(k in es));
  ok('P1: today the owed Spanish lines are exactly the English keys es.js lacks (the bundle is otherwise current)',
    pending.length === lacks.length && pending.every((p) => p.reason === 'missing') && lacks.length > 0, `${pending.length} vs ${lacks.length}`);
  ok('P2: an English-only key is never owed, though no language holds it (LANG-8)',
    Object.keys(en).some(isEnglishOnly) && !pending.some((p) => isEnglishOnly(p.key)));
  const reworded = { ...en, 'common.save': 'Save it now' };
  const p2 = SRC.pendingLines({ en: reworded, bundled: es, sources, lang: 'es' });
  ok('P3: a line whose English moved on is owed as "changed"', p2.some((p) => p.key === 'common.save' && p.reason === 'changed'));
  ok('P4: …and a line whose English is what it was translated from is not', !pending.some((p) => p.key === 'common.save'));
  const blank = SRC.pendingLines({ en, bundled: { ...es, 'common.save': '  ' }, sources, lang: 'es' });
  ok('P5: a blank line is owed like a missing one', blank.some((p) => p.key === 'common.save' && p.reason === 'missing'));
}

// ── D. the door ───────────────────────────────────────────────────────────────────────────
const route = await tryImport('../api/i18n/[...path].js');
const i18n = await tryImport('../api/_lib/i18n.js');
const { seedPermissions } = await import('../src/lib/roles.js');
const CU = '11111111-1111-4111-8111-111111111112';
const logins = {
  'tok-crew': { id: 'a-crew', email: 'tomas@x.test', app_metadata: { role: 'crew', org_user_id: 'u_tomas', org_id: ORG } },
  'tok-crew2': { id: 'a-crew2', email: 'ana@x.test', app_metadata: { role: 'crew', org_user_id: 'u_ana', org_id: ORG } },
  'tok-own': { id: 'a-own', email: 'o@x.test', app_metadata: { role: 'owner', org_user_id: 'u_own', org_id: ORG } },
  'tok-client': { id: 'a-client', email: 'pm@building.test', app_metadata: { role: 'client', client_user_id: CU, org_id: ORG } },
};
const person = (id, role, extra = {}) => ({ id, role, status: 'active', name: id, email: `${id.slice(2)}@x.test`, ...extra });
const STATE = {
  version: 57, company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: [person('u_own', 'owner', { email: 'o@x.test' }), person('u_tomas', 'crew', { email: 'tomas@x.test', language: 'es' }), person('u_ana', 'crew', { email: 'ana@x.test' })],
  clients: [{ id: 'cl_1', name: 'Coral Bay HOA', status: 'active' }], sites: [{ id: 's_1', clientId: 'cl_1', name: 'Clubhouse' }],
  permissions: seedPermissions(), userPermissionOverrides: [], notifications: [], opsSettings: {},
};
function seed(extra = {}) {
  resetWorld({ tables: { org_state: [{ organization_id: ORG, version: 57, state: structuredClone(STATE) }], machine_translations: [], ...extra }, logins });
}
async function call(handler, { method = 'GET', subpath, token = 'tok-crew', query = {}, body } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  Object.assign(req, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, query: { subpath, ...query }, body });
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response')), 20000);
      const done = (status, b, headers) => { clearTimeout(timer); resolve({ status, body: b, headers }); };
      const res = {
        statusCode: 200, headers: {},
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { this.headers[k] = v; return this; },
        json(b) { done(this.statusCode, b, this.headers); return this; },
        send(b) { done(this.statusCode, b, this.headers); return this; },
        end(b) { done(this.statusCode, b ?? null, this.headers); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } catch (e) { return { status: -1, body: { error: e.message } }; } finally { Object.assign(console, quiet); }
}
const google = { sent: [], calls: 0 };
function fakeGoogle({ status = 200 } = {}) {
  google.sent = []; google.calls = 0;
  globalThis.fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    google.calls += 1; google.sent.push(...req.q);
    if (status !== 200) return { ok: false, status, json: async () => ({ error: { message: 'nope' } }) };
    return { ok: true, status: 200, json: async () => ({ data: { translations: req.q.map((q) => ({ translatedText: `ES«${q}»` })) } }) };
  };
}

if (!route.__error && !i18n.__error && have) {
  const handler = route.default;
  const owed = i18n.pendingFor('es');
  const terms = await import('../src/i18n/terms.js');
  process.env.GOOGLE_TRANSLATE_API_KEY = KEY;
  seed(); fakeGoogle();
  const anon = await call(handler, { subpath: 'lines', token: null, query: { lang: 'es' } });
  ok('D1: a signed-out caller is refused (401), and nothing is translated', anon.status === 401 && google.calls === 0, JSON.stringify(anon).slice(0, 200));
  const client = await call(handler, { subpath: 'lines', token: 'tok-client', query: { lang: 'es' } });
  ok('D2: a customer-hub login is refused (403): staff only', client.status === 403 && google.calls === 0, JSON.stringify(client).slice(0, 200));
  const r = await call(handler, { subpath: 'lines', token: 'tok-crew', query: { lang: 'es', text: 'Hack the planet' }, body: { texts: ['Hack the planet'], lines: { x: 'y' } } });
  ok('D3: a CLEANER gets the lines (200)', r.status === 200 && r.body?.lang === 'es' && !!r.body?.lines, JSON.stringify(r).slice(0, 300));
  const got = Object.keys(r.body?.lines || {}).sort();
  ok('D4: the lines are exactly the keys this build owes Spanish', got.length === owed.length && got.join('|') === owed.map((p) => p.key).sort().join('|'), `${got.length} vs ${owed.length}`);
  const plurals = owed.filter((p) => typeof p.value === 'object');
  ok('D5: a plural comes through whole: every form the English has', plurals.length > 0
    && plurals.every((p) => typeof r.body.lines[p.key] === 'object' && Object.keys(p.value).every((f) => typeof r.body.lines[p.key][f] === 'string')));
  ok('D6: …and every line keeps its English placeholders', owed.every((p) => {
    const want = (typeof p.value === 'string' ? [p.value] : Object.values(p.value));
    const have2 = (typeof r.body.lines[p.key] === 'string' ? [r.body.lines[p.key]] : Object.values(r.body.lines[p.key] || {}));
    return want.every((w, i) => JSON.stringify((w.match(/\{[^}]*\}/g) || []).sort()) === JSON.stringify(((have2[i] || '').match(/\{[^}]*\}/g) || []).sort()));
  }));
  const allowed = new Set(owed.flatMap((p) => (typeof p.value === 'string' ? [p.value] : Object.values(p.value))).map((s) => terms.prepareForMachine('es', s).text));
  ok('D7: text a caller sends is NEVER translated — everything Google saw is the server\'s own owed English',
    google.sent.length > 0 && google.sent.every((q) => allowed.has(q)) && !google.sent.some((q) => /Hack the planet/.test(q)), google.sent.slice(0, 3).join(' | '));
  const englishOnlyTexts = Object.keys(en).filter(isEnglishOnly).flatMap((k) => (typeof en[k] === 'string' ? [en[k]] : Object.values(en[k])));
  ok('D8: an English-only line (what a customer reads) never reaches Google', !google.sent.some((q) => englishOnlyTexts.some((t) => terms.prepareForMachine('es', t).text === q)));
  ok('D9: the answer is private and never cached on the way', r.headers?.['Cache-Control'] === 'private, no-store');
  fakeGoogle();
  const again = await call(handler, { subpath: 'lines', token: 'tok-crew2', query: { lang: 'es' } });
  ok('D10: asked again (another cleaner), the store answers — Google is not asked', again.status === 200 && google.calls === 0
    && Object.keys(again.body?.lines || {}).length === owed.length, `${google.calls} calls`);
  const bad = await call(handler, { subpath: 'lines', token: 'tok-crew', query: { lang: 'fr' } });
  ok('D11: a language the app does not speak is a 400', bad.status === 400 && bad.body?.code === 'bad-language');
  let limited = null;
  for (let i = 0; i < route.LINES_RATE.limit + 2 && !limited; i += 1) {
    const x = await call(handler, { subpath: 'lines', token: 'tok-own', query: { lang: 'ht' } });
    if (x.status === 429) limited = x;
  }
  ok('D12: rate-limited per login (429)', !!limited);
  i18n.__resetStoredLines();   // a fresh process: nothing in memory, nothing stored
  seed(); fakeGoogle({ status: 503 });
  const down = await call(handler, { subpath: 'lines', token: 'tok-crew2', query: { lang: 'ht' } });
  // A line that is only placeholders and protected nouns ("{item} (backordered, ETA {eta, date})")
  // needs nothing from Google: the term list decides it. Every other line is left out.
  const bareOnly = (k) => (typeof en[k] === 'string' ? [en[k]] : Object.values(en[k])).every((t) => terms.prepareForMachine('ht', t).bare);
  const shown = Object.keys(down.body?.lines || {});
  ok('D13: Google down: still 200, and only the lines the term list decides alone come back (the rest show English)', down.status === 200
    && google.calls > 0 && shown.every(bareOnly) && shown.length < i18n.pendingFor('ht').length, JSON.stringify(shown.filter((k) => !bareOnly(k))).slice(0, 200));
  ok('D14: …and nothing Google was asked for is stored', (world.tables.machine_translations || []).every((r) => terms.prepareForMachine('ht', r.english).bare));
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  globalThis.fetch = BLOCKED;
} else {
  ok('D0: the door and the server catalogs load (api/i18n/[...path].js, api/_lib/i18n.js)', false, `${route.__error || ''} ${i18n.__error || ''}`);
}

// ── A. an alert the server writes reads the stored line ─────────────────────────────────────
if (!i18n.__error && have && typeof i18n.__resetStoredLines === 'function') {
  const { readOrgState } = await import('../api/_lib/orgState.js');
  const { supplyDecisionNotifications } = await import('../src/lib/supplyFlow.js');
  const KEY_T = 'alerts.supply.orderApprovedTitle';
  ok('A0: the alert line is one this build owes Spanish (es.js lacks it)', !(KEY_T in es) && i18n.pendingFor('es').some((p) => p.key === KEY_T));
  const request = { id: 'sr_1', number: 1047, clientId: 'cl_1', siteId: 's_1', requestedByUserId: 'u_tomas', status: 'approved', items: [{ id: 'l1', name: 'Paper towels', qty: 2 }] };
  const render = async () => {
    const { state } = await readOrgState();
    const rows = supplyDecisionNotifications(state, { request, decision: 'approve', actorUserId: 'u_own' });
    return rows.find((n) => n.userId === 'u_tomas');
  };
  i18n.__resetStoredLines();
  seed();
  const before = await render();
  ok('A1: with nothing stored, the Spanish cleaner\'s row reads English (never a key name)', !!before
    && !before.title.startsWith('Pedido aprobado') && !/alerts\./.test(before.title) && before.title.includes('Coral Bay HOA'), JSON.stringify(before));
  const ES_LINE = `Pedido aprobado: ${en[KEY_T]}`;
  i18n.__resetStoredLines();
  seed({ machine_translation_fills: [{ build_id: i18n.fillBuildId(), lines: { es: { [KEY_T]: ES_LINE } }, complete: true }] });
  const after = await render();
  ok('A2: once the build\'s lines are filled, the row the server writes for her reads them (merged before the render)',
    !!after && after.title.startsWith('Pedido aprobado: ') && !after.title.includes('{'), JSON.stringify(after));
  const reads = world.log.filter((q) => q.table === 'machine_translation_fills');
  ok('A2b: …in ONE read of the build\'s fill row (not a read per line)', reads.length === 1 && reads[0].eq?.build_id === i18n.fillBuildId(), JSON.stringify(reads));
  ok('A3: the merge rides the shared-record read every renderer makes (readOrgState awaits ensureStoredLines)',
    /const lines = ensureStoredLines\(\);[\s\S]*await lines;/.test(readFileSync(new URL('../api/_lib/orgState.js', import.meta.url), 'utf8')));
  const { state } = await readOrgState();
  const forAna = supplyDecisionNotifications(state, { request: { ...request, id: 'sr_2', requestedByUserId: 'u_ana' }, decision: 'approve', actorUserId: 'u_own' })
    .find((n) => n.userId === 'u_ana');
  ok('A4: …while an English reader\'s row, written in the same pass, stays English', !!forAna && !forAna.title.startsWith('Pedido')
    && forAna.title.includes('Coral Bay HOA'), JSON.stringify(forAna));
  i18n.__resetStoredLines();
} else {
  ok('A: the server catalogs expose the stored-line loader (api/_lib/i18n.js)', false);
}

console.log(`\ntest-i18n-lines: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
