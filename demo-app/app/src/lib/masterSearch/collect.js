// masterSearch/collect.js — the pure candidate-building engine. Imports only rank.js (also
// import-free) so it is node-testable in isolation; sources.js supplies the real adapters
// (which reference the store selectors and therefore cannot themselves be imported under
// plain node). Given a sources array + state + user + a permission checker, this turns
// allowed slices into rank-ready candidates. It never decides scoping itself — each
// source's `select` does.
import { normalize } from './rank.js';

const DAY_MS = 86400000;
const NO_DEPS = [];

// source object → its cache. Module-level and keyed by the adapter's identity, so adapters
// are never mutated and two adapters can never share a cache (one spread from another, or
// two selecting the same slice array). The maps are weak.
//   lists:   list array → { day, ctx, index, token, built } — the last build of that exact list.
//   records: record object → { day, ctx, index, token, sig, kept, cand } — per record, for a
//            source that declares a `signature`.
//   deps / token: the identities of the other slices the source `reads`, and a token object
//            that is replaced whenever one of them changes (so "did anything it reads change?"
//            is one identity compare per record).
const CACHE = new WeakMap();
const cacheOf = (source) => {
  let c = CACHE.get(source);
  if (!c) { c = { lists: new WeakMap(), records: new WeakMap(), deps: null, token: null }; CACHE.set(source, c); }
  return c;
};
const sameRefs = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
function readsToken(c, source, state) {
  const deps = source.reads ? source.reads.map((k) => state[k]) : NO_DEPS;
  if (!c.deps || !sameRefs(c.deps, deps)) { c.deps = deps; c.token = {}; }
  return c.token;
}

// Labels and keywords are normalized ONCE per distinct short string: a book repeats its
// customer, location, service and status names and its dates thousands of times. Long text
// (a note) is normalized where it stands, never held.
const NORM = new Map();
const NORM_MAX = 20000;
const norm = (s) => {
  if (s.length > 64) return normalize(s);
  let v = NORM.get(s);
  if (v === undefined) {
    v = normalize(s);
    if (NORM.size >= NORM_MAX) NORM.clear();
    NORM.set(s, v);
  }
  return v;
};

// One record's candidate. Label/keywords are normalized HERE, once, so a keystroke never
// re-normalizes the book. `index` fixes the record-type tie-break order (rankBucket 2 + index).
// The word builders get the build's `now` too (a clean's status today reads it).
function buildCandidate(source, rec, state, index, now) {
  const label = String(source.primary(rec, state, now) ?? '');
  const keywords = source.keywords(rec, state, now);
  return {
    id: `${source.type}:${rec.id}`,
    kind: 'record',
    type: source.type,
    typeLabel: source.typeLabel,
    rankBucket: 2 + index,
    group: source.type,
    groupLabel: source.groupLabel,
    groupIcon: source.groupIcon,
    minQueryLen: 2,
    label,
    sublabel: source.sublabel(rec, state, now),
    keywords,
    _l: norm(label),
    _k: keywords.map(norm),
    order: source.order ? source.order(rec, state, now) : 0,
    icon: source.groupIcon,
    to: source.to(rec, state),
    refId: rec.id,
    seeAll: source.seeAll || null,
    seeAllFiltered: !!source.seeAllFiltered,
    seeAllLabel: source.seeAllLabel,
  };
}

// A record's memo entry (CS-674), for a source that declares `signature(rec, state, now)`: a
// string of everything OUTSIDE the record its words read (its customer's name, its status).
// The entry stands while the record object, the day, the display context and the type order
// are the same; when a slice the source `reads` changed (the token moved) the signature is
// re-taken and the entry stands if it still matches. Anything else rebuilds just this record.
// `kept` is the source's `keep(rec, now)` answer for the day.
function recordEntry(source, c, rec, state, index, now, day, ctx, token) {
  let m = c.records.get(rec);
  if (m && m.day === day && m.ctx === ctx && m.index === index) {
    if (m.token === token) return m;
    const sig = source.signature(rec, state, now);
    if (sig === m.sig) { m.token = token; return m; }
  }
  const kept = !source.keep || source.keep(rec, now);
  m = { day, ctx, index, token, sig: source.signature(rec, state, now), kept, cand: kept ? buildCandidate(source, rec, state, index, now) : null };
  c.records.set(rec, m);
  return m;
}

