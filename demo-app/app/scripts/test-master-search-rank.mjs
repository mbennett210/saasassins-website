// Master-search ranking — the pure scoring core (src/lib/masterSearch/rank.js).
// Pins the tier ladder, AND semantics, the joined-query override, the fixed tie order,
// the caps, and DETERMINISM (permuting the input never changes the output).
//
//   node scripts/test-master-search-rank.mjs
import { normalize, terms, tierOf, matchHint, rankEntries, groupRanked, PER_GROUP_CAP } from '../src/lib/masterSearch/rank.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const page = (id, label, keywords = []) => ({ id, label, keywords, kind: 'page', rankBucket: 0, group: 'pages', groupLabel: 'Pages' });
const action = (id, label, keywords = []) => ({ id, label, keywords, kind: 'action', rankBucket: 1, group: 'actions', groupLabel: 'Actions' });
const record = (id, label, keywords = []) => ({ id, label, keywords, kind: 'record', rankBucket: 2, group: 'client', groupLabel: 'Customers', minQueryLen: 2 });

// ── tier ladder ──────────────────────────────────────────────────────────────
const T = (label, q, keywords = []) => tierOf({ label, keywords }, normalize(q), terms(q));
ok('exact label → tier 0', T('Payroll', 'payroll') === 0);
ok('label prefix → tier 1', T('Payroll', 'pay') === 1);
ok('label WORD prefix → tier 2', T('North Shore Dental', 'shore') === 2);
ok('label substring → tier 3', T('North Shore Dental', 'ental') === 3);
ok('keyword-only → tier 4', T('Variance', 'labor', ['labor', 'overtime']) === 4);
ok('no match anywhere → Infinity', T('Payroll', 'zzz') === Infinity);

// ── joined query beats worst-term ─────────────────────────────────────────────
// "north shore" is a prefix of the whole label (tier 1); per-term each is a word-prefix
// (tier 2). The joined override must win.
ok('joined prefix beats worst-term', T('North Shore Dental', 'north shore') === 1);
ok('multi-term AND: every term must hit', T('North Shore Dental', 'north miami') === Infinity);
ok('worst-term decides when no joined hit', T('North Shore Dental', 'north ental') === 3); // north=word-prefix(2), ental=substring(3) → 3

// ── minQueryLen ────────────────────────────────────────────────────────────────
{
  const r1 = rankEntries([record('client:1', 'Acme')], 'a');   // 1 char, record needs 2
  const r2 = rankEntries([record('client:1', 'Acme')], 'ac');
  ok('record excluded below minQueryLen', r1.length === 0);
  ok('record included at minQueryLen', r2.length === 1);
  ok('page matches at 1 char', rankEntries([page('page:/hr', 'HR')], 'h').length === 1);
}

// ── kind/type tie order: page < action < record on equal tier ──────────────────
{
  const entries = [record('r', 'Cleanco'), action('a', 'Cleanco'), page('p', 'Cleanco')];
  const out = rankEntries(entries, 'cleanco'); // all exact → tier 0
  ok('equal tier orders page, action, record', out.map((e) => e.id).join(',') === 'p,a,r');
}

// ── caps + truncation flag ─────────────────────────────────────────────────────
{
  const many = Array.from({ length: 7 }, (_, i) => page(`page:/p${i}`, `Portal ${i}`));
  const groups = groupRanked(rankEntries(many, 'portal'));
  ok('one group produced', groups.length === 1);
  ok(`group capped at ${PER_GROUP_CAP}`, groups[0].items.length === PER_GROUP_CAP);
  ok('group flagged truncated', groups[0].truncated === true && groups[0].totalCount === 7);
}

// ── group ordering by best tier, then rankBucket ───────────────────────────────
{
  // record 'Acme' is an exact hit (tier 0); page 'Accounts' only a prefix (tier 1).
  // The record's group should sort ABOVE pages despite pages' lower rankBucket.
  const groups = groupRanked(rankEntries([page('page:/x', 'Accounts'), record('client:1', 'Ac')], 'ac'));
  ok('stronger record group floats above pages', groups[0].key === 'client');
}
{
  // equal tier: pages before records
  const groups = groupRanked(rankEntries([record('client:1', 'Acme'), page('page:/x', 'Acme')], 'acme'));
  ok('equal-tier groups keep pages-first', groups[0].key === 'pages');
}

// ── determinism: permuting input yields identical output ───────────────────────
{
  const base = [
    page('page:/hr', 'HR'), page('page:/payroll', 'Payroll'),
    action('action:add', 'Add pay item'), record('client:1', 'Pay Plaza'),
    record('client:2', 'Payton LLC'), record('invoice:CS-1', 'CS-PAY'),
  ];
  const q = 'pay';
  const run = (arr) => rankEntries(arr, q).map((e) => e.id).join('|');
  const a = run(base);
  const shuffled = [...base].reverse();
  const b = run(shuffled);
  const shuffled2 = [base[3], base[0], base[5], base[1], base[4], base[2]];
  const c = run(shuffled2);
  ok('permuted input → identical order', a === b && a === c);
  ok('same input twice → identical order', run(base) === run(base));
}

// ── match hint: a keyword-only hit explains itself ────────────────────────────────
{
  const e = { label: 'Invoices', keywords: ['Billing', 'Payments'] };
  ok('hint names the keyword that matched (original casing)', matchHint(e, terms('pay')) === 'Payments');
  ok('no hint when the label itself matched', matchHint(e, terms('inv')) === '');
  const [r] = rankEntries([page('page:/invoices', 'Invoices', ['Billing', 'Payments'])], 'pay');
  ok('ranked tier-4 entries carry their hint', r.tier === 4 && r.hint === 'Payments');
  const [r2] = rankEntries([page('page:/payroll', 'Payroll')], 'pay');
  ok('label matches carry no hint', r2.hint === '');
}

// ── per-record relevance order breaks ties between same-labelled rows ───────────────
{
  const far = { ...record('job:far', 'Coral Bay HOA'), order: 500 };
  const near = { ...record('job:near', 'Coral Bay HOA'), order: 5 };
  const out = rankEntries([far, near], 'coral');
  ok('same label → lower `order` first (nearest clean first)', out[0].id === 'job:near');
}

// ── per-group caps: pages/actions carry a larger cap than records ───────────────────
{
  const many = Array.from({ length: 10 }, (_, i) => ({ ...page(`page:/p${i}`, `Portal ${i}`), groupCap: 8 }));
  const [g] = groupRanked(rankEntries(many, 'portal'));
  ok('groupCap on entries overrides the default cap', g.items.length === 8 && g.truncated && g.totalCount === 10);
}

// ── precomputed normalized text is honoured (no per-keystroke re-normalize) ─────────
{
  const e = { label: 'IGNORED', keywords: [], _l: 'north shore dental', _k: [] };
  ok('tierOf reads _l when present', tierOf(e, 'north', terms('north')) === 1);
}

// ── normalize collapses whitespace/case (searchRows parity) ─────────────────────
ok('normalize lowercases + collapses', normalize('  North   SHORE ') === 'north shore');
ok('terms splits on whitespace', terms('a  b\tc').join(',') === 'a,b,c');

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\nmaster-search rank: ${pass}/${pass} passed`);
