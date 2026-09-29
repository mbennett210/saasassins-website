// CS-403 across the stack + the shared resolver's call sites — the halves no pure unit
// test can reach, checked MECHANICALLY over the source (BUILD_INTEGRITY "coverage is
// enumeration, not judgment"). Offline, no imports beyond the pure copy module.
//
// WHY: `checklist_results` has ONE actor column, `completed_by_user_id`, stamped from the
// JWT claim (app/api/qc/[...path].js). `CleanChecklist` matched a result to a cleaner by
// NAME, a field the backend never returns, so the filter kept every row and one cleaner's
// completion showed as the other's — in the crew button and in the manager roster. The
// demo stub stored a name, which is why demo mode never showed the bug. So: no name field
// anywhere on the checklist path, and the stub + the demo seed write the id the backend
// writes.
//
// Also pins that every `checklistFor(...)` call site passes the clean (`job`). Step 3
// makes the resolver read `job.coverFor`; with the clean already passed everywhere, that
// step changes only the function body.
//
// Run: node app/scripts/test-checklist-by-user-id.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { opsAlertCopy } from '../src/lib/opsAlertCopy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');          // app/
const REPO = path.resolve(APP, '..');          // repo root
const rel = (p) => path.relative(REPO, p).split(path.sep).join('/');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };

function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); continue; }
    if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}
const SOURCES = [...walk(path.join(APP, 'src')), ...walk(path.join(APP, 'api'))];
const read = (p) => readFileSync(p, 'utf8');
// A file that does not exist yet is a FAILING check, not a crash — the suite still
// reports every other row.
const readOr = (p) => { try { return read(p); } catch { return ''; } };
ok(SOURCES.length > 300, `enumerated the app source (${SOURCES.length} files under app/src + app/api)`);

// ── The schema is the oracle: ONE actor column, and it is an id ────────────────
{
  const sql = read(path.join(REPO, 'supabase/migrations/20260614120000_qc_backend.sql'));
  const start = sql.search(/create table if not exists (public\.)?checklist_results\s*\(/);
  ok(start >= 0, 'SCHEMA: found the checklist_results DDL (the oracle for who completed a checklist)');
  const body = sql.slice(start, sql.indexOf('\n);', start) + 3);
  ok(/completed_by_user_id/.test(body), 'SCHEMA: checklist_results stores completed_by_user_id');
  ok(!/completed_by_name/.test(body), 'SCHEMA: checklist_results has NO name column — a name match can never be satisfied by a backend row');
}

// ── No checklist code may carry the phantom name column ───────────────────────
{
  const hits = SOURCES.filter((p) => /completed_by_name/.test(read(p))).map(rel);
  ok(hits.length === 0, `CS-403: no app source references completed_by_name (found: ${hits.join(', ') || 'none'})`);
}
{
  // `completedByName` is a REAL field on supply requests, so scope this to the checklist
  // submit path: every file that speaks submitChecklist.
  const submitPath = SOURCES.filter((p) => /submitChecklist/.test(read(p)));
  ok(submitPath.length >= 3, `enumerated the checklist submit path (${submitPath.length} files)`);
  const hits = submitPath.filter((p) => /completedByName/.test(read(p))).map(rel);
  ok(hits.length === 0, `CS-403: the checklist submit path carries no completedByName (found: ${hits.join(', ') || 'none'})`);
}

// ── The three surfaces that decide "is this cleaner's checklist done" ─────────
{
  const clean = read(path.join(APP, 'src/components/CleanChecklist.jsx'));
  const matches = [...clean.matchAll(/latestChecklistFor\s*\(([^;]*?)\)\s*[,;)}]/g)];
  ok(matches.length >= 2,
    `CS-403: CleanChecklist matches results through the shared latestChecklistFor (${matches.length} call sites: the viewer's own card/button and the roster)`);
  const byName = matches.filter((m) => !/\buserId\s*:/.test(m[1]));
  ok(byName.length === 0,
    `CS-403: every CleanChecklist result match names the cleaner by userId, never by name (${byName.length} call(s) do not)`);
}
{
  const qcApi = read(path.join(APP, 'src/lib/qcApi.js'));
  const stub = qcApi.slice(qcApi.indexOf('function stubSubmitChecklist'));
  ok(/completed_by_user_id:/.test(stub.slice(0, stub.indexOf('\n}'))),
    'CS-403: the demo stub writes completed_by_user_id, exactly as the backend does');
}
{
  const demo = read(path.join(APP, 'src/data/demoStubs.js'));
  ok(/completed_by_user_id:/.test(demo), 'CS-403: the seeded demo checklist rows carry completed_by_user_id');
}

