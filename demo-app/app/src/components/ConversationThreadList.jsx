import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Avatar from './Avatar';
import EmptyState from './EmptyState';
import Icon from './Icon';
import BulkActionBar from './BulkActionBar';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import {
  selectContactById, selectMessagesForConversation, selectUnreadForConversation,
  selectOtherParticipant,
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

// Per-row ⋯ action menu — the default (non-bulk) state of the left control slot.
// Opening it reveals Mark read / Mark unread / Delete for that single thread.
// The popover is position:fixed, anchored to the button's rect, and PORTALED to
// document.body: the row list is an overflow-y:auto scroll container, AND
// `.thread-row:active` applies a transform (a transformed ancestor re-hosts a
// fixed child, which mispositioned the menu + spawned a scrollbar on press).
// Rendering at body level keeps it viewport-anchored. Closes on outside-click,
// Escape, scroll, or resize.
function ThreadRowMenu({ label, unread, canDelete, onStartSelect, onMarkRead, onMarkUnread, onDelete }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // Dismiss on an outside tap — and SWALLOW that tap so it only closes the menu
    // instead of ALSO activating whatever was under it (opening a thread, hitting
    // the nav, etc.). A capture-phase click runs before the target's own handler,
    // so preventDefault + stopImmediatePropagation stop the click from ever
    // reaching it. The popover is portaled out of wrapRef, so spare BOTH the
    // trigger (it toggles itself) and the popover (its items run their action).
    // Hardening rule — see UI_RULES §100: a dismiss layer must eat the dismiss tap.
    const onOutsideClick = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (popRef.current?.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('click', onOutsideClick, true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('click', onOutsideClick, true);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) {
      const MENU_W = 190;
      const MENU_H = 180;
      let top = r.bottom + 4;
      let left = r.left;
      if (top + MENU_H > window.innerHeight - 8) top = Math.max(8, r.top - MENU_H - 4);
      if (left + MENU_W > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - MENU_W);
      setPos({ top, left });
    }
    setOpen(true);
  };

  // Fire the action, then close. stopPropagation keeps the row's own open-thread
  // click from firing underneath the menu.
  const choose = (fn) => (e) => { e.stopPropagation(); fn(); setOpen(false); };

  return (
    <div className="thread-row-menu" ref={wrapRef} onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        className="btn-icon btn-icon-ghost"
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Actions"
        onClick={(e) => { e.stopPropagation(); toggle(); }}
      >
        <Icon name="dots" size={16} />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="thread-row-menu-popover"
          role="menu"
          style={{ top: pos.top, left: pos.left }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            role="menuitem"
            className="menu-option"
            onClick={choose(onStartSelect)}
          >
            Select
          </button>
          <div className="thread-row-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="menu-option"
            onClick={choose(onMarkRead)}
            disabled={unread === 0}
          >
            Mark as read
          </button>
          <button
            type="button"
            role="menuitem"
            className="menu-option"
            onClick={choose(onMarkUnread)}
            disabled={unread > 0}
          >
            Mark as unread
          </button>
          <div className="thread-row-menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className="menu-option menu-option-danger"
            onClick={choose(onDelete)}
            disabled={!canDelete}
            title={canDelete ? undefined : "Only the thread's creator or a Super Admin can delete it"}
          >
            Delete
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

function ThreadRow({
  conversation, active, selected, onSelect, onToggleSelect, onToggleStar,
  hideCheckbox = false, isOwnedByMe = false, bulkMode = false,
  onStartSelect, onRowMarkRead, onRowMarkUnread, onRowDelete,
}) {
  const state = useStore();
  const { currentUser } = useAuth();
  const contact = conversation.contactId ? selectContactById(state, conversation.contactId) : null;
  const msgs = selectMessagesForConversation(state, conversation.id);
  const last = msgs[msgs.length - 1];
  const unread = selectUnreadForConversation(state, conversation.id);
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
      className={`thread-row ${active ? 'active' : ''} ${selected ? 'selected' : ''} ${isOwnedByMe ? 'is-owner' : ''} ${isMuted ? 'is-muted' : ''}`}
      onClick={handleClick}
      role="button"
      tabIndex={0}
    >
      {!hideCheckbox && (
        bulkMode ? (
          <label className="thread-row-check" onClick={(e) => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={selected}
              onChange={() => onToggleSelect(conversation.id)}
              aria-label={`Select ${displayName}`}
            />
          </label>
        ) : (
          <ThreadRowMenu
            label={displayName}
            unread={unread}
            canDelete={isOwnedByMe || currentUser?.role === 'owner'}
            onStartSelect={onStartSelect}
            onMarkRead={() => onRowMarkRead(conversation.id)}
            onMarkUnread={() => onRowMarkUnread(conversation.id)}
            onDelete={() => onRowDelete(conversation.id)}
          />
        )
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
          {/* Pin/star omitted for a crew (non-office) viewer — the crew write merge drops it (CS-002). */}
          {onToggleStar && (
            <button
              type="button"
              className={`btn-icon btn-icon-ghost ${isStarred ? 'starred' : ''}`}
              onClick={(e) => { e.stopPropagation(); onToggleStar(conversation.id); }}
              aria-label={isStarred ? 'Unpin' : 'Pin'}
              title={isStarred ? 'Unpin' : 'Pin'}
            >
              <Icon name="star" size={14} />
            </button>
          )}
        </div>
        <span className="thread-row-time">{last ? fmtRelative(last.sentAt) : fmtRelative(conversation.createdAt)}</span>
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
  bulkMode = false,
  onEnterBulk,
  onExitBulk,
  onRowMarkRead,
  onRowMarkUnread,
  onRowDelete,
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

  const countText = conversations.length === totalBeforeFilter
    ? `${conversations.length} thread${conversations.length === 1 ? '' : 's'}`
    : `${conversations.length} of ${totalBeforeFilter}`;

  // Select-all / deselect-all for the bulk toolbar. Entering bulk mode now happens
  // from a row's ⋯ menu ("Select"), so this no longer double-duties as an enter toggle.
  const onToggleAll = () => {
    if (allSelected) onClearSelection();
    else onSelectAll(selectableConversations.map((c) => c.id));
  };

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
          <span className="text-xs text-muted">{countText}</span>
          {!isDmInbox && bulkMode && (
            <button type="button" className="linklike text-xs thread-bulk-done" onClick={onExitBulk}>
              Done
            </button>
          )}
        </div>
      </div>
      {!isDmInbox && bulkMode && (
        <BulkActionBar
          selectedCount={selectedCount}
          allSelected={allSelected}
          onToggleAll={onToggleAll}
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
              bulkMode={bulkMode}
              onStartSelect={onEnterBulk}
              onRowMarkRead={onRowMarkRead}
              onRowMarkUnread={onRowMarkUnread}
              onRowDelete={onRowDelete}
            />
          );

          // Channels inbox: split into "Your channels" (created by current user) on top + the rest below.
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
                      <span>Your channels</span>
                      <span className="thread-section-count">{owned.length}</span>
                    </div>
                    {ownedSplit.pinned.map(renderRow)}
                    {ownedSplit.rest.map(renderRow)}
                  </>
                )}
                {others.length > 0 && (
                  <>
                    <div className="thread-section-header thread-section-header-muted">
                      <span>Team channels</span>
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
