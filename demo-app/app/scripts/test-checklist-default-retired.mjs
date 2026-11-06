// R3 — THERE IS NO LOCATION-WIDE DEFAULT CHECKLIST. A checklist applies only to the
// cleaners it is assigned to; a cleaner with no pick has no checklist, and that is a
// normal state (R1), never a warning.
//
// Before this, `client.checklistTemplateId` was a location-wide default that every
// unassigned cleaner inherited (`crewChecklist.checklistFor` fell back to it), so a
// location with Checklists A–E could not say "and nobody else has one", and the
// account-default picker made the per-cleaner picks look like overrides.
//
// Three halves are checked here, because no single level reaches them:
//   1. the pure rule — `checklistFor` has no fallback, and the scrub/completion helpers
//      no longer speak of a default;
//   2. the v56 → v57 transform — a saved default becomes a pick for each cleaner on that
//      location's upcoming/in-progress cleans who has none, then the field is DELETED
//      (`retireLocationDefaultsV57`, shared by store/persist.js and the live data-op);
//   3. MECHANICALLY over the source (BUILD_INTEGRITY "coverage is enumeration, not
//      judgment") — the field name is gone from the app, the seed and the fixtures, and
//      no surface still offers "Default checklist" / "Use account default".
//
// Failing-first by construction: `retireLocationDefaultsV57` does not exist pre-fix, so
// the import is undefined and every transform assertion throws.
//
// Run: node app/scripts/test-checklist-default-retired.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// crewChecklist.js is a leaf with NO imports, so it loads in raw Node. seed.js and
// persist.js pull Vite-style extensionless deps Node cannot resolve, so both are read as
// TEXT below — the same way test-persist-chain.mjs and test-crew-view.mjs read them.
//
// A NAMESPACE import on purpose: pre-fix `retireLocationDefaultsV57` does not exist, and a
// named import would fail at LINK time, printing an ESM error instead of the resolver
// failures that are the actual regression. This way the pre-fix run reports every wrong
// answer first and then dies on the missing transform — red either way, but legible.
import * as CK from '../src/lib/crewChecklist.js';

const { checklistFor, removeTemplateFromClients, retireLocationDefaultsV57, RETIRE_DEFAULT_JOB_STATUSES } = CK;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const REPO = path.resolve(APP, '..');
const rel = (p) => path.relative(REPO, p).split(path.sep).join('/');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1; else { fail += 1; console.error(`  ✗ ${name}\n      got : ${g}\n      want: ${w}`); }
};

// ── 1. The resolver has NO fallback ──────────────────────────────────────────
{
  // A location-wide default is not a thing any more, so a field left behind on an
  // un-migrated row must be INERT — never resurrect the old behaviour.
  const legacy = { id: 'cl1', checklistTemplateId: 'it_closeout', crewChecklists: { u_andre: 'it_floorcare' } };
  eq('the cleaner\'s own pick still wins', checklistFor({ client: legacy, job: null, userId: 'u_andre' }), 'it_floorcare');
  eq('a cleaner with NO pick gets NO checklist (R3 — no fallback)', checklistFor({ client: legacy, job: null, userId: 'u_tomas' }), null);
  eq('no user id → no checklist', checklistFor({ client: legacy, job: null, userId: null }), null);
  eq('a stale checklistTemplateId is inert even with no picks at all',
    checklistFor({ client: { id: 'cl2', checklistTemplateId: 'it_closeout' }, job: null, userId: 'u_any' }), null);
  eq('nullish client → null', checklistFor({ client: null, job: null, userId: 'u_x' }), null);
  eq('called with nothing at all → null (never throws)', checklistFor(), null);
  // Step 3 reads `job.coverFor`; a plain clean must not change the answer today.
  eq('a plain clean does not change the answer',
    checklistFor({ client: legacy, job: { id: 'j1', crewIds: ['u_andre', 'u_tomas'] }, userId: 'u_tomas' }), null);
}

