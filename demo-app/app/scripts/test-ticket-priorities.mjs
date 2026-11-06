// WO-18 (Matt, 2026-09-30 follow-up): "lets make a change put low, medium, urgent".
// THREE ticket priorities, not four — "high" is gone, and every ticket that carried it
// reads as URGENT (Daniel's call: none of them gets quieter). The response targets are
// urgent 2 hours, medium 1 day, low 3 days.
//
// PURE + node-safe: everything here is asserted against the SOURCE-OF-TRUTH module
// (src/lib/workOrders.js) or read off disk, never against a restated literal — so the
// day someone retunes a target the test follows it instead of pinning a stale number.
//
//   node app/scripts/test-ticket-priorities.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
// A file that does not exist yet reads as '' so its checks FAIL rather than ending the run.
const read = (p) => { try { return readFileSync(root(p), 'utf8'); } catch { return ''; } };

let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) pass += 1; else fails.push(d ? `${n} — ${d}` : n); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
// A check whose SUBJECT may not exist yet on the pre-change tree (a missing export, a
// migration file that is not there) must still read as one failed check, not end the run
// — THE LAW II.3 wants the whole pre-fix failure list, not its first line.
const call = (fn, ...args) => { try { return fn(...args); } catch (e) { return `threw: ${e?.message || e}`; } };

const {
  WO_PRIORITIES, WO_PRIORITY_META, DEFAULT_WO_PRIORITY, SLA_HOURS,
  normalizePriority, woPriorityLabel, woPriorityRank, severityToPriority,
  slaTargetLabel, toWorkOrder, computeDueAt,
  RETIRED_PRIORITY, RETIRED_PRIORITY_BECOMES,
} = await import('../src/lib/workOrders.js');

const HOUR = 3600 * 1000;

// ── A. The vocabulary is exactly three, urgent first ─────────────────────────
eq('A1: the priorities are urgent, medium, low', WO_PRIORITIES, ['urgent', 'medium', 'low']);
ok('A2: "high" is not a priority any more', !WO_PRIORITIES.includes('high'));
ok('A3: …and carries no metadata', !('high' in WO_PRIORITY_META));
eq('A4: every priority has metadata', WO_PRIORITIES.filter((p) => !WO_PRIORITY_META[p]), []);
eq('A5: metadata names no priority outside the list', Object.keys(WO_PRIORITY_META).filter((p) => !WO_PRIORITIES.includes(p)), []);
eq('A6: medium is still the default', DEFAULT_WO_PRIORITY, 'medium');
ok('A7: the default is one of the three', WO_PRIORITIES.includes(DEFAULT_WO_PRIORITY));

// Ranks order the queue: urgent above medium above low, with no ties.
{
  const ranks = WO_PRIORITIES.map((p) => woPriorityRank(p));
  eq('A8: the ranks run 0,1,2 in list order', ranks, [0, 1, 2]);
  eq('A9: …and are all distinct', new Set(ranks).size, ranks.length);
}

// ── B. The three still LOOK different (urgent red · medium amber · low slate) ─
eq('B1: urgent is red', WO_PRIORITY_META.urgent.badge, 'red');
eq('B2: medium is amber', WO_PRIORITY_META.medium.badge, 'amber');
eq('B3: low is slate', WO_PRIORITY_META.low.badge, 'slate');
eq('B4: no two priorities share a badge variant',
  new Set(WO_PRIORITIES.map((p) => WO_PRIORITY_META[p].badge)).size, WO_PRIORITIES.length);

// The row/drawer chip is a CSS class per priority (`wo-pri pri-<priority>`), so each of
// the three needs its own rule and the retired one must not linger.
{
  const css = read('src/index.css');
  for (const p of WO_PRIORITIES) {
    ok(`B5: index.css styles .pri-${p}`, css.includes(`.wo-pri.pri-${p}`));
    ok(`B6: …and its dot`, css.includes(`.pri-${p} .wo-dot`));
  }
  ok('B7: the retired .pri-high rule is gone', !css.includes('pri-high'));
}

// ── C. "high" NORMALIZES TO URGENT — never to the default ────────────────────
// Daniel's call: an existing high ticket becomes urgent, so none of them gets quieter.
eq('C1: normalizePriority("high") is urgent', normalizePriority('high'), 'urgent');
eq('C2: a legacy row reads urgent', toWorkOrder({ priority: 'high' }).priority, 'urgent');
eq('C3: the legacy severity "high" maps to urgent too', severityToPriority('high'), 'urgent');
eq('C4: …and the other severities are unchanged',
  ['low', 'med'].map(severityToPriority), ['low', DEFAULT_WO_PRIORITY]);
eq('C5: an unknown priority still falls to the default', normalizePriority('whatever'), DEFAULT_WO_PRIORITY);
eq('C6: …and so does an absent one', normalizePriority(undefined), DEFAULT_WO_PRIORITY);
eq('C7: the three normalize to themselves', WO_PRIORITIES.map(normalizePriority), WO_PRIORITIES);
eq('C8: the label for a legacy "high" says Urgent', woPriorityLabel(normalizePriority('high')), WO_PRIORITY_META.urgent.label);

