// QB-14 — the P&L is ACCRUAL, asked for explicitly (offline).
//
// Matt, 2026-09-30 (meetings/2026-09-30-matt-followup-answers.md): "Should the bonus numbers use
// cash or accrual? (b) Accrual". The P&L request used to OMIT `accounting_method`, so QuickBooks
// answered on the company's own default basis, which an admin can flip in QuickBooks' settings
// without anyone here knowing; the bonus figures would silently change meaning. This pins:
//   1. the client function asks for accounting_method=Accrual, from ONE named constant;
//   2. every P&L the route requests carries it, whatever the range;
//   3. the report cache key carries the basis (THE LAW II.7: a result keyed on its full inputs);
//   4. a payload cached under the pre-accrual key (built on the company default, which may be
//      cash) is never served after the change.
//
//   node scripts/test-qbo-accrual.mjs
import { createHash } from 'node:crypto';
import { rig, counter, pnlReport } from './qbo-harness.mjs';
import { resolveRange } from '../api/_lib/qbo/ranges.js';
import * as client from '../api/_lib/qbo/client.js';

const { ok, finish } = counter('qbo-accrual');
const r = await rig();
const TZ = 'America/New_York';

// ── 1. the client function ──────────────────────────────────────────────────
r.build();
await client.fetchProfitAndLoss('AT', {
  environment: 'sandbox', realmId: 'realm_1', startDate: '2026-09-01', endDate: '2026-09-30', summarizeColumnBy: 'Customers',
});
{
  const u = r.pnlUrls()[0];
  ok('🔴 fetchProfitAndLoss asks QuickBooks for accounting_method=Accrual', u?.searchParams.get('accounting_method') === 'Accrual', u ? u.search : 'no request');
  ok('the basis is ONE named constant, QBO_REPORT_BASIS = "Accrual"', client.QBO_REPORT_BASIS === 'Accrual', String(client.QBO_REPORT_BASIS));
}

// ── 2. every P&L the route asks for, whatever the range ─────────────────────
const ENTITIES = { customer: [{ Id: '1', DisplayName: 'Ball Harbor', Active: true }, { Id: '2', DisplayName: 'Brickell', Active: true }] };
const LINKS = () => [r.linkRow('cl_1', 'customer', '1', 'Ball Harbor'), r.linkRow('cl_2', 'customer', '2', 'Brickell')];
const BOOK = () => pnlReport({
  cols: [{ key: '1', title: 'Ball Harbor', income: '1000.00', cogs: '400.00' }, { key: '2', title: 'Brickell', income: '500.00', cogs: '100.00' }],
});
r.build({ links: LINKS(), entities: ENTITIES });
r.intuit.pnl = BOOK;
for (const range of ['day', 'd30', 'all']) {
  const res = await r.call({ path: 'pnl', token: 'tok-owner', query: { range } });
  ok(`pnl ${range} → 200`, res.status === 200, r.show(res));
}
{
  const urls = r.pnlUrls();
  ok('the route asked QuickBooks for P&Ls', urls.length >= 3, `${urls.length} requests`);
  ok('🔴 EVERY P&L request carries accounting_method=Accrual', urls.length > 0 && urls.every((u) => u.searchParams.get('accounting_method') === 'Accrual'),
    urls.map((u) => u.searchParams.get('accounting_method')).join(','));
}

// ── 3. the cache key carries the basis ──────────────────────────────────────
{
  const keys = r.world.tables.qbo_report_cache.map((row) => row.cache_key).filter((k) => k.startsWith('pnl:'));
  ok('P&L payloads were cached', keys.length > 0, JSON.stringify(keys));
  ok('🔴 every P&L cache key names the basis it was built on', keys.length > 0 && keys.every((k) => /accrual/i.test(k)), JSON.stringify(keys));
}

// ── 4. a payload cached BEFORE the change is never served ───────────────────
// The pre-change key (6e61596c): pnl:v<parse version>:<env>:<realm>:<type>:<range>:<start>:<end>:f<digest of the filter ids>.
// Its payload was built on the company's default basis (here: cash, with a sentinel income).
r.build({ links: LINKS(), entities: ENTITIES });
r.intuit.pnl = BOOK;
{
  const { start, end } = resolveRange('d30', { tz: TZ });
  const digest = createHash('sha256').update('1,2').digest('hex').slice(0, 16);
  r.world.tables.qbo_report_cache.push({
    organization_id: r.world.tables.org_state[0].organization_id,
    cache_key: `pnl:v2:sandbox:realm_1:customer:d30:${start}:${end}:f${digest}`,
    fetched_at: new Date().toISOString(),
    payload: { basis: 'Cash', entities: [{ entityId: '1', entityName: 'Ball Harbor', ancestorIds: [], incomeCents: 999, cogsCents: 0, grossProfitCents: 999 }], unassigned: {}, total: {} },
  });
  const res = await r.call({ path: 'pnl', token: 'tok-owner', query: { range: 'd30' } });
  const c1 = (res.body.accounts || []).find((a) => a.clientId === 'cl_1');
  ok('🔴 a payload cached under the pre-accrual key is never served (the cash sentinel 999 is gone)', c1 && c1.incomeCents === 100000, JSON.stringify(c1));
  ok('… QuickBooks was asked instead', r.pnlUrls().length === 1, `${r.pnlUrls().length} P&L requests`);
  ok('the response says the basis it is on', res.body.basis === 'Accrual', r.show(res));
}

finish();
