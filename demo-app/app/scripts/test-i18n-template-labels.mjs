// CS-850 (CS-193; Matt's LANG-6) — the office's OWN checklist and inspection wording in Spanish and
// Creole is translated by the SYSTEM. Daniel, 2026-10-15: "No fucking translators to translate the
// language, this all needs to be handled by the system." Nobody checks a line; the office may type
// its own, which stays while its English does.
//
//   A. what a reader SEES (src/lib/checklistI18n checklistLabel): the line for TODAY's English,
//      machine or typed — an unchecked machine line shows; a line of reworded English never does;
//      an old row that still carries the retired `status` / `checkedBy` reads like any other;
//   B. what is SAVED (sanitizeSchemaTranslations, the route AND the demo stub): no `status`, no
//      `checkedBy` / `checkedAt` ever again; an untouched machine line stays machine; a line the
//      browser changed — or claims is "machine" — is the office's own;
//   C. what is never READ: the checklist COUNT ignores every label in every language, and the
//      fills still POST the office's English label;
//   D. the real template SAVE route, driven with a fake Supabase and a FAKE Google: every section
//      and item comes back translated into Spanish and Creole; the office's line for today's
//      English stays and is not re-sent; a reworded line is translated again; an unchanged
//      machine line is never re-sent; Google down, the save still saves; the key nowhere;
//   E. a CLEANER's read of the published template (templates/get) carries the lines;
//   F. the retired doors and words: the editor's machine drafts (EP-270 / EP-271) answer 404, the
//      client has no call to them, the editor has no Checked tick and no "Draft" button, and no
//      catalog line asks a person to check a translation;
//   N. the checklist or inspection NAME is translated the same way: on save (the version's
//      schema carries it, so a renamed draft carries its own until Publish), copied onto the
//      template row at publish so every list a cleaner reads names it in their language; the
//      office's own wording kept until the name changes; the customer hub keeps the English
//      (LANG-8).
//
// Offline. Run: node scripts/test-i18n-template-labels.mjs
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000610';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
delete process.env.GOOGLE_TRANSLATE_API_KEY;
const BLOCKED = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
globalThis.fetch = BLOCKED;
installFakeSupabase();

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const read = (p) => { try { return readFileSync(new URL(p, import.meta.url), 'utf8'); } catch { return ''; } };

let L = null; let route = null; let qcRoute = null; let count = null;
try { L = await import('../src/lib/checklistI18n.js'); } catch { /* reported below */ }
try { route = (await import('../api/i18n/[...path].js')).default; } catch { /* reported below */ }
try { qcRoute = (await import('../api/qc/[...path].js')).default; } catch { /* reported below */ }
try { count = await import('../src/lib/checklistCount.js'); } catch { /* always there */ }
const { seedPermissions } = await import('../src/lib/roles.js');
const have = !!L && typeof L.checklistLabel === 'function' && typeof L.fillSchemaTranslations === 'function';
ok('0: the system-translation rules load (src/lib/checklistI18n fillSchemaTranslations)', have);
const safe = (fn) => { try { return fn(); } catch { return undefined; } };

// ── A. what a reader sees ─────────────────────────────────────────────────────────────────
const MOP = 'Mop the lobby floor';
const ES = 'Trapear el piso del vestíbulo';
const item = (i18n) => ({ id: 'i1', label: MOP, ...(i18n ? { i18n } : {}) });
const label = (n, lang) => safe(() => L.checklistLabel(n, lang));
ok('A1: an UNCHECKED machine line of today\'s English shows to a Spanish reader', have && label(item({ es: { label: ES, en: MOP, source: 'machine' } }), 'es') === ES);
ok('A2: the office\'s own line shows too', have && label(item({ es: { label: 'Trapeen el lobby', en: MOP, source: 'human' } }), 'es') === 'Trapeen el lobby');
ok('A3: a line of OLD English (the office reworded it) shows the English', have && label(item({ es: { label: ES, en: 'Mop the floor', source: 'machine' } }), 'es') === MOP);
ok('A4: an English reader always reads the office\'s English', have && label(item({ es: { label: ES, en: MOP, source: 'machine' } }), 'en') === MOP);
ok('A5: a Creole reader with only a Spanish line reads English', have && label(item({ es: { label: ES, en: MOP, source: 'machine' } }), 'ht') === MOP);
ok('A6: a blank line shows the English', have && label(item({ es: { label: '  ', en: MOP, source: 'machine' } }), 'es') === MOP);
ok('A7: no translations at all is exactly as before', have && label(item(), 'es') === MOP);
ok('A8: saved data stays readable — a row that still carries the retired status / checkedBy renders its line, a "draft" as surely as a "checked"',
  have && label(item({ es: { label: ES, en: MOP, status: 'draft', source: 'machine' } }), 'es') === ES
  && label(item({ es: { label: ES, en: MOP, status: 'checked', source: 'human', checkedBy: 'u_x', checkedAt: '2026-10-04T00:00:00Z' } }), 'es') === ES);
