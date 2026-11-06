// QB-9 / QB-10 — the NIGHTLY QuickBooks refresh, and the cache and errors around it (offline).
//
// Matt, 2026-09-29: "How fresh should the numbers be? (a) Updated every night" (QB-9) and "How
// much history should load when we connect? (a) The last 12 months" (QB-10). Driven through the
// REAL cron handler (api/cron/qbo-refresh.js) and the REAL QuickBooks route over fake Supabase
// and a logging Intuit stub (scripts/qbo-harness.mjs). Pins:
//   A. the cron gate: CRON_SECRET unset → 500, wrong or missing bearer → 401, nothing read;
//   B. it refreshes ONLY the linked properties: one P&L per nightly window (12 months and
//      all-time included, 'Today' not), each filtered to the linked ids and their descendants,
//      on the accrual basis, on the connected company only;
//   C. it writes last_synced_at, and Settings' status shows it and who connected (CS-569);
//   D. a run that finds tonight's refresh done asks QuickBooks nothing;
//   E. the dashboard then reads the warm numbers (a nightly window is a day's snapshot; 'Today'
//      is pulled live);
//   F. the report cache is bounded at the write point: an age ceiling and a count cap (CS-566);
//   G. a transient QuickBooks failure is RETRYABLE: 503 + retryable, no stamp, the previous
//      snapshot kept, and the next run fetches only the gap (CS-574);
//   H. reauth needed → 409, not retryable;
//   I. the owner's "Refresh data" re-pulls every window now;
//   J. the route answers a transient failure 503 + retryable, never 500 or a 504 (CS-574, CS-572);
//   K. the entity list is a COMPLETE read: count first, every page, never capped.
//
//   node scripts/test-qbo-nightly.mjs
import { rig, counter, pnlReport } from './qbo-harness.mjs';
import { resolveRange } from '../api/_lib/qbo/ranges.js';
import * as client from '../api/_lib/qbo/client.js';

const { ok, finish } = counter('qbo-nightly');
const r = await rig();
const cron = (await import('../api/cron/qbo-refresh.js').catch(() => null))?.default || null;
ok('the nightly cron route exists (api/cron/qbo-refresh.js)', typeof cron === 'function');
// The one body every cron gate answers an unset secret with (null before it existed).
const { CRON_UNAVAILABLE = null } = await import('../api/_lib/cronGate.js').catch(() => ({}));

const TZ = 'America/New_York';
// 'mtd' (this month) joined with the dashboard's period picker (2026-10-04).
const NIGHTLY = ['d10', 'd15', 'd30', 'd60', 'd90', 'm12', 'all', 'mtd'];
const BEARER = { authorization: `Bearer ${process.env.CRON_SECRET}` };
const runCron = (headers = BEARER) => (cron ? r.call({ using: cron, raw: true, headers }) : Promise.resolve({ status: 0, body: {}, headers: {} }));
const conn = () => r.world.tables.qbo_connection[0] || null;
const pnlRows = () => r.world.tables.qbo_report_cache.filter((row) => row.cache_key.startsWith('pnl:'));
const windowOf = (u) => `${u.searchParams.get('start_date')}..${u.searchParams.get('end_date')}`;
// (A window the tree does not know — m12 before Wave 3 — reads as no window, so its check fails
// instead of the suite crashing.)
const want = (k) => { try { const w = resolveRange(k, { tz: TZ }); return `${w.start}..${w.end}`; } catch { return `(no ${k} window)`; } };
const hoursAgo = (h) => new Date(Date.now() - h * 3600e3).toISOString();

