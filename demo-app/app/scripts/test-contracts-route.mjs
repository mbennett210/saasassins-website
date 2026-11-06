// /api/contracts/[...path] + the reminder cron, driven END TO END through the REAL handlers
// against fake-supabase.mjs (no network, no credentials, no live project — BUILD_INTEGRITY
// §6b forbids proving a server claim against prod). CON-1..CON-14, CS-194.
//
// What it proves, in the order it matters:
//   1. every branch refuses an anonymous caller and a cleaner, and a write needs contracts.edit
//   2. 🔴 THE MONEY GATE, BOTH HALVES (CS-019): an admin reads a contract with its prices
//      NULLED, and SAVING that stripped contract back does NOT blank the stored prices. Half a
//      gate is a data-loss bug, so both halves are pinned here.
//   3. 🔴 ONE ACTIVE CONTRACT PER BUILDING (CON-2/CON-14): 409, naming the buildings
//   4. the annual value the route serves is the cents arithmetic, not a float
//   5. the reminder schedule: generated on create, 60 days ahead, preserved across a save
//   6. CON-10: done / snooze / note, and what a snooze does to the next ring
//   7. the activity log gets contract.created / edited / deleted, flagged as MONEY
//   8. CON-11: a signed-PDF URL is minted under this contract's prefix, and a foreign path is refused
//   9. the CRON: a due reminder rings the account's manager AND the owner, stamps itself so it
//      never rings twice, and stays silent outside office hours
//
//   node app/scripts/test-contracts-route.mjs
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const ORG = '00000000-0000-0000-0000-000000000001';
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.SUPABASE_ANON_KEY = 'fake-anon';
process.env.FORMS_ORG_ID = ORG;
process.env.CLEANSPACE_ORG_ID = ORG;
globalThis.fetch = async (u) => { throw new Error(`network blocked in this suite (${u})`); };

const { installFakeSupabase, resetWorld, world } = await import('./fake-supabase.mjs');
installFakeSupabase();

const { seedPermissions } = await import('../src/lib/roles.js');
const { addDaysKey, dayKey } = await import('../src/lib/dates.js');
const {
  REMINDER_LEAD_DAYS, REMINDER_KIND, REMINDER_STATUS, CONTRACT_STATUS, TERM_TYPE,
  MONTHS_PER_YEAR, CONTRACT_REMINDER_MAX_PER_RUN,
} = await import('../src/lib/contracts.js');
const { contractAlertId, CONTRACT_ALERT_KIND } = await import('../src/lib/contractReminders.js');
const handler = (await import('../api/contracts/[...path].js')).default;
const { run, contractAlertsFor } = await import('../api/cron/ops-alerts.js');

let pass = 0;
const fails = [];
// ARG ORDER: ok(label, cond, detail) — stated because this repo's suites disagree and a
// swapped call "passes" on a truthy label.
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

// ── the world ───────────────────────────────────────────────────────────────
// A Wednesday 10:00 in the org's zone, so the office-hours gate is OPEN by default
// (lib/officeHours defaults to Mon–Fri 08:00–17:00) and one case can close it.
const NOW = Date.parse('2026-10-07T14:00:00.000Z');
const TZ = 'America/New_York';
const TODAY = dayKey(NOW, TZ);

// 🔴 THE SUITE'S CLOCK IS THE ROUTE'S CLOCK. The route plans reminders from `new Date()`
// (api/contracts today()), while every expectation here is built from the pinned NOW, so the
// two only agreed on the day this suite was written: from 2026-10-08 the real day ran ahead of
// TODAY, a price change's next ring landed on the real day instead, and two checks went red on
// an untouched tree. Freeze `new Date()` / `Date.now()` at NOW for the whole run; an explicit
// date (`new Date(x)`, `Date.parse`, `Date.UTC`) is unchanged.
const RealDate = Date;
class SuiteDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(NOW); else super(...args); }
  static now() { return NOW; }
}
globalThis.Date = SuiteDate;

const PEOPLE = {
  owner: { id: 'u_owner', role: 'owner', claim: true },
  admin: { id: 'u_admin', role: 'admin', claim: true },
  mgr: { id: 'u_mgr', role: 'manager', claim: false },   // claim-less, as live
  mgr2: { id: 'u_mgr2', role: 'manager', claim: false },
  crew: { id: 'u_crew', role: 'crew', claim: true },
};
const emailOf = (k) => `${k.toLowerCase()}@example.test`;
const roster = Object.entries(PEOPLE).map(([k, p]) => ({
  id: p.id, email: emailOf(k), role: p.role, status: 'active', name: k, notificationPrefs: {},
}));
const logins = Object.fromEntries(Object.entries(PEOPLE).map(([k, p]) => [
  `tok-${k}`,
  { id: `auth-${k}`, email: emailOf(k), app_metadata: p.claim ? { role: p.role, org_user_id: p.id, org_id: ORG } : {} },
]));
const CLIENTS = [
  { id: 'cl_1', name: 'Ball Harbor Village', supervisorId: 'u_mgr' },
  { id: 'cl_2', name: 'Brickell Bay Offices', supervisorId: 'u_mgr2' },
  { id: 'cl_3', name: 'Las Olas Medical', supervisorId: null },
];

