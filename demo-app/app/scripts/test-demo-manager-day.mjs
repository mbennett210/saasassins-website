// Node unit test: the demo's MANAGER'S DAY (data/demoManagerDay.js) — Daniel, 2026-10-09: "You
// need to adequately seed whatever a manager can see and tie it to a customer's requests that we
// have built out as well."
//
// Everything a manager's screens read must have data in the login-free demo, true at whatever
// hour it is opened: today's visits in every state (done, on site, late, no check-in, upcoming,
// called out) on REAL seed jobs with real punches, the checklists (saved complete, saved short,
// clocked in with nothing saved), Hours Approval (several people, an off-site punch, overtime),
// inspections (recent scores, one building due), supplies (one waiting, one placed, one over
// budget), and Client Requests raised by the customer IN THE HUB on the manager's buildings —
// with their threads and a mix of deadlines. Every state is judged by the module that owns it
// (lib/managerToday, lib/clientRequests, lib/supplies, lib/managerHome), never restated here.
//
// The data modules are loaded dynamically so the suite RUNS (and reports its counts) on a tree
// where the manager's day does not exist yet: every check then fails instead of the file crashing.
//   node app/scripts/test-demo-manager-day.mjs
import { installResolveShim } from './deletion-core.mjs';

installResolveShim();
const load = async (p) => import(p).catch((e) => { console.error(`  (${p} did not load: ${e.code || e.message})`); return {}; });

const dates = await import('../src/lib/dates.js');
const { INITIAL_STATE } = await import('../src/data/seed.js');
const today = await import('../src/lib/managerToday.js');
const { clientRequestRows } = await import('../src/lib/clientRequests.js');
const supplies = await import('../src/lib/supplies.js');
const { homeScope, inspectionsDueCount, inspectionTrend } = await import('../src/lib/managerHome.js');
const { OT_WEEKLY_MINUTES, payWeekKeyOf } = await import('../src/lib/payroll.js');
const { hubVisitStatus } = await import('../src/lib/hubVisit.js');
const stubKeys = await import('../src/data/stubKeys.js');
const plan = await load('../src/data/demoManagerDay.js');
const ledger = await load('../src/data/demoTimeLedger.js');
const stubs = await load('../src/data/demoStubs.js');
const sandbox = await load('../src/lib/demoSandbox.js');
const persist = await load('../src/store/persist.js');
const team = await import('../src/lib/teamScope.js').catch(() => ({ isOpsManager: () => false }));

let pass = 0;
let fail = 0;
// ok(condition, message) — this file's own order.
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };

const HAVE = typeof plan.buildManagerDay === 'function' && typeof stubs.buildManagerDayStubs === 'function'
  && typeof sandbox.placeManagerDayInState === 'function';
const S = today.VISIT_STATUS;
const C = today.CHECKLIST_STATE;
const G = today.VISIT_GROUP;
const TZ = INITIAL_STATE.company.timezone;
const MGR = plan.MANAGER_DAY_MANAGER_ID || '__missing__';
// S131: the seven active buildings are an Operations Manager's TEAM — Renata (MGR) holds four and a
// second account manager three, both reporting to the OM (data/seed.js). The manager's day is the
// team's day: it is read over the team's buildings (lib/teamScope), as the OM's Home reads it.
const OM = (INITIAL_STATE.users.find((u) => team.isOpsManager(u)) || {}).id || '__missing__';
const TEAM = team.teamMemberIds ? team.teamMemberIds(INITIAL_STATE.users, OM) : [];
const onTeam = (supervisorId) => TEAM.includes(supervisorId);
const WEEK_START = INITIAL_STATE.opsSettings.payWeekStartDay;
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// The day as the bootstrap places it: the plan, the store with its jobs and call-out, the ledger,
// and the checklist saves.
function placed(nowMs) {
  if (!HAVE) return null;
  const day = plan.buildManagerDay(new Date(nowMs), { tz: TZ, weekStartDay: WEEK_START });
  const state = sandbox.placeManagerDayInState(INITIAL_STATE, day, {
    jobIds: plan.MANAGER_DAY_JOB_IDS, timeOffIds: plan.MANAGER_DAY_TIME_OFF_IDS,
  });
  const entries = ledger.buildDemoLedgerEntries(new Date(nowMs), day);
  const md = stubs.buildManagerDayStubs(day);
  return { day, state, entries, md };
}
function judge(p, nowMs) {
  return today.computeManagerToday({
    jobs: p.state.jobs, timeEntries: p.entries, checklists: p.md.checklists, timeOff: p.state.timeOff,
    users: p.state.users, clients: p.state.clients, sites: p.state.sites, opsSettings: p.state.opsSettings,
    managerId: TEAM, now: nowMs, tz: TZ,
  });
}

