// A customer's own Inspections tab reads THAT customer's inspections. Pre-existing bug
// found during the S74 Reports work, fixed 2026-09-23: the tab
// (components/ClientInspections.jsx) called qcApi.listInspections({}), which is the ORG's
// newest 200 (api/_lib/qc/store.js listInspections), and kept the customer's rows in the
// browser. Once the org passed 200 inspections, an account's older inspections (or all of
// them) silently fell off its own tab. The read now filters by customer in the query,
// keeps crew scope, reads one row past the cap so `truncated` is exact, and the tab says
// "showing the newest N" when it is capped (UI_RULES §117).
//
// Offline, three layers:
//   A. the server store, against scripts/fake-postgrest.mjs (db-max-rows 1000, like Supabase)
//   B. the demo stub in lib/qcApi.js, imported under plain node (no VITE env → stub mode)
//   C. the route + component wiring, by source shape (the route needs a live session and
//      the component a browser; both were driven live when this landed)
//   node app/scripts/test-client-inspections.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { fakeDb } from './fake-postgrest.mjs';
import { installResolveShim } from './deletion-core.mjs';
import { listInspections } from '../api/_lib/qc/store.js';
import { idParam } from '../api/_lib/queryParams.js';
import { CLEANSPACE_ORG_ID as ORG } from '../api/_lib/constants.js';
import * as inspectionsLib from '../src/lib/inspections.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };
// A read that throws is a failed assertion with its message, not a crashed suite.
const attempt = async (fn) => { try { return { v: await fn() }; } catch (e) { return { e }; } };
const why = (r) => (r.e ? ` [threw: ${r.e.message}]` : '');

// The cap is ONE shared number (server read + demo stub). Asserted, then used; the `?? 200`
// only lets the older tree run far enough to show which behaviors it gets wrong.
ok(Number.isInteger(inspectionsLib.INSPECTION_LIST_LIMIT) && inspectionsLib.INSPECTION_LIST_LIMIT > 0,
  'L0: the list cap is one shared constant (lib/inspections INSPECTION_LIST_LIMIT)');
const LIMIT = inspectionsLib.INSPECTION_LIST_LIMIT ?? 200;

// ── fixture: an org well past the cap, the quiet customer's records the oldest ────
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60000;
const DAY = 1440 * MIN;
const iso = (ms) => new Date(ms).toISOString();
let seq = 0;
function rec(clientId, siteId, t, extra = {}) {
  seq += 1;
  return {
    id: `in_${clientId}_${String(seq).padStart(5, '0')}`, organization_id: ORG,
    client_id: clientId, site_id: siteId, client_name: clientId, site_name: siteId,
    inspector_user_id: 'u_mgr', inspector_name: 'Manager',
    overall_score: 90, result: 'pass', status: 'submitted',
    performed_at: iso(t), template_snapshot: { schema: 'x'.repeat(40) },
    ...extra,
  };
}
const ALL = [];
// c_quiet: 40 inspections, older than everything else — the account that vanished.
for (let i = 0; i < 40; i += 1) ALL.push(rec('c_quiet', 's_quiet', BASE + i * 60 * MIN));
// c_busy: 300 — the org's newest, so they ARE the org's newest 200.
for (let i = 0; i < 300; i += 1) ALL.push(rec('c_busy', 's_busy', BASE + 100 * DAY + i * 10 * MIN));
// c_heavy: 450 over two sites; every 3rd by the crew member, every 7th an unsubmitted
// draft; timestamps in pairs so a tie straddles the cap (the id tiebreak decides it).
for (let i = 0; i < 450; i += 1) {
  ALL.push(rec('c_heavy', i % 2 ? 's_heavy_b' : 's_heavy_a', BASE + 10 * DAY + Math.floor((i + 1) / 2) * 30 * MIN, {
    inspector_user_id: i % 3 === 0 ? 'u_crew' : 'u_mgr',
    ...(i % 7 === 0 ? { status: 'draft', overall_score: null, result: null } : {}),
  }));
}
// Exactly at the cap, and one past it — `truncated` must tell them apart.
for (let i = 0; i < LIMIT; i += 1) ALL.push(rec('c_exact', 's_exact', BASE + 5 * DAY + i * MIN));
for (let i = 0; i < LIMIT + 1; i += 1) ALL.push(rec('c_over1', 's_over', BASE + 6 * DAY + i * MIN));

