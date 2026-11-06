// QB-12 — the "needs matching" list (offline).
//
// Matt, 2026-09-29: "When a QuickBooks customer doesn't match an account in the app? (a) Put it on
// a 'needs matching' list for your analyst." Buildings are QuickBooks CUSTOMERS (QB-2), some of
// them jobs under a management company. This pins:
//   1. the rule (src/lib/qboRules.js needsMatching): ACTIVE customers WITH ACTIVITY in the window
//      that reach no property — never one linked, never a job under a linked parent; numbered
//      ones first; counts say what was left out;
//   2. the suggestion: the customer here with the same four-digit number, else the same name —
//      never one already linked, never a vendor;
//   3. the activity chunks keep a customer with its own jobs, and cover every active customer once;
//   4. the route (GET /api/quickbooks/needs-matching): integrations.view; COMPLETE across pages
//      (a 2,345-customer book, three pages); linked never listed; names only, no money; reads
//      QuickBooks and never writes to it; an activity read that cannot finish lists every active
//      customer (activityKnown false) rather than guess;
//   5. the nightly refresh reads the activity, so the list opens without asking QuickBooks;
//   6. the demo stub runs the same rule over its fixtures;
//   7. the screen is written on the catalog and pages its rows.
//
//   node scripts/test-qbo-matching.mjs
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';
import { rig, counter, pnlReport } from './qbo-harness.mjs';

const { ok, finish } = counter('qbo-matching');
// Imported dynamically, so a tree without the rules (before Wave 3) reports each check as failed
// rather than dying on the import.
const rules = await import('../src/lib/qboRules.js').catch(() => ({}));
const fn = (name) => (typeof rules[name] === 'function' ? rules[name] : () => null);
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// ── 1. the rule ─────────────────────────────────────────────────────────────
const E = (id, name, extra = {}) => ({ id, name, active: true, parentId: null, ...extra });
const BOOK = [
  E('1', '0001 Ball Harbor Village'),                        // linked
  E('2', 'Graystar Properties'),                             // linked parent…
  E('3', '0003 Aventura Lofts', { parentId: '2' }),          // …so its job is covered
  E('4', '0004 Brickell Bay Offices'),                       // needs matching
  E('5', '0005 Sunset Center', { active: false }),           // inactive
  E('6', '0006 Wynwood Lofts'),                              // no activity
  E('7', 'Harbor Group'),                                    // needs matching, no number
  E('8', '0002 Doral Point', { parentId: '7' }),             // a job under an unlinked parent — needs matching
];
{
  const got = fn('needsMatching')({ entities: BOOK, linkedIds: ['1', '2'], activeIds: new Set(['1', '2', '3', '4', '7', '8']) }) || { customers: [], counts: {} };
  const ids = got.customers.map((c) => c.id);
  ok('🔴 needsMatching lists the active customers with activity that reach no property', ids.sort().join(',') === '4,7,8', ids.join(','));
  ok('🔴 a linked customer is never listed', !ids.includes('1') && !ids.includes('2'));
  ok('🔴 a job under a linked parent is not listed (its money already reaches that property)', !ids.includes('3'));
  ok('an inactive QuickBooks customer is not listed', !ids.includes('5'));
  ok('a customer with nothing in the window is not listed', !ids.includes('6'));
  ok('counts say what was left out and why', got.counts.linked === 2 && got.counts.covered === 1 && got.counts.quiet === 1 && got.counts.active === 7 && got.counts.unmatched === 3, JSON.stringify(got.counts));
  const ordered = got.customers.map((c) => c.id);
  ok('numbered customers first, by number (0002 before 0004), then the rest by name', ordered.join(',') === '8,4,7', ordered.join(','));
  const doral = got.customers.find((c) => c.id === '8');
  ok('a row carries QuickBooks\' own number and the parent it is a job under', doral && doral.number === '0002' && doral.parentName === 'Harbor Group', JSON.stringify(doral));
  const unknown = fn('needsMatching')({ entities: BOOK, linkedIds: ['1', '2'], activeIds: null }) || { customers: [] };
  ok('activity not known yet → every active, unmatched customer is listed (never a guess)', unknown.customers.map((c) => c.id).sort().join(',') === '4,6,7,8', unknown.customers.map((c) => c.id).join(','));
}