// ── A. the plan's shape, against its own constants ─────────────────────────────────────────
{
  ok(HAVE, 'A1 the manager\'s day exists: buildManagerDay, buildManagerDayStubs and the store placing');
  ok(Array.isArray(plan.MANAGER_DAY_JOB_IDS) && plan.MANAGER_DAY_JOB_IDS.length > 0, 'A2 the plan names the jobs it owns');
  const book = INITIAL_STATE.clients.filter((c) => onTeam(c.supervisorId) && c.type !== 'vendor' && !c.status);
  ok(book.length >= 7, `A3 the OM's team supervises the seven active buildings (got ${book.length})`);
  const hers = book.filter((c) => c.supervisorId === MGR).length;
  ok(TEAM.length === 3 && TEAM[0] === OM && hers === 4 && book.length - hers === 3,
    `A3b …Renata four, the second account manager three, both on the OM's team (${hers} / ${book.length - hers}, team ${TEAM.length})`);
  const picks = (key, tpl) => (INITIAL_STATE.clients.find((c) => c.id === `cl_seed_${key}`)?.crewChecklists || {});
  ok(Object.values(picks('pacridge')).includes(plan.MD_TEMPLATE_OFFICE), 'A4 Palmetto Ridge assigns its own checklist per cleaner');
  ok(Object.values(picks('evergreen')).includes(plan.MD_TEMPLATE_MEDICAL), 'A5 Las Olas assigns its own checklist per cleaner');
  const tpls = HAVE ? stubs.buildManagerDayStubs(plan.buildManagerDay(new Date())).templates : [];
  ok([plan.MD_TEMPLATE_OFFICE, plan.MD_TEMPLATE_MEDICAL].every((id) => tpls.some((t) => t.id === id && t.kind === 'checklist' && t.client_id)),
    'A6 …and the demo carries both checklists, each filed under its building (R2)');
  const staticIds = new Set(INITIAL_STATE.jobs.map((j) => j.id));
  ok(HAVE && plan.MANAGER_DAY_JOB_IDS.every((id) => !staticIds.has(id)), 'A7 today\'s visits are the plan\'s alone (the static seed does not also carry them)');
}

// ── B. at every hour: visits inside today, no punch in the future, nobody in two places ──────
// Two days: the seed's own day (the series it fixes there are on the board too) and a later one.
const realToday = dates.dayKey(new Date(), TZ);
const DAYS = [realToday, dates.addDaysKey(realToday, 9)];
const HOURS = ['00:20', '01:00', '05:40', '06:00', '07:30', '10:00', '12:00', '14:00', '15:10', '16:30', '18:00', '20:00', '22:00', '23:40'];
const FULL_MIX = new Set(['06:00', '07:30', '10:00', '14:00', '16:30', '20:00', '22:00']);
for (const dk of DAYS) {
  for (const hm of HOURS) {
    const nowMs = Date.parse(dates.composeIso(dk, hm, TZ));
    const p = placed(nowMs);
    const tag = `${dk === realToday ? 'seed day' : 'a later day'} ${hm}`;
    if (!p) { ok(false, `B0 ${tag}: the day was placed`); continue; }
    const dayStart = dates.startOfDayKey(dk, TZ).getTime();
    const dayEnd = dates.startOfDayKey(dates.addDaysKey(dk, 1), TZ).getTime();
    ok(p.day.jobs.every((j) => Date.parse(j.startAt) >= dayStart && Date.parse(j.startAt) < dayEnd), `B1 ${tag}: every visit the plan places starts today`);
    const todays = p.entries.filter((e) => e.id.startsWith(plan.MANAGER_DAY_PREFIX.entry) && !e.id.includes('_ot_'));
    ok(todays.every((e) => Date.parse(e.clock_in_at) <= nowMs && (!e.clock_out_at || Date.parse(e.clock_out_at) <= nowMs)),
      `B2 ${tag}: no punch starts or ends in the future`);
    const jobIds = new Set(p.state.jobs.map((j) => j.id));
    ok(todays.every((e) => jobIds.has(e.job_id)), `B3 ${tag}: today's punches are on REAL seed jobs in the store`);
    // Nobody is in two places: one open punch at most, and no two punches overlap.
    const byUser = new Map();
    for (const e of p.entries) {
      const a = Date.parse(e.clock_in_at);
      const b = e.clock_out_at ? Date.parse(e.clock_out_at) : nowMs;
      if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
      byUser.get(e.user_id).push([a, b, e.id, !e.clock_out_at]);
    }
    let overlap = null;
    let twoOpen = null;
    for (const [u, list] of byUser) {
      if (list.filter((x) => x[3]).length > 1) twoOpen = u;
      list.sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < list.length; i += 1) if (list[i][0] < list[i - 1][1]) overlap = `${list[i - 1][2]} / ${list[i][2]}`;
    }
    ok(!twoOpen, `B4 ${tag}: nobody has two open punches (${twoOpen})`);
    ok(!overlap, `B5 ${tag}: no cleaner's punches overlap (${overlap})`);
    // …and nobody is booked on two of today's visits at once.
    const booked = new Map();
    for (const j of p.state.jobs) {
      const a = Date.parse(j.startAt);
      if (!(a >= dayStart && a < dayEnd) || j.status === 'cancelled') continue;
      for (const u of j.crewIds || []) {
        if (!booked.has(u)) booked.set(u, []);
        booked.get(u).push([a, Date.parse(j.endAt), j.id]);
      }
    }
    let double = null;
    for (const list of booked.values()) {
      list.sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < list.length; i += 1) if (list[i][0] < list[i - 1][1]) double = `${list[i - 1][2]} / ${list[i][2]}`;
    }
    ok(!double, `B6 ${tag}: nobody is booked on two visits at once (${double})`);
    ok(p.md.checklists.every((c) => jobIds.has(c.job_id) && (p.state.jobs.find((j) => j.id === c.job_id)?.crewIds || []).includes(c.completed_by_user_id)),
      `B7 ${tag}: every checklist save is bound to its visit, by someone on it`);

    if (!FULL_MIX.has(hm)) continue;
    // ── C. the full mix on the manager's board (lib/managerToday's own states) ──
    const r = judge(p, nowMs);
    const st = new Set(r.visits.map((v) => v.status));
    for (const k of ['DONE', 'IN_PROGRESS', 'LATE', 'NO_CHECK_IN', 'UPCOMING', 'CALLED_OUT']) {
      ok(st.has(S[k]), `C1 ${tag}: a visit is ${S[k]}`);
    }
    const cl = new Set(r.visits.map((v) => v.checklist));
    for (const k of ['COMPLETE', 'NOT_FINISHED', 'IN_PROGRESS', 'NOT_STARTED']) ok(cl.has(C[k]), `C2 ${tag}: a visit's checklist is ${C[k]}`);
    const short = r.visits.find((v) => v.checklist === C.NOT_FINISHED && v.total);
    ok(!!short && short.completed < short.total, `C3 ${tag}: the short save reads "Not finished · ${short?.completed} of ${short?.total}"`);
    ok(r.counts.day > 0 && r.counts.evening > 0, `C4 ${tag}: both groups are populated (day ${r.counts.day}, evening ${r.counts.evening})`);
    ok(r.counts.properties >= 6, `C5 ${tag}: the day runs across the team's buildings (${r.counts.properties})`);
    const onSite = r.visits.find((v) => v.status === S.IN_PROGRESS && v.clientId === 'cl_seed_mtbaker');
    ok(!!onSite && onSite.crew.length >= 2, `C6 ${tag}: Coral Bay HOA is on site with two cleaners`);
    // The client hub reads the same visit as on site (lib/hubVisit, the server's rule).
    const coral = p.state.clients.find((c) => c.id === 'cl_seed_mtbaker');
    const hub = hubVisitStatus({
      jobs: p.state.jobs.filter((j) => j.clientId === coral.id), punches: p.entries.filter((e) => e.client_id === coral.id),
      checklists: p.md.checklists.filter((c) => c.client_id === coral.id), client: coral, upcoming: [], now: nowMs, tz: TZ,
    });
    ok(hub?.state === 'on_site', `C7 ${tag}: the customer's hub shows Coral Bay's crew on site (${hub?.state})`);
  }
}