// The truth, computed here from the fixture — never from the code under test.
const newestFirst = (a, b) => (Date.parse(b.performed_at) - Date.parse(a.performed_at)) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const truth = (pred) => ALL.filter(pred).sort(newestFirst);
const ids = (rows) => (Array.isArray(rows) ? rows.map((r) => r.id) : []);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const of = (c) => (r) => r.client_id === c;

const heavy = truth(of('c_heavy'));
ok(heavy[LIMIT - 1].performed_at === heavy[LIMIT].performed_at, 'fixture: a timestamp tie straddles the cap (so the tiebreak is exercised)');
ok(truth(() => true).slice(0, LIMIT).every(of('c_busy')), 'fixture: the org\'s newest records all belong to c_busy');

// ── A. the server store ─────────────────────────────────────────────────────────
const db = (maxRows = 1000) => fakeDb({ inspection_records: ALL.slice() }, { maxRows });
const list = (filters, maxRows) => attempt(() => listInspections(filters, db(maxRows)));
{
  const org = await list({});
  const oldTab = (org.v?.inspections || []).filter(of('c_quiet'));
  ok(ids(org.v?.inspections).length === LIMIT && oldTab.length === 0 && truth(of('c_quiet')).length === 40,
    `A1 (control): the org-wide newest-${LIMIT} holds NONE of c_quiet's 40 — the old tab, narrowing it in the browser, read "No inspections recorded"${why(org)}`);

  const quiet = await list({ clientId: 'c_quiet' });
  ok(same(ids(quiet.v?.inspections), ids(truth(of('c_quiet')))) && quiet.v?.truncated === false,
    `A2: clientId → every one of c_quiet's 40, newest first, not truncated${why(quiet)}`);

  const hv = await list({ clientId: 'c_heavy' });
  ok(same(ids(hv.v?.inspections), ids(heavy.slice(0, LIMIT))) && hv.v?.truncated === true,
    `A3: 450 → the customer's newest ${LIMIT} exactly (drafts included, the tie broken by id) and truncated${why(hv)}`);

  const exact = await list({ clientId: 'c_exact' });
  const over = await list({ clientId: 'c_over1' });
  ok(ids(exact.v?.inspections).length === LIMIT && exact.v?.truncated === false,
    `A4: exactly ${LIMIT} → all of them, NOT truncated${why(exact)}`);
  ok(same(ids(over.v?.inspections), ids(truth(of('c_over1')).slice(0, LIMIT))) && over.v?.truncated === true,
    `A5: ${LIMIT + 1} → the newest ${LIMIT} (the oldest one left out), truncated${why(over)}`);

  const tight = await list({ clientId: 'c_heavy' }, 64);
  ok(same(ids(tight.v?.inspections), ids(heavy.slice(0, LIMIT))) && tight.v?.truncated === true,
    `A6: under a db-max-rows of 64 the cap still means ${LIMIT} rows and truncated stays exact${why(tight)}`);

  const scope = { clientIds: [], siteIds: ['s_heavy_a'], userId: 'u_crew' };
  const crewTruth = truth((r) => r.client_id === 'c_heavy' && (r.site_id === 's_heavy_a' || r.inspector_user_id === 'u_crew'));
  const crew = await list({ clientId: 'c_heavy', crewScope: scope });
  ok(same(ids(crew.v?.inspections), ids(crewTruth.slice(0, LIMIT))) && crew.v?.truncated === (crewTruth.length > LIMIT),
    `A7: crew scope still applies with a clientId — only their site's rows + their own${why(crew)}`);

  const wider = await list({ clientId: 'c_quiet', crewScope: { clientIds: ['c_busy'], siteIds: [], userId: 'u_nobody' } });
  ok(!wider.e && ids(wider.v?.inspections).length === 0 && wider.v?.truncated === false,
    `A8: a clientId outside the crew member's scope reads nothing — it narrows, never widens${why(wider)}`);

  const crafted = await list({ clientId: 'c_quiet', crewScope: { clientIds: [], siteIds: ['x),client_id.in.(c_quiet'], userId: null } });
  ok(!crafted.e && ids(crafted.v?.inspections).length === 0,
    `A9: a scope id smuggled in as filter syntax is dropped even alongside a clientId — no rows${why(crafted)}`);

  const site = await list({ clientId: 'c_heavy', siteIds: ['s_heavy_b'] });
  const siteTruth = truth((r) => r.client_id === 'c_heavy' && r.site_id === 's_heavy_b');
  ok(same(ids(site.v?.inspections), ids(siteTruth.slice(0, LIMIT))) && site.v?.truncated === (siteTruth.length > LIMIT),
    `A10: clientId + siteIds narrow together${why(site)}`);

  ok(same(ids(org.v?.inspections), ids(truth(() => true).slice(0, LIMIT))) && org.v?.truncated === true,
    `A11: no clientId → the Quality hub's org-wide newest ${LIMIT}, now flagged truncated${why(org)}`);
}