// ── 1b. The template scrub no longer has a default to clear ──────────────────
{
  const clients = [
    { id: 'c1', crewChecklists: { u_a: 'it_x', u_b: 'it_y' } },
    { id: 'c2', crewChecklists: {} },
  ];
  const after = removeTemplateFromClients(clients, 'it_x');
  eq('scrub drops the per-cleaner entries pointing at the deleted checklist', after[0].crewChecklists, { u_b: 'it_y' });
  ok(!('checklistTemplateId' in after[0]), 'scrub never mints a checklistTemplateId field');
  ok(after[1] === clients[1], 'scrub leaves an unrelated row untouched by reference');
  // A row that still carries the retired field (an un-migrated blob) is left exactly as
  // it is: the scrub's job is the per-cleaner map, and the field is inert.
  const legacy = [{ id: 'c3', checklistTemplateId: 'it_x' }];
  ok(removeTemplateFromClients(legacy, 'it_x')[0] === legacy[0], 'scrub does not rewrite a row whose only reference is the retired field');
}

// ── 2. The v56 → v57 transform: convert, then clear ─────────────────────────
eq('only present/future cleans count', RETIRE_DEFAULT_JOB_STATUSES, ['upcoming', 'in_progress']);
{
  const base = () => ({
    clients: [
      // a saved default + one cleaner who already picked their own
      { id: 'cl_bay', name: 'Coral Bay', checklistTemplateId: 'it_closeout', crewChecklists: { u_andre: 'it_floorcare' } },
      // a saved default, nobody scheduled → the field just goes
      { id: 'cl_quiet', name: 'Quiet St', checklistTemplateId: 'it_closeout' },
      // never had one
      { id: 'cl_none', name: 'No Checklist Ave', crewChecklists: {} },
    ],
    jobs: [
      { id: 'j1', clientId: 'cl_bay', status: 'upcoming', crewIds: ['u_andre', 'u_tomas'] },
      { id: 'j2', clientId: 'cl_bay', status: 'in_progress', crewIds: ['u_priya', null] },
      { id: 'j3', clientId: 'cl_bay', status: 'done', crewIds: ['u_past'] },
      { id: 'j4', clientId: 'cl_bay', status: 'cancelled', crewIds: ['u_cancelled'] },
      { id: 'j5', clientId: 'cl_none', status: 'upcoming', crewIds: ['u_andre'] },
    ],
  });

  const s = base();
  const out = retireLocationDefaultsV57(s);
  const byId = Object.fromEntries(out.clients.map((c) => [c.id, c]));

  eq('CONVERT: every cleaner on an upcoming/in-progress clean with no pick inherits the saved default',
    byId.cl_bay.crewChecklists, { u_andre: 'it_floorcare', u_tomas: 'it_closeout', u_priya: 'it_closeout' });
  ok(!('checklistTemplateId' in byId.cl_bay), 'CLEAR: the field is deleted, not nulled');
  ok(!('checklistTemplateId' in byId.cl_quiet), 'CLEAR: a location with nobody scheduled simply loses the field');
  eq('a location with nobody scheduled gains no assignments', byId.cl_quiet.crewChecklists, undefined);
  ok(byId.cl_none === s.clients[2], 'a location that never had a default is untouched by reference');
  eq('a cleaner only ever on a DONE clean inherits nothing', byId.cl_bay.crewChecklists.u_past, undefined);
  eq('a cleaner only on a CANCELLED clean inherits nothing', byId.cl_bay.crewChecklists.u_cancelled, undefined);
  eq('a cleaner at ANOTHER location inherits nothing there', byId.cl_none.crewChecklists, {});
  eq('the counts describe the run', { converted: out.converted.length, cleaned: out.cleaned.length, added: out.assignmentsAdded }, { converted: 2, cleaned: 0, added: 2 });
  eq('the report names each converted location and who it added',
    out.converted.map((r) => [r.clientId, r.templateId, r.addedUserIds]),
    [['cl_bay', 'it_closeout', ['u_tomas', 'u_priya']], ['cl_quiet', 'it_closeout', []]]);

  // NEVER overwrite a cleaner's own pick.
  ok(byId.cl_bay.crewChecklists.u_andre === 'it_floorcare', 'NEVER overwrites a cleaner\'s own pick');

  // IDEMPOTENT: a re-run changes nothing.
  const again = retireLocationDefaultsV57({ clients: out.clients, jobs: s.jobs });
  eq('IDEMPOTENT: a re-run is deep-equal', JSON.stringify(again.clients), JSON.stringify(out.clients));
  eq('IDEMPOTENT: a re-run reports no work', { converted: again.converted.length, cleaned: again.cleaned.length, added: again.assignmentsAdded }, { converted: 0, cleaned: 0, added: 0 });
  ok(again.clients.every((c, i) => c === out.clients[i]), 'IDEMPOTENT: a re-run returns every row by reference');

  // A row left carrying an explicit null (an older template scrub nulled it) still loses
  // the key, and gains nothing.
  // D5 (stale-tab re-mint): a pre-deploy tab's UPDATE_CLIENT_OPS can write
  // `checklistTemplateId: null` back AFTER the live op ran. The key is still removed, but
  // it is a CLEANUP, not a conversion — otherwise the op's own verification ("re-run, it
  // must report nothing") would read as a failed write.
  const nulled = retireLocationDefaultsV57({ clients: [{ id: 'c_null', checklistTemplateId: null, crewChecklists: { u_a: 'it_a' } }], jobs: [{ id: 'jx', clientId: 'c_null', status: 'upcoming', crewIds: ['u_b'] }] });
  ok(!('checklistTemplateId' in nulled.clients[0]), 'an explicit null loses the key too');
  eq('an explicit null converts nobody', nulled.clients[0].crewChecklists, { u_a: 'it_a' });
  eq('an explicit null is a CLEANUP, never a conversion',
    { converted: nulled.converted.length, cleaned: nulled.cleaned, added: nulled.assignmentsAdded },
    { converted: 0, cleaned: ['c_null'], added: 0 });
  // …and a falsy-but-not-null value ('' from a hand-edited blob) is the same class.
  eq('an empty-string default is a cleanup too',
    retireLocationDefaultsV57({ clients: [{ id: 'c_empty', checklistTemplateId: '' }], jobs: [] }).cleaned, ['c_empty']);

  // Defensive shapes the live blob can hand it.
  eq('nullish input → empty clients', retireLocationDefaultsV57().clients, []);
  eq('a job with no clientId is ignored',
    retireLocationDefaultsV57({ clients: [{ id: 'c', checklistTemplateId: 't' }], jobs: [{ id: 'j', status: 'upcoming', crewIds: ['u'] }] }).assignmentsAdded, 0);
  eq('a job with no crewIds is ignored',
    retireLocationDefaultsV57({ clients: [{ id: 'c', checklistTemplateId: 't' }], jobs: [{ id: 'j', clientId: 'c', status: 'upcoming' }] }).assignmentsAdded, 0);
}