// ── D. Hours Approval: several people waiting, one off-site, overtime ─────────────────────────
{
  const nowMs = Date.now();
  const p = placed(nowMs);
  const mine = new Set(INITIAL_STATE.clients.filter((c) => onTeam(c.supervisorId)).map((c) => c.id));
  const pending = (p?.entries || []).filter((e) => e.approval_status === 'pending' && e.clock_out_at && mine.has(e.client_id));
  ok(new Set(pending.map((e) => e.user_id)).size >= 3, `D1 punches wait for approval from several people in the team's buildings (${new Set(pending.map((e) => e.user_id)).size})`);
  ok(pending.some((e) => e.geofence_result === 'outside'), 'D2 …one of them clocked in off site');
  const crewdemo = 'u_seed_crewdemo';
  const weeks = new Map();
  for (const e of (p?.entries || []).filter((x) => x.user_id === crewdemo && x.clock_out_at)) {
    const wk = payWeekKeyOf(e.clock_in_at, WEEK_START, TZ);
    weeks.set(wk, (weeks.get(wk) || 0) + e.duration_minutes);
  }
  const over = [...weeks.values()].some((m) => m > OT_WEEKLY_MINUTES);
  ok(over, `D3 a cleaner worked past ${OT_WEEKLY_MINUTES / 60} hours in a pay week, so overtime waits for the manager`);
  const thisWeek = payWeekKeyOf(new Date(nowMs), WEEK_START, TZ);
  ok([...weeks.keys()].every((k) => k < thisWeek), 'D4 …in a week already over, so it never overlaps today');
}

