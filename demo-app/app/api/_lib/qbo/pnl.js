// QuickBooks P&L and entity lists, through the report cache — the ONE read path shared by the
// dashboard's `pnl` route, the owner's "Refresh data" and the nightly refresh (QB-9). Server
// only (service role). Every Intuit call takes the caller's DEADLINE (CS-572), so a slow
// QuickBooks answers a retryable 'timeout' inside the function's limit instead of a 504.
import { createHash } from 'node:crypto';
import { getValidAccessToken } from './tokens.js';
import { queryEntities, fetchProfitAndLoss, QBO_REPORT_BASIS } from './client.js';
import { readReportCache, writeReportCache } from './store.js';
import { parseProfitAndLoss, PNL_PARSE_VERSION, reportFilterIds, MAX_REPORT_FILTER_IDS } from './report.js';
import { RANGE_KEYS, MONTH_TO_DATE, resolveRange } from './ranges.js';

// QBO dimension → the report's column dimension, and → its filter parameter.
export const SUMMARIZE_BY = Object.freeze({ customer: 'Customers', class: 'Classes', department: 'Departments' });
export const FILTER_PARAM = Object.freeze({ customer: 'customer', class: 'class', department: 'department' });

// ── how long a cached answer is good for ─────────────────────────────────────
// QB-9 (Matt, 2026-09-29: "How fresh should the numbers be? (a) Updated every night"): the
// figures are a NIGHTLY snapshot. The nightly refresh rewrites every window after the org's
// midnight, and a dashboard read serves that snapshot until the next night — 26 h, so a late or
// missed run degrades to an on-demand pull instead of a stale book. 'Today' is the exception: a
// snapshot taken at 2 AM has nothing in it, so it is pulled live, an hour at a time.
export const NIGHTLY_TTL_MS = 26 * 60 * 60 * 1000;
export const LIVE_TTL_MS = 60 * 60 * 1000;
export const pnlTtlMs = (rangeKey) => (rangeKey === 'day' ? LIVE_TTL_MS : NIGHTLY_TTL_MS);
// What the nightly refresh warms: every window but 'day'. Includes 'm12' (QB-10, the last
// twelve months), 'all', and 'mtd' (this month, the dashboard picker's first choice). A past
// month or a span of the caller's own dates is pulled on demand and then cached like the rest.
export const NIGHTLY_RANGE_KEYS = Object.freeze([...RANGE_KEYS.filter((k) => k !== 'day'), MONTH_TO_DATE]);
// The Link dialog's entity list is kept fresher, so a customer added in QuickBooks a minute ago
// can be linked; the P&L filter and the matching list accept the nightly list.
export const ENTITY_TTL_MS = 10 * 60 * 1000;

// One entity list (with parentIds), cached. `maxAgeMs` is how old a cached list may be for THIS
// caller. The key is versioned (v2) because rows carry parentId: a pre-v2 payload has none, and
// the filter would silently drop a linked parent's sub-customers.
export async function loadEntities({ environment, realmId, type, maxAgeMs = ENTITY_TTL_MS, deadline = null }) {
  const key = `entities:v2:${environment}:${realmId}:${type}`;
  const cached = await readReportCache(key);
  if (cached && Date.now() - Date.parse(cached.fetched_at) < maxAgeMs) {
    return { entities: cached.payload.entities, cached: true, fetchedAt: cached.fetched_at };
  }
  const token = await getValidAccessToken(environment);
  const entities = await queryEntities(token, { environment, realmId, entityType: type, deadline });
  await writeReportCache(key, { entities });
  return { entities, cached: false, fetchedAt: new Date().toISOString() };
}

// The cache key of one P&L: the parser's shape version, the company, the dimension, the BASIS
// (QB-14), the window and its dates, and a digest of the filter set (CS-598) — every input the
// payload depends on (THE LAW II.7).
export function pnlCacheKey({ environment, realmId, type, rangeKey, start, end, filterIds }) {
  const fdigest = createHash('sha256').update(filterIds.join(',')).digest('hex').slice(0, 16);
  return `pnl:v${PNL_PARSE_VERSION}:${environment}:${realmId}:${type}:${QBO_REPORT_BASIS}:${rangeKey}:${start}:${end}:f${fdigest}`;
}

// The parsed P&L for one dimension and window, as the caller will attribute it (attributeToLinked).
// QuickBooks is asked for the LINKED entities only (their ids plus every descendant: a whole-book
// summary timed out on a 778-customer company, CS-598); past MAX_REPORT_FILTER_IDS the unfiltered
// report is the fallback. A cached payload is served when it was fetched at or after `freshAfter`
// (epoch ms): the dashboard passes now − pnlTtlMs(range), the nightly run the org's midnight
// (anything fetched since then is tonight's), the owner's refresh `now` (always re-pull).
export async function loadPnl({ environment, realmId, type, rangeKey, tz, linkedIds, entities, freshAfter, deadline = null, now = new Date() }) {
  const { start, end } = resolveRange(rangeKey, { now, tz });
  let filterIds = reportFilterIds(linkedIds, entities);
  if (filterIds.length > MAX_REPORT_FILTER_IDS) filterIds = [];
  const key = pnlCacheKey({ environment, realmId, type, rangeKey, start, end, filterIds });
  const cached = await readReportCache(key);
  if (cached && Date.parse(cached.fetched_at) >= freshAfter) {
    return { parsed: cached.payload, fetchedAt: cached.fetched_at, start, end, cached: true };
  }
  const token = await getValidAccessToken(environment);
  const raw = await fetchProfitAndLoss(token, {
    environment, realmId, startDate: start, endDate: end, summarizeColumnBy: SUMMARIZE_BY[type],
    filter: { param: FILTER_PARAM[type], ids: filterIds }, deadline,
  });
  const parsed = parseProfitAndLoss(raw);
  const fetchedAt = new Date().toISOString();
  await writeReportCache(key, parsed);
  return { parsed, fetchedAt, start, end, cached: false };
}