// ── 2b. The store version moves in lockstep (the numbers, from the files) ────
// test-persist-chain.mjs owns the generic lockstep property; this pins THIS bump and
// that the hop delegates to the one shared transform rather than re-implementing it.
// A LATER bump (v58, the manager's book — test-demo-manager-day.mjs) leaves this one in
// the chain: the store is at v57 or past it, and the chain runner still runs this hop.
{
  const persist = readFileSync(path.join(APP, 'src/store/persist.js'), 'utf8');
  const seedSrc = readFileSync(path.join(APP, 'src/data/seed.js'), 'utf8');
  const seedVersion = Number((seedSrc.match(/^\s*version:\s*(\d+)\s*,/m) || [])[1]);
  const keyVersion = Number((persist.match(/STORAGE_KEY\s*=\s*'pp\.store\.v(\d+)'/) || [])[1]);
  eq('INITIAL_STATE.version is 57 or a later bump', seedVersion >= 57, true);
  ok(keyVersion === seedVersion, `STORAGE_KEY is pp.store.v${seedVersion}, in lockstep (got v${keyVersion})`);
  ok(/version\s*===\s*56\)\s*st\s*=\s*migrateV56toV57/.test(persist), 'the chain runner still runs the v56 → v57 hop');
  const hop = (persist.match(/export function migrateV56toV57\s*\([\s\S]*?\n}/) || [])[0] || '';
  ok(hop.length > 0, 'migrateV56toV57 exists');
  ok(/retireLocationDefaultsV57/.test(hop), 'migrateV56toV57 delegates to the shared retireLocationDefaultsV57 (one transform, demo + live)');
  ok(/version:\s*57/.test(hop), 'migrateV56toV57 stamps version 57');
  ok(/'pp\.store\.v56'/.test(persist), 'the v56 storage key is still read, so an existing install migrates instead of reseeding');
}

