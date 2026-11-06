// A section page's heading (Matt's boards web-02..web-05, mobile-02..mobile-06): "‹ Back to
// Dashboard", the title, and the building it is about; `actions` sit at the heading's end (New
// request).
//
// The back arrow is the PAGE's own <BackLink> (passed in as `back`), not drawn here: lint:backnav
// finds the pages that have a back arrow by the BackLink in the page module, and then holds every
// link into them to carrying its referrer. A back arrow hidden in this shared heading would take
// those pages out of the lint without a word.
export default function HubSectionHead({ back = null, title, building = null, actions = null }) {
  return (
    <header className="hub-head">
      {back}
      <div className="hub-head-row">
        <div className="hub-head-text">
          <h1 className="hub-title">{title}</h1>
          {building?.name && <div className="hub-head-sub text-sm">{building.name}</div>}
        </div>
        {actions && <div className="hub-head-actions">{actions}</div>}
      </div>
    </header>
  );
}

// A server-paged list's first row while it loads, fails or is empty — a table row, so the table
// keeps its frame (and .mobile-stack its card) in every state.
export function hubListState({ pager, cols, empty }) {
  if (pager.loading) return <tr className="stack-plain"><td colSpan={cols} className="text-muted">Loading…</td></tr>;
  if (pager.error) {
    return (
      <tr className="stack-plain"><td colSpan={cols}>
        <span className="text-sm">{pager.error} </span>
        <button type="button" className="btn btn-outline" onClick={pager.reload}>Try again</button>
      </td></tr>
    );
  }
  if (pager.total === 0) return <tr className="stack-plain"><td colSpan={cols}>{empty}</td></tr>;
  return null;
}