// CON-10: the Renewals board is found by its STAGE KEY, never by the seed's pipeline id, so
// the fixture gives it a different id AND puts another board in front of it.
const RENEWAL_STAGE = 'renewal-due';
const PIPELINES = () => [
  { id: 'pl_master', label: 'Master', isMaster: true, stages: [{ id: 's1', key: 'new-lead', label: 'New Lead' }, { id: 's2', key: 'won', label: 'Won' }, { id: 's3', key: 'lost', label: 'Lost' }] },
  {
    id: 'pl_not_the_seed_id',
    label: 'Renewals & Upsells',
    stages: [
      { id: 's4', key: RENEWAL_STAGE, label: 'Up for Renewal' },
      { id: 's5', key: 'renewal-outreach', label: 'Outreach Sent' },
      { id: 's6', key: 'won', label: 'Renewed' },
      { id: 's7', key: 'lost', label: 'Churned' },
    ],
  },
];

function build({ overrides = [], pipelines = PIPELINES() } = {}) {
  const state = {
    users: roster, permissions: seedPermissions(), userPermissionOverrides: overrides,
    clients: CLIENTS, company: { timezone: TZ },
    notifications: [], opsAlertEvents: [], opsSettings: {}, invoices: [], supplyRequests: [],
    pipelines, activePipelineId: 'pl_master', opportunities: [],
  };
  resetWorld({
    tables: {
      org_state: [{ organization_id: ORG, state, version: 4 }],
      contracts: [], contract_buildings: [], contract_years: [], contract_lines: [], contract_reminders: [],
      activity_log: [], activity_log_baseline: [], customer_messages: [],
    },
    logins,
  });
  return state;
}

async function call({ method = 'GET', path, token, body, query = {} }) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = token ? { authorization: `Bearer ${token}` } : {};
  req.query = { ...query, subpath: path };
  req.body = body;
  const quiet = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} ${path}: no response`)), 8000);
      const done = (status, b) => { clearTimeout(timer); resolve({ status, body: b }); };
      const res = {
        statusCode: 200,
        setHeader() { return this; },
        status(c) { this.statusCode = c; return this; },
        json(b) { done(this.statusCode, b); return this; },
        send(b) { done(this.statusCode, b); return this; },
        end(b) { done(this.statusCode, b ?? null); return this; },
      };
      Promise.resolve(handler(req, res)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  } finally { Object.assign(console, quiet); }
}
const tok = (w) => `tok-${w}`;
const show = (r) => `got ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;

// A three-year contract on one building, rising each year. Caller-minted id, as the route
// requires (a retried create must be a no-op, not a second contract).
const newContract = (over = {}) => ({
  id: randomUUID(),
  status: CONTRACT_STATUS.active,
  clientIds: ['cl_1'],
  startDate: '2026-01-01',
  endDate: '2028-12-31',
  termType: TERM_TYPE.fixed,
  termMonths: 36,
  cancellationNoticeDays: 90,
  serviceFrequency: '5x per week',
  squareFootage: 42000,
  baseMonthlyCents: 125075,
  years: [
    { yearNumber: 1, startsOn: '2026-01-01', monthlyCents: 125075 },
    { yearNumber: 2, startsOn: '2027-01-01', monthlyCents: 128900 },
    { yearNumber: 3, startsOn: '2028-01-01', monthlyCents: 132800 },
  ],
  lines: [{ description: 'Floor care', monthlyCents: 25000 }],
  ...over,
});

const create = (payload, who = 'owner') => call({ method: 'POST', path: 'create', token: tok(who), body: payload });

// ── 1. the gates ────────────────────────────────────────────────────────────
console.log('\n── CON gates: anonymous, crew, and contracts.edit ──');
{
  build();
  const branches = [
    { label: 'GET list', method: 'GET', path: 'list' },
    { label: 'GET for-client', method: 'GET', path: 'for-client', query: { clientId: 'cl_1' } },
    { label: 'POST create', method: 'POST', path: 'create', body: newContract() },
  ];
  for (const b of branches) {
    const anon = await call({ ...b });
    ok(`${b.label} 401s with no session`, anon.status === 401, show(anon));
    const crew = await call({ ...b, token: tok('crew') });
    ok(`${b.label} 403s a cleaner`, crew.status === 403, show(crew));
  }
  const mgr = await call({ method: 'GET', path: 'list', token: tok('mgr') });
  ok('a manager may read the book', mgr.status === 200, show(mgr));
  const adm = await call({ method: 'GET', path: 'list', token: tok('admin') });
  ok('an admin may read the book', adm.status === 200, show(adm));
}

// A contracts.view-only holder (contracts.edit revoked) must not write.
{
  build({ overrides: [{ userId: 'u_admin', grants: [], revokes: ['contracts.edit'] }] });
  const r = await create(newContract(), 'admin');
  ok('contracts.edit revoked -> a write is refused', r.status === 403, show(r));
  const read = await call({ method: 'GET', path: 'list', token: tok('admin') });
  ok('…but the read still works (view and edit are separate keys)', read.status === 200, show(read));
}

