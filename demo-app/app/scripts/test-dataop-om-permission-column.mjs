// The RELEASE data-op for the Operations Manager's permission column (CS-858, plan
// docs/plans/2026-10-16-om-permission-column.md §6) — `app/scripts/dataop-om-permission-column.mjs`.
//
// A STORED permission row wins over the code default (lib/roles can()), so on production's saved
// matrix every Operations Manager would hold NOTHING the moment the column ships. The op copies the
// manager column into the new one — `operations_manager` added to every stored row whose roles
// include `manager`, nothing else touched — and it runs BEFORE the deploy (today's code ignores an
// unknown name in a row). Live data-op law (THE LAW II.8, DATA_AND_SYNC.md §8.2): a dry run by
// default, --apply to write, the §8.2 production guard, a backup of the row first, a CAS on
// `version`, and a read-back.
//
// This suite is OFFLINE: it drives the op's pure plan and BOTH transports on fakes that record
// every statement, and checks the §8.2 contract mechanically over the op's source. The op's live
// section is behind a main-module guard, so importing it runs nothing. ⚠️ The op itself is NEVER
// run against production without the owner's recorded go (DATA_AND_SYNC.md §11).
//
// Failing-first by construction: the import is dynamic, so before the op exists every check is
// counted as failed. Run: node app/scripts/test-dataop-om-permission-column.mjs
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_STATE_BYTES } from '../api/_lib/blobBudget.js';

const ROLES_MOD = await import('../src/lib/roles.js');
const { seedPermissions } = ROLES_MOD;
const withOpsManagerColumn = typeof ROLES_MOD.withOpsManagerColumn === 'function' ? ROLES_MOD.withOpsManagerColumn : () => ({ permissions: undefined, added: [] });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = (() => { try { return readFileSync(path.join(HERE, 'dataop-om-permission-column.mjs'), 'utf8'); } catch { return ''; } })();
const OP = await import('./dataop-om-permission-column.mjs').catch(() => ({}));
const fn = (name) => (typeof OP[name] === 'function' ? OP[name] : () => undefined);
const OM_COL = 'operations_manager';

let pass = 0, fail = 0;
// ARG ORDER: ok(cond, msg) — this file follows test-dataop-checklist-default's order.
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) pass += 1; else { fail += 1; console.error(`  ✗ ${name}\n      got : ${g}\n      want: ${w}`); }
};
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));

// The FAKE ROWS: a saved matrix from before the column existed, with the shapes production can hold.
const FAKE_ROWS = () => [
  { id: 'clients.view', label: 'View Customers', roles: ['owner', 'admin', 'manager', 'crew'] },
  { id: 'invoices.view', label: 'View Invoices', roles: ['owner', 'manager'] },
  { id: 'payroll.rates.edit', label: 'Set team-member pay rates', roles: ['owner'] },
  { id: 'supplies.view', label: 'View Supplies', roles: ['owner', 'admin', 'manager', 'supply_manager'] },
  { id: 'quotes.delete', label: 'Void quotes', roles: ['owner', 'admin'] },            // the office took the manager off
  { id: 'reports.view', label: 'View reports', roles: ['owner', 'manager', OM_COL] },   // already carries it
  { id: 'legacy.string', label: 'A hand-written row', roles: 'owner,manager' },        // not the app's shape
];
const STATE_FIX = () => ({ version: 60, users: [{ id: 'u_owner', role: 'owner' }], clients: [{ id: 'cl_1', name: 'One' }], permissions: FAKE_ROWS() });

