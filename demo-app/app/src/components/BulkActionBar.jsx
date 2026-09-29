import Icon from './Icon';

// The bulk toolbar. Shown whenever the list is in multi-select mode (entered from
// a row's ⋯ "Select"). Left: a Select-all / Deselect-all toggle so every visible
// thread can be grabbed at once; right: the actions, which only appear once ≥1
// thread is selected. "Delete" is offered to users who can hard-delete at least
// one selected thread; the delete handler filters by per-thread permission at the
// call site — this component just renders the trigger.
export default function BulkActionBar({
  selectedCount,
  allSelected,
  onToggleAll,
  onMarkRead,
  onMarkUnread,
  onBulkDelete,
  canBulk,
}) {
  const hasSelection = selectedCount > 0;
  return (
    <div className="bulk-action-bar" role="toolbar" aria-label="Bulk actions">
      <button type="button" className="btn btn-outline btn-sm bulk-selectall" onClick={onToggleAll}>
        <Icon name={allSelected ? 'x' : 'check'} size={12} />
        <span>{allSelected ? 'Deselect all' : 'Select all'}</span>
      </button>
      <span className="bulk-count">
        <strong>{selectedCount}</strong> selected
      </span>
      <div className="bulk-actions">
        {hasSelection && canBulk && (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={onMarkRead}>
              <Icon name="check" size={12} />
              <span>Mark read</span>
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={onMarkUnread}>
              <span>Mark unread</span>
            </button>
            {onBulkDelete && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={onBulkDelete}
                title="Permanently delete selected threads (only those you can delete will be removed)"
              >
                <Icon name="trash" size={12} />
                <span>Delete</span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
