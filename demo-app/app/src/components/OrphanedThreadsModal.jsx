import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import ConfirmDialog from './ConfirmDialog';
import EmptyState from './EmptyState';
import Icon from './Icon';
import ThreadTitleEditor from './ThreadTitleEditor';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectOrphanedInternalThreads, selectThreadCreator,
  selectMessagesForConversation, selectActiveUsers,
} from '../store/selectors';
import { CREATOR_STATE_REASON, threadCreatorLabel } from '../lib/threads';
import { fmtRelative } from '../lib/dates';

// Super-Admin maintenance surface for ORPHANED internal threads — threads whose
// creator was deleted or is no longer active.
//
// Why this exists: selectConversationsForInbox scopes the internal inbox to
// participants for EVERY role, Super Admin included. A manager who isn't a member
// can't see, open, or delete such a thread, and once every member is deleted the
// thread drains to zero participants and becomes visible to nobody at all —
// permanently undeletable dead weight in the shared org blob. This panel is the
// only escape hatch.
//
// It is deliberately METADATA-ONLY. Bypassing participant scoping to enable
// cleanup is not a licence to read private team conversations, so no message text
// is ever rendered here — only the name, who made it, how many members remain,
// and when it was last active.
export default function OrphanedThreadsModal({ open, onClose }) {
  const state = useStore();
  const dispatch = useDispatch();
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // null when closed; { ids } when the destructive confirm is up.
  const [confirmIds, setConfirmIds] = useState(null);

  const orphans = useMemo(() => (open ? selectOrphanedInternalThreads(state) : []), [state, open]);

  // Active-user ids, so a row can say how many live people still rely on the
  // thread — deleting an inactive-creator thread is destructive for THEM.
  const activeUserIds = useMemo(() => new Set(selectActiveUsers(state).map((u) => u.id)), [state]);

  useEffect(() => { if (open) setSelectedIds(new Set()); }, [open]);

  // Drop ids that stop being orphans (creator reactivated) or get deleted, so a
  // stale selection can never carry into a bulk delete.
  useEffect(() => {
    const live = new Set(orphans.map((c) => c.id));
    setSelectedIds((prev) => {
      const next = new Set(Array.from(prev).filter((id) => live.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [orphans]);

  const toggle = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const allSelected = orphans.length > 0 && orphans.every((c) => selectedIds.has(c.id));
  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(orphans.map((c) => c.id)));
  };

  const handleRename = (id, title) => {
    dispatch({ type: ACTIONS.RENAME_CONVERSATION, id, title });
  };

  const handleConfirmDelete = () => {
    const ids = confirmIds || [];
    if (ids.length === 0) return;
    if (ids.length === 1) dispatch({ type: ACTIONS.DELETE_CONVERSATION, id: ids[0] });
    else dispatch({ type: ACTIONS.BULK_DELETE_CONVERSATIONS, ids });
    setSelectedIds(new Set());
    setConfirmIds(null);
  };

  const confirmCount = confirmIds?.length || 0;

  return (
    <>
      <Modal open={open} onClose={onClose} title="Orphaned channels">
        <div className="text-xs text-muted orphan-intro">
          Channels whose creator was removed or is no longer active. Channels are never
          deleted with their creator, so they live on here. Rename one to keep it, or delete
          it for good. Message contents stay private; this list shows details only.
        </div>

        {orphans.length === 0 ? (
          <EmptyState
            icon={<Icon name="check" size={24} />}
            title="Nothing to clean up"
            message="Every channel has an active creator."
          />
        ) : (
          <>
            <div className="orphan-list-head">
              <label className="orphan-selectall">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all orphaned channels"
                />
                <span className="text-xs text-muted">
                  {selectedIds.size > 0
                    ? `${selectedIds.size} of ${orphans.length} selected`
                    : `${orphans.length} orphaned channel${orphans.length === 1 ? '' : 's'}`}
                </span>
              </label>
              {selectedIds.size > 0 && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => setConfirmIds(Array.from(selectedIds))}
                >
                  <Icon name="trash" size={14} />
                  Delete selected
                </button>
              )}
            </div>

            <div className="orphan-list">
              {orphans.map((c) => {
                const creator = selectThreadCreator(state, c);
                const members = c.participantUserIds || [];
                const activeMembers = members.filter((id) => activeUserIds.has(id)).length;
                const msgCount = selectMessagesForConversation(state, c.id).length;
                const lastAt = c.lastMessageAt || c.createdAt;
                return (
                  <div key={c.id} className={`orphan-row ${selectedIds.has(c.id) ? 'is-selected' : ''}`}>
                    <label className="orphan-row-check">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(c.id)}
                        onChange={() => toggle(c.id)}
                        aria-label={`Select ${c.title || 'Team discussion'}`}
                      />
                    </label>
                    <div className="orphan-row-body">
                      <div className="orphan-row-title">
                        <ThreadTitleEditor
                          title={c.title}
                          canEdit
                          onRename={(title) => handleRename(c.id, title)}
                        />
                      </div>
                      <div className="orphan-row-meta text-xs text-muted">
                        <span title={CREATOR_STATE_REASON[creator.state] || undefined}>
                          {threadCreatorLabel(creator)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{msgCount} message{msgCount === 1 ? '' : 's'}</span>
                        <span aria-hidden="true">·</span>
                        <span>{lastAt ? `Active ${fmtRelative(lastAt)}` : 'Never active'}</span>
                      </div>
                      {/* An INACTIVE creator's thread is still in daily use by whoever
                          is left. That has to be legible before the delete click,
                          because nothing here shows what would be destroyed. */}
                      {activeMembers > 0 ? (
                        <div className="orphan-row-warn text-xs">
                          <Icon name="warning" size={11} />
                          Still visible to {activeMembers} active member{activeMembers === 1 ? '' : 's'}
                        </div>
                      ) : (
                        <div className="orphan-row-note text-xs text-muted">
                          No active members left. Visible to nobody
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-danger"
                      onClick={() => setConfirmIds([c.id])}
                      title="Permanently delete this channel and all its messages"
                    >
                      <Icon name="trash" size={14} />
                      Delete
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Close</button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmIds !== null}
        title={`Permanently delete ${confirmCount} channel${confirmCount === 1 ? '' : 's'}?`}
        message={`This permanently deletes ${confirmCount === 1 ? 'the channel' : `${confirmCount} channels`} and every message in ${confirmCount === 1 ? 'it' : 'them'}, for everyone. This cannot be undone.`}
        confirmLabel="Delete forever"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onClose={() => setConfirmIds(null)}
      />
    </>
  );
}
