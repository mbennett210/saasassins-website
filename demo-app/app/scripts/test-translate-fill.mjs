// CS-851 / CS-850 — the FILL: the build's Spanish and Creole are translated before anyone opens the
// app, by the ops-alerts cron, at most once per build. Driven for real (api/_lib/translateFill.js,
// translateAll, the qc store's template read) with a fake Supabase and a FAKE Google:
//
//   F1. no key: nothing is asked or written;
//   F2. every owed app line, es and ht, is stored, and the build's fill row holds them, complete;
//   F3. the next run of the same build stops at that row (no Google call, nothing written);
//   F4. a published template saved before the rule gets its lines — only `schema` changes, by
//       adding lines: the English, the version number and the rest stay; a draft is not touched;
//       another org's template is not touched;
//   F5. CAS: a version re-published between the read and the write is left for the next run;
//   F6. idempotent: a new build over translated templates writes nothing to them;
//   F7. Google failing: the row is written incomplete, and the next run finishes it;
//   F8. the server's own renders read the filled lines at once (no restart);
//   F9. the cron runs it before its alerts and never on a dry run.
//
// Offline. Run: node scripts/test-translate-fill.mjs
import { readFileSync } from 'node:fs';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000613';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
const KEY = 'AIzaFAKE-fill-key-0123456789';
delete process.env.GOOGLE_TRANSLATE_API_KEY;
const BLOCKED = async (url) => { throw new Error(`network is blocked in this suite (${url})`); };
globalThis.fetch = BLOCKED;
installFakeSupabase();

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const read = (p) => { try { return readFileSync(new URL(p, import.meta.url), 'utf8'); } catch { return ''; } };

let F = null; let I = null;
try { F = await import('../api/_lib/translateFill.js'); } catch (e) { fails.push(`F0: api/_lib/translateFill.js loads — ${e.message}`); }
try { I = await import('../api/_lib/i18n.js'); } catch { /* reported by F0 */ }

const google = { calls: 0, sent: [] };
function fakeGoogle({ failAfter = Infinity } = {}) {
  google.calls = 0; google.sent = [];
  globalThis.fetch = async (_url, init) => {
    const req = JSON.parse(init.body);
    google.calls += 1;
    if (google.calls > failAfter) return { ok: false, status: 503, json: async () => ({}) };
    google.sent.push(...req.q);
    return { ok: true, status: 200, json: async () => ({ data: { translations: req.q.map((q) => ({ translatedText: `${req.target.toUpperCase()}«${q}»` })) } }) };
  };
}
const MOP = 'Mop the lobby floor';
const schemaOf = (i18n) => ({ areas: [{ id: 'a1', label: 'Lobby', siteAreaId: null, items: [{ id: 'i1', label: MOP, photoRequired: true, naAllowed: false, ...(i18n ? { i18n } : {}) }] }] });
const PUBLISHED_AT = '2026-10-04T12:00:00.000Z';
function seed(extra = {}) {
  resetWorld({
    tables: {
      machine_translations: [], machine_translation_fills: [],
      inspection_templates: [
        { id: 'it_pub', organization_id: ORG, name: 'Lobby nightly', kind: 'checklist', client_id: 'c1', is_published: true, published_version_id: 'v_pub', updated_at: '2026-10-04T12:00:00Z' },
        { id: 'it_draft', organization_id: ORG, name: 'Draft only', kind: 'checklist', client_id: 'c1', is_published: false, published_version_id: null, updated_at: '2026-10-04T12:00:00Z' },
        { id: 'it_other', organization_id: '00000000-0000-0000-0000-00000000dead', name: 'Not ours', kind: 'checklist', client_id: 'c9', is_published: true, published_version_id: 'v_other', updated_at: '2026-10-04T12:00:00Z' },
      ],
      inspection_template_versions: [
        { id: 'v_pub', template_id: 'it_pub', version_number: 3, status: 'published', published_at: PUBLISHED_AT, schema: schemaOf() },
        { id: 'v_draft', template_id: 'it_draft', version_number: 1, status: 'draft', published_at: null, schema: schemaOf() },
        { id: 'v_other', template_id: 'it_other', version_number: 1, status: 'published', published_at: PUBLISHED_AT, schema: schemaOf() },
      ],
      ...extra,
    },
  });
}
const v = (id) => world.tables.inspection_template_versions.find((x) => x.id === id);
const env = (deploy) => ({ ...process.env, GOOGLE_TRANSLATE_API_KEY: KEY, VERCEL_DEPLOYMENT_ID: deploy });
const quiet = (report) => (tag, err) => report.push(`${tag}:${err?.message}`);