// ── the plan, pure ───────────────────────────────────────────────────────────────────────────
{
  const plan = fn('planOmColumnOp')({ permissions: FAKE_ROWS() }) || {};
  eq('the plan adds the column to exactly the rows naming the manager that lack it', plan.added, ['clients.view', 'invoices.view', 'supplies.view']);
  const by = Object.fromEntries((plan.permissions || []).filter((p) => p && p.id).map((p) => [p.id, p]));
  eq('…right after the manager, the row\'s other roles in their order', by['supplies.view']?.roles, ['owner', 'admin', 'manager', OM_COL, 'supply_manager']);
  eq('…a row without the manager is untouched (the office\'s own choice is copied, never overridden)', by['quotes.delete']?.roles, ['owner', 'admin']);
  eq('…an owner-only row is untouched', by['payroll.rates.edit']?.roles, ['owner']);
  eq('…a row already carrying the column is untouched', by['reports.view']?.roles, ['owner', 'manager', OM_COL]);
  eq('…a row not in the app\'s shape is left exactly as it is', by['legacy.string']?.roles, 'owner,manager');
  eq('…labels and ids are never touched', (plan.permissions || []).map((p) => [p.id, p.label]), FAKE_ROWS().map((p) => [p.id, p.label]));
  eq('the before census', plan.before, { rows: 7, managerRows: 4, withColumn: 1, malformed: 1 });
  eq('the after census: every manager row carries the column', plan.after, { rows: 7, managerRows: 4, withColumn: 4, malformed: 1 });
  ok(plan.changed === true, 'the plan reports there is work to do');
  // ONE transform for the demo and production: the op runs lib/roles withOpsManagerColumn.
  eq('the op\'s rows are exactly lib/roles withOpsManagerColumn\'s (the demo\'s v60 hop runs the same)',
    plan.permissions, withOpsManagerColumn(FAKE_ROWS()).permissions);
  ok(/import \{[^}]*withOpsManagerColumn[^}]*\} from '\.\.\/src\/lib\/roles\.js'/.test(SRC), 'the op imports the transform from lib/roles, never a copy of it');
  // IDEMPOTENT
  const again = fn('planOmColumnOp')({ permissions: plan.permissions || [] }) || {};
  ok(again.changed === false && Array.isArray(again.added) && again.added.length === 0, 'IDEMPOTENT: a second plan has nothing to do');
  eq('IDEMPOTENT: …and the same rows', JSON.stringify(again.permissions), JSON.stringify(plan.permissions));
  // the seed's own matrix is already done (it is built with the column)
  ok((fn('planOmColumnOp')({ permissions: seedPermissions() }) || {}).changed === false, 'a matrix built by this build already carries the column: no-op');
  const none = fn('planOmColumnOp')({ permissions: null }) || {};
  ok(none.changed === false && none.permissions === null, 'no stored matrix: nothing to do (the code defaults carry the column)');
}

