import { useRef, useCallback } from 'react';
import Avatar from './Avatar';
import EmptyState from './EmptyState';
import Icon from './Icon';
import BulkActionBar from './BulkActionBar';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import {
  selectContactById, selectMessagesForConversation, selectUnreadForConversation,
  selectEffectiveStatus, selectOtherParticipant,
} from '../store/selectors';
import { fmtRelative } from '../lib/dates';

function previewText(msg) {
  if (!msg) return '';
  return msg.text || '';
}

function initialsFromContact(contact) {
  if (!contact) return 'T';
  const first = (contact.firstName || '')[0] || '';
  const last = (contact.lastName || '')[0] || '';
  return `${first}${last}`.toUpperCase() || 'C';
}

// "Snoozed" label: show "Snoozed · in Xh" if waking within a day, else "until <date>".
function snoozeLabel(untilIso) {
  if (!untilIso) return 'Snoozed';
  const diffMs = new Date(untilIso).getTime() - Date.now();
  if (diffMs <= 0) return 'Snoozed';
  const hours = Math.round(diffMs / 3600000);
  if (hours < 24) return `Snoozed · in ${Math.max(1, hours)}h`;
  const d = new Date(untilIso);
  return `Snoozed · until ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function StatusChip({ status, snoozedUntil }) {
  if (status === 'open') return null;
  if (status === 'snoozed') {
    return <span className="status-chip status-chip-amber"><Icon name="moon" size={10} />{snoozeLabel(snoozedUntil)}</span>;
  }
  if (status === 'closed') {
    return <span className="status-chip status-chip-slate"><Icon name="check" size={10} />Closed</span>;
  }
  return null;
}

function ThreadRow({ conversation, active, selected, onSelect, onToggleSelect, onToggleStar, hideCheckbox = false, isOwnedByMe = false }) {
  const state = useStore();
  const { currentUser } = useAuth();
  const contact = conversation.contactId ? selectContactById(state, conversation.contactId) : null;
  const msgs = selectMessagesForConversation(state, conversation.id);
  const last = msgs[msgs.length - 1];
  const unread = selectUnreadForConversation(state, conversation.id);
  const effectiveStatus = selectEffectiveStatus(conversation);
  const isMuted = !!(currentUser && (conversation.mutedByUserIds || []).includes(currentUser.id));
  const isStarred = !!(currentUser && (conversation.starredByUserIds || []).includes(currentUser.id));
  const rowRef = useRef(null);

  const handleClick = useCallback(() => {
    const el = rowRef.current;
    if (el) {
      el.classList.remove('thread-row-tap');
      void el.offsetWidth;
      el.classList.add('thread-row-tap');
    }
    onSelect(conversation.id);
  }, [onSelect, conversation.id]);

  const isInternal = conversation.channel === 'internal';
  const isDm = conversation.channel === 'dm';
  const dmOther = isDm ? selectOtherParticipant(state, conversation, currentUser?.id) : null;

  let displayName;
  let initials;
  let avatarVariant;
  if (isDm) {
    displayName = dmOther ? dmOther.name : 'Unknown user';
    initials = dmOther?.initials || '?';
    avatarVariant = dmOther?.avatar || 1;
  } else if (isInternal) {
    displayName = conversation.title || 'Team discussion';
    initials = 'T';
    avatarVariant = 3;
  } else {
    displayName = contact ? `${contact.firstName} ${contact.lastName}` : 'Unlinked';
    initials = initialsFromContact(contact);
    avatarVariant = ((contact?.id?.length || 0) % 5) + 1;
  }

  return (
    <div
      ref={rowRef}
      className={`thread-row ${active ? 'active' : ''} ${selected ? 'selected' : ''} ${effectiveStatus !== 'open' ? 'status-' + effectiveStatus : ''} ${isOwnedByMe ? 'is-owner' : ''} ${isMuted ? 'is-muted' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
    >
      {!hideCheckbox && (
        <label className="thread-row-check" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect(conversation.id)}
            aria-label={`Select ${displayName}`}
          />
        </label>
      )}
      <Avatar initials={initials} variant={avatarVariant} size="sm" />
      <div className="thread-row-body">
        <div className="thread-row-name">
          {displayName}
          {isOwnedByMe && (
            <span
              className="thread-row-owner-mark"
              title="You created this thread"
              aria-label="You created this thread"
            >
              <Icon name="star" size={12} />
            </span>
          )}
          {isMuted && (
            <span
              className="thread-row-mute-mark"
              title="You silenced notifications for this thread"
              aria-label="Notifications silenced"
            >
              <Icon name="bellOff" size={12} />
            </span>
          )}
        </div>
        <div className="thread-row-preview">{previewText(last) || 'No messages yet'}</div>
      </div>
      <div className="thread-row-right">
        <div className="thread-row-top">
          {unread > 0 && <span className="thread-unread" aria-label={`${unread} unread`}>{unread}</span>}
          <button
            type="button"
            className={`thread-star-btn ${isStarred ? 'starred' : ''}`}
            onClick={(e) => { e.stopPropagation(); onToggleStar(conversation.id); }}
            aria-label={isStarred ? 'Unpin' : 'Pin'}
            title={isStarred ? 'Unpin' : 'Pin'}
          >
            <Icon name="star" size={14} />
          </button>
        </div>
        <span className="thread-row-time">{last ? fmtRelative(last.sentAt) : fmtRelative(conversation.createdAt)}</span>
        <div className="thread-row-meta">
          <StatusChip status={effectiveStatus} snoozedUntil={conversation.snoozedUntil} />
        </div>
      </div>
    </div>
  );
}

