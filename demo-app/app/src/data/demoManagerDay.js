// The demo's MANAGER'S DAY (the manager view redesign, 2026-10-09). Daniel: "You need to adequately
// seed whatever a manager can see and tie it to a customer's requests that we have built out as
// well." Renata Cruz (u_seed_mgr1) supervises seven buildings (data/seed.js; store/persist
// migrateV57toV58 hands them to her in a browser seeded before), and this is HER TODAY in them:
// one of every state the manager screens draw (lib/managerToday), placed around `now` so it is
// true at whatever hour the demo is opened.
//
//   done          Palmetto Ridge (Keisha, checklist saved complete), Las Olas (Luis, checklist
//                 saved SHORT, "Not finished · 7 of 9"), Flagler Townhomes (Luis, out half an
//                 hour ago, the client hub's "visit complete"), and for an evening viewer a
//                 morning floor clean at Lakeside (Tomas) so the Day group is never empty
//   on site now   Coral Bay HOA: Tomas (covering Andre, his Floor Care under way and nothing saved
//                 yet) and Keisha. Their open punches are data/demoTimeLedger.js's (the client
//                 hub's "who's on site now", HUB-5); the visit starts MD_ON_SITE.earlyMins after
//                 the first arrival, so the hub reads "Arrived 2 min early"
//   no check-in   Lakeside Office Park: Demo Crew, 75 minutes past the start (past the missed mark)
//   late          Las Olas: Demo Crew again, 12 minutes past the start (inside the mark)
//   upcoming      Palmetto Ridge tonight (Demo Crew) and Bayshore (Luis): the Evening group; and
//                 Keisha's next stop at Lakeside after Coral Bay (the Cleaner Hub's demo cleaner)
//   called out    Gulfstream Logistics: Andre's nightly deep clean; he called out sick this morning
//
// A visit whose time falls outside today (a 5-hours-ago clean opened at 3 AM) is left out: the
// mix is complete from about 6 AM to 11 PM and thins at the ends of the day, as a real one would.
//
// PURE. Nothing here reads the clock or the store: buildManagerDay(now) is a function of `now`, the
// org's zone and the pay week's first day, and every id is a stable seed id. The rows it describes
// are built by their own modules — the punches by data/demoTimeLedger.js (the stub ledger's row
// shape), the checklist saves, work orders, templates and supply rows by data/demoStubs.js
// buildManagerDayStubs (each stub's row shape) — and lib/demoBootstrap places them: on the first
// load and ?demo=reset, and again whenever the day it placed is over two hours old or yesterday
// (lib/demoSandbox managerDayStale). What it owns is listed below by id, so a re-placing replaces
// exactly those rows and never a record the viewer made.
import { seedId } from '../lib/ids.js';
import {
  DEFAULT_ORG_TIMEZONE, dayKey, addDaysKey, composeIso, startOfDayKey, startOfMonthKey, dayOfWeekKey,
} from '../lib/dates.js';

const MIN = 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');
const U = (k) => seedId('u', k);
const CL = (k) => seedId('cl', k);
const ST = (k) => seedId('st', k);
const SVC = (k) => seedId('svc', k);

export const MANAGER_DAY_MANAGER_ID = U('mgr1');

// The on-site visit at Coral Bay: the two clock-ins (minutes before now — data/demoTimeLedger.js
// writes them as `openMinsAgo`, so the ledger file carries "someone on site now") and how long
// after the first one the visit was due to start.
export const MD_ON_SITE = Object.freeze({ firstInMinsAgo: 38, secondInMinsAgo: 12, earlyMins: 2 });

// The two checklists filed under a building the day's cleaners owe at (data/demoStubs.js builds
// their rows; data/seed.js assigns them per cleaner — the only way a checklist reaches one, R3).
export const MD_TEMPLATE_OFFICE = 'it_md_office';   // Palmetto Ridge Corp's Office Nightly Clean
export const MD_TEMPLATE_MEDICAL = 'it_md_medical'; // Las Olas Medical Group's Medical Office Clean