ok('A9: the Translations view reads each line\'s state: machine, the office\'s own, or pending (none / reworded English / an older translator\'s, CS-856)', have
  && L.translationState(item({ es: { label: ES, en: MOP, source: 'machine', v: L.TRANSLATOR_VERSION } }), 'es') === 'machine'
  && L.translationState(item({ es: { label: ES, en: MOP, source: 'machine' } }), 'es') === 'pending'
  && L.translationState(item({ es: { label: ES, en: MOP, source: 'human' } }), 'es') === 'human'
  && L.translationState(item(), 'es') === 'pending'
  && L.translationState(item({ es: { label: ES, en: 'old', source: 'machine' } }), 'es') === 'pending');

// ── B. what is saved ──────────────────────────────────────────────────────────────────────
const schemaWith = (itemI18n, areaI18n) => ({
  areas: [{
    id: 'a1', label: 'Lobby', siteAreaId: 'sa_1', ...(areaI18n ? { i18n: areaI18n } : {}),
    items: [{ id: 'i1', label: MOP, photoRequired: true, naAllowed: false, ...(itemI18n ? { i18n: itemI18n } : {}) }],
  }],
});
const clean = (prev, next) => safe(() => L.sanitizeSchemaTranslations(prev, next));
const tr = (schema, lang = 'es') => schema?.areas?.[0]?.items?.[0]?.i18n?.[lang];
{
  const s = clean(null, schemaWith({ es: { label: ES, en: MOP, status: 'checked', source: 'human', checkedBy: 'u_forged', checkedAt: '2020-01-01T00:00:00Z' } }));
  ok('B1: nothing is "checked" any more — status, checkedBy and checkedAt are never saved', !!tr(s) && !('status' in tr(s)) && !('checkedBy' in tr(s)) && !('checkedAt' in tr(s)), JSON.stringify(tr(s)));
  const prev = schemaWith({ es: { label: ES, en: MOP, source: 'machine' } });
  ok('B2: a machine line the office left alone stays machine', tr(clean(prev, prev))?.source === 'machine');
  ok('B3: a line the office changed is its own', tr(clean(prev, schemaWith({ es: { label: 'Trapeen el lobby', en: MOP, source: 'machine' } })))?.source === 'human');
  ok('B4: a browser cannot mint a "machine" line (no such line before = the office\'s own)', tr(clean(null, schemaWith({ es: { label: ES, en: MOP, source: 'machine' } })))?.source === 'human');
}
{
  const s = clean(null, schemaWith({
    es: { label: ES, en: MOP, source: 'telepathy' },
    fr: { label: 'Laver le sol', en: MOP, source: 'machine' },
    ht: { label: 'x'.repeat(L?.MAX_TRANSLATION_CHARS ? L.MAX_TRANSLATION_CHARS + 1 : 501), en: MOP, source: 'machine' },
  }));
  ok('B5: an unknown source is the office\'s own', tr(s)?.source === 'human');
  ok('B6: a language we do not speak is dropped', tr(s, 'fr') === undefined);
  ok('B7: a line over the limit is dropped, not cut', tr(s, 'ht') === undefined);
}
{
  const s = clean(null, schemaWith({ es: { label: '   ', source: 'human' } }));
  ok('B8: a blank line leaves no entry behind', s?.areas?.[0]?.items?.[0]?.i18n === undefined);
  const plain = schemaWith();
  ok('B9: a schema with no translations saves exactly as it came', JSON.stringify(clean(null, plain)) === JSON.stringify(plain));
  const s2 = clean(null, schemaWith({ es: { label: ES, en: MOP, source: 'machine' } }, { es: { label: 'Vestíbulo', en: 'Lobby', status: 'checked' } }));
  ok('B10: nothing else on a section or item is touched', s2?.areas?.[0]?.siteAreaId === 'sa_1'
    && s2?.areas?.[0]?.items?.[0]?.photoRequired === true && s2?.areas?.[0]?.items?.[0]?.naAllowed === false);
  ok('B11: sections are cleaned too', !!s2?.areas?.[0]?.i18n?.es && !('status' in s2.areas[0].i18n.es));
}

