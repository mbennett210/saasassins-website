import Icon from './Icon';

// Appears at the top of the thread list when ≥1 conversation is selected.
// Available actions: mark read/unread for everyone, plus "Delete" for users
// who have permission to hard-delete at least one of the selected threads.
// The delete handler must filter by per-thread permission at the call site;
// this component just renders the trigger.
export default function BulkActionBar({
  selectedCount,
  onClear,
  onMarkRead,
  onMarkUnread,
  onBulkDelete,
  canBulk,
}) {
  return (
    <div className="bulk-action-bar" role="toolbar" aria-label="Bulk actions">
      <span className="bulk-count">
        <strong>{selectedCount}</strong> selected
      </span>
      <div className="bulk-actions">
        {canBulk && (
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
        <button type="button" className="btn btn-outline btn-sm bulk-clear" onClick={onClear} title="Clear selection">
          <Icon name="x" size={12} />
          <span>Clear selection</span>
        </button>
      </div>
    </div>
  );
}
