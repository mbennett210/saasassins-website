// The dashboards' period picker: this month, a calendar month, or the reader's own dates (offline).
//
// Matt, 2026-10-04: "On the dashboard, I want to have a filter there so I can see the
// performance, for example, from August, from September, from July, or from this month only. I
// want to be able to edit the dates." This pins:
//   1. the grammar (lib/pnlRange.js, shared by the route and the screen): 'mtd', 'YYYY-MM' and
//      'YYYY-MM-DD_YYYY-MM-DD' resolve to org-zone days, never past today, never before all-time;
//      a whole month typed as two dates reads as that month;
//   2. the route answers them and asks QuickBooks for exactly those days; an impossible period
//      is a 400; the nightly refresh warms this month;
//   3. the URL helper keeps a month, this month or a span, and refuses a future or junk one;
//   4. the preview book and the demo stub honour a month's own day count;
//   5. the picker is on the page: the searchable list, the editable dates, catalog lines.
//
//   node scripts/test-qbo-period.mjs
import { readFileSync } from 'node:fs';
import { rig, counter, pnlReport } from './qbo-harness.mjs';
import * as ranges from '../api/_lib/qbo/ranges.js';
import * as preview from '../src/data/dashboardLayoutPreview.js';
import * as view from '../src/lib/qboView.js';
import en from '../src/i18n/catalog/en.js';
import { stubPnlAccounts } from '../src/lib/qboStubData.js';
import { dayKey, addMonthsKey, startOfMonthKey } from '../src/lib/dates.js';

const { ok, finish } = counter('qbo-period');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tryRange = (key, opts) => { try { return ranges.resolveRange(key, opts); } catch { return null; } };
const show = (v) => JSON.stringify(v);
// A helper the pre-fix tree lacks reads as a no-op, so its checks FAIL instead of the suite crashing.
const fn = (mod, name) => (typeof mod[name] === 'function' ? mod[name] : () => undefined);
const spanKey = fn(ranges, 'spanKey');
const rangeDays = fn(ranges, 'rangeDays');

// ── 1. the grammar ──────────────────────────────────────────────────────────
const TZ = 'America/New_York';
const now = new Date('2026-10-04T15:00:00Z'); // 2026-10-04 in New York
const at = { now, tz: TZ };
{
  ok('🔴 this month (mtd): the 1st through today', show(tryRange('mtd', at)) === show({ start: '2026-10-01', end: '2026-10-04' }), show(tryRange('mtd', at)));
  ok('🔴 a past month: its first through its last day', show(tryRange('2026-08', at)) === show({ start: '2026-08-01', end: '2026-08-31' }), show(tryRange('2026-08', at)));
  ok('February in a leap year ends on the 29th', tryRange('2024-02', at)?.end === '2024-02-29', show(tryRange('2024-02', at)));
  ok('the current month as a month ends today, not on the 31st', tryRange('2026-10', at)?.end === '2026-10-04', show(tryRange('2026-10', at)));
  ok('🔴 a month that has not started is refused', tryRange('2026-11', at) === null, show(tryRange('2026-11', at)));
  ok('🔴 a span of the reader\'s dates: exactly those days', show(tryRange('2026-08-03_2026-09-14', at)) === show({ start: '2026-08-03', end: '2026-09-14' }), show(tryRange('2026-08-03_2026-09-14', at)));
  ok('a span running past today ends today', tryRange('2026-09-20_2026-12-31', at)?.end === '2026-10-04', show(tryRange('2026-09-20_2026-12-31', at)));
  ok('a one-day span is that day', show(tryRange('2026-09-01_2026-09-01', at)) === show({ start: '2026-09-01', end: '2026-09-01' }));
  ok('a span that ends before it starts is refused', tryRange('2026-09-14_2026-08-03', at) === null);
  ok('a span starting after today is refused', tryRange('2026-10-05_2026-10-09', at) === null);
  ok('a span starting before all-time is refused', tryRange('1999-12-01_2000-01-31', at) === null);
  ok('an impossible date is refused (Feb 30)', tryRange('2026-02-30_2026-03-02', at) === null);
  ok('junk is refused', ['2026-13', '2026-8', 'august', '2026-08-01', '2026-08-01..2026-08-31', ''].every((k) => tryRange(k, at) === null));
  ok('the org\'s day, not UTC: 2026-11-01T02:00Z is still October in New York, so November has not started',
    tryRange('2026-11', { now: new Date('2026-11-01T02:00:00Z'), tz: TZ }) === null);
  ok('🔴 a whole month picked as two dates reads as that month', spanKey('2026-08-01', '2026-08-31') === '2026-08'
    && spanKey('2026-08-01', '2026-08-30') === '2026-08-01_2026-08-30' && spanKey('2026-08-02', '2026-08-31') === '2026-08-02_2026-08-31');
}