// The book: cl_1 → customer 1 (parent of job 4), cl_2 → customer 2; customer 3 is unlinked;
// cl_old links customer 9 on ANOTHER company (realm).
const ENTITIES = {
  customer: [
    { Id: '1', DisplayName: '0001 Ball Harbor Village', Active: true },
    { Id: '2', DisplayName: '0002 Brickell Bay Offices', Active: true },
    { Id: '3', DisplayName: '0003 Unlinked Tower', Active: true },
    { Id: '4', DisplayName: '0004 Ball Harbor Annex', Active: true, ParentRef: { value: '1' } },
  ],
};
const LINKS = () => [
  r.linkRow('cl_1', 'customer', '1', '0001 Ball Harbor Village'),
  r.linkRow('cl_2', 'customer', '2', '0002 Brickell Bay Offices'),
  r.linkRow('cl_old', 'customer', '9', 'Old company', 'realm_OTHER'),
];
const BOOK = () => pnlReport({
  cols: [
    { key: '1', title: '0001 Ball Harbor Village', income: '1000.00', cogs: '600.00' },
    { key: '4', title: '0004 Ball Harbor Annex', income: '200.00', cogs: '100.00' },
    { key: '1', title: 'Total 0001 Ball Harbor Village', income: '1200.00', cogs: '700.00' },
    { key: '2', title: '0002 Brickell Bay Offices', income: '500.00', cogs: '250.00' },
  ],
});
const world = (over = {}) => {
  r.build({ links: LINKS(), entities: ENTITIES, timezone: TZ, ...over });
  r.intuit.pnl = BOOK;
  r.intuit.tokenBody = () => ({ access_token: 'AT_NEW', expires_in: 3600, refresh_token: 'RT_NEW', x_refresh_token_expires_in: 8640000 });
};

// ── A. the gate ─────────────────────────────────────────────────────────────
world();
{
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const unset = await runCron();
  process.env.CRON_SECRET = saved;
  const wrong = await runCron({ authorization: 'Bearer nope' });
  // Fails closed, and names nothing: an unset secret is a 500 (monitoring sees the
  // misconfiguration, CS-215) with cronGate's one fixed body; the gap goes to the server log —
  // test-config-gap-refusals.mjs holds every cron gate to it.
  ok('🔴 CRON_SECRET unset → 500 (fails closed), with the fixed body that names nothing', unset.status === 500
    && !!CRON_UNAVAILABLE && JSON.stringify(unset.body) === JSON.stringify(CRON_UNAVAILABLE)
    && !/CRON_SECRET|config|secret/i.test(JSON.stringify(unset.body)), r.show(unset));
  ok('a wrong secret → 401', wrong.status === 401, r.show(wrong));
  const none = await runCron({});
  ok('no secret → 401', none.status === 401, r.show(none));
  ok('… and none of them asked QuickBooks anything', r.intuitLog.length === 0, `${r.intuitLog.length} Intuit calls`);
}

// ── B. not connected ────────────────────────────────────────────────────────
world({ connected: false });
{
  const res = await runCron();
  ok('not connected → 200, skipped', res.status === 200 && res.body.skipped === 'not_connected', r.show(res));
}