// ── 2. the suggestion ───────────────────────────────────────────────────────
{
  const suggest = fn('suggestAccountFor');
  const clients = [
    { id: 'a', name: 'Brickell Bay Offices', customerNumber: '0004' },
    { id: 'b', name: 'Harbor Group' },
    { id: 'c', name: 'Doral Point', customerNumber: '0099' },
    { id: 'v', name: 'Sunset Center', type: 'vendor' },
  ];
  ok('🔴 the customer with the same four-digit number is suggested', suggest('0004 Brickell Bay Offices', clients)?.id === 'a');
  ok('… else the same name, numbers and punctuation aside', suggest('HARBOR GROUP', clients)?.id === 'b' && suggest('0002 Doral Point', clients)?.id === 'c');
  ok('a customer already linked to QuickBooks is never suggested', suggest('0004 Brickell Bay Offices', clients, ['a']) == null);
  ok('a vendor is never suggested', suggest('0005 Sunset Center', clients) == null);
  ok('no likely match → nothing', suggest('0123 Nowhere Plaza', clients) == null);
  const without = fn('accountsWithoutQuickBooks')(clients, ['a'], { isActive: (c) => c.id !== 'c' }) || [];
  ok('🔴 the reverse view: active customers here with no QuickBooks link (no vendor)', without.map((c) => c.id).join(',') === 'b', without.map((c) => c.id).join(','));
}

// ── 3. the activity chunks ──────────────────────────────────────────────────
{
  const many = [];
  for (let i = 1; i <= 400; i += 1) many.push(E(String(i), `Customer ${i}`, { parentId: i > 300 ? String(i - 300) : null }));
  many.push(E('999', 'Gone', { active: false }));
  const chunks = fn('activityChunks')(many, 150) || [];
  const flat = chunks.flat();
  ok('every active customer is in exactly one chunk', flat.length === 400 && new Set(flat).size === 400 && !flat.includes('999'), `${flat.length}`);
  ok('no chunk is larger than the bound', chunks.length > 1 && chunks.every((c) => c.length <= 150), chunks.map((c) => c.length).join(','));
  const home = new Map();
  chunks.forEach((c, i) => c.forEach((id) => home.set(id, i)));
  ok('🔴 a customer travels with its own jobs (its roll-up column always follows its own)', [...Array(100).keys()].every((k) => home.get(String(k + 301)) === home.get(String(k + 1))));
}

