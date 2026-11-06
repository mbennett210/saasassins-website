// CS-856 — customer and building names stay EXACTLY as written inside anything the system
// translates (checklist and inspection names, sections, items). Production's first fill stored
// "Nightly Close-Out — Bayshore Senior Living" as "Cierre nocturno — Residencia para personas mayores
// Bayshore", and the same checklist type came out three different ways. Driven with a fake Supabase
// and a FAKE Google that translates names the way Google did:
//
//   P1. a name inside a string comes back verbatim in es and ht, and Google never sees it;
//   P2. strings that differ only by the name share ONE stored translation (the store is keyed by
//       the English with its names protected), so every "Nightly Close-Out — <customer>" reads alike;
//   P3. a lost name token = no line (null), never stored;
//   P4. the real template save: a customer and a building name inside the checklist's name, a
//       section and an item, verbatim in es and ht;
//   P5. the fill redoes the machine lines made before this fix (a name with a translated building)
//       and keeps the office's own line; the row's copy follows; a redone line carries the
//       translator version, and a second run redoes nothing;
//   P6. the Translations view counts an old machine line as due again; a save keeps the version of
//       a machine line the office left alone.
//
// Offline. Run: node scripts/test-i18n-proper-nouns.mjs
import { Readable } from 'node:stream';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000614';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
const KEY = 'AIzaFAKE-nouns-key-0123456789';
delete process.env.GOOGLE_TRANSLATE_API_KEY;
const BLOCKED = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
globalThis.fetch = BLOCKED;
installFakeSupabase();

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const tryImport = async (p) => { try { return await import(p); } catch (e) { return { __error: e.message }; } };

const S = await tryImport('../api/_lib/translateStore.js');
const L = await tryImport('../src/lib/checklistI18n.js');
const qc = await tryImport('../api/qc/[...path].js');
const F = await tryImport('../api/_lib/translateFill.js');
const I = await tryImport('../api/_lib/i18n.js');

const BAYSHORE = 'Bayshore Senior Living';
const BISCAYNE = 'Biscayne Harbor Apartments';
const CLUBHOUSE = 'Clubhouse';
// A fake Google that does what the real one did to names: "Senior Living" and "Apartments" become
// Spanish, "Harbor" Creole — and wraps everything "<LANG>«…»". Tokens it leaves alone.
const google = { sent: [], calls: 0 };
function fakeGoogle({ drop = false } = {}) {
  google.sent = []; google.calls = 0;
  globalThis.fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    google.calls += 1;
    google.sent.push(...req.q.map((q) => `${req.target}:${q}`));
    const say = (q) => {
      let out = q.replace(/Senior Living/g, 'Residencia para personas mayores').replace(/Apartments/g, 'Apartamentos').replace(/Harbor/g, 'Pò').replace(/Clubhouse/g, 'Casa club');
      if (drop) out = out.replace(/\{\d+\}/, '');
      return `${req.target.toUpperCase()}«${out}»`;
    };
    return { ok: true, status: 200, json: async () => ({ data: { translations: req.q.map((q) => ({ translatedText: say(q) })) } }) };
  };
}
const rows = () => world.tables.machine_translations || [];

// ── P1–P3: translateAll with the org's names ──────────────────────────────────────────────
if (!S.__error) {
  process.env.GOOGLE_TRANSLATE_API_KEY = KEY;
  resetWorld({ tables: { machine_translations: [] } });
  fakeGoogle();
  const nouns = [BAYSHORE, BISCAYNE, CLUBHOUSE];
  const T = (lang, list, opts = {}) => S.translateAll(lang, list, { report: () => {}, properNouns: nouns, ...opts });
  const [es] = await T('es', [`Nightly Close-Out — ${BAYSHORE}`]);
  const [ht] = await T('ht', [`Nightly Close-Out — ${BAYSHORE}`]);
  ok('P1a: a customer name inside a line comes back exactly as written, in Spanish and Creole',
    es === `ES«Nightly Close-Out — ${BAYSHORE}»` && ht === `HT«Nightly Close-Out — ${BAYSHORE}»`, JSON.stringify({ es, ht }));
  ok('P1b: …and Google never sees it', google.sent.length > 0 && !google.sent.some((q) => /Bayshore|Senior Living/.test(q)), JSON.stringify(google.sent));
  fakeGoogle();
  const [es2] = await T('es', [`Nightly Close-Out — ${BISCAYNE}`]);
  ok('P2a: another customer\'s checklist of the same kind reads the SAME words, with its own name', es2 === `ES«Nightly Close-Out — ${BISCAYNE}»`, es2);
  ok('P2b: …from the ONE stored translation (Google not asked again)', google.calls === 0, `${google.calls} calls`);
  const pattern = rows().filter((r) => r.lang === 'es' && r.english.startsWith('Nightly Close-Out'));
  ok('P2c: the store holds the line once, with the name protected', pattern.length === 1 && !/Bayshore|Biscayne/.test(pattern[0].english) && /\{noun0\}/.test(pattern[0].translation),
    JSON.stringify(pattern));
  const [two] = await T('es', [`${CLUBHOUSE} restrooms at ${BAYSHORE}`]);
  ok('P2d: two names in one line each come back in place', two === `ES«${CLUBHOUSE} restrooms at ${BAYSHORE}»`, two);
  resetWorld({ tables: { machine_translations: [] } });
  fakeGoogle({ drop: true });
  const [lost] = await T('es', [`Nightly Close-Out — ${BAYSHORE}`]);
  ok('P3: a lost name token = no line (null), and nothing is stored', lost === null && rows().length === 0, JSON.stringify({ lost, rows: rows() }));
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  globalThis.fetch = BLOCKED;
} else ok('P0: api/_lib/translateStore.js loads', false, S.__error);