// ── 2. the route ────────────────────────────────────────────────────────────
const r = await rig();
r.build({ links: [r.linkRow('cl_1', 'customer', '1', 'Ball Harbor')], entities: { customer: [{ Id: '1', DisplayName: 'Ball Harbor', Active: true }] } });
r.intuit.pnl = () => pnlReport({ cols: [{ key: '1', title: 'Ball Harbor', income: '1000.00', cogs: '400.00' }] });
// The route reads the real clock, so the periods are built off today in the org's zone.
const today = dayKey(new Date(), TZ);
const lastMonth = addMonthsKey(startOfMonthKey(today), -1).slice(0, 7);
const span = `${addMonthsKey(startOfMonthKey(today), -2)}_${today}`;
for (const key of ['mtd', lastMonth, span]) {
  const res = await r.call({ path: 'pnl', token: 'tok-owner', query: { range: key } });
  const want = tryRange(key, { tz: TZ });
  ok(`🔴 pnl?range=${key} → 200 on the resolved period`, res.status === 200 && want && res.body.start === want.start && res.body.end === want.end && res.body.range === key, r.show(res));
  const u = r.pnlUrls().at(-1);
  ok(`  QuickBooks was asked for those days (${key})`, u && want && u.searchParams.get('start_date') === want.start && u.searchParams.get('end_date') === want.end, u ? u.search : 'no request');
}
const nextMonth = addMonthsKey(startOfMonthKey(today), 1).slice(0, 7);
for (const bad of [nextMonth, `${today}_${addMonthsKey(today, -1)}`, '2026-13', 'd45']) {
  const res = await r.call({ path: 'pnl', token: 'tok-owner', query: { range: bad } });
  ok(`an impossible period is refused: ${bad} → 400`, res.status === 400, r.show(res));
}
{
  const { NIGHTLY_RANGE_KEYS } = await import('../api/_lib/qbo/pnl.js');
  ok('🔴 the nightly refresh warms this month', NIGHTLY_RANGE_KEYS.includes('mtd'), show(NIGHTLY_RANGE_KEYS));
}

// ── 3. the URL helper ───────────────────────────────────────────────────────
{
  const pick = (raw) => view.windowFromParam(raw, at);
  ok('🔴 windowFromParam keeps this month, a month and a span', pick('mtd') === 'mtd' && pick('2026-08') === '2026-08' && pick('2026-08-03_2026-09-14') === '2026-08-03_2026-09-14');
  ok('windowFromParam still keeps the rolling windows', pick('d60') === 'd60' && pick('m12') === 'm12');
  ok('windowFromParam: a future month, an inverted span or junk → 30 days', pick('2026-11') === 'd30' && pick('2026-09-14_2026-08-03') === 'd30' && pick('nope') === 'd30');
  ok('windowFromParam: a bar-only range still → 30 days', pick('day') === 'd30' && pick('all') === 'd30');
}

// ── 4. the preview book and the demo stub ───────────────────────────────────
{
  const a0 = preview.PREVIEW_ACCOUNTS[0];
  const book = view.buildPreviewBook(lastMonth);
  const days = Number(rangeDays(lastMonth));
  ok('🔴 the preview book honours a month\'s own day count', book.range === lastMonth && book.accounts[0].revenueCents === Math.round(a0.daily * days * 100), `${book.accounts[0].revenueCents} for ${days} days`);
  ok('the preview book carries its dates (for the label)', book.start === `${lastMonth}-01` && book.end === tryRange(lastMonth, {})?.end, `${book.start}..${book.end}`);
  const one = stubPnlAccounts([{ clientId: 'cl_a', entityType: 'customer', entityId: '1001', entityName: 'A' }], 'd30')[0].incomeCents;
  const month = stubPnlAccounts([{ clientId: 'cl_a', entityType: 'customer', entityId: '1001', entityName: 'A' }], lastMonth)[0].incomeCents;
  ok('the demo stub scales a month by its own days', month === Math.round((one / 30) * days), `${month} vs ${one}/30×${days}`);
}

// ── 5. the picker is on the page ────────────────────────────────────────────
{
  const dash = read('../src/pages/AccountDashboard.jsx');
  ok('🔴 the dashboard\'s period is a searchable FilterSelect list', /<FilterSelect[^>]*value=\{value\}/.test(dash), 'no FilterSelect');
  ok('🔴 the period\'s first and last day are editable date fields', (dash.match(/type="date"/g) || []).length === 2, 'no date fields');
  ok('the list offers this month, the windows and the recent months', /MONTH_TO_DATE/.test(dash) && /WINDOWS\.map\(/.test(dash) && /recentMonths\(\)/.test(dash), 'missing choices');
  ok('two typed dates become a span through spanKey', /spanKey\(start, end\)/.test(dash), 'not spanKey');
  ok('the old segmented toggle is gone (replace means delete)', !/acct-dash-window/.test(dash) && !/acct-dash-window/.test(read('../src/index.css')));
  ok('every new line is in the catalog', ['acctDash.range.mtd', 'acctDash.period.custom', 'acctDash.period.from', 'acctDash.period.to'].every((k) => typeof en[k] === 'string'));
  const pnlRange = await import('../src/lib/pnlRange.js').catch(() => ({}));
  const months = fn(pnlRange, 'recentMonths')(12, at) || [];
  ok('the month list is the twelve months before this one, newest first', months.length === 12 && months[0] === '2026-09' && months[11] === '2025-10', show(months));
}

finish();