// ── 4. the route ────────────────────────────────────────────────────────────
const r = await rig();
const many = Array.from({ length: 2345 }, (_, i) => ({
  Id: String(i + 1), DisplayName: `${String(i + 1).padStart(4, '0')} Building ${i + 1}`, Active: i % 10 !== 9,
  ...(i >= 2300 ? { ParentRef: { value: '1' } } : {}),
}));
// Activity: every customer whose id is divisible by 3 has money in the window; the report lists
// only the customers in its filter, as Intuit's filtered P&L does.
const activityReport = (u) => {
  const ids = (u.searchParams.get('customer') || '').split(',').filter(Boolean);
  return pnlReport({ cols: ids.filter((id) => Number(id) % 3 === 0).map((id) => ({ key: id, title: `C${id}`, income: '100.00', cogs: '10.00' })) });
};
const LINKS = () => [r.linkRow('cl_1', 'customer', '1', '0001 Building 1'), r.linkRow('cl_2', 'customer', '6', '0006 Building 6')];
const world = (over = {}) => { r.build({ links: LINKS(), entities: { customer: many }, ...over }); r.intuit.pnl = activityReport; };
// active (every tenth is not), not linked (1, 6), not a job under 1 (2301…2345), and — when
// activity is known — with money in the window (÷3).
const expected = ({ activity = true } = {}) => {
  const out = [];
  for (let i = 1; i <= 2345; i += 1) {
    if (i % 10 === 0) continue;
    if (i === 1 || i === 6 || i > 2300) continue;
    if (activity && i % 3 !== 0) continue;
    out.push(String(i));
  }
  return out;
};
world();
{
  const anon = await r.call({ path: 'needs-matching' });
  ok('no session → 401', anon.status === 401, r.show(anon));
  for (const [who, want] of [['crew', 403], ['admin', 403], ['mgr', 200], ['owner', 200]]) {
    const res = await r.call({ path: 'needs-matching', token: `tok-${who}` });
    ok(`integrations.view gates it: ${who} → ${want}`, res.status === want, r.show(res));
  }
}
world();
{
  const res = await r.call({ path: 'needs-matching', token: 'tok-owner' });
  const ids = (res.body.customers || []).map((c) => c.id).sort((a, b) => Number(a) - Number(b));
  const want = expected();
  ok('→ 200, connected', res.status === 200 && res.body.connected === true, r.show(res));
  ok('🔴 COMPLETE across pages: every active, unmatched customer with activity in a 2,345-customer book', ids.length === want.length && ids.join(',') === want.join(','), `${ids.length} vs ${want.length}`);
  const queries = r.intuitLog.filter((e) => e.url.pathname.endsWith('/query')).map((e) => e.url.searchParams.get('query'));
  ok('… read count-first, then all three pages', queries.length === 4 && /count\(\*\)/i.test(queries[0]), queries.length);
  ok('🔴 a linked customer is never listed', !ids.includes('1') && !ids.includes('6'));
  ok('🔴 a job under a linked parent is never listed', !ids.some((id) => Number(id) > 2300));
  ok('an inactive customer is not listed', !ids.includes('10') && !ids.includes('30'));
  ok('activity was known', res.body.activityKnown === true, r.show(res));
  ok('the window is the last twelve months', res.body.window && /^\d{4}-\d{2}-\d{2}$/.test(res.body.window.start) && res.body.window.start < res.body.window.end, JSON.stringify(res.body.window));
  ok('the reverse view gets the linked customers\' ids', JSON.stringify([...(res.body.linkedClientIds || [])].sort()) === JSON.stringify(['cl_1', 'cl_2']), JSON.stringify(res.body.linkedClientIds));
  ok('🔴 names only: no money in the answer', !/Cents|income|cogs/i.test(JSON.stringify(res.body)));
  ok('🔴 it never writes to QuickBooks: every Intuit call is a GET of a query or a report',
    r.intuitLog.length > 0 && r.intuitLog.every((e) => e.method === 'GET' && (/\/query$/.test(e.url.pathname) || /\/reports\/ProfitAndLoss$/.test(e.url.pathname))),
    r.intuitLog.map((e) => `${e.method} ${e.url.pathname}`).filter((s) => !/query|ProfitAndLoss/.test(s)).join(' | '));
  const pnl = r.pnlUrls();
  ok('the activity is read a chunk of customers at a time, over twelve months, accrual', pnl.length >= 15 && pnl.every((u) => (u.searchParams.get('customer') || '').split(',').length <= 150 && u.searchParams.get('accounting_method') === 'Accrual'), `${pnl.length} reports`);
  r.intuitLog.length = 0;
  const again = await r.call({ path: 'needs-matching', token: 'tok-owner' });
  ok('a second look is served from the cache (QuickBooks not asked)', again.status === 200 && r.intuitLog.length === 0, `${r.intuitLog.length} calls`);
}
world();
{
  r.intuit.fail = (u) => (u.pathname.endsWith('/reports/ProfitAndLoss') ? { status: 503 } : null);
  const res = await r.call({ path: 'needs-matching', token: 'tok-owner' });
  const ids = (res.body.customers || []).map((c) => c.id).sort((a, b) => Number(a) - Number(b));
  ok('🔴 activity that could not be read → activityKnown false, and EVERY active unmatched customer is listed (never a guess)',
    res.status === 200 && res.body.activityKnown === false && ids.join(',') === expected({ activity: false }).join(','), `${r.show(res)} · ${ids.length}`);
}
world({ connected: false });
{
  const res = await r.call({ path: 'needs-matching', token: 'tok-owner' });
  ok('not connected → { connected: false }', res.status === 200 && res.body.connected === false, r.show(res));
}