// ── C. what is never read ─────────────────────────────────────────────────────────────────
{
  const plain = schemaWith();
  const translated = schemaWith({ es: { label: ES, en: MOP, source: 'machine' }, ht: { label: 'Lave atè a', en: MOP, source: 'human' } });
  const renamed = JSON.parse(JSON.stringify(translated)); renamed.areas[0].items[0].label = 'Something else entirely';
  const items = [{ item_key: 'i1', checked: true }];
  const n = (sc) => JSON.stringify(count?.countChecklistSubmission(sc, items, { photoKeys: ['i1'] }));
  ok('C1: the checklist count is the same with or without translations, whatever the labels say',
    !!count && n(plain) === n(translated) && n(translated) === n(renamed));
  const src = read('../src/lib/checklistCount.js');
  ok('C2: lib/checklistCount reads no label and no translation at all', !!src && !/\.label\b/.test(src) && !/i18n/.test(src));
  ok('C3: the checklist fill POSTS the office\'s English label (and shows checklistLabel)',
    /label: `\$\{area\.label \|\| english\('checklist\.fill\.areaFallback'\)\}\. \$\{it\.label \|\| english\('checklist\.fill\.itemFallback'\)\}`/.test(read('../src/components/ChecklistFill.jsx'))
    && /checklistLabel\(it, t\.lang\)/.test(read('../src/components/ChecklistFill.jsx')));
  ok('C4: the inspection fill POSTS the office\'s English label (and shows checklistLabel)',
    /label: `\$\{area\.label \|\| english\('inspectionFill\.areaFallback'\)\}\. \$\{it\.label \|\| english\('inspectionFill\.itemFallback'\)\}`/.test(read('../src/lib/inspections.js'))
    && /inspectionFillItems\(/.test(read('../src/components/InspectionFill.jsx'))
    && /checklistLabel\(item, t\.lang\)/.test(read('../src/components/InspectionFill.jsx')));
  ok('C5: the editor saves each label\'s lines with it (schema carries i18n)',
    /const withI18n = \(n\) => \(n\.i18n \? \{ i18n: n\.i18n \} : \{\}\);/.test(read('../src/components/InspectionTemplateEditor.jsx')));
  ok('C6: the demo stub saves through the same cleaning as the server (the name\'s lines included)',
    /if \(schema\) schema = sanitizeSchemaTranslations\(v\?\.schema, schema, \{ name: /.test(read('../src/lib/qcApi.js')));
}

// ── a request through a real handler ──────────────────────────────────────────────────────
const KEY = 'AIzaFAKE-test-key-0123456789';
const logins = {
  'tok-own': { id: 'auth-o', email: 'o@x.test', app_metadata: { role: 'owner', org_user_id: 'u_own', org_id: ORG } },
  'tok-crew': { id: 'auth-c', email: 'c@x.test', app_metadata: { role: 'crew', org_user_id: 'u_crew', org_id: ORG } },
};
const person = (id, role) => ({ id, role, status: 'active', name: id, email: `${id === 'u_own' ? 'o' : 'c'}@x.test` });
function seed(extra = {}) {
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, version: 57, state: {
        version: 57, company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
        users: [person('u_own', 'owner'), person('u_crew', 'crew')],
        clients: [{ id: 'c1', name: 'Coral Bay HOA' }], sites: [], permissions: seedPermissions(), userPermissionOverrides: [], notifications: [],
      } }],
      machine_translations: [],
      ...extra,
    },
    logins,
  });
}
const logs = [];
async function call(handler, { method = 'GET', subpath, token = 'tok-own', body, query = {} } = {}) {
  const raw = body ? JSON.stringify(body) : '';
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  Object.assign(req, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, query: { subpath, ...query }, body });
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  const keep = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  console.log = console.warn = console.error = keep;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no response')), 10000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200, headers: {},
        status(c) { this.statusCode = c; return this; },
        setHeader(k, v) { this.headers[k] = v; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } catch (e) { return { status: -1, body: { error: e.message } }; } finally { Object.assign(console, quiet); }
}
// A fake Google: records what it was sent, answers each line "<LANG>«…»".
const google = { sent: [] };
function fakeGoogle({ status = 200 } = {}) {
  google.sent = [];
  globalThis.fetch = async (url, init) => {
    const req = JSON.parse(init.body);
    google.sent.push(...req.q.map((q) => `${req.target}:${q}`));
    if (status !== 200) return { ok: false, status, json: async () => ({ error: { message: `API key not valid (${KEY})` } }) };
    return { ok: true, status: 200, json: async () => ({ data: { translations: req.q.map((q) => ({ translatedText: `${req.target.toUpperCase()}«${q}»` })) } }) };
  };
}
const version = (id = 'v_1') => (world.tables.inspection_template_versions || []).find((v) => v.id === id)?.schema;
const node = (schema, kind, i = 0) => (kind === 'area' ? schema?.areas?.[0] : schema?.areas?.[0]?.items?.[i]);
const twoItems = (overrides = {}) => ({
  areas: [{ id: 'a1', label: 'Lobby', siteAreaId: null, ...(overrides.area || {}), items: [
    { id: 'i1', label: MOP, photoRequired: false, naAllowed: false, ...(overrides.i1 || {}) },
    { id: 'i2', label: 'Empty the trash', photoRequired: false, naAllowed: false, ...(overrides.i2 || {}) },
  ] }],
});
const TEMPLATES = (schema) => ({
  inspection_templates: [{ id: 'it_1', organization_id: ORG, name: 'Lobby nightly', kind: 'checklist', client_id: 'c1', is_published: false, published_version_id: null }],
  inspection_template_versions: [{ id: 'v_1', template_id: 'it_1', version_number: 1, status: 'draft', schema }],
});

