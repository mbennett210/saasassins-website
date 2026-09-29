// The Quality hub's Inspections tab reads what its filters ask for. Pre-existing bug, the
// same class as the Customer › Inspections tab (S76), fixed 2026-09-23 (S83): the hub
// (pages/Inspections.jsx) read the ORG's newest 200 inspections (qcApi.listInspections({})
// → api/_lib/qc/store.js listInspections) and applied its Locations / Result / Inspector /
// Date-range facets to that slice in the browser; its stat cards and its Export CSV ran
// over the filtered slice, and it ignored `truncated`. Once the org passed 200 inspections,
// a location's, an inspector's or an older range's inspections fell out of the list, the
// cards were figures over a partial set, and the CSV silently exported a partial set.
// Now the facets run in the server read, the cards are tallied over EVERY match, the CSV
// reads every match (refused past its cap, never cut short), and a capped list says so.
//
// Offline, four layers:
//   A. the server store, against scripts/fake-postgrest.mjs (db-max-rows 1000, like Supabase)
//   B. the demo stub in lib/qcApi.js, imported under plain node (no VITE env → stub mode)
//   C. the facet → query conversion (lib/filters/inspectionFilters inspectionListQuery)
//   D. the route, adapter and page wiring, by source shape (the route needs a live session
//      and the page a browser; both were driven when this landed)
//   node app/scripts/test-hub-inspections.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { fakeDb } from './fake-postgrest.mjs';
import { installResolveShim } from './deletion-core.mjs';
import * as store from '../api/_lib/qc/store.js';
import * as queryParams from '../api/_lib/queryParams.js';
import { CLEANSPACE_ORG_ID as ORG } from '../api/_lib/constants.js';
import * as inspectionsLib from '../src/lib/inspections.js';

