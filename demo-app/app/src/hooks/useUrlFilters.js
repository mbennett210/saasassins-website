import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { codecFor, isEmptyValue } from '../lib/filters/applyFilters';

// URL-backed facet state — the generalized version of the hand-rolled setParam
// pattern in Schedule.jsx. Keeps every facet in the query string (replace:true)
// so the back button / referrer restore the exact filtered view, and drops a
// param when its facet returns to "no constraint" (clean URLs). Returns the
// decoded values, a setter, a clear-all, and how many facets are active.
//
//   const { values, setValue, clearAll, activeCount } = useUrlFilters(scheduleFilterSpecs);
//   const rows = applyFilters(jobs, values, scheduleFilterSpecs, { state, user });
//
// `specs` should be a stable (module-level) array. See CLEANSPACE_SWEPT.md §2.6.
export function useUrlFilters(specs) {
  const [searchParams, setSearchParams] = useSearchParams();

  const values = useMemo(() => {
    const out = {};
    for (const spec of specs) {
      const codec = spec.codec || codecFor(spec.kind);
      const raw = searchParams.get(spec.key);
      out[spec.key] = raw == null
        ? (spec.defaultValue ?? codec.default)
        : (spec.decode ? spec.decode(raw) : codec.decode(raw));
    }
    return out;
  }, [specs, searchParams]);

  // Functional updater, NOT a render-time snapshot: router-7 navigations run
  // in a transition, so a second param write landing before the first commits
  // rebuilt the URL from PRE-navigation params and silently dropped the other
  // write (the "range filter doesn't save when I switch views" report).
  const setValue = useCallback((key, v) => {
    const spec = specs.find((s) => s.key === key);
    if (!spec) return;
    const codec = spec.codec || codecFor(spec.kind);
    const enc = spec.encode ? spec.encode(v) : codec.encode(v);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (!enc || isEmptyValue(spec, v)) next.delete(key);
      else next.set(key, enc);
      return next;
    }, { replace: true });
  }, [specs, setSearchParams]);

  const clearAll = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      specs.forEach((s) => next.delete(s.key));
      return next;
    }, { replace: true });
  }, [specs, setSearchParams]);

  const activeCount = useMemo(
    () => specs.reduce((n, s) => n + (isEmptyValue(s, values[s.key]) ? 0 : 1), 0),
    [specs, values],
  );

  return { values, setValue, clearAll, activeCount };
}