// ── D. the save route translates ──────────────────────────────────────────────────────────
if (qcRoute && have) {
  process.env.GOOGLE_TRANSLATE_API_KEY = KEY;
  seed(TEMPLATES(twoItems())); fakeGoogle();
  const r = await call(qcRoute, { method: 'POST', subpath: 'templates/save', body: { id: 'it_1', schema: twoItems() } });
  const saved = version();
  ok('D1: the save went through', r.status === 200, JSON.stringify(r).slice(0, 200));
  ok('D2: every section and item is saved in Spanish AND Creole, by the server ("machine", made from today\'s English)',
    ['area', 'item'].every((k) => ['es', 'ht'].every((lang) => {
      const e = node(saved, k)?.i18n?.[lang];
      return e?.source === 'machine' && e.en === node(saved, k).label && e.label === `${lang.toUpperCase()}«${node(saved, k).label}»`;
    })) && node(saved, 'item', 1)?.i18n?.es?.source === 'machine', JSON.stringify(saved));
  ok('D3: …so a Spanish cleaner reads it with no one having checked anything', L.checklistLabel(node(saved, 'item'), 'es') === `ES«${MOP}»`);
  ok('D4: each line — and the template\'s name — is sent once per language (unique English)', google.sent.length === 8
    && google.sent.filter((q) => q.endsWith('Lobby nightly')).length === 2, JSON.stringify(google.sent));

  // An office line for today's English stays and is not sent; a reworded line is translated again;
  // an unchanged machine line is never re-sent.
  const next = JSON.parse(JSON.stringify(saved));
  next.areas[0].items[0].i18n.es = { label: 'Trapeen el lobby', en: MOP, source: 'human' };
  next.areas[0].items[1].label = 'Empty every trash can';
  fakeGoogle();
  const r2 = await call(qcRoute, { method: 'POST', subpath: 'templates/save', body: { id: 'it_1', schema: next } });
  const resaved = version();
  ok('D5: the office\'s own line for today\'s English stays (an override, never a gate)', r2.status === 200
    && node(resaved, 'item')?.i18n?.es?.label === 'Trapeen el lobby' && node(resaved, 'item')?.i18n?.es?.source === 'human', JSON.stringify(node(resaved, 'item')));
  ok('D6: a reworded line is translated again, from its new English', node(resaved, 'item', 1)?.i18n?.es?.label === 'ES«Empty every trash can»'
    && node(resaved, 'item', 1)?.i18n?.ht?.en === 'Empty every trash can');
  ok('D7: …and only it goes to Google — no line already translated is re-sent', google.sent.length === 2
    && google.sent.every((s) => s.endsWith('Empty every trash can')), JSON.stringify(google.sent));
  const reworded = JSON.parse(JSON.stringify(resaved));
  reworded.areas[0].items[0].label = 'Mop and dry the lobby floor';
  fakeGoogle();
  await call(qcRoute, { method: 'POST', subpath: 'templates/save', body: { id: 'it_1', schema: reworded } });
  ok('D8: once its English is reworded, the office\'s line gives way to the system\'s translation of the new English',
    node(version(), 'item')?.i18n?.es?.source === 'machine' && node(version(), 'item')?.i18n?.es?.label === 'ES«Mop and dry the lobby floor»');
  ok('D9: nothing saved carries a status or a checked-by', !JSON.stringify(version()).includes('"status"') && !JSON.stringify(version()).includes('checkedBy'));

  // Google down: the save still saves; the lines stay English; the key is nowhere.
  seed(TEMPLATES(twoItems())); fakeGoogle({ status: 403 });
  logs.length = 0;
  const down = await call(qcRoute, { method: 'POST', subpath: 'templates/save', body: { id: 'it_1', schema: twoItems() } });
  ok('D10: with Google down the save still answers 200 and saves the wording', down.status === 200 && node(version(), 'item')?.label === MOP, JSON.stringify(down).slice(0, 200));
  ok('D11: …with no line invented (the English shows until the cron fills it)', !node(version(), 'item')?.i18n && L.schemaNeedsTranslation(version()));
  ok('D12: the key is in no log line and in no answer', logs.every((l) => !l.includes(KEY)) && !JSON.stringify(down.body).includes(KEY), logs.join(' | ').slice(0, 300));
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  // No key: the save saves as it always did.
  seed(TEMPLATES(twoItems())); fakeGoogle();
  const off = await call(qcRoute, { method: 'POST', subpath: 'templates/save', body: { id: 'it_1', schema: twoItems() } });
  ok('D13: with no key the save works and asks no one', off.status === 200 && google.sent.length === 0);
  globalThis.fetch = BLOCKED;
} else {
  ok('D: the template save route loads (api/qc/[...path].js)', false);
}