installResolveShim(); // Vite writes extensionless imports; plain node needs `.js`
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (...p) => import(pathToFileURL(path.join(APP, 'src', 'lib', ...p)).href);
const { rangeBounds } = await load('filters', 'applyFilters.js');
const { fetchAllPages } = await load('pagedFetch.js');
const { startOfDayKey, addDaysKey, dayKey } = await load('dates.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };
// A read that throws is a failed assertion with its message, not a crashed suite.
const attempt = async (fn) => { try { return { v: await fn() }; } catch (e) { return { e }; } };
const why = (r) => (r.e ? ` [threw: ${r.e.message}]` : '');

const LIMIT = inspectionsLib.INSPECTION_LIST_LIMIT;
ok(Number.isInteger(LIMIT) && LIMIT > 0, 'L0: the list cap is the shared constant (lib/inspections INSPECTION_LIST_LIMIT)');

// The figures can't depend on the order the records arrive in: the server's complete read
// pages oldest-first, the stub sorts newest-first. Here a tie on performed_at straddles
// the trend's two halves; newest-first with ties by id puts a3 in the newer half.
{
  const at = (m) => new Date(Date.parse('2026-03-01T12:00:00.000Z') + m * 60000).toISOString();
  const four = [
    { id: 'a1', status: 'submitted', overall_score: 100, result: 'pass', performed_at: at(2) },
    { id: 'a2', status: 'submitted', overall_score: 40, result: 'fail', performed_at: at(1) },
    { id: 'a3', status: 'submitted', overall_score: 90, result: 'pass', performed_at: at(1) },
    { id: 'a4', status: 'submitted', overall_score: 60, result: 'pass', performed_at: at(0) },
  ];
  const fig = (rows) => { try { return inspectionsLib.inspectionFigures(rows); } catch { return null; } };
  const asc = fig([four[3], four[1], four[2], four[0]]);
  const desc = fig([four[0], four[2], four[1], four[3]]);
  ok(asc?.delta === 45 && desc?.delta === 45 && asc.recentAvg === 95 && asc.priorAvg === 50,
    `L1: the figures split a tie by id whatever order the records arrive in (trend +45: 95 vs 50) [asc ${asc?.delta}, desc ${desc?.delta}]`);
}

// ── fixture: an org well past the cap; the busiest customer holds the org's newest 200 ──
const BASE = Date.parse('2026-01-05T15:00:00.000Z');
const MIN = 60000;
const DAY = 1440 * MIN;
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
function rec(siteId, clientId, t, extra = {}) {
  seq += 1;
  return {
    id: `in_${String(seq).padStart(5, '0')}`, organization_id: ORG,
    client_id: clientId, site_id: siteId, client_name: `Customer ${clientId}`, site_name: `Site ${siteId}`,
    inspector_user_id: 'u_mgr', inspector_name: 'Manager',
    overall_score: 90, result: 'pass', status: 'submitted', public_token: `tok_${seq}`,
    performed_at: iso(t), template_snapshot: { name: `Walkthrough ${siteId}`, schema: { areas: [] }, pad: 'x'.repeat(40) },
    ...extra,
  };
}
const draft = { status: 'draft', overall_score: null, result: null };
const ALL = [];
// s_old: 30 inspections in January, the org's OLDEST, by Ana; every 3rd failed.
for (let i = 0; i < 30; i += 1) {
  ALL.push(rec('s_old', 'c_old', BASE + i * 6 * 60 * MIN, {
    inspector_user_id: 'u_ana', inspector_name: 'Ana',
    ...(i % 3 === 0 ? { result: 'fail', overall_score: 55 + i } : { overall_score: 82 + (i % 10) }),
  }));
}
// c_mid: 260 over two sites from late January, timestamps in PAIRS (a tie straddles
// the cap); Ana, Ben (every 3rd) and the crew member (every 13th); fails, follow-ups and
// drafts mixed in.
for (let i = 0; i < 260; i += 1) {
  const who = i % 13 === 0 ? ['u_crew', 'Crew'] : i % 3 === 0 ? ['u_ben', 'Ben'] : ['u_ana', 'Ana'];
  let extra = { overall_score: 80 + (i % 20) };
  if (i % 5 === 0) extra = { result: 'fail', overall_score: 50 + (i % 25) };
  else if (i % 11 === 0) extra = { result: 'needs_follow_up', overall_score: 70 };
  if (i % 9 === 0) extra = draft;
  ALL.push(rec(i % 2 ? 's_mid_b' : 's_mid_a', 'c_mid', BASE + 20 * DAY + Math.floor((i + 1) / 2) * 120 * MIN, {
    inspector_user_id: who[0], inspector_name: who[1], ...extra,
  }));
}
// c_busy: 400, the org's NEWEST (from May), by the manager — so they ARE the org's newest 200.
for (let i = 0; i < 400; i += 1) {
  ALL.push(rec('s_busy', 'c_busy', BASE + 120 * DAY + i * 30 * MIN, {
    overall_score: 88 + (i % 12),
    ...(i % 17 === 0 ? { result: 'fail', overall_score: 60 } : {}),
    ...(i % 10 === 0 ? draft : {}),
  }));
}
// s_edge: one inspection in the LAST MINUTE of Jan 31 in the org's zone (23:59:30 PST =
// 07:59:30Z Feb 1). A range ending Jan 31 must hold it; the engine used to end days at
// 23:59:00 and drop it from both January and February (review finding, S83).
const EDGE_AT = '2026-02-01T07:59:30.000Z';
ALL.push(rec('s_edge', 'c_edge', Date.parse(EDGE_AT)));

// The truth, computed HERE from the fixture — never through the code under test.
const t = (r) => Date.parse(r.performed_at);
const newestFirst = (a, b) => (t(b) - t(a)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const matching = (pred) => ALL.filter(pred).sort(newestFirst);
const ids = (rows) => (Array.isArray(rows) ? rows.map((r) => r.id) : []);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);
function figuresOf(set) {
  const scored = set.filter((r) => r.status === 'submitted' && r.overall_score != null).sort(newestFirst);
  const n = scored.length;
  const half = Math.floor(n / 2);
  const recent = avg(scored.slice(0, n - half).map((r) => r.overall_score));
  const prior = avg(scored.slice(n - half).map((r) => r.overall_score));
  return {
    total: set.length, count: n, avgScore: avg(scored.map((r) => r.overall_score)),
    delta: n >= 2 ? recent - prior : null,
    failCount: set.filter((r) => r.result === 'fail' || r.result === 'needs_follow_up').length,
  };
}
const sameFigures = (a, b) => !!a && ['total', 'count', 'avgScore', 'delta', 'failCount'].every((k) => a[k] === b[k]);
const EXPORT_KEYS = ['id', 'performed_at', 'client_id', 'site_id', 'client_name', 'site_name', 'template_name', 'overall_score', 'result', 'inspector_name'];
const exportRow = (r) => Object.fromEntries(EXPORT_KEYS.map((k) => [k, k === 'template_name' ? r.template_snapshot.name : r[k]]));
const canon = (o) => JSON.stringify(Object.keys(o || {}).sort().map((k) => [k, o[k]]));
const sameRows = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => canon(x) === canon(b[i]));