export default function ConversationThreadList({
  conversations,
  activeId,
  onSelect,
  search,
  onSearchChange,
  totalBeforeFilter = 0,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  onToggleStar,
  onBulkMarkRead,
  onBulkMarkUnread,
  onBulkDelete,
  canBulk,
  selectedInbox,
}) {
  const { currentUser } = useAuth();
  const isDmInbox = selectedInbox === 'dm';
  const isInternalInbox = selectedInbox === 'internal';
  const selectedCount = selectedIds?.size || 0;

  // Owned-by-current-user is surfaced as a small star next to the name (see
  // ThreadRow). Bulk multi-select INCLUDES owned threads — the bulk-delete
  // handler in Messaging.jsx (handleBulkDeleteRequest) enforces per-thread
  // permissions (creator-or-Super-Admin) and shows a heavy confirm before
  // any destructive action, so the visual gate isn't needed.
  const isOwned = (c) => Boolean(currentUser && c.createdByUserId === currentUser.id);
  const selectableConversations = conversations;
  const allSelected = selectedCount > 0 && selectableConversations.length > 0
    && selectableConversations.every((c) => selectedIds.has(c.id));

  return (
    <section className="thread-list-pane">
      <div className="thread-list-head">
        <div className="thread-list-search">
          <Icon name="search" size={14} />
          <input
            className="thread-list-input"
            placeholder="Search by name or message…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        <div className="thread-list-subhead">
          {isDmInbox ? (
            <span className="text-xs text-muted">
              {conversations.length === totalBeforeFilter
                ? `${conversations.length} thread${conversations.length === 1 ? '' : 's'}`
                : `${conversations.length} of ${totalBeforeFilter}`}
            </span>
          ) : (
            <label className="thread-list-selectall" title="Select all visible threads">
              <input
                type="checkbox"
                checked={allSelected}
                disabled={selectableConversations.length === 0}
                onChange={() => (allSelected ? onClearSelection() : onSelectAll(selectableConversations.map((c) => c.id)))}
                aria-label="Select all visible"
              />
              <span className="text-xs text-muted">
                {conversations.length === totalBeforeFilter
                  ? `${conversations.length} thread${conversations.length === 1 ? '' : 's'}`
                  : `${conversations.length} of ${totalBeforeFilter}`}
              </span>
            </label>
          )}
        </div>
      </div>
      {!isDmInbox && selectedCount > 0 && (
        <BulkActionBar
          selectedCount={selectedCount}
          onClear={onClearSelection}
          onMarkRead={onBulkMarkRead}
          onMarkUnread={onBulkMarkUnread}
          onBulkDelete={onBulkDelete}
          canBulk={canBulk}
        />
      )}
      <div className="thread-list-rows">
        {conversations.length === 0 ? (
          <EmptyState
            icon={<Icon name="messaging" size={24} />}
            title="No conversations"
            message="Try a different inbox or clear your filters."
          />
        ) : (() => {
          const renderRow = (c) => (
            <ThreadRow
              key={c.id}
              conversation={c}
              active={c.id === activeId}
              selected={selectedIds?.has(c.id) || false}
              onSelect={onSelect}
              onToggleSelect={onToggleSelect}
              onToggleStar={onToggleStar}
              hideCheckbox={isDmInbox}
              isOwnedByMe={isOwned(c)}
            />
          );

          // Threads inbox: split into "Your threads" (created by current user) on top + the rest below.
          if (isInternalInbox && currentUser) {
            const isPinnedByMe = (c) => (c.starredByUserIds || []).includes(currentUser.id);
            const owned = conversations.filter((c) => isOwned(c));
            const others = conversations.filter((c) => !isOwned(c));
            // Within each group, surface pinned first.
            const split = (list) => ({
              pinned: list.filter(isPinnedByMe),
              rest: list.filter((c) => !isPinnedByMe(c)),
            });
            const ownedSplit = split(owned);
            const othersSplit = split(others);
            return (
              <>
                {owned.length > 0 && (
                  <>
                    <div className="thread-section-header">
                      <Icon name="star" size={12} />
                      <span>Your threads</span>
                      <span className="thread-section-count">{owned.length}</span>
                    </div>
                    {ownedSplit.pinned.map(renderRow)}
                    {ownedSplit.rest.map(renderRow)}
                  </>
                )}
                {others.length > 0 && (
                  <>
                    <div className="thread-section-header thread-section-header-muted">
                      <span>Team threads</span>
                      <span className="thread-section-count">{others.length}</span>
                    </div>
                    {othersSplit.pinned.map(renderRow)}
                    {othersSplit.rest.map(renderRow)}
                  </>
                )}
              </>
            );
          }

          // Inbox / DMs: pinned on top (existing behavior). Pinned is per-user.
          const isPinnedByMe = (c) => Boolean(currentUser) && (c.starredByUserIds || []).includes(currentUser.id);
          const pinned = conversations.filter(isPinnedByMe);
          const others = conversations.filter((c) => !isPinnedByMe(c));
          if (pinned.length === 0) return conversations.map(renderRow);
          return (
            <>
              <div className="thread-section-header">
                <Icon name="star" size={12} />
                <span>Pinned</span>
                <span className="thread-section-count">{pinned.length}</span>
              </div>
              {pinned.map(renderRow)}
              {others.length > 0 && (
                <>
                  <div className="thread-section-header thread-section-header-muted">
                    <span>All conversations</span>
                    <span className="thread-section-count">{others.length}</span>
                  </div>
                  {others.map(renderRow)}
                </>
              )}
            </>
          );
        })()}
      </div>
    </section>
  );
}
