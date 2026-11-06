// QBO demo STUB data (pure, offline). No network, no Supabase, no import.meta.
//
// The demo build exercises the whole QuickBooks UI with no backend by backing qboApi with
// a localStorage stub (CS-038 pattern: STATIC MODE gate, dead in `npm run build`). The
// stub's DATA — the sandbox entity fixtures and the deterministic per-property P&L — lives
// in the node-safe src/lib/qboStubData.js so it is unit-testable headlessly. This pins:
//   • determinism: the same (links, range) always yields byte-identical P&L, so every UI
//     state is reproducible in the demo (task: "P&L is deterministic per linked entity and
//     range");
//   • money is INTEGER CENTS and the QBO identity income − COGS = gross profit holds (II.8);
//   • range monotonicity: a longer window is at least as much revenue as a shorter one;
//   • the stub starts DISCONNECTED (empty db), so the demo opens on the not-connected state;
//   • the stub key is in the ?demo=reset list (DEMO_STUB_KEYS), so a reset wipes it back to
//     disconnected (task decision: registered in the reset ritual).
//
//   node scripts/test-qbo-stub.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { QBO_STUB_KEY } from '../src/data/stubKeys.js';
import {
  stubEmptyDb, stubEntities, stubPnlAccounts, stubSandboxCompany,
} from '../src/lib/qboStubData.js';
import { RANGE_KEYS } from '../api/_lib/qbo/ranges.js';

// data/demoStubs.js has extensionless relative imports (Vite-resolved), so it can't be
// imported in bare node here — assert its ?demo=reset registration from the source text.
const demoStubsSrc = readFileSync(fileURLToPath(new URL('../src/data/demoStubs.js', import.meta.url)), 'utf8');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const eq = (label, got, want) => ok(label, got === want, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);

// ── 1. starts disconnected; reset wipes it ───────────────────────────────────
const empty = stubEmptyDb();
eq('empty stub db has no connection (opens disconnected)', empty.connection, null);
ok('empty stub db has an empty links array', Array.isArray(empty.links) && empty.links.length === 0);
eq('QBO_STUB_KEY is a string', typeof QBO_STUB_KEY, 'string');
ok('🔴 C1: demoStubs.js imports QBO_STUB_KEY from the fixtures-free key module, NOT qboStubData',
  /QBO_STUB_KEY\b[^\n]*from ['"]\.\/stubKeys['"]/.test(demoStubsSrc) && !/from ['"][^'"]*qboStubData/.test(demoStubsSrc));
ok('QBO_STUB_KEY is listed in DEMO_STUB_KEYS (so ?demo=reset wipes it back to disconnected)',
  /export const DEMO_STUB_KEYS\s*=\s*\[[\s\S]*?QBO_STUB_KEY[\s\S]*?\]/.test(demoStubsSrc));

// ── 1b. ONE declaration of the key, in data/stubKeys.js (the home of every demo stub key) ──
// demoBootstrap writes a stub only when its key is ABSENT, so the key is also the stub's shape
// version; a second copy of the literal is how a bump gets missed (the CS-403 lesson).
{
  const APP = fileURLToPath(new URL('..', import.meta.url));
  const walk = (dir, out = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out); } else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const sources = [...walk(path.join(APP, 'src')), ...walk(path.join(APP, 'api'))];
  ok('enumerated the app source (app/src + app/api)', sources.length > 300, `${sources.length} files`);
  const literals = sources.filter((p) => !p.endsWith(path.join('data', 'stubKeys.js')) && /cleanspace_qbo_stub/.test(readFileSync(p, 'utf8')))
    .map((p) => path.relative(APP, p).split(path.sep).join('/'));
  ok('🔴 only data/stubKeys.js spells the QBO stub key literal', literals.length === 0, `found: ${literals.join(', ')}`);
  ok('lib/qboApi.js reads the shared constant from data/stubKeys',
    /QBO_STUB_KEY\b[^\n]*from ['"]\.\.\/data\/stubKeys['"]/.test(readFileSync(path.join(APP, 'src/lib/qboApi.js'), 'utf8')));
}

// ── 2. sandbox company + entity fixtures ─────────────────────────────────────
const company = stubSandboxCompany();
eq('sandbox company is labelled sandbox (test data)', company.environment, 'sandbox');
ok('sandbox company has a name', typeof company.companyName === 'string' && company.companyName.length > 0);

for (const type of ['customer', 'class', 'department']) {
  const ents = stubEntities(type);
  ok(`entities(${type}) is a non-empty fixture`, Array.isArray(ents) && ents.length > 0);
  ok(`entities(${type}) rows carry id/name/type`, ents.every((e) => e.id && e.name && e.type === type));
  eq(`entities(${type}) ids are unique`, new Set(ents.map((e) => e.id)).size, ents.length);
}
ok('an unknown entity type yields an empty list', stubEntities('bogus').length === 0);

// ── 3. deterministic P&L per (link, range), integer cents, QBO identity ──────
const links = [
  { clientId: 'cl_a', entityType: 'customer', entityId: '1001', entityName: 'Ball Harbor (QBO)' },
  { clientId: 'cl_b', entityType: 'class', entityId: '2002', entityName: 'Brickell Class' },
];
const a1 = stubPnlAccounts(links, 'd30');
const a2 = stubPnlAccounts(links, 'd30');
eq('P&L is deterministic (same links+range → identical JSON)', JSON.stringify(a1), JSON.stringify(a2));
eq('one account per link', a1.length, links.length);
ok('accounts carry the link identity', a1[0].clientId === 'cl_a' && a1[0].entityType === 'customer' && a1[0].entityName === 'Ball Harbor (QBO)');
for (const acc of a1) {
  ok(`incomeCents integer (${acc.clientId})`, Number.isInteger(acc.incomeCents));
  ok(`cogsCents integer (${acc.clientId})`, Number.isInteger(acc.cogsCents));
  ok(`grossProfitCents integer (${acc.clientId})`, Number.isInteger(acc.grossProfitCents));
  ok(`expensesCents integer (${acc.clientId})`, Number.isInteger(acc.expensesCents));
  ok(`netIncomeCents integer (${acc.clientId})`, Number.isInteger(acc.netIncomeCents));
  eq(`QBO identity income − COGS = gross profit (${acc.clientId})`, acc.incomeCents - acc.cogsCents, acc.grossProfitCents);
  ok(`income is positive (${acc.clientId})`, acc.incomeCents > 0);
}

// ── 4. range monotonicity: a longer window is at least as much revenue ───────
const byRange = Object.fromEntries(RANGE_KEYS.map((r) => [r, stubPnlAccounts(links, r)[0].incomeCents]));
ok('day ≤ d10 ≤ d15 ≤ d30 ≤ all (monotonic revenue)',
  byRange.day <= byRange.d10 && byRange.d10 <= byRange.d15 && byRange.d15 <= byRange.d30 && byRange.d30 <= byRange.all,
  JSON.stringify(byRange));
// Distinct entities get distinct books (so the dashboard isn't all one number).
ok('distinct entities yield distinct P&L', stubPnlAccounts([links[0]], 'd30')[0].incomeCents !== stubPnlAccounts([links[1]], 'd30')[0].incomeCents);
ok('no links → no accounts', stubPnlAccounts([], 'd30').length === 0);

console.log(`\nqbo-stub: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