// Build (and cache) the candidates for one source's current list.
//
// THE LIST CACHE: keyed on the exact array the selector returned (non-crew selectors return
// the slice by reference, stable across renders), plus the day (a record's `order`, e.g. a
// clean's distance from today, is date-relative), the source's display `context()` (the
// language and zone its dates are written in) and the other slices it `reads` (a customer
// renamed while the visits stand still must still show).
//
// WHEN IT MISSES (CS-674): every realtime jobs patch and every clock-out replaces the jobs
// array, and every adopted shared record replaces the customers — at 49,883 visits a full
// rebuild was the 7 s freeze, all evening. So a source with a `signature` rebuilds only the
// records that changed (`recordEntry`), and one with `keep(rec, now)` offers only what it
// keeps (the cleans: a bounded window of past visits). A source without a signature
// rebuilds its whole list, as before.
export function candidatesFor(source, list, state, index, now = Date.now()) {
  const c = cacheOf(source);
  const day = Math.floor(now / DAY_MS);
  const ctx = source.context ? source.context() : '';
  const token = readsToken(c, source, state);
  const hit = c.lists.get(list);
  if (hit && hit.day === day && hit.ctx === ctx && hit.index === index && hit.token === token) return hit.built;
  const built = [];
  for (const rec of list) {
    if (source.signature) {
      const m = recordEntry(source, c, rec, state, index, now, day, ctx, token);
      if (m.kept) built.push(m.cand);
    } else if (!source.keep || source.keep(rec, now)) {
      built.push(buildCandidate(source, rec, state, index, now));
    }
  }
  c.lists.set(list, { day, ctx, index, token, built });
  return built;
}

// Every record candidate the user is permitted to search. Gating is per SOURCE; the scoped
// selector inside each allowed source does the per-record work. `opts.isMobile` drops
// desktop-only sources (their destination is a desktop-bound surface). Appended one by one:
// `out.push(...list)` passes every candidate as an argument and throws RangeError ("Maximum
// call stack size exceeded") past ~120,000 of them — a year of visits.
export function collectCandidates(sources, state, user, check, opts = {}) {
  const now = opts.now ?? Date.now();
  const out = [];
  sources.forEach((source, index) => {
    if (!check(source.perm)) return;
    if (source.desktopOnly && opts.isMobile) return;
    const list = source.select(state, user) || [];
    if (!list.length) return;
    for (const cand of candidatesFor(source, list, state, index, now)) out.push(cand);
  });
  return out;
}

// Re-resolve one record recent against LIVE state: the fresh candidate (so a rename shows),
// or null when the record is gone / no longer permitted / out of the user's scope / on a
// desktop-only surface while on mobile — so the recents list drops it. Builds THAT record's
// candidate only (it used to build the whole source's list to find one). A recent the
// source's window no longer `keep`s still resolves: it is something this person opened.
export function resolveFromSources(sources, state, user, check, type, refId, opts = {}) {
  const index = sources.findIndex((s) => s.type === type);
  if (index < 0) return null;
  const source = sources[index];
  if (!check(source.perm)) return null;
  if (source.desktopOnly && opts.isMobile) return null;
  const list = source.select(state, user) || [];
  const rec = list.find((r) => r.id === refId);
  if (!rec) return null;
  const now = opts.now ?? Date.now();
  if (!source.signature) return buildCandidate(source, rec, state, index, now);
  const c = cacheOf(source);
  const m = recordEntry(source, c, rec, state, index, now, Math.floor(now / DAY_MS), source.context ? source.context() : '', readsToken(c, source, state));
  return m.cand || buildCandidate(source, rec, state, index, now);
}
