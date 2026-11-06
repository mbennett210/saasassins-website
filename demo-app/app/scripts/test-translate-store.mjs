// CS-851 / CS-850 — the translation STORE: the server translates every Spanish and Creole line
// itself, once per (language, exact English), and serves it from the store after that. No person
// approves anything. Driven for real with a fake Supabase and a FAKE Google (never the real API):
//
//   M. the migration (static): one row per (lang, sha256), RLS on with no policies, browsers
//      revoked, service_role cut back to select + insert; the fill marker beside it;
//   S. translateAll: one Google request per line ever (the second ask is the store's), a repeat
//      inside one call sent once, concurrent calls sharing one request; the write is
//      `on conflict do nothing`, so a line another caller stored first never fails the call;
//      placeholders and tags travel as tokens and come back exact (a lost token = no line, never
//      a broken one); a pinned line never reaches Google; with no key only the store answers;
//      on a Google error the line stays English and the error is reported as a CODE — the key in
//      no log line, no report and no answer.
//
// Offline. Run: node scripts/test-translate-store.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000611';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
const KEY = 'AIzaFAKE-store-key-0123456789';
delete process.env.GOOGLE_TRANSLATE_API_KEY;
globalThis.fetch = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
installFakeSupabase();

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };

// ── M. the migration ──────────────────────────────────────────────────────────────────────
const dir = new URL('../../supabase/migrations/', import.meta.url);
const NAME = '20261015120000_machine_translations.sql';
const raw = readdirSync(dir).includes(NAME) ? readFileSync(new URL(NAME, dir), 'utf8').replace(/\r\n/g, '\n') : '';
const code = raw.replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase();
ok(`M1: ${NAME} exists`, !!raw);
ok('M2: purpose / expand|contract / forward-fix / verified-on header, NOT APPLIED',
  /^-- purpose:/m.test(raw) && /^-- expand\|contract: expand/m.test(raw) && /^-- forward-fix:/m.test(raw) && /^-- verified-on: NOT APPLIED/m.test(raw));