// Every facet, alone and together; each with its own predicate, written out here.
const inRange = (from, to) => (r) => (from == null || t(r) >= Date.parse(from)) && (to == null || t(r) <= Date.parse(to));
const JAN_FROM = iso(BASE - DAY);
const JAN_TO = iso(BASE + 30 * DAY);
const COMBOS = [
  { name: 'no filter (the hub as it opens)', f: {}, pred: () => true },
  { name: 'one old location', f: { siteIds: ['s_old'] }, pred: (r) => r.site_id === 's_old' },
  { name: 'two locations', f: { siteIds: ['s_old', 's_mid_b'] }, pred: (r) => r.site_id === 's_old' || r.site_id === 's_mid_b' },
  { name: 'both mid locations (past the cap)', f: { siteIds: ['s_mid_a', 's_mid_b'] }, pred: (r) => r.client_id === 'c_mid' },
  { name: 'an inspector', f: { inspectorIds: ['u_ben'] }, pred: (r) => r.inspector_user_id === 'u_ben' },
  { name: 'failed + follow-up', f: { results: ['fail', 'needs_follow_up'] }, pred: (r) => r.result === 'fail' || r.result === 'needs_follow_up' },
  { name: 'an older date range', f: { fromIso: JAN_FROM, toIso: JAN_TO }, pred: inRange(JAN_FROM, JAN_TO) },
  { name: 'a range with no end', f: { fromIso: iso(BASE + 125 * DAY) }, pred: inRange(iso(BASE + 125 * DAY), null) },
  { name: 'a range with no start', f: { toIso: iso(BASE + 25 * DAY) }, pred: inRange(null, iso(BASE + 25 * DAY)) },
  {
    name: 'all four at once',
    f: { siteIds: ['s_mid_a', 's_mid_b', 's_old'], results: ['fail'], inspectorIds: ['u_ana', 'u_crew'], fromIso: JAN_FROM, toIso: iso(BASE + 60 * DAY) },
    pred: (r) => ['s_mid_a', 's_mid_b', 's_old'].includes(r.site_id) && r.result === 'fail'
      && ['u_ana', 'u_crew'].includes(r.inspector_user_id) && inRange(JAN_FROM, iso(BASE + 60 * DAY))(r),
  },
];

const orgNewest = matching(() => true).slice(0, LIMIT);
ok(orgNewest.every((r) => r.client_id === 'c_busy'), 'fixture: the org\'s newest records all belong to c_busy');
const midAll = matching((r) => r.client_id === 'c_mid');
ok(midAll.length > LIMIT && t(midAll[LIMIT - 1]) === t(midAll[LIMIT]), 'fixture: c_mid runs past the cap, with a timestamp tie straddling it');
for (const c of COMBOS) ok(matching(c.pred).length > 0, `fixture: "${c.name}" matches something`);