// ── 2. the money gate, BOTH halves (CS-019) ─────────────────────────────────
console.log('\n── CON-12 money: served and accepted only with invoices.view ──');
{
  build();
  const c = newContract();
  const made = await create(c);
  ok('the owner creates a contract', made.status === 200 && made.body.contract.id === c.id, show(made));

  // The owner holds invoices.view by default; the admin does NOT (Q24).
  const asOwner = await call({ method: 'GET', path: 'list', token: tok('owner') });
  const ownerRow = asOwner.body.contracts[0];
  ok('the owner sees the prices', ownerRow.baseMonthlyCents === 125075 && ownerRow.moneyVisible === true, JSON.stringify(ownerRow).slice(0, 200));
  ok('…and the book total', typeof asOwner.body.bookValueCents === 'number' && asOwner.body.bookValueCents > 0, show(asOwner));

  const asAdmin = await call({ method: 'GET', path: 'list', token: tok('admin') });
  const adminRow = asAdmin.body.contracts[0];
  ok('an admin gets every price NULLED, not zeroed', adminRow.baseMonthlyCents === null
    && adminRow.years.every((y) => y.monthlyCents === null)
    && adminRow.lines.every((l) => l.monthlyCents === null), JSON.stringify(adminRow).slice(0, 220));
  ok('…and is told the money is hidden, so the screen can say so', adminRow.moneyVisible === false, JSON.stringify(adminRow).slice(0, 120));
  ok('…and no annual value', adminRow.annualValueCents === null, show(asAdmin));
  ok('…and no book total (null, never 0)', asAdmin.body.bookValueCents === null, show(asAdmin));
  ok('the admin still sees the dates and the buildings', adminRow.startDate === '2026-01-01' && adminRow.clientIds[0] === 'cl_1', JSON.stringify(adminRow).slice(0, 160));

  // 🔴 THE SECOND HALF. The admin's screen holds a stripped contract; saving it back must
  // not write those nulls over the stored prices.
  const save = await call({
    method: 'POST', path: `${c.id}/save`, token: tok('admin'),
    body: { ...adminRow, serviceFrequency: '6x per week' },
  });
  ok('an admin may save the dates and the frequency', save.status === 200, show(save));
  const after = await call({ method: 'GET', path: 'list', token: tok('owner') });
  const row = after.body.contracts[0];
  ok('…and the stored prices are UNTOUCHED (a stripped read + Save must not blank them)',
    row.baseMonthlyCents === 125075 && row.years.map((y) => y.monthlyCents).join() === '125075,128900,132800'
    && row.lines[0].monthlyCents === 25000,
    JSON.stringify(row).slice(0, 260));
  ok('…while the field they did edit landed', row.serviceFrequency === '6x per week', JSON.stringify(row).slice(0, 160));
}

// ── 2b. the customer's service-change confirmation is QUEUED on a save (2026-10-19) ──
console.log('\n── the service-change confirmation (Matt\'s approved messages) ──');
{
  build();
  const c = newContract({ clientIds: ['cl_1', 'cl_2'], isMaster: true });
  await create(c);
  const queued = () => (world.tables.customer_messages || []).filter((r) => r.status === 'pending' && r.template_key === 'service_change');
  await call({ method: 'POST', path: `${c.id}/save`, token: tok('owner'), body: { notes: 'touched' } });
  ok('a save the customer would not notice (a note) queues nothing', queued().length === 0, JSON.stringify(queued()));
  await call({ method: 'POST', path: `${c.id}/save`, token: tok('owner'), body: { serviceFrequency: '3x per week' } });
  const q = queued();
  ok('🔴 a frequency change on an ACTIVE agreement queues ONE confirmation per building it covers', q.length === 2 && q.map((r) => r.client_id).sort().join() === 'cl_1,cl_2', JSON.stringify(q).slice(0, 300));
  ok('…carrying what changed, in the customer\'s words, and the day', q.length === 2 && q.every((r) => Array.isArray(r.payload?.summary) && r.payload.summary.includes('New schedule: 3x per week') && r.payload.effectiveDay === TODAY), JSON.stringify(q[0]?.payload));
  ok('…keyed by the contract and the building, with a retention', q.length === 2 && q.every((r) => r.id.startsWith(`service_change:${c.id}:`) && r.id.endsWith(`:${r.client_id}`) && !!r.keep_until));
  const draft = newContract({ clientIds: ['cl_3'], status: CONTRACT_STATUS.draft });
  await create(draft);
  await call({ method: 'POST', path: `${draft.id}/save`, token: tok('owner'), body: { serviceFrequency: '7x per week' } });
  ok('a DRAFT agreement\'s change is not news to the customer (nothing queued)', queued().length === 2, JSON.stringify(queued().map((r) => r.client_id)));
}

// ── 3. one active contract per building ─────────────────────────────────────
console.log('\n── CON-2 / CON-14: a building is on ONE active contract ──');
{
  build();
  const first = newContract({ clientIds: ['cl_1', 'cl_2'], isMaster: true, name: 'City master' });
  ok('a MASTER agreement over two buildings is accepted', (await create(first)).status === 200);

  const clash = await create(newContract({ clientIds: ['cl_2'] }));
  ok('a second ACTIVE contract on a covered building is refused with 409', clash.status === 409, show(clash));
  ok('…and the refusal names the building, so the office can act on it',
    Array.isArray(clash.body.clientIds) && clash.body.clientIds.includes('cl_2'), show(clash));
  ok('…with a stable code', clash.body.code === 'building_already_contracted', show(clash));

  const draft = await create(newContract({ clientIds: ['cl_2'], status: CONTRACT_STATUS.draft }));
  ok('a DRAFT over the same building IS allowed — that is how a renewal is prepared', draft.status === 200, show(draft));

  const free = await create(newContract({ clientIds: ['cl_3'] }));
  ok('an untaken building is fine', free.status === 200, show(free));

  // Re-saving the same contract must not collide with itself.
  const again = await call({ method: 'POST', path: `${first.id}/save`, token: tok('owner'), body: { clientIds: ['cl_1', 'cl_2'] } });
  ok('re-saving a contract never conflicts with itself', again.status === 200, show(again));

  // Ending the master releases its buildings for the draft to go live.
  await call({ method: 'POST', path: `${first.id}/save`, token: tok('owner'), body: { status: CONTRACT_STATUS.ended } });
  const promoted = await call({ method: 'POST', path: `${draft.body.contract.id}/save`, token: tok('owner'), body: { status: CONTRACT_STATUS.active } });
  ok('ending a contract releases its buildings', promoted.status === 200, show(promoted));
}

