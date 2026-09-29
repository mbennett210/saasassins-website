// Complete reads of a relational table — count-first, bounded concurrency, per-page
// retry, deterministic order (playbook II.7 "Fetch strategy"). PURE: it never imports
// the Supabase client. Callers pass closures built on their OWN query, so the count and
// every page carry identical filters, and the offline suite can drive it against a
// PostgREST stand-in (test-paged-select.mjs).
//
// WHY. The report and payroll feeds used to read `.order(col, desc).limit(N)` — the
// newest N rows and silently nothing else (a month of checklists at ~750 sites came back
// as the newest 200). And PostgREST's db-max-rows (1000 on Supabase unless changed) caps
// EVERY response below whatever `.limit()` or `.range()` asked for, so even a generous
// limit truncates — and a `truncated = rows.length >= LIMIT` check then never fires. Two
// rules close both holes:
//   · rangeFill() fills a requested range in <= CHUNK slices until it has every row it
//     asked for or the table runs out, so a page means what it says at ANY max-rows.
//   · selectAll() fails LOUDLY (IncompleteReadError) when the assembled set comes up
//     short of the count; a report or a pay run must never render a partial read as data.
//
// The `page(from, to)` closure MUST order deterministically — `.order(<sort col>)` then
// `.order('id')` before `.range()` (lint:paging fails the build otherwise) — or page
// membership is left to the planner and rows can skip or repeat across boundaries.

export const CHUNK = 1000;          // <= Supabase's default db-max-rows
export const DEFAULT_PAGE = 1000;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_RETRIES = 3;
export const DEFAULT_MAX_ROWS = 250000;

export class IncompleteReadError extends Error {
  constructor(got, expected) {
    super(`Read ${got} of ${expected} rows — the result is incomplete. Try again.`);
    this.name = 'IncompleteReadError';
    this.got = got;
    this.expected = expected;
  }
}

export class TooManyRowsError extends Error {
  constructor(total, maxRows) {
    super(`This read spans ${total} rows (limit ${maxRows}). Narrow the date range.`);
    this.name = 'TooManyRowsError';
    this.total = total;
    this.maxRows = maxRows;
    this.status = 413;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A count read must come back as a number. A missing count is NOT zero: read as zero it
// turns an unreadable count into an empty window — for job coverage, every clean looks
// unclocked. Throwing sends it through the retry and, failing that, to a loud error.
export function exactCount(count) {
  if (!Number.isFinite(count)) throw new Error('The row count came back empty, so the read cannot be checked for completeness.');
  return count;
}

// Run fn(), retrying a throw up to `retries` more times with a short linear backoff.
export async function withRetry(fn, retries = DEFAULT_RETRIES, backoffMs = 300) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(backoffMs * (attempt + 1));
    }
  }
}

// Every row in [from, to] (inclusive offsets), fetched in <= chunk slices. A slice that
// comes back short (max-rows below the slice) just continues from where it stopped; an
// empty slice — or one holding only rows already read — means the table ran out.
// Slices after the first start SLICE_OVERLAP rows early, deduped by key: a row deleted
// between two slices slides every later row back one place, and the row that slid across
// the seam was skipped with nothing to show for it (the churn selectAll's page overlap
// absorbs, one level down: a 2000-row API page is two or three slices). Rows without a
// key (keyOf gives null) can't be deduped, so they are read without the overlap. With
// nothing moving it returns exactly the range asked for; under churn it may run a row or
// two past `to`, which the caller's page overlap dedupes.
export const SLICE_OVERLAP = 25;
export async function rangeFill(page, from, to, { chunk = CHUNK, overlap = SLICE_OVERLAP, keyOf = (r) => r.id } = {}) {
  const out = [];
  const seen = new Set();
  let keyed = null;   // decided on the first row
  let a = from;       // the first offset not yet read
  let lastGot = 0;
  while (a <= to) {
    const lap = keyed && lastGot ? Math.min(overlap, Math.floor(lastGot / 4)) : 0;
    const start = a - lap;
    const b = Math.min(start + chunk - 1, to);
    const rows = await page(start, b);
    if (!Array.isArray(rows) || rows.length === 0) break;
    const take = rows.length > b - start + 1 ? rows.slice(0, b - start + 1) : rows;
    if (keyed === null) keyed = keyOf(take[0]) != null;
    for (const r of take) {
      if (keyed) {
        const k = keyOf(r);
        if (seen.has(k)) continue;
        seen.add(k);
      }
      out.push(r);
    }
    if (start + take.length <= a) break; // only rows already read came back — the end
    a = start + take.length;
    lastGot = take.length;
  }
  return out;
}

// Every row matching the caller's filter.
//   count()        -> Promise<number>  exact count, SAME filters as page()
//   page(from, to) -> Promise<rows[]>  the filtered query, deterministically ordered, .range(from, to)
// Pages OVERLAP by `overlap` rows and the last one reads `overlap` rows past the count:
// a row inserted or deleted mid-read ahead of a boundary shifts everything after it by
// one, and with concurrent pages that shift can push a row off one page before the next
// page is read — with no overlap the set stays the right SIZE with one row silently
// swapped for another (the review's probe: 2,500 rows, one backdated insert, the last
// row gone and nothing raised). Overlap absorbs up to `overlap` rows of churn per read;
// dedupe by key keeps each row once. A set still short of the count gets one fresh pass
// and then an IncompleteReadError — never a silently partial result. Rows written after
// the count may or may not land in this read; the next read has them.
export const DEFAULT_OVERLAP = 50;
export async function selectAll({
  count, page,
  pageSize = DEFAULT_PAGE, concurrency = DEFAULT_CONCURRENCY, retries = DEFAULT_RETRIES,
  maxRows = DEFAULT_MAX_ROWS, keyOf = (r) => r.id, chunk = CHUNK, overlap = DEFAULT_OVERLAP,
} = {}) {
  const pass = async () => {
    const total = await withRetry(count, retries);
    if (!Number.isFinite(total) || total < 0) throw new Error('Could not count the rows to read.');
    if (total > maxRows) throw new TooManyRowsError(total, maxRows);
    const pages = total === 0 ? 0 : Math.ceil(total / pageSize);
    const results = new Array(pages);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next;
        if (i >= pages) return;
        next += 1;
        const from = Math.max(0, i * pageSize - overlap);
        const to = i === pages - 1 ? total - 1 + overlap : (i + 1) * pageSize - 1;
        results[i] = await withRetry(() => rangeFill(page, from, to, { chunk, keyOf }), retries);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, pages) }, worker));
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
  if (res.rows.length < res.total) throw new IncompleteReadError(res.rows.length, res.total);
  return res.rows;
}

// The HTTP status a route should answer for a read error: a too-wide read is the
// caller's to narrow (413); an incomplete read is transient — retry (503); anything
// else is a server error.
export function readErrorStatus(e) {
  if (e && e.name === 'TooManyRowsError') return 413;
  if (e && e.name === 'IncompleteReadError') return 503;
  return 500;
}