// ── A. the server store ─────────────────────────────────────────────────────────
const db = (opts = {}) => fakeDb({ inspection_records: ALL.slice() }, { maxRows: 1000, ...opts });
{
  // Control: what the hub used to do — the org's newest 200, filtered in the browser.
  const org = await attempt(() => store.listInspections({}, db()));
  const slice = org.v?.inspections || [];
  const lost = COMBOS.filter((c) => c.name !== 'no filter (the hub as it opens)')
    .filter((c) => slice.filter(c.pred).length < Math.min(LIMIT, matching(c.pred).length));
  ok(slice.length === LIMIT && lost.length >= 8,
    `A0 (control): narrowing the org's newest ${LIMIT} in the browser loses rows for ${lost.length} of ${COMBOS.length - 1} filters (e.g. "one old location" → ${slice.filter(COMBOS[1].pred).length} of 30)${why(org)}`);

  for (const c of COMBOS) {
    const truth = matching(c.pred);
    const got = await attempt(() => store.listInspections(c.f, db()));
    ok(same(ids(got.v?.inspections), ids(truth.slice(0, LIMIT))) && got.v?.truncated === (truth.length > LIMIT),
      `A1 list, ${c.name}: the newest ${Math.min(LIMIT, truth.length)} of the ${truth.length} that match, newest first, truncated=${truth.length > LIMIT}${why(got)}`);
  }

  const tight = await attempt(() => store.listInspections({ siteIds: ['s_mid_a', 's_mid_b'] }, db({ maxRows: 64 })));
  ok(same(ids(tight.v?.inspections), ids(midAll.slice(0, LIMIT))) && tight.v?.truncated === true,
    `A2: under a db-max-rows of 64 a filtered list still means ${LIMIT} rows, truncated exact${why(tight)}`);

  const scope = { clientIds: [], siteIds: ['s_mid_a'], userId: 'u_crew' };
  const crewTruth = matching((r) => (r.site_id === 's_mid_a' || r.inspector_user_id === 'u_crew') && r.result === 'fail');
  const crew = await attempt(() => store.listInspections({ results: ['fail'], crewScope: scope }, db()));
  ok(crewTruth.length > 0 && same(ids(crew.v?.inspections), ids(crewTruth.slice(0, LIMIT))),
    `A3: crew scope still applies under a filter — only their site's rows + their own${why(crew)}`);
  const outside = await attempt(() => store.listInspections({ siteIds: ['s_old'], crewScope: scope }, db()));
  ok(!outside.e && ids(outside.v?.inspections).length === 0,
    `A4: a location outside the crew member's scope reads nothing — a filter narrows, never widens${why(outside)}`);

  const empty = await attempt(() => store.listInspections({ siteIds: [] }, db()));
  const junk = await attempt(() => store.listInspections({ inspectorIds: ['x),client_id.in.(c_busy'] }, db()));
  ok(!empty.e && ids(empty.v?.inspections).length === 0 && !junk.e && ids(junk.v?.inspections).length === 0,
    `A5: an empty id list, or one of only malformed ids, keeps nothing — never an org-wide read${why(empty)}${why(junk)}`);

  // inspection_records.id is a uuid: `eq('id', '__none__')` is a 22P02 there, not "no rows".
  const typed = { uuidColumns: { inspection_records: ['id'] } };
  const noScope = await attempt(() => store.listInspections({ crewScope: { clientIds: [], siteIds: [], userId: null } }, db(typed)));
  const typedEmpty = await attempt(() => store.listInspections({ siteIds: [] }, db(typed)));
  ok(!noScope.e && ids(noScope.v?.inspections).length === 0 && !typedEmpty.e && ids(typedEmpty.v?.inspections).length === 0,
    `A6: "no rows" is a valid filter on a uuid key — a crew member with no scope gets an empty list, not a database error${why(noScope)}${why(typedEmpty)}`);

  // Figures: every match, not the list's newest 200.
  const listFigures = figuresOf(orgNewest);
  const allFigures = figuresOf(matching(() => true));
  ok(listFigures.total !== allFigures.total && listFigures.avgScore !== allFigures.avgScore,
    'A7 (control): figures over the list\'s newest 200 are not the org\'s figures');
  for (const c of COMBOS) {
    const truth = figuresOf(matching(c.pred));
    const got = await attempt(() => store.inspectionFiguresMatching(c.f, {}, db()));
    ok(sameFigures(got.v, truth),
      `A8 figures, ${c.name}: total ${truth.total}, scored ${truth.count}, avg ${truth.avgScore}, trend ${truth.delta}, failed ${truth.failCount} — over every match${got.v ? ` (got ${canon(got.v)})` : ''}${why(got)}`);
  }
  const figTight = await attempt(() => store.inspectionFiguresMatching({}, {}, db({ maxRows: 64 })));
  ok(sameFigures(figTight.v, allFigures), `A9: figures are complete under a db-max-rows of 64${why(figTight)}`);
  const figCap = await attempt(() => store.inspectionFiguresMatching({}, { maxRows: 100 }, db()));
  ok(figCap.e?.name === 'TooManyRowsError', `A10: past its row bound the figures read is REFUSED (413), never a partial tally${figCap.e ? ` [${figCap.e.name}]` : ''}`);
  const figCrew = await attempt(() => store.inspectionFiguresMatching({ results: ['fail'], crewScope: scope }, {}, db()));
  ok(sameFigures(figCrew.v, figuresOf(crewTruth)), `A11: the figures keep crew scope${why(figCrew)}`);

  // Export: every match, read the way the browser reads it — lib/pagedFetch.js over the
  // route's pages (the first carrying the count). Small pages here, so a read spans many
  // pages and their overlaps; the rows come back newest first in the CSV's columns.
  const exportAll = (f, dbx, pageSize = 2000) => fetchAllPages({
    pageSize,
    backoffMs: 1,
    fetchPage: async (offset, limit) => ({
      rows: await store.pageInspectionsForExport(f, { offset, limit }, dbx),
      total: offset === 0 ? await store.countInspectionsMatching(f, dbx) : null,
      limit,
    }),
  });
  for (const c of COMBOS) {
    const n = await attempt(() => store.countInspectionsMatching(c.f, db()));
    ok(n.v === matching(c.pred).length, `A12 count, ${c.name}: ${matching(c.pred).length}${why(n)}`);
  }
  for (const c of [COMBOS[0], COMBOS[1], COMBOS[3], COMBOS[9]]) {
    const truth = matching(c.pred).map(exportRow);
    const got = await attempt(() => exportAll(c.f, db(), 150));
    ok(sameRows(got.v, truth),
      `A13 export, ${c.name}: all ${truth.length} matches (not the newest ${LIMIT}), each once, newest first, the CSV's columns with the template name out of the snapshot${why(got)}`);
  }
  const expTight = await attempt(() => exportAll({}, db({ maxRows: 64 })));
  ok(sameRows(expTight.v, matching(() => true).map(exportRow)), `A14: the export is complete under a db-max-rows of 64 (2,000-row pages filled past it)${why(expTight)}`);
  const page = await attempt(() => store.pageInspectionsForExport({}, { offset: 250, limit: 100 }, db({ maxRows: 64 })));
  ok(same(ids(page.v), ids(matching(() => true).slice(250, 350))), `A15: one export page is exactly rows [offset, offset + limit) of the newest-first order${why(page)}`);
  const expCrew = await attempt(() => exportAll({ crewScope: scope }, db(), 150));
  const expCrewTruth = matching((r) => r.site_id === 's_mid_a' || r.inspector_user_id === 'u_crew').map(exportRow);
  ok(sameRows(expCrew.v, expCrewTruth), `A15b: the export keeps crew scope${why(expCrew)}`);

  // The last minute of a day belongs to that day (review finding): a range ending Jan 31
  // holds the 23:59:30 inspection, and February's doesn't.
  const q = (await load('filters', 'inspectionFilters.js')).inspectionListQuery;
  const query = (values) => (typeof q === 'function' ? q(values) : {});
  const jan = query({ loc: ['s_edge'], range: { preset: '__custom', from: '2026-01-01', to: '2026-01-31' } });
  const feb = query({ loc: ['s_edge'], range: { preset: '__custom', from: '2026-02-01', to: '2026-02-28' } });
  const inJan = await attempt(() => store.listInspections(jan.filters, db()));
  const inFeb = await attempt(() => store.listInspections(feb.filters, db()));
  ok(jan.filters?.toIso === '2026-02-01T07:59:59.999Z' && ids(inJan.v?.inspections).length === 1 && inJan.v.inspections[0].performed_at === EDGE_AT
    && ids(inFeb.v?.inspections).length === 0,
  `A17: a range ending Jan 31 runs to 23:59:59.999 org time and holds the 23:59:30 inspection; February's doesn't [toIso ${jan.filters?.toIso}]${why(inJan)}`);

  // The Reports tally rides the same filter helper (results is now a list).
  const window = { fromIso: JAN_FROM, toIso: iso(BASE + 200 * DAY) };
  const fails = await attempt(() => store.listInspectionsInWindow({ ...window, results: ['fail'], submittedOnly: true }, {}, db()));
  const failTruth = ALL.filter((r) => r.result === 'fail' && r.status !== 'draft' && inRange(window.fromIso, window.toIso)(r));
  ok(Array.isArray(fails.v) && fails.v.length === failTruth.length && fails.v.every((r) => r.result === 'fail'),
    `A16: the Reports window read filters by result through the same helper (${failTruth.length} failed)${why(fails)}`);
}