// ── 4. the annual value the route serves ────────────────────────────────────
console.log('\n── CON-12: the value on the account, in cents ──');
{
  build();
  const c = newContract();
  await create(c);
  const r = await call({ method: 'GET', path: `${c.id}`, token: tok('owner') });
  // Year 1 is in effect on 2026-10-07: (1,250.75 + 250.00) x 12 = $18,009.00.
  ok('annual value = (this year\'s monthly + the lines) x 12, exactly',
    r.body.contract.annualValueCents === (125075 + 25000) * MONTHS_PER_YEAR, show(r));
  ok('…and it is 1800900 cents, not a rounded 18009', r.body.contract.annualValueCents === 1800900, show(r));
  const list = await call({ method: 'GET', path: 'list', token: tok('owner') });
  ok('the book total is the sum of the active contracts', list.body.bookValueCents === 1800900, show(list));
  ok('the customer tab reads the same number',
    (await call({ method: 'GET', path: 'for-client', token: tok('owner'), query: { clientId: 'cl_1' } }))
      .body.contracts[0].annualValueCents === 1800900);
}

// ── 5. the reminder schedule ────────────────────────────────────────────────
console.log('\n── CON-6..9: the schedule the create generates ──');
let scheduled = null;
{
  build();
  const c = newContract();
  await create(c);
  const r = await call({ method: 'GET', path: `${c.id}`, token: tok('owner') });
  scheduled = r.body.contract.reminders;
  const byKind = (k) => scheduled.filter((x) => x.kind === k);
  ok('two price-change reminders (years 2 and 3)', byKind(REMINDER_KIND.price_increase).length === 2, JSON.stringify(scheduled.map((x) => `${x.kind}@${x.targetDate}`)));
  ok('one end reminder', byKind(REMINDER_KIND.end).length === 1);
  ok('one cancellation-notice reminder', byKind(REMINDER_KIND.cancellation_notice).length === 1);
  ok('each is due exactly REMINDER_LEAD_DAYS before its date',
    scheduled.every((x) => x.dueOn === addDaysKey(x.targetDate, -REMINDER_LEAD_DAYS)),
    JSON.stringify(scheduled.map((x) => [x.targetDate, x.dueOn])));
  ok('every one starts pending and unrung', scheduled.every((x) => x.status === REMINDER_STATUS.pending && !x.notifiedAt));

  // Re-saving must not duplicate the schedule, and must keep what the office did to a row.
  const done = scheduled.find((x) => x.kind === REMINDER_KIND.end);
  await call({ method: 'POST', path: `reminders/${done.id}`, token: tok('owner'), body: { status: REMINDER_STATUS.done, note: 'Renewal signed' } });
  await call({ method: 'POST', path: `${c.id}/save`, token: tok('owner'), body: { notes: 'touched' } });
  const after = (await call({ method: 'GET', path: `${c.id}`, token: tok('owner') })).body.contract.reminders;
  ok('re-saving does not duplicate the schedule', after.length === scheduled.length, `${after.length} vs ${scheduled.length}`);
  const stillDone = after.find((x) => x.id === done.id);
  ok('…and a reminder the office marked done STAYS done, with its note', stillDone
    && stillDone.status === REMINDER_STATUS.done && stillDone.note === 'Renewal signed', JSON.stringify(stillDone));

  // Moving the end date retires the reminder that pointed at the old one.
  await call({ method: 'POST', path: `${c.id}/save`, token: tok('owner'), body: { endDate: '2029-06-30', termMonths: 42 } });
  const moved = (await call({ method: 'GET', path: `${c.id}`, token: tok('owner') })).body.contract.reminders;
  ok('moving the end date drops the stale future reminder and plans the new one',
    moved.some((x) => x.kind === REMINDER_KIND.end && x.targetDate === '2029-06-30')
    && !moved.some((x) => x.kind === REMINDER_KIND.end && x.targetDate === '2028-12-31'),
    JSON.stringify(moved.map((x) => `${x.kind}@${x.targetDate}`)));
}

// ── 6. CON-10: done / snooze / note ─────────────────────────────────────────
console.log('\n── CON-10: a reminder is marked done, snoozed, or noted ──');
let snoozeWorld = null;
{
  build();
  const c = newContract();
  await create(c);
  const rems = (await call({ method: 'GET', path: `${c.id}`, token: tok('owner') })).body.contract.reminders;
  const target = rems[0];

  const noted = await call({ method: 'POST', path: `reminders/${target.id}`, token: tok('mgr'), body: { note: 'Called Yolanda' } });
  ok('a note is saved', noted.status === 200 && noted.body.reminder.note === 'Called Yolanda', show(noted));

  const snoozeTo = addDaysKey(TODAY, 14);
  const snoozed = await call({ method: 'POST', path: `reminders/${target.id}`, token: tok('mgr'), body: { status: REMINDER_STATUS.snoozed, snoozeUntil: snoozeTo } });
  ok('a snooze moves the next ring and keeps the original due date',
    snoozed.body.reminder.nextDueOn === snoozeTo && snoozed.body.reminder.dueOn === target.dueOn, show(snoozed));
  ok('…and clears the rung stamp, so the snoozed reminder can ring again',
    snoozed.body.reminder.notifiedAt === null, show(snoozed));

  const bad = await call({ method: 'POST', path: `reminders/${target.id}`, token: tok('mgr'), body: { status: REMINDER_STATUS.snoozed } });
  ok('a snooze with no date is refused', bad.status === 400, show(bad));

  const done = await call({ method: 'POST', path: `reminders/${target.id}`, token: tok('mgr'), body: { status: REMINDER_STATUS.done } });
  ok('done records who and when', done.body.reminder.status === REMINDER_STATUS.done
    && done.body.reminder.doneByUserId === 'u_mgr' && !!done.body.reminder.doneAt, show(done));

  const crew = await call({ method: 'POST', path: `reminders/${target.id}`, token: tok('crew'), body: { note: 'x' } });
  ok('a cleaner cannot touch a reminder', crew.status === 403, show(crew));
  snoozeWorld = c;
}

