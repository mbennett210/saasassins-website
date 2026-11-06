// A server-paged table's pager in the SAME shape usePagedRows gives (ListPager reads it): the page
// lives in the URL, the rows are the one page the route returned, and `total` is the route's count
// of everything that matched. The Supplies queue and its Catalog tab read it (moved here from
// pages/Supplies.jsx when the catalog became its second reader, 2026-10-11).
export function useServerPager(rows, { total, page, pageSize, setPage }) {
  const totalPages = Math.max(1, Math.ceil((Number(total) || 0) / pageSize));
  return {
    pageRows: rows || [],
    page,
    totalPages,
    total: Number(total) || 0,
    pageSize,
    setPage,
    start: !total ? 0 : (page - 1) * pageSize + 1,
    end: Math.min(page * pageSize, Number(total) || 0),
  };
}