// ── P4: the real template save ────────────────────────────────────────────────────────────
const logins = { 'tok-own': { id: 'auth-o', email: 'o@x.test', app_metadata: { role: 'owner', org_user_id: 'u_own', org_id: ORG } } };
const { seedPermissions } = await import('../src/lib/roles.js');
const NAME = `Nightly Close-Out — ${BAYSHORE}`;
const schemaOf = (extra = {}) => ({ areas: [{ id: 'a1', label: `${CLUBHOUSE} lobby`, siteAreaId: null, ...(extra.area || {}), items: [
  { id: 'i1', label: `Lock the ${BAYSHORE} front door`, photoRequired: false, naAllowed: false, ...(extra.i1 || {}) },
  { id: 'i2', label: 'Empty the trash', photoRequired: false, naAllowed: false, ...(extra.i2 || {}) },
] }], ...(extra.nameI18n ? { nameI18n: extra.nameI18n } : {}) });
function seedRoute(templates = {}) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 57, state: {
        version: 57, company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
        users: [{ id: 'u_own', role: 'owner', status: 'active', name: 'Owner', email: 'o@x.test' }],
        clients: [{ id: 'c1', name: BAYSHORE }, { id: 'c2', name: BISCAYNE }], sites: [{ id: 's1', clientId: 'c1', name: CLUBHOUSE }],
        permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
      } }],
      machine_translations: [], machine_translation_fills: [],
      ...templates,
    },
    logins,
  });
}
async function call(handler, { method = 'GET', subpath, token = 'tok-own', body, query = {} } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  Object.assign(req, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, query: { subpath, ...query }, body });
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response')), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(b) { done(this.statusCode, b); return this; }, send(b) { done(this.statusCode, b); return this; }, end(b) { done(this.statusCode, b ?? null); return this; } };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } catch (e) { return { status: -1, body: { error: e.message } }; } finally { Object.assign(console, quiet); }
}
const TPL = (schema, extra = {}) => ({
  inspection_templates: [{ id: 'it_1', organization_id: ORG, name: NAME, kind: 'checklist', client_id: 'c1', is_published: false, published_version_id: null, ...extra }],
  inspection_template_versions: [{ id: 'v_1', template_id: 'it_1', version_number: 1, status: 'draft', schema }],
});
if (!qc.__error && !L.__error) {
  process.env.GOOGLE_TRANSLATE_API_KEY = KEY;
  seedRoute(TPL(schemaOf())); fakeGoogle();
  const r = await call(qc.default, { method: 'POST', subpath: 'templates/save', body: { id: 'it_1', name: NAME, schema: schemaOf() } });
  const v = world.tables.inspection_template_versions.find((x) => x.id === 'v_1')?.schema;
  const lines = (lang) => [v?.nameI18n?.[lang]?.label, v?.areas?.[0]?.i18n?.[lang]?.label, v?.areas?.[0]?.items?.[0]?.i18n?.[lang]?.label];
  ok('P4a: the save went through', r.status === 200, JSON.stringify(r).slice(0, 160));
  ok('P4b: the customer and building names inside the checklist\'s name, a section and an item stay exactly as written, in Spanish',
    JSON.stringify(lines('es')) === JSON.stringify([`ES«Nightly Close-Out — ${BAYSHORE}»`, `ES«${CLUBHOUSE} lobby»`, `ES«Lock the ${BAYSHORE} front door»`]), JSON.stringify(lines('es')));
  ok('P4c: …and in Creole', JSON.stringify(lines('ht')) === JSON.stringify([`HT«Nightly Close-Out — ${BAYSHORE}»`, `HT«${CLUBHOUSE} lobby»`, `HT«Lock the ${BAYSHORE} front door»`]), JSON.stringify(lines('ht')));
  ok('P4d: the lines the system writes now carry the translator version', !!L.TRANSLATOR_VERSION && v?.nameI18n?.es?.v === L.TRANSLATOR_VERSION && v?.areas?.[0]?.items?.[1]?.i18n?.ht?.v === L.TRANSLATOR_VERSION);
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  globalThis.fetch = BLOCKED;
} else ok('P4: the template save route and the rules load', false, `${qc.__error || ''} ${L.__error || ''}`);

