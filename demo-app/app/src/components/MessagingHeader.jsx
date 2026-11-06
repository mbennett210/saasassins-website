import { useRef, useState } from 'react';
import PopMenu from './PopMenu';
import Icon from './Icon';
import Select from './Select';
import TagPicker from './TagPicker';
import NotificationsBell from './NotificationsBell';
import { useT } from '../i18n/react';

export const EMPTY_FILTERS = {
  channels: [],        // [] = all
  tagIds: [],          // [] = all
  dateRange: 'all',    // '24h' | '7d' | '30d' | 'all'
  logic: 'and',        // 'and' | 'or'
  starredOnly: false,  // true → only starred threads
};

// Labels are catalog keys, shown in the reader's language (CS-193).
const INBOXES = [
  { key: 'inbox',    labelKey: 'messages.inbox' },
  { key: 'internal', labelKey: 'messages.channels' },
  { key: 'dm',       labelKey: 'messages.dms' },
];

const DATE_OPTIONS = [
  { value: '24h', labelKey: 'messages.date.24h' },
  { value: '7d',  labelKey: 'messages.date.7d' },
  { value: '30d', labelKey: 'messages.date.30d' },
  { value: 'all', labelKey: 'messages.date.all' },
];

const CHANNEL_CHIPS = [
  { key: 'sms',      labelKey: 'messages.channel.sms' },
  { key: 'email',    labelKey: 'messages.channel.email' },
  { key: 'internal', labelKey: 'messages.channel.internal' },
  { key: 'dm',       labelKey: 'messages.channel.dm' },
];

function FiltersPopover({ open, anchorRef, filters, onFiltersChange, onClose }) {
  const t = useT();
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
    <PopMenu open={open} onClose={onClose} anchorRef={anchorRef} className="filters-popover" role="dialog" aria-label={t('messages.filters')} sheetTitle={t('messages.filters')}>
      <div className="filters-popover-head">
        <span>{t('messages.filters')}</span>
        {anyFilter && (
          <button type="button" className="linklike" onClick={() => onFiltersChange(EMPTY_FILTERS)}>
            {t('messages.clearAll')}
          </button>
        )}
      </div>

      <div className="filters-popover-body">
        <div className="filter-block">
          <div className="filter-label">{t('messages.filter.channels')}</div>
          <div className="filter-chips">
            {CHANNEL_CHIPS.map((c) => (
              <button
                key={c.key}
                type="button"
                className={`chip ${filters.channels.includes(c.key) ? 'on' : ''}`}
                onClick={() => toggleChannel(c.key)}
              >
                {t(c.labelKey)}
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
            <span>{t('messages.filter.pinnedOnly')}</span>
          </label>
        </div>

        <div className="filter-block">
          <div className="filter-label">{t('messages.filter.tags')}</div>
          <TagPicker
            value={filters.tagIds}
            onChange={(ids) => onFiltersChange({ ...filters, tagIds: ids })}
            canCreate={false}
            placeholder={t('messages.filter.tagPlaceholder')}
          />
        </div>

        <div className="filter-block">
          <div className="filter-label">{t('messages.filter.dateRange')}</div>
          <Select
            ariaLabel={t('messages.filter.dateRange')}
            value={filters.dateRange}
            onChange={(v) => onFiltersChange({ ...filters, dateRange: v })}
            options={DATE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
          />
        </div>

        <div className="filter-block">
          <div className="filter-label">{t('messages.filter.combine')}</div>
          <div className="segmented">
            {['and', 'or'].map((v) => (
              <button
                key={v}
                type="button"
                className={`segmented-btn ${filters.logic === v ? 'active' : ''}`}
                onClick={() => onFiltersChange({ ...filters, logic: v })}
              >
                {v === 'and' ? t('messages.filter.matchAll') : t('messages.filter.matchAny')}
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
  const t = useT();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersWrapRef = useRef(null);

  const anyFilter =
    filters.channels.length > 0 ||
    filters.tagIds.length > 0 ||
    filters.dateRange !== 'all' ||
    filters.starredOnly;

  return (
    <header className="messaging-header">
      <div className="messaging-inbox-toggle" role="tablist" aria-label={t('messages.inbox')}>
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
              <span>{t(ib.labelKey)}</span>
              {count > 0 && <span className="inbox-toggle-unread">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="messaging-header-actions">
        {/* The Customers tab (client hub redesign) filters its own list by Manager and Customer,
            server-side; these channel/tag/date filters are the store inboxes'. */}
        {selectedInbox !== 'customers' && (
        <div className="filters-wrap" ref={filtersWrapRef}>
          <button
            type="button"
            className={`btn btn-success ${anyFilter ? 'has-active-filter' : ''}`}
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
          >
            <Icon name="filter" size={14} />
            <span>{t('messages.filters')}</span>
            {anyFilter && <span className="filter-active-dot" aria-label={t('messages.filtersActive')} />}
          </button>
          <FiltersPopover
            open={filtersOpen}
            anchorRef={filtersWrapRef}
            filters={filters}
            onFiltersChange={onFiltersChange}
            onClose={() => setFiltersOpen(false)}
          />
        </div>
        )}

        {selectedInbox === 'dm' && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onNewDm}
            title={t('messages.newDmTitle')}
          >
            <span>{t('messages.newDm')}</span>
          </button>
        )}
        {selectedInbox === 'internal' && orphanCount > 0 && onOpenOrphans && (
          <button
            type="button"
            className="btn btn-outline"
            onClick={onOpenOrphans}
            title={t('messages.orphanedTitle')}
          >
            <Icon name="warning" size={14} />
            <span>{t('messages.orphaned', { count: orphanCount })}</span>
          </button>
        )}
        {selectedInbox === 'internal' && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onNewInternalThread}
            disabled={!canStartInternalThread}
            title={canStartInternalThread ? t('messages.newChannelTitle') : t('messages.noChannelPermission')}
          >
            <span>{t('messages.newChannel')}</span>
          </button>
        )}
        {selectedInbox === 'inbox' && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={onNewConversation}
            disabled={!canStart}
            title={canStart ? t('messages.newConversationTitle') : t('messages.noConversationPermission')}
          >
            <span>{t('messages.newConversation')}</span>
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
