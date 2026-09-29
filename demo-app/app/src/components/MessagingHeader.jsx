import { useRef, useState } from 'react';
import PopMenu from './PopMenu';
import Icon from './Icon';
import Select from './Select';
import TagPicker from './TagPicker';
import NotificationsBell from './NotificationsBell';

export const EMPTY_FILTERS = {
  channels: [],        // [] = all
  tagIds: [],          // [] = all
  dateRange: 'all',    // '24h' | '7d' | '30d' | 'all'
  logic: 'and',        // 'and' | 'or'
  starredOnly: false,  // true → only starred threads
};

const INBOXES = [
  { key: 'inbox',    label: 'Inbox' },
  { key: 'internal', label: 'Channels' },
  { key: 'dm',       label: 'DMs' },
];

const DATE_OPTIONS = [
  { value: '24h', label: 'Last 24h' },
  { value: '7d',  label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];

const CHANNEL_CHIPS = [
  { key: 'sms',      label: 'SMS' },
  { key: 'email',    label: 'Email' },
  { key: 'internal', label: 'Internal' },
  { key: 'dm',       label: 'DM' },
];

function FiltersPopover({ open, anchorRef, filters, onFiltersChange, onClose }) {
  const toggleChannel = (ch) => {
    const set = new Set(filters.channels);
    if (set.has(ch)) set.delete(ch); else set.add(ch);
    onFiltersChange({ ...filters, channels: Array.from(set) });
  };

  const anyFilter =
    filters.channels.length > 0 ||
    filters.tagIds.length > 0 ||
    filters.dateRange !== 'all' ||
    filters.starredOnly;

  return (
    <PopMenu open={open} onClose={onClose} anchorRef={anchorRef} className="filters-popover" role="dialog" aria-label="Filters" sheetTitle="Filters">
      <div className="filters-popover-head">
        <span>Filters</span>
        {anyFilter && (
          <button type="button" className="linklike" onClick={() => onFiltersChange(EMPTY_FILTERS)}>
            Clear all
          </button>
        )}
      </div>

      <div className="filters-popover-body">
        <div className="filter-block">
          <div className="filter-label">Channels</div>
          <div className="filter-chips">
            {CHANNEL_CHIPS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`chip ${filters.channels.includes(c.key) ? 'on' : ''}`}
                onClick={() => toggleChannel(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-block">
          <label className="filter-starred-row">
            <input
              type="checkbox"
              checked={filters.starredOnly}
              onChange={(e) => onFiltersChange({ ...filters, starredOnly: e.target.checked })}
            />
            <span>Pinned only</span>
          </label>
        </div>

        <div className="filter-block">
          <div className="filter-label">Tags</div>
          <TagPicker
            value={filters.tagIds}
            onChange={(ids) => onFiltersChange({ ...filters, tagIds: ids })}
            canCreate={false}
            placeholder="Filter by tag…"
          />
        </div>

        <div className="filter-block">
          <div className="filter-label">Date range</div>
          <Select
            ariaLabel="Date range"
            value={filters.dateRange}
            onChange={(v) => onFiltersChange({ ...filters, dateRange: v })}
            options={DATE_OPTIONS}
          />
        </div>

        <div className="filter-block">
          <div className="filter-label">Combine filters</div>
          <div className="segmented">
            {['and', 'or'].map((v) => (
              <button
                key={v}
                type="button"
                className={`segmented-btn ${filters.logic === v ? 'active' : ''}`}
                onClick={() => onFiltersChange({ ...filters, logic: v })}
              >
                {v === 'and' ? 'Match all' : 'Match any'}
              </button>
            ))}
          </div>
        </div>
      </div>
    </PopMenu>
  );
}

export default function MessagingHeader({
  selectedInbox,
  onInboxChange,
  unread = {},
  filters,
  onFiltersChange,
  canStart,
  canStartInternalThread,
  onNewConversation,
  onNewDm,
  onNewInternalThread,
  visibleInboxes,
  // Super-Admin-only orphan maintenance. Count comes from the parent so this
  // header stays presentation-focused; 0 hides the entry point entirely.
  orphanCount = 0,
  onOpenOrphans,
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersWrapRef = useRef(null);

  const anyFilter =
    filters.channels.length > 0 ||
    filters.tagIds.length > 0 ||
    filters.dateRange !== 'all' ||
    filters.starredOnly;

  return (
    <header className="messaging-header">
      <div className="messaging-inbox-toggle" role="tablist" aria-label="Inbox">
        {(visibleInboxes || INBOXES).map((ib) => {
          const active = selectedInbox === ib.key;
          const count = unread[ib.key] || 0;
          return (
            <button
              key={ib.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={`inbox-toggle-btn ${active ? 'active' : ''}`}
              onClick={() => onInboxChange(ib.key)}
            >
              <span>{ib.label}</span>
              {count > 0 && <span className="inbox-toggle-unread">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="messaging-header-actions">
        <div className="filters-wrap" ref={filtersWrapRef}>
          <button
            type="button"
            className={`btn btn-success ${anyFilter ? 'has-active-filter' : ''}`}
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
          >
            <Icon name="filter" size={14} />
            <span>Filters</span>
            {anyFilter && <span className="filter-active-dot" aria-label="filters active" />}
          </button>
          <FiltersPopover
            open={filtersOpen}
            anchorRef={filtersWrapRef}
            filters={filters}
            onFiltersChange={onFiltersChange}
            onClose={() => setFiltersOpen(false)}
          />
        </div>

        {selectedInbox === 'dm' && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onNewDm}
            title="Start a direct message with another user"
          >
            <span>New DM</span>
          </button>
        )}
        {selectedInbox === 'internal' && orphanCount > 0 && onOpenOrphans && (
          <button
            type="button"
            className="btn btn-outline"
            onClick={onOpenOrphans}
            title="Channels whose creator was removed or is no longer active"
          >
            <Icon name="warning" size={14} />
            <span>Orphaned ({orphanCount})</span>
          </button>
        )}
        {selectedInbox === 'internal' && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onNewInternalThread}
            disabled={!canStartInternalThread}
            title={canStartInternalThread ? 'Start a new channel' : 'You lack permission to start channels'}
          >
            <span>New channel</span>
          </button>
        )}
        {selectedInbox === 'inbox' && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onNewConversation}
            disabled={!canStart}
            title={canStart ? 'Start a new conversation' : 'You lack permission to start conversations'}
          >
            <span>New conversation</span>
          </button>
        )}
        {/* Notifications bell lives in the header on mobile (CSS-shown ≤640) so it
            no longer floats over the top bar; the global .bell-floater is hidden
            on mobile messaging. Desktop keeps the floater. */}
        <NotificationsBell className="msg-inbox-bell" />
      </div>
    </header>
  );
}