// ── what the plan owns, by id ───────────────────────────────────────────────────────────────
// The jobs. A re-placing removes all of them from the store and puts back the ones that fit today.
// Most are one-off visits; cbay-w1 is this week's visit of the Coral Bay weekly series, the cover
// (R8) the seed has always carried — Tomas covering Andre, who is called out today — so it moves
// with the call-out and is marked a one-off in both crew and time.
export const MANAGER_DAY_JOB_KEYS = Object.freeze([
  'today-3', 'ck-demo', 'md-flagler', 'today-2', 'cbay-w1', 'cs-today-1',
  'md-callout', 'cs-today-2', 'md-evening', 'md-morning', 'md-crew-next',
]);
export const MANAGER_DAY_JOB_IDS = Object.freeze(MANAGER_DAY_JOB_KEYS.map((k) => seedId('j', k)));
// The call-out booked this morning.
export const MANAGER_DAY_TIME_OFF_IDS = Object.freeze([seedId('to', 'andre-out')]);
// The other stubs' rows, by id prefix: the punches (data/demoTimeLedger.js), the checklist saves,
// the work orders the customer raised in the hub, and the supply rows (data/demoStubs.js).
export const MANAGER_DAY_PREFIX = Object.freeze({
  entry: 'te_demo_md_',
  checklist: 'cr_md_',
  ticket: 'pr_md_',
  supplyItem: seedId('si', 'md-'),
  supplyRequest: seedId('sr', 'md-'),
  // the demo's customer messages of the day (uuid-shaped, as client_messages ids are)
  message: 'dec0de11-',
});
// The visits at the OTHER managers' buildings (`extra` below): the production sandbox has four
// managers, and each one's view must hold a day too. Building slots x1…x8, filled by the caller.
export const MANAGER_DAY_EXTRA_KEYS = Object.freeze(['x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8']);
export const ownsId = (prefix) => (row) => !!row && typeof row.id === 'string' && row.id.startsWith(prefix);

// The SLOTS the day is written in: the seed keys of the buildings (with their locations) and of the
// people. The demo resolves them to the seed's own ids; app/scripts/seed-backend.mjs resolves them
// to the live book's (the manager's own buildings, the crew on the roster), so the production
// sandbox gets the same day.
export const MANAGER_DAY_SLOTS = Object.freeze({
  buildings: Object.freeze({
    pacridge: 'pac-tower', evergreen: 'evgrn-main', salishan: 'sal-main', lakeside: 'lake-main',
    mtbaker: 'mtb-clbhs', cascade: 'csc-main', olympic: 'oly-main',
  }),
  crew: Object.freeze(['crew1', 'crew2', 'crew3', 'crew4', 'crewdemo']),
  owner: 'kyler',
});
const SEED_RESOLVE = Object.freeze({
  client: CL, site: ST, user: U, service: SVC, job: (key) => seedId('j', key),
});