// ── 7. the activity log ─────────────────────────────────────────────────────
console.log('\n── LOG-2/LOG-3: contract.created / edited / deleted, as MONEY ──');
{
  build();
  const c = newContract();
  await create(c);
  await call({ method: 'POST', path: `${c.id}/save`, token: tok('owner'), body: { baseMonthlyCents: 130000 } });
  await call({ method: 'POST', path: `${c.id}/delete`, token: tok('owner') });
  const rows = world.tables.activity_log;
  const actions = rows.map((r) => r.action);
  ok('all three actions are written', ['contract.created', 'contract.edited', 'contract.deleted'].every((a) => actions.includes(a)), actions.join(','));
  ok('every one is flagged as money (an admin must not read them)', rows.every((r) => r.is_money === true), JSON.stringify(rows.map((r) => [r.action, r.is_money])));
  const edited = rows.find((r) => r.action === 'contract.edited');
  ok('the edit carries before AND after in CENTS',
    edited.before.monthlyCents === 125075 && edited.after.monthlyCents === 130000, JSON.stringify(edited.before) + JSON.stringify(edited.after));
  ok('…and says so in one sentence', /125075/.test(edited.summary) && /130000/.test(edited.summary), edited.summary);
  ok('the row files under the customer it is about', edited.client_id === 'cl_1' && edited.client_name === 'Ball Harbor Village', `${edited.client_id} / ${edited.client_name}`);
  ok('the actor comes from the claim, with their role', edited.actor_user_id === 'u_owner' && edited.actor_role === 'owner', JSON.stringify([edited.actor_user_id, edited.actor_role]));
  const deleted = rows.find((r) => r.action === 'contract.deleted');
  ok('the delete keeps what was lost in `before`', deleted.before && deleted.before.startDate === '2026-01-01', JSON.stringify(deleted.before));
  ok('the contract and its children are gone', world.tables.contracts.length === 0
    && world.tables.contract_years.length === 0 && world.tables.contract_reminders.length === 0,
    `${world.tables.contracts.length}/${world.tables.contract_years.length}/${world.tables.contract_reminders.length}`);
}

// ── 8. CON-11: the signed PDF ───────────────────────────────────────────────
console.log('\n── CON-11: the signed contract document ──');
{
  build();
  const c = newContract();
  await create(c);
  const up = await call({ method: 'POST', path: `${c.id}/upload-url`, token: tok('owner'), body: { mimeType: 'application/pdf', sizeBytes: 120000 } });
  ok('an upload URL is minted', up.status === 200 && !!up.body.signedUrl, show(up));
  ok('…under THIS contract\'s own prefix, rebuilt server-side', String(up.body.path).startsWith(`${ORG}/${c.id}/`), up.body.path);

  const bad = await call({ method: 'POST', path: `${c.id}/upload-url`, token: tok('owner'), body: { mimeType: 'application/x-msdownload', sizeBytes: 10 } });
  ok('an executable is refused', bad.status === 400, show(bad));

  await call({ method: 'POST', path: `${c.id}/document`, token: tok('owner'), body: { name: 'Signed.pdf', size: 120000, storagePath: up.body.path } });
  const got = await call({ method: 'GET', path: `${c.id}`, token: tok('owner') });
  ok('the document is recorded on the contract', got.body.contract.document && got.body.contract.document.name === 'Signed.pdf', JSON.stringify(got.body.contract.document));

  const dl = await call({ method: 'POST', path: `${c.id}/download-url`, token: tok('admin'), body: { storagePath: up.body.path } });
  ok('contracts.view is enough to open it', dl.status === 200 && !!dl.body.url, show(dl));

  const foreign = await call({ method: 'POST', path: `${c.id}/download-url`, token: tok('owner'), body: { storagePath: `${ORG}/${randomUUID()}/other.pdf` } });
  ok('another contract\'s object is refused', foreign.status === 400, show(foreign));
  const escape = await call({ method: 'POST', path: `${c.id}/download-url`, token: tok('owner'), body: { storagePath: `${ORG}/${c.id}/../../secret.pdf` } });
  ok('a path that walks out of the prefix is refused', escape.status === 400, show(escape));
}