// ── B. the demo stub (the same contract, over the local records) ─────────────────
{
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => { mem.set(k, String(v)); },
    removeItem: (k) => { mem.delete(k); },
  };
  const qcApi = await import(pathToFileURL(path.join(APP, 'src', 'lib', 'qcApi.js')).href);
  ok(qcApi.isQcStub(), 'B0: under plain node qcApi runs its demo stub');
  // Stored out of order: the stub must sort, not trust insertion order.
  const shuffled = ALL.map((r, i) => [(i * 7919) % ALL.length, r]).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
  mem.set('cleanspace_qc_inspections_stub_v1', JSON.stringify({ inspections: shuffled }));

  for (const c of COMBOS) {
    const truth = matching(c.pred);
    const got = await attempt(() => qcApi.listInspections(c.f));
    ok(same(ids(got.v?.inspections), ids(truth.slice(0, LIMIT))) && got.v?.truncated === (truth.length > LIMIT),
      `B1 stub list, ${c.name}: the newest ${Math.min(LIMIT, truth.length)} of ${truth.length}, truncated=${truth.length > LIMIT}${why(got)}`);
    const fig = await attempt(() => qcApi.inspectionFigures(c.f));
    ok(sameFigures(fig.v, figuresOf(truth)), `B2 stub figures, ${c.name}: the same figures as the server tally${why(fig)}`);
  }
  for (const c of [COMBOS[0], COMBOS[3], COMBOS[9]]) {
    const got = await attempt(() => qcApi.exportInspections(c.f));
    ok(sameRows(got.v, matching(c.pred).map(exportRow)), `B3 stub export, ${c.name}: every match, in the server's export columns${why(got)}`);
  }
  // An empty facet is no facet: the adapter never sends (or stubs) an empty list as "nothing".
  const blank = await attempt(() => qcApi.listInspections({ siteIds: [], results: [], inspectorIds: [] }));
  ok(same(ids(blank.v?.inspections), ids(orgNewest)), `B4: empty lists from the page are "no filter", in both modes${why(blank)}`);
  mem.delete('cleanspace_qc_inspections_stub_v1');
}