// The day's visits, as the plan builds them. Each: { key, client, site, service, crew (user keys),
// startMs, mins, status, notes, extra, punches: [{ user, inMs, outMs }], checklist }.
// `checklist` is the save on that visit, when there is one: { user, template, done, total, atMs }.
// `total` is null for a whole template (the schema's own count is used).
function visitsFor(N, { dayStart, dayEnd, wall }) {
  const rel = (mins) => N + mins * MIN;
  const eveningViewer = N >= wall(15);
  const out = [];
  const add = (v) => { if (v.startMs >= dayStart + 5 * MIN && v.startMs < dayEnd - 5 * MIN) out.push(v); };

  // DONE — Palmetto Ridge's early office clean: Keisha, her Office Nightly Clean saved complete.
  {
    const s = rel(-330);
    add({
      key: 'today-3', client: 'pacridge', site: 'pac-tower', service: 'jan', crew: ['crew3'], startMs: s, mins: 120,
      status: 'done', notes: 'Tower A. Early office clean before the building opens.',
      punches: [{ user: 'crew3', inMs: s - 3 * MIN, outMs: s + 118 * MIN, dist: 9 }],
      checklist: { user: 'crew3', template: MD_TEMPLATE_OFFICE, done: 9, total: null, complete: true, atMs: s + 112 * MIN },
    });
  }
  // DONE — Las Olas Medical Group: Luis left with two items of the Medical Office Clean undone.
  {
    const s = rel(-270);
    add({
      key: 'ck-demo', client: 'evergreen', site: 'evgrn-main', service: 'jan', crew: ['crew4'], startMs: s, mins: 100,
      status: 'done', notes: 'Main Hospital. Clinic-wing clean.',
      punches: [{ user: 'crew4', inMs: s + 1 * MIN, outMs: s + 96 * MIN, dist: 14 }],
      checklist: { user: 'crew4', template: MD_TEMPLATE_MEDICAL, done: 7, total: null, complete: false, atMs: s + 92 * MIN },
    });
  }
  // DONE — Flagler Townhomes: Luis checked out half an hour ago after 1 h 25 min, his Close-Out
  // checklist saved ten minutes before he left (the client hub's "visit complete"). Nobody owes a
  // checklist here, so the manager's Checklists today reads none for it.
  {
    const inMs = rel(-115);
    const outMs = rel(-30);
    add({
      key: 'md-flagler', client: 'salishan', site: 'sal-main', service: 'jan', crew: ['crew4'], startMs: inMs - 3 * MIN, mins: 90,
      status: 'done', notes: 'Common areas and the pool house.',
      punches: [{ user: 'crew4', inMs, outMs, dist: 12 }],
      checklist: { user: 'crew4', template: 'it_closeout', done: 5, total: null, complete: true, atMs: outMs - 10 * MIN },
    });
  }
  // NO CHECK-IN — Lakeside Office Park: Demo Crew, 75 minutes past the start and nobody in.
  add({
    key: 'today-2', client: 'lakeside', site: 'lake-main', service: 'flr', crew: ['crewdemo'], startMs: rel(-75), mins: 60,
    status: 'upcoming', notes: 'Main Campus. Lobby floor buff.', punches: [], checklist: null,
  });
  // ON SITE — Coral Bay HOA: Tomas covering Andre (his Floor Care, nothing saved yet) and Keisha.
  add({
    key: 'cbay-w1', client: 'mtbaker', site: 'mtb-clbhs', service: 'jan', crew: ['crew2', 'crew3'],
    startMs: rel(-MD_ON_SITE.firstInMinsAgo + MD_ON_SITE.earlyMins), mins: 90,
    status: 'in_progress', notes: 'Tomas covering for Andre (called out). Keisha helping with the pool house.',
    extra: {
      seriesId: seedId('ser', 'coralbay-weekly'),
      oneOff: { crew: true, time: true },
      coverFor: { crew2: 'crew1' }, // slot keys: Tomas covers Andre
    },
    punches: [], // data/demoTimeLedger.js: the two open punches, written as openMinsAgo
    checklist: null,
  });
  // UPCOMING — the Cleaner Hub's demo cleaner (brief A, 2026-10-13): Keisha's next stop after Coral
  // Bay, at Lakeside Office Park (a located building, so the Clock in screen draws its ring), so her Home
  // reads Clock out at Coral Bay (her open punch, the ledger file's) with a second stop to come. It starts
  // after Coral Bay ends and ends before her other managers' evening visit (x5, the production sandbox).
  add({
    key: 'md-crew-next', client: 'lakeside', site: 'lake-main', service: 'rst', crew: ['crew3'],
    startMs: rel(-MD_ON_SITE.firstInMinsAgo + MD_ON_SITE.earlyMins + 90 + 15), mins: 45,
    status: 'upcoming', notes: 'Main Campus. Restroom touch-up after Coral Bay.', punches: [], checklist: null,
  });
  // LATE — Las Olas Medical Group: Demo Crew, 12 minutes past the start (the live clock-in path:
  // switch to Demo Crew, open My Day, clock in, and the manager's board turns this visit on site).
  add({
    key: 'cs-today-1', client: 'evergreen', site: 'evgrn-main', service: 'jan', crew: ['crewdemo'], startMs: rel(-12), mins: 120,
    status: 'upcoming', notes: 'Main Hospital. Daily janitorial.', punches: [], checklist: null,
  });
  // CALLED OUT — Gulfstream Logistics: Andre's nightly warehouse deep clean (the ledger's history
  // carries his past ones); he called out sick this morning.
  add({
    key: 'md-callout', client: 'cascade', site: 'csc-main', service: 'pw', crew: ['crew1'], startMs: wall(17, 30), mins: 360,
    status: 'upcoming', notes: 'Warehouse 1. Nightly deep clean.', punches: [], checklist: null,
  });
  // UPCOMING — Palmetto Ridge tonight (Demo Crew), after the late Las Olas visit.
  add({
    key: 'cs-today-2', client: 'pacridge', site: 'pac-tower', service: 'jan', crew: ['crewdemo'], startMs: rel(150), mins: 120,
    status: 'upcoming', notes: 'Tower A. Evening service.', punches: [], checklist: null,
  });
  // UPCOMING — Bayshore Senior Living: Luis at 7 PM, or an hour from now when it is later than 3.
  add({
    key: 'md-evening', client: 'olympic', site: 'oly-main', service: 'rst', crew: ['crew4'],
    startMs: eveningViewer ? rel(60) : wall(19), mins: 90,
    status: 'upcoming', notes: 'Main Residence. Restroom sanitation, west wing first.', punches: [], checklist: null,
  });
  // DONE — for an evening viewer, the morning's floor clean at Lakeside (Tomas), so the Day group
  // still shows the morning. Before 3 PM the day's own visits are the Day group.
  if (eveningViewer) {
    const s = wall(7);
    add({
      key: 'md-morning', client: 'lakeside', site: 'lake-main', service: 'flr', crew: ['crew2'], startMs: s, mins: 120,
      status: 'done', notes: 'Main Campus. Morning floor care.',
      punches: [{ user: 'crew2', inMs: s - 3 * MIN, outMs: s + 123 * MIN, dist: 10 }],
      checklist: null,
    });
  }
  return out;
}