// ── E. Client Requests the customer raised in the hub, on her buildings, with their threads ───
{
  const nowMs = Date.now();
  const p = placed(nowMs);
  const base = stubs.buildDemoStubs ? (stubs.buildDemoStubs()[stubKeys.QC_PROBLEMS_STUB_KEY]?.problems || []) : [];
  const md = p?.md.problems || [];
  const contact = stubs.DEMO_CLIENT_USER?.id;
  const supervisorOf = (id) => INITIAL_STATE.clients.find((c) => c.id === id)?.supervisorId || null;
  ok(md.length >= 3, `E1 the day adds requests (${md.length})`);
  ok(md.every((t) => t.origin === 'portal' && t.raised_by_client_user_id === contact && t.raised_by_client_name), 'E2 …each raised by the customer contact in the hub (origin portal, HUB-13)');
  ok(md.every((t) => onTeam(supervisorOf(t.client_id))), 'E3 …each on one of the team\'s buildings');
  ok(md.every((t) => t.messages.some((m) => m.author_role === 'client' && m.author_client_user_id === contact)), 'E4 …each opening with the customer\'s own message');
  ok(md.filter((t) => t.messages.some((m) => m.author_role === 'office' && !m.internal)).length >= 2, 'E5 …and the office has answered at least two of them in the thread');
  const rows = clientRequestRows([...base, ...md], { now: nowMs, supervisorOf, managerId: TEAM });
  const states = new Set(rows.map((r) => r.left.state));
  for (const s of ['breached', 'soon', 'paused']) ok(states.has(s), `E6 her queue has a request that is ${s}`);
  ok(rows.some((r) => r.origin === 'internal'), 'E7 …and an issue the office logged itself');
  ok(base.some((t) => t.status === 'resolved' && t.raised_by_client_user_id === contact && onTeam(supervisorOf(t.client_id))), 'E8 the customer has a completed request on the team\'s buildings too');
  ok(md.every((t) => t.id.startsWith(plan.MANAGER_DAY_PREFIX?.ticket ?? '__')), 'E9 the day\'s requests carry the prefix it re-places them by');
}

// ── F. Supplies: one waiting, one order placed, one building over budget ──────────────────────
{
  const nowMs = Date.now();
  const p = placed(nowMs);
  const db = stubs.buildDemoStubs ? stubs.buildDemoStubs()[stubKeys.SUPPLIES_STUB_KEY] : { items: [], requests: [] };
  const merged = HAVE ? sandbox.placeManagerDaySupplies(db, p.md, p.day.monthStartMs) : db;
  const fromMs = dates.startOfDayKey(dates.startOfMonthKey(dates.dayKey(new Date(nowMs), TZ)), TZ).getTime();
  const book = INITIAL_STATE.clients.filter((c) => onTeam(c.supervisorId));
  const spendCents = {};
  for (const c of book) spendCents[c.id] = Math.round(supplies.supplySpendInWindow(merged.requests, { clientId: c.id, fromMs, toMs: nowMs }) * 100);
  const rows = supplies.supplyBuildingRows({ clients: book, requests: merged.requests.filter((r) => !supplies.isSupplySettled(r)), spendCents });
  const counts = supplies.supplyBuildingCounts(rows);
  ok(rows.some((r) => r.waiting > 0), 'F1 a request waits for the manager\'s approval');
  ok(counts.placed >= 1, `F2 a building's order is approved and with the office ("orders placed": ${counts.placed})`);
  ok(rows.some((r) => r.over), 'F3 a building is over its supply budget this month');
  // A delivery from last month is put back in this one, so the budget story holds next month.
  if (HAVE) {
    const lastMonth = merged.requests.map((r) => (r.id.startsWith(plan.MANAGER_DAY_PREFIX.supplyRequest) && r.status === 'completed' ? { ...r, completedAt: iso(fromMs - 3 * 86400000) } : r));
    const again = sandbox.placeManagerDaySupplies({ ...merged, requests: lastMonth }, p.md, p.day.monthStartMs);
    ok(again.requests.filter((r) => r.id.startsWith(plan.MANAGER_DAY_PREFIX.supplyRequest) && r.status === 'completed').every((r) => Date.parse(r.completedAt) >= fromMs),
      'F4 a re-placing moves the over-budget delivery into the current month');
  } else ok(false, 'F4 a re-placing moves the over-budget delivery into the current month');
}