if (F && I) {
  const owedEs = I.pendingFor('es');
  const owedHt = I.pendingFor('ht');
  const owedStrings = (owed) => owed.flatMap((p) => (typeof p.value === 'string' ? [p.value] : Object.values(p.value)));

  // F1 — no key
  seed(); fakeGoogle(); I.__resetStoredLines();
  const off = await F.fillTranslations({ env: { ...process.env, VERCEL_DEPLOYMENT_ID: 'dpl_1' } });
  ok('F1: with no key the fill asks no one and writes nothing', off.skipped === 'off' && google.calls === 0
    && world.tables.machine_translations.length === 0 && world.tables.machine_translation_fills.length === 0, JSON.stringify(off));

  // F2 — a first run
  seed(); fakeGoogle(); I.__resetStoredLines();
  const reports = [];
  const first = await F.fillTranslations({ env: env('dpl_1'), report: quiet(reports) });
  const stored = world.tables.machine_translations;
  const { pinnedLineFor } = await import('../src/i18n/terms.js');
  const { SOURCE_CATALOG } = await import('../src/i18n/core.js');
  const unique = (lang, owed) => new Set(owedStrings(owed).filter((s) => !pinnedLineFor(lang, s, SOURCE_CATALOG))).size;
  const appRows = (lang, owed) => { const want = new Set(owedStrings(owed)); return stored.filter((r) => r.lang === lang && want.has(r.english)).length; };
  ok('F2a: every owed app line is stored once, Spanish and Creole (beside the template\'s own lines)', appRows('es', owedEs) === unique('es', owedEs)
    && appRows('ht', owedHt) === unique('ht', owedHt) && stored.length === unique('es', owedEs) + unique('ht', owedHt) + 6,
    `${stored.length} rows; want ${unique('es', owedEs)} + ${unique('ht', owedHt)} + 6 template lines (its section, item and name, in two languages)`);
  const fill = world.tables.machine_translation_fills;
  ok('F2b: the build\'s fill row holds every owed line, assembled, and says it is complete', fill.length === 1 && fill[0].complete === true
    && Object.keys(fill[0].lines.es || {}).length === owedEs.length && Object.keys(fill[0].lines.ht || {}).length === owedHt.length, JSON.stringify(first).slice(0, 300));
  ok('F2c: its key is this build (the deployment and what it owes)', fill[0]?.build_id === I.fillBuildId(env('dpl_1')) && fill[0].build_id.startsWith('dpl_1:'));

  // F4 — the templates
  const pub = v('v_pub');
  ok('F4a: the published template saved before the rule now has its Spanish and Creole lines', pub.schema.areas[0].items[0].i18n?.es?.label === `ES«${MOP}»`
    && pub.schema.areas[0].i18n?.ht?.source === 'machine' && pub.schema.areas[0].items[0].i18n?.ht?.en === MOP, JSON.stringify(pub.schema));
  ok('F4b: …its English, its version number, its status and its other fields untouched', pub.version_number === 3 && pub.status === 'published'
    && pub.published_at === PUBLISHED_AT && pub.schema.areas[0].items[0].label === MOP && pub.schema.areas[0].items[0].photoRequired === true);
  ok('F4c: a draft is left to its next save', !v('v_draft').schema.areas[0].items[0].i18n);
  ok('F4d: another organization\'s template is never read or written', !v('v_other').schema.areas[0].items[0].i18n);
  ok('F4e: the result counts it', first.templates?.filled === 1 && first.templates?.complete === true && first.complete === true, JSON.stringify(first.templates));
  const pubRow = world.tables.inspection_templates.find((t) => t.id === 'it_pub');
  ok('F4f: its NAME gets its lines too — on the version and on the row every list reads (CAS on the name)',
    pub.schema.nameI18n?.es?.label === 'ES«Lobby nightly»' && pub.schema.nameI18n?.ht?.en === 'Lobby nightly'
    && pubRow?.name_i18n?.es?.label === 'ES«Lobby nightly»' && pubRow?.name === 'Lobby nightly', JSON.stringify({ v: pub.schema.nameI18n, row: pubRow?.name_i18n }));

  // F3 — once per build
  fakeGoogle();
  const logFrom = world.log.length;
  const again = await F.fillTranslations({ env: env('dpl_1') });
  const ran = world.log.slice(logFrom);
  ok('F3: the next run of the same build stops at its fill row: no Google, one read, nothing written', again.skipped === 'done' && google.calls === 0
    && ran.length === 1 && ran[0].table === 'machine_translation_fills' && ran[0].op === 'select', JSON.stringify(ran));

  // F6 — a new build over translated templates: nothing to write to them
  fakeGoogle();
  const logFrom2 = world.log.length;
  const next = await F.fillTranslations({ env: env('dpl_2') });
  const writes = world.log.slice(logFrom2).filter((q) => q.table === 'inspection_template_versions' && q.op === 'update');
  ok('F6: a new build re-checks, finds the lines stored and the templates translated: no Google call, no template written',
    next.complete === true && google.calls === 0 && writes.length === 0, JSON.stringify({ calls: google.calls, writes: writes.length }));
  ok('F6b: …and the old build\'s row is kept (it is fresh) beside the new one', world.tables.machine_translation_fills.length === 2);

  // F5 — CAS
  seed(); fakeGoogle(); I.__resetStoredLines();
  world.beforeQuery = async (q) => {
    if (q.table === 'inspection_template_versions' && q.op === 'update') {
      const row = v('v_pub');
      if (row.published_at === PUBLISHED_AT) row.published_at = '2026-10-15T09:00:00.000Z';   // re-published in between
    }
  };
  const raced = await F.fillTranslations({ env: env('dpl_3') });
  world.beforeQuery = null;
  ok('F5a: a version re-published between the read and the write is not overwritten', !v('v_pub').schema.areas[0].items[0].i18n);
  ok('F5b: …and the build is not marked complete, so the next run fills it', raced.complete === false && world.tables.machine_translation_fills[0]?.complete === false);
  const retry = await F.fillTranslations({ env: env('dpl_3') });
  ok('F5c: the next run reads it afresh and fills it', retry.complete === true && v('v_pub').schema.areas[0].items[0].i18n?.es?.source === 'machine');

  // F7 — Google failing part-way
  seed(); I.__resetStoredLines(); fakeGoogle({ failAfter: 1 });
  const broken = await F.fillTranslations({ env: env('dpl_4'), report: () => {} });
  ok('F7a: Google failing part-way: the row is written, incomplete', broken.complete === false && world.tables.machine_translation_fills[0]?.complete === false);
  fakeGoogle();
  const healed = await F.fillTranslations({ env: env('dpl_4'), report: () => {} });
  ok('F7b: the next run finishes it (and asks Google only for what is still missing)', healed.complete === true
    && google.sent.length < owedStrings(owedEs).length + owedStrings(owedHt).length, `${google.sent.length} sent`);

  // F8 — the server renders with them at once
  const { translate } = await import('../src/i18n/core.js');
  const key = owedEs.find((p) => typeof p.value === 'string' && !/\{/.test(p.value))?.key;
  ok('F8: right after the fill, this server renders the filled line (no restart)', !!key && translate('es', key).startsWith('ES«'), `${key}: ${key && translate('es', key)}`);

  // budget
  seed(); I.__resetStoredLines(); fakeGoogle();
  const late = await F.fillTranslations({ env: env('dpl_5'), budgetMs: -1, report: () => {} });
  ok('F10: out of time before it starts, it stops and leaves the build incomplete (Google not asked)', late.complete === false && google.calls === 0);
  delete process.env.GOOGLE_TRANSLATE_API_KEY;
  globalThis.fetch = BLOCKED;
}

// F9 — the cron runs it, before its alerts, never on a dry run
const cron = read('../api/cron/ops-alerts.js');
ok('F9: the ops-alerts cron fills the translations before it raises alerts, and never on a dry run',
  /if \(!dryRun\) \{\s*try \{ translations = await fillTranslations\(\); \}/.test(cron)
  && cron.indexOf('await fillTranslations()') < cron.indexOf('const out = await run(dryRun)'));

console.log(`\ntest-translate-fill: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