// The visits at the other managers' buildings, fitted into the same crew's free time around the
// day above (nobody is booked or on the clock twice): three done before the on-site visit — whole,
// short and whole checklists — four upcoming after it, and Andre's morning visit, called out.
// `template: 'building'` is the building's own checklist (the caller files one under it).
function extraVisitsFor(N, { dayStart, dayEnd, wall, count }, mdEvening) {
  const rel = (mins) => N + mins * MIN;
  const out = [];
  const add = (v) => { if (out.length < count && v.startMs >= dayStart + 5 * MIN && v.startMs < dayEnd - 5 * MIN) out.push(v); };
  const done = (key, crew, startRel, mins, inOff, outOff, checklist) => {
    const s = rel(startRel);
    add({
      key: `md-${key}`, client: key, site: key, service: 'jan', crew: [crew], startMs: s, mins, status: 'done',
      notes: 'Day clean.', punches: [{ user: crew, inMs: s + inOff * MIN, outMs: s + outOff * MIN, dist: 9 }],
      checklist: { user: crew, template: 'building', done: checklist.done, total: null, complete: checklist.complete, atMs: s + (outOff - 3) * MIN },
    });
  };
  const upcoming = (key, crew, startMs, mins, notes) => add({
    key: `md-${key}`, client: key, site: key, service: 'jan', crew: [crew], startMs, mins, status: 'upcoming', notes, punches: [], checklist: null,
  });
  done('x1', 'crew2', -300, 110, -2, 108, { done: 5, complete: true });
  done('x2', 'crew3', -190, 100, 1, 97, { done: 3, complete: false });
  done('x3', 'crew4', -165, 40, 1, 39, { done: 5, complete: true });
  upcoming('x4', 'crew2', rel(120), 90, 'Evening clean.');
  upcoming('x5', 'crew3', rel(180), 120, 'Evening clean.');
  upcoming('x6', 'crewdemo', rel(300), 90, 'Night porter.');
  upcoming('x7', 'crew1', wall(7, 30), 90, 'Morning restroom round.');   // Andre: called out today
  if (mdEvening) upcoming('x8', 'crew4', mdEvening.startMs + 120 * MIN, 90, 'Late clean.');
  return out;
}

// ── what the customer asked for, and the supplies ─────────────────────────────────────────────
// The requests the customer contact raised IN THE HUB (origin portal, HUB-13) on three of the
// manager's buildings, each at a different point on its clock (lib/workOrders SLA: urgent 2 h,
// medium 1 day, low 3 days): past its deadline, an hour left, and a new one nobody has answered.
// `createdHrs` / `hrs` are hours before the day is placed; a message `role` is who wrote it — the
// customer contact, the office (the building's manager), or a cleaner by slot (`by`); in a body,
// `{client}` is the contact's first name and `{crew2}` (any crew slot) that cleaner's. The demo's
// stubs (data/demoStubs.js) and the production sandbox (app/scripts/seed-backend.mjs) both write
// these, so the office's Client Requests, the Work Orders tab and the customer's hub read them.
export const MANAGER_DAY_REQUESTS = Object.freeze([
  {
    key: 'coralbay_pool_leak', building: 'mtbaker', type: 'complaint', category: 'spill', priority: 'urgent',
    status: 'in_progress', assigned: true, escalated: true, createdHrs: 3,
    title: 'Water pooling outside the pool restroom',
    description: 'There is water pooling outside the pool restroom door. Someone is going to slip.',
    messages: [
      { role: 'client', hrs: 3, body: 'There is water pooling outside the pool restroom door. Someone is going to slip.' },
      { role: 'office', hrs: 2.6, body: 'Thanks {client}. {crew2} is due there shortly and will put a wet-floor sign out first, then check the drain.' },
      { role: 'crew', by: 'crew2', hrs: 0.3, body: 'Ya puse el letrero de piso mojado. El desagüe está tapado y lo estoy destapando.', trans: 'The wet-floor sign is out. The drain is blocked and I am clearing it.', from: 'Spanish' },
    ],
  },
  {
    key: 'palmetto_carpet', building: 'pacridge', type: 'request', category: 'spill', priority: 'medium',
    status: 'in_progress', assigned: true, escalated: false, createdHrs: 23,
    // The Cleaner Hub (brief C): the office routed it to the evening cleaner, Demo Crew, whose
    // Client Requests shows it ("Assigned to you", due within the hour).
    crew: ['crewdemo'],
    title: 'Coffee spill on the 4th-floor conference room carpet',
    description: 'A full pot of coffee went over on the 4th-floor conference room carpet. Can it be treated before the next board meeting?',
    messages: [
      { role: 'client', hrs: 23, body: 'A full pot of coffee went over on the 4th-floor conference room carpet. Can it be treated before the next board meeting?' },
      { role: 'office', hrs: 22, body: 'Yes. The evening crew will extract it on their visit and I will send you a photo when it is done.' },
    ],
  },
  {
    key: 'gulfstream_dock', building: 'cascade', type: 'complaint', category: 'missed_area', priority: 'low',
    status: 'open', assigned: false, escalated: false, createdHrs: 2,
    title: 'Loading dock by bay 3 not swept',
    description: 'The loading dock by bay 3 still has shrink wrap and pallet debris from the last clean.',
    messages: [
      { role: 'client', hrs: 2, body: 'The loading dock by bay 3 still has shrink wrap and pallet debris from the last clean. Can it be swept?' },
    ],
  },
]);