// ── B/C. the happy night ────────────────────────────────────────────────────
world();
{
  const t0 = Date.now();
  const res = await runCron();
  ok('🔴 the nightly run → 200 ok', res.status === 200 && res.body.ok === true, r.show(res));
  const all = r.pnlUrls();
  // The night also reads the twelve months' activity for the "needs matching" list (QB-12): those
  // reports ask for EVERY active customer (3, the unlinked one, included); the dashboard's ask
  // for the linked ones.
  const isActivity = (u) => (u.searchParams.get('customer') || '').split(',').includes('3');
  const urls = all.filter((u) => !isActivity(u));
  const activity = all.filter(isActivity);
  // (On the 1st of a month, this month IS today's window, so "not Today" holds only on other days.)
  ok('🔴 one P&L per nightly window — 10/15/30/60/90 days, 12 months, all-time, this month — and not "Today"',
    urls.length === NIGHTLY.length && NIGHTLY.every((k) => urls.some((u) => windowOf(u) === want(k)))
      && (want('day') === want('mtd') || !urls.some((u) => windowOf(u) === want('day'))),
    urls.map(windowOf).join(' | '));
  ok('🔴 QB-10: the last twelve months are among them', urls.some((u) => windowOf(u) === want('m12')), want('m12'));
  ok('🔴 the dashboard\'s windows ask for the LINKED properties only: ids 1 and 2 plus job 4 under 1 — never 3, never another company\'s 9',
    urls.length > 0 && urls.every((u) => u.searchParams.get('customer') === '1,2,4'), urls.map((u) => u.searchParams.get('customer')).join(' | '));
  ok('the needs-matching activity is read over the twelve months, for this company\'s active customers only (never 9)',
    activity.length >= 1 && activity.every((u) => windowOf(u) === want('m12') && !(u.searchParams.get('customer') || '').split(',').includes('9')), activity.map((u) => `${windowOf(u)} ${u.searchParams.get('customer')}`).join(' | '));
  ok('every request is on the connected company', all.length > 0 && all.every((u) => u.pathname.includes('/company/realm_1/')));
  ok('every request is on the accrual basis (QB-14)', all.length > 0 && all.every((u) => u.searchParams.get('accounting_method') === 'Accrual'));
  const stamp = conn()?.last_synced_at;
  ok('🔴 CS-569: last_synced_at is written', !!stamp && Date.parse(stamp) >= t0 - 1000, String(stamp));
  ok('… and no error is left', conn()?.last_error == null, String(conn()?.last_error));
  ok('every window is cached', pnlRows().length === NIGHTLY.length, `${pnlRows().length} rows`);
  const st = await r.call({ path: 'status', token: 'tok-owner' });
  ok('🔴 CS-569: status shows the last refresh', st.status === 200 && st.body.lastSyncedAt === stamp, r.show(st));
  ok('🔴 CS-569: status names who connected (their team id; Settings shows the name)', st.body.connectedBy === 'u_owner', r.show(st));

  // ── D. the next scheduled run tonight does nothing ──
  r.intuitLog.length = 0;
  const again = await runCron();
  ok('🔴 a second run the same night → 200 "already_refreshed", QuickBooks not asked', again.status === 200 && again.body.skipped === 'already_refreshed' && r.intuitLog.length === 0,
    `${r.show(again)} · ${r.intuitLog.length} calls`);

  // ── E. the dashboard reads the warm numbers ──
  for (const row of r.world.tables.qbo_report_cache) row.fetched_at = hoursAgo(5); // the run was at 3 AM; it is 8 AM
  conn().last_synced_at = hoursAgo(5);
  r.intuitLog.length = 0;
  const d90 = await r.call({ path: 'pnl', token: 'tok-owner', query: { range: 'd90' } });
  const c1 = (d90.body.accounts || []).find((a) => a.clientId === 'cl_1');
  ok('🔴 QB-9: the morning\'s 90-day book is the night\'s snapshot — QuickBooks not asked', d90.status === 200 && r.pnlUrls().length === 0, `${r.pnlUrls().length} P&L calls`);
  ok('  the parent customer carries its job (1,000 + 200)', c1 && c1.incomeCents === 120000, JSON.stringify(c1));
  const today = await r.call({ path: 'pnl', token: 'tok-owner', query: { range: 'day' } });
  ok('"Today" is pulled live (a 3 AM snapshot of today has nothing in it)', today.status === 200 && r.pnlUrls().length === 1, `${r.pnlUrls().length} P&L calls`);
}

// ── F. the cache is bounded at the write point ──────────────────────────────
world({
  cache: [
    { cache_key: 'pnl:v2:sandbox:realm_1:customer:Accrual:d30:2026-01-01:2026-01-30:fold', fetched_at: hoursAgo(24 * 5), payload: {} },
    { cache_key: 'entities:v2:sandbox:realm_1:class', fetched_at: hoursAgo(24 * 5), payload: { entities: [] } },
    { cache_key: 'pnl:v2:sandbox:realm_1:customer:Accrual:day:keep', fetched_at: hoursAgo(1), payload: {} },
  ],
});
{
  const res = await runCron();
  const keys = r.world.tables.qbo_report_cache.map((row) => row.cache_key);
  ok('🔴 CS-566: the nightly run reaps rows past the age ceiling', res.status === 200 && !keys.some((k) => k.endsWith(':fold')) && !keys.includes('entities:v2:sandbox:realm_1:class'), keys.join(' | '));
  ok('… and keeps a recent one', keys.some((k) => k.endsWith(':keep')));
}
world({ cache: [{ cache_key: 'pnl:old', fetched_at: hoursAgo(24 * 4), payload: {} }] });
{
  await r.call({ path: 'pnl', token: 'tok-owner', query: { range: 'd30' } });
  const keys = r.world.tables.qbo_report_cache.map((row) => row.cache_key);
  ok('🔴 CS-566: an ordinary dashboard read that writes a row reaps too (retention at the write point)', !keys.includes('pnl:old'), keys.join(' | '));
}
world({ cache: Array.from({ length: 520 }, (_, i) => ({ cache_key: `pnl:filler:${i}`, fetched_at: new Date(Date.now() - (i + 1) * 60e3).toISOString(), payload: {} })) });
{
  await r.call({ path: 'pnl', token: 'tok-owner', query: { range: 'd30' } });
  const rows = r.world.tables.qbo_report_cache;
  ok('🔴 CS-566: the cache never holds more than its count cap', rows.length <= 500, `${rows.length} rows`);
  ok('… the newest rows are the ones kept', rows.some((row) => row.cache_key.includes(':d30:')) && !rows.some((row) => row.cache_key === 'pnl:filler:519'), `${rows.length} rows`);
}

