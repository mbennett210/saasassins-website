// The QuickBooks REFRESH: pull every window of the linked properties' P&L into the report cache,
// so the owner and manager dashboards read warm numbers (QB-9, Matt 2026-09-29: "Updated every
// night"), including the last twelve months (QB-10). Run by the nightly cron
// (api/cron/qbo-refresh.js) and by the owner's "Refresh data" (POST /api/quickbooks/refresh).
//
//   · ONLY THE LINKED PROPERTIES: one P&L per window for the company's one dimension (CS-565),
//     filtered to the linked ids and their descendants (CS-598) — never the whole book.
//   · BOUNDED: CONCURRENCY calls at a time (Intuit allows 10 per company), each inside the
//     caller's DEADLINE (CS-572), a transient failure retried once.
//   · RESUMABLE: in a nightly run a window already fetched since the org's midnight is kept, so
//     a run that did not finish leaves only its gaps to the next scheduled one (CS-574).
//   · STAMPED: `qbo_connection.last_synced_at` is written only when EVERY window is in (CS-569:
//     it was never written, so Settings' "Last refresh" never showed); an unfinished run records
//     `last_error = 'refresh_incomplete'` and keeps the previous snapshot rows.
//   · REAPED: the report cache's age + count ceilings, at the end (CS-566).
import { getConnectionForEnv, listLinks, patchConnection, reapReportCache } from './store.js';
import { readOrgState } from '../orgState.js';
import { realmDimension } from './report.js';
import { loadEntities, loadPnl, NIGHTLY_RANGE_KEYS } from './pnl.js';
import { loadCustomerActivity } from './matching.js';
import { QboError, TRANSIENT_CODES, isTransient } from './client.js';
import { dayKey, startOfDayKey } from '../../../src/lib/dates.js';

const CONCURRENCY = 4;
const RETRY_DELAY_MS = 1500;
// The `last_error` an unfinished refresh leaves; Settings says it in words.
export const REFRESH_INCOMPLETE = 'refresh_incomplete';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = (e) => (e instanceof QboError ? e.code : (e?.code || 'error'));

// The org's midnight today, as epoch ms (THE LAW II.8: the org's day, never the cron's UTC day).
export function orgDayStartMs(now, tz) {
  return startOfDayKey(dayKey(now, tz), tz).getTime();
}

// Was the last COMPLETE refresh today, in the org's zone?
export function refreshedToday(conn, now, tz) {
  return !!conn?.last_synced_at && !conn.last_error && dayKey(conn.last_synced_at, tz) === dayKey(now, tz);
}

async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i]; i += 1; await fn(item); }
  }));
}

// One retry for a transient failure, when the deadline leaves room for it.
async function withRetry(fn, deadline) {
  try {
    return await fn();
  } catch (e) {
    if (!isTransient(e) || (deadline && Date.now() + RETRY_DELAY_MS + 2000 > deadline)) throw e;
    await sleep(RETRY_DELAY_MS);
    return fn();
  }
}

// mode 'nightly' keeps what was fetched since the org's midnight; 'manual' (the owner's button,
// after a purge) re-pulls everything. `includeActivity` (nightly by default) also reads the
// twelve months' customer activity the "needs matching" list uses (QB-12) — the button leaves it
// to the list itself, to stay quick. Returns a summary: { ok, retryable, warmed, windows,
// dimension, linked, activity, failures: [{ step, code }], reaped, lastSyncedAt } — codes only,
// never provider text or token material. `conn` / `tz` may be passed by a caller that already
// read them.
export async function refreshBook({
  environment, mode = 'nightly', now = new Date(), deadline = null, conn: connIn = null, tz: tzIn,
  includeActivity = mode === 'nightly',
} = {}) {
  const conn = connIn || await getConnectionForEnv(environment);
  if (!conn) return { ok: true, skipped: 'not_connected', failures: [] };
  if (conn.status === 'reauth_required') return { ok: false, retryable: false, code: 'reauth_required', failures: [] };
  let tz = tzIn;
  if (tz === undefined) {
    const { state } = await readOrgState();
    tz = state?.company?.timezone;
  }
  const realmId = conn.realm_id;
  const realmLinks = (await listLinks()).filter((l) => l.realm_id === realmId);
  const dimension = realmDimension(realmLinks);
  const linkedIds = realmLinks.filter((l) => l.entity_type === dimension).map((l) => l.entity_id);
  const freshAfter = mode === 'manual' ? now.getTime() : orgDayStartMs(now, tz);
  const failures = [];
  let warmed = 0;

  // 1. the dimension's entity list (the P&L filter needs every descendant of a linked parent).
  let entities = null;
  if (dimension) {
    try {
      const got = await withRetry(() => loadEntities({
        environment, realmId, type: dimension, maxAgeMs: Math.max(0, now.getTime() - freshAfter), deadline,
      }), deadline);
      entities = got.entities;
    } catch (e) {
      failures.push({ step: `entities:${dimension}`, code: codeOf(e) });
    }
  }

  // 2. every window, a few at a time.
  if (dimension && entities && linkedIds.length) {
    await mapLimit(NIGHTLY_RANGE_KEYS, CONCURRENCY, async (rangeKey) => {
      try {
        await withRetry(() => loadPnl({ environment, realmId, type: dimension, rangeKey, tz, linkedIds, entities, freshAfter, deadline, now }), deadline);
        warmed += 1;
      } catch (e) {
        failures.push({ step: `pnl:${rangeKey}`, code: codeOf(e) });
      }
    });
  }

  // 3. the "needs matching" list's activity (QB-12): every active customer's last twelve months,
  //    a chunk at a time, after the dashboard's windows (they matter more if time runs short).
  let activity = null;
  if (includeActivity) {
    try {
      const customers = dimension === 'customer' && entities
        ? entities
        : (await withRetry(() => loadEntities({ environment, realmId, type: 'customer', maxAgeMs: Math.max(0, now.getTime() - freshAfter), deadline }), deadline)).entities;
      const got = await loadCustomerActivity({ environment, realmId, tz, entities: customers, freshAfter, deadline, now });
      activity = { chunks: got.chunks, read: got.read, complete: got.complete };
      for (const f of got.failures) failures.push({ step: 'activity', code: f.code });
    } catch (e) {
      failures.push({ step: 'activity', code: codeOf(e) });
    }
  }

  // 4. stamp (complete) or record the gap (incomplete); then reap.
  const complete = failures.length === 0;
  try {
    await patchConnection(complete ? { last_synced_at: now.toISOString(), last_error: null } : { last_error: REFRESH_INCOMPLETE });
  } catch (e) {
    failures.push({ step: 'stamp', code: codeOf(e) });
  }
  const reaped = await reapReportCache();
  const ok = failures.length === 0;
  return {
    ok,
    retryable: !ok && failures.every((f) => TRANSIENT_CODES.has(f.code) || f.code === 'store_error'),
    warmed,
    windows: dimension && linkedIds.length ? NIGHTLY_RANGE_KEYS.length : 0,
    dimension,
    linked: linkedIds.length,
    activity,
    failures,
    reaped,
    lastSyncedAt: ok ? now.toISOString() : (conn.last_synced_at || null),
  };
}