// ── F′. The delivery step (plan 2026-10-12 §2): Demo Crew's buildings today read "Supplies on the
//    way" and "Delivered today", and the office has a sent request for the driver's list ──────────
{
  const realToday = dates.dayKey(new Date(), TZ);
  const at14 = Date.parse(dates.composeIso(realToday, '14:00', TZ));
  const crewScope = await import('../src/lib/crewScope.js');
  const lineFor = (requests, p, nowMs) => {
    const todayK = dates.dayKey(new Date(nowMs), TZ);
    const ids = typeof crewScope.crewTodayClientIds === 'function'
      ? crewScope.crewTodayClientIds({ jobs: p.state.jobs, sites: p.state.sites, userId: 'u_seed_crewdemo', todayKey: todayK, dayKeyOf: (v) => dates.dayKey(v, TZ) })
      : new Set();
    return typeof supplies.supplyCrewBuildings === 'function'
      ? supplies.supplyCrewBuildings({ requests, clientIds: ids, dayStartMs: dates.startOfDayKey(todayK, TZ).getTime() })
      : [];
  };
  const p = placed(at14);
  const db = stubs.buildDemoStubs ? stubs.buildDemoStubs()[stubKeys.SUPPLIES_STUB_KEY] : { items: [], requests: [] };
  const merged = HAVE ? sandbox.placeManagerDaySupplies(db, p.md, p.day.monthStartMs, { replaceIds: plan.MANAGER_DAY_DAILY_SUPPLY_IDS }) : db;
  const lines = HAVE ? lineFor(merged.requests, p, at14) : [];
  ok(lines.some((b) => b.onTheWay.length > 0), 'F5 a building Demo Crew cleans today has supplies on the way (sent)');
  ok(lines.some((b) => b.delivered.length > 0), 'F6 … and one had supplies delivered today');
  // S131: an order with the supplier carries its per-line record (no "how many went out"), who
  // submitted it and when — and a line backordered with the supplier's day.
  ok(merged.requests.some((r) => r.status === 'sent' && Array.isArray(r.fulfillment) && r.fulfillment.length === (r.lines || []).length
    && r.fulfillment.some((e) => e.backorder && /^\d{4}-\d{2}-\d{2}$/.test(e.backorder.eta || '')) && r.sentAt && r.sentByName && !Array.isArray(r.sentLines)),
    'F7 the office\'s submitted order carries its per-line record (a backorder with its ETA), who submitted it and when');
  // A day placed again tomorrow keeps both TODAY: the day's own supply rows are re-placed with it.
  if (HAVE) {
    const next = at14 + 24 * 60 * MIN;
    const p2 = placed(next);
    const again = sandbox.placeManagerDaySupplies(merged, p2.md, p2.day.monthStartMs, { replaceIds: plan.MANAGER_DAY_DAILY_SUPPLY_IDS });
    const l2 = lineFor(again.requests, p2, next);
    ok(l2.some((b) => b.onTheWay.length > 0) && l2.some((b) => b.delivered.length > 0), 'F8 re-placed the next day, the sent and delivered-today rows are today\'s again');
    ok(again.requests.filter((r) => (plan.MANAGER_DAY_DAILY_SUPPLY_IDS || []).includes(r.id)).length === (plan.MANAGER_DAY_DAILY_SUPPLY_IDS || []).length
      && (plan.MANAGER_DAY_DAILY_SUPPLY_IDS || []).length >= 2, 'F9 … replaced, never doubled');
  } else {
    ok(false, 'F8 re-placed the next day, the sent and delivered-today rows are today\'s again');
    ok(false, 'F9 … replaced, never doubled');
  }
}

// ── G. Inspections: recent scores, one building due ──────────────────────────────────────────
{
  const nowMs = Date.now();
  const inspections = stubs.buildDemoStubs ? (stubs.buildDemoStubs()[stubKeys.QC_INSPECTIONS_STUB_KEY]?.inspections || []) : [];
  // The OM's Home (lib/managerHome homeScope over the team).
  const om = INITIAL_STATE.users.find((u) => u.id === OM) || { role: 'manager', id: OM };
  const scope = homeScope({ viewer: om, clients: INITIAL_STATE.clients, users: INITIAL_STATE.users });
  const due = inspectionsDueCount({ clients: INITIAL_STATE.clients, latest: inspections, scope, now: nowMs, settings: INITIAL_STATE.opsSettings });
  ok(due >= 1, `G1 a building in the team's book is due an inspection (${due})`);
  const hers = inspections.filter((i) => scope.clientIds?.has(i.client_id));
  ok(inspectionTrend(hers).trend.length >= 3, 'G2 …and the team\'s buildings have recent scores to trend');
}

// ── H. a browser seeded before: the v58 hop hands her the book without undoing the viewer's work ─
{
  const hop = persist.migrateV57toV58;
  ok(typeof hop === 'function', 'H1 store/persist has the v57 → v58 hop');
  if (typeof hop === 'function') {
    const v57 = {
      version: 57,
      clients: [
        { id: 'cl_seed_pacridge', supervisorId: 'u_seed_heather' },
        { id: 'cl_seed_olympic', supervisorId: 'u_seed_steve' },          // the viewer re-assigned it
        { id: 'cl_seed_lakeside' },
        { id: 'cl_seed_evergreen', supervisorId: 'u_seed_mgr1', crewChecklists: { u_seed_crew4: 'it_closeout' } },
        { id: 'cl_mine', supervisorId: null },                              // a customer the viewer made
      ],
    };
    const out = hop(v57);
    const by = (id) => out.clients.find((c) => c.id === id);
    ok(out.version === 58, 'H2 …lands on 58');
    ok(by('cl_seed_pacridge').supervisorId === MGR && by('cl_seed_lakeside').supervisorId === MGR, 'H3 …seed buildings still on their seed supervisor move to Renata');
    ok(by('cl_seed_olympic').supervisorId === 'u_seed_steve', 'H4 …a building the viewer re-assigned keeps their choice');
    ok(by('cl_seed_evergreen').crewChecklists.u_seed_crew4 === 'it_closeout' && by('cl_seed_evergreen').crewChecklists.u_seed_crewdemo === plan.MD_TEMPLATE_MEDICAL,
      'H5 …a cleaner\'s own pick is never overwritten, a missing one is added');
    ok(by('cl_mine').supervisorId === null, 'H6 …and a customer the viewer made is untouched');
  }
}