// ── P5: the fill redoes what the first fill got wrong, and keeps the office's own words ────
if (!F.__error && !I.__error && !L.__error) {
  process.env.GOOGLE_TRANSLATE_API_KEY = KEY;
  const BAD = 'Cierre nocturno — Residencia para personas mayores Bayshore';
  const old = schemaOf({
    nameI18n: { es: { label: BAD, en: NAME, source: 'machine' }, ht: { label: 'Fèmen chak swa — Bayshore Senior Living', en: NAME, source: 'machine' } },
    i1: { i18n: { es: { label: 'Cierren la puerta de Bayshore', en: `Lock the ${BAYSHORE} front door`, source: 'human' } } },
  });
  seedRoute({
    inspection_templates: [{ id: 'it_1', organization_id: ORG, name: NAME, kind: 'checklist', client_id: 'c1', is_published: true, published_version_id: 'v_pub', name_i18n: old.nameI18n }],
    inspection_template_versions: [{ id: 'v_pub', template_id: 'it_1', version_number: 4, status: 'published', published_at: '2026-10-15T02:00:00.000Z', schema: old }],
  });
  I.__resetStoredLines(); fakeGoogle();
  const env = { ...process.env, VERCEL_DEPLOYMENT_ID: 'dpl_nouns_1' };
  const out = await F.fillTranslations({ env, report: () => {} });
  const pub = world.tables.inspection_template_versions.find((x) => x.id === 'v_pub');
  const row = world.tables.inspection_templates.find((x) => x.id === 'it_1');
  ok('P5a: the name the first fill got wrong is redone — the building name exactly as written', pub.schema.nameI18n?.es?.label === `ES«Nightly Close-Out — ${BAYSHORE}»`
    && pub.schema.nameI18n?.ht?.label === `HT«Nightly Close-Out — ${BAYSHORE}»` && pub.schema.nameI18n?.es?.v === L.TRANSLATOR_VERSION, JSON.stringify(pub.schema.nameI18n));
  ok('P5b: the office\'s own line is kept, untouched', JSON.stringify(pub.schema.areas[0].items[0].i18n.es) === JSON.stringify({ label: 'Cierren la puerta de Bayshore', en: `Lock the ${BAYSHORE} front door`, source: 'human' }),
    JSON.stringify(pub.schema.areas[0].items[0].i18n.es));
  ok('P5c: the row\'s copy follows (what the lists read)', row.name_i18n?.es?.label === `ES«Nightly Close-Out — ${BAYSHORE}»`, JSON.stringify(row.name_i18n));
  ok('P5d: the English and the version number are untouched', pub.version_number === 4 && pub.schema.areas[0].items[0].label === `Lock the ${BAYSHORE} front door` && row.name === NAME);
  fakeGoogle();
  const logFrom = world.log.length;
  const again = await F.fillTranslations({ env: { ...env, VERCEL_DEPLOYMENT_ID: 'dpl_nouns_2' }, report: () => {} });
  const writes = world.log.slice(logFrom).filter((q) => q.table === 'inspection_template_versions' && q.op === 'update');
  ok('P5e: a second run (a later build) redoes nothing: every line is this version\'s', writes.length === 0 && again.complete === true, JSON.stringify({ writes: writes.length, again: again.complete, out: out.complete }));
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  globalThis.fetch = BLOCKED;
} else ok('P5: the fill loads', false, `${F.__error || ''} ${I.__error || ''}`);

// ── P6: the Translations view and the save's cleaning know the version ─────────────────────
if (!L.__error && L.TRANSLATOR_VERSION) {
  const node = (entry) => ({ label: 'Empty the trash', i18n: { es: entry } });
  ok('P6a: a machine line made before this version is due again ("Translated when you save")',
    L.translationState(node({ label: 'Vaciar la basura', en: 'Empty the trash', source: 'machine' }), 'es') === 'pending'
    && L.translationState(node({ label: 'Vaciar la basura', en: 'Empty the trash', source: 'machine', v: L.TRANSLATOR_VERSION }), 'es') === 'machine'
    && L.translationState(node({ label: 'Vaciar la basura', en: 'Empty the trash', source: 'human' }), 'es') === 'human');
  ok('P6b: …while a reader still sees it until it is redone (never English for nothing)',
    L.checklistLabel(node({ label: 'Vaciar la basura', en: 'Empty the trash', source: 'machine' }), 'es') === 'Vaciar la basura');
  const prev = { areas: [{ id: 'a1', label: 'Lobby', items: [{ id: 'i1', label: 'Empty the trash', i18n: { es: { label: 'Vaciar la basura', en: 'Empty the trash', source: 'machine', v: L.TRANSLATOR_VERSION } } }] }] };
  const kept = L.sanitizeSchemaTranslations(prev, JSON.parse(JSON.stringify(prev)));
  ok('P6c: a save keeps the version of a machine line the office left alone (no churn)', kept.areas[0].items[0].i18n.es.v === L.TRANSLATOR_VERSION
    && kept.areas[0].items[0].i18n.es.source === 'machine', JSON.stringify(kept.areas[0].items[0].i18n.es));
} else ok('P6: the translator version exists (src/lib/checklistI18n TRANSLATOR_VERSION)', false);

console.log(`\ntest-i18n-proper-nouns: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