// ── 2c. The seed is the source of truth for the demo drive ──────────────────
{
  const seedSrc = readFileSync(path.join(APP, 'src/data/seed.js'), 'utf8');
  const bay = (seedSrc.split('\n').find((l) => l.includes("name: 'Coral Bay HOA'")) || '');
  ok(bay.length > 0, 'the seed still has Coral Bay HOA');
  ok(!/checklistTemplateId/.test(bay), 'SEED: Coral Bay HOA has no location default');
  const picks = (bay.match(/crewChecklists:\s*\{([^}]*)\}/) || [])[1] || '';
  eq('SEED: Coral Bay HOA keeps its two cleaners\' own checklists',
    [...picks.matchAll(/'(it_[a-z]+)'/g)].map((m) => m[1]).sort(), ['it_floorcare', 'it_fullclean']);
}

// ── 3. Mechanically: the field name and the copy are gone ───────────────────
// THE ENUMERATION IS THE WORKING TREE MINUS WHAT GIT IGNORES. A local artifact the live
// scripts write is not a surface: `app/scripts/orgstate-backup-*.json` (app/.gitignore:29)
// is a pre-mutation dump of the real blob, so it names `checklistTemplateId` by definition
// and a raw directory walk turned this suite red on any machine that had run the data-op —
// CI stayed green only because CI has no backup. `orgstate-current.json`,
// `jwt-claims-backup-*` and `jobs-dedup-backup-*` (app/.gitignore:30, 35, 36) are the same
// class, so the rule is the ignore file, never a pattern list restated here.
// `--cached --others --exclude-standard` keeps UNTRACKED files that are not ignored, so a
// new, uncommitted source file is still caught — which is the whole point of walking disk
// rather than reading the index.
const EXTS = /\.(js|jsx|mjs|json|sql|css)$/;
const ROOTS = ['app/src', 'app/api', 'app/scripts', 'supabase'];
// Only reached when git is unavailable (an export with no .git). The known local-artifact
// names are skipped by hand there so the degraded path is not a landmine either.
const LOCAL_ARTIFACT = /^(orgstate-backup-.*|orgstate-current|jwt-claims-backup-.*|jobs-dedup-backup-.*)\.json$/;
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'dist') walk(p, out); continue; }
    if (EXTS.test(e.name) && !LOCAL_ARTIFACT.test(e.name)) out.push(p);
  }
  return out;
}
function gitFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ...ROOTS],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const files = [...new Set(out.split('\0').filter((f) => f && EXTS.test(f)))].map((f) => path.join(REPO, f));
    return files.length ? files : null;
  } catch { return null; }
}
const SOURCES = gitFiles() || ROOTS.map((r) => path.join(REPO, r)).flatMap((d) => walk(d));
ok(SOURCES.length > 400, `enumerated the shipped source + scripts + schema (${SOURCES.length} files)`);
ok(!SOURCES.some((p) => LOCAL_ARTIFACT.test(path.basename(p))),
  'the enumeration skips the gitignored blob dumps the live scripts write (app/.gitignore:29)');
const read = (p) => readFileSync(p, 'utf8');
// Comments are not surfaces: the migration and the data-op must be able to say, in prose,
// exactly which field they are retiring.
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