// ── The one resolver, and the clean passed at every call site ────────────────
{
  const stale = SOURCES.filter((p) => /resolveChecklistTemplateId/.test(read(p))).map(rel);
  ok(stale.length === 0, `replace-means-delete: resolveChecklistTemplateId is gone (found: ${stale.join(', ') || 'none'})`);
}
{
  // EVERY `checklistFor(` call — not only the ones already written as an object literal,
  // so `checklistFor(opts)` or a positional call fails this check instead of slipping past
  // it. `(?<![A-Za-z])` keeps the longer names that end in `checklistFor` out.
  const CALL = /(?<![A-Za-z])checklistFor\s*\(/g;
  const sites = [];
  for (const p of SOURCES) {
    if (p.endsWith(path.join('lib', 'crewChecklist.js'))) continue; // the definition itself
    const src = read(p);
    for (const m of src.matchAll(CALL)) {
      const after = src.slice(m.index + m[0].length);
      const lit = /^\s*\{([^}]*)\}/.exec(after);          // an inline object literal, or not
      sites.push({ file: rel(p), args: lit ? lit[1] : null, line: src.slice(0, m.index).split('\n').length });
    }
  }
  // Anti-vacuous floor, not a target: the three surfaces that resolve a cleaner's checklist
  // — the viewer's own card/button, the manager roster, and the reminder walker. The
  // assignments organizer's two call sites went with the location default they resolved for
  // (R3, 2026-09-27): every row now shows its own pick, so there is nothing to resolve.
  ok(sites.length >= 3, `enumerated the checklistFor call sites (${sites.length}): ${sites.map((s) => `${s.file}:${s.line}`).join(', ')}`);
  // The clean may be passed as `job` (shorthand) or `job: <expr>`. A call whose argument
  // is not an inline object literal cannot be checked, so it fails.
  const passesJob = (args) => args != null && args.split(',').map((x) => x.trim()).some((x) => x === 'job' || /^job\s*:/.test(x));
  const missing = sites.filter((s) => !passesJob(s.args))
    .map((s) => `${s.file}:${s.line}${s.args === null ? ' (not an inline object literal)' : ''}`);
  ok(missing.length === 0, `every checklistFor call site passes the clean as an inline object literal (step 3 then changes only the body) — missing: ${missing.join(', ') || 'none'}`);
}

// ── The demo stub's key is ONE constant, and it moves when the row shape moves ──
// `demoBootstrap` writes a stub only when its key is ABSENT, so a row-shape change with
// the key unchanged leaves an existing demo browser on the old shape for ever. The key was
// duplicated as a literal in the seed builder AND the adapter, which is how that could
// happen unnoticed.
{
  const keys = readOr(path.join(APP, 'src/data/stubKeys.js'));
  const m = /QC_CHECKLISTS_STUB_KEY\s*=\s*'([^']+)'/.exec(keys);
  ok(!!m, 'STUB KEY: data/stubKeys.js declares QC_CHECKLISTS_STUB_KEY');
  ok(/_v2$/.test(m ? m[1] : ''), `STUB KEY: it is bumped past the row-shape change (${m ? m[1] : 'missing'}) so every demo browser reseeds`);
  // Only the declaring file may spell the literal (it also lists the retired keys).
  const literals = SOURCES.filter((p) => !p.endsWith(path.join('data', 'stubKeys.js')) && /cleanspace_qc_checklists_stub/.test(read(p))).map(rel);
  ok(literals.length === 0, `STUB KEY: no other file hardcodes the literal (found: ${literals.join(', ') || 'none'})`);
  for (const f of ['src/data/demoStubs.js', 'src/lib/qcApi.js']) {
    ok(/QC_CHECKLISTS_STUB_KEY/.test(readOr(path.join(APP, f))) && /stubKeys/.test(readOr(path.join(APP, f))),
      `STUB KEY: ${f} reads the shared constant`);
  }
  ok(/RETIRED_STUB_KEYS/.test(read(path.join(APP, 'src/lib/demoBootstrap.js'))),
    'STUB KEY: demoBootstrap clears the retired key so the old rows do not linger');
}