// ── E. a cleaner's read carries the lines ─────────────────────────────────────────────────
if (qcRoute && have) {
  process.env.GOOGLE_TRANSLATE_API_KEY = KEY;
  seed(TEMPLATES(twoItems())); fakeGoogle();
  await call(qcRoute, { method: 'POST', subpath: 'templates/save', body: { id: 'it_1', schema: twoItems() } });
  const pub = await call(qcRoute, { method: 'POST', subpath: 'templates/publish', body: { id: 'it_1' } });
  const got = await call(qcRoute, { subpath: 'templates/get', token: 'tok-crew', query: { id: 'it_1' } });
  const sch = got.body?.published?.schema;
  ok('E1: published, the template a CLEANER loads (templates/get, the crew checklist page\'s read) carries every line',
    pub.status === 200 && got.status === 200 && node(sch, 'item')?.i18n?.es?.label === `ES«${MOP}»` && node(sch, 'area')?.i18n?.ht?.source === 'machine', JSON.stringify(got).slice(0, 300));
  ok('E2: …and the cleaner\'s screen shows them', L.checklistLabel(node(sch, 'item'), 'ht') === `HT«${MOP}»`);
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  globalThis.fetch = BLOCKED;
}

// ── F. the retired doors and words ────────────────────────────────────────────────────────
if (route) {
  seed();
  const st = await call(route, { subpath: 'machine/status' });
  const dr = await call(route, { method: 'POST', subpath: 'machine/drafts', body: { lang: 'es', texts: [MOP] } });
  ok('F1: the editor\'s machine drafts are gone (EP-270 / EP-271 answer 404)', st.status === 404 && dr.status === 404, JSON.stringify([st.status, dr.status]));
} else ok('F1: the translation route loads (api/i18n/[...path].js)', false);
const apiSrc = read('../src/lib/i18nApi.js');
ok('F2: the client has no call to them', !/machineDrafts|machineStatus|machine\/drafts|machine\/status/.test(apiSrc));
const view = read('../src/components/TemplateTranslations.jsx');
ok('F3: the Translations view has no Checked tick and no draft button', !!view && !/type="checkbox"/.test(view) && !/withChecked|draftMissing|machineDrafts/.test(view));
ok('F4: …and says how each line stands: translated automatically, edited, or translated when you save',
  /translations\.auto/.test(view) && /translations\.edited/.test(view) && /translations\.pending/.test(view));