// ── C. the facet values → the server's filters ──────────────────────────────────
{
  const mod = await attempt(() => import(pathToFileURL(path.join(APP, 'src', 'lib', 'filters', 'inspectionFilters.js')).href));
  const q = mod.v?.inspectionListQuery;
  ok(typeof q === 'function', `C0: lib/filters/inspectionFilters exports inspectionListQuery${why(mod)}`);
  const run = (values, now) => { try { return q(values, now); } catch (e) { return { thrown: e.message }; } };
  const now = new Date('2026-09-23T18:30:00.000Z');
  if (typeof q === 'function') {
    const all = run({ loc: ['s1', 's2'], result: ['fail'], inspector: ['u1'], range: null }, now);
    ok(canon(all.filters) === canon({ siteIds: ['s1', 's2'], results: ['fail'], inspectorIds: ['u1'], fromIso: null, toIso: null }),
      `C1: each facet becomes its server filter ${canon(all.filters || all)}`);
    const none = run({ loc: [], result: [], inspector: [], range: null }, now);
    ok(none.filters && ['siteIds', 'results', 'inspectorIds', 'fromIso', 'toIso'].every((k) => none.filters[k] === null),
      'C2: an empty facet is no filter (null), never an empty list');
    const week = run({ range: { preset: '7d' } }, now);
    ok(week.filters?.fromIso === rangeBounds({ preset: '7d' }, now).from.toISOString() && week.filters?.toIso === null,
      'C3: a rolling preset starts where the engine says and has NO end (it ends now; a slow browser clock would otherwise hide a new inspection)');
    const today = run({ range: { preset: 'today' } }, now);
    const todayK = dayKey(now);
    const lastMs = startOfDayKey(addDaysKey(todayK, 1)).getTime() - 1; // the day's last millisecond, org zone
    ok(today.filters?.fromIso === startOfDayKey(todayK).toISOString() && today.filters?.toIso === new Date(lastMs).toISOString(),
      `C4: "Today" runs from the org day's first to its LAST millisecond, not 23:59:00 [${today.filters?.toIso}]`);
    const custom = run({ range: { preset: '__custom', from: '2026-01-01', to: '2026-01-31' } }, now);
    const cb = rangeBounds({ from: '2026-01-01', to: '2026-01-31' }, now);
    ok(custom.filters?.fromIso === cb.from.toISOString() && custom.filters?.toIso === cb.to.toISOString(),
      'C5: a custom range is sent as the engine\'s org-zone day bounds');
    const fromOnly = run({ range: { preset: '__custom', from: '2026-01-01', to: '' } }, now);
    ok(fromOnly.filters?.fromIso === cb.from.toISOString() && fromOnly.filters?.toIso === null, 'C6: a custom range with no end is sent with no end');
    const inverted = run({ range: { preset: '__custom', from: '2026-02-01', to: '2026-01-01' } }, now);
    ok(typeof inverted.error === 'string' && !inverted.filters, 'C7: a range that ends before it starts is an error, not a query');
    // A truncated or hand-edited link (?range=2026-01~) used to throw mid-render and take
    // the whole Quality page down; an impossible day rolled into the next month.
    const partial = run({ range: { preset: '__custom', from: '2026-01', to: '' } }, now);
    const impossible = run({ range: { preset: '__custom', from: '2026-02-01', to: '2026-02-31' } }, now);
    ok(typeof partial.error === 'string' && !partial.filters && !partial.thrown && typeof impossible.error === 'string' && !impossible.filters,
      `C7b: a date that isn't a real day is an error — never a crash, never a silently open bound [${partial.thrown || partial.error}]`);
    let engine;
    try { engine = rangeBounds({ preset: '__custom', from: '2026-01', to: '2026-01-31' }, now); } catch (e) { engine = { thrown: e.message }; }
    ok(!engine.thrown && engine.from === null && engine.to?.toISOString() === '2026-02-01T07:59:59.999Z',
      `C7c: the shared engine (rangeBounds, also the Schedule's) leaves a malformed bound open instead of throwing, and ends a custom day at its last millisecond [${engine.thrown || engine.to?.toISOString()}]`);
    const specs = mod.v?.inspectionFilterSpecs || [];
    ok(specs.length === 4 && specs.every((s) => typeof s.match !== 'function'),
      'C8: the facet specs carry no match() — nothing filters inspections in the browser any more');
  }
}

