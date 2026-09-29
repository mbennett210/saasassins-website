// The pager under a truncated table — THE ONE pager UI. Pair it with `usePagedRows`:
//
//   const pager = usePagedRows(filtered, { param: 'page', resetKey: search });
//   …<tbody>{pager.pageRows.map(…)}</tbody>…
//   <ListPager pager={pager} noun="invoices" />
//
// Renders NOTHING when everything fits on one page — a "Page 1 of 1" control is furniture
// that says only that the control exists. The row-count readout goes with it, because on a
// single page the table already shows every row and counting them is the table's job.
//
// Markup and classes are the ones Clients/Invoices already used (`.list-pager*` in
// index.css), so adopting this changed no pixels on the two surfaces that had a pager.
export default function ListPager({ pager, noun = 'rows' }) {
  if (!pager || pager.totalPages <= 1) return null;
  const { page, totalPages, setPage, start, end, total } = pager;
  return (
    <div className="list-pager">
      <span className="list-pager-info">Showing {start}–{end} of {total} {noun}</span>
      <div className="list-pager-controls">
        <button type="button" className="btn btn-secondary" disabled={page <= 1}
          onClick={() => setPage(page - 1)}>Previous</button>
        <span className="list-pager-page">Page {page} of {totalPages}</span>
        <button type="button" className="btn btn-secondary" disabled={page >= totalPages}
          onClick={() => setPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}