// ── I. a browser seeded before S131: the v59 hop builds the OM's team (store/persist) ──────────
{
  const hop = persist.migrateV58toV59;
  ok(typeof hop === 'function', 'I1 store/persist has the v58 → v59 hop');
  if (typeof hop === 'function') {
    const v58 = {
      version: 58,
      users: [
        { id: 'u_seed_mgr1', role: 'manager', name: 'Renata Cruz' },
        { id: 'u_seed_supply1', role: 'supply_manager', name: 'Kept as the viewer left it' }, // already there
      ],
      clients: [
        { id: 'cl_seed_cascade', supervisorId: 'u_seed_mgr1' },
        { id: 'cl_seed_olympic', supervisorId: 'u_seed_steve' },          // the viewer re-assigned it
        { id: 'cl_seed_salishan', supervisorId: 'u_seed_mgr1' },
        { id: 'cl_seed_evergreen', supervisorId: 'u_seed_mgr1' },         // stays Renata's
        { id: 'cl_mine', supervisorId: 'u_seed_mgr1' },                   // a customer the viewer made
      ],
    };
    const out = hop(v58);
    const by = (id) => out.clients.find((c) => c.id === id);
    const u = (id) => out.users.filter((x) => x.id === id);
    const seedOm = INITIAL_STATE.users.find((x) => x.id === OM);
    // CS-858 bumped the seed to v60 (the Operations Manager's column); the v59 hop still lands on 59,
    // and the next hop carries it on to the seed's version.
    ok(out.version === 59 && typeof persist.migrateV59toV60 === 'function' && persist.migrateV59toV60(out).version === INITIAL_STATE.version,
      'I2 …lands on 59, and the v60 hop carries it on to the seed\'s version (lockstep)');
    ok(u(OM).length === 1 && team.isOpsManager(u(OM)[0]) && u('u_seed_mgr2').length === 1 && u('u_seed_mgr2')[0].opsManagerId === OM
      && !!seedOm && seedOm.name === u(OM)[0].name,
      'I3 …the Operations Manager and the second account manager join, as the seed has them');
    ok(u('u_seed_supply1').length === 1 && u('u_seed_supply1')[0].name === 'Kept as the viewer left it', 'I4 …a member already there is never duplicated or rewritten');
    ok(u('u_seed_mgr1')[0].opsManagerId === OM, 'I5 …Renata reports to the OM');
    ok(by('cl_seed_cascade').supervisorId === 'u_seed_mgr2' && by('cl_seed_salishan').supervisorId === 'u_seed_mgr2'
      && by('cl_seed_evergreen').supervisorId === 'u_seed_mgr1', 'I6 …the three seed buildings still on Renata move to the second AM, the rest stay');
    ok(by('cl_seed_olympic').supervisorId === 'u_seed_steve' && by('cl_mine').supervisorId === 'u_seed_mgr1',
      'I7 …a building the viewer re-assigned, and one they made, are untouched');
    const again = hop({ ...out, version: 58 });
    ok(again.users.length === out.users.length, 'I8 …and it is idempotent (a second run adds nobody)');
  }
}

// ── R. the same day over another book (app/scripts/seed-backend.mjs resolves the slots) ────────
{
  const day = HAVE ? plan.buildManagerDay(new Date(Date.parse(dates.composeIso(realToday, '14:00', TZ))), {
    tz: TZ, weekStartDay: WEEK_START,
    resolve: { client: (k) => `C-${k}`, site: (k) => `S-${k}`, user: (k) => `U-${k}`, service: (k) => `V-${k}`, job: (k) => `J-${k}` },
  }) : null;
  ok(!!day && day.jobs.every((j) => j.id.startsWith('J-') && j.clientId.startsWith('C-') && j.siteId.startsWith('S-') && j.crewIds.every((u) => u.startsWith('U-'))),
    'R1 every job of the day is written in the ids the caller resolves');
  const cover = day?.jobs.find((j) => j.coverFor);
  ok(!!cover && Object.entries(cover.coverFor).every(([a, b]) => a.startsWith('U-') && b.startsWith('U-')), 'R2 …the cover too');
  ok(!!day && day.timeOff.every((t) => t.userId.startsWith('U-') && t.createdBy.startsWith('U-')), 'R3 …and the call-out');
  ok(!!day && day.checklists.every((c) => c.userId?.startsWith('U-') && c.clientId?.startsWith('C-') && c.siteId?.startsWith('S-') && typeof c.complete === 'boolean'),
    'R4 each save carries its resolved ids and whether it is the whole checklist');
  ok(!!day && day.entries.some((e) => e.ot) && day.entries.filter((e) => e.ot).every((e) => e.jobKey && e.client),
    'R5 the overtime week names its own visits (a backend punch needs a job)');
  const P = plan.MANAGER_DAY_REQUESTS || [];
  ok(P.length >= 3 && P.every((r) => Object.keys(plan.MANAGER_DAY_SLOTS?.buildings || {}).includes(r.building) && r.messages[0]?.role === 'client'),
    'R6 the requests are written in building slots, each opening with the customer');
  const text = plan.managerDayText;
  ok(typeof text === 'function' && text('Thanks {client}. {crew2} is due', { client: 'Sasha Lin', crew2: 'Tomas Rivera' }) === 'Thanks Sasha. Tomas is due'
    && text('Thanks {client}. {crew2} is due', {}) === 'Thanks. Our cleaner is due', 'R7 a message reads right with names and without them');
}