// ── 9. the cron ─────────────────────────────────────────────────────────────
console.log('\n── CON-6..9 on the ops-alert cron: who hears about a renewal ──');
{
  const state = build();
  // A contract whose end is 60 days out, so its end reminder is due TODAY.
  const endOn = addDaysKey(TODAY, REMINDER_LEAD_DAYS);
  const c = newContract({
    clientIds: ['cl_1'], startDate: '2026-01-01', endDate: endOn, termMonths: 36,
    cancellationNoticeDays: 0, years: undefined,
  });
  await create(c);
  const due = world.tables.contract_reminders.filter((r) => r.next_due_on <= TODAY);
  ok('the end reminder is due today', due.length === 1 && due[0].kind === REMINDER_KIND.end, JSON.stringify(world.tables.contract_reminders.map((r) => [r.kind, r.next_due_on])));

  const alerts = await contractAlertsFor(state, NOW, new Set());
  ok('the walker raises one alert', alerts.length === 1, JSON.stringify(alerts));
  ok('…routed to the account manager AND the owner (CON-9)',
    alerts[0].recipientScope === 'users'
    && [...alerts[0].userIds].sort().join() === ['u_mgr', 'u_owner'].join(),
    JSON.stringify(alerts[0].userIds));
  ok('…with a deterministic id built off the reminder row', alerts[0].id === contractAlertId(due[0].id), alerts[0].id);
  ok('…and it deep-links to the customer\'s Contract tab', alerts[0].url === '/clients/cl_1?tab=contract', alerts[0].url);
  ok('…and its words name the date', /contract is ending/i.test(alerts[0].title) && alerts[0].body.includes('60 days away'), `${alerts[0].title} | ${alerts[0].body}`);

  // OUTSIDE office hours it raises nothing — a renewal is sixty days away, nobody needs it
  // at 03:00, and holding the RAISE means no bell accumulates overnight either.
  const threeAm = Date.parse('2026-10-07T07:00:00.000Z'); // 03:00 America/New_York
  ok('outside office hours it stays silent', (await contractAlertsFor(state, threeAm, new Set())).length === 0);

  // Already fired -> never again in the same window.
  ok('an already-fired marker makes it a no-op',
    (await contractAlertsFor(state, NOW, new Set([contractAlertId(due[0].id)]))).length === 0);

  // Now the full orchestration: bells written, reminders stamped, nothing rung twice.
  let written = null;
  const deps = {
    now: NOW,
    readState: async () => ({ state: structuredClone(written || state), version: 4 }),
    writeState: async (next) => { written = next; return true; },
    compute: async (s, now) => contractAlertsFor(s, now, new Set((s.opsAlertEvents || []).map((e) => e.id))),
    dispatch: async () => ({ claimed: 1, sent: 1 }),
    pushToUser: async () => ({ delivered: 0 }),
    pushReady: () => true,
    logAuto: async (rows) => rows,
    report: () => {},
  };
  const out = await run(false, deps);
  ok('the run raises the alert', out.raised === 1, JSON.stringify(out));
  const rung = (written.notifications || []).map((n) => n.userId).sort();
  ok('a bell row lands for the manager and the owner', rung.join() === ['u_mgr', 'u_owner'].join(), JSON.stringify(rung));
  ok('…carrying the contractReminder event, so the Account toggle governs it',
    (written.notifications || []).every((n) => n.eventKey === CONTRACT_ALERT_KIND), JSON.stringify(written.notifications.map((n) => n.eventKey)));
  ok('…and push was flushed immediately', out.push && out.push.sent === 1, JSON.stringify(out.push));
  ok('the reminder is stamped once the bell is durable', out.contracts && out.contracts.stamped === 1, JSON.stringify(out.contracts));
  ok('…in the table, so it survives the marker being pruned',
    world.tables.contract_reminders.filter((r) => r.notified_at).length === 1,
    JSON.stringify(world.tables.contract_reminders.map((r) => [r.kind, r.notified_at])));

  const second = await run(false, deps);
  ok('a second run rings nothing — the stamp IS the dedup', second.raised === 0, JSON.stringify(second));
}

// A master agreement reaches every covered building's manager.
{
  const state = build();
  const endOn = addDaysKey(TODAY, REMINDER_LEAD_DAYS);
  await create(newContract({
    clientIds: ['cl_1', 'cl_2', 'cl_3'], isMaster: true, name: 'City of Hollywood',
    endDate: endOn, cancellationNoticeDays: 0, years: undefined,
  }));
  const alerts = await contractAlertsFor(state, NOW, new Set());
  ok('a master contract reaches EVERY building\'s manager, plus the owner',
    alerts.length === 1 && [...alerts[0].userIds].sort().join() === ['u_mgr', 'u_mgr2', 'u_owner'].join(),
    JSON.stringify(alerts[0] && alerts[0].userIds));
  ok('…and opens the Contracts list, since no single customer page holds it',
    alerts[0].url.startsWith('/contracts?c='), alerts[0].url);
}

// The back-blast bound: a bulk entry of contracts cannot flood the bell in one tick.
{
  const state = build();
  const endOn = addDaysKey(TODAY, REMINDER_LEAD_DAYS);
  // One contract, many due reminder rows: write them straight into the table so the walker
  // sees more than its per-run bound without needing thirty customers.
  const c = newContract({ clientIds: ['cl_1'], endDate: endOn, cancellationNoticeDays: 0, years: undefined });
  await create(c);
  for (let i = 0; i < CONTRACT_REMINDER_MAX_PER_RUN + 5; i += 1) {
    world.tables.contract_reminders.push({
      id: randomUUID(), organization_id: ORG, contract_id: c.id, kind: REMINDER_KIND.renewal,
      target_date: addDaysKey(endOn, i + 1), due_on: TODAY, next_due_on: TODAY,
      status: REMINDER_STATUS.pending, note: null, notified_at: null, done_at: null, done_by_user_id: null,
    });
  }
  const alerts = await contractAlertsFor(state, NOW, new Set());
  ok('a flood of due reminders is bounded per run — the rest ring minutes later',
    alerts.length === CONTRACT_REMINDER_MAX_PER_RUN, String(alerts.length));
}