{
  // The retired field survives ONLY on the retirement path: the transform that deletes it,
  // the store hop and the data-op that call the transform, and these two suites. Anything
  // else naming it is a reader that was missed.
  const RETIREMENT_PATH = new Set([
    'app/src/lib/crewChecklist.js',              // the transform that deletes it
    'app/src/store/persist.js',                  // the v56 → v57 hop's log line
    'app/scripts/dataop-checklist-default.mjs',  // the live op that calls the transform
    'app/scripts/test-checklist-default-retired.mjs',
    'app/scripts/test-dataop-checklist-default.mjs',
    // A closed list of suites that keep the retired field on a fixture ON PURPOSE, to prove
    // it INERT — they assert null, never a fallback. A NEW file naming the field still fails.
    'app/scripts/test-crew-checklist.mjs',       // the cover cases: inert on that path too
  ]);
  const hits = SOURCES.map(rel).filter((f, i) => /checklistTemplateId/.test(read(SOURCES[i])));
  const strays = hits.filter((f) => !RETIREMENT_PATH.has(f));
  ok(strays.length === 0, `R3: only the retirement path still names checklistTemplateId (strays: ${strays.join(', ') || 'none'})`);
  ok(hits.length >= 3, `…and the retirement path itself is real (${hits.length} files: ${hits.join(', ')})`);
  // In the rule module the name may appear ONLY inside the retirement transform — never in
  // the resolver or the scrub, which is exactly where the fallback used to live.
  const ck = read(path.join(APP, 'src/lib/crewChecklist.js'));
  const beforeTransform = stripComments(ck.slice(0, ck.indexOf('export const RETIRE_DEFAULT_JOB_STATUSES')));
  ok(beforeTransform.length > 500 && !/checklistTemplateId/.test(beforeTransform),
    'the resolver and the scrub do not read checklistTemplateId at all (comments aside)');
  // The seed is DATA: it must not carry the field in any form, comment included.
  ok(!/checklistTemplateId/.test(read(path.join(APP, 'src/data/seed.js'))), 'SEED: the field name is gone from the seed entirely');
}
{
  const SELF = path.join(APP, 'scripts', 'test-checklist-default-retired.mjs');
  const stale = SOURCES.filter((p) => p !== SELF && /isDefaultChecklistForCleaner/.test(read(p))).map(rel);
  ok(stale.length === 0, `replace-means-delete: isDefaultChecklistForCleaner is gone (found: ${stale.join(', ') || 'none'})`);
  // D1: the roster gate moved off the location-wide question, so that helper goes too.
  const loc = SOURCES.filter((p) => p !== SELF && /hasPerCleanerChecklists/.test(read(p))).map(rel);
  ok(loc.length === 0, `replace-means-delete: hasPerCleanerChecklists is gone (found: ${loc.join(', ') || 'none'})`);
}
{
  // D1: the manager roster asks THIS CLEAN's crew, through the one resolver, so a card
  // whose every row would read "No checklist" (and an empty crew) renders nothing.
  const clean = read(path.join(APP, 'src/components/CleanChecklist.jsx'));
  const gate = (clean.match(/const rosterMode = [^;]*;/) || [])[0] || '';
  ok(/hasChecklistOnClean/.test(gate), `CleanChecklist gates the roster on hasChecklistOnClean (got: ${gate || 'no rosterMode'})`);
  ok(!/hasPerCleanerChecklists/.test(gate), 'CleanChecklist no longer gates the roster on the whole location');
}
{
  // The copies that told the operator a default existed. Comments are stripped first: the
  // migration and the data-op legitimately explain what they are retiring. Off the ONE
  // enumeration above, so the ignore rule reaches this sweep too.
  const SRC_DIR = path.join(APP, 'src') + path.sep;
  const UI = SOURCES.filter((p) => p.startsWith(SRC_DIR));
  const bad = UI.filter((p) => /Use account default|Default checklist|account default/i.test(stripComments(read(p)))).map(rel);
  ok(bad.length === 0, `COPY: no surface offers a default checklist (found: ${bad.join(', ') || 'none'})`);
}
{
  // …and the ONE surface that assigns checklists offers the honest empty state instead.
  // Service setup and the Quality hub's Assignments tab are the SAME component now
  // (components/checklists/CustomerChecklistPanel), so there is one place to check; the
  // pop-up organizer it replaced (ChecklistAssignmentsModal) is deleted, and
  // test-checklist-assignments.mjs holds that deletion.
  const panel = read(path.join(APP, 'src/components/checklists/CustomerChecklistPanel.jsx'));
  ok(/No checklist/.test(panel), 'COPY: the assignment panel offers "No checklist"');
  ok(!/svc-checklist\b/.test(panel), 'the panel renders no account-default select (#svc-checklist)');
  const svc = read(path.join(APP, 'src/components/ServiceSetupCard.jsx'));
  ok(!/svc-checklist\b/.test(svc), 'Service setup no longer renders the account-default select (#svc-checklist)');
}

console.log(`\nchecklist-default-retired: ${pass}/${pass + fail} assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
