import Icon from './Icon';
import { useT } from '../i18n/react';

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
  const t = useT();
  const hasSelection = selectedCount > 0;
  return (
    <div className="bulk-action-bar" role="toolbar" aria-label={t('messages.bulkActions')}>
      <button type="button" className="btn btn-outline btn-sm bulk-selectall" onClick={onToggleAll}>
        <Icon name={allSelected ? 'x' : 'check'} size={12} />
        <span>{allSelected ? t('messages.deselectAll') : t('messages.selectAll')}</span>
      </button>
      <span className="bulk-count">
        {t.rich('messages.selectedCount', { count: selectedCount })}
      </span>
      <div className="bulk-actions">
        {hasSelection && canBulk && (
          <>
            <button type="button" className="btn btn-primary btn-sm" onClick={onMarkRead}>
              <Icon name="check" size={12} />
              <span>{t('messages.markReadShort')}</span>
            </button>
            <button type="button" className="btn btn-primary btn-sm" onClick={onMarkUnread}>
              <span>{t('messages.markUnreadShort')}</span>
            </button>
            {onBulkDelete && (
              <button
                type="button"
                className="btn btn-danger btn-sm"
                onClick={onBulkDelete}
                title={t('messages.bulkDeleteHint')}
              >
                <Icon name="trash" size={12} />
                <span>{t('messages.delete')}</span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