// ── D. The response targets: urgent 2 h, medium 1 day, low 3 days ────────────
eq('D1: SLA_HOURS covers exactly the three priorities', Object.keys(SLA_HOURS).sort(), [...WO_PRIORITIES].sort());
eq('D2: urgent is 2 hours', SLA_HOURS.urgent, 2);
eq('D3: medium is one day', SLA_HOURS.medium, 24);
eq('D4: low is three days', SLA_HOURS.low, 72);
ok('D5: the targets get looser down the list',
  WO_PRIORITIES.every((p, i) => i === 0 || SLA_HOURS[WO_PRIORITIES[i - 1]] < SLA_HOURS[p]));

// The deadline a legacy "high" ticket is judged against is URGENT's, derived from the
// one table — not restated here.
{
  const created = '2026-10-03T10:00:00.000Z';
  eq('D6: a legacy high ticket is due on the urgent clock',
    computeDueAt(created, 'high'),
    new Date(Date.parse(created) + SLA_HOURS.urgent * HOUR).toISOString());
  eq('D7: …and a medium one on the medium clock',
    computeDueAt(created, 'medium'),
    new Date(Date.parse(created) + SLA_HOURS.medium * HOUR).toISOString());
}

// The settings help text says the targets in words, so there is one phrasing of "1 day".
eq('D8: the urgent target reads in hours', call(slaTargetLabel, 'urgent'), '2 hours');
eq('D9: the medium target reads as a day', call(slaTargetLabel, 'medium'), '1 day');
eq('D10: the low target reads in days', call(slaTargetLabel, 'low'), '3 days');
eq('D11: a legacy high reads as urgent does', call(slaTargetLabel, 'high'), call(slaTargetLabel, 'urgent'));

// ── E. "high" is gone from every surface that offers or stores a priority ────
// Mechanical, so a new surface cannot quietly reintroduce it. src/lib/workOrders.js is
// not on the list because it OWNS the retirement seam — checked on its own terms below.
const PRIORITY_SURFACES = [
  'src/lib/qcApi.js',
  'src/components/WorkOrderModal.jsx',
  'src/components/WorkOrdersPanel.jsx',
  'src/components/WorkOrderDrawer.jsx',
  'src/pages/ClientRequests.jsx',
  'src/pages/settings/Operations.jsx',
  'api/_lib/qc/store.js',
];
for (const f of PRIORITY_SURFACES) {
  const src = read(f);
  ok(`E1: ${f} offers no 'high' priority`, !/['"]high['"]/.test(src.replace(/^\s*\/\/.*$/gm, '')));
}
// The owning module may name the retired level ONCE, as the named seam the normalizer
// reads — never as a live option in the list, the metadata or the SLA table.
{
  const src = read('src/lib/workOrders.js').replace(/^\s*\/\/.*$/gm, '');
  const mentions = (src.match(/['"]high['"]/g) || []).length;
  eq('E1a: workOrders.js names the retired level exactly once', mentions, 1);
  ok('E1b: …as the named RETIRED_PRIORITY seam', /RETIRED_PRIORITY\s*=\s*'high'/.test(src));
  eq('E1c: …which normalizes up to urgent', RETIRED_PRIORITY_BECOMES, 'urgent');
  eq('E1d: …and is not one of the three', WO_PRIORITIES.includes(RETIRED_PRIORITY), false);
}
// The demo seed and the backend seed script both build work orders; neither may ship one.
for (const f of ['src/data/demoStubs.js', 'scripts/seed-backend.mjs']) {
  ok(`E2: ${f} seeds no 'high' work order`, !/priority:\s*['"]high['"]/.test(read(f)));
}
// The backend seed restates the SLA table; it must restate THIS one.
{
  const seed = read('scripts/seed-backend.mjs');
  const m = seed.match(/const SLA_HOURS = \{[^}]*\}/);
  ok('E3: seed-backend still declares an SLA table', !!m);
  if (m) {
    for (const p of WO_PRIORITIES) ok(`E4: …covering ${p} at ${SLA_HOURS[p]}h`, m[0].includes(`${p}: ${SLA_HOURS[p]}`));
    ok('E5: …and nothing for high', !m[0].includes('high'));
  }
}

// ── F. The data migration moves the stored rows ──────────────────────────────
// The verdict normalizes on READ, so no row can display wrong — but the column still has
// to move, or the CHECK constraint and every direct query keep a value the app denies.
{
  const sql = read('../supabase/migrations/20261003100000_work_order_priority_three.sql');
  ok('F1: the migration updates priority high → urgent',
    /update\s+problem_reports[\s\S]*set\s+priority\s*=\s*'urgent'[\s\S]*where\s+priority\s*=\s*'high'/i.test(sql));
  ok('F2: …drops the old CHECK constraint', /drop constraint if exists problem_reports_priority_check/i.test(sql));
  ok('F3: …and adds one naming exactly the three',
    new RegExp(`add\\s+constraint\\s+problem_reports_priority_check\\s+check\\s*\\(\\s*priority\\s+in\\s*\\(${WO_PRIORITIES.map((p) => `'${p}'`).join(',')}\\)`, 'i')
      .test(sql.replace(/\s*,\s*/g, ',')));
  ok('F4: …and re-points the due_at backfill at the new targets',
    WO_PRIORITIES.every((p) => new RegExp(`when\\s+'${p}'\\s+then\\s+interval\\s+'${SLA_HOURS[p]} hours'`, 'i').test(sql)));
  ok('F5: the migration is idempotent on a second run',
    /where\s+priority\s*=\s*'high'/i.test(sql));
}

console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error('  ✗ ' + f);
process.exitCode = fails.length === 0 ? 0 : 1;