// Supplies: Lakeside's list and an order the office has approved and not yet filled ("order
// placed"), and a delivery to Palmetto Ridge THIS MONTH that takes it past its budget. Since the
// master supply list (2026-10-11) a building's item is a switch over the catalog: `catalog` names
// the item in data/demoSupplyCatalog.js, which holds its name, SKU, unit and price. A request
// line names its item by the day's own key (`item`, a Lakeside switch) or by its catalog key
// (`catalog`: Palmetto's own list in the demo; in the production sandbox only the catalog item);
// its name and price are frozen from the catalog when the rows are built.
// THE DELIVERY STEP (2026-10-12; per line since S131): two DAILY rows, placed around `now` every time
// the day is (`daily`, by id MANAGER_DAY_DAILY_SUPPLY_IDS) — an order SUBMITTED to the supplier this
// morning for Las Olas, its toilet paper backordered a few days (`backordered`: line indexes), so
// Demo Crew's clean there reads "Supplies on the way", and one DELIVERED to Lakeside today, so its
// clean reads "Delivered today at …" (both are on Demo Crew's list today). Each order's per-line
// record comes from ONE rule (managerDaySupplyFulfillment, below) for the demo and the production
// sandbox seed alike.
export const MANAGER_DAY_SUPPLIES = Object.freeze({
  items: Object.freeze([
    { key: 'lake-towel', building: 'lakeside', catalog: 'towel' },
    { key: 'lake-liner', building: 'lakeside', catalog: 'liner' },
    { key: 'lake-finish', building: 'lakeside', catalog: 'finish' },
  ]),
  requests: Object.freeze([
    {
      key: 'lake-appr', building: 'lakeside', status: 'approved', note: 'Floor finish for the lobby buff.',
      createdHrs: 26, approvedHrs: 20,
      lines: [{ item: 'lake-finish', qty: 2 }, { item: 'lake-towel', qty: 1 }],
    },
    {
      key: 'prc-delivered', building: 'pacridge', status: 'completed', note: 'Restock after the quarterly deep clean.',
      deliveredInMonth: true,
      lines: [{ catalog: 'liner', qty: 2 }, { catalog: 'towel', qty: 2 }],
    },
    {
      key: 'evg-sent', building: 'evergreen', status: 'sent', daily: true, note: 'Monthly restock.',
      lines: [{ catalog: 'glass', qty: 4 }, { catalog: 'towel', qty: 2 }, { catalog: 'tp', qty: 3 }],
      backordered: [2], etaDays: 3,
    },
    {
      key: 'lake-dropped', building: 'lakeside', status: 'completed', daily: true, deliveredToday: true, note: '',
      lines: [{ item: 'lake-liner', qty: 2 }, { item: 'lake-towel', qty: 1 }],
    },
  ]),
});
// THE PER-LINE RECORD a manager-day order carries (S131: fulfillment, lib/supplies), from the plan
// above — ONE rule for the demo (data/demoStubs.js) and the production sandbox seed (scripts/_lib/
// managerDaySeed.mjs). `lines` are the order's frozen lines (each with its itemId and
// catalogItemId); `at` the moment of the act (epoch ms): a SUBMITTED order's backorder, a COMPLETED
// order's every delivery (in full); `by` { id, name } who recorded it; `etaKey` the supplier's day for
// a backordered line. → the per-line array, or null for an order not yet submitted.
export function managerDaySupplyFulfillment(r, lines, { at, by = {}, etaKey = null } = {}) {
  const stamp = { byUserId: (by && by.id) || null, byName: (by && by.name) || null };
  const when = new Date(at).toISOString();
  const entry = (l) => ({ itemId: l.itemId || null, catalogItemId: l.catalogItemId || null, deliveries: [], backorder: null, cancelled: null });
  if (r.status === 'sent') {
    const back = new Set(Array.isArray(r.backordered) ? r.backordered : []);
    return lines.map((l, i) => ({ ...entry(l), backorder: back.has(i) && etaKey ? { at: when, ...stamp, eta: etaKey } : null }));
  }
  if (r.status === 'completed') {
    return lines.map((l) => ({ ...entry(l), deliveries: [{ qty: Number(l.qty) || 0, at: when, ...stamp, via: 'office' }] }));
  }
  return null;
}
// The day's own supply rows (above), re-placed with the day every time (lib/demoSandbox
// placeManagerDaySupplies `replaceIds`), so "on the way" and "delivered today" are always today's.
export const MANAGER_DAY_DAILY_SUPPLY_IDS = Object.freeze(
  MANAGER_DAY_SUPPLIES.requests.filter((r) => r.daily).map((r) => seedId('sr', `md-${r.key}`)),
);
// When the daily rows' moves happened, for the day placed at `day.nowMs` (inside today, before
// now): the sent order went out this morning, about three hours ago; the delivered one landed
// about an hour and a quarter ago, sent four hours before that. Each was asked for and approved the
// day before its send. → epoch ms, every one ≤ now.
export function managerDaySupplyTimes(day) {
  const N = day.nowMs;
  const start = Number.isFinite(day.dayStartMs) ? day.dayStartMs : N - 12 * 60 * MIN;
  const delivered = Math.min(N - MIN, Math.max(start + 2 * MIN, N - 75 * MIN));
  const sentEarly = Math.min(delivered - MIN, Math.max(start + MIN, delivered - 4 * 60 * MIN));
  const sent = Math.min(N - MIN, Math.max(start + MIN, N - 3 * 60 * MIN));
  const back = (ms) => ({ approvedMs: ms - 20 * 60 * MIN, createdMs: ms - 26 * 60 * MIN });
  return {
    sent: { sentMs: sent, ...back(sent) },
    delivered: { completedMs: delivered, sentMs: sentEarly, ...back(sentEarly) },
  };
}

