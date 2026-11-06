// QB-12's "activity in the window": which QuickBooks customers have money on their own P&L
// column in the last twelve months (QB-10's history). Server only (service role); read-only on
// QuickBooks — it asks for reports, it never writes.
//
// One whole-book P&L timed out on Matt's 778-customer company (CS-598), so the window is read a
// CHUNK of customers at a time (src/lib/qboRules.js activityChunks: a customer travels with its
// own jobs), each chunk filtered by id, ACTIVITY_CONCURRENCY at a time inside the caller's
// deadline, and cached like any report (keyed on the window, the basis and the chunk's ids). A
// chunk that could not be read leaves the answer INCOMPLETE — then the list shows every active
// customer rather than guess which were quiet — and the next call or the next night reads only
// the chunks still missing.
import { createHash } from 'node:crypto';
import { getValidAccessToken } from './tokens.js';
import { fetchProfitAndLoss, QBO_REPORT_BASIS, QboError } from './client.js';
import { readReportCache, writeReportCache } from './store.js';
import { parseProfitAndLoss } from './report.js';
import { resolveRange } from './ranges.js';
import { activityChunks } from '../../../src/lib/qboRules.js';

const ACTIVITY_CONCURRENCY = 3;
// The money fields any of which, non-zero, is activity.
const MONEY = ['incomeCents', 'cogsCents', 'expensesCents', 'otherIncomeCents', 'otherExpensesCents'];

export function activityCacheKey({ environment, realmId, start, end, ids }) {
  const digest = createHash('sha256').update(ids.join(',')).digest('hex').slice(0, 16);
  return `activity:v1:${environment}:${realmId}:${QBO_REPORT_BASIS}:${start}:${end}:f${digest}`;
}

// → { ids: Set of customer ids with activity, complete, window: { start, end }, chunks, read,
//     failures: [{ code }] }. `freshAfter` (epoch ms) is the oldest cached chunk still served.
export async function loadCustomerActivity({ environment, realmId, tz, entities, freshAfter, deadline = null, now = new Date() }) {
  const window = resolveRange('m12', { now, tz });
  const chunks = activityChunks(entities);
  const ids = new Set();
  const failures = [];
  let read = 0;
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next]; next += 1;
      try {
        const key = activityCacheKey({ environment, realmId, start: window.start, end: window.end, ids: chunk });
        const cached = await readReportCache(key);
        let active;
        if (cached && Date.parse(cached.fetched_at) >= freshAfter) {
          active = cached.payload?.ids || [];
        } else {
          const token = await getValidAccessToken(environment);
          const raw = await fetchProfitAndLoss(token, {
            environment, realmId, startDate: window.start, endDate: window.end, summarizeColumnBy: 'Customers',
            filter: { param: 'customer', ids: chunk }, deadline,
          });
          const parsed = parseProfitAndLoss(raw);
          active = parsed.entities.filter((e) => MONEY.some((f) => Number.isInteger(e[f]) && e[f] !== 0)).map((e) => e.entityId);
          await writeReportCache(key, { ids: active });
          read += 1;
        }
        for (const id of active) ids.add(String(id));
      } catch (e) {
        failures.push({ code: e instanceof QboError ? e.code : (e?.code || 'error') });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ACTIVITY_CONCURRENCY, chunks.length) }, worker));
  return { ids, complete: failures.length === 0, window, chunks: chunks.length, read, failures };
}