// ── G. a transient failure is retryable, and the next run fills only the gap ──
world({ cache: [{ cache_key: 'pnl:v2:sandbox:realm_1:customer:Accrual:d90:yesterday', fetched_at: hoursAgo(26), payload: { kept: true } }] });
{
  const d90Start = want('d90').split('..')[0];
  r.intuit.fail = (u) => (u.pathname.endsWith('/reports/ProfitAndLoss') && u.searchParams.get('start_date') === d90Start ? { status: 503 } : null);
  const res = await runCron();
  ok('🔴 CS-574: a QuickBooks hiccup → 503, retryable', res.status === 503 && res.body.retryable === true && res.body.code === 'refresh_incomplete', r.show(res));
  ok('… it says when to come back (Retry-After)', !!res.headers['retry-after'], JSON.stringify(res.headers));
  ok('🔴 … no "Last refresh" stamp for an unfinished night', conn()?.last_synced_at == null, String(conn()?.last_synced_at));
  ok('… the gap is recorded (Settings says so)', conn()?.last_error === 'refresh_incomplete', String(conn()?.last_error));
  ok('… the windows that did answer are cached', pnlRows().filter((row) => row.fetched_at > hoursAgo(1)).length === NIGHTLY.length - 1, `${pnlRows().length} rows`);
  ok('… and yesterday\'s snapshot was not wiped', r.world.tables.qbo_report_cache.some((row) => row.cache_key.endsWith(':yesterday')));
  r.intuit.fail = null;
  r.intuitLog.length = 0;
  const retry = await runCron();
  const urls = r.pnlUrls();
  ok('🔴 the next scheduled run completes the night → 200', retry.status === 200 && retry.body.ok === true, r.show(retry));
  ok('🔴 … asking QuickBooks for the missing window only', urls.length === 1 && windowOf(urls[0]) === want('d90'), urls.map(windowOf).join(' | '));
  ok('… and stamps the refresh', !!conn()?.last_synced_at && conn()?.last_error == null, JSON.stringify({ s: conn()?.last_synced_at, e: conn()?.last_error }));
}

// ── H. a dead authorization is not retryable ────────────────────────────────
world({ conn: { status: 'reauth_required', last_error: 'invalid_grant' } });
{
  const res = await runCron();
  ok('reauth needed → 409, not retryable, QuickBooks not asked', res.status === 409 && res.body.retryable === false && r.intuitLog.length === 0, r.show(res));
}

// ── I. the owner's "Refresh data" ───────────────────────────────────────────
world({ cache: [{ cache_key: 'pnl:v2:sandbox:realm_1:customer:Accrual:d30:x', fetched_at: hoursAgo(1), payload: {} }] });
{
  const t0 = Date.now();
  const res = await r.call({ method: 'POST', path: 'refresh', token: 'tok-owner' });
  ok('🔴 Refresh data re-pulls every window now', res.status === 200 && res.body.ok === true && r.pnlUrls().length === NIGHTLY.length, `${r.show(res)} · ${r.pnlUrls().length} P&L calls`);
  ok('… and stamps the refresh', !!conn()?.last_synced_at && Date.parse(conn().last_synced_at) >= t0 - 1000, String(conn()?.last_synced_at));
  ok('… nothing older than the press is left', !r.world.tables.qbo_report_cache.some((row) => row.cache_key.endsWith(':x')));
  const mgr = await r.call({ method: 'POST', path: 'refresh', token: 'tok-mgr' });
  ok('Refresh data stays owner-only (403 for a manager)', mgr.status === 403, r.show(mgr));
}
world();
{
  r.intuit.fail = (u) => (u.pathname.endsWith('/reports/ProfitAndLoss') ? { status: 503 } : null);
  const res = await r.call({ method: 'POST', path: 'refresh', token: 'tok-owner' });
  ok('a refresh QuickBooks could not answer → 503 + retryable, in words', res.status === 503 && res.body.retryable === true && typeof res.body.error === 'string', r.show(res));
}

