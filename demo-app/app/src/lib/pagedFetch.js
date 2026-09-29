// Complete paged reads from our own API routes — the client half of the II.7 fetch law
// (the server half is api/_lib/pagedSelect.js). PURE (no browser globals), so the offline
// suite drives it with a fake transport (test-paged-select.mjs).
//
// WHY. The report + payroll feeds used to make ONE request and trust whatever came back.
// The server capped that at a fixed number of rows (newest first), so a month-long report
// or a semi-monthly pay run at full volume silently read a fraction of the punches. A
// single response also can't carry everything at scale (Vercel caps a function response
// at 4.5 MB), so the reads are paged: the first page returns the total, the rest are
// fetched with bounded concurrency and per-page retry, and a short result THROWS
// (IncompleteFetchError) instead of rendering a partial report or pay run as if complete.
//
//   fetchPage(offset, limit) -> Promise<{ rows, total, limit }>
//     total  — read from the offset-0 page
//     limit  — the page size the server actually served (it may clamp what was asked);
//              the page math follows it, so the two sides aren't tied by convention
//
// Pages OVERLAP by `overlap` rows and the last reads past the total, so a row inserted or
// deleted mid-read ahead of a page boundary (an offline replay lands a backdated punch)
// can't shift another row into the gap between two pages; dedupe keeps each row once.

export const PAGE_SIZE = 2000;
export const OVERLAP = 50;
export const CONCURRENCY = 3;
export const RETRIES = 3;
export const MAX_PAGES = 200;

export class IncompleteFetchError extends Error {
  constructor(got, expected) {
    super(`Only ${got} of ${expected} records loaded — the result would be incomplete. Try again.`);
    this.name = 'IncompleteFetchError';
    this.got = got;
    this.expected = expected;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, retries, backoffMs) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      // A 4xx is the server refusing the request (bad range, no permission, too many
      // rows) — retrying cannot change the answer, so surface it at once. 408 (timeout)
      // and 429 (rate limited) are the exceptions: transient, so they retry.
      if (e && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) throw e;
      if (attempt >= retries) throw e;
      await sleep(backoffMs * (attempt + 1));
    }
  }
}

export async function fetchAllPages({
  fetchPage, pageSize = PAGE_SIZE, overlap = OVERLAP, concurrency = CONCURRENCY, retries = RETRIES,
  keyOf = (r) => r.id, maxPages = MAX_PAGES, backoffMs = 400,
} = {}) {
  const pass = async () => {
    const first = await withRetry(() => fetchPage(0, pageSize), retries, backoffMs);
    const total = Number(first && first.total);
    if (!Number.isFinite(total) || total < 0) throw new Error('The server did not report how many records to load.');
    const size = Math.max(1, Math.min(pageSize, Number(first && first.limit) || pageSize));
    const lap = Math.min(overlap, Math.floor(size / 4));
    const step = size - lap;
    // Page starts: 0, step, 2·step … until a page reaches `lap` rows past the total.
    const offsets = [0];
    while (offsets[offsets.length - 1] + size < total + lap) {
      offsets.push(offsets[offsets.length - 1] + step);
      if (offsets.length > maxPages) throw new Error(`This read spans ${total} records — narrow the date range.`);
    }
    const results = new Array(offsets.length);
    results[0] = (first && first.rows) || [];
    let next = 1;
    const worker = async () => {
      for (;;) {
        const i = next;
        if (i >= offsets.length) return;
        next += 1;
        const res = await withRetry(() => fetchPage(offsets[i], size), retries, backoffMs);
        results[i] = (res && res.rows) || [];
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(offsets.length - 1, 0)) }, worker));
    const seen = new Set();
    const rows = [];
    for (const list of results) {
      for (const r of list || []) {
        const k = keyOf(r);
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push(r);
      }
    }
    return { rows, total };
  };
  let res = await pass();
  if (res.rows.length < res.total) res = await pass();
  if (res.rows.length < res.total) throw new IncompleteFetchError(res.rows.length, res.total);
  return res.rows;
}
