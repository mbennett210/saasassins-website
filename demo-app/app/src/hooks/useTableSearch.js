import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

// URL-backed free-text search for a single list table. Mirrors useUrlFilters'
// contract: writes with replace:true so the back button / referrer restore the
// exact filtered view, and DROPS the param when the query is empty (clean URLs).
// `key` namespaces the param so two searchable tables can share one page without
// colliding (e.g. 'q' for the main table, 'oq' for a second). Pair with
// searchRows for the actual filtering. See UI_RULES §72.
//
// `reset` names the params a new search must clear — the table's page above all — and they go
// in the SAME address update as the search (CS-720). Never pair the setter with a second
// update (`setQ(v); setParam({ page: null })`): react-router builds every setSearchParams from
// the params of the LAST RENDER, in its functional form too, so the second update starts from
// the old address and drops the search — the Supplies searches never kept a letter.
// `scripts/test-url-search-one-update.mjs` fails any handler that writes the address twice.
//
//   const [q, setQ] = useTableSearch('q', { reset: ['page'] });
//   const rows = searchRows(all, q, (r) => `${r.name} ${r.email}`);
export function useTableSearch(key = 'q', { reset } = {}) {
  const [params, setParams] = useSearchParams();
  const value = params.get(key) || '';
  const resetList = (reset || []).join('\u0001');
  const setValue = useCallback((v) => {
    const resetKeys = resetList ? resetList.split('\u0001') : [];
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if ((v || '').trim()) next.set(key, v);
      else next.delete(key);
      for (const k of resetKeys) next.delete(k);
      return next;
    }, { replace: true });
  }, [key, resetList, setParams]);
  return [value, setValue];
}
