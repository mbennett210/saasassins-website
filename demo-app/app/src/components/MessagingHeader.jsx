import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import Select from './Select';
import TagPicker from './TagPicker';

export const EMPTY_FILTERS = {
  channels: [],        // [] = all
  tagIds: [],          // [] = all
  dateRange: 'all',    // '24h' | '7d' | '30d' | 'all'
  logic: 'and',        // 'and' | 'or'
  statuses: [],        // [] = all statuses (subset of 'open' | 'snoozed' | 'closed')
  starredOnly: false,  // true → only starred threads
};

const INBOXES = [
  { key: 'inbox',    label: 'Inbox' },
  { key: 'internal', label: 'Threads' },
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

const STATUS_CHIPS = [
  { key: 'open',    label: 'Open' },
  { key: 'snoozed', label: 'Snoozed' },
  { key: 'closed',  label: 'Closed' },
];

function FiltersPopover({ filters, onFiltersChange, onClose }) {
  const wrapRef = useRef(null);

  useEffect(() => {
    const onClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const toggleChannel = (ch) => {
    const set = new Set(filters.channels);
    if (set.has(ch)) set.delete(ch); else set.add(ch);
    onFiltersChange({ ...filters, channels: Array.from(set) });
  };
  const toggleStatus = (st) => {
    const set = new Set(filters.statuses);
    if (set.has(st)) set.delete(st); else set.add(st);
    onFiltersChange({ ...filters, statuses: Array.from(set) });
  };

  const anyFilter =
    filters.channels.length > 0 ||
    filters.tagIds.length > 0 ||
    filters.dateRange !== 'all' ||
    filters.statuses.length > 0 ||
    filters.starredOnly;

  return (
    <div className="filters-popover" ref={wrapRef} role="dialog" aria-label="Filters">
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
                className={`filter-chip ${filters.channels.includes(c.key) ? 'on' : ''}`}
                onClick={() => toggleChannel(c.key)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="filter-block">
          <div className="filter-label">Status</div>
          <div className="filter-chips">
            {STATUS_CHIPS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`filter-chip ${filters.statuses.includes(c.key) ? 'on' : ''}`}
                onClick={() => toggleStatus(c.key)}
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
          <div className="segmented segmented-sm">
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
    </div>
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
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);

  const anyFilter =
    filters.channels.length > 0 ||
    filters.tagIds.length > 0 ||
    filters.dateRange !== 'all' ||
    filters.statuses.length > 0 ||
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
        <div className="filters-wrap">
          <button
            type="button"
            className={`btn btn-success btn-sm ${anyFilter ? 'has-active-filter' : ''}`}
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
          >
            <Icon name="filter" size={14} />
            <span>Filters</span>
            {anyFilter && <span className="filter-active-dot" aria-label="filters active" />}
          </button>
          {filtersOpen && (
            <FiltersPopover
              filters={filters}
              onFiltersChange={onFiltersChange}
              onClose={() => setFiltersOpen(false)}
            />
          )}
        </div>

        {selectedInbox === 'dm' && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onNewDm}
            title="Start a direct message with another user"
          >
            <span>New DM</span>
          </button>
        )}
        {selectedInbox === 'internal' && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onNewInternalThread}
            disabled={!canStartInternalThread}
            title={canStartInternalThread ? 'Start a new team thread' : 'You lack permission to start threads'}
          >
            <span>New thread</span>
          </button>
        )}
        {selectedInbox === 'inbox' && (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onNewConversation}
            disabled={!canStart}
            title={canStart ? 'Start a new conversation' : 'You lack permission to start conversations'}
          >
            <span>New conversation</span>
          </button>
        )}
      </div>
    </header>
  );
}
