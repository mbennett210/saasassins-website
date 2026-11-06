// Node unit test: the production sandbox's seed (app/scripts/seed-backend.mjs) — its manager's day
// over a live book (scripts/_lib/managerDaySeed.mjs) and its write path over Postgres
// (scripts/_lib/seedWrite.mjs). Daniel, 2026-10-09: "Go ahead and seed more data so this can be
// better seen", and yes to loading the manager's day into the live sandbox.
//
// Offline: a fixture book shaped like production's (13 seed customers, 4 office users with
// buildings, 6 unmanaged, a vendor, 5 cleaners) and a FAKE Postgres client that records every
// statement. What it holds:
//   A. only unmanaged SEED buildings get a manager — never a vendor, never a customer the office
//      made, never one that already has a manager;
//   B. every managed building gets a visit, a request and a message thread; two messages still
//      wait for the office's first reply; nobody is in two places; the customer is written in the
//      portal shape (no client-hub user id, so no login and no email);
//   C. the shared record's part changes only seed customers, never overwrites a checklist the
//      office assigned, and never touches a user;
//   D. the write path: no whole-table delete is expressible; one transaction; the shared record's
//      CAS failing rolls everything back; any project but the production sandbox is refused.
// The modules are loaded dynamically so the suite RUNS (and reports its counts) on a tree where
// they do not exist yet: every check then fails instead of the file crashing.
//   node app/scripts/test-seed-backend-write.mjs
import { createHash } from 'node:crypto';

const load = async (p) => import(p).catch((e) => { console.error(`  (${p} did not load: ${e.code || e.message})`); return {}; });
const seed = await load('./_lib/managerDaySeed.mjs');
const write = await load('./_lib/seedWrite.mjs');
const { PROD_REF } = await import('./_lib/liveGuard.mjs');
const dates = await import('../src/lib/dates.js');

let pass = 0;
let fail = 0;
// ok(condition, message) — this file's own order.
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.error('  ✗ ' + m); } };
const HAVE = typeof seed.planManagerDays === 'function' && typeof write.runPgPlan === 'function';