// A message body with its names filled in: `{client}` the customer contact's first name (dropped
// with the space before it when there is none), `{,client}` the same after a comma, `{crewN}` that
// crew slot's first name.
export function managerDayText(body, names = {}) {
  const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
  return String(body || '')
    .replace(/\{,client\}/g, () => (first(names.client) ? `, ${first(names.client)}` : ''))
    .replace(/\s*\{client\}/g, () => (first(names.client) ? ` ${first(names.client)}` : ''))
    .replace(/\{(crew\w*)\}/g, (m, k) => first(names[k]) || 'Our cleaner');
}

// The requests on the OTHER buildings of the production sandbox (one each, cycled), so every
// managed building's queue holds something the customer raised: fresh, an hour from its deadline,
// waiting on the customer, and done.
export const MANAGER_DAY_OTHER_REQUESTS = Object.freeze([
  {
    key: 'towels', type: 'complaint', category: 'restock', priority: 'medium', status: 'in_progress', assigned: true, escalated: false, createdHrs: 22.5,
    title: 'Paper towels ran out in the second-floor restroom',
    description: 'The paper towel dispensers in the second-floor restroom were empty by late morning.',
    messages: [
      { role: 'client', hrs: 22.5, body: 'The paper towel dispensers in the second-floor restroom were empty by late morning.' },
      { role: 'office', hrs: 21.8, body: 'Thanks{client}. The crew will restock tonight and we are adding a midday check.' },
    ],
  },
  {
    key: 'glass', type: 'complaint', category: 'missed_area', priority: 'low', status: 'open', assigned: false, escalated: false, createdHrs: 5,
    title: 'Front door glass smudged at opening',
    description: 'The front door glass had handprints on it when we opened this morning.',
    messages: [
      { role: 'client', hrs: 5, body: 'The front door glass had handprints on it when we opened this morning.' },
    ],
  },
  {
    key: 'carpet', type: 'request', category: 'extra_service', priority: 'low', status: 'awaiting_client', assigned: true, escalated: false, createdHrs: 30,
    title: 'Add a carpet shampoo next month',
    description: 'Could we add a carpet shampoo for the main hallway next month?',
    messages: [
      { role: 'client', hrs: 30, body: 'Could we add a carpet shampoo for the main hallway next month?' },
      { role: 'office', hrs: 28, body: 'Happy to. Which week works best for you, and should we include the conference room?' },
    ],
  },
  {
    key: 'spill', type: 'complaint', category: 'spill', priority: 'urgent', status: 'open', assigned: true, escalated: false, createdHrs: 0.75,
    title: 'Spill by the elevator lobby',
    description: 'There is a sticky spill by the elevator lobby. Can someone come by?',
    messages: [
      { role: 'client', hrs: 0.75, body: 'There is a sticky spill by the elevator lobby. Can someone come by?' },
    ],
  },
  {
    key: 'thanks', type: 'request', category: 'other', priority: 'medium', status: 'resolved', assigned: true, escalated: false, createdHrs: 40, resolvedHrs: 20,
    title: 'Move the trash pickup to after 6 PM',
    description: 'Our tenants work late. Could trash pickup move to after 6 PM?',
    messages: [
      { role: 'client', hrs: 40, body: 'Our tenants work late. Could trash pickup move to after 6 PM?' },
      { role: 'office', hrs: 22, body: 'Done. From tonight the crew starts trash at 6:15 PM.' },
      { role: 'client', hrs: 20, body: 'Perfect, thank you!' },
    ],
  },
]);

