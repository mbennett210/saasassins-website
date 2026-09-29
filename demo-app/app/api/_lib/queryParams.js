// Query-string parsing shared by the read routes (time, qc). Malformed input becomes a
// 400 at the route, never a raw Postgres error wrapped in a 500, and never a filter that
// silently widens or narrows a read.

// An ISO-8601 timestamp param: null = absent, undefined = malformed (answer 400). A full
// date-time with its zone, as toISOString() writes it, on a real calendar day. Date.parse
// alone let `1` and `Jan 1 2026 (x)` through (and rolls Feb 31 into March), and PostgREST
// then failed the query with a 500 instead of this route answering 400.
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/;
export function isoParam(v) {
  if (v == null || v === '') return null;
  const s = Array.isArray(v) ? v[0] : String(v);
  const m = ISO_RE.exec(s);
  if (!m || Number.isNaN(Date.parse(s))) return undefined;
  const [y, mo, d, h, mi, sec = 0] = m.slice(1).map((x) => (x == null ? undefined : Number(x)));
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59 || sec > 59) return undefined;
  return s;
}

// A comma-separated id list. A repeated key arrives as an array — join it rather than
// silently dropping the filter (which would WIDEN the result org-wide). Ids are held to
// the id alphabet so a stray quote/paren never reaches PostgREST's in.() / or() parser.
export const ID_RE = /^[A-Za-z0-9_\-:.]{1,64}$/;
export function idList(v) {
  const raw = Array.isArray(v) ? v.join(',') : (typeof v === 'string' ? v : '');
  return raw.split(',').map((s) => s.trim()).filter((s) => ID_RE.test(s));
}

// A comma-separated id FILTER: null = absent (no constraint), undefined = malformed (answer
// 400) — any id outside the alphabet, or more than `max` of them. Unlike idList, which drops
// a bad id, a filter must not quietly lose one: with every id dropped nothing constrains the
// read, and it widens org-wide.
export function idListParam(v, max = Infinity) {
  const vals = listValues(v);
  if (!vals.length) return null;
  return vals.length <= max && vals.every((s) => ID_RE.test(s)) ? vals : undefined;
}

// A comma-separated list from a fixed vocabulary (a Set): null = absent, undefined = any
// value outside it (answer 400).
export function enumListParam(v, allowed) {
  const vals = listValues(v);
  if (!vals.length) return null;
  return vals.every((s) => allowed.has(s)) ? vals : undefined;
}

// The distinct values of a list param. A repeated key arrives as an array: join it.
function listValues(v) {
  const raw = Array.isArray(v) ? v.join(',') : (v == null ? '' : String(v));
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

// One id: null = absent, undefined = malformed (answer 400).
export function idParam(v) {
  if (v == null || v === '') return null;
  const s = Array.isArray(v) ? v[0] : String(v);
  return ID_RE.test(s) ? s : undefined;
}

// A bounded integer (offset / limit) — anything malformed falls back.
export function intParam(v, fallback, min, max) {
  const n = parseInt(Array.isArray(v) ? v[0] : v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
