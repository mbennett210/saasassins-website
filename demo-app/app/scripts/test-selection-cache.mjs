// useSelector's memoization — Increment 0.4 (E3).
//
// 🔴 THE BUG THIS FIXES IS A WHITE SCREEN, NOT A SLOWDOWN.
//
// useSelector cached on OUTPUT-VALUE EQUALITY. With the default Object.is and ANY
// allocating selector — `s => s.jobs.filter(...)`, `s => ({a: s.x})`, or even
// `s => s.reviews || {}` when the key is absent from the blob — the new value is a
// fresh reference every call, isEqual always fails, and the cache NEVER hits.
//
// React calls getSnapshot at least twice per render: once to render, once post-commit
// to verify consistency. A different reference the second time forces a re-render,
// which calls getSnapshot again, which allocates again — an infinite loop ending in
// React error #185. And the "getSnapshot should be cached" warning is STRIPPED FROM
// PRODUCTION BUILDS, so the first component to adopt useSelector with an ordinary
// `|| []` selector would white-screen prod with no warning anywhere.
//
// The fix keys the cache on (snapshot, selector, isEqual) IDENTITY. The consistency
// re-check then gets back exactly what it was given, which is loop-proof by
// construction.
//
//   node scripts/test-selection-cache.mjs
import { makeSelectionCache } from '../src/store/selectionCache.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const is = Object.is;
const shallow = (a, b) => {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a); const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.is(a[k], b[k]));
};

const snap = (jobs = [], extra = {}) => ({ jobs, ...extra });

// ── 🔴 THE LOOP-BREAKER ──────────────────────────────────────────────────
// React's second getSnapshot call, same snapshot, must return the IDENTICAL
// reference. This is the whole fix; if it regresses, production white-screens.
{
  const sel = makeSelectionCache();
  const s = snap([{ id: 'a' }, { id: 'b' }]);
  const allocating = (st) => st.jobs.filter((j) => j.id === 'a');   // fresh array EVERY call
  const first = sel(s, allocating, is);
  const second = sel(s, allocating, is);   // React's consistency re-check
  ok('an ALLOCATING selector with the DEFAULT comparer returns an identical reference', first === second);
  const third = sel(s, allocating, is);
  ok('  ...and stays identical across further calls', third === first);
}
{
  // The other everyday shape: `|| []` / `|| {}` on a key absent from the live blob.
  const sel = makeSelectionCache();
  const s = snap([], {});
  const orEmpty = (st) => st.reviews || {};
  ok('`|| {}` on an absent key does not allocate a new reference each call',
    sel(s, orEmpty, is) === sel(s, orEmpty, is));
}
{
  const sel = makeSelectionCache();
  const s = snap();
  const objLiteral = (st) => ({ a: st.jobs, b: st.other });
  ok('an object-literal selector is stable within a snapshot',
    sel(s, objLiteral, is) === sel(s, objLiteral, is));
}
{
  // Nested construction — the shape shallowEqual cannot rescue. Must STILL be stable
  // within a snapshot, or it loops regardless of comparer.
  const sel = makeSelectionCache();
  const s = snap([{ id: 'a' }]);
  const nested = (st) => st.jobs.map((j) => ({ ...j, tag: 'x' }));
  ok('even a DEEPLY allocating selector is stable within a snapshot',
    sel(s, nested, is) === sel(s, nested, is));
}

// ── correctness across snapshots ────────────────────────────────────────
{
  const sel = makeSelectionCache();
  const a = snap([{ id: 'a' }]);
  const b = snap([{ id: 'a' }, { id: 'b' }]);
  const pick = (st) => st.jobs;
  const v1 = sel(a, pick, is);
  const v2 = sel(b, pick, is);
  ok('a NEW snapshot recomputes', v1 !== v2);
  ok('  ...and returns the new value', v2.length === 2);
}
{
  // The perf half: across snapshots, an equal result keeps the PRIOR reference so the
  // consumer does not re-render on an unrelated dispatch.
  const sel = makeSelectionCache();
  const jobs = [{ id: 'a' }];
  const a = snap(jobs, { tick: 1 });
  const b = snap(jobs, { tick: 2 });   // unrelated slice changed
  const build = (st) => ({ count: st.jobs.length });
  const v1 = sel(a, build, shallow);
  const v2 = sel(b, build, shallow);
  ok('shallowEqual keeps the PRIOR reference when content is unchanged', v1 === v2);
}
{
  const sel = makeSelectionCache();
  const a = snap([{ id: 'a' }]);
  const b = snap([{ id: 'a' }, { id: 'b' }]);
  const build = (st) => ({ count: st.jobs.length });
  ok('shallowEqual still yields a NEW reference when content changed',
    sel(a, build, shallow) !== sel(b, build, shallow));
}