// ── Both reminder callers shape their reads through the shared helpers ─────────
// The cron and the in-browser tick must agree, and neither may turn a failed or misshaped
// read into "nothing exists".
{
  for (const f of ['src/components/OpsAlertScheduler.jsx', 'api/cron/ops-alerts.js']) {
    const src = readOr(path.join(APP, f));
    ok(/liveChecklistIdsFrom\s*\(/.test(src), `READS: ${f} shapes the template read through liveChecklistIdsFrom`);
    ok(/activeUserIds/.test(src), `READS: ${f} passes the active roster ids to the walker`);
  }
}

// ── The publish guard is ONE rule, used by the server, the stub and the editor ──
{
  for (const f of ['api/_lib/qc/store.js', 'src/lib/qcApi.js', 'src/components/InspectionTemplateEditor.jsx']) {
    const src = readOr(path.join(APP, f));
    ok(/publishRefusal\s*\(/.test(src), `PUBLISH: ${f} refuses an item-less checklist through the shared publishRefusal`);
  }
  const route = readOr(path.join(APP, 'api/qc/[...path].js'));
  ok(/r\.refused/.test(route), 'PUBLISH: the route answers the refusal (400) instead of reporting a publish');
}

// ── The escalation names who is missing, from the roster ─────────────────────
{
  const roster = { u_a: 'Andre Baptiste', u_b: 'Tomas Rivera' };
  const userName = (id) => roster[id] || null;
  const esc = {
    kind: 'checklistDue', recipientScope: 'supervisor', jobId: 'j_1', clientId: 'cl_1',
    scheduledStart: '2026-09-27T12:00:00.000Z', missingUserIds: ['u_a', 'u_b'],
  };
  const both = opsAlertCopy(esc, 'Coral Bay HOA', { userName });
  ok(both.body.includes('Andre Baptiste') && both.body.includes('Tomas Rivera'),
    'COPY: the escalation names every missing cleaner from the roster');
  const one = opsAlertCopy({ ...esc, missingUserIds: ['u_b'] }, 'Coral Bay HOA', { userName });
  ok(one.body.includes('Tomas Rivera') && !one.body.includes('Andre Baptiste'),
    'COPY: it names only the cleaners who are actually missing');
  const unknown = opsAlertCopy({ ...esc, missingUserIds: ['u_gone'] }, 'Coral Bay HOA', { userName });
  ok(typeof unknown.body === 'string' && unknown.body.length > 0 && !unknown.body.includes('u_gone'),
    'COPY: an id with no roster row never leaks the raw id into the bell');
  const noResolver = opsAlertCopy(esc, 'Coral Bay HOA');
  ok(typeof noResolver.body === 'string' && noResolver.body.length > 0 && !noResolver.body.includes('u_a'),
    'COPY: with no roster resolver the copy still reads as a sentence (never a raw id)');
  const nudge = opsAlertCopy({ ...esc, recipientScope: 'crew' }, 'Coral Bay HOA', { userName });
  ok(!nudge.body.includes('Andre Baptiste') && !nudge.body.includes('Tomas Rivera'),
    'COPY: the crew nudge is addressed to that cleaner, so it does not name anyone');
}

console.log(`\nchecklist-by-user-id: ${pass}/${pass + fail} assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
