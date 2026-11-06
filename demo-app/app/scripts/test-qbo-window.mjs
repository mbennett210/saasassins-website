// The dashboards' window toggle: 30 / 60 / 90 days and 12 months (offline).
//
// S111 ② named the 30/60/90-day toggle as the next step once a longer window no longer asked
// QuickBooks to summarize the whole book (CS-598); QB-10 (Matt, 2026-09-29: "How much history
// should load when we connect? (a) The last 12 months") makes 12 months a window the owner and
// manager homes can show. This pins:
//   1. the server windows: d60 / d90 / m12 resolve to org-zone calendar days (m12 = the twelve
//      calendar months ending today, leap days included);
//   2. RANGE_KEYS is exactly the drill-in bars (RANGES) plus the toggle (WINDOWS), in one list;
//   3. the route answers the new windows and still refuses an unknown one;
//   4. the preview book honours a window, and the toggle's choice reads from the URL through one
//      helper (an unknown value falls back to 30 days);
//   5. every window's label is a catalog line (UI_RULES §140);
//   6. the demo stub stays monotonic across every window (a longer window is never less revenue).
//
//   node scripts/test-qbo-window.mjs
import { readFileSync } from 'node:fs';
import { rig, counter, pnlReport } from './qbo-harness.mjs';
import * as ranges from '../api/_lib/qbo/ranges.js';
import * as preview from '../src/data/dashboardLayoutPreview.js';
import * as view from '../src/lib/qboView.js';
import en from '../src/i18n/catalog/en.js';
import { stubPnlAccounts } from '../src/lib/qboStubData.js';
import { dayKey, addDaysKey, diffDaysKey } from '../src/lib/dates.js';

const { ok, finish } = counter('qbo-window');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const tryRange = (key, opts) => { try { return ranges.resolveRange(key, opts); } catch { return null; } };

// ── 1. the server windows ───────────────────────────────────────────────────
const TZ = 'America/Los_Angeles';
const now1 = new Date('2026-06-15T02:00:00Z'); // still 2026-06-14 in Los Angeles
const today1 = dayKey(now1, TZ);
{
  const d60 = tryRange('d60', { now: now1, tz: TZ });
  ok('🔴 d60 resolves: 60 calendar days ending today (org zone)', d60 && d60.end === today1 && d60.start === addDaysKey(today1, -59), JSON.stringify(d60));
  const d90 = tryRange('d90', { now: now1, tz: TZ });
  ok('🔴 d90 resolves: 90 calendar days ending today', d90 && d90.end === today1 && diffDaysKey(d90.start, d90.end) === 89, JSON.stringify(d90));
  const m12 = tryRange('m12', { now: now1, tz: TZ });
  ok('🔴 m12 resolves: the twelve calendar months ending today (2025-06-15 … 2026-06-14)', m12 && m12.start === '2025-06-15' && m12.end === '2026-06-14', JSON.stringify(m12));
  const leap = tryRange('m12', { now: new Date('2024-02-29T18:00:00Z'), tz: TZ });
  ok('m12 on a leap day: 2023-03-01 … 2024-02-29 (no Feb 30)', leap && leap.start === '2023-03-01' && leap.end === '2024-02-29', JSON.stringify(leap));
  const nyEdge = tryRange('d90', { now: new Date('2026-10-04T03:30:00Z'), tz: 'America/New_York' });
  ok('a window ends on the ORG\'s day, not the server\'s UTC day', nyEdge && nyEdge.end === '2026-10-03', JSON.stringify(nyEdge));
}

// ── 2. one list of keys: the bars plus the toggle ───────────────────────────
{
  const WINDOWS = preview.WINDOWS || [];
  ok('🔴 the toggle\'s windows are 30, 60, 90 days and 12 months', WINDOWS.map((w) => w.key).join(',') === 'd30,d60,d90,m12', JSON.stringify(WINDOWS));
  ok('the default window is 30 days', preview.DEFAULT_WINDOW === 'd30', String(preview.DEFAULT_WINDOW));
  const union = [...new Set([...preview.RANGES.map((r) => r.key), ...WINDOWS.map((w) => w.key)])];
  ok('🔴 RANGE_KEYS is exactly the drill-in bars plus the toggle', [...ranges.RANGE_KEYS].sort().join(',') === union.sort().join(','), `${ranges.RANGE_KEYS.join(',')} vs ${union.join(',')}`);
  const order = ranges.RANGE_KEYS.map((k) => { const w = tryRange(k, { now: now1, tz: TZ }); return w ? diffDaysKey(w.start, w.end) : NaN; });
  ok('RANGE_KEYS run shortest to longest', order.every((d, i) => i === 0 || d >= order[i - 1]), order.join(','));
}