// ── X. the other managers' visits (the production sandbox's four managers) ────────────────────
// The same crew's free time around her day: at every hour, nobody booked or on the clock twice,
// every visit inside today, and the other managers' views hold done, upcoming and called-out visits.
{
  const resolve = {
    client: (k) => `C-${k}`, site: (k) => `S-${k}`, user: (k) => `U-${k}`, service: (k) => `V-${k}`, job: (k) => `J-${k}`,
  };
  const xs = new Set();
  for (const hm of HOURS) {
    const nowMs = Date.parse(dates.composeIso(realToday, hm, TZ));
    const day = HAVE ? plan.buildManagerDay(new Date(nowMs), { tz: TZ, weekStartDay: WEEK_START, resolve, extra: 8 }) : null;
    if (!day) { ok(false, `X0 ${hm}: the day with the other managers' visits is placed`); continue; }
    const dayStart = dates.startOfDayKey(realToday, TZ).getTime();
    const dayEnd = dates.startOfDayKey(dates.addDaysKey(realToday, 1), TZ).getTime();
    ok(day.jobs.every((j) => Date.parse(j.startAt) >= dayStart && Date.parse(j.startAt) < dayEnd), `X1 ${hm}: every visit starts today`);
    const booked = new Map();
    for (const j of day.jobs) for (const u of j.crewIds) { if (!booked.has(u)) booked.set(u, []); booked.get(u).push([Date.parse(j.startAt), Date.parse(j.endAt), j.id]); }
    let double = null;
    for (const list of booked.values()) { list.sort((a, b) => a[0] - b[0]); for (let i = 1; i < list.length; i += 1) if (list[i][0] < list[i - 1][1]) double = `${list[i - 1][2]} / ${list[i][2]}`; }
    ok(!double, `X2 ${hm}: nobody is booked on two visits at once (${double})`);
    const spans = new Map();
    for (const e of day.entries.filter((x) => !x.ot)) { if (!spans.has(e.user)) spans.set(e.user, []); spans.get(e.user).push([e.inAt, e.inAt + e.dur * MIN, e.id]); }
    // the on-site punches (the ledger file's own): crew2 from 38 minutes ago, crew3 from 12
    const ON = plan.MD_ON_SITE || { firstInMinsAgo: 0, secondInMinsAgo: 0 };
    if (day.jobs.some((j) => j.id === 'J-cbay-w1')) {
      spans.set('crew2', [...(spans.get('crew2') || []), [nowMs - ON.firstInMinsAgo * MIN, nowMs, 'on site']]);
      spans.set('crew3', [...(spans.get('crew3') || []), [nowMs - ON.secondInMinsAgo * MIN, nowMs, 'on site']]);
    }
    let overlap = null;
    for (const list of spans.values()) { list.sort((a, b) => a[0] - b[0]); for (let i = 1; i < list.length; i += 1) if (list[i][0] < list[i - 1][1]) overlap = `${list[i - 1][2]} / ${list[i][2]}`; }
    ok(!overlap, `X3 ${hm}: no cleaner's punches overlap (${overlap})`);
    ok(day.entries.every((e) => e.inAt + e.dur * MIN <= nowMs || e.ot), `X4 ${hm}: no punch ends in the future`);
    for (const j of day.jobs.filter((x) => /^J-md-x/.test(x.id))) xs.add(j.status);
  }
  ok(['done', 'upcoming'].every((st) => xs.has(st)) && [...xs].length >= 2, `X5 the other managers' visits are done and upcoming over the day (${[...xs].join(', ')})`);
  const day14 = HAVE ? plan.buildManagerDay(new Date(Date.parse(dates.composeIso(realToday, '14:00', TZ))), { tz: TZ, weekStartDay: WEEK_START, resolve, extra: 8 }) : null;
  ok(!!day14 && day14.jobs.some((j) => j.id === 'J-md-x7' && j.crewIds.includes('U-crew1')), 'X6 …and Andre\'s morning round is on an other manager\'s building (called out with him)');
  ok(!!day14 && (plan.buildManagerDay(new Date(), { tz: TZ, weekStartDay: WEEK_START }).jobs.every((j) => !/md-x/.test(j.id))), 'X7 the demo (one manager) places none of them');
}