ok('M3: lock and statement timeouts', /set lock_timeout = '3s';/.test(raw) && /set statement_timeout = '60s';/.test(raw));
ok('M4: one row per (lang, sha256 hex of the English), Spanish and Creole only',
  /create table if not exists public\.machine_translations \(/.test(code)
  && /lang text not null check \(lang in \('es', 'ht'\)\)/.test(code)
  && /source_hash text not null check \(source_hash ~ '\^\[0-9a-f\]\{64\}\$'\)/.test(code)
  && /english text not null/.test(code) && /translation text not null/.test(code)
  && /created_at timestamptz not null default now\(\)/.test(code)
  && /primary key \(lang, source_hash\)/.test(code));
ok('M5: the house law — RLS on, no policies, anon/authenticated revoked, service_role select + insert only',
  /alter table public\.machine_translations enable row level security;/.test(code)
  && /revoke all on public\.machine_translations from anon, authenticated;/.test(code)
  && /revoke update, delete, truncate, trigger, references on public\.machine_translations from service_role;/.test(code)
  && /grant select, insert on public\.machine_translations to service_role;/.test(code)
  && !/create policy/.test(code) && !/grant [a-z, ]* on public\.machine_translations to (anon|authenticated|public)/.test(code));
ok('M6: the fill — one row per build with its lines and whether it finished, service-role only (select, insert, update: its upsert; delete: its retention)',
  /create table if not exists public\.machine_translation_fills \( build_id text primary key/.test(code)
  && /lines jsonb not null default '\{\}'::jsonb/.test(code) && /complete boolean not null default false/.test(code)
  && /alter table public\.machine_translation_fills enable row level security;/.test(code)
  && /revoke all on public\.machine_translation_fills from anon, authenticated;/.test(code)
  && /grant select, insert, update, delete on public\.machine_translation_fills to service_role;/.test(code));
ok('M7: nothing existing is narrowed or dropped — the one change to an existing table is a nullable column (the template row\'s name lines)',
  !/alter table public\.(?!machine_translation|inspection_templates add column if not exists name_i18n jsonb;)/.test(code)
  && /alter table public\.inspection_templates add column if not exists name_i18n jsonb;/.test(code) && !/drop /.test(code));

// ── S. translateAll ───────────────────────────────────────────────────────────────────────
let S = null; let terms = null;
try { S = await import('../api/_lib/translateStore.js'); } catch (e) { fails.push(`S0: api/_lib/translateStore.js loads — ${e.message}`); }
try { terms = await import('../src/i18n/terms.js'); } catch { /* reported below */ }
const reports = [];
const report = (tag, err, extra = {}) => reports.push({ tag, message: err?.message, extra: JSON.stringify(extra) });
const google = { calls: [] };
// A fake Google: records every request; answers each line "ES«…»" (or what `answer` says).
function fakeGoogle({ status = 200, answer = (q) => `ES«${q}»`, body = null } = {}) {
  google.calls = [];
  globalThis.fetch = async (url, init) => {
    const req = init?.body ? JSON.parse(init.body) : null;
    google.calls.push({ url: String(url), headers: init?.headers || {}, body: req });
    const payload = body || { data: { translations: (req?.q || []).map((q) => ({ translatedText: answer(q, req.target) })) } };
    return { ok: status >= 200 && status < 300, status, json: async () => payload };
  };
}
const sent = () => google.calls.flatMap((c) => c.body?.q || []);
const rows = () => world.tables.machine_translations || [];
const fresh = (tables = {}) => { resetWorld({ tables: { machine_translations: [], ...tables } }); reports.length = 0; };
const T = (lang, list, opts = {}) => S.translateAll(lang, list, { report, ...opts });

if (S) {
  process.env.GOOGLE_TRANSLATE_API_KEY = KEY;
  const MOP = 'Mop the lobby floor';
  const DUST = 'Dust the front desk';

  // S1: once per line, ever
  fresh(); fakeGoogle();
  const first = await T('es', [MOP, DUST, MOP]);
  ok('S1a: every line answered, a repeat in one call sent ONCE', first[0] === `ES«${MOP}»` && first[1] === `ES«${DUST}»` && first[2] === first[0]
    && sent().length === 2, JSON.stringify({ first, sent: sent() }));
  ok('S1b: each line stored once, keyed by lang + sha256 of the exact English, with its English',
    rows().length === 2 && rows().every((r) => r.lang === 'es' && /^[0-9a-f]{64}$/.test(r.source_hash) && typeof r.english === 'string')
    && rows().some((r) => r.source_hash === S.sha256Hex(MOP) && r.english === MOP && r.translation === `ES«${MOP}»`), JSON.stringify(rows()));
  fakeGoogle();
  const second = await T('es', [DUST, MOP]);
  ok('S1c: asked again, the store answers — Google is not asked at all', google.calls.length === 0
    && second[0] === `ES«${DUST}»` && second[1] === `ES«${MOP}»`, JSON.stringify({ second, calls: google.calls.length }));
  fakeGoogle();
  const ht = await T('ht', [MOP]);
  ok('S1d: a language is its own row (Creole is asked for once, too)', ht[0] === `ES«${MOP}»` && google.calls.length === 1
    && google.calls[0].body?.target === 'ht' && rows().filter((r) => r.lang === 'ht').length === 1);

  // S2: the write is conflict-safe
  const upserts = world.log.filter((q) => q.table === 'machine_translations' && q.op === 'upsert');
  ok('S2a: the write is an upsert that does nothing on conflict (no update path at all)', upserts.length > 0
    && !world.log.some((q) => q.table === 'machine_translations' && (q.op === 'update' || q.op === 'delete')));
  ok('S2b: …on the table\'s own key, lang + source_hash', S.STORE_CONFLICT === 'lang,source_hash');
  {
    // Another caller stores the same line between this call's read and its write.
    fresh(); fakeGoogle({ answer: (q) => `MINE«${q}»` });
    world.beforeQuery = async (q) => {
      if (q.table === 'machine_translations' && q.op === 'upsert' && !rows().length) {
        rows().push({ lang: 'es', source_hash: S.sha256Hex(MOP), english: MOP, translation: 'THEIRS' });
      }
    };
    let threw = null; let got = null;
    try { got = await T('es', [MOP]); } catch (e) { threw = e; }
    world.beforeQuery = null;
    ok('S2c: a line another caller stored first does not fail this call', !threw && got?.[0] === `MINE«${MOP}»`, String(threw?.message || JSON.stringify(got)));
    ok('S2d: …and the first row stands (do nothing, never overwrite)', rows().length === 1 && rows()[0].translation === 'THEIRS', JSON.stringify(rows()));
  }

  // S3: placeholders and tags travel as tokens, and come back exact
  {
    fresh();
    const LINE = 'Clocked in at {start, time} for {customer}: <b>{count} left</b>';
    fakeGoogle({ answer: (q) => q.replace('Clocked in at', 'Entrada a las').replace('for', 'para').replace('left', 'pendientes') });
    const [out] = await T('es', [LINE]);
    const q = sent()[0] || '';
    ok('S3a: Google sees numbered tokens, never a placeholder name or a tag', /\{0\}/.test(q) && !/customer|start|count|<b>|<\/b>/.test(q), q);
    ok('S3b: the line comes back with EXACTLY the English placeholders and tags',
      out === 'Entrada a las {start, time} para {customer}: <b>{count} pendientes</b>', out);
    fresh();
    fakeGoogle({ answer: (q) => q.replace(/\{1\}/, '') });
    const [lost] = await T('es', [LINE]);
    ok('S3c: a token Google dropped = no line (null, so the English shows), and nothing stored', lost === null && rows().length === 0, JSON.stringify({ lost, rows: rows() }));
    ok('S3d: …reported as a code, with no text', reports.some((r) => r.tag === 'i18n.machine-placeholders') && reports.every((r) => !r.extra.includes('Clocked')));
    fresh();
    fakeGoogle({ answer: (q) => `${q} {0}` });
    const [doubled] = await T('es', [LINE]);
    ok('S3e: a doubled token is refused the same way', doubled === null);
    fresh();
    fakeGoogle({ answer: (q) => q.replace('{3}', '{9}') });
    const [invented] = await T('es', [LINE]);
    ok('S3f: a token Google invented is refused the same way', invented === null);
    fresh(); fakeGoogle();
    const [plain] = await T('es', ['{count}']);
    ok('S3g: a line with nothing to read (only a placeholder) is never sent, and comes back as it is', plain === '{count}' && google.calls.length === 0);
  }

  // S4: plural forms are lines like any other; each form is translated whole
  {
    fresh(); fakeGoogle({ answer: (q) => q.replace('clean', 'limpieza').replace('cleans', 'limpiezas') });
    const out = await T('es', ['{count} clean', '{count} cleans']);
    ok('S4: each plural form comes back with its placeholder', out[0] === '{count} limpieza' && out[1]?.startsWith('{count} limpieza'), JSON.stringify(out));
  }

  // S5: a Google error — the line stays English, the error is a code, the key is nowhere
  {
    fresh();
    const logs = [];
    const keep = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
    const quiet = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = keep;
    fakeGoogle({ status: 403, body: { error: { message: `API key not valid. (${KEY})` } } });
    let out;
    try { out = await S.translateAll('es', [MOP, DUST]); } finally { Object.assign(console, quiet); }
    ok('S5a: on a Google error every line answers null (the English shows) and nothing throws', Array.isArray(out) && out.every((x) => x === null));
    ok('S5b: nothing is stored', rows().length === 0);
    ok('S5c: the failure is reported (the default reporter: a structured [ALERT] line) as a code', logs.some((l) => l.includes('i18n.translate') && l.includes('machine-translation-refused')), logs.join(' | '));
    ok('S5d: the key is in no log line, and Google\'s own words are not passed on', logs.every((l) => !l.includes(KEY) && !l.includes('API key not valid')), logs.join(' | '));
    fakeGoogle();
    const after = await T('es', [MOP]);
    ok('S5e: the next ask tries Google again (a failure is not stored)', after[0] === `ES«${MOP}»` && google.calls.length === 1);
    ok('S5f: the key travels ONLY in Google\'s header', google.calls[0]?.headers?.['X-Goog-Api-Key'] === KEY && !google.calls[0]?.url.includes(KEY)
      && !JSON.stringify(google.calls[0]?.body).includes(KEY));
  }

  // S6: no key — the store answers what it has, Google is never asked
  {
    fresh({ machine_translations: [{ lang: 'es', source_hash: S.sha256Hex(MOP), english: MOP, translation: 'Trapear el piso del vestíbulo' }] });
    delete process.env.GOOGLE_TRANSLATE_API_KEY;
    fakeGoogle();
    const out = await T('es', [MOP, DUST]);
    ok('S6: with no key the stored line answers, the rest stay English, Google is never asked',
      out[0] === 'Trapear el piso del vestíbulo' && out[1] === null && google.calls.length === 0, JSON.stringify(out));
    process.env.GOOGLE_TRANSLATE_API_KEY = KEY;
  }

  // S7: two calls at once share one request per line
  {
    fresh();
    let release;
    const gate = new Promise((r) => { release = r; });
    google.calls = [];
    globalThis.fetch = async (url, init) => {
      const req = JSON.parse(init.body);
      google.calls.push({ url: String(url), headers: init.headers, body: req });
      await gate;
      return { ok: true, status: 200, json: async () => ({ data: { translations: req.q.map((q) => ({ translatedText: `ES«${q}»` })) } }) };
    };
    const a = T('es', [MOP]);
    const b = T('es', [MOP]);
    await new Promise((r) => setTimeout(r, 30));
    release();
    const [ra, rb] = await Promise.all([a, b]);
    ok('S7: two concurrent asks for one line make ONE Google request and both get the line',
      google.calls.length === 1 && ra[0] === `ES«${MOP}»` && rb[0] === `ES«${MOP}»`, JSON.stringify({ calls: google.calls.length, ra, rb }));
  }

  // S8: a pinned line is the term list's own, never Google's
  {
    fresh(); fakeGoogle();
    const { SOURCE_CATALOG } = await import('../src/i18n/core.js');
    const english = SOURCE_CATALOG['clock.in'];
    const [es] = await T('es', [english]);
    const [htLine] = await T('ht', [english]);
    ok('S8: "Clock in" is TERM_LINES\' line in each language, and Google is not asked',
      !!terms && es === terms.TERM_LINES.es['clock.in'] && htLine === terms.TERM_LINES.ht['clock.in'] && google.calls.length === 0, JSON.stringify({ es, htLine }));
  }

  // S9: bounds — out of time, nothing is sent; a line too long is never sent; a bad language answers nothing
  {
    fresh(); fakeGoogle();
    const late = await T('es', [MOP], { deadline: Date.now() - 1 });
    const long = await T('es', ['x'.repeat(S.MAX_ENGLISH_CHARS + 1)]);
    const fr = await T('fr', [MOP]);
    ok('S9: past the deadline, over the length, or a language we do not speak: null, and Google is not asked',
      late[0] === null && long[0] === null && fr[0] === null && google.calls.length === 0);
  }
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
}

console.log(`\ntest-translate-store: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