// ── 3. the route answers the new windows ────────────────────────────────────
const r = await rig();
r.build({ links: [r.linkRow('cl_1', 'customer', '1', 'Ball Harbor')], entities: { customer: [{ Id: '1', DisplayName: 'Ball Harbor', Active: true }] } });
r.intuit.pnl = () => pnlReport({ cols: [{ key: '1', title: 'Ball Harbor', income: '1000.00', cogs: '400.00' }] });
for (const key of ['d60', 'd90', 'm12']) {
  const res = await r.call({ path: 'pnl', token: 'tok-owner', query: { range: key } });
  const want = tryRange(key, { tz: 'America/New_York' });
  ok(`🔴 pnl?range=${key} → 200 on the resolved window`, res.status === 200 && want && res.body.start === want.start && res.body.end === want.end, r.show(res));
  const u = r.pnlUrls().at(-1);
  ok(`  QuickBooks was asked for that window (${key})`, u && want && u.searchParams.get('start_date') === want.start && u.searchParams.get('end_date') === want.end, u ? u.search : 'no request');
}
ok('an unknown window is still refused (400)', (await r.call({ path: 'pnl', token: 'tok-owner', query: { range: 'd45' } })).status === 400);

// ── 4. the preview book and the URL helper ──────────────────────────────────
{
  const book = view.buildPreviewBook('d90');
  const a0 = preview.PREVIEW_ACCOUNTS[0];
  ok('🔴 the preview book honours a 90-day window', book.range === 'd90' && book.accounts[0].revenueCents === Math.round(a0.daily * 90 * 100), `${book.accounts[0].revenueCents}`);
  const m12 = view.buildPreviewBook('m12');
  ok('the preview book honours 12 months (365 days of the fixture\'s daily revenue)', m12.accounts[0].revenueCents === Math.round(a0.daily * 365 * 100), `${m12.accounts[0].revenueCents}`);
  const pick = typeof view.windowFromParam === 'function' ? view.windowFromParam : () => undefined;
  ok('🔴 windowFromParam reads a valid window from the URL', pick('d60') === 'd60' && pick('m12') === 'm12');
  ok('windowFromParam: missing → 30 days', pick(null) === 'd30' && pick('') === 'd30');
  ok('windowFromParam: a bar range or junk → 30 days (only the toggle\'s windows)', pick('day') === 'd30' && pick('all') === 'd30' && pick('d45') === 'd30');
  const dash = read('../src/pages/AccountDashboard.jsx');
  ok('AccountDashboard keeps the window in the URL through windowFromParam', /windowFromParam\(/.test(dash) && /useSearchParams/.test(dash), 'not wired');
  ok('AccountDashboard renders one button per WINDOWS entry', /WINDOWS\.map\(/.test(dash), 'no toggle');
  ok('useQboBook takes the chosen window', /useQboBook\(\{\s*window/.test(dash), 'not passed');
}

// ── 5. every window label is a catalog line ─────────────────────────────────
{
  const WINDOWS = preview.WINDOWS || [];
  ok('🔴 each window names a catalog key', WINDOWS.length === 4 && WINDOWS.every((w) => typeof w.labelKey === 'string' && typeof en[w.labelKey] === 'string'),
    JSON.stringify(WINDOWS.map((w) => [w.key, w.labelKey, en[w.labelKey]])));
}

// ── 6. the demo stub stays monotonic over every window ──────────────────────
{
  const links = [{ clientId: 'cl_a', entityType: 'customer', entityId: '1001', entityName: 'A' }, { clientId: 'cl_seed_evergreen', entityType: 'customer', entityId: '1002', entityName: 'B' }];
  for (const l of links) {
    const by = ranges.RANGE_KEYS.map((k) => stubPnlAccounts([l], k)[0]?.incomeCents);
    ok(`🔴 stub revenue never shrinks as the window grows (${l.clientId})`, by.every((v, i) => Number.isInteger(v) && (i === 0 || v >= by[i - 1])), `${ranges.RANGE_KEYS.join(',')} = ${by.join(',')}`);
  }
}

finish();