// ── the §8.2 guard contract, read off the op ─────────────────────────────────────────────────
{
  eq('the op names itself for the provenance stamp', OP.OP_NAME, 'dataop-om-permission-column');
  ok(/APPLY\s*=\s*process\.argv\.includes\('--apply'\)/.test(SRC), 'G1: dry run is the DEFAULT (an --apply opt-in, never a --dry-run opt-out)');
  ok(!/includes\('--dry-run'\)/.test(SRC), 'G1: not one of the write-by-default scripts (§8.1)');
  ok(/from '\.\/_lib\/liveGuard\.mjs'/.test(SRC) && /refuseTarget\(\{/.test(SRC) && /printTarget\(\{/.test(SRC), 'G2/G3: the shared guard (liveGuard.mjs) — the target printed, production refused without --prod + CONFIRM_PROD');
  ok(/--prod/.test(SRC) && /CONFIRM_PROD/.test(SRC), 'G3: production needs --prod and CONFIRM_PROD');
  const usage = SRC.slice(0, SRC.indexOf('// WHY'));
  const prodLines = usage.split('\n').filter((l) => /--prod/.test(l));
  ok(prodLines.length >= 2 && prodLines.every((l) => /CONFIRM_PROD/.test(l)), 'G3: every documented --prod invocation carries CONFIRM_PROD');
  ok(/orgstate-backup-/.test(SRC), 'G4: the pre-write backup lands on the gitignored orgstate-backup-* pattern');
  ok(/updated_via/.test(SRC) && /script:\$\{OP_NAME\}/.test(SRC), 'G5: the write stamps script provenance');
  ok(/import \{ MAX_STATE_BYTES \} from '\.\.\/api\/_lib\/blobBudget\.js'/.test(SRC) && !/3_500_000|3500000/.test(SRC), 'the blob ceiling is the api constant, never a restated literal');
  const guardAt = SRC.indexOf('refuseTarget({');
  const importAt = SRC.indexOf('await import(');
  ok(guardAt > 0 && importAt > 0 && guardAt < importAt, 'G3: the refusal is decided before a driver is even imported (a refused run makes no query)');
  eq('the pg path connects exactly once', (SRC.match(/client\.connect\(\)/g) || []).length, 1);
  ok(/client\.end\(\)/.test(SRC) && !/process\.exit\(/.test(SRC), 'the pg client is closed on every exit; exit codes are set, never process.exit()');
  ok(/import\.meta\.url/.test(SRC) && /process\.argv\[1\]/.test(SRC), 'the live section is behind a main-module guard, so importing it is inert');
  ok(/protected_fingerprint/.test(SRC), 'the op says what it does with the stored digest (left alone: the next save takes the full check)');
}

// ── the op over the Postgres transport, end to end on a stateful fake ────────────────────────
const ORG_FIX = '00000000-0000-0000-0000-0000000000ab';
const VERSION_FIX = 4177; // not 1 or 2: a digit no `$1` placeholder can be confused with
function recorder() {
  const lines = [];
  const write = (...a) => { lines.push(a.map(String).join(' ')); };
  return { lines, write, text: () => lines.join('\n') };
}
// node-postgres hands bigint back as a STRING; the fake does too, so `version + 1` must be normalised.
// It is STATEFUL: a CAS that matches stores the new state, and the read-back sees it — handed back
// with every object's keys in REVERSED order, as jsonb hands back its own order.
function fakePg({ state, version = VERSION_FIX, casMiss = false, lieOnReadBack = false, onUpdate } = {}) {
  const calls = [];
  let row = state === null ? null : { state: structuredClone(state), version };
  let reads = 0;
  const reverseKeys = (v) => (Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])])) : v);
  const client = {
    calls,
    query: async (text, params) => {
      calls.push({ text, params });
      if (/^\s*select state, version from public\.org_state/.test(text)) {
        reads += 1;
        if (!row) return { rows: [] };
        const s = reads > 1 && lieOnReadBack ? state : row.state;
        return { rows: [{ state: reads > 1 ? reverseKeys(s) : structuredClone(s), version: String(row.version) }] };
      }
      if (/^\s*update public\.org_state/.test(text)) {
        if (onUpdate) onUpdate();
        if (casMiss || !row || Number(params[4]) !== row.version) return { rows: [] };
        row = { state: structuredClone(params[0]), version: row.version + 1 };
        return { rows: [{ version: String(row.version) }] };
      }
      throw new Error(`the fake saw an unexpected statement: ${text}`);
    },
  };
  return client;
}
const BACKUPS = mkdtempSync(path.join(tmpdir(), 'cs-dataop-om-'));
const BACKUP_DIR = new URL(`${pathToFileURL(BACKUPS).href}/`);
const run = (t, over = {}) => {
  const r = recorder();
  return Promise.resolve(fn('runOmColumnOp')({ t, org: ORG_FIX, apply: true, backupDir: BACKUP_DIR, log: r.write, err: r.write, ...over }))
    .then((code) => ({ code, out: r.text() }));
};
const pg = (client) => fn('pgTransport')(client) || {};
const updateOf = (calls) => calls.find((c) => /^\s*update /i.test(c.text));