// The customer's MESSAGES in a building's hub thread (client_messages) — not requests: the
// building's open line to the office. Two still wait for the office's first reply (one 12 minutes
// in, one 50 minutes, past the half hour), one was answered. `mins` is minutes before the day is
// placed. A building slot here is the manager's own (the demo's Palmetto Ridge, Flagler Townhomes
// and Gulfstream Logistics); the production sandbox also gives every other building the answered
// exchange (MANAGER_DAY_MESSAGE_ANSWERED) and one more waiting message at an other manager's (x1).
export const MANAGER_DAY_MESSAGES = Object.freeze([
  { key: 'waiting_fresh', building: 'pacridge', lines: [
    { role: 'client', mins: 12, body: 'Hi, the 4th-floor conference room is booked early tomorrow. Can tonight’s crew do it first?' },
  ] },
  { key: 'waiting_late', building: 'salishan', lines: [
    { role: 'client', mins: 50, body: 'The pool gate was left unlatched after this morning’s visit. Can the crew double-check it?' },
  ] },
  { key: 'answered', building: 'cascade', lines: [
    { role: 'client', mins: 26 * 60, body: 'Will the crew be able to sweep the parking garage stairwells this week?' },
    { role: 'office', mins: 25 * 60, body: 'Yes{,client}. {crew4} will do the stairwells on Thursday night.' },
  ] },
  { key: 'waiting_other', building: 'x1', lines: [
    { role: 'client', mins: 95, body: 'Could the crew leave the lobby lights on a timer instead of switching them off?' },
  ] },
]);
export const MANAGER_DAY_MESSAGE_ANSWERED = Object.freeze({ key: 'answered', lines: MANAGER_DAY_MESSAGES[2].lines });

// When the over-budget delivery landed: two days back, held inside this month and before now, so
// the month's budget reads it whatever the date.
export function managerDayDeliveredMs(day) {
  return Math.min(day.nowMs - MIN, Math.max(day.monthStartMs + MIN, day.nowMs - 48 * 60 * MIN));
}

// Demo Crew's last pay week: five 8½-hour days at Las Olas, approved — 42½ hours, so 2½ hours of
// overtime wait for the manager on Hours Approval (the Overtime tab). Synthetic job ids, as the
// ledger's history uses: a past punch must never join a live visit.
function overtimeWeek(today, weekStartDay, tz) {
  const back = (dayOfWeekKey(today) - weekStartDay + 7) % 7;
  const prevWeek = addDaysKey(addDaysKey(today, -back), -7);
  const rows = [];
  for (let i = 1; i <= 5; i += 1) {
    const key = addDaysKey(prevWeek, i);
    const inMs = Date.parse(composeIso(key, '07:00', tz));
    rows.push({ id: `te_demo_md_ot_${i}`, job: `j_demo_md_ot_${i}`, jobKey: `md-ot-${i}`, ot: true, user: 'crewdemo', client: 'evergreen', site: 'evgrn-main', inAt: inMs, dur: 510, exp: 510, geo: 'inside', dist: 11, appr: 'approved' });
  }
  return rows;
}