// ── B. the demo stub (the same contract, over the local records) ─────────────────
{
  installResolveShim(); // Vite writes extensionless imports; plain node needs `.js`
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
  const stub = (filters) => attempt(() => qcApi.listInspections(filters));

  const quiet = await stub({ clientId: 'c_quiet' });
  ok(same(ids(quiet.v?.inspections), ids(truth(of('c_quiet')))) && quiet.v?.truncated === false,
    `B1: stub, clientId → every one of c_quiet's 40, newest first, not truncated${why(quiet)}`);
  const hv = await stub({ clientId: 'c_heavy' });
  ok(same(ids(hv.v?.inspections), ids(heavy.slice(0, LIMIT))) && hv.v?.truncated === true,
    `B2: stub, 450 → the newest ${LIMIT} (ties by id, like the query) and truncated${why(hv)}`);
  const exact = await stub({ clientId: 'c_exact' });
  const over = await stub({ clientId: 'c_over1' });
  ok(exact.v?.truncated === false && ids(exact.v?.inspections).length === LIMIT && over.v?.truncated === true && ids(over.v?.inspections).length === LIMIT,
    `B3: stub, truncated is exact at ${LIMIT} vs ${LIMIT + 1}${why(exact)}${why(over)}`);
  const site = await stub({ siteIds: ['s_heavy_b'] });
  ok(ids(site.v?.inspections).length > 0 && (site.v?.inspections || []).every((r) => r.site_id === 's_heavy_b'),
    `B4: stub, siteIds is honored (the pre-S76 stub ignored its site filter)${why(site)}`);
  const org = await stub({});
  ok(same(ids(org.v?.inspections), ids(truth(() => true).slice(0, LIMIT))) && org.v?.truncated === true,
    `B5: stub, no filter → the org's newest ${LIMIT}, truncated${why(org)}`);
}