// ── 10. CON-10: a renewal ALSO lands on the Renewals board ──────────────────
// Deliberately asserted on what the CRON WROTE (`written.opportunities`) rather than on the
// pure helper, so every check here fails on the pre-change tree with a wrong-behaviour
// assertion — no card where there should be one — instead of a missing import (THE LAW II.3).
console.log('\n── CON-10: a renewal also lands on the Renewals board ──');

// One cron run over whatever contract the caller just created; `written` is the state the
// single CAS write carried, so the opportunity and the bell rows prove they rode together.
function renewalRun(state) {
  let written = null;
  const deps = {
    now: NOW,
    readState: async () => ({ state: structuredClone(written || state), version: 4 }),
    writeState: async (next) => { written = next; return true; },
    compute: async (s, now) => contractAlertsFor(s, now, new Set((s.opsAlertEvents || []).map((e) => e.id))),
    dispatch: async () => ({ claimed: 1, sent: 1 }),
    pushToUser: async () => ({ delivered: 0 }),
    pushReady: () => true,
    logAuto: async (rows) => rows,
    report: () => {},
  };
  return { deps, written: () => written };
}
const cards = (w) => (w && w.opportunities) || [];

{
  const state = build();
  const endOn = addDaysKey(TODAY, REMINDER_LEAD_DAYS);
  const c = newContract({ clientIds: ['cl_1'], endDate: endOn, cancellationNoticeDays: 0, years: undefined });
  await create(c);
  const { deps, written } = renewalRun(state);
  const out = await run(false, deps);

  ok('the run places one card', cards(written()).length === 1, JSON.stringify(cards(written())));
  // `|| {}` so a MISSING card reports every property check as failed rather than throwing
  // out of the suite — the pre-change run has to be readable, not a stack trace.
  const card = cards(written())[0] || {};
  ok('…and says so in the response', out.renewalCards && out.renewalCards.placed === 1, JSON.stringify(out.renewalCards));
  ok('…on the board that OWNS the renewal-due stage, found by that key, not by a seed id',
    card.pipelineId === 'pl_not_the_seed_id' && card.stage === RENEWAL_STAGE, `${card.pipelineId}/${card.stage}`);
  ok('…open, so the board actually draws it', card.status === 'open', card.status);
  ok('…against the building, which is what the board card headlines', card.clientId === 'cl_1', card.clientId);
  ok('…named for the customer', card.title === 'Ball Harbor Village', card.title);
  ok('…owned by that account\'s manager', card.ownerUserId === 'u_mgr', String(card.ownerUserId));
  ok('…carrying the link to the contract', String(card.notes).includes(`/contracts?c=${c.id}`), card.notes);
  ok('…and the date it is about, as a re-zoneable day key', card.expectedCloseDate === endOn, String(card.expectedCloseDate));

  // 🔴 CS-019: contract money must not be copied into the shared record, which every
  // pipeline viewer reads whether or not they hold invoices.view.
  ok('🔴 the deal VALUE is left EMPTY — contract money never reaches the shared record',
    cards(written()).length === 1 && (card.value === null || card.value === undefined), JSON.stringify(card.value));
  ok('…and no price rides along on the card either',
    cards(written()).length === 1 && !JSON.stringify(card).includes('125075') && !JSON.stringify(card).includes('1250.75'), JSON.stringify(card));

  // It rode the SAME CAS write as the bell rows.
  ok('the card and the bell rows landed in one write', (written().notifications || []).length > 0 && cards(written()).length === 1);

  // A second run: the reminder is stamped, so nothing rings — and nothing is added.
  await run(false, deps);
  ok('a second run adds nothing', cards(written()).length === 1, String(cards(written()).length));

  // The office moves the card; a reminder that rings again must leave it alone. Clearing the
  // stamp + the marker is the only way to make the same cycle ring twice.
  const w = written();
  if (w.opportunities && w.opportunities[0]) {
    w.opportunities[0].stage = 'renewal-outreach';
    w.opportunities[0].notes = 'Called Yolanda';
  }
  w.opsAlertEvents = [];
  for (const r of world.tables.contract_reminders) r.notified_at = null;
  const again = await run(false, deps);
  ok('the reminder rings again once its stamp is cleared', again.raised === 1, JSON.stringify(again));
  ok('…but the card the office already MOVED is left exactly as it is',
    cards(written()).length === 1 && cards(written())[0].stage === 'renewal-outreach'
    && cards(written())[0].notes === 'Called Yolanda',
    JSON.stringify(cards(written())));
  ok('…and the run reports it placed nothing new', again.renewalCards && again.renewalCards.placed === 0, JSON.stringify(again.renewalCards));
}