const cats = await Promise.all(['en', 'es', 'ht'].map(async (l) => (await import(`../src/i18n/catalog/${l}.js`)).default));
const asksAPerson = cats.flatMap((c, i) => Object.entries(c).filter(([k]) => k.startsWith('translations.'))
  .filter(([, v]) => /checked|biling|someone who speaks|tick/i.test(JSON.stringify(v))).map(([k]) => `${['en', 'es', 'ht'][i]} ${k}`));
ok('F5: no line of the editor\'s wording asks a person to check a translation', asksAPerson.length === 0, asksAPerson.join(', '));
ok('F6: the i18n domain keeps its vercel.json rewrite', /"source": "\/api\/i18n\/:rest\*",\s*"destination": "\/api\/i18n\/_\?subpath=:rest\*"/.test(read('../vercel.json')));

// ── N. the template's NAME ────────────────────────────────────────────────────────────────
const NAME = 'Floor Care Checklist';
const nameLabel = (name, i18n, lang) => safe(() => L.templateNameLabel(name, i18n, lang));
ok('N1: a template name shows its line for TODAY\'s name (machine or typed), else the English',
  typeof L?.templateNameLabel === 'function'
  && nameLabel(NAME, { es: { label: 'Lista de cuidado de pisos', en: NAME, source: 'machine' } }, 'es') === 'Lista de cuidado de pisos'
  && nameLabel(NAME, { es: { label: 'Vieja', en: 'Old name', source: 'machine' } }, 'es') === NAME
  && nameLabel(NAME, { es: { label: 'Lista de cuidado de pisos', en: NAME, source: 'machine' } }, 'en') === NAME
  && nameLabel(NAME, null, 'ht') === NAME);