// ── M. the customer's messages in the demo (Messaging → Customers' waiting messages, and the Home's count) ──
{
  const nowMs = Date.now();
  const p = placed(nowMs);
  const msgs = p?.md.messages || [];
  const contact = stubs.DEMO_CLIENT_USER?.id;
  const byBuilding = new Map();
  for (const m of [...msgs].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))) byBuilding.set(m.client_id, m);
  const waiting = [...byBuilding.values()].filter((m) => m.author_role === 'client');
  ok(waiting.length >= 2, `M1 at least two customer messages wait for the office's first reply (${waiting.length})`);
  ok(waiting.some((m) => nowMs - Date.parse(m.created_at) < 30 * MIN) && waiting.some((m) => nowMs - Date.parse(m.created_at) > 30 * MIN),
    'M2 …one inside the half hour and one past it');
  ok([...byBuilding.values()].some((m) => m.author_role === 'staff'), 'M3 …and one thread the office has answered');
  const mine = new Set(INITIAL_STATE.clients.filter((c) => onTeam(c.supervisorId)).map((c) => c.id));
  ok(msgs.length > 0 && msgs.every((m) => mine.has(m.client_id)), 'M4 every message is on one of the team\'s buildings');
  ok(msgs.filter((m) => m.author_role === 'client').every((m) => m.author_client_user_id === contact), 'M5 the customer\'s lines are the hub contact\'s own');
  ok(msgs.every((m) => m.id.startsWith(plan.MANAGER_DAY_PREFIX?.message ?? '__')) && msgs.every((m) => !/\{[a-z,0-9]+\}/.test(m.body)),
    'M6 they carry the prefix they are re-placed by, and read with names filled in');
  if (HAVE) {
    const later = sandbox.moveOwnedRows([...msgs, { id: 'viewer_reply', client_id: msgs[0]?.client_id, created_at: new Date(nowMs).toISOString() }], msgs, 2 * 3600 * 1000);
    ok(msgs.length > 0 && later.some((m) => m.id === 'viewer_reply') && later.find((m) => m.id === msgs[0]?.id)?.created_at === new Date(Date.parse(msgs[0]?.created_at) + 2 * 3600 * 1000).toISOString(),
      'M7 a re-placing moves them with the clock and keeps the viewer\'s reply');
  } else ok(false, 'M7 a re-placing moves them with the clock and keeps the viewer\'s reply');
}

// ── S. the production sandbox's seed: the same day, idempotent, never another row ──────────────
// (the write path itself, over a fixture book and a fake Postgres client: test-seed-backend-write.mjs)
{
  const { readFileSync } = await import('node:fs');
  const strip = (t) => t.replace(/^\s*\/\/.*$/gm, '');
  const src = strip(readFileSync(new URL('./seed-backend.mjs', import.meta.url), 'utf8'));
  const readOr = (u) => { try { return readFileSync(u, 'utf8'); } catch { return ''; } };
  const lib = strip(readOr(new URL('./_lib/managerDaySeed.mjs', import.meta.url)));
  ok(/from '\.\.\/\.\.\/src\/data\/demoManagerDay\.js'/.test(lib) && /buildManagerDay\(/.test(lib) && /from '\.\/_lib\/managerDaySeed\.mjs'/.test(src),
    'S1 seed-backend builds the same manager\'s day (the demo\'s own plan, through scripts/_lib/managerDaySeed)');
  ok(/D\('problem_reports', \[\{ col: 'id', op: 'in', value: seedWoIds \}\]\)/.test(src) && !/\.delete\(\)/.test(src),
    'S2 it deletes only its own work orders, by id, and issues no delete outside its plan');
  ok(/D\('checklist_results', \[\{ col: 'id', op: 'in', value: mdIds\.checklistIds \}\]/.test(src), 'S3 the day\'s checklist saves are found by their seed ids (before the jobs they name)');
  ok(/D\('supply_requests', \[\{ col: 'id', op: 'like', value: `\$\{MD_SUPPLY_REQUEST_PREFIX\}%` \}\]/.test(src)
    && /D\('supply_items', \[\{ col: 'id', op: 'like', value: `\$\{MD_SUPPLY_ITEM_PREFIX\}%` \}\]/.test(src), 'S4 …and its supply rows by their seed prefixes');
  // The master supply list (2026-10-11): the catalog is the org's — the seed upserts the items its
  // day uses (before the switches that name them) and never deletes one, and writes no SKU.
  ok(/U\('supply_catalog', mdOut\?\.supplyCatalogRows/.test(src) && !/D\('supply_catalog'/.test(src)
    && src.indexOf("U('supply_catalog'") < src.indexOf("U('supply_items'")
    && /supplyBackfillCatalogId\(/.test(lib) && !/\bsku: c\.sku\b/.test(lib),
    'S4b …the master list\'s rows are upserted on their backfill ids, before the switches, with no SKU, and never deleted');
  ok(/MD_JOB_PREFIX = 'j_bkseed_md_'/.test(lib) && /D\('jobs', \[\{ col: 'id', op: 'like', value: 'j_bkseed_%' \}\]\)/.test(src), 'S5 its jobs carry the seed prefix the jobs and punches clean-up already finds');
  ok(/const COMMIT = process\.argv\.includes\('--commit'\)/.test(src) && /if \(!COMMIT\) \{[\s\S]*?DRY RUN — nothing written/.test(src), 'S6 it is still a dry run unless --commit');
  ok(/begin transaction read only/.test(src) && /runPgPlan\(/.test(src) && /pgTarget\(/.test(src),
    'S7 over Postgres the dry run reads READ ONLY, and --commit is one checked transaction to the one allowed project');
}

console.log(`\n${pass}/${pass + fail} manager's-day assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exitCode = 1; }