// ── C. wiring, by source shape ──────────────────────────────────────────────────
{
  ok(idParam('c_quiet') === 'c_quiet' && idParam('') === null && idParam(undefined) === null
    && idParam('x),client_id.in.(y') === undefined && idParam(['c1', 'c2']) === 'c1',
  'C0: idParam — an id passes, absent is null, filter syntax is undefined (the route answers 400)');

  // CRLF normalized: on a Windows checkout a '\n}\n' end marker never matches otherwise,
  // and a check scoped to one function silently runs against the rest of the file.
  const read = (p) => readFileSync(path.join(APP, p), 'utf8').replace(/\r\n/g, '\n');
  const between = (src, from, to) => {
    const a = src.indexOf(from);
    if (a < 0) return '';
    const b = src.indexOf(to, a + from.length);
    return src.slice(a, b < 0 ? undefined : b);
  };

  // Since S83 the list's filters (clientId + the Quality hub's) are parsed by ONE helper,
  // inspectionFilterParams, shared with inspections/figures and /export.
  const route = read('api/qc/[...path].js');
  const params = between(route, 'function inspectionFilterParams(req, res)', '\n}\n');
  const listRoute = between(route, "if (group === 'inspections')", "'latest-by-client'");
  ok(/const clientId = idParam\(req\.query\.clientId\);\s*if \(clientId === undefined\) return bad\(/.test(params)
    && /const siteIds = idListParam\(req\.query\.siteIds, ID_FILTER_MAX\);\s*if \(siteIds === undefined\) return bad\(/.test(params)
    && /const bad = \(error\) => \{ res\.status\(400\)/.test(params),
  'C1: inspections/list validates ?clientId (idParam) and ?siteIds (idListParam) — malformed is a 400');
  ok(/return \{ clientId,[^}]*\};/.test(params)
    && /const filters = inspectionFilterParams\(req, res\); if \(!filters\) return;[\s\S]{0,200}?listInspections\(\{ \.\.\.filters, crewScope \}\)/.test(listRoute),
  'C2: inspections/list hands the clientId (in its parsed filters) to the store, alongside the crew scope');
  ok(/json\(\{[^}]*\btruncated\b[^}]*\}\)/.test(listRoute),
    'C3: inspections/list answers with `truncated`');

  const adapter = read('src/lib/qcApi.js');
  const listFn = between(adapter, 'export async function listInspections', 'export async function');
  ok(/qs\.set\('clientId', f\.clientId\)/.test(between(adapter, 'function inspectionParams(f)', '\n}\n'))
    && /\/qc\/inspections\/list\$\{inspectionQuery\(f\)\}/.test(listFn) && /truncated: !!r\.truncated/.test(listFn),
  'C4: qcApi.listInspections sends clientId to the server and returns its `truncated`');

  const tab = read('src/components/ClientInspections.jsx');
  ok(/qcApi\.listInspections\(\{\s*clientId: client\.id\s*\}\)/.test(tab),
    'C5: the customer tab reads by customer — qcApi.listInspections({ clientId: client.id })');
  ok(!/listInspections\(\{\s*\}\)/.test(tab) && !/client_id === client\.id/.test(tab),
    'C6: …and no longer reads the org list and narrows it in the browser');
  // The cap note is visible text (a title tooltip never shows on a phone), gated on
  // `truncated`, placed above the first figure, and says the figures cover only the list.
  const note = /\{truncated && \(\s*<p\b[^>]*>[^<]*Showing the newest \{inspections\.length\}[^<]*cover only these/.exec(tab);
  ok(note && note.index < tab.indexOf('Overall score'),
    'C7: a capped list says "Showing the newest N", above the figures, and that they cover only those (UI_RULES §117)');
  ok(/\{quality\.total\.count\} scored inspection/.test(tab),
    'C7b: the count beside the score says "scored" — it excludes drafts, which the list and its pager include');
  // Error is checked BEFORE loading and empty (else a failed read reads "Loading…" forever
  // or "No inspections recorded"), and the catch keeps rows null and stores the error.
  const chain = /\{error \? \([\s\S]*?Try again[\s\S]*?\) : inspections === null \? \([\s\S]*?Loading inspection history[\s\S]*?\) : detailRows\.length === 0 \? \(/;
  const caught = /listInspections\(\{\s*clientId: client\.id\s*\}\)[\s\S]{0,400}?\.catch\(\((\w+)\) => [^\n]*\brows: null\b[^\n]*\berror: \1\b/;
  ok(chain.test(tab) && caught.test(tab),
    'C8: a failed read renders its error with Try again, ahead of loading/empty — never "Loading…" forever or "No inspections recorded"');
  // Both tables carry the §24 stacked-card markup (cell-primary, data-label, cell-actions);
  // without the class a plain .table-wrap is display:none at phone width — the rows vanish.
  const wraps = tab.match(/className="table-wrap[^"]*"/g) || [];
  ok(wraps.length === 2 && wraps.every((c) => /\bmobile-stack\b/.test(c)),
    'C10: both tables stack as cards on a phone (mobile-stack, UI_RULES §24) — the rows are not hidden');

  const detail = read('src/pages/ClientDetail.jsx');
  ok(/usePermission\('qc\.view'\)/.test(detail)
    && /\{canViewInspections && \(\s*<button[\s\S]{0,300}?setActivitySubTab\('inspections'\)/.test(detail)
    && /canViewInspections && activitySubTab === 'inspections'/.test(detail),
  'C9: the Inspections toggle AND its panel are gated on qc.view, the permission its read needs');
}

console.log(`\ntest-client-inspections: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