// ── D. wiring, by source shape (+ the pure param parsers) ───────────────────────
{
  const { idListParam, enumListParam } = queryParams;
  ok(typeof idListParam === 'function' && typeof enumListParam === 'function', 'D0: queryParams exports idListParam + enumListParam');
  if (typeof idListParam === 'function' && typeof enumListParam === 'function') {
    const R = new Set(['pass', 'fail']);
    ok(idListParam(undefined) === null && idListParam('') === null && idListParam(',') === null
      && canon(idListParam('s1,s2,s1')) === canon(['s1', 's2']) && canon(idListParam(['s1', 's2'])) === canon(['s1', 's2'])
      && idListParam('s1,x),client_id.in.(y') === undefined && idListParam('a,b,c', 2) === undefined,
    'D0b: idListParam — absent is null, a repeated key is joined, ONE malformed id or too many is undefined (the route answers 400; it never drops one and widens)');
    ok(enumListParam(null, R) === null && canon(enumListParam('fail,pass', R)) === canon(['fail', 'pass']) && enumListParam('fail,maybe', R) === undefined,
      'D0c: enumListParam — a value outside the vocabulary is undefined (400)');
  }
  // A date param is a full ISO date-time on a real day. Date.parse alone let `1` through,
  // which PostgREST then failed as `performed_at=gte.1` (a 500, not this route's 400).
  const { isoParam } = queryParams;
  const stamp = '2026-06-01T07:00:00.000Z';
  ok(isoParam(stamp) === stamp && isoParam('2026-06-01T07:00:00+02:00') === '2026-06-01T07:00:00+02:00' && isoParam(new Date().toISOString())
    && isoParam('') === null && isoParam(undefined) === null
    && ['1', 'Jan 1 2026 (x)', '2026-02-31T00:00:00Z', '2026-06-01', '2026-06-01T24:00:00Z'].every((s) => isoParam(s) === undefined),
  'D0d: isoParam takes a real ISO date-time with its zone — `1`, prose, Feb 31, a bare date and 24:00 are undefined (400)');

  // Normalized: on a CRLF checkout the '\n}\n' scoping below would otherwise never match
  // and every check would run against the rest of the file (review finding).
  const read = (p) => readFileSync(path.join(APP, p), 'utf8').replace(/\r\n/g, '\n');
  const between = (src, from, to) => {
    const a = src.indexOf(from);
    if (a < 0) return '';
    const b = src.indexOf(to, a + from.length);
    return src.slice(a, b < 0 ? undefined : b);
  };

  const route = read('api/qc/[...path].js');
  const parse = between(route, 'function inspectionFilterParams(req, res)', '\n}\n');
  const checked = (expr) => new RegExp(`const (\\w+) = ${expr.replace(/[.()[\]]/g, '\\$&')};\\s*if \\(\\1 === undefined\\) return bad\\(`).test(parse);
  ok(checked('idParam(req.query.clientId)') && checked('idListParam(req.query.siteIds, ID_FILTER_MAX)')
    && checked('idListParam(req.query.inspectorIds, ID_FILTER_MAX)') && checked('enumListParam(req.query.results, INSPECTION_RESULTS)')
    && /isoParam\(req\.query\.fromIso\)/.test(parse) && /isoParam\(req\.query\.toIso\)/.test(parse)
    && /fromIso === undefined \|\| toIso === undefined\) return bad\(/.test(parse)
    && /if \(fromIso && toIso && Date\.parse\(fromIso\) > Date\.parse\(toIso\)\) return bad\(/.test(parse)
    && /return \{ clientId, siteIds, inspectorIds, results, fromIso, toIso \};/.test(parse)
    && /if \(req\.query\.siteId != null\) return bad\(/.test(parse),
  'D1: inspectionFilterParams checks every filter — malformed, a backward range or the retired ?siteId is a 400');
  const group = between(route, "if (group === 'inspections')", "'latest-by-client'");
  const action = (name, until) => between(group, `action === '${name}'`, until);
  const listA = action('list', "action === 'figures'");
  const figA = action('figures', "action === 'export'");
  const expA = action('export', '\n      }\n');
  const parsed = /const filters = inspectionFilterParams\(req, res\); if \(!filters\) return;/;
  ok(/requirePermission\(req, res, 'qc\.view'\)/.test(listA) && parsed.test(listA) && /listInspections\(\{ \.\.\.filters, crewScope \}\)/.test(listA)
    && /json\(\{ inspections, truncated \}\)/.test(listA),
  'D2: inspections/list reads the parsed filters inside the crew scope and answers `truncated`');
  ok(/requirePermission\(req, res, 'qc\.view'\)/.test(figA) && parsed.test(figA)
    && /inspectionFiguresMatching\(\{ \.\.\.filters, crewScope \}, \{ maxRows: FIGURES_MAX_ROWS \}\)/.test(figA),
  'D3: inspections/figures tallies the same filters inside the crew scope (qc.view)');
  ok(/requirePermission\(req, res, 'qc\.view'\)/.test(expA) && /requirePermission\(req, res, 'qc\.share'\)/.test(expA) && parsed.test(expA)
    && /const scoped = \{ \.\.\.filters, crewScope \};/.test(expA)
    && /intParam\(req\.query\.offset, 0, 0, EXPORT_OFFSET_MAX\)/.test(expA) && /intParam\(req\.query\.limit, EXPORT_PAGE_MAX, 1, EXPORT_PAGE_MAX\)/.test(expA)
    && /offset === 0 \? countInspectionsMatching\(scoped\) : Promise\.resolve\(null\)/.test(expA)
    && /pageInspectionsForExport\(scoped, \{ offset, limit \}\)/.test(expA) && /json\(\{ inspections, total, offset, limit \}\)/.test(expA),
  'D4: inspections/export serves pages (the first with the count) of the same filters inside the crew scope, a page at most EXPORT_PAGE_MAX rows, gated qc.view AND qc.share (the Export button\'s permission)');
  ok(/const EXPORT_PAGE_MAX = (\d+);/.test(route) && Number(/const EXPORT_PAGE_MAX = (\d+);/.exec(route)[1]) <= 2000,
    'D4b: an export page is bounded (≤ 2,000 rows of ≤ ~500 bytes: well inside the 4.5 MB function response)');
  ok(/listInspectionsInWindow\(\s*\{ \.\.\.win, clientId, results: result \? \[result\] : null, submittedOnly: true, crewScope \}/.test(route)
    && /if \(result != null && !INSPECTION_RESULTS\.has\(result\)\) return res\.status\(400\)/.test(route),
  'D5: the Reports tally passes its result through the shared filter helper, and a malformed ?result is a 400 (it used to widen to all results)');

  const adapter = read('src/lib/qcApi.js');
  const qsFn = between(adapter, 'function inspectionParams(f)', '\n}\n');
  const exportFn = between(adapter, 'export async function exportInspections', '\n}\n');
  ok(['clientId', 'siteIds', 'inspectorIds', 'results', 'fromIso', 'toIso'].every((k) => qsFn.includes(`qs.set('${k}'`))
    && /\/qc\/inspections\/list\$\{inspectionQuery\(f\)\}/.test(adapter) && /\/qc\/inspections\/figures\$\{inspectionQuery\(f\)\}/.test(adapter),
  'D6: qcApi sends every filter to inspections/list and /figures');
  ok(/fetchAllPages\(\{/.test(exportFn) && /const qs = inspectionParams\(f\);/.test(exportFn)
    && /qs\.set\('offset', String\(offset\)\)/.test(exportFn) && /qs\.set\('limit', String\(limit\)\)/.test(exportFn)
    && /\/qc\/inspections\/export\?\$\{qs\.toString\(\)\}/.test(exportFn) && /return \{ rows: r\.inspections \|\| \[\], total: r\.total, limit: r\.limit \};/.test(exportFn),
  'D6b: qcApi reads the export through every page (lib/pagedFetch.js), with the same filters — never one capped response');

  const page = read('src/pages/Inspections.jsx');
  ok(!/applyFilters/.test(page) && !/summarizeInspections/.test(page),
    'D7: the hub no longer filters, or tallies, inspection records in the browser');
  ok(/const query = inspectionListQuery\(JSON\.parse\(filtersKey\)\);[\s\S]{0,120}?qcApi\.listInspections\(query\.filters\)/.test(page)
    && /const query = inspectionListQuery\(JSON\.parse\(filtersKey\)\);[\s\S]{0,120}?qcApi\.inspectionFigures\(query\.filters\)/.test(page)
    && /downloadInspectionsCsv\(await qcApi\.exportInspections\(query\.filters\)/.test(page) && /onClick=\{exportCsv\}/.test(page),
  'D8: the list, the figures and the export each read the server with the facets, resolved when the read runs');
  ok(/if \(alive\) setList\(\{ key: filtersKey,/.test(page) && /if \(alive\) setFigures\(\{ key: filtersKey,/.test(page)
    && /list\.key === filtersKey \? list : LIST_LOADING/.test(page) && /figures\.key === filtersKey \? figures : FIGURES_LOADING/.test(page),
  'D9: a response for an earlier filter is dropped, never shown under a later one');
  ok(/<StatCard label="Scored inspections" value=\{fig \? fig\.count : '—'\}/.test(page) && /<StatCard label="Failed \/ follow-up" value=\{fig \? fig\.failCount : '—'\}/.test(page),
    'D10: the stat cards read the complete figures ("—" until they load)');
  const tabBody = between(page, "{tab === 'records' ? (", "tab === 'checklists' ? (");
  const note = /\{!rangeError && shownList\.truncated && records && \(\s*<p\b[^>]*>[\s\S]{0,120}?Showing the newest \$\{records\.length\} of \$\{matchTotal/.exec(tabBody);
  ok(note && note.index < tabBody.indexOf('<table>'),
    'D11: a capped list says "Showing the newest N of M" in visible text above the list (UI_RULES §117)');
  const chain = /\{rangeError \? \([\s\S]*?Check the dates[\s\S]*?\) : shownList\.error \? \([\s\S]*?Try again[\s\S]*?\) : records === null \? \([\s\S]*?Loading…[\s\S]*?\) : records\.length === 0 \? \(/;
  const errAt = tabBody.indexOf(') : shownList.error ? (');
  ok(chain.test(tabBody) && errAt > 0 && errAt < tabBody.indexOf('records === null ? (') && errAt < tabBody.indexOf('records.length === 0 ? ('),
    'D12: a failed list read is an error with Try again, ahead of loading and empty — never "No inspections yet"');
  ok(/shownFigures\.error \? \([\s\S]{0,400}?Couldn’t load the figures[\s\S]{0,300}?Try again/.test(tabBody),
    'D13: a failed figures read says so with Try again — never zeros');
}

console.log(`\ntest-hub-inspections: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
