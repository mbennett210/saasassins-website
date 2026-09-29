import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

// URL-backed free-text search for a single list table. Mirrors useUrlFilters'
// contract: writes with replace:true so the back button / referrer restore the
// exact filtered view, and DROPS the param when the query is empty (clean URLs).
// `key` namespaces the param so two searchable tables can share one page without
// colliding (e.g. 'q' for the main table, 'oq' for a second). Pair with
// searchRows for the actual filtering. See UI_RULES §72.
//
//   const [q, setQ] = useTableSearch('q');
//   const rows = searchRows(all, q, (r) => `${r.name} ${r.email}`);
export function useTableSearch(key = 'q') {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) || '';
  const setValue = useCallback((v) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if ((v || '').trim()) next.set(key, v);
      else next.delete(key);
      return next;
    }, { replace: true });
  }, [key, setParams]);
  return [value, setValue];
}
