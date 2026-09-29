// Complete reads for reports, the pay run and the alerts (Reports fix #1, 2026-09-22).
// Offline: the server stores run against scripts/fake-postgrest.mjs, a PostgREST
// stand-in that — like Supabase — caps EVERY response at db-max-rows (1000). The
// defect this pins: the report + payroll + alert feeds read `.limit(N)` newest-first,
// so at volume they silently saw a slice (200 inspections, 500 punches a day, 5000 a
// pay run — and max-rows cut even those to 1000).
//   node app/scripts/test-paged-select.mjs
import { fakeDb } from './fake-postgrest.mjs';
import {
  rangeFill, selectAll, IncompleteReadError, TooManyRowsError, readErrorStatus,
} from '../api/_lib/pagedSelect.js';
import {
  countForRollup, pageForRollup, listForRollup, countForReport, pageForReport, listForReportAll,
  listForReport, coveredJobIdsInWindow, ATTENDANCE_COLUMNS,
} from '../api/_lib/time/store.js';
import {
  listInspectionsInWindow, listChecklistsInWindow, INSPECTION_WINDOW_COLUMNS, latestInspectionPerClient,
} from '../api/_lib/qc/store.js';
import { listOverridesForEntries } from '../api/_lib/time/driveOverrides.js';
import { CLEANSPACE_ORG_ID as ORG } from '../api/_lib/constants.js';
import { fetchAllPages, IncompleteFetchError } from '../src/lib/pagedFetch.js';
import { aggregateInspectionsPerSite, aggregateChecklistsPerSite } from '../src/lib/reports/qcReports.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