const NS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const uuid5 = (name) => {
  const h = createHash('sha1').update(Buffer.from(NS.replace(/-/g, ''), 'hex')).update(String(name)).digest().subarray(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
};

// ── the fixture book (production's shape on 2026-10-09) ────────────────────────────────────────
const u = (key, name, role) => ({ id: `u_seed_${key}`, name, role, status: 'active' });
const users = [
  u('kyler', 'Matt Giunco', 'owner'), u('steve', 'Dana Cole', 'owner'), u('heather', 'Yolanda Reyes', 'admin'),
  u('lauren', 'Priya Nair', 'admin'), u('mgr1', 'Renata Cruz', 'manager'),
  u('crew1', 'Andre Baptiste', 'crew'), u('crew2', 'Tomas Rivera', 'crew'), u('crew3', 'Keisha Bryant', 'crew'),
  u('crew4', 'Luis Ferrer', 'crew'), u('crewdemo', 'Demo Crew', 'crew'),
];
const c = (key, name, sup, extra = {}) => ({ id: `cl_seed_${key}`, name, type: 'customer', supervisorId: sup, primaryContact: `${name} Contact`, ...extra });
const clients = [
  c('evergreen', 'Las Marinas', 'u_seed_mgr1', { crewChecklists: { u_seed_crew4: 'office_pick' } }),
  c('lakeside', 'Lime Tree', 'u_seed_kyler'), c('cascade', 'Huizenga Park', null), c('mtbaker', 'City of Hallandale', 'u_seed_kyler'),
  c('pacridge', 'Palmetto Ridge Corp', 'u_seed_heather'), c('olympic', 'Bayshore Senior Living', 'u_seed_lauren'),
  c('salishan', 'Flagler Townhomes', null), c('aventura', 'Aventura Dental Group', 'u_seed_kyler'),
  c('biscayne', 'Biscayne Harbor Apartments', 'u_seed_kyler'), c('coralgables', 'Coral Gables Architects', null),
  c('sunshine', 'Sunshine Supply Co', null, { type: 'vendor' }), c('northside', 'Northside Auto Group', null),
  c('riverwalk', 'Riverwalk Brewing Co', null),
  { id: 'cl_office_made', name: 'A customer the office made', type: 'customer', supervisorId: null },
];
const sites = clients.filter((x) => x.type !== 'vendor').map((x, i) => ({ id: `st_${x.id}`, clientId: x.id, name: `${x.name} site`, lat: 26 + i / 100, lng: -80 }));
const services = [{ id: 'svc_seed_jan', name: 'Janitorial' }, { id: 'svc_seed_flr', name: 'Floor care' }, { id: 'svc_seed_pw', name: 'Pressure wash' }, { id: 'svc_seed_rst', name: 'Restroom' }];
const TZ = 'America/New_York';
const state = { company: { timezone: TZ }, opsSettings: { payWeekStartDay: 1 }, clients, users };
const SCHEMA = { areas: [{ id: 'a_close', label: 'Close-Out', items: ['c1', 'c2', 'c3', 'c4', 'c5'].map((id) => ({ id, label: id })) }] };

// ── A. who gets a manager ──────────────────────────────────────────────────────────────────────
const assigned = HAVE ? seed.assignManagers({ clients, sites, users }) : { clients, assignments: [] };
{
  const ids = assigned.assignments.map((a) => a.clientId).sort();
  ok(JSON.stringify(ids) === JSON.stringify(['cl_seed_cascade', 'cl_seed_coralgables', 'cl_seed_northside', 'cl_seed_riverwalk', 'cl_seed_salishan']),
    `A1 the five unmanaged seed buildings get a manager (got ${ids.join(', ')})`);
  ok(assigned.assignments.every((a) => a.to === 'u_seed_mgr1'), 'A2 …the seed\'s manager, Renata');
  ok(!assigned.assignments.some((a) => a.clientId === 'cl_seed_sunshine'), 'A3 a vendor is never cleaned, so never managed');
  ok(!assigned.assignments.some((a) => a.clientId === 'cl_office_made'), 'A4 a customer the office made is never touched');
  ok(assigned.clients.find((x) => x.id === 'cl_seed_pacridge')?.supervisorId === 'u_seed_heather', 'A5 a building that has a manager keeps them');
}

// ── B. the day over the book, at several hours ────────────────────────────────────────────────
const today = dates.dayKey(new Date(), TZ);
for (const hm of ['07:30', '11:00', '14:00', '19:30']) {
  const now = new Date(Date.parse(dates.composeIso(today, hm, TZ)));
  const md = HAVE ? seed.planManagerDays({ clients: assigned.clients, sites, users, services, state, now }) : null;
  const out = md ? seed.managerDayRows(md, { org: 'org1', uuid5, nowIso: now.toISOString(), schema: SCHEMA }) : null;
  const tag = `at ${hm}`;
  ok(!!out, `B0 ${tag}: the day is planned and written`);
  if (!out) continue;
  const managed = assigned.clients.filter((x) => x.supervisorId && x.type !== 'vendor' && x.id.startsWith('cl_seed_'));
  const visited = new Set(out.jobRows.filter((r) => !r.id.includes('_md-ot-')).map((r) => r.client_id));
  const managers = new Set(managed.map((x) => x.supervisorId));
  const managersWithVisits = new Set([...visited].map((id) => assigned.clients.find((x) => x.id === id)?.supervisorId));
  ok([...managers].every((m) => managersWithVisits.has(m)), `B1 ${tag}: every manager's view holds a visit today`);
  if (hm === '14:00') ok(managed.every((x) => visited.has(x.id)), 'B2 at 14:00: every managed building has a visit today');
  ok(managed.every((x) => out.probRows.some((p) => p.client_id === x.id)), `B3 ${tag}: every managed building has a request the customer raised`);
  ok(managed.every((x) => out.threadRows.some((t) => t.client_id === x.id)), `B4 ${tag}: …and a hub message thread`);
  const waiting = out.threadRows.filter((t) => t.last_author_role === 'client');
  ok(waiting.length >= 2, `B5 ${tag}: at least two customer messages wait for the office's first reply (${waiting.length})`);
  ok(out.probRows.every((p) => p.origin === 'portal' && p.raised_by_client_user_id === null && p.raised_by_client_name)
    && out.cmsgRows.every((m) => m.author_client_user_id === null && m.author_name),
  `B6 ${tag}: the customer is written in the portal shape (a name, no client-hub user id)`);
  ok(out.msgRows.every((m) => !/\{[a-z,0-9]+\}/.test(m.body)) && out.cmsgRows.every((m) => !/\{[a-z,0-9]+\}/.test(m.body)), `B7 ${tag}: every message reads with its names filled in`);
  // nobody in two places
  const by = new Map();
  for (const t of out.teRows) {
    const a = Date.parse(t.clock_in_at);
    const b = t.clock_out_at ? Date.parse(t.clock_out_at) : now.getTime();
    if (!by.has(t.user_id)) by.set(t.user_id, []);
    by.get(t.user_id).push([a, b]);
  }
  let overlap = false;
  for (const list of by.values()) { list.sort((x, y) => x[0] - y[0]); for (let i = 1; i < list.length; i += 1) if (list[i][0] < list[i - 1][1]) overlap = true; }
  ok(!overlap, `B8 ${tag}: no cleaner's punches overlap`);
  const jobIds = new Set(out.jobRows.map((r) => r.id));
  ok(out.teRows.every((t) => jobIds.has(t.job_id)) && out.checkRows.every((r) => jobIds.has(r.job_id)), `B9 ${tag}: every punch and save names a job this seed writes`);
  ok(out.checkRows.every((r) => out.templateRows.some((t) => t.id === r.template_id && t.client_id === r.client_id)), `B10 ${tag}: every save is on the checklist filed under its building`);
  // a thread's summary is its newest line
  const lastOf = (cid) => out.cmsgRows.filter((m) => m.client_id === cid).sort((x, y) => String(x.created_at).localeCompare(String(y.created_at))).pop();
  ok(out.threadRows.every((t) => lastOf(t.client_id)?.id === t.last_message_id), `B11 ${tag}: each thread summary names its newest line`);
  // every id this run writes is one the next run can find
  const universe = seed.managerDayIdUniverse({ uuid5, seedClientIds: clients.filter((x) => x.id.startsWith('cl_seed_')).map((x) => x.id) });
  ok(out.probRows.every((p) => universe.problemIds.includes(p.id)) && out.cmsgRows.every((m) => universe.messageIds.includes(m.id))
    && out.checkRows.every((r) => universe.checklistIds.includes(r.id)), `B12 ${tag}: every request, message and save id is in the set the next run deletes`);
  ok(out.jobRows.every((r) => r.id.startsWith('j_bkseed_')), `B13 ${tag}: every job carries the seed prefix the clean-up finds`);
  // S131: the supply orders in the new shape — a submitted or completed order carries its per-line
  // record and its state, never "how many went out"; the order NUMBER is left to the table's sequence.
  const sr = out.supplyRequestRows || [];
  const gone = sr.filter((r) => r.status === 'sent' || r.status === 'completed');
  ok(gone.length > 0 && gone.every((r) => Array.isArray(r.fulfillment) && r.fulfillment.length === r.lines.length
    && ['pending', 'partial', 'ready'].includes(r.fulfillment_state) && r.sent_lines === null && r.sent_total_cents === null && !!r.sent_at),
    `B14 ${tag}: every supply order with the supplier carries its per-line record, no sent quantities`);
  ok(sr.every((r) => !('number' in r)), `B15 ${tag}: no supply order row sends a number (the sequence numbers it)`);
  ok(sr.filter((r) => r.status === 'completed').every((r) => r.fulfillment_state === 'ready'
    && r.fulfillment.every((e, i) => e.deliveries.reduce((a, d) => a + d.qty, 0) === r.lines[i].qty)), `B16 ${tag}: a completed order has every line delivered in full`);
}

// ── C. the shared record's part ──────────────────────────────────────────────────────────────
{
  const now = new Date(Date.parse(dates.composeIso(today, '14:00', TZ)));
  const md = HAVE ? seed.planManagerDays({ clients: assigned.clients, sites, users, services, state, now }) : null;
  const out = md ? seed.managerDayRows(md, { org: 'org1', uuid5, nowIso: now.toISOString(), schema: SCHEMA }) : null;
  const res = HAVE && out ? seed.blobClientChanges(clients, { assignments: assigned.assignments, picks: out.picks, budgetClientIds: out.budgetClientIds }) : { clients, changes: [] };
  const by = (id) => res.clients.find((x) => x.id === id);
  ok(res.changes.length > 0 && res.changes.every((ch) => ch.clientId.startsWith('cl_seed_')), 'C1 only seed customers change');
  ok(by('cl_office_made') === clients.find((x) => x.id === 'cl_office_made'), 'C2 …a customer the office made is the same object');
  ok(by('cl_seed_evergreen')?.crewChecklists?.u_seed_crew4 === 'office_pick', 'C3 a checklist the office assigned is never overwritten');
  ok(Object.keys(by('cl_seed_coralgables')?.crewChecklists || {}).length > 0 || Object.keys(by('cl_seed_riverwalk')?.crewChecklists || {}).length > 0,
    'C4 the cleaners on today\'s visits get the building\'s checklist');
  ok(res.changes.every((ch) => ['supervisorId', 'crewChecklists', 'supplyBudgetMonthly'].includes(ch.field)), 'C5 only the supervisor, the checklists and a budget change');
  const again = HAVE && out ? seed.blobClientChanges(res.clients, { assignments: assigned.assignments, picks: out.picks, budgetClientIds: out.budgetClientIds }) : { changes: [1] };
  ok(again.changes.length === 0, 'C6 applying it twice changes nothing the second time');
}

// ── D. the write path ────────────────────────────────────────────────────────────────────────
{
  const refused = (fn) => { try { fn(); return false; } catch { return true; } };
  ok(typeof write.whereSql === 'function' && refused(() => write.whereSql([])), 'D1 a delete with no filter is refused');
  ok(typeof write.whereSql === 'function' && refused(() => write.whereSql([{ col: 'organization_id', op: 'eq', value: 'o' }])), 'D2 …and one that names only the org');
  ok(typeof write.deleteSql === 'function' && refused(() => write.deleteSql('jobs; drop table x', [{ col: 'id', op: 'eq', value: 'a' }])), 'D3 an identifier that is not a plain name is refused');
  const d = typeof write.deleteSql === 'function' ? write.deleteSql('problem_reports', [{ col: 'organization_id', op: 'eq', value: 'o' }, { col: 'id', op: 'in', value: ['a', 'b'] }]) : { text: '', values: [] };
  ok(d.text === 'delete from public."problem_reports" where "organization_id" = $1 and "id" = any($2)' && Array.isArray(d.values[1]), 'D4 a delete names its rows by bound parameters');
  const types = new Map([['id', { data_type: 'text' }], ['lines', { data_type: 'jsonb' }], ['photo_paths', { data_type: 'ARRAY', udt_name: '_text' }], ['created_at', { data_type: 'timestamp with time zone' }]]);
  const up = typeof write.upsertSql === 'function' ? write.upsertSql('t', [{ id: 'a', lines: [{ q: 1 }], photo_paths: [], created_at: undefined }], { types }) : [{ text: '', values: [] }];
  ok(/values \(\$1, \$2::jsonb, \$3::text\[\], default\)/.test(up[0].text) && up[0].values[1] === '[{"q":1}]', 'D5 jsonb is sent as JSON, an array as an array, a missing value as the column default');
  ok(/on conflict \("id"\) do update set "lines" = excluded\."lines"/.test(up[0].text), 'D6 …and an existing row is updated (idempotent re-runs)');
  ok(typeof write.upsertSql === 'function' && refused(() => write.upsertSql('t', [{ nope: 1 }], { types })), 'D7 a column the table does not have is refused before anything is written');

  // a fake Postgres client: records statements, answers the type read and the shared record
  const fake = ({ casRows = 1, failOn = null } = {}) => {
    const log = [];
    return {
      log,
      async query(text, values) {
        log.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
        if (failOn && text.includes(failOn)) throw new Error('boom');
        if (/information_schema\.columns/.test(text)) {
          return { rows: ['jobs', 'problem_reports'].flatMap((t) => ['id', 'organization_id', 'data'].map((col) => ({ table_name: t, column_name: col, data_type: col === 'data' ? 'jsonb' : 'text', udt_name: 'text' }))) };
        }
        if (/from public\.org_state/.test(text)) return { rows: [{ state: { clients: [] }, version: '541' }] };
        if (/^update public\.org_state/.test(text)) return { rowCount: casRows };
        return { rowCount: 1, rows: [] };
      },
    };
  };
  const steps = [
    { kind: 'delete', table: 'jobs', where: [{ col: 'organization_id', op: 'eq', value: 'o' }, { col: 'id', op: 'like', value: 'j_bkseed_%' }] },
    { kind: 'upsert', table: 'jobs', rows: [{ id: 'j_bkseed_md_x', organization_id: 'o', data: { a: 1 } }], conflict: ['id'] },
    { kind: 'delete', table: 'forms', where: [{ col: 'organization_id', op: 'eq', value: 'o' }, { col: 'slug', op: 'like', value: 'bkseed-%' }] },
  ];
  const blob = { org: 'o', apply: (st) => ({ state: { ...st, touched: true }, changes: [] }) };
  if (typeof write.runPgPlan === 'function') {
    const f = fake();
    const res = await write.runPgPlan(f, { steps, blob });
    ok(f.log[1] === 'begin' && f.log[f.log.length - 1] === 'commit', 'D8 the whole plan runs in ONE transaction');
    ok(f.log.some((l) => l.startsWith('select state,')) && f.log.some((l) => l.startsWith('update public.org_state')), 'D9 …the shared record re-read and written inside it');
    ok(res.blob?.from === 541 && res.blob?.to === 542, 'D10 …its version moves by one');
    ok(res.skipped.some((x) => /forms/.test(x)) && !f.log.some((l) => /"forms"/.test(l)), 'D11 a table the project does not have is skipped, not failed');
    const g = fake({ casRows: 0 });
    let threw = false;
    try { await write.runPgPlan(g, { steps, blob }); } catch { threw = true; }
    ok(threw && g.log[g.log.length - 1] === 'rollback' && !g.log.includes('commit'), 'D12 the shared record moving under the write rolls EVERYTHING back');
    const h = fake({ failOn: 'insert into' });
    threw = false;
    try { await write.runPgPlan(h, { steps, blob }); } catch { threw = true; }
    ok(threw && h.log[h.log.length - 1] === 'rollback' && !h.log.includes('commit'), 'D13 a failed statement rolls everything back');
    const big = fake();
    threw = false;
    try { await write.runPgPlan(big, { steps, blob, maxBlobBytes: 5 }); } catch { threw = true; }
    ok(threw && big.log[big.log.length - 1] === 'rollback', 'D14 a shared record over its size limit is never written');
  } else for (let i = 8; i <= 14; i += 1) ok(false, `D${i} the Postgres write path exists`);

  const t = typeof write.pgTarget === 'function' ? write.pgTarget : () => ({ refusal: null, ref: null });
  ok(t(`postgresql://postgres.${PROD_REF}:pw@aws-0.pooler.supabase.com:6543/postgres`).refusal === null, 'D15 the production sandbox is the one target');
  ok(!!t('postgresql://postgres.someotherref000000:pw@aws-0.pooler.supabase.com:6543/postgres').refusal, 'D16 any other project is refused');
  ok(!!t('postgresql://user:pw@localhost:5432/db').refusal, 'D17 …and so is one whose project cannot be read');
}

// ── E. seed-backend uses only the plan to delete ─────────────────────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./seed-backend.mjs', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  ok(!/\.delete\(\)/.test(src), 'E1 seed-backend issues no delete of its own: every delete is a plan step with its seed filter');
  ok(/D\('problem_reports', \[\{ col: 'id', op: 'in', value: seedWoIds \}\]\)/.test(src) && /D\('work_order_messages', \[\{ col: 'problem_id', op: 'in', value: seedWoIds \}\]\)/.test(src),
    'E2 work orders and their messages are deleted by the seed\'s own ids');
  ok(/explainPgPlan\(/.test(src) && /countPgDeletes\(/.test(src), 'E3 the dry run counts what it would delete and has the database plan every statement');
  ok(/runPgPlan\(/.test(src) && /pgTarget\(/.test(src), 'E4 --commit over Postgres goes through the one-transaction path, after the target check');
}

console.log(`\n${pass}/${pass + fail} seed-backend write assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exitCode = 1; }
