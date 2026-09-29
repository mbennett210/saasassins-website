// masterSearch/rank.js — the pure ranking core. ZERO imports on purpose: it is the
// most logic-dense piece and must be exhaustively node-testable in isolation
// (scripts/test-master-search-rank.mjs). No React, no store, no DOM.
//
// Query semantics mirror the app's one text-match util (lib/searchRows.js): lowercase,
// trim, collapse whitespace, split on spaces, and AND the terms. No fuzzy, no wildcard —
// global search behaves exactly like every list-page search the user already knows.

export function normalize(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}

export function terms(q) {
  const n = normalize(q);
  return n ? n.split(' ') : [];
}

// Normalized label / keywords. Candidates built by collect.js and registry.js carry these
// precomputed (`_l`, `_k`) so a keystroke never re-normalizes the whole book; hand-built
// entries (tests) fall back to computing them here.
const labelOf = (e) => (e._l != null ? e._l : normalize(e.label));
const keywordsOf = (e) => (e._k != null ? e._k : (e.keywords || []).map(normalize));

// Match tier of one entry (lower = better); Infinity means "does not match" (AND failed).
//   0 exact label · 1 label starts-with query · 2 a label WORD starts with a term ·
//   3 label substring · 4 term matches only in keywords.
// The entry's tier is the WORST term's tier (AND semantics), EXCEPT a whole-query
// exact/prefix hit on the label overrides it — so "north shore" ranks as a prefix of
// "North Shore Dental" (tier 1), not as the worst per-term substring.
export function tierOf(entry, q, ts) {
  if (!ts.length) return Infinity;
  const label = labelOf(entry);
  const labelWords = label.split(' ');
  const kw = keywordsOf(entry);

  let joined = Infinity;
  if (label === q) joined = 0;
  else if (label.startsWith(q)) joined = 1;

  let worst = 0;
  for (const t of ts) {
    let termTier;
    if (labelWords.some((w) => w.startsWith(t))) termTier = 2;
    else if (label.includes(t)) termTier = 3;
    else if (kw.some((k) => k.includes(t))) termTier = 4;
    else return Infinity; // a term that matches nowhere removes the entry (AND)
    if (termTier > worst) worst = termTier;
  }
  return Math.min(joined, worst);
}

// For a keyword-only match (tier 4), the keyword that explains it — the first keyword
// holding a term the label does not. Surfaced in the UI so a hit like "Invoices" for
// "pay" reads as `"payments"` instead of looking random. Returns the ORIGINAL casing.
export function matchHint(entry, ts) {
  const label = labelOf(entry);
  const kwNorm = keywordsOf(entry);
  const kwRaw = entry.keywords || [];
  for (const t of ts) {
    if (label.includes(t)) continue;
    const i = kwNorm.findIndex((k) => k.includes(t));
    if (i >= 0) return String(kwRaw[i] ?? '');
  }
  return '';
}

// Sort key is TOTAL and permutation-independent (asserted by test):
//   [tier ASC, rankBucket ASC, label ASC, order ASC, id ASC].
// rankBucket encodes "modules beat actions beat records on ties" + the fixed
// record-type order (pages 0, actions 1, records 2 + typeIndex). `order` is an optional
// per-record relevance tie-break for same-labelled rows (e.g. a customer's cleans sort
// nearest-to-today first). The trailing id compare guarantees a stable total order.
export function rankEntries(entries, query) {
  const q = normalize(query);
  const ts = terms(query);
  const scored = [];
  for (const e of entries) {
    const minLen = e.minQueryLen || 1;
    if (q.length < minLen) continue;
    const tier = tierOf(e, q, ts);
    if (tier === Infinity) continue;
    scored.push({ ...e, tier, hint: tier === 4 ? matchHint(e, ts) : '' });
  }
  scored.sort((a, b) =>
    a.tier - b.tier
    || a.rankBucket - b.rankBucket
    || labelOf(a).localeCompare(labelOf(b), 'en')
    || (a.order ?? 0) - (b.order ?? 0)
    || String(a.id).localeCompare(String(b.id)));
  return scored;
}

export const PER_GROUP_CAP = 5;
export const TOTAL_CAP = 36;

// Group the flat ranked list into ordered sections and cap them. A group maps 1:1 to a
// rankBucket (Pages / Actions / one per record type). Groups are ordered by their BEST
// item's tier, then rankBucket — so a strong record match can float its section above
// Pages, while on equal tiers the fixed pages → actions → records order holds. Each
// group caps at its entries' `groupCap` (pages/actions carry a larger one: they ARE the
// app's functions, hiding one silently is worse than a longer list) else PER_GROUP_CAP;
// a truncated group carries { truncated, totalCount } for its overflow row. TOTAL_CAP
// bounds the rendered rows.
export function groupRanked(scored) {
  const byKey = new Map();
  for (const e of scored) {
    if (!byKey.has(e.group)) byKey.set(e.group, []);
    byKey.get(e.group).push(e);
  }
  const groups = [];
  for (const [key, items] of byKey) {
    groups.push({ key, items, bestTier: items[0].tier, rankBucket: items[0].rankBucket });
  }
  groups.sort((a, b) => a.bestTier - b.bestTier || a.rankBucket - b.rankBucket || a.key.localeCompare(b.key));

  let total = 0;
  const out = [];
  for (const g of groups) {
    if (total >= TOTAL_CAP) break;
    const cap = g.items[0].groupCap || PER_GROUP_CAP;
    const room = Math.min(cap, TOTAL_CAP - total);
    const shown = g.items.slice(0, room);
    if (!shown.length) continue;
    total += shown.length;
    out.push({
      key: g.key,
      label: g.items[0].groupLabel,
      icon: g.items[0].groupIcon,
      items: shown,
      truncated: g.items.length > shown.length,
      totalCount: g.items.length,
    });
  }
  return out;
}
