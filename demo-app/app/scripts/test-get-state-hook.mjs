// useGetState — imperative state reads that do NOT subscribe.
//
// ══ WHY IT EXISTS ═════════════════════════════════════════════════════════════
// useSelector covers reads whose value should drive a re-render. It cannot cover the
// other half of the 0.4 migration: reads inside EVENT HANDLERS — a drag-drop resolving
// conflicts, a save composing a patch, a confirm handler checking what it is about to
// touch. Those need the current state at call time, not a subscription.
//
// Before this, the only way to get it was useStore(), which re-subscribes the component
// to the whole snapshot and undoes the entire point of migrating. That is why several
// hot pages were stuck with no path forward — Schedule alone reads state in seven
// handlers.
//
//   node scripts/test-get-state-hook.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const src = readFileSync(new URL('../src/store/index.jsx', import.meta.url), 'utf8');
const fn = (src.match(/export function useGetState\(\) \{[\s\S]*?\n\}/) || [])[0] || '';

// ── it must not subscribe ───────────────────────────────────────────────
{
  ok('useGetState exists', fn.length > 0);
  ok('🔴 it does NOT call useSyncExternalStore (that is the whole point)',
    !/useSyncExternalStore/.test(fn));
  ok('  ...and returns the raw getter, not a value', /return store\.getSnapshot;/.test(fn));
  ok('  ...not an invoked snapshot', !/return store\.getSnapshot\(\)/.test(fn));
  ok('it throws outside the provider, like its siblings', /must be used inside <StoreProvider>/.test(fn));
}

// ── the stability claim it rests on ─────────────────────────────────────
// A stable getter is only safe in a dependency array if the store identity is stable.
{
  ok('🔴 the store is created ONCE via a lazy useState initialiser',
    /const \[store\] = useState\(\(\) => createExternalStore\(/.test(src));
  ok('  ...which the comment justifies against StrictMode double-invocation',
    /only one store is ever retained/.test(src));
  // If the store were rebuilt per render, every consumer's deps would churn.
  ok('  ...and it is NOT a plain useMemo/useRef assignment per render',
    !/const store = createExternalStore\(/.test(src));
}

// ── it is distinct from the subscribing hooks ───────────────────────────
{
  const useStoreFn = (src.match(/export function useStore\(\) \{[\s\S]*?\n\}/) || [])[0] || '';
  ok('useStore DOES subscribe (unchanged)', /useSyncExternalStore\(store\.subscribe, store\.getSnapshot\)/.test(useStoreFn));
  const useSelectorFn = (src.match(/export function useSelector\([\s\S]*?\n\}/) || [])[0] || '';
  ok('useSelector DOES subscribe (unchanged)', /useSyncExternalStore\(store\.subscribe, getSelection\)/.test(useSelectorFn));
  ok('all three read the same context', (src.match(/useContext\(StoreCtx\)/g) || []).length >= 3);
}

// ── the documented misuse is called out ─────────────────────────────────
// Reading it during render produces untracked output — the component will not update.
{
  ok('the render-time misuse is documented', /Do not read this DURING RENDER/.test(src));
  ok('  ...with the correct alternative named', /Render from useSelector/.test(src));
}

console.log(`\nuseGetState: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