ok('N2: …and a template ROW names itself the same way (templateNameOf reads its name_i18n)',
  typeof L?.templateNameOf === 'function'
  && safe(() => L.templateNameOf({ name: NAME, name_i18n: { ht: { label: 'Lis swen planche', en: NAME, source: 'machine' } } }, 'ht')) === 'Lis swen planche');
{
  const prev = { areas: [], nameI18n: { es: { label: 'Lista de cuidado de pisos', en: NAME, source: 'machine' } } };
  const kept = safe(() => L.sanitizeSchemaTranslations(prev, prev, { name: NAME }));
  const typed = safe(() => L.sanitizeSchemaTranslations(prev, { areas: [], nameI18n: { es: { label: 'Mi lista de pisos', en: NAME, source: 'machine', status: 'checked' } } }, { name: NAME }));
  ok('N3: the save cleans the name\'s lines like any other: an untouched machine line stays machine, a changed one is the office\'s own, no status',
    kept?.nameI18n?.es?.source === 'machine' && typed?.nameI18n?.es?.source === 'human' && !('status' in (typed?.nameI18n?.es || {})), JSON.stringify(typed?.nameI18n));
}
if (qcRoute && have && typeof L?.templateNameOf === 'function') {
  process.env.GOOGLE_TRANSLATE_API_KEY = KEY;
  // (A name with no protected noun, so the fake Google's line is predictable: "Checklist" in a name
  // is the term list's own word — test-i18n-terms.mjs holds that.)
  const NAME = 'Floor Care';
  const NT = (schema, extra = {}) => ({
    inspection_templates: [{ id: 'it_1', organization_id: ORG, name: NAME, kind: 'checklist', client_id: 'c1', is_published: false, published_version_id: null, ...extra }],
    inspection_template_versions: [{ id: 'v_1', template_id: 'it_1', version_number: 1, status: 'draft', schema }],
  });
  seed(NT(twoItems())); fakeGoogle();
  await call(qcRoute, { method: 'POST', subpath: 'templates/save', body: { id: 'it_1', name: NAME, schema: twoItems() } });
  const draft = version();
  ok('N4: the save translates the NAME into Spanish and Creole with the sections and items (its version carries it)',
    draft?.nameI18n?.es?.label === `ES«${NAME}»` && draft?.nameI18n?.ht?.en === NAME && draft?.nameI18n?.es?.source === 'machine', JSON.stringify(draft?.nameI18n));
  const pub = await call(qcRoute, { method: 'POST', subpath: 'templates/publish', body: { id: 'it_1' } });
  const row = (world.tables.inspection_templates || []).find((t) => t.id === 'it_1');
  ok('N5: publishing copies the name\'s lines onto the template row (what every list reads)', pub.status === 200
    && row?.name_i18n?.es?.label === `ES«${NAME}»`, JSON.stringify(row?.name_i18n));
  const got = await call(qcRoute, { subpath: 'templates/get', token: 'tok-crew', query: { id: 'it_1' } });
  const listed = await call(qcRoute, { subpath: 'templates/list', token: 'tok-own', query: { kind: 'checklist', clientId: 'c1' } });
  ok('N6: a CLEANER\'s read of the template names it in their language (row and published schema)',
    L.templateNameOf(got.body?.template, 'es') === `ES«${NAME}»` && L.templateNameLabel(got.body?.template?.name, got.body?.published?.schema?.nameI18n, 'ht') === `HT«${NAME}»`, JSON.stringify(got.body?.template).slice(0, 200));
  ok('N7: …and so does the template list (the clean\'s checklist card, the fill pickers)',
    L.templateNameOf((listed.body?.templates || [])[0], 'es') === `ES«${NAME}»`, JSON.stringify(listed.body).slice(0, 200));
  // A published template renamed in a draft: the draft carries the new name's line; the live row
  // keeps its own until Publish.
  fakeGoogle();
  await call(qcRoute, { method: 'POST', subpath: 'templates/save', body: { id: 'it_1', name: 'Floor Care Nightly', schema: twoItems() } });
  const liveRow = (world.tables.inspection_templates || []).find((t) => t.id === 'it_1');
  const draft2 = (world.tables.inspection_template_versions || []).filter((v) => v.template_id === 'it_1').sort((a, b) => b.version_number - a.version_number)[0];
  ok('N8: renamed in a draft of a live template: the draft carries the NEW name\'s line, the live name keeps its own',
    draft2?.status === 'draft' && draft2?.schema?.nameI18n?.es?.en === 'Floor Care Nightly' && liveRow?.name === NAME && L.templateNameOf(liveRow, 'es') === `ES«${NAME}»`,
    JSON.stringify({ draft: draft2?.schema?.nameI18n, row: liveRow?.name_i18n }));
  await call(qcRoute, { method: 'POST', subpath: 'templates/publish', body: { id: 'it_1' } });
  const after = (world.tables.inspection_templates || []).find((t) => t.id === 'it_1');
  ok('N9: …and at Publish the new name goes live with its line', after?.name === 'Floor Care Nightly' && L.templateNameOf(after, 'es') === 'ES«Floor Care Nightly»', JSON.stringify(after?.name_i18n));
  // The office's own line for the name stays while the name does.
  const own = JSON.parse(JSON.stringify(draft2.schema));
  own.nameI18n.es = { label: 'Pisos de noche', en: 'Floor Care Nightly', source: 'human' };
  fakeGoogle();
  await call(qcRoute, { method: 'POST', subpath: 'templates/save', body: { id: 'it_1', name: 'Floor Care Nightly', schema: own } });
  const kept = (world.tables.inspection_template_versions || []).filter((v) => v.template_id === 'it_1').sort((a, b) => b.version_number - a.version_number)[0];
  ok('N10: the office\'s own name line stays while the name does (and is not re-sent)', kept?.schema?.nameI18n?.es?.label === 'Pisos de noche'
    && kept?.schema?.nameI18n?.es?.source === 'human' && !google.sent.some((q) => q.endsWith('Floor Care Nightly')), JSON.stringify(kept?.schema?.nameI18n));
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  globalThis.fetch = BLOCKED;
} else {
  ok('N4: the name rules load (src/lib/checklistI18n templateNameOf)', false);
}
// Every place a cleaner (or the fill) reads a template's name, in the reader's language.
const crewPage = read('../src/pages/crew/CrewChecklist.jsx');
const cleanCard = read('../src/components/CleanChecklist.jsx');
const fill = read('../src/components/ChecklistFill.jsx');
const inspFill = read('../src/components/InspectionFill.jsx');
ok('N11: My Checklist names it in the reader\'s language (online and from the phone\'s copy)', /templateNameLabel\(/.test(crewPage));
ok('N12: the clean\'s checklist card names it so too (the cover line, the roster, a saved snapshot)', /templateNameOf\(/.test(cleanCard) && /templateNameLabel\(/.test(cleanCard));
ok('N13: the checklist fill\'s picker', /label: templateNameOf\(x, t\.lang\)/.test(fill));
ok('N14: the inspection fill\'s picker, its form and its "continue" card', /label: templateNameOf\(x, t\.lang\)/.test(inspFill) && /templateNameLabel\(snap\?\.name/.test(inspFill) && /resumableName/.test(inspFill));
ok('N15: the editor\'s Translations view lists the name first', /translations\.name/.test(read('../src/components/TemplateTranslations.jsx')));
const hubFiles = ['../src/lib/hubVisit.js', '../src/lib/hubDemo.js'].map(read).join('\n');
ok('N16: the customer hub keeps the English name (LANG-8)', !!hubFiles && !/templateNameOf|templateNameLabel/.test(hubFiles));
const mig = read('../../supabase/migrations/20261015120000_machine_translations.sql').replace(/--.*$/gm, '');
ok('N17: the template row\'s name_i18n is one nullable column, added (nothing narrowed)', /alter table public\.inspection_templates add column if not exists name_i18n jsonb;/.test(mig.replace(/\s+/g, ' ')));

// The demo story: Tomas reads his checklist's NAME in Spanish (data/demoTranslations + the seed).
let demoT = null;
try { demoT = await import('../src/data/demoTranslations.js'); } catch { /* reported below */ }
const floorName = 'Floor Care Checklist';
const demoNames = typeof demoT?.demoNameTranslations === 'function' ? demoT.demoNameTranslations(floorName) : null;
ok('N18: the demo\'s checklists carry their names\' lines (as a saved template does), on the row and the version',
  demoNames?.es?.en === floorName && demoNames?.es?.source === 'machine' && !!demoNames?.ht?.label
  && L.templateNameLabel(floorName, demoNames, 'es') !== floorName
  && /const nameI18n = demoNameTranslations\(name\);/.test(read('../src/data/demoStubs.js')) && /name_i18n: nameI18n/.test(read('../src/data/demoStubs.js')));

console.log(`\ntest-i18n-template-labels: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