// ── J. the route: transient = 503 + retryable (CS-574), a slow QuickBooks = 503, never 504 (CS-572) ──
const EXPIRED = { conn: { access_token_expires_at: new Date(Date.now() - 1000).toISOString() } };
world(EXPIRED);
{
  r.intuit.fail = (u) => (u.origin === 'https://oauth.platform.intuit.com' ? { status: 500 } : null);
  const res = await r.call({ path: 'pnl', token: 'tok-owner', query: { range: 'd30' } });
  ok('🔴 CS-574: a token refresh Intuit could not do → 503 + retryable (was 502)', res.status === 503 && res.body.retryable === true, r.show(res));
}
world(EXPIRED);
{
  r.intuit.tokenBody = () => ({}); // a malformed 200: refresh_failed
  const res = await r.call({ path: 'pnl', token: 'tok-owner', query: { range: 'd30' } });
  ok('🔴 CS-574: refresh_failed → 503 + retryable (was 500)', res.status === 503 && res.body.code === 'refresh_failed' && res.body.retryable === true, r.show(res));
}
world();
{
  r.intuit.fail = (u) => (u.pathname.endsWith('/reports/ProfitAndLoss') ? { throw: 'TimeoutError' } : null);
  const res = await r.call({ path: 'pnl', token: 'tok-owner', query: { range: 'd30' } });
  ok('🔴 CS-572: QuickBooks too slow → 503 "timeout", retryable — not a 504', res.status === 503 && res.body.code === 'timeout' && res.body.retryable === true, r.show(res));
}
world();
{
  r.intuit.fail = (u) => (u.pathname.endsWith('/reports/ProfitAndLoss') ? { status: 502 } : null);
  const res = await r.call({ path: 'pnl', token: 'tok-owner', query: { range: 'd30' } });
  ok('Intuit\'s own 5xx → 503, retryable', res.status === 503 && res.body.retryable === true, r.show(res));
}
{
  let threw = null;
  r.intuitLog.length = 0;
  try {
    await client.fetchProfitAndLoss('AT', { environment: 'sandbox', realmId: 'realm_1', startDate: '2026-01-01', endDate: '2026-01-31', summarizeColumnBy: 'Customers', deadline: Date.now() - 5 });
  } catch (e) { threw = e; }
  ok('🔴 CS-572: a call past its deadline is not started (QboError "timeout")', threw && threw.code === 'timeout' && r.intuitLog.length === 0, threw ? `${threw.code} · ${r.intuitLog.length} calls` : 'no throw');
}

// ── K. the entity list is a complete read ───────────────────────────────────
{
  const many = Array.from({ length: 2345 }, (_, i) => ({ Id: String(i + 1), DisplayName: `Customer ${i + 1}`, Active: i % 3 !== 0 }));
  r.build({ entities: { customer: many } });
  const got = await client.queryEntities('AT', { environment: 'sandbox', realmId: 'realm_1', entityType: 'customer' });
  ok('a 2,345-customer book reads every customer', got.length === 2345 && new Set(got.map((e) => e.id)).size === 2345, `${got.length}`);
  const queries = r.intuitLog.filter((e) => e.url.pathname.endsWith('/query')).map((e) => e.url.searchParams.get('query'));
  ok('🔴 count first, then exactly the three pages that count needs', queries.length === 4 && /count\(\*\)/i.test(queries[0]), queries.join(' | '));
  // A read that comes back short of the count is refused, never served as the whole list.
  r.build({ entities: { customer: many } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    const q = new URL(String(url)).searchParams.get('query') || '';
    if (/count\(\*\)/i.test(q)) return { ...res, json: async () => ({ QueryResponse: { totalCount: 2346 } }) };
    return res;
  };
  let short = null;
  try { await client.queryEntities('AT', { environment: 'sandbox', realmId: 'realm_1', entityType: 'customer' }); } catch (e) { short = e; }
  globalThis.fetch = realFetch;
  ok('🔴 fewer rows than counted → "incomplete_read" (transient), never a silent partial list', short && short.code === 'incomplete_read' && client.TRANSIENT_CODES?.has('incomplete_read'), short ? short.code : 'no throw');
}

finish();