// ── 5. the nightly refresh reads the activity ───────────────────────────────
const cron = (await import('../api/cron/qbo-refresh.js').catch(() => null))?.default || null;
world();
{
  const res = cron ? await r.call({ using: cron, raw: true, headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }) : { status: 0, body: {} };
  ok('🔴 the nightly run reads the twelve months\' activity too', res.status === 200 && res.body.ok === true && r.world.tables.qbo_report_cache.some((row) => row.cache_key.startsWith('activity:')), r.show(res));
  r.intuitLog.length = 0;
  const list = await r.call({ path: 'needs-matching', token: 'tok-owner' });
  ok('… so the list opens the next morning without asking QuickBooks', list.status === 200 && list.body.activityKnown === true && r.intuitLog.length === 0, `${r.intuitLog.length} calls`);
}

// ── 6. the demo stub ────────────────────────────────────────────────────────
const APP = fileURLToPath(new URL('..', import.meta.url));
const LIB = join(APP, 'src', 'lib');
const tmpRoot = mkdtempSync(join(tmpdir(), 'cs-qbo-matching-'));
async function loadUnder(file, env) {
  const src = readFileSync(join(LIB, file), 'utf8');
  const { code } = await transformWithOxc(src, file, { define: { 'import.meta.env': JSON.stringify(env) } });
  const rewritten = code.replace(/(from\s*['"])(\.\.?\/[^'"]+)(['"])/g, (_, a, spec, b) => {
    let abs = fileURLToPath(new URL(spec, pathToFileURL(join(LIB, file))));
    if (!extname(abs)) abs += '.js';
    return a + pathToFileURL(abs).href + b;
  });
  const tmp = join(tmpRoot, `${file.replace(/\.js$/, '')}.demo.mjs`);
  writeFileSync(tmp, rewritten);
  return import(pathToFileURL(tmp).href);
}
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } };
try {
  const api = await loadUnder('qboApi.js', { PROD: false, MODE: 'demo' });
  ok('the adapter has the list', typeof api.getQboNeedsMatching === 'function');
  if (typeof api.getQboNeedsMatching === 'function') {
    ok('demo: not connected → { connected: false }', (await api.getQboNeedsMatching()).connected === false);
    await api.connectQbo();
    const ents = (await api.listQboEntities('customer')).entities;
    const lasOlas = ents.find((e) => e.name === '0001 Las Olas Medical Group');
    await api.linkQboProperty({ clientId: 'cl_seed_evergreen', entityType: 'customer', entityId: lasOlas.id, entityName: lasOlas.name });
    const got = await api.getQboNeedsMatching();
    const names = got.customers.map((c) => c.name);
    ok('🔴 demo: the unmatched buildings are listed, numbered first', names[0] === '0002 Lakeside Office Park' && names.includes('0008 Ball Harbor Village') && names.includes('0011 Doral Point'), names.join(' | '));
    ok('demo: the linked one is not', !names.includes('0001 Las Olas Medical Group'));
    ok('demo: the inactive and the quiet one, and the quiet management company, are not', !names.includes('0012 Sunset Corporate Center') && !names.includes('0013 Wynwood Creative Lofts') && !names.includes('Graystar Properties'), names.join(' | '));
    ok('demo: a job says whose it is', got.customers.find((c) => c.name === '0010 Aventura Lofts')?.parentName === 'Graystar Properties');
  }
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

// ── 7. the screen ───────────────────────────────────────────────────────────
{
  let card = '';
  try { card = read('../src/components/QboMatchingCard.jsx'); } catch { /* not built yet */ }
  ok('🔴 the list is a screen on the Integrations page', /<QboMatchingCard/.test(read('../src/components/QuickBooksSection.jsx')));
  ok('it reads the list through the adapter', /getQboNeedsMatching\(/.test(card));
  ok('it pages its rows and searches them (UI_RULES §50, §72)', /usePagedRows\(/.test(card) && /<ListPager/.test(card) && /<TableSearch/.test(card));
  ok('it is written on the catalog from its first line (§140): in the converted list', /'src\/components\/QboMatchingCard\.jsx'/.test(read('./test-i18n-coverage.mjs')));
  ok('Link… opens the dialog filled in (preset)', /onLink\(\{/.test(card) && /preset=\{linkPreset\}/.test(read('../src/components/QuickBooksSection.jsx')));
}

finish();
