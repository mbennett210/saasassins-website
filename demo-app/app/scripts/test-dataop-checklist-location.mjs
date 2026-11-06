// The LIVE data-op that files every checklist under its customer (R2) —
// `app/scripts/dataop-checklist-location.mjs`. Migration `20260928120000` adds
// `inspection_templates.client_id` and deliberately carries NO backfill; this op is the
// one-time conversion, run AFTER the code deploys (the new reads filter on client_id, so a
// row converted before the deploy would simply be invisible to the old ones).
//
// WHAT IT DOES, per checklist template:
//   · picked by NOBODY                      → left alone (it is a starter);
//   · picked at exactly one customer        → stamped with that customer;
//   · picked at several                     → the first (in blob order) is stamped, every
//                                             other customer gets its own COPY and has its
//                                             picks re-pointed at it;
//   · already filed under X but picked at Y → X is never moved; Y gets a copy and is
//                                             re-pointed.
// A copy's slug is DETERMINISTIC, so a re-run finds the copy instead of making a second one,
// and a re-run with nothing left to do is a true no-op.
//
// This suite is OFFLINE: the pure halves on fixtures, the §8.2 guard contract read
// mechanically off the source, and the whole op end to end on FAKES OF BOTH TRANSPORTS
// (Postgres and PostgREST). It never opens a connection — the script's live section is
// behind an `import.meta.url === argv[1]` main guard, so importing it here runs nothing.
// ⚠️ The script itself is NEVER run against production without the owner's recorded go.
//
// Failing-first by construction: pre-fix the module does not exist, so the import throws.
//
// Run: node app/scripts/test-dataop-checklist-location.mjs
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  OP_NAME, PROD_REF, ENV_DEFAULT, ENV_PROD, TEMPLATE_KIND, TEMPLATE_SELECT, VERSION_SELECT,
  copySlug, holdersByTemplate, planChecklistLocationOp, applyRepoints,
  pgTransport, supabaseTransport, runChecklistLocationOp,
} from './dataop-checklist-location.mjs';
import { MAX_STATE_BYTES } from '../api/_lib/blobBudget.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(HERE, 'dataop-checklist-location.mjs'), 'utf8');
const GUARD = readFileSync(path.join(HERE, '_lib', 'liveGuard.mjs'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1; else { fail += 1; console.error(`  ✗ ${name}\n      got : ${g}\n      want: ${w}`); }
};

// ── fixtures ─────────────────────────────────────────────────────────────────
const ORG_FIX = '00000000-0000-0000-0000-0000000000ab';
const ONE = { areas: [{ id: 'a', label: 'A', items: [{ id: 'i1', label: 'Sweep' }] }] };
const TWO = { areas: [{ id: 'a', label: 'A', items: [{ id: 'i1', label: 'Sweep' }, { id: 'i2', label: 'Mop' }] }] };
const NONE = { areas: [] };

const fixtureClients = () => [
  { id: 'cl_bay', name: 'Coral Bay HOA', crewChecklists: { u_andre: 'it_floor', u_tomas: 'it_shared' } },
  { id: 'cl_olas', name: 'Las Olas', crewChecklists: { u_luis: 'it_shared', u_kei: 'it_shared' } },
  { id: 'cl_lake', name: 'Lakeside', crewChecklists: { u_priya: 'it_elsewhere' } },
  { id: 'cl_quiet', name: 'Quiet St' },
];
// In ID ORDER, because that is the order BOTH transports read them in (`order by id` /
// `.order('id')`) — the op's output is then a function of the data, not of a page's luck.
const SCALE = { type: 'passfail', passThreshold: 100 };
const fixtureTemplates = () => [
  { id: 'it_elsewhere', organization_id: ORG_FIX, kind: 'checklist', client_id: 'cl_bay', name: 'Deep clean', slug: 's4', rating_scale: SCALE, is_published: false, published_version_id: null },
  { id: 'it_floor', organization_id: ORG_FIX, kind: 'checklist', client_id: null, name: 'Floor care', slug: 's1', rating_scale: SCALE, is_published: true, published_version_id: 'v_floor' },
  { id: 'it_shared', organization_id: ORG_FIX, kind: 'checklist', client_id: null, name: 'Nightly', slug: 's2', rating_scale: SCALE, is_published: true, published_version_id: 'v_shared' },
  { id: 'it_start', organization_id: ORG_FIX, kind: 'checklist', client_id: null, name: 'Close-out', slug: 's3', rating_scale: SCALE, is_published: true, published_version_id: 'v_start' },
];
const fixtureVersions = () => [
  { id: 'v_floor', template_id: 'it_floor', version_number: 1, schema: ONE, status: 'published' },
  { id: 'v_shared', template_id: 'it_shared', version_number: 1, schema: TWO, status: 'published' },
  { id: 'v_shared_draft', template_id: 'it_shared', version_number: 2, schema: NONE, status: 'draft' },
  { id: 'v_start', template_id: 'it_start', version_number: 1, schema: ONE, status: 'published' },
  { id: 'v_else', template_id: 'it_elsewhere', version_number: 1, schema: TWO, status: 'draft' },
];

const SHARED_TO_OLAS = copySlug('it_shared', 'cl_olas');
const ELSE_TO_LAKE = copySlug('it_elsewhere', 'cl_lake');

// ── who picks what ───────────────────────────────────────────────────────────
{
  const holders = holdersByTemplate(fixtureClients());
  eq('every customer that picks a checklist, in blob order',
    [...holders.entries()].map(([t, cs]) => `${t}:${cs.join('+')}`),
    ['it_floor:cl_bay', 'it_shared:cl_bay+cl_olas', 'it_elsewhere:cl_lake']);
  eq('a customer picking the same checklist for two cleaners is listed ONCE',
    holders.get('it_shared'), ['cl_bay', 'cl_olas']);
  eq('a customer with no picks appears nowhere', holders.has('cl_quiet'), false);
  eq('nullish input is empty, never a crash', [...holdersByTemplate(null).keys()], []);
}

// ── the plan ─────────────────────────────────────────────────────────────────
const plan = planChecklistLocationOp({ clients: fixtureClients(), templates: fixtureTemplates() });
{
  eq('BEFORE: 4 checklists, 3 of them unfiled, and 4 picks land on a checklist that is not that customer\'s',
    plan.before, { checklists: 4, starters: 3, filed: 1, misplacedPicks: 4, assignments: 5 });
  eq('AFTER: two copies exist, nothing is unfiled but the starter, and no pick is misplaced',
    plan.after, { checklists: 6, starters: 1, filed: 5, misplacedPicks: 0, assignments: 5 });

  eq('STAMPED: a checklist picked at exactly one customer is stamped with it',
    plan.stamps.map((s) => `${s.templateId}->${s.clientId}`),
    ['it_floor->cl_bay', 'it_shared->cl_bay']);
  ok(!plan.stamps.some((s) => s.templateId === 'it_elsewhere'),
    'NEVER MOVED: a checklist already filed under a customer keeps that customer');
  ok(!plan.stamps.some((s) => s.templateId === 'it_start'),
    'STARTER: a checklist nobody picks is left alone');

  eq('COPIED: every other customer that picks it gets its own copy, on a deterministic slug',
    plan.copies.map((c) => `${c.sourceTemplateId}->${c.clientId}:${c.slug}`),
    [`it_elsewhere->cl_lake:${ELSE_TO_LAKE}`, `it_shared->cl_olas:${SHARED_TO_OLAS}`]);
  eq('COPIED: a copy is named after its source', plan.copies.map((c) => c.name), ['Deep clean', 'Nightly']);

  eq('RE-POINTED: every pick at a copied-for customer moves to the copy',
    plan.repoints.map((r) => `${r.clientId}/${r.userId}:${r.fromTemplateId}->${r.toSlug}`),
    [`cl_lake/u_priya:it_elsewhere->${ELSE_TO_LAKE}`,
      `cl_olas/u_luis:it_shared->${SHARED_TO_OLAS}`, `cl_olas/u_kei:it_shared->${SHARED_TO_OLAS}`]);
  ok(!plan.repoints.some((r) => r.clientId === 'cl_bay'),
    'RE-POINTED: the customer the row is stamped with keeps pointing at the original');
  ok(plan.changed === true, 'the plan reports there is work to do');

  eq('a deterministic slug is a function of the source and the customer only',
    [copySlug('it_shared', 'cl_olas'), copySlug('it_shared', 'cl_olas')], [SHARED_TO_OLAS, SHARED_TO_OLAS]);
  ok(copySlug('it_shared', 'cl_olas') !== copySlug('it_shared', 'cl_lake'), '…and differs per customer');
}

// ── applying the re-points, and IDEMPOTENCE ──────────────────────────────────
{
  const idBySlug = new Map([[SHARED_TO_OLAS, 'it_copy_a'], [ELSE_TO_LAKE, 'it_copy_b']]);
  const next = applyRepoints(fixtureClients(), plan.repoints, idBySlug);
  eq('the re-pointed customers now name their own copy',
    next.map((c) => `${c.id}:${Object.entries(c.crewChecklists || {}).map(([u, t]) => `${u}=${t}`).join(',')}`),
    ['cl_bay:u_andre=it_floor,u_tomas=it_shared', 'cl_olas:u_luis=it_copy_a,u_kei=it_copy_a',
      'cl_lake:u_priya=it_copy_b', 'cl_quiet:']);
  eq('the pick COUNT never changes — nobody gains or loses a checklist',
    next.reduce((n, c) => n + Object.keys(c.crewChecklists || {}).length, 0), 5);
  ok(applyRepoints(fixtureClients(), [], new Map())[0] === fixtureClients()[0]
    || JSON.stringify(applyRepoints(fixtureClients(), [], new Map())) === JSON.stringify(fixtureClients()),
    'no re-points leaves the customers untouched');
  let threw = false;
  try { applyRepoints(fixtureClients(), plan.repoints, new Map()); } catch { threw = true; }
  ok(threw, 'a slug with no template id THROWS rather than leave a pick on the source');

  // the converted world: stamps applied, copies inserted, picks re-pointed
  const nextTemplates = [
    ...fixtureTemplates().map((t) => {
      const s = plan.stamps.find((x) => x.templateId === t.id);
      return s ? { ...t, client_id: s.clientId } : t;
    }),
    { id: 'it_copy_a', kind: 'checklist', client_id: 'cl_olas', name: 'Nightly', slug: SHARED_TO_OLAS, is_published: true, published_version_id: 'vc_a' },
    { id: 'it_copy_b', kind: 'checklist', client_id: 'cl_lake', name: 'Deep clean', slug: ELSE_TO_LAKE, is_published: false, published_version_id: null },
  ];
  const rerun = planChecklistLocationOp({ clients: next, templates: nextTemplates });
  ok(rerun.changed === false, 'IDEMPOTENT: a re-run has nothing to do');
  eq('IDEMPOTENT: no stamps, no copies, no re-points',
    [rerun.stamps.length, rerun.copies.length, rerun.repoints.length], [0, 0, 0]);
  eq('IDEMPOTENT: before === after on a re-run', rerun.before, rerun.after);
  eq('IDEMPOTENT: the converted census is the one the first run projected', rerun.before, plan.after);

  eq('a blob nobody has assigned anything in is a no-op (PRODUCTION today: 0 assignments)',
    planChecklistLocationOp({ clients: [{ id: 'c', crewChecklists: {} }], templates: fixtureTemplates() }).changed, false);
  eq('nullish input is a no-op, never a crash', planChecklistLocationOp().changed, false);
  eq('an INSPECTION template is never touched, even if something names it',
    planChecklistLocationOp({
      clients: [{ id: 'c', crewChecklists: { u: 'it_insp' } }],
      templates: [{ id: 'it_insp', kind: 'inspection', client_id: null, name: 'Walk' }],
    }).changed, false);
}

// ── the §8.2 guard contract ──────────────────────────────────────────────────
{
  eq('the op names itself for the provenance stamp', OP_NAME, 'dataop-checklist-location');
  eq('the production ref is the one §8.2 names', PROD_REF, 'nvsbknowpkmhrzbkcwxs');
  eq('the default env is the sandbox, not production', ENV_DEFAULT, '../.env.sandbox.local');
  eq('production env is only reached deliberately', ENV_PROD, '../.env.local');
  eq('it converts CHECKLIST templates only', TEMPLATE_KIND, 'checklist');

  ok(/APPLY\s*=\s*process\.argv\.includes\('--apply'\)/.test(SRC), 'G1: dry run is the DEFAULT (an --apply opt-in, never a --dry-run opt-out)');
  ok(!/includes\('--dry-run'\)/.test(SRC), 'G1: not one of the write-by-default scripts (§8.1)');
  ok(/from '\.\/_lib\/liveGuard\.mjs'/.test(SRC) && /refuseTarget/.test(SRC),
    'G3: it runs the SHARED guard, not a second copy of it');
  ok(/CONFIRM_PROD/.test(GUARD) && /CONFIRM_PROD[^\n]*PROD_REF|PROD_REF[^\n]*CONFIRM_PROD/.test(GUARD),
    'G3: …which requires CONFIRM_PROD to equal the prod ref');
  ok(/--prod/.test(SRC), 'G3: production needs an explicit --prod');
  ok(/orgstate-backup-/.test(SRC), 'G4: the pre-write backup lands on the gitignored orgstate-backup-* pattern');
  ok(new RegExp(`updated_via[^\\n]*script:\\$\\{OP_NAME\\}`).test(SRC), 'G5: the write stamps script provenance in updated_via');
  ok(/\.eq\('version',\s*baseVersion\)/.test(SRC) || /and version = \$/.test(SRC), 'CAS: the version predicate rides ON the update');
  ok(/import\.meta\.url/.test(SRC) && /process\.argv\[1\]/.test(SRC), 'the live section is behind a main-module guard, so importing it is inert');
  ok(/import \{ MAX_STATE_BYTES \} from '\.\.\/api\/_lib\/blobBudget\.js'/.test(SRC),
    'D7: the blob ceiling is imported from api/_lib/blobBudget.js, not redeclared');
  ok(!/3_500_000|3500000/.test(SRC), 'D7: no restated byte literal anywhere in the script');
  ok(/planTemplateCopy/.test(SRC),
    'a copy takes its version 1 from the SAME shared rule the server copy uses (src/lib/inspections.js)');
  ok(!/process\.exit\(/.test(SRC), 'exit codes are set, never process.exit() — it can crash node on Windows after network I/O');
  eq('the pg path connects exactly once — Supabase bans an address after failed passwords',
    (SRC.match(/client\.connect\(\)/g) || []).length, 1);
  ok(/client\.end\(\)/.test(SRC), 'the pg client is closed on every exit');

  const guardAt = SRC.indexOf('refuseTarget({');
  const importAt = SRC.indexOf('await import(');
  const pgAt = SRC.indexOf('new pg.Client');
  ok(guardAt > 0 && importAt > 0 && pgAt > 0, 'the script has a guard call, a dynamic driver import and a pg client');
  ok(guardAt < importAt, 'G3: the refusal is decided before the driver is even imported');
  ok(guardAt < pgAt, 'G3: …and before a Postgres connection is constructed — a refused run makes NO query');
  ok(SRC.indexOf('printTarget({') > guardAt, 'the guard runs before the target is printed, so a refused run prints only the refusal');

  const usage = SRC.slice(0, SRC.indexOf('// WHAT:'));
  const prodLines = usage.split('\n').filter((l) => /--prod/.test(l));
  ok(prodLines.length >= 2, `the usage block documents the production invocations (${prodLines.length})`);
  ok(prodLines.every((l) => /CONFIRM_PROD/.test(l)), 'every documented --prod invocation carries CONFIRM_PROD, as the guard requires');
  ok(/expected to change nothing|0 assignments|no-op/i.test(usage),
    "the header says production's run is expected to change nothing (0 assignments there today)");
}

// ── the op end to end, over a fake Postgres client ───────────────────────────
const VERSION_FIX = 4177;
const STATE_FIX = () => ({ version: 57, clients: fixtureClients(), users: [] });

function recorder() {
  const lines = [];
  const write = (...a) => { lines.push(a.map(String).join(' ')); };
  return { lines, write, text: () => lines.join('\n') };
}

// node-postgres hands bigint back as a STRING (PostgREST hands back a number), so the fake
// returns `version` as a string on purpose: forget to normalise it and `version + 1`
// concatenates and the success line reads "v4177 → 41771".
function fakePg({ state = STATE_FIX(), version = VERSION_FIX, templates = fixtureTemplates(), versions = fixtureVersions(), count, updated = [{ version: String(version + 1) }], onUpdateOrgState, stampRows = null, publishRows = null } = {}) {
  const calls = [];
  let minted = 0;
  const client = {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (/from public\.org_state/.test(text)) return { rows: state === null ? [] : [{ state, version: String(version) }] };
      if (/count\(\*\)/.test(text)) return { rows: [{ n: count ?? templates.length }] };
      // The statement says `order by id`, and the real database obeys it — so the fake must
      // too, or the two transports would be compared on different row orders.
      if (/from public\.inspection_templates/.test(text)) return { rows: [...templates].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
      if (/from public\.inspection_template_versions/.test(text)) return { rows: versions };
      if (/^\s*insert into public\.inspection_templates/.test(text)) { minted += 1; return { rows: [{ id: `it_new_${minted}` }] }; }
      if (/^\s*insert into public\.inspection_template_versions/.test(text)) { minted += 1; return { rows: [{ id: `iv_new_${minted}` }] }; }
      if (/^\s*update public\.inspection_templates set client_id/.test(text)) {
        return { rows: stampRows ?? [{ id: params[params.length - 2] }] };
      }
      if (/^\s*update public\.inspection_templates/.test(text)) {
        return { rows: publishRows ?? [{ id: params[params.length - 2] }] };
      }
      if (/^\s*update public\.org_state/.test(text)) { if (onUpdateOrgState) onUpdateOrgState(); return { rows: updated }; }
      throw new Error(`the fake saw an unexpected statement: ${text}`);
    },
  };
  return client;
}

const BACKUPS = mkdtempSync(path.join(tmpdir(), 'cs-dataop-loc-'));
const BACKUP_DIR = new URL(`${pathToFileURL(BACKUPS).href}/`);
const runWith = (t, over = {}) => {
  const r = recorder();
  return runChecklistLocationOp({ t, org: ORG_FIX, apply: true, backupDir: BACKUP_DIR, log: r.write, err: r.write, ...over })
    .then((code) => ({ code, out: r.text() }));
};
const orgUpdate = (calls) => calls.find((c) => /^\s*update public\.org_state/i.test(c.text));

{
  const client = fakePg();
  const { code, out } = await runWith(pgTransport(client));
  const calls = client.calls;
  eq('the happy path exits 0', code, 0);
  ok(/org_state v4177 → 4178/.test(out), `the version is read as a number, not a string (got: ${out.split('\n').filter((l) => /v41/.test(l)).join(' | ')})`);

  // every statement is parameterized: the values live in `params`, never in the text.
  // Matched as a WHOLE TOKEN, and never straight after a `$` — 'published' is a legitimate
  // substring of the column name `published_at`, and a small integer value is a substring
  // of its own placeholder (`item_count = $2` would read as the value 2 interpolated).
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const { text, params } of calls) {
    ok(!/;\s*\S/.test(text), `one statement per query: ${text.slice(0, 48)}…`);
    for (let i = 0; i < (params || []).length; i += 1) {
      const v = params[i];
      const asText = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      ok(text.includes(`$${i + 1}`), `$${i + 1} is a placeholder in: ${text.slice(0, 48)}…`);
      ok(!new RegExp(`(^|[^A-Za-z0-9_$])${esc(asText)}([^A-Za-z0-9_]|$)`).test(text),
        `param ${i + 1} (${asText.slice(0, 24)}) is not interpolated into: ${text.slice(0, 48)}…`);
    }
  }

  const counts = calls.filter((c) => /count\(\*\)/.test(c.text));
  const reads = calls.filter((c) => /from public\.inspection_templates/.test(c.text) && !/count\(\*\)/.test(c.text));
  eq('the templates are counted first', calls.indexOf(counts[0]) < calls.indexOf(reads[0]), true);
  eq('…and read in exactly one ordered statement', reads.length, 1);
  ok(/order by id/.test(reads[0].text), 'the templates read is ordered by id');

  const inserts = calls.filter((c) => /^\s*insert into public\.inspection_templates/.test(c.text));
  eq('one template insert per copy', inserts.length, 2);
  ok(inserts.every((c) => c.params.includes('checklist')), 'every copy is inserted as a checklist');
  ok(inserts.some((c) => c.params.includes(SHARED_TO_OLAS)) && inserts.some((c) => c.params.includes(ELSE_TO_LAKE)),
    'each copy carries its deterministic slug, so a re-run finds it instead of duplicating');
  const vInserts = calls.filter((c) => /^\s*insert into public\.inspection_template_versions/.test(c.text));
  eq('one version insert per copy', vInserts.length, 2);
  // F4: a copy this op makes must be the same kind of row as one made in the app, or step
  // 6's summary shows it with a blank count for ever.
  const publishes = calls.filter((c) => /^\s*update public\.inspection_templates set is_published/.test(c.text));
  ok(publishes.length >= 1 && publishes.every((c) => /item_count = \$/.test(c.text)),
    'a published copy carries its item_count, as store.publishTemplate sets it');
  eq('…and it is the PUBLISHED schema\'s count', publishes[0].params[1], 2);
  ok(vInserts.some((c) => JSON.stringify(c.params).includes(JSON.stringify(TWO))),
    "the copy of a PUBLISHED source carries its published schema, not the newer draft beside it");

  const stamps = calls.filter((c) => /^\s*update public\.inspection_templates set client_id/.test(c.text));
  eq('one stamp per single-customer checklist', stamps.length, 2);
  ok(stamps.every((c) => /client_id is null/.test(c.text)),
    'a stamp only ever fills an EMPTY client_id — it can never move a checklist out from under a customer');
  ok(stamps.every((c) => /organization_id = \$/.test(c.text)), 'every write is org-scoped');

  const upd = orgUpdate(calls);
  ok(upd, 'the picks are re-pointed in an org_state write');
  eq('…exactly ONE of them', calls.filter((c) => /^\s*update public\.org_state/.test(c.text)).length, 1);
  ok(/where organization_id = \$4 and version = \$5/.test(upd.text), 'CAS: the version predicate rides ON the update, as a parameter');
  ok(/version = version \+ 1/.test(upd.text), 'the next version is computed in SQL, never restated');
  ok(/returning version/.test(upd.text), 'the update returns its row, so 0 rows is a detectable conflict');
  ok(/updated_by = null/.test(upd.text) && /updated_by_build = null/.test(upd.text),
    'D6: no human and no client build is credited for a script write');
  eq('D6: updated_via is the script', upd.params[1], `script:${OP_NAME}`);
  eq('D6: updated_by_tab is the script', upd.params[2], `script:${OP_NAME}`);
  eq('the CAS params are the org and the version just read', [upd.params[3], upd.params[4]], [ORG_FIX, VERSION_FIX]);

  const written = upd.params[0];
  eq('the written blob re-points only the copied-for customers',
    written.clients.map((c) => Object.values(c.crewChecklists || {}).join('+')),
    ['it_floor+it_shared', 'it_new_3+it_new_3', 'it_new_1', '']);
  eq('…and changes nothing else about the state', { version: written.version, users: written.users }, { version: 57, users: [] });

  const backups = readdirSync(BACKUPS).filter((f) => /^orgstate-backup-.*\.json$/.test(f));
  eq('G4: the write left exactly one backup', backups.length, 1);
  const backup = JSON.parse(readFileSync(path.join(BACKUPS, backups[0]), 'utf8'));
  eq('G4: the backup holds the version and the state as they were read', { version: backup.version, state: backup.state }, { version: VERSION_FIX, state: STATE_FIX() });
  eq('G4: …AND the template rows, because this op rewrites those too', backup.templates, fixtureTemplates());
}

// G4 ordered: the backup is on disk before the FIRST write of either kind
{
  let backupsAtWrite = -1;
  const client = fakePg({ onUpdateOrgState: () => { backupsAtWrite = readdirSync(BACKUPS).filter((f) => /^orgstate-backup-/.test(f)).length; } });
  const { code } = await runWith(pgTransport(client), { now: new Date('2026-09-28T01:02:03.456Z') });
  eq('the op still exits 0', code, 0);
  ok(backupsAtWrite > 0, 'G4: a backup file is on disk before the org_state UPDATE is issued');
  ok(existsSync(path.join(BACKUPS, 'orgstate-backup-2026-09-28T01-02-03-456Z.json')),
    'G4: the backup name is the run timestamp on the gitignored pattern');
  const firstWrite = client.calls.findIndex((c) => /^\s*(insert|update)/i.test(c.text));
  const firstRead = client.calls.findIndex((c) => /^\s*select/i.test(c.text));
  ok(firstRead >= 0 && firstWrite > firstRead, 'every read happens before the first write');
}

// a half-applied run finds its own copies again instead of duplicating them
{
  const already = [...fixtureTemplates(),
    { id: 'it_copy_a', kind: 'checklist', client_id: 'cl_olas', name: 'Nightly', slug: SHARED_TO_OLAS, is_published: true, published_version_id: 'vc_a' },
    { id: 'it_copy_b', kind: 'checklist', client_id: 'cl_lake', name: 'Deep clean', slug: ELSE_TO_LAKE, is_published: false, published_version_id: null },
  ];
  const client = fakePg({ templates: already });
  const { code } = await runWith(pgTransport(client));
  eq('a re-run after a failed CAS exits 0', code, 0);
  eq('…and inserts NO second copy', client.calls.filter((c) => /^\s*insert into public\.inspection_templates/.test(c.text)).length, 0);
  const upd = orgUpdate(client.calls);
  eq('…and re-points at the copies that already exist',
    upd.params[0].clients.map((c) => Object.values(c.crewChecklists || {}).join('+')),
    ['it_floor+it_shared', 'it_copy_a+it_copy_a', 'it_copy_b', '']);
}

// F7: a write that changed NO ROW is a failure, not a step that happened (DEV_PLAYBOOK
// 3.5.2 — an affected-row count is the only proof a guarded UPDATE did anything). The stamp
// carries `client_id is null` as its guard and the publish carries the org, so zero rows
// means the world moved under the op: the plan is stale and the blob must not be rewritten
// against it.
{
  const client = fakePg({ stampRows: [] });
  const { code, out } = await runWith(pgTransport(client));
  eq('F7: a stamp that updated 0 rows exits 1', code, 1);
  ok(/stamp|client_id/i.test(out), '…and says which write found nothing');
  ok(!/✓ Filed/.test(out), '…and prints no success line');
  eq('F7: …and the org_state write never happens', orgUpdate(client.calls), undefined);
}
{
  const client = fakePg({ publishRows: [] });
  const { code, out } = await runWith(pgTransport(client));
  eq('F7: a publish that updated 0 rows exits 1', code, 1);
  ok(!/✓ Filed/.test(out), '…and prints no success line');
  eq('F7: …and the org_state write never happens', orgUpdate(client.calls), undefined);
}

// a CAS miss is loud, and never reads as success
{
  const client = fakePg({ updated: [] });
  const { code, out } = await runWith(pgTransport(client));
  eq('0 rows updated exits 1', code, 1);
  ok(/CAS conflict/.test(out), 'a CAS miss says so');
  ok(!/✓ Filed/.test(out), 'a CAS miss prints no success line');
}

// the dry run is the default: it reads, prints, and writes nothing
{
  const before = readdirSync(BACKUPS).filter((f) => /^orgstate-backup-/.test(f)).length;
  const client = fakePg();
  const { code, out } = await runWith(pgTransport(client), { apply: false });
  eq('the dry run exits 0', code, 0);
  eq('the dry run issues no write at all', client.calls.filter((c) => /^\s*(insert|update)/i.test(c.text)).length, 0);
  ok(/nothing written/.test(out), 'the dry run says nothing was written');
  eq('…and leaves no NEW backup behind', readdirSync(BACKUPS).filter((f) => /^orgstate-backup-/.test(f)).length, before);
}

// a converted world is a TRUE no-op: no write, and no version burned
{
  const converted = applyRepoints(fixtureClients(), plan.repoints, new Map([[SHARED_TO_OLAS, 'it_copy_a'], [ELSE_TO_LAKE, 'it_copy_b']]));
  const templates = [
    ...fixtureTemplates().map((t) => {
      const s = plan.stamps.find((x) => x.templateId === t.id);
      return s ? { ...t, client_id: s.clientId } : t;
    }),
    { id: 'it_copy_a', kind: 'checklist', client_id: 'cl_olas', name: 'Nightly', slug: SHARED_TO_OLAS, is_published: true, published_version_id: 'vc_a' },
    { id: 'it_copy_b', kind: 'checklist', client_id: 'cl_lake', name: 'Deep clean', slug: ELSE_TO_LAKE, is_published: false, published_version_id: null },
  ];
  const client = fakePg({ state: { ...STATE_FIX(), clients: converted }, templates });
  const { code, out } = await runWith(pgTransport(client));
  eq('a converted blob exits 0', code, 0);
  eq('…and issues no write of any kind', client.calls.filter((c) => /^\s*(insert|update)/i.test(c.text)).length, 0);
  ok(/No-op|already/i.test(out), '…and says it is already done');
}

// a short read is refused rather than planned on
{
  const client = fakePg({ count: fixtureTemplates().length + 1 });
  const { code, out } = await runWith(pgTransport(client));
  eq('a templates read that does not match the count exits 1', code, 1);
  eq('…and issues no write', client.calls.filter((c) => /^\s*(insert|update)/i.test(c.text)).length, 0);
  ok(/re-run/.test(out), '…and says to re-run');
}

// the blob ceiling, behaviourally
{
  const state = { ...STATE_FIX(), filler: 'x'.repeat(MAX_STATE_BYTES) };
  const client = fakePg({ state });
  const { code, out } = await runWith(pgTransport(client));
  eq('a result over the ceiling exits 1', code, 1);
  eq('…and issues no org_state UPDATE', orgUpdate(client.calls), undefined);
  ok(/ceiling/.test(out), '…and names the ceiling');
}

// an uninitialized org is a clean refusal, not a crash
{
  const client = fakePg({ state: null });
  const { code, out } = await runWith(pgTransport(client));
  eq('no org_state row exits 1', code, 1);
  ok(/not initialized/.test(out), '…and says so');
}

// ── the op over a fake PostgREST (the service-role transport) ────────────────
// A hand-rolled recording stand-in for the slice of the supabase-js builder this transport
// uses. Small on purpose: it records every call, so the PostgREST half is pinned the same
// way the SQL half is, and it stays offline with no client library anywhere near it.
function fakeRest({ state = STATE_FIX(), version = VERSION_FIX, templates = fixtureTemplates(), versions = fixtureVersions(), count, casRows = [{ version: version + 1 }] } = {}) {
  const calls = [];
  let minted = 0;
  const rows = { org_state: [{ organization_id: ORG_FIX, state, version }], inspection_templates: templates, inspection_template_versions: versions };
  const make = (table) => {
    const q = { table, op: 'select', filters: [], eqs: {}, isNull: [], inList: null, orders: [], cols: '*', head: false, countMode: null, payload: null, one: null };
    const api = {
      select(cols = '*', opts = {}) { q.cols = cols; if (opts.count) q.countMode = opts.count; if (opts.head) q.head = true; return api; },
      insert(p) { q.op = 'insert'; q.payload = p; return api; },
      update(p) { q.op = 'update'; q.payload = p; return api; },
      eq(c, v) { q.eqs[c] = v; q.filters.push((r) => String(r[c]) === String(v)); return api; },
      is(c, v) { q.isNull.push(c); q.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return api; },
      in(c, arr) { q.inList = { c, arr }; q.filters.push((r) => arr.includes(r[c])); return api; },
      order(c, o = {}) { q.orders.push({ c, asc: o.ascending !== false }); return api; },
      range(a, b) { q.range = [a, b]; return api; },
      single() { q.one = 'single'; return api; },
      maybeSingle() { q.one = 'maybe'; return api; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    function run() {
      calls.push({ ...q, payload: q.payload ? JSON.parse(JSON.stringify(q.payload)) : null });
      if (q.op === 'insert') {
        minted += 1;
        const id = table === 'inspection_templates' ? `it_new_${minted}` : `iv_new_${minted}`;
        const row = { id, ...q.payload };
        rows[table] = [...(rows[table] || []), row];
        return { data: q.one ? row : [row], error: null };
      }
      let hit = (rows[table] || []).filter((r) => q.filters.every((f) => f(r)));
      if (q.op === 'update') {
        for (const r of hit) Object.assign(r, q.payload);
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (q.countMode && q.head) return { data: null, count: (count ?? hit.length), error: null };
      if (q.orders.length) {
        hit = hit.slice().sort((x, y) => {
          for (const { c, asc } of q.orders) {
            const d = String(x[c]).localeCompare(String(y[c]));
            if (d !== 0) return asc ? d : -d;
          }
          return 0;
        });
      }
      if (q.range) hit = hit.slice(q.range[0], q.range[1] + 1);
      const data = hit.map((r) => ({ ...r }));
      if (q.one) return { data: data[0] ?? null, error: null };
      return { data, error: null };
    }
    return api;
  };
  return { calls, rows, from: make, casRows };
}

{
  const db = fakeRest();
  const { code, out } = await runWith(supabaseTransport(db, { casRows: () => db.casRows }));
  eq('PostgREST: the happy path exits 0', code, 0);
  ok(/org_state v4177 → 4178/.test(out), 'PostgREST: the version reads as a number');

  const inserts = db.calls.filter((c) => c.op === 'insert' && c.table === 'inspection_templates');
  eq('PostgREST: one template insert per copy', inserts.length, 2);
  ok(inserts.every((c) => c.payload.kind === 'checklist' && c.payload.organization_id === ORG_FIX),
    'PostgREST: each copy is a checklist in this org');
  eq('PostgREST: each copy carries its deterministic slug',
    inserts.map((c) => c.payload.slug), [ELSE_TO_LAKE, SHARED_TO_OLAS]);
  eq('PostgREST: each copy is filed under the customer it was made for',
    inserts.map((c) => c.payload.client_id), ['cl_lake', 'cl_olas']);

  const stamps = db.calls.filter((c) => c.op === 'update' && c.table === 'inspection_templates' && 'client_id' in (c.payload || {}));
  eq('PostgREST: one stamp per single-customer checklist', stamps.length, 2);
  ok(stamps.every((c) => c.isNull.includes('client_id')),
    'PostgREST: a stamp only fills an EMPTY client_id');
  ok(stamps.every((c) => c.eqs.organization_id === ORG_FIX), 'PostgREST: every write is org-scoped');

  const cas = db.calls.filter((c) => c.op === 'update' && c.table === 'org_state');
  eq('PostgREST: exactly one org_state write', cas.length, 1);
  eq('PostgREST: CAS — the version predicate rides ON the update', cas[0].eqs.version, VERSION_FIX);
  eq('PostgREST: …and the org', cas[0].eqs.organization_id, ORG_FIX);
  eq('PostgREST: provenance is the script, and no human is credited',
    [cas[0].payload.updated_via, cas[0].payload.updated_by, cas[0].payload.updated_by_build, cas[0].payload.updated_by_tab],
    [`script:${OP_NAME}`, null, null, `script:${OP_NAME}`]);
  eq('PostgREST: the re-pointed picks match the Postgres transport exactly',
    cas[0].payload.state.clients.map((c) => Object.values(c.crewChecklists || {}).join('+')),
    ['it_floor+it_shared', 'it_new_3+it_new_3', 'it_new_1', '']);

  const reads = db.calls.filter((c) => c.op === 'select' && c.table === 'inspection_templates' && !c.head);
  ok(reads.every((c) => c.orders.some((o) => o.c === 'id')), 'PostgREST: the templates read is ordered');
  ok(reads.every((c) => !!c.range), 'PostgREST: …and paged (it caps rows, unlike Postgres)');
  eq('PostgREST: the narrow selects name their columns',
    [reads[0].cols, db.calls.find((c) => c.table === 'inspection_template_versions' && c.op === 'select' && !c.head).cols],
    [TEMPLATE_SELECT, VERSION_SELECT]);
}

// a CAS miss on the PostgREST transport is just as loud
{
  const db = fakeRest();
  const { code, out } = await runWith(supabaseTransport(db, { casRows: () => [] }));
  eq('PostgREST: 0 rows updated exits 1', code, 1);
  ok(/CAS conflict/.test(out), 'PostgREST: a CAS miss says so');
}

rmSync(BACKUPS, { recursive: true, force: true });

// the backup pattern the script writes must already be gitignored (§8.2 rule 4)
{
  const ignore = readFileSync(path.join(HERE, '..', '.gitignore'), 'utf8');
  ok(/scripts\/orgstate-backup-\*\.json/.test(ignore), 'app/.gitignore already excludes scripts/orgstate-backup-*.json');
}

// it must NOT look like a test to the canonical runner (it would then need a LIVE_EFFECT row)
{
  const runner = readFileSync(path.join(HERE, 'run-tests.mjs'), 'utf8');
  ok(!/dataop-checklist-location/.test(runner), 'the op is out of the test path entirely (its name is not test-*), so no LIVE_EFFECT row is needed');
}

console.log(`\ndataop-checklist-location: ${pass}/${pass + fail} assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exitCode = 1; }