const BASE = Date.parse('2026-09-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const minute = 60000;

// n punches spread over ~n minutes from BASE; every 7th is still open, every 11th voided.
function punches(n, extra = (i) => ({})) {
  return Array.from({ length: n }, (_, i) => ({
    id: `te_${String(i).padStart(6, '0')}`,
    organization_id: ORG,
    user_id: `u${i % 40}`, user_name: `Cleaner ${i % 40}`,
    job_id: `j${i}`, site_id: `s${i % 90}`, client_id: `c${i % 30}`, site_name: 'S', client_name: 'C',
    clock_in_at: iso(BASE + i * minute),
    clock_out_at: i % 7 === 0 ? null : iso(BASE + i * minute + 45 * minute),
    duration_minutes: i % 7 === 0 ? null : 45,
    status: i % 11 === 0 ? 'voided' : (i % 7 === 0 ? 'in_progress' : 'completed'),
    approval_status: i % 3 === 0 ? 'approved' : 'pending',
    job_cancelled_at: null,
    ...extra(i),
  }));
}
const ids = (rows) => rows.map((r) => r.id);
const isSortedAsc = (rows, col) => rows.every((r, i) => i === 0 || rows[i - 1][col] <= r[col]);

// ── the primitive: rangeFill honors a page at ANY max-rows ─────────────────────
{
  const db = fakeDb({ t: punches(2500) }, { maxRows: 1000 });
  const page = async (a, b) => {
    const { data, error } = await db.from('t').select('*').order('clock_in_at').order('id').range(a, b);
    if (error) throw error;
    return data;
  };
  const p1 = await rangeFill(page, 0, 1999);
  ok(p1.length === 2000, `P1: a 2000-row page under max-rows 1000 returns 2000 (got ${p1.length})`);
  ok(new Set(ids(p1)).size === 2000 && isSortedAsc(p1, 'clock_in_at'), 'P1b: filled in order, no repeats');
  const p2 = await rangeFill(page, 2000, 2999);
  ok(p2.length === 500, `P2: the last page returns the 500 left (got ${p2.length})`);
  const tight = fakeDb({ t: punches(700) }, { maxRows: 128 });
  const pageT = async (a, b) => (await tight.from('t').select('*').order('id').range(a, b)).data;
  ok((await rangeFill(pageT, 0, 699)).length === 700, 'P3: a max-rows far below the chunk still fills the page');
}

// ── selectAll: count-first, concurrent, retried, loud when short ───────────────
{
  const all = punches(12345);
  const db = fakeDb({ t: all }, { maxRows: 1000 });
  // Like the store's count/page readers: an { error } response throws (so it is retried).
  const count = async () => {
    const { count: n, error } = await db.from('t').select('id', { count: 'exact', head: true });
    if (error) throw error;
    return n;
  };
  const page = async (a, b) => {
    const { data, error } = await db.from('t').select('*').order('clock_in_at').order('id').range(a, b);
    if (error) throw error;
    return data;
  };
  const rows = await selectAll({ count, page, pageSize: 2000 });
  ok(rows.length === 12345 && new Set(ids(rows)).size === 12345, `S1: every one of 12,345 rows under max-rows 1000 (got ${rows.length})`);
  db.failNext(2);
  const again = await selectAll({ count, page, pageSize: 3000 });
  ok(again.length === 12345, 'S2: transient page failures are retried, the read still completes');
  const shortCount = async () => 12345 + 5; // rows that vanish between count and pages
  let threw = null;
  try { await selectAll({ count: shortCount, page, pageSize: 5000 }); } catch (e) { threw = e; }
  ok(threw instanceof IncompleteReadError, 'S3: a read that comes up short THROWS IncompleteReadError — never a partial result');
  ok(readErrorStatus(threw) === 503, 'S3b: an incomplete read answers 503 (retry)');
  let big = null;
  try { await selectAll({ count, page, maxRows: 1000 }); } catch (e) { big = e; }
  ok(big instanceof TooManyRowsError && readErrorStatus(big) === 413, 'S4: a read past maxRows is a 413 "narrow the range", not a truncation');
  ok(readErrorStatus(new Error('x')) === 500, 'S4b: anything else is a 500');
}

// ── the rollup (pay run + Hours report): every completed punch in the window ────
{
  const rows = punches(12000);
  const db = fakeDb({ time_entries: rows }, { maxRows: 1000 });
  const f = { fromIso: iso(BASE), toIso: iso(BASE + 20000 * minute) };
  const completed = rows.filter((r) => r.clock_out_at);
  const total = await countForRollup(f, db);
  ok(total === completed.length, `R1: count = completed punches in the window (${total} vs ${completed.length})`);
  const got = [];
  for (let offset = 0; offset < total; offset += 2000) {
    const pageRows = await pageForRollup(f, { offset, limit: 2000 }, db);
    ok(pageRows.length === Math.min(2000, total - offset), `R2: page @${offset} holds ${Math.min(2000, total - offset)} (got ${pageRows.length})`);
    got.push(...pageRows);
  }
  ok(got.length === completed.length && new Set(ids(got)).size === completed.length, 'R3: the pages together are EVERY completed punch, once');
  ok(isSortedAsc(got, 'clock_in_at'), 'R4: oldest first, deterministic');
  const approved = await countForRollup({ ...f, approvedOnly: true }, db);
  ok(approved === completed.filter((r) => r.approval_status === 'approved').length, 'R5: approvedOnly narrows the count the same as the pages');
  // Legacy single read (only app bundles cached before paging call it): its 5000 cap
  // now means 5000 — before, max-rows cut it to 1000 without a word.
  const legacy = await listForRollup(f, db);
  ok(legacy.length === 5000, `R6: the legacy capped read returns its full 5000 under max-rows 1000 (got ${legacy.length})`);
}

// ── punch history reads: capped (history lists) vs complete (attendance) ────────
{
  const rows = punches(3000);
  const db = fakeDb({ time_entries: rows }, { maxRows: 1000 });
  const f = { fromIso: iso(BASE), toIso: iso(BASE + 5000 * minute) };
  const newest = await listForReport({ ...f, limit: 2001 }, db);
  ok(newest.length === 2001 && newest[0].clock_in_at >= newest[2000].clock_in_at, 'H1: the capped read returns limit+1 newest-first, so `truncated` can be exact past max-rows');
  const n = await countForReport(f, db);
  ok(n === 3000, 'H2: exact count for a window');
  const lite = await pageForReport(f, { offset: 1000, limit: 1500, columns: ATTENDANCE_COLUMNS }, db);
  ok(lite.length === 1500 && !('site_name' in lite[0]) && 'job_id' in lite[0], 'H3: a lite page carries only the attendance columns');
  const everything = await listForReportAll(f, { columns: ATTENDANCE_COLUMNS }, db);
  ok(everything.length === 3000, `H4: listForReportAll reads every punch (got ${everything.length})`);
  const oneUser = await listForReportAll({ ...f, userIds: ['u3'] }, {}, db);
  ok(oneUser.length === rows.filter((r) => r.user_id === 'u3').length && oneUser.every((r) => r.user_id === 'u3'), 'H5: filters narrow the count and pages identically');
}

// ── coverage (late/missed alerts, Dashboard KPI): every real clock-in counts ─────
{
  const rows = punches(5000, (i) => (i % 13 === 0 ? { status: 'no_show' } : i % 17 === 0 ? { job_id: null } : {}));
  const db = fakeDb({ time_entries: rows }, { maxRows: 1000 });
  const f = { fromIso: iso(BASE), toIso: iso(BASE + 6000 * minute) };
  const covered = new Set(await coveredJobIdsInWindow(f, db));
  const expected = new Set(rows.filter((r) => r.job_id && r.status !== 'voided' && r.status !== 'no_show').map((r) => r.job_id));
  ok(covered.size === expected.size && [...expected].every((j) => covered.has(j)), `C1: every covered clean in 5,000 punches is found (${covered.size}/${expected.size})`);
  ok(!covered.has('j0') && !covered.has('j13'), 'C2: voided / no-show punches never cover a clean');
  const late = rows[4999].job_id;
  ok(covered.has(late) && covered.has(rows[1].job_id), 'C3: the day\'s earliest AND latest punches both count (the newest-N slice dropped the earliest)');
}

// ── QC window reads (Inspections / Checklists per site + reminders) ────────────
{
  const insp = Array.from({ length: 3000 }, (_, i) => ({
    id: `in_${String(i).padStart(5, '0')}`, organization_id: ORG,
    client_id: `c${i % 3}`, site_id: `s${i % 3}`, client_name: `Client ${i % 3}`, site_name: 'Main',
    inspector_user_id: i % 5 === 0 ? 'u_crew' : 'u_mgr', overall_score: 80 + (i % 20),
    result: i % 10 === 0 ? 'fail' : 'pass', status: i % 9 === 0 ? 'draft' : 'submitted',
    performed_at: iso(BASE + i * 10 * minute), template_snapshot: { big: 'x'.repeat(50) },
  }));
  const db = fakeDb({ inspection_records: insp }, { maxRows: 1000 });
  const f = { fromIso: iso(BASE), toIso: iso(BASE + 40000 * minute) };
  const subs = await listInspectionsInWindow({ ...f, submittedOnly: true }, { columns: INSPECTION_WINDOW_COLUMNS }, db);
  ok(subs.length === insp.filter((r) => r.status !== 'draft').length, `Q1: every submitted inspection in the window (${subs.length})`);
  ok(!('template_snapshot' in subs[0]), 'Q2: narrow columns — no template snapshot in a count read');
  const crew = await listInspectionsInWindow({ ...f, crewScope: { clientIds: ['c1'], siteIds: [], userId: 'u_crew' } }, {}, db);
  ok(crew.length > 0 && crew.every((r) => r.client_id === 'c1' || r.inspector_user_id === 'u_crew'), 'Q3: crew scope still applies to window reads');
  const noScope = await listInspectionsInWindow({ ...f, crewScope: { clientIds: [], siteIds: [], userId: null } }, {}, db);
  ok(noScope.length === 0, 'Q4: a crew member with no scope reads nothing');
  // A site id smuggled into the shared blob as filter syntax must not add its own OR
  // branch: `x),client_id.in.(c2` would otherwise widen the read to client c2.
  const injected = await listInspectionsInWindow({ ...f, crewScope: { clientIds: ['c1'], siteIds: ['x),client_id.in.(c2'], userId: 'u_nobody' } }, {}, db);
  ok(injected.length > 0 && injected.every((r) => r.client_id === 'c1'), 'Q4b: a crafted scope id can NOT widen a crew read to another account');
  const onlyBad = await listInspectionsInWindow({ ...f, crewScope: { clientIds: ['c1),id.not.is.null,site_id.in.(z'], siteIds: [], userId: null } }, {}, db);
  ok(onlyBad.length === 0, 'Q4c: a scope made only of crafted ids reads nothing (dropped, never widened)');
  // End to end: the per-site tally over the window is the TRUE count — the old read took
  // the newest 200 inspections org-wide, then tallied those.
  const siteRows = aggregateInspectionsPerSite({ inspections: subs, fromMs: Date.parse(f.fromIso), toMs: Date.parse(f.toIso) });
  const c0 = siteRows.find((r) => r.clientId === 'c0');
  const trueC0 = insp.filter((r) => r.client_id === 'c0' && r.status !== 'draft').length;
  ok(c0 && c0.count === trueC0, `Q5: inspections at one site = ${trueC0} (got ${c0 && c0.count}; the newest-200 read gave at most 200)`);

  const cls = Array.from({ length: 2500 }, (_, i) => ({
    id: `cl_${String(i).padStart(5, '0')}`, organization_id: ORG, client_id: 'c9', site_id: 's9', job_id: `j${i}`,
    completed_by_user_id: 'u1', completed_count: i % 4 ? 10 : 8, total_count: 10, items: [{ big: true }],
    performed_at: iso(BASE + i * 30 * minute),
  }));
  const cdb = fakeDb({ checklist_results: cls }, { maxRows: 1000 });
  const clAll = await listChecklistsInWindow({ fromIso: iso(BASE), toIso: iso(BASE + 90000 * minute) }, {}, cdb);
  ok(clAll.length === 2500 && !('items' in clAll[0]), `Q6: every checklist in the window, narrow columns (${clAll.length})`);
  const clRows = aggregateChecklistsPerSite({ checklists: clAll });
  ok(clRows[0].count === 2500 && clRows[0].fullCount === cls.filter((c) => c.completed_count === 10).length, 'Q7: checklists at one site = 2,500 and fully-complete counts every one');
}

// ── drive overrides: EVERY leg's ruling is read (was: first 1000 ids, one URL) ──
{
  const overrides = Array.from({ length: 2500 }, (_, i) => ({
    id: `ov${i}`, organization_id: ORG, from_entry_id: `te_${i}`, to_entry_id: `te_${i + 1}`,
    excluded: false, paid_minutes: 10, reason: 'r',
  }));
  const db = fakeDb({ drive_segment_overrides: overrides }, { maxRows: 1000 });
  const got = await listOverridesForEntries(overrides.map((o) => o.from_entry_id), db);
  ok(got.length === 2500, `O1: all 2,500 rulings come back (got ${got.length}; the old read dropped every id past 1000)`);
  ok(got.find((o) => o.fromEntryId === 'te_2499')?.paidMinutes === 10, 'O2: a ruling on leg #2,500 is applied, not paid at the unadjusted minutes');
}

// ── the client pager (timeApi.rollup / entriesAll) over the route's paged contract ─
{
  const rows = punches(9000);
  const db = fakeDb({ time_entries: rows }, { maxRows: 1000 });
  const f = { fromIso: iso(BASE), toIso: iso(BASE + 10000 * minute) };
  // The route: offset 0 carries the total; every page is filled past max-rows.
  let requests = 0;
  const route = async (offset, limit) => {
    requests += 1;
    const [total, entries] = await Promise.all([offset === 0 ? countForRollup(f, db) : null, pageForRollup(f, { offset, limit }, db)]);
    return { rows: entries, total };
  };
  const got = await fetchAllPages({ fetchPage: route, pageSize: 2000 });
  const completed = rows.filter((r) => r.clock_out_at).length;
  ok(got.length === completed && new Set(ids(got)).size === completed, `F1: the pay run's rows are every completed punch (${got.length}/${completed})`);
  // Pages overlap by 50 rows (step 1950) and the last reads 50 past the total.
  const expectedPages = 1 + Math.max(0, Math.ceil((completed + 50 - 2000) / 1950));
  ok(requests === expectedPages, `F2: one request per page — ${expectedPages} overlapping pages (${requests})`);
  let fivexx = 0;
  const flaky = async (o, l) => { if (o === 2000 && fivexx < 2) { fivexx += 1; const e = new Error('cold start'); e.status = 503; throw e; } return route(o, l); };
  ok((await fetchAllPages({ fetchPage: flaky, pageSize: 2000, backoffMs: 1 })).length === completed, 'F3: a 5xx page is retried');
  let four = 0;
  const denied = async () => { four += 1; const e = new Error('Insufficient permissions'); e.status = 403; throw e; };
  let deniedErr = null;
  try { await fetchAllPages({ fetchPage: denied, backoffMs: 1 }); } catch (e) { deniedErr = e; }
  ok(deniedErr && four === 1, 'F4: a 4xx is not retried — it surfaces at once');
  // A middle page comes back short (whatever its offset — the pages overlap, so they don't
  // start on round thousands).
  const stingy = async (o, l) => { const r = await route(o, l); return o > 3000 && o < 5000 ? { ...r, rows: r.rows.slice(0, 10) } : r; };
  let short = null;
  try { await fetchAllPages({ fetchPage: stingy, pageSize: 2000, backoffMs: 1 }); } catch (e) { short = e; }
  ok(short instanceof IncompleteFetchError, 'F5: a server that under-delivers is an IncompleteFetchError — the report / pay run shows an error, not partial totals');
  const dupey = async (o, l) => route(Math.max(0, o - 5), l);
  const deduped = await fetchAllPages({ fetchPage: dupey, pageSize: 2000, backoffMs: 1 });
  ok(new Set(ids(deduped)).size === deduped.length, 'F6: rows seen on two pages (churn) are kept once');
}

// ── churn mid-read: a row deleted ahead of a page seam, one added at the end ─────
// The total doesn't move, so a count check can't see it — but every row past the deletion
// slides back one place, and the row that was first on the next page slides onto the page
// already read. Without overlapping pages it is skipped without a word (the pay run is
// short one punch and looks complete). Both halves of the read overlap their pages.
const allDone = (i) => ({ status: 'completed', clock_out_at: iso(BASE + i * minute + 45 * minute), duration_minutes: 45 });
const churn = (table) => {
  table.splice(5, 1); // deleted ahead of every later page
  table.push({ ...table[table.length - 1], id: 'te_replayed', clock_in_at: iso(BASE + 9000 * minute), clock_out_at: iso(BASE + 9045 * minute) });
};
{
  const base = punches(5000, allDone);
  const f = { fromIso: iso(BASE), toIso: iso(BASE + 20000 * minute) };
  const readWith = async (overlap) => {
    const db = fakeDb({ time_entries: base.slice() }, { maxRows: 1000 });
    let served = 0;
    const route = async (offset, limit) => {
      const [total, entries] = await Promise.all([offset === 0 ? countForRollup(f, db) : null, pageForRollup(f, { offset, limit }, db)]);
      served += 1;
      if (served === 1) churn(db.tables.time_entries);
      return { rows: entries, total, limit };
    };
    return fetchAllPages({ fetchPage: route, pageSize: 2000, concurrency: 1, overlap, backoffMs: 1 });
  };
  const seamRow = base[2000].id; // first row of page two — slides onto page one mid-read
  const got = await readWith(undefined);
  ok(got.some((r) => r.id === seamRow) && got.some((r) => r.id === 'te_replayed'), 'F7: the client pager keeps the row that slid across a page seam mid-read');
  const bare = await readWith(0);
  ok(!bare.some((r) => r.id === seamRow), 'F7b (control): without the overlap the same churn silently drops that row — the test has teeth');
}
{
  // Server, page seams: 1000-row pages (one slice each), a row deleted after page one.
  const base = punches(3000, allDone);
  const readWith = async (overlap) => {
    const db = fakeDb({ t: base.slice() }, { maxRows: 1000 });
    let served = 0;
    const count = async () => { const { count: n, error } = await db.from('t').select('id', { count: 'exact', head: true }); if (error) throw error; return n; };
    const page = async (a, b) => {
      const { data, error } = await db.from('t').select('*').order('clock_in_at').order('id').range(a, b);
      if (error) throw error;
      served += 1;
      if (served === 1) churn(db.tables.t);
      return data;
    };
    return selectAll({ count, page, pageSize: 1000, concurrency: 1, overlap });
  };
  const seamRow = base[1000].id;
  ok((await readWith(undefined)).some((r) => r.id === seamRow), 'S5: selectAll keeps the row that slid across a PAGE seam mid-read');
  ok(!(await readWith(0)).some((r) => r.id === seamRow), 'S5b (control): without the page overlap it is dropped, and the count still matches');
}
{
  // Server, slice seams: one range read in max-rows slices — what a 2000-row API page is
  // (pageForRollup / pageForReport), or any page under a max-rows below 1000.
  const base = punches(3000, allDone);
  const readWith = async (opts) => {
    const db = fakeDb({ t: base.slice() }, { maxRows: 1000 });
    let served = 0;
    const page = async (a, b) => {
      const { data, error } = await db.from('t').select('*').order('clock_in_at').order('id').range(a, b);
      if (error) throw error;
      served += 1;
      if (served === 1) churn(db.tables.t);
      return data;
    };
    return rangeFill(page, 0, 2999, opts);
  };
  const seamRow = base[1000].id;
  const got = await readWith({});
  ok(got.some((r) => r.id === seamRow) && new Set(ids(got)).size === got.length, 'S6: rangeFill keeps the row that slid across a SLICE seam, each row once');
  ok(!(await readWith({ overlap: 0 })).some((r) => r.id === seamRow), 'S6b (control): without the slice overlap it is dropped');
  const quiet = await rangeFill(async (a, b) => (await fakeDb({ t: base }, { maxRows: 1000 }).from('t').select('*').order('clock_in_at').order('id').range(a, b)).data, 500, 2499);
  ok(quiet.length === 2000 && quiet[0].id === base[500].id && quiet[1999].id === base[2499].id, 'S6c: with nothing moving, the overlapped slices return exactly the range');
  const keyless = await rangeFill(async (a, b) => base.slice(a, b + 1).map((r) => ({ job_id: r.job_id })), 0, 2999);
  ok(keyless.length === 3000, 'S6d: rows with no key are read without the overlap — never duplicated');
}

// ── the latest inspection per customer (the inspection-reminder walker) ─────────
{
  const N = 3000;
  const insp = Array.from({ length: N }, (_, i) => ({
    id: `li_${String(i).padStart(5, '0')}`, organization_id: ORG, client_id: `c${i % 10}`,
    status: 'submitted', performed_at: iso(BASE + i * 10 * minute),
  }));
  insp[N - 1] = { ...insp[N - 1], status: 'draft' }; // c9's newest: started, never submitted
  insp.push({ id: 'li_ancient', organization_id: ORG, client_id: 'c_gone', status: 'submitted', performed_at: iso(BASE - 400 * 1440 * minute) });
  insp.push({ id: 'li_early', organization_id: ORG, client_id: 'c_early', status: 'submitted', performed_at: iso(BASE + 5 * minute) });
  const db = fakeDb({ inspection_records: insp }, { maxRows: 1000 });
  const sinceIso = iso(BASE - 30 * 1440 * minute);
  const untilIso = iso(BASE + N * 10 * minute);
  const want = Array.from({ length: 10 }, (_, i) => `c${i}`);
  const trueLatest = (c) => insp.filter((r) => r.client_id === c && r.status !== 'draft').map((r) => r.performed_at).sort().pop();
  const before = db.calls.select;
  const latest = await latestInspectionPerClient({ clientIds: want, sinceIso, untilIso }, db);
  const byClient = new Map(latest.map((r) => [r.client_id, r.performed_at]));
  ok(want.every((c) => byClient.get(c) === trueLatest(c)), 'L1: every customer asked about gets its newest SUBMITTED inspection');
  ok(byClient.get('c9') === iso(BASE + (N - 11) * 10 * minute), 'L2: an abandoned draft is not an inspection — c9 reads its last submitted one');
  ok(db.calls.select - before === 1, `L3: every account seen on page one → one query, not a year of pages (${db.calls.select - before})`);
  ok(latest.length === want.length && !byClient.has('c_early'), 'L4: customers not asked about are dropped');
  const early = await latestInspectionPerClient({ clientIds: [...want, 'c_early'], sinceIso, untilIso }, db);
  ok(early.find((r) => r.client_id === 'c_early')?.performed_at === iso(BASE + 5 * minute), 'L5: an account last inspected 3,000 records back is still found — the pages walk until it is seen');
  ok((await latestInspectionPerClient({ clientIds: ['c_gone'], sinceIso, untilIso }, db)).length === 0, 'L6: nothing since sinceIso → absent (reads as never inspected)');
  let threw = null;
  try { await latestInspectionPerClient({ clientIds: want }, db); } catch (e) { threw = e; }
  ok(threw instanceof Error, 'L7: no sinceIso → refused (an unbounded scan never runs)');
  ok((await latestInspectionPerClient({ clientIds: [], sinceIso, untilIso }, db)).length === 0, 'L8: no customers asked about → no read, no rows');
}

console.log(`\ntest-paged-select: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