// ── parameterised selectors ─────────────────────────────────────────────
// `s => selectById(s, props.id)` is a new closure per render. A prop change must never
// serve the previous prop's value.
{
  const sel = makeSelectionCache();
  const s = snap([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
  const byId = (id) => (st) => st.jobs.find((j) => j.id === id) || null;
  const selA = byId('a');
  const selB = byId('b');
  ok('a different selector identity recomputes', sel(s, selA, is).id === 'a' && sel(s, selB, is).id === 'b');
  ok('  ...and switching back is correct', sel(s, selA, is).id === 'a');
  // Same snapshot + same closure is still stable, so an unchanged prop does not loop.
  ok('the same parameterised closure is stable within a snapshot', sel(s, selA, is) === sel(s, selA, is));
}

// ── comparer identity is part of the key ────────────────────────────────
{
  const sel = makeSelectionCache();
  const s = snap([{ id: 'a' }]);
  const build = (st) => ({ n: st.jobs.length });
  const v1 = sel(s, build, is);
  const v2 = sel(s, build, shallow);   // comparer swapped
  ok('a different comparer recomputes rather than reusing a mismatched cache', v1 !== v2 || v1.n === v2.n);
  ok('  ...and is then stable under the NEW comparer', sel(s, build, shallow) === v2);
}

// ── primitives and degenerate values ────────────────────────────────────
{
  const sel = makeSelectionCache();
  const s = snap([], { currentUserId: 'u_1' });
  const pick = (st) => st.currentUserId;
  ok('a scalar selector is stable', sel(s, pick, is) === 'u_1' && sel(s, pick, is) === 'u_1');
  const nul = () => null;
  ok('null is cached, not treated as a miss', sel(s, nul, is) === null && sel(s, nul, is) === null);
  const undef = () => undefined;
  ok('undefined is cached too', sel(s, undef, is) === undefined && sel(s, undef, is) === undefined);
  const nan = () => NaN;
  ok('NaN is stable under Object.is', Number.isNaN(sel(s, nan, is)) && Number.isNaN(sel(s, nan, is)));
}
{
  // Two independent hooks must not share state.
  const s = snap([{ id: 'a' }]);
  const c1 = makeSelectionCache();
  const c2 = makeSelectionCache();
  const build = (st) => ({ n: st.jobs.length });
  ok('separate caches are independent', c1(s, build, is) !== c2(s, build, is));
}

// ── the invariant, stated directly ──────────────────────────────────────
// For ANY selector and ANY comparer, two consecutive calls with the SAME snapshot must
// return the identical reference. That is exactly the condition React requires, and
// violating it is the infinite loop.
{
  const selectors = [
    (st) => st.jobs,
    (st) => st.jobs.filter(Boolean),
    (st) => st.jobs.map((j) => ({ ...j })),
    (st) => ({ a: 1, b: st.jobs }),
    (st) => st.missing || [],
    (st) => st.missing || {},
    () => null,
    () => 42,
  ];
  let violated = 0;
  for (const comparer of [is, shallow]) {
    for (const f of selectors) {
      const c = makeSelectionCache();
      const s = snap([{ id: 'a' }]);
      if (c(s, f, comparer) !== c(s, f, comparer)) violated += 1;
    }
  }
  ok(`INVARIANT: same snapshot => identical reference, for all 16 selector/comparer pairs (${violated} violations)`, violated === 0);
}

console.log(`\nselection cache: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
