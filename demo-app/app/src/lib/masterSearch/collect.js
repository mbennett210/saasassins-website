// masterSearch/collect.js — the pure candidate-building engine. Imports only rank.js (also
// import-free) so it is node-testable in isolation; sources.js supplies the real adapters
// (which reference the store selectors and therefore cannot themselves be imported under
// plain node). Given a sources array + state + user + a permission checker, this turns
// allowed slices into rank-ready candidates. It never decides scoping itself — each
// source's `select` does.
import { normalize } from './rank.js';

const DAY_MS = 86400000;

// source object → (list array → { day, built }). Module-level and keyed by the adapter's
// identity, so adapters are never mutated and two adapters can never share a cache (one
// spread from another, or two selecting the same slice array). Both levels are weak.
const CACHE = new WeakMap();

// Build (and cache) the candidates for one source's current list. Keyed on the exact array
// the selector returned: non-crew selectors return the slice by reference (stable across
// renders), so haystacks rebuild only when a slice array identity changes — which every
// add/edit/delete does — or when the day rolls over (the per-record `order`, e.g. a
// clean's distance from today, is date-relative). Label/keywords are normalized HERE, once,
// so a keystroke never re-normalizes the book. `index` fixes the record-type tie-break
// order (rankBucket 2 + index).
export function candidatesFor(source, list, state, index, now = Date.now()) {
  let perSource = CACHE.get(source);
  if (!perSource) { perSource = new WeakMap(); CACHE.set(source, perSource); }
  const day = Math.floor(now / DAY_MS);
  const hit = perSource.get(list);
  if (hit && hit.day === day) return hit.built;
  const built = list.map((rec) => {
    const label = String(source.primary(rec, state) ?? '');
    const keywords = source.keywords(rec, state);
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
      sublabel: source.sublabel(rec, state),
      keywords,
      _l: normalize(label),
      _k: keywords.map(normalize),
      order: source.order ? source.order(rec, state, now) : 0,
      icon: source.groupIcon,
      to: source.to(rec, state),
      refId: rec.id,
      seeAll: source.seeAll || null,
      seeAllFiltered: !!source.seeAllFiltered,
      seeAllLabel: source.seeAllLabel,
    };
  });
  perSource.set(list, { day, built });
  return built;
}

// Every record candidate the user is permitted to search. Gating is per SOURCE; the scoped
// selector inside each allowed source does the per-record work. `opts.isMobile` drops
// desktop-only sources (their destination is a desktop-bound surface).
export function collectCandidates(sources, state, user, check, opts = {}) {
  const now = opts.now ?? Date.now();
  const out = [];
  sources.forEach((source, index) => {
    if (!check(source.perm)) return;
    if (source.desktopOnly && opts.isMobile) return;
    const list = source.select(state, user) || [];
    if (!list.length) return;
    out.push(...candidatesFor(source, list, state, index, now));
  });
  return out;
}

// Re-resolve one record recent against LIVE state: the fresh candidate (so a rename shows),
// or null when the record is gone / no longer permitted / out of the user's scope / on a
// desktop-only surface while on mobile — so the recents list drops it.
export function resolveFromSources(sources, state, user, check, type, refId, opts = {}) {
  const index = sources.findIndex((s) => s.type === type);
  if (index < 0) return null;
  const source = sources[index];
  if (!check(source.perm)) return null;
  if (source.desktopOnly && opts.isMobile) return null;
  const list = source.select(state, user) || [];
  if (!list.some((r) => r.id === refId)) return null;
  return candidatesFor(source, list, state, index, opts.now ?? Date.now()).find((c) => c.refId === refId) || null;
}