// A PRICE CHANGE and a CANCELLATION NOTICE ring, but neither is a renewal.
{
  const state = build();
  const c = newContract({
    clientIds: ['cl_1'],
    // Its end is far out, so only the price change (60 days ahead of year 2) is due today.
    startDate: addDaysKey(TODAY, -365), endDate: addDaysKey(TODAY, 900), termMonths: 36,
    cancellationNoticeDays: 0,
    years: [
      { yearNumber: 1, startsOn: addDaysKey(TODAY, -365), monthlyCents: 100000 },
      { yearNumber: 2, startsOn: addDaysKey(TODAY, REMINDER_LEAD_DAYS), monthlyCents: 110000 },
      { yearNumber: 3, startsOn: addDaysKey(TODAY, 425), monthlyCents: 120000 },
    ],
  });
  await create(c);
  const dueKinds = world.tables.contract_reminders.filter((r) => r.next_due_on <= TODAY && r.target_date >= TODAY).map((r) => r.kind);
  ok('a price-change reminder is what is due here', dueKinds.includes(REMINDER_KIND.price_increase) && !dueKinds.includes(REMINDER_KIND.renewal) && !dueKinds.includes(REMINDER_KIND.end), dueKinds.join(','));
  const { deps, written } = renewalRun(state);
  const out = await run(false, deps);
  ok('the price-change reminder still rings', out.raised >= 1, JSON.stringify(out));
  ok('🔴 …but a price change puts NO card on the renewals board', cards(written()).length === 0, JSON.stringify(cards(written())));
}
{
  const state = build();
  const c = newContract({
    clientIds: ['cl_1'], endDate: addDaysKey(TODAY, 120), cancellationNoticeDays: 60, years: undefined,
  });
  await create(c);
  const dueKinds = world.tables.contract_reminders.filter((r) => r.next_due_on <= TODAY && r.target_date >= TODAY).map((r) => r.kind);
  ok('a cancellation-notice reminder is what is due here',
    dueKinds.length === 1 && dueKinds[0] === REMINDER_KIND.cancellation_notice, dueKinds.join(','));
  const { deps, written } = renewalRun(state);
  await run(false, deps);
  ok('🔴 …and a notice deadline puts NO card on the renewals board either', cards(written()).length === 0, JSON.stringify(cards(written())));
}

// A RENEWAL reminder (the auto-renewing shape) places a card just as an end date does.
{
  const state = build();
  const renewOn = addDaysKey(TODAY, REMINDER_LEAD_DAYS);
  const c = newContract({
    clientIds: ['cl_2'], termType: TERM_TYPE.auto_renew, termMonths: 12,
    startDate: addDaysKey(renewOn, -366), endDate: addDaysKey(renewOn, -1),
    cancellationNoticeDays: 0, years: undefined,
  });
  await create(c);
  const { deps, written } = renewalRun(state);
  await run(false, deps);
  ok('a RENEWAL reminder places a card too', cards(written()).length === 1, JSON.stringify(cards(written())));
  ok('…owned by THAT account\'s manager', cards(written())[0] && cards(written())[0].ownerUserId === 'u_mgr2', JSON.stringify(cards(written())[0] && cards(written())[0].ownerUserId));
  ok('…with the contract id in its own id, so the same cycle can never mint a second',
    cards(written())[0] && String(cards(written())[0].id).includes(c.id), String(cards(written())[0] && cards(written())[0].id));
}

// A master agreement: the card names the agreement and its first building, and has no
// supervisor to own it when the first building has none.
{
  const state = build();
  const endOn = addDaysKey(TODAY, REMINDER_LEAD_DAYS);
  await create(newContract({
    clientIds: ['cl_3', 'cl_1'], isMaster: true, name: 'City of Hollywood',
    endDate: endOn, cancellationNoticeDays: 0, years: undefined,
  }));
  const { deps, written } = renewalRun(state);
  await run(false, deps);
  const card = cards(written())[0];
  ok('a master agreement places ONE card', cards(written()).length === 1, JSON.stringify(cards(written())));
  ok('…named for the agreement and its first building', card && card.title === 'City of Hollywood — Las Olas Medical', String(card && card.title));
  ok('…filed under that first building', card && card.clientId === 'cl_3', String(card && card.clientId));
  ok('…and unowned when that building has no manager', card && card.ownerUserId === null, String(card && card.ownerUserId));
}

// No board carries the renewal-due stage: skip cleanly, say so, and still ring the bell.
{
  const state = build({ pipelines: [{ id: 'pl_master', label: 'Master', isMaster: true, stages: [{ id: 's1', key: 'new-lead', label: 'New Lead' }] }] });
  const endOn = addDaysKey(TODAY, REMINDER_LEAD_DAYS);
  await create(newContract({ clientIds: ['cl_1'], endDate: endOn, cancellationNoticeDays: 0, years: undefined }));
  const { deps, written } = renewalRun(state);
  const out = await run(false, deps);
  ok('with no renewals board the bell still rings', out.raised === 1, JSON.stringify(out));
  ok('…no card is invented on another board', cards(written()).length === 0, JSON.stringify(cards(written())));
  ok('…and the run COUNTS what it skipped, so a missing board is visible',
    out.renewalCards && out.renewalCards.placed === 0 && out.renewalCards.skipped === 1, JSON.stringify(out.renewalCards));
}

// An org with no pipelines slice at all must not throw (default-safe read).
{
  const state = build({ pipelines: undefined });
  delete state.pipelines;
  delete state.opportunities;
  const endOn = addDaysKey(TODAY, REMINDER_LEAD_DAYS);
  await create(newContract({ clientIds: ['cl_1'], endDate: endOn, cancellationNoticeDays: 0, years: undefined }));
  const { deps, written } = renewalRun(state);
  const out = await run(false, deps);
  ok('an org with no pipelines slice still rings, and adds nothing',
    out.raised === 1 && cards(written()).length === 0, JSON.stringify([out.raised, cards(written())]));
}

console.log(`\n${fails.length ? '✗' : '✓'} contracts route + cron: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error(`  ✗ ${f}`);
if (fails.length) process.exitCode = 1;