// buildManagerDay(now) → the day, ready for the builders:
//   { nowMs, dayKey, monthStartMs,
//     jobs:    store job rows (data/seed.js's shape),
//     timeOff: store time-off rows,
//     entries: ledger specs for data/demoTimeLedger.js mk() (closed punches + the overtime week;
//              the on-site open punches are the ledger file's own),
//     checklists: [{ id, jobId, user, userId, client, clientId, site, siteId, template, done, total, atMs }],
//     visits }
// `resolve` maps a slot key to an id ({ client, site, user, service, job }, each key → id); the
// seed's own ids when omitted. Every entry and save carries both the slot key and the resolved id.
// `extra` (0–8) adds the visits at the other managers' buildings, slots x1…x8 (the production
// sandbox; the demo has one manager and passes none).
export function buildManagerDay(now = new Date(), { tz = DEFAULT_ORG_TIMEZONE, weekStartDay = 0, resolve = {}, extra = 0 } = {}) {
  const R = { ...SEED_RESOLVE, ...resolve };
  const ref = now instanceof Date ? now : new Date(now);
  const N = Number.isFinite(ref.getTime()) ? ref.getTime() : Date.now();
  const today = dayKey(new Date(N), tz);
  const dayStart = startOfDayKey(today, tz).getTime();
  const dayEnd = startOfDayKey(addDaysKey(today, 1), tz).getTime();
  const wall = (h, m = 0) => Date.parse(composeIso(today, `${pad(h)}:${pad(m)}`, tz));
  const iso = (ms) => new Date(ms).toISOString();
  const own = visitsFor(N, { dayStart, dayEnd, wall });
  const visits = extra > 0
    ? [...own, ...extraVisitsFor(N, { dayStart, dayEnd, wall, count: Math.min(extra, MANAGER_DAY_EXTRA_KEYS.length) }, own.find((v) => v.key === 'md-evening'))]
    : own;
  const createdAt = composeIso(addDaysKey(today, -3), '09:00', tz);

  const jobs = visits.map((v) => ({
    id: R.job(v.key),
    clientId: R.client(v.client),
    siteId: R.site(v.site),
    serviceId: R.service(v.service),
    crewIds: [...new Set(v.crew.map(R.user))],
    startAt: iso(v.startMs),
    endAt: iso(v.startMs + v.mins * MIN),
    status: v.status,
    notes: v.notes,
    seriesId: null,
    recurrence: null,
    createdAt,
    ...(v.extra ? {
      seriesId: v.extra.seriesId,
      oneOff: v.extra.oneOff,
      coverFor: Object.fromEntries(Object.entries(v.extra.coverFor).map(([a, b]) => [R.user(a), R.user(b)])),
    } : {}),
  }));

  // Andre's call-out: sick, booked a little before seven (or just now, before then).
  const bookedMs = Math.max(dayStart + MIN, Math.min(wall(6, 40), N - 20 * MIN));
  const timeOff = [{
    id: MANAGER_DAY_TIME_OFF_IDS[0], userId: R.user('crew1'), startDate: today, endDate: today,
    reason: '', calloutReason: 'sick', kind: 'callout', createdBy: R.user(MANAGER_DAY_SLOTS.owner), createdAt: iso(bookedMs),
  }];

  const entries = [];
  for (const v of visits) {
    for (const p of v.punches) {
      if (p.outMs > N) continue; // a clean never ends in the future
      entries.push({
        id: `${MANAGER_DAY_PREFIX.entry}${v.key.replace(/-/g, '_')}_${p.user}`,
        job: R.job(v.key), jobKey: v.key, user: p.user, client: v.client, site: v.site,
        inAt: p.inMs, dur: Math.round((p.outMs - p.inMs) / MIN), exp: v.mins,
        geo: 'inside', dist: p.dist, appr: 'pending',
      });
    }
  }
  entries.push(...overtimeWeek(today, weekStartDay, tz));

  const checklists = visits.filter((v) => v.checklist && v.checklist.atMs <= N).map((v) => ({
    id: `${MANAGER_DAY_PREFIX.checklist}${v.key.replace(/-/g, '_')}`,
    jobId: R.job(v.key), user: v.checklist.user, userId: R.user(v.checklist.user),
    client: v.client, clientId: R.client(v.client), site: v.site, siteId: R.site(v.site),
    template: v.checklist.template, done: v.checklist.done, total: v.checklist.total, complete: v.checklist.complete, atMs: v.checklist.atMs,
  }));

  return {
    nowMs: N,
    dayKey: today,
    dayStartMs: dayStart,
    monthStartMs: startOfDayKey(startOfMonthKey(today), tz).getTime(),
    jobs,
    timeOff,
    entries,
    checklists,
    visits,
  };
}

export default buildManagerDay;