// THE DRY RUN on the fake rows: it reports every row it would change, and writes nothing.
let DRY_RUN_OUTPUT = '';
{
  const client = fakePg({ state: STATE_FIX() });
  const { code, out } = await run(pg(client), { apply: false });
  DRY_RUN_OUTPUT = out;
  eq('the dry run exits 0', code, 0);
  eq('the dry run issues no UPDATE', updateOf(client.calls), undefined);
  ok(/nothing written/.test(out), 'the dry run says nothing was written');
  ok(['clients.view', 'invoices.view', 'supplies.view'].every((id) => new RegExp(`· ${id.replace('.', '\\.')}\\b`).test(out)), 'the dry run lists each row it would change');
  ok(!/· quotes\.delete\b/.test(out) && !/· payroll\.rates\.edit\b/.test(out) && !/· reports\.view\b/.test(out), '…and none it would not');
  ok(/rows naming the manager\s*:\s*4/.test(out) && /not in the app's shape\s*:\s*1/.test(out), 'the dry run prints the census before and after');
}

// --apply: the column is added where the manager is, and nowhere else; the backup lands first
{
  let backupsAtWrite = -1;
  const client = fakePg({ state: STATE_FIX(), onUpdate: () => { backupsAtWrite = readdirSync(BACKUPS).filter((f) => /^orgstate-backup-/.test(f)).length; } });
  const { code, out } = await run(pg(client), { now: new Date('2026-10-16T01:02:03.456Z') });
  eq('--apply exits 0', code, 0);
  ok(new RegExp(`v${VERSION_FIX} → ${VERSION_FIX + 1}`).test(out), `the version is read as a number (got: ${out.split('\n').filter((l) => /v41/.test(l)).join(' | ')})`);
  const upd = updateOf(client.calls);
  ok(!!upd, 'an UPDATE is issued');
  const written = upd?.params?.[0] || {};
  const want = STATE_FIX();
  want.permissions = withOpsManagerColumn(want.permissions).permissions;
  eq('the written blob is the state it read with ONLY the matrix rows changed', canonical(written), canonical(want));
  eq('…every other slice byte-for-byte as read', canonical({ ...written, permissions: null }), canonical({ ...STATE_FIX(), permissions: null }));
  ok(/where organization_id = \$4 and version = \$5/.test(upd?.text || ''), 'CAS: the version predicate rides ON the update, as a parameter');
  ok(/version = version \+ 1/.test(upd?.text || '') && /returning version/.test(upd?.text || ''), 'the next version is computed in SQL, and the update returns its row');
  ok(/updated_by = null/.test(upd?.text || '') && /updated_by_build = null/.test(upd?.text || ''), 'no human and no client build is credited for a script write');
  eq('updated_via and updated_by_tab name the script', [upd?.params?.[1], upd?.params?.[2]], ['script:dataop-om-permission-column', 'script:dataop-om-permission-column']);
  eq('the CAS params are the org and the version just read', [upd?.params?.[3], upd?.params?.[4]], [ORG_FIX, VERSION_FIX]);
  for (const { text, params } of client.calls) {
    for (let i = 0; i < (params || []).length; i += 1) {
      const v = params[i];
      const asText = typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
      ok(text.includes(`$${i + 1}`) && !text.includes(asText), `param ${i + 1} is a placeholder, never interpolated: ${text.slice(0, 40)}…`);
    }
  }
  ok(backupsAtWrite > 0, 'G4: the backup is on disk before the UPDATE is issued');
  ok(existsSync(path.join(BACKUPS, 'orgstate-backup-2026-10-16T01-02-03-456Z.json')), 'G4: the backup name is the run timestamp on the gitignored pattern');
  const backup = (() => { try { return JSON.parse(readFileSync(path.join(BACKUPS, 'orgstate-backup-2026-10-16T01-02-03-456Z.json'), 'utf8')); } catch { return null; } })();
  eq('G4: the backup holds the version and the state as they were read', backup, { version: VERSION_FIX, state: STATE_FIX() });
  // the read-back
  const reads = client.calls.filter((c) => /^\s*select state, version/.test(c.text));
  eq('READ-BACK: the row is read again after the write', reads.length, 2);
  ok(/read back/i.test(out) && new RegExp(`v${VERSION_FIX + 1}`).test(out), 'READ-BACK: the op reports what it read back');
  ok(!/does not match/i.test(out), 'READ-BACK: jsonb\'s own key order is not a mismatch');
}

// a SECOND run changes nothing: no backup, no UPDATE, exit 0
{
  const done = STATE_FIX();
  done.permissions = withOpsManagerColumn(done.permissions).permissions;
  const client = fakePg({ state: done });
  const before = readdirSync(BACKUPS).length;
  const { code, out } = await run(pg(client));
  eq('a second run exits 0', code, 0);
  eq('…issues no UPDATE (a version is never burned on a no-op)', updateOf(client.calls), undefined);
  eq('…and writes no backup', readdirSync(BACKUPS).length, before);
  ok(/No-op/.test(out), '…and says it is a no-op');
}

// failures are loud and never read as success
{
  const miss = fakePg({ state: STATE_FIX(), casMiss: true });
  const m = await run(pg(miss));
  eq('a CAS miss exits 1', m.code, 1);
  ok(/CAS conflict/.test(m.out) && !/✓/.test(m.out), 'a CAS miss says so and prints no success line');
  const lie = fakePg({ state: STATE_FIX(), lieOnReadBack: true });
  const l = await run(pg(lie));
  eq('a read-back that does not show the write exits 1', l.code, 1);
  ok(/read-back/i.test(l.out) && /backup/i.test(l.out), '…and names the backup to restore from');
  const big = STATE_FIX();
  big.filler = 'x'.repeat(MAX_STATE_BYTES);
  const b = fakePg({ state: big });
  const bo = await run(pg(b));
  eq('a result over the ceiling exits 1', bo.code, 1);
  eq('…and issues no UPDATE', updateOf(b.calls), undefined);
  const nobody = fakePg({ state: null });
  const n = await run(pg(nobody));
  eq('no org_state row exits 1', n.code, 1);
  ok(/not initialized/.test(n.out), '…and says so');
}

// ── the supabase-js transport (the service-role pair), on a minimal fake ─────────────────────
{
  const calls = [];
  let row = { state: STATE_FIX(), version: 12 };
  const db = {
    from: (table) => {
      const q = { table, filters: [], op: 'select' };
      const api = {
        select: (cols) => { q.cols = cols; return api; },
        update: (patch) => { q.op = 'update'; q.patch = patch; return api; },
        eq: (col, val) => { q.filters.push([col, val]); return api; },
        maybeSingle: async () => { calls.push({ ...q }); return { data: row ? { state: structuredClone(row.state), version: row.version } : null, error: null }; },
        then: undefined,
      };
      // an update resolves when awaited after .select('version')
      api.select = (cols) => {
        q.cols = cols;
        if (q.op !== 'update') return api;
        return (async () => {
          calls.push({ ...q });
          const v = (q.filters.find(([c]) => c === 'version') || [])[1];
          if (v !== row.version) return { data: [], error: null };
          row = { state: structuredClone(q.patch.state), version: q.patch.version };
          return { data: [{ version: row.version }], error: null };
        })();
      };
      return api;
    },
  };
  const t = fn('supabaseTransport')(db) || {};
  const r = recorder();
  const code = await Promise.resolve(fn('runOmColumnOp')({ t, org: ORG_FIX, apply: true, backupDir: BACKUP_DIR, log: r.write, err: r.write }));
  eq('the supabase-js transport: --apply exits 0', code, 0);
  const upd = calls.find((c) => c.op === 'update');
  ok(!!upd && upd.filters.some(([c, v]) => c === 'version' && v === 12) && upd.filters.some(([c, v]) => c === 'organization_id' && v === ORG_FIX),
    'the supabase-js CAS carries the org and the version just read');
  ok(upd?.patch?.version === 13 && upd?.patch?.updated_via === 'script:dataop-om-permission-column' && upd?.patch?.updated_by === null, 'the supabase-js write stamps the next version and the script provenance');
  ok(row.version === 13 && row.state.permissions.every((p) => !Array.isArray(p.roles) || p.roles.includes(OM_COL) === p.roles.includes('manager')), 'the row now carries the column on every manager row');
}

rmSync(BACKUPS, { recursive: true, force: true });

// the backup pattern the op writes must already be gitignored (§8.2 rule 4)
{
  const ignore = readFileSync(path.join(HERE, '..', '.gitignore'), 'utf8');
  ok(/scripts\/orgstate-backup-\*\.json/.test(ignore), 'app/.gitignore already excludes scripts/orgstate-backup-*.json');
}
// it must NOT look like a test to the canonical runner
{
  const runner = readFileSync(path.join(HERE, 'run-tests.mjs'), 'utf8');
  ok(!/dataop-om-permission-column/.test(runner), 'the op is out of the test path entirely (its name is not test-*)');
}

if (process.argv.includes('--show-dry-run')) console.log(`\n── the dry run on the fake rows ──${DRY_RUN_OUTPUT ? `\n${DRY_RUN_OUTPUT}` : ' (none)'}\n`);
console.log(`\ndataop-om-permission-column: ${pass}/${pass + fail} assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exitCode = 1; }
