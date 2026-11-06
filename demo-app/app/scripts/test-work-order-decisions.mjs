// Matt's three work-order decisions of 2026-09-29, driven through the REAL
// api/qc/[...path].js handler and the REAL supabase-js client against
// scripts/fake-supabase-http.mjs on 127.0.0.1 (the offline-drive pattern; no sandbox project
// exists — CS-033). Nothing leaves this machine: SUPABASE_URL points at the fake before the
// handler is imported, and the run refuses to go on otherwise.
//
//   WO-10  "Is a completion photo required to close a ticket? — (b) Always required."
//   WO-12  "…categories for reporting? — (a) Yes: restock, spill, missed area, extra service,
//          other."
//   WO-14  "How should 'complaining too much' show up? — (a) A flag on the account when it
//          passes a set number of tickets in 30 days" (his note: 10).
//
//   node app/scripts/test-work-order-decisions.mjs
import { startFakeSupabase } from './fake-supabase-http.mjs';

let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) pass += 1; else fails.push(d ? `${n} — ${d}` : n); };
const eq = (n, got, want) => ok(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const ORG = '00000000-0000-0000-0000-000000000001';
const watchdog = setTimeout(() => { console.error('test-work-order-decisions: timed out'); process.exit(1); }, 60000);

const TOKENS = {
  't-owner': { id: 'a-ow', email: 'ow@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } },
  't-mgr': { id: 'a-mg', email: 'mg@cs.co', app_metadata: { role: 'manager', org_user_id: 'u_mgr', org_id: ORG } },
};

const fake = await startFakeSupabase({ authUsers: TOKENS });
Object.assign(process.env, {
  SUPABASE_URL: fake.url,
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  SUPABASE_ANON_KEY: 'anon',
  CLEANSPACE_ORG_ID: ORG,
});
delete process.env.ALERT_WEBHOOK_URL;
if (!String(process.env.SUPABASE_URL).startsWith('http://127.0.0.1:')) {
  console.error('refusing to run: SUPABASE_URL is not the local fake');
  process.exit(1);
}
const { default: handler } = await import('../api/qc/[...path].js');
// Asserted against the SHARED rule module, never a restated list or sentence (II.3).
const {
  WO_CATEGORIES, WO_CATEGORY_META, UNCATEGORIZED_LABEL, normalizeCategory, woCategoryLabel,
  RESOLVE_PHOTO_CODE, RESOLVE_PHOTO_MESSAGE, resolvePhotoRefusal,
  TICKET_FLAG_DAYS, DEFAULT_TICKET_FLAG_COUNT, ticketFlagThreshold, isTicketFlagged,
  ticketCountsByClient, toWorkOrder,
} = await import('../src/lib/workOrders.js');

const DAY = 24 * 3600 * 1000;
const user = (id, role) => ({ id, role, status: 'active', name: id, email: `${id}@cs.co` });
const baseState = () => ({
  version: 57,
  company: { id: 'co', name: 'Clean Space', timezone: 'America/New_York' },
  users: [user('u_owner', 'owner'), user('u_mgr', 'manager')],
  clients: [
    { id: 'c_bay', name: 'Coral Bay HOA', supervisorId: 'u_mgr' },
    { id: 'c_pac', name: 'Pacific Tower', supervisorId: 'u_mgr' },
  ],
  sites: [{ id: 's_bay', clientId: 'c_bay', name: 'Bay clubhouse' }, { id: 's_pac', clientId: 'c_pac', name: 'Pacific lobby' }],
  permissions: [], userPermissionOverrides: [],
  opsSettings: {},
});

const ticket = (id, over = {}) => ({
  id, organization_id: ORG, client_id: 'c_bay', site_id: 's_bay', title: id,
  type: 'issue', origin: 'internal', priority: 'medium', status: 'open',
  created_at: new Date(Date.now() - DAY).toISOString(), resolved_at: null, category: null, ...over,
});
const photo = (refId, over = {}) => ({
  id: `am_${refId}`, organization_id: ORG, scope: 'problem_report', ref_id: refId,
  site_id: 's_bay', client_id: 'c_bay', kind: 'image', storage_path: 'x/y.jpg',
  created_at: new Date().toISOString(), ...over,
});

function reset({ problems = [], media = [] } = {}) {
  fake.tables.org_state.splice(0, fake.tables.org_state.length,
    { organization_id: ORG, state: baseState(), version: 57, updated_at: '2026-09-29T12:00:00.000Z', protected_fingerprint: null });
  fake.tables.problem_reports = problems;
  fake.tables.account_media = media;
  // The open view carries each ticket's first staff reply (a complete read of work_order_messages).
  fake.tables.work_order_messages = [];
  fake.tables.jobs = [];
  fake.requests.length = 0;
}

async function call(path, { token = null, body = {}, method = 'POST', query = {} } = {}) {
  const parts = path.split('/');
  const req = {
    method, url: `/api/qc/${path}`, query: { path: parts, ...query }, body,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
  };
  const out = { status: 200, body: null, headers: {} };
  const res = {
    status(c) { out.status = c; return res; },
    json(b) { out.body = b; return res; },
    setHeader(k, v) { out.headers[k] = v; return res; },
    end() { return res; },
  };
  await handler(req, res);
  return out;
}
const rowsIn = () => fake.tables.problem_reports;
const byId = (id) => rowsIn().find((r) => r.id === id) || null;

// ═════════════════════════ WO-12 · the reporting category ════════════════════════
{
  // Matt's five (WO-12), plus `damage` for a visitor's "Something broken or damaged" (QR-23 c,
  // 2026-10-17), with "other" still last.
  eq('the categories: Matt\'s five in his order, damage before other', WO_CATEGORIES, ['restock', 'spill', 'missed_area', 'extra_service', 'damage', 'other']);
  ok('each carries a label and a hint', WO_CATEGORIES.every((c) => WO_CATEGORY_META[c]?.label && WO_CATEGORY_META[c]?.hint));
  eq('a known code survives normalization', normalizeCategory('spill'), 'spill');
  eq('an unknown code is dropped, never coerced to other', normalizeCategory('flood'), null);
  eq('an empty string is no category', normalizeCategory(''), null);
  eq('undefined is no category', normalizeCategory(undefined), null);
  eq('no category reads as Uncategorized, not "Other"', woCategoryLabel(null), UNCATEGORIZED_LABEL);
  ok('…which is NOT the Other label', UNCATEGORIZED_LABEL !== WO_CATEGORY_META.other.label);
  eq('the view-model carries the category through', toWorkOrder({ category: 'restock' }).category, 'restock');
  eq('…and normalizes a stray one', toWorkOrder({ category: 'nope' }).category, null);

  // CREATE with a category, and without one.
  reset();
  let r = await call('problems/create', { token: 't-owner', body: { clientId: 'c_bay', siteId: 's_bay', title: 'Soap out', category: 'restock' } });
  eq('create with a category → 200', r.status, 200);
  eq('…stored', rowsIn().slice(-1)[0].category, 'restock');
  r = await call('problems/create', { token: 't-owner', body: { clientId: 'c_bay', siteId: 's_bay', title: 'No category' } });
  eq('create with none stores NULL, not "other"', rowsIn().slice(-1)[0].category, null);
  r = await call('problems/create', { token: 't-owner', body: { clientId: 'c_bay', siteId: 's_bay', title: 'Bad', category: 'flood' } });
  eq('an unknown category is dropped at the write point', rowsIn().slice(-1)[0].category, null);

  // EDIT it, and CLEAR it.
  reset({ problems: [ticket('p1')] });
  await call('problems/update', { token: 't-owner', body: { id: 'p1', category: 'missed_area' } });
  eq('update sets the category', byId('p1').category, 'missed_area');
  await call('problems/update', { token: 't-owner', body: { id: 'p1', category: null } });
  eq('…and null clears it back to uncategorized', byId('p1').category, null);
  await call('problems/update', { token: 't-owner', body: { id: 'p1', category: 'nope' } });
  eq('…while an unknown value stays cleared', byId('p1').category, null);
  await call('problems/update', { token: 't-owner', body: { id: 'p1', title: 'Renamed' } });
  eq('an update that never mentions the category leaves it alone', byId('p1').category, null);

  // FILTERABLE.
  reset({ problems: [ticket('p1', { category: 'spill' }), ticket('p2', { category: 'restock' }), ticket('p3')] });
  r = await call('problems/list', { token: 't-owner', method: 'GET', query: { category: 'spill' } });
  eq('list filters by category', (r.body?.problems || []).map((p) => p.id), ['p1']);
  r = await call('problems/list', { token: 't-owner', method: 'GET' });
  eq('…and without the filter every ticket is listed', (r.body?.problems || []).length, 3);
}

// ═════════════════════ WO-10 · a completion photo to resolve ═════════════════════
{
  // The pure rule first.
  eq('resolving with no photo is refused', resolvePhotoRefusal({ status: 'resolved', photoCount: 0 }), RESOLVE_PHOTO_CODE);
  eq('…with one is fine', resolvePhotoRefusal({ status: 'resolved', photoCount: 1 }), null);
  eq('a missing count is no photos', resolvePhotoRefusal({ status: 'resolved' }), RESOLVE_PHOTO_CODE);
  eq('every OTHER status is untouched', [
    resolvePhotoRefusal({ status: 'open', photoCount: 0 }),
    resolvePhotoRefusal({ status: 'in_progress', photoCount: 0 }),
    resolvePhotoRefusal({ status: 'awaiting_client', photoCount: 0 }),
  ], [null, null, null]);
  eq('an absent status is untouched', resolvePhotoRefusal({}), null);
  // Legacy 'ack' normalizes to in_progress, so it is not a resolve either.
  eq('the legacy ack status is not a resolve', resolvePhotoRefusal({ status: 'ack', photoCount: 0 }), null);

  // 🔴 The SERVER refuses.
  reset({ problems: [ticket('p1')] });
  let r = await call('problems/update', { token: 't-owner', body: { id: 'p1', status: 'resolved' } });
  eq('resolve with NO photo → 409', r.status, 409);
  eq('…with the shared code', r.body?.code, RESOLVE_PHOTO_CODE);
  eq('…and the shared sentence', r.body?.error, RESOLVE_PHOTO_MESSAGE);
  eq('…and the ticket is untouched', byId('p1').status, 'open');
  eq('…with no resolved_at stamped', byId('p1').resolved_at, null);

  // Any other status change still works with no photo.
  r = await call('problems/update', { token: 't-owner', body: { id: 'p1', status: 'in_progress' } });
  eq('in_progress needs no photo', r.status, 200);
  eq('…and landed', byId('p1').status, 'in_progress');
  r = await call('problems/update', { token: 't-owner', body: { id: 'p1', priority: 'urgent', escalated: true } });
  eq('a priority + escalation change needs no photo', r.status, 200);

  // WITH a photo it resolves.
  reset({ problems: [ticket('p1')], media: [photo('p1')] });
  r = await call('problems/update', { token: 't-owner', body: { id: 'p1', status: 'resolved' } });
  eq('resolve WITH a photo → 200', r.status, 200);
  eq('…and it is resolved', byId('p1').status, 'resolved');
  ok('…with a resolved_at stamp', !!byId('p1').resolved_at);

  // A photo attached to ANOTHER ticket does not count.
  reset({ problems: [ticket('p1'), ticket('p2')], media: [photo('p2')] });
  r = await call('problems/update', { token: 't-owner', body: { id: 'p1', status: 'resolved' } });
  eq("another ticket's photo does not unlock this one", r.status, 409);
  // Nor does media at a different SCOPE (an inspection photo, a cleaning instruction).
  reset({ problems: [ticket('p1')], media: [photo('p1', { scope: 'cleaning_instruction' })] });
  r = await call('problems/update', { token: 't-owner', body: { id: 'p1', status: 'resolved' } });
  eq('media at another scope does not count as a completion photo', r.status, 409);

  // REOPEN is never gated: a resolved ticket must always be able to come back.
  reset({ problems: [ticket('p1', { status: 'resolved', resolved_at: new Date().toISOString() })] });
  r = await call('problems/update', { token: 't-owner', body: { id: 'p1', status: 'open' } });
  eq('reopening a resolved ticket needs no photo', r.status, 200);
  eq('…and clears resolved_at', byId('p1').resolved_at, null);

  // A manager is held to it too — it is not an owner-only courtesy.
  reset({ problems: [ticket('p1')] });
  r = await call('problems/update', { token: 't-mgr', body: { id: 'p1', status: 'resolved' } });
  eq('a manager is refused the same way', r.status, 409);
}

// ═════════════════════ WO-14 · the ticket-volume account flag ════════════════════
{
  eq('the window is 30 days', TICKET_FLAG_DAYS, 30);
  eq('the default count is 10', DEFAULT_TICKET_FLAG_COUNT, 10);
  eq('no setting → the default', ticketFlagThreshold({}), DEFAULT_TICKET_FLAG_COUNT);
  eq('a setting is used', ticketFlagThreshold({ ticketFlagCount30d: 4 }), 4);
  eq('zero falls back (it would flag every account, including empty ones)', ticketFlagThreshold({ ticketFlagCount30d: 0 }), DEFAULT_TICKET_FLAG_COUNT);
  eq('a non-number falls back', ticketFlagThreshold({ ticketFlagCount30d: 'ten' }), DEFAULT_TICKET_FLAG_COUNT);
  ok('"passes" reads as AT or above — the flag fires ON the tenth ticket', isTicketFlagged(10, {}) && !isTicketFlagged(9, {}));
  ok('…and above it', isTicketFlagged(50, {}));
  ok('no tickets is never flagged', !isTicketFlagged(0, {}));

  // The pure tally.
  const now = Date.now();
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => ({ client_id: 'c_bay', created_at: new Date(now - (i + 1) * DAY).toISOString() })),
    { client_id: 'c_pac', created_at: new Date(now - 2 * DAY).toISOString() },
    { client_id: 'c_bay', created_at: new Date(now - 90 * DAY).toISOString() },   // outside the window
    { client_id: null, created_at: new Date(now - DAY).toISOString() },           // no customer
    { client_id: 'c_bay', created_at: 'not-a-date' },                             // junk
  ];
  const counts = ticketCountsByClient(rows, { now });
  eq('only tickets INSIDE the window count', counts.get('c_bay'), 3);
  eq('…per customer', counts.get('c_pac'), 1);
  eq('a ticket with no customer is not counted anywhere', counts.size, 2);
  eq('no rows → no counts', ticketCountsByClient([], { now }).size, 0);
  eq('junk rows are ignored', ticketCountsByClient([null, undefined, {}], { now }).size, 0);

  // 🔴 The server read, complete and per customer.
  reset({
    problems: [
      ...Array.from({ length: 4 }, (_, i) => ticket(`b${i}`, { client_id: 'c_bay', created_at: new Date(now - (i + 1) * DAY).toISOString() })),
      ticket('p0', { client_id: 'c_pac', created_at: new Date(now - 3 * DAY).toISOString() }),
      ticket('old', { client_id: 'c_bay', created_at: new Date(now - 200 * DAY).toISOString() }),
    ],
  });
  const r = await call('problems/counts', { token: 't-owner', method: 'GET' });
  eq('the counts endpoint answers 200', r.status, 200);
  eq('…naming the window it counted', r.body?.days, TICKET_FLAG_DAYS);
  const got = Object.fromEntries((r.body?.counts || []).map((c) => [c.clientId, c.count]));
  eq('…4 for the busy customer', got.c_bay, 4);
  eq('…1 for the other', got.c_pac, 1);
  ok('…and the 200-day-old ticket is not counted', got.c_bay === 4);
  const flagged = (r.body?.counts || []).filter((c) => isTicketFlagged(c.count, { ticketFlagCount30d: 4 })).map((c) => c.clientId);
  eq('at a threshold of 4 only the busy customer is flagged', flagged, ['c_bay']);
  eq('at the default of 10 neither is', (r.body?.counts || []).filter((c) => isTicketFlagged(c.count, {})).length, 0);
}

clearTimeout(watchdog);
await fake.close();
console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error('  ✗ ' + f);
process.exitCode = fails.length === 0 ? 0 : 1;
