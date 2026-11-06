// Key check-in/check-out — physical keys belong to a customer's location (the company
// is derived from it), grouped by company in the list with a Location column per row. Any staff
// can check keys in/out (keys.checkout); admins manage the inventory (keys.manage).
// Crew see only the keys currently checked out to them; managers see all.
// Every action is timestamped + attributed to the acting user, with full history.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useDismissTap } from '../hooks/useDismissTap';
import Icon from '../components/Icon';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import MobileSheet from '../components/MobileSheet';
import FormField from '../components/FormField';
import FilterSelect from '../components/FilterSelect';
import ClientNamePicker from '../components/ClientNamePicker';
import ConfirmDialog from '../components/ConfirmDialog';
import { useIsMobile } from '../hooks/useIsMobile';
import { useStore, useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectKeys, selectKeysByClient, selectKeyEventsForKey, selectActiveUsers, selectUserById, selectSitesForClient, selectSiteById, selectVisibleClientsFor } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { savedMsg } from '../lib/offlineCopy';
import { usePagedRows } from '../hooks/usePagedRows';
import { makeKeyScope } from '../lib/keyScope';
import { personOptions } from '../lib/pickerOptions';
import ListPager from '../components/ListPager';
import { useT } from '../i18n/react';
import { timeAgoLong } from '../i18n/relative';
import { fmtDate, fmtTime } from '../lib/dates';

// LANGUAGES (CS-193): a key screen a cleaner works from — every word is a catalog line, in
// their language. Key names, notes and holders' names are people's own words, shown as typed.
//
// Status → badge. `unknown` is the soft "whereabouts unclear" signal (yellow);
// `lost` is the harder confirmed-gone signal (red). Any status not in this map
// buckets as `unknown` everywhere it's read (counts/filter/menu).
const STATUS = {
  in: { variant: 'green', labelKey: 'keyPage.status.in' },
  out: { variant: 'amber', labelKey: 'keyPage.status.out' },
  unknown: { variant: 'yellow', labelKey: 'keyPage.status.unknown' },
  lost: { variant: 'red', labelKey: 'keyPage.status.lost' },
};

function holderLabel(state, k, t) {
  // Fall back to the denormalized heldByName before "Unknown user" — a deleted
  // holder's name is exactly what an admin chasing a physical key needs.
  if (k.heldByUserId) return selectUserById(state, k.heldByUserId)?.name || k.heldByName || t('messages.unknownUser');
  if (k.heldByName) return k.heldByName;
  return '—';
}
// A moment in the ORG's zone and the reader's locale (lib/dates), e.g. "Oct 3, 2026, 9:30 PM".
const dt = (iso) => (iso ? `${fmtDate(iso, { month: 'short', day: 'numeric', year: 'numeric' })}, ${fmtTime(iso)}` : '');

// Human duration between a checkout and its check-in — "45 min", "3 hrs", "6 days".
const heldFor = (ms, t) => {
  const m = Math.floor(ms / 60000);
  if (m < 60) return t('keyPage.held.min', { count: Math.max(m, 1) });
  const h = Math.floor(m / 60);
  if (h < 24) return t('keyPage.held.hr', { count: h });
  const d = Math.floor(h / 24);
  return t('keyPage.held.day', { count: d });
};

export default function Keys() {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const online = useOnlineStatus(); // key actions dispatch into the store; offline they buffer + sync
  const { currentUser } = useAuth();
  const canManage = usePermission('keys.manage');
  const canCheckout = usePermission('keys.checkout');
  const users = selectActiveUsers(state);

  // NOTE: keys have NO return window and NO due-back date/time. There is no overdue
  // concept here by design (removed 2026-07-22) — a key stays checked out until
  // someone checks it back in, and that is not a condition anyone is alerted about.
  // Crew see keys for the companies they're ASSIGNED to plus any key in their own hands;
  // managers / owners see every key. The rule is lib/keyScope (shared with
  // selectVisibleKeysFor and global search) so a key hidden here can't surface elsewhere.
  const isCrew = currentUser?.role === 'crew';
  const inBaseScope = makeKeyScope(currentUser, isCrew ? selectVisibleClientsFor(state, currentUser) : null);
  // Keys the user just actioned stay visible for the session even if the action
  // dropped them out of scope (check-in / hand-off at a non-assigned company
  // clears heldByUserId → the row would vanish mid-tap and read as a misfire,
  // with its History unreachable — CREW_AUDIT #12).
  const [recentKeyIds, setRecentKeyIds] = useState(() => new Set());
  const markRecent = (id) => setRecentKeyIds((prev) => { const n = new Set(prev); n.add(id); return n; });
  const keyInScope = (k) => recentKeyIds.has(k.id) || inBaseScope(k);
  const groups = selectKeysByClient(state)
    .map((g) => ({ ...g, keys: g.keys.filter(keyInScope) }))
    .filter((g) => g.keys.length > 0);
  const allKeys = selectKeys(state).filter(keyInScope);

  // Custody guard: changing a key's custody (check-in, hand-off, mark
  // unknown/lost) all act on the CURRENT holder, so a key checked out to another
  // TEAM MEMBER is read-only for a crew user — this is what stops Kayla from
  // checking in a key that Latisha still physically holds. Managers/owners keep
  // full control. Only internal-user holds lock: a key out to an external party
  // (client, contractor — no heldByUserId) stays actionable so whoever retrieves
  // it can log the return, and taking an available (In/Unknown/Lost) key is never
  // locked. A crew member's OWN held key is theirs to check in.
  const lockedToOtherHolder = (k) => !canManage && !!k.heldByUserId && k.heldByUserId !== currentUser?.id;

  const [checkoutKey, setCheckoutKey] = useState(null);
  const [historyKey, setHistoryKey] = useState(null);
  const [editKey, setEditKey] = useState(null); // {} = new, {id,...} = edit
  // Global search "Add key" deep-link: ?new=1 opens the add-key modal once, then strips it.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') && canManage) {
      setEditKey({});
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, canManage, setSearchParams]);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [unknownKey, setUnknownKey] = useState(null);
  const [lostKey, setLostKey] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [query, setQuery] = useState('');

  // Discovery over 180+ keys: status chips (with live counts) + a search box
  // matching client, key label, master code, or current holder. Groups with no
  // matching keys drop out of the list.
  const counts = { all: allKeys.length, in: 0, out: 0, unknown: 0, lost: 0 };
  for (const k of allKeys) counts[STATUS[k.status] ? k.status : 'unknown'] += 1;
  const q = query.trim().toLowerCase();
  const matches = (k, clientName) => {
    if (statusFilter !== 'all' && (STATUS[k.status] ? k.status : 'unknown') !== statusFilter) return false;
    if (!q) return true;
    return [clientName, k.siteName, k.label, k.masterCode, k.notes, holderLabel(state, k, t)]
      .some((v) => (v || '').toLowerCase().includes(q));
  };
  const filteredGroups = groups
    .map((g) => ({ ...g, keys: g.keys.filter((k) => matches(k, g.clientName)) }))
    .filter((g) => g.keys.length > 0);

  function doCheckin(k) {
    markRecent(k.id);
    dispatch({ type: ACTIONS.CHECKIN_KEY, keyId: k.id });
    toast.success(savedMsg(online, t('keyPage.checkedIn', { key: k.label || t('keyPage.aKey') }), t('offline.savedOnDevice')));
  }

  // Shared by the table row + mobile card: the status badge becomes a menu
  // (In / Out / Unknown / Lost) for anyone who can check keys in/out. "In"
  // checks the key in, "Out" runs the normal check-out (holder picker),
  // "Unknown"/"Lost" open a confirm with an optional note — every path lands in
  // the key's History. Locked to a read-only badge when the key is out to
  // another team member and the viewer is crew (see lockedToOtherHolder).
  const statusMenu = (k) => (
    <KeyStatusMenu
      keyRec={k}
      canEdit={canCheckout}
      readOnly={lockedToOtherHolder(k)}
      onSetIn={() => doCheckin(k)}
      onSetOut={() => setCheckoutKey(k)}
      onMarkUnknown={() => setUnknownKey(k)}
      onMarkLost={() => setLostKey(k)}
    />
  );

  return (
    <div className="page">
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>{t('keyPage.title')}</h1>
        </div>
        {canManage && (
          <button className="btn btn-primary" onClick={() => setEditKey({})}>{t('keyPage.addKey')}</button>
        )}
      </div>

      {groups.length > 0 && (
        <div className="keys-filter-bar">
          <input
            className="input keys-filter-search"
            placeholder={t('keyPage.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="keys-filter-chips">
            {[['all', 'keyPage.status.all'], ['in', 'keyPage.status.in'], ['out', 'keyPage.status.out'], ['unknown', 'keyPage.status.unknown'], ['lost', 'keyPage.status.lost']].map(([key, labelKey]) => (
              <button
                key={key}
                type="button"
                className={`chip ${statusFilter === key ? 'on' : ''}`}
                onClick={() => setStatusFilter(key)}
              >
                {t(labelKey)} <span className="control-count">{counts[key]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--color-neutral-500)' }}>
          {isCrew ? t('keyPage.emptyCrew') : canManage ? t.rich('keyPage.emptyManage') : t('keyPage.empty')}
        </div>
      ) : filteredGroups.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--color-neutral-500)' }}>
          {(() => {
            const status = statusFilter !== 'all' ? (STATUS[statusFilter] ? t(STATUS[statusFilter].labelKey) : statusFilter) : null;
            if (q && status) return t.rich('keyPage.noMatchBoth', { query: query.trim(), status });
            if (q) return t.rich('keyPage.noMatchQuery', { query: query.trim() });
            if (status) return t.rich('keyPage.noMatchStatus', { status });
            return t('keyPage.noMatch');
          })()}
        </div>
      ) : (
        filteredGroups.map((g) => (
          <KeyGroup
            key={g.clientName}
            group={g}
            state={state}
            canManage={canManage}
            canCheckout={canCheckout}
            statusMenu={statusMenu}
            lockedToOtherHolder={lockedToOtherHolder}
            doCheckin={doCheckin}
            setCheckoutKey={setCheckoutKey}
            setHistoryKey={setHistoryKey}
            setEditKey={setEditKey}
            setConfirmDelete={setConfirmDelete}
            resetKey={`${q}|${statusFilter}`}
          />
        ))
      )}

      {checkoutKey && (
        <CheckOutModal
          keyRec={checkoutKey}
          users={users}
          defaultUserId={currentUser?.id}
          onClose={() => setCheckoutKey(null)}
          onConfirm={({ holderUserId, holderName, note }) => {
            markRecent(checkoutKey.id);
            dispatch({ type: ACTIONS.CHECKOUT_KEY, keyId: checkoutKey.id, holderUserId, holderName, note });
            toast.success(savedMsg(online, t('keyPage.checkedOut', { key: checkoutKey.label || t('keyPage.aKey') }), t('offline.savedOnDevice')));
            setCheckoutKey(null);
          }}
        />
      )}

      {historyKey && (
        <Modal open onClose={() => setHistoryKey(null)} title={t('keyPage.historyTitle', { key: historyKey.label || t('keyPage.aKey') })}>
          <KeyHistory state={state} keyId={historyKey.id} />
        </Modal>
      )}

      {unknownKey && (
        <MarkStatusModal
          keyRec={unknownKey}
          status="unknown"
          onClose={() => setUnknownKey(null)}
          onConfirm={(note) => {
            markRecent(unknownKey.id);
            dispatch({ type: ACTIONS.MARK_KEY_UNKNOWN, keyId: unknownKey.id, note });
            toast.success(savedMsg(online, t('keyPage.markedUnknown', { key: unknownKey.label || t('keyPage.aKey') }), t('offline.savedOnDevice')));
            setUnknownKey(null);
          }}
        />
      )}

      {lostKey && (
        <MarkStatusModal
          keyRec={lostKey}
          status="lost"
          onClose={() => setLostKey(null)}
          onConfirm={(note) => {
            markRecent(lostKey.id);
            dispatch({ type: ACTIONS.MARK_KEY_LOST, keyId: lostKey.id, note });
            toast.success(savedMsg(online, t('keyPage.reportedLost', { key: lostKey.label || t('keyPage.aKey') }), t('offline.savedOnDevice')));
            setLostKey(null);
          }}
        />
      )}

      {editKey && (
        <EditKeyModal
          keyRec={editKey}
          onClose={() => setEditKey(null)}
          onSave={(patch) => {
            if (editKey.id) {
              // Summarize what changed so the History entry is meaningful. The words are written INTO
              // the key's record (its history note), so they stay English like the activity log.
              // i18n-ok: stored record text, not screen words
              const labels = { clientName: 'company', siteName: 'location', label: 'key label', masterCode: 'master code', notes: 'notes' };
              const changed = Object.keys(labels).filter((f) => (patch[f] ?? '') !== (editKey[f] ?? '')).map((f) => labels[f]);
              dispatch({ type: ACTIONS.UPDATE_KEY, id: editKey.id, patch, note: changed.length ? `changed ${changed.join(', ')}` : null });
            } else {
              dispatch({ type: ACTIONS.ADD_KEY, key: patch });
            }
            toast.success(savedMsg(online, editKey.id ? t('keyPage.updated') : t('keyPage.added'), t('offline.savedOnDevice')));
            setEditKey(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={t('keyPage.deleteTitle', { key: confirmDelete?.label || t('keyPage.thisKey') })}
        message={t('keyPage.deleteMessage')}
        confirmLabel={t('keyPage.delete')}
        variant="danger"
        onConfirm={() => {
          dispatch({ type: ACTIONS.DELETE_KEY, id: confirmDelete.id });
          toast.success(savedMsg(online, t('keyPage.deletedToast', { key: confirmDelete.label || t('keyPage.aKey') }), t('offline.savedOnDevice')));
          setConfirmDelete(null);
        }}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}

// One company's key group — its own table + mobile cards, paged locally at 20
// (UI_RULES §50). Extracted to a child component so each group gets its OWN
// usePagedRows: a hook can't be called inside the parent's filteredGroups.map,
// and every group's key count is otherwise an unbounded tbody. The "N keys"
// title + the page-level status counts still read the FULL group/allKeys sets.
function KeyGroup({
  group, state, canManage, canCheckout, statusMenu, lockedToOtherHolder,
  doCheckin, setCheckoutKey, setHistoryKey, setEditKey, setConfirmDelete, resetKey,
}) {
  const t = useT();
  const pager = usePagedRows(group.keys, { resetKey });
  return (
    // Container hygiene (UI Rule 1): no .card wrapper — the heading stands
    // alone and .table-wrap carries its own border/shadow/margin.
    <div className="keys-group">
      <h3 className="keys-group-title">
        {group.clientName} <span className="keys-group-count">· {t('keyPage.groupCount', { count: group.keys.length })}</span>
      </h3>
      <div className="table-wrap">
        {/* Fixed column geometry (colgroup + .keys-table) so the Key /
            Master / Status / Held-by columns line up across every client
            card, not per-table. */}
        <table className="keys-table">
          <colgroup>
            <col />
            <col style={{ width: 190 }} />
            <col style={{ width: 110 }} />
            <col style={{ width: 112 }} />
            <col style={{ width: 170 }} />
            <col style={{ width: 250 }} />
          </colgroup>
          <thead><tr><th>{t('keyPage.col.key')}</th><th>{t('keyPage.col.location')}</th><th>{t('keyPage.col.master')}</th><th>{t('keyPage.col.status')}</th><th>{t('keyPage.col.heldBy')}</th><th></th></tr></thead>
          <tbody>
            {pager.pageRows.map((k) => {
              const addr = selectSiteById(state, k.siteId)?.address;
              return (
                <tr key={k.id}>
                  <td style={{ fontWeight: 600 }}>{k.label || '—'}{k.notes ? <div className="text-xs text-muted" style={{ fontWeight: 400 }}>{k.notes}</div> : null}</td>
                  <td>{addr || <span className="text-muted">{t('keyPage.unassigned')}</span>}</td>
                  <td>{k.masterCode || '—'}</td>
                  <td>{statusMenu(k)}</td>
                  <td>{holderLabel(state, k, t)}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {canCheckout && k.status !== 'out' && <button className="btn btn-link btn-sm" onClick={() => setCheckoutKey(k)}>{t('keyPage.checkOut')}</button>}
                    {canCheckout && k.status === 'out' && !lockedToOtherHolder(k) && <button className="btn btn-link btn-sm" onClick={() => doCheckin(k)}>{t('keyPage.checkIn')}</button>}
                    <button className="btn btn-link btn-sm" onClick={() => setHistoryKey(k)}>{t('keyPage.history')}</button>
                    {canManage && <button className="btn btn-link btn-sm" onClick={() => setEditKey(k)}>{t('keyPage.edit')}</button>}
                    {canManage && <button className="btn-icon keys-key-delete" title={t('keyPage.delete')} onClick={() => setConfirmDelete(k)}><Icon name="trash" size={15} /></button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* Mobile: .table-wrap is display:none under 640px (global rule), so
          render the standard .mobile-card-list. One card per key with the
          full detail set + actions. */}
      <div className="mobile-card-list">
        {pager.pageRows.map((k) => {
          const addr = selectSiteById(state, k.siteId)?.address;
          return (
            <div key={k.id} className="mobile-card" style={{ cursor: 'default' }}>
              <div className="mc-name">{k.label || '—'}</div>
              <div className="mc-sub">
                {addr || t('keyPage.unassigned')}
                {k.masterCode ? ` · ${t('keyPage.master', { code: k.masterCode })}` : ''}
                {k.notes ? ` · ${k.notes}` : ''}
              </div>
              <div className="mc-meta">
                {statusMenu(k)}
                {k.status === 'out' && <span className="text-xs text-muted">{t('keyPage.heldBy', { name: holderLabel(state, k, t) })}</span>}
                {canCheckout && k.status !== 'out' && <button className="btn btn-link" onClick={() => setCheckoutKey(k)}>{t('keyPage.checkOut')}</button>}
                {canCheckout && k.status === 'out' && !lockedToOtherHolder(k) && <button className="btn btn-link" onClick={() => doCheckin(k)}>{t('keyPage.checkIn')}</button>}
                <button className="btn btn-link" onClick={() => setHistoryKey(k)}>{t('keyPage.history')}</button>
                {canManage && <button className="btn btn-link" onClick={() => setEditKey(k)}>{t('keyPage.edit')}</button>}
                {canManage && <button className="btn-icon keys-key-delete" title={t('keyPage.delete')} onClick={() => setConfirmDelete(k)}><Icon name="trash" size={15} /></button>}
              </div>
            </div>
          );
        })}
      </div>
      <ListPager pager={pager} noun={t('keyPage.noun')} />
    </div>
  );
}

// Holder can be a team member OR anyone else by name (client, contractor,
// building manager…) — the live data is full of external holders, so the
// picker must be able to record them, not just the internal team. Re-used for
// hand-offs while a key is already out (logs a fresh checkout event).
// The team is the searchable, capped picker, by name (UI_RULES §127; CS-713: a plain select of
// every login in the order added — 1,541 at Matt's size). "Someone else" is its FIRST row, which
// the picker keeps on screen while typing, so an outside holder is always one tap away.
const OTHER_HOLDER = '__other';

function CheckOutModal({ keyRec, users, defaultUserId, onClose, onConfirm }) {
  const t = useT();
  const people = useMemo(() => personOptions(users), [users]);
  const holderOptions = useMemo(() => [{ value: OTHER_HOLDER, label: t('keyPage.someoneElse') }, ...people], [people, t]);
  // The opener when they are on the team, else the first name, else someone else — never an id
  // the picker cannot show.
  const [userId, setUserId] = useState(() => (people.some((o) => o.value === defaultUserId) ? defaultUserId : (people[0]?.value ?? OTHER_HOLDER)));
  const [otherName, setOtherName] = useState('');
  const [note, setNote] = useState('');
  const isOther = userId === OTHER_HOLDER;
  const valid = isOther ? otherName.trim().length > 0 : Boolean(userId);
  const handoff = keyRec.status === 'out';
  return (
    <Modal open onClose={onClose} title={t('keyPage.checkoutTitle', { action: handoff ? t('keyPage.handOff') : t('keyPage.checkOut'), key: keyRec.label || t('keyPage.aKey') })}>
      {handoff && (
        <p className="text-muted" style={{ marginTop: 0 }}>
          {t('keyPage.handoffNote')}
        </p>
      )}
      <FormField label={t('keyPage.whoTakes')}>
        <FilterSelect value={userId} onChange={setUserId} options={holderOptions} ariaLabel={t('keyPage.whoTakes')} />
      </FormField>
      {isOther && (
        <FormField
          label={t('keyPage.theirName')} required value={otherName}
          onChange={(e) => setOtherName(e.target.value)} placeholder={t('keyPage.theirNamePlaceholder')}
        />
      )}
      <FormField label={t('keyPage.noteOptional')} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('keyPage.notePlaceholder')} />
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        <button
          type="button" className="btn btn-primary" disabled={!valid}
          onClick={() => onConfirm(isOther
            ? { holderUserId: null, holderName: otherName.trim(), note: note.trim() }
            : { holderUserId: userId, note: note.trim() })}
        >
          {handoff ? t('keyPage.handOff') : t('keyPage.checkOut')}
        </button>
      </div>
    </Modal>
  );
}

// Status badge that opens a small In / Out / Unknown menu for users with
// keys.checkout. Read-only badge for everyone else. "Out" defers to the
// check-out flow (holder picker) — and stays available while a key is out so a
// direct hand-off logs a true checkout event instead of a phantom check-in.
// The popover renders through a portal with fixed positioning: the keys table
// cells clip overflow (.keys-table td + .table-wrap), so an in-cell absolute
// menu would be invisible on desktop.
const MENU_W = 300; // keep in sync with .key-status-menu width in index.css
const MENU_H = 160; // approx (4 items); used only to flip upward near the viewport bottom

function KeyStatusMenu({ keyRec, canEdit, readOnly, onSetIn, onSetOut, onMarkUnknown, onMarkLost }) {
  const t = useT();
  const isMobile = useIsMobile();
  const [pos, setPos] = useState(null); // desktop popover: {top,left} viewport coords; null = closed
  const [sheetOpen, setSheetOpen] = useState(false); // mobile bottom-sheet (R9)
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const st = STATUS[keyRec.status] || STATUS.unknown;
  const open = pos !== null;

  // Desktop-only portaled popover: outside tap / Escape dismiss, sparing the trigger
  // (wrapRef) and the portaled menu (menuRef). UI_RULES §100 — the dismiss tap is eaten.
  useDismissTap({ open, ref: wrapRef, ref2: menuRef, onDismiss: () => setPos(null) });

  // Any scroll/resize detaches the fixed popover coords — just close.
  useEffect(() => {
    if (!open) return undefined;
    const onMove = () => setPos(null);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open]);

  // Read-only badge when the user can't check keys in/out at all, OR when the key
  // is out to another team member and this (crew) user isn't allowed to touch its
  // custody — the same guard that hides their Check-in button.
  if (!canEdit || readOnly) return <Badge variant={st.variant}>{t(st.labelKey)}</Badge>;

  const toggle = (e) => {
    // Mobile (R9): open the shared bottom-sheet instead of an anchored popover
    // that spills off its trigger near the viewport edge.
    if (isMobile) { setSheetOpen(true); return; }
    if (open) { setPos(null); return; }
    const r = e.currentTarget.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - MENU_W - 8));
    const top = r.bottom + 4 + MENU_H > window.innerHeight ? r.top - MENU_H - 4 : r.bottom + 4;
    setPos({ top, left });
  };
  const close = () => { setPos(null); setSheetOpen(false); };
  const choose = (fn) => () => { close(); fn(); };

  // Same four options on both surfaces — rendered in the desktop popover or the
  // mobile sheet so the action set can't drift between them.
  const items = (
    <>
      <button type="button" className="menu-option" role="menuitem" disabled={keyRec.status === 'in'} onClick={choose(onSetIn)}>
        <Badge variant="green">{t('keyPage.status.in')}</Badge> <span>{t('keyPage.backInLockbox')}</span>
      </button>
      <button type="button" className="menu-option" role="menuitem" onClick={choose(onSetOut)}>
        <Badge variant="amber">{t('keyPage.status.out')}</Badge> <span>{keyRec.status === 'out' ? t('keyPage.handOffSomeone') : t('keyPage.checkOutSomeone')}</span>
      </button>
      <button type="button" className="menu-option" role="menuitem" disabled={keyRec.status === 'unknown'} onClick={choose(onMarkUnknown)}>
        <Badge variant="yellow">{t('keyPage.status.unknown')}</Badge> <span>{t('keyPage.whereaboutsUnclear')}</span>
      </button>
      <button type="button" className="menu-option" role="menuitem" disabled={keyRec.status === 'lost'} onClick={choose(onMarkLost)}>
        <Badge variant="red">{t('keyPage.status.lost')}</Badge> <span>{t('keyPage.confirmedLost')}</span>
      </button>
    </>
  );

  return (
    <span className="key-status-wrap" ref={wrapRef}>
      <button
        type="button" className="badge-trigger" title={t('keyPage.setStatus')}
        aria-haspopup="menu" aria-expanded={open || sheetOpen} onClick={toggle}
      >
        <Badge variant={st.variant}>{t(st.labelKey)}</Badge>
        <span className="key-status-caret" aria-hidden>▾</span>
      </button>
      {isMobile ? (
        <MobileSheet open={sheetOpen} onClose={close} title={t('keyPage.setStatusTitle', { key: keyRec.label || t('keyPage.aKey') })}>
          <div className="key-status-sheet" role="menu">{items}</div>
        </MobileSheet>
      ) : (open && createPortal(
        <div className="key-status-menu" role="menu" ref={menuRef} style={{ top: pos.top, left: pos.left }}>
          {items}
        </div>,
        document.body
      ))}
    </span>
  );
}

// One modal for both whereabouts states — `status` is 'unknown' (soft, likely
// recoverable) or 'lost' (confirmed gone). Both clear any holder and log the
// change to the key's history; the copy + confirm label switch on which.
const MARK_COPY = {
  unknown: { titleKey: 'keyPage.unknownTitle', bodyKey: 'keyPage.unknownBody', placeholderKey: 'keyPage.unknownPlaceholder', confirmKey: 'keyPage.unknownConfirm' },
  lost: { titleKey: 'keyPage.lostTitle', bodyKey: 'keyPage.lostBody', placeholderKey: 'keyPage.lostPlaceholder', confirmKey: 'keyPage.lostConfirm' },
};

function MarkStatusModal({ keyRec, status, onClose, onConfirm }) {
  const t = useT();
  const [note, setNote] = useState('');
  const copy = MARK_COPY[status] || MARK_COPY.unknown;
  return (
    <Modal open onClose={onClose} title={t(copy.titleKey, { key: keyRec.label || t('keyPage.aKey') })}>
      <p className="text-muted" style={{ marginTop: 0 }}>{t(copy.bodyKey)}</p>
      <FormField label={t('keyPage.noteOptional')} value={note} onChange={(e) => setNote(e.target.value)} placeholder={t(copy.placeholderKey)} />
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary" onClick={() => onConfirm(note.trim() || null)}>{t(copy.confirmKey)}</button>
      </div>
    </Modal>
  );
}

function EditKeyModal({ keyRec, onClose, onSave }) {
  const t = useT();
  const state = useStore();
  const [form, setForm] = useState({
    clientName: keyRec.clientName || '', clientId: keyRec.clientId || null,
    siteId: keyRec.siteId || null, siteName: keyRec.siteName || '',
    masterCode: keyRec.masterCode || '', label: keyRec.label || '', notes: keyRec.notes || '',
  });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  // Every key files at the customer's single location; a company that resolves to a
  // location is required (no company-wide keys).
  const valid = form.clientName.trim() && form.label.trim() && !!form.siteId;
  return (
    <Modal open onClose={onClose} title={keyRec.id ? t('keyPage.editTitle') : t('keyPage.addTitle')}>
      <div className="form-group">
        <label className="form-label">{t('keyPage.company')} <span className="form-required">*</span></label>
        <ClientNamePicker
          value={form.clientName}
          onChange={({ name, clientId }) => {
            // Every customer has exactly one location; file the key there.
            const loc = clientId ? selectSitesForClient(state, clientId)[0] : null;
            setForm({ ...form, clientName: name, clientId, siteId: loc ? loc.id : null, siteName: loc ? loc.name : '' });
          }}
        />
        <div className="form-help">{t('keyPage.companyHelp')}</div>
      </div>
      <div className="form-group">
        <label className="form-label">{t('keyPage.location')}</label>
        <div className="form-help">{form.clientId
          ? (form.siteId ? t('keyPage.filesAt', { place: selectSiteById(state, form.siteId)?.address || t('keyPage.theLocation') }) : t('keyPage.noLocation'))
          : t('keyPage.linkCompany')}</div>
      </div>
      <div className="form-row">
        <FormField label={t('keyPage.label')} required value={form.label} onChange={set('label')} placeholder={t('keyPage.labelPlaceholder')} />
        <FormField label={t('keyPage.masterCode')} value={form.masterCode} onChange={set('masterCode')} placeholder={t('keyPage.masterPlaceholder')} />
      </div>
      <FormField label={t('keyPage.notes')} value={form.notes} onChange={set('notes')} placeholder={t('keyPage.notesPlaceholder')} />
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={!valid} onClick={() => onSave({ ...form, clientName: form.clientName.trim(), label: form.label.trim() })}>{keyRec.id ? t('common.save') : t('keyPage.addKey')}</button>
      </div>
    </Modal>
  );
}

function KeyHistory({ state, keyId }) {
  const t = useT();
  const keyRec = selectKeys(state).find((k) => k.id === keyId);
  const events = selectKeyEventsForKey(state, keyId); // newest first
  const st = STATUS[keyRec?.status] || STATUS.unknown;
  const holder = keyRec ? holderLabel(state, keyRec, t) : '—';
  const since = events[0]?.occurredAt;

  return (
    <>
      {keyRec && (
        <div className="key-history-summary">
          <Badge variant={st.variant}>{t(st.labelKey)}</Badge>
          <div>
            <div className="key-history-summary-main">
              {keyRec.status === 'out' ? t.rich('keyPage.outWith', { name: holder })
                : keyRec.status === 'in' ? t('keyPage.inLockbox')
                : keyRec.status === 'lost' ? t('keyPage.lostSummary')
                : t('keyPage.unknownSummary')}
            </div>
            {since && <div className="text-xs text-muted">{t('keyPage.since', { date: dt(since), ago: timeAgoLong(t, since) })}</div>}
          </div>
        </div>
      )}
      {events.length === 0 ? (
        <p className="text-muted">{t('keyPage.noHistory')}</p>
      ) : (
        <div className="key-history-list">
          {events.map((e, i) => {
            // A deleted actor/holder is demoted to byName/holderName (DELETE_USER), so the
            // custody trail keeps who did it; the live name wins while they exist.
            const by = (e.byUserId && selectUserById(state, e.byUserId)?.name) || e.byName || null;
            const evtHolder = (e.holderUserId && selectUserById(state, e.holderUserId)?.name) || e.holderName || null;
            const EVT = {
              checkout: { variant: 'amber', labelKey: 'keyPage.evt.checkout' },
              checkin: { variant: 'green', labelKey: 'keyPage.evt.checkin' },
              unknown: { variant: 'yellow', labelKey: 'keyPage.evt.unknown' },
              lost: { variant: 'red', labelKey: 'keyPage.evt.lost' },
              created: { variant: 'slate', labelKey: 'keyPage.evt.created' },
              edited: { variant: 'slate', labelKey: 'keyPage.evt.edited' },
            };
            const evtBadge = EVT[e.kind] || { variant: 'slate', labelKey: null };
            // How long the key was out: pair this check-in with the nearest
            // older checkout (events are newest-first).
            let held = null;
            if (e.kind === 'checkin') {
              const out = events.slice(i + 1).find((p) => p.kind === 'checkout');
              const ms = out ? new Date(e.occurredAt) - new Date(out.occurredAt) : 0;
              if (ms > 0) held = heldFor(ms, t);
            }
            return (
              <div key={e.id} className="key-history-item">
                <div className="key-history-item-head">
                  <span className="key-history-item-what">
                    <Badge variant={evtBadge.variant}>{evtBadge.labelKey ? t(evtBadge.labelKey) : e.kind}</Badge>
                    {e.kind === 'checkout' && evtHolder ? <> {t.rich('keyPage.toWhom', { name: evtHolder })}</> : null}
                    {by ? <> {t.rich('keyPage.byWhom', { name: by })}</> : null}
                    {held ? <span className="text-xs text-muted"> · {t('keyPage.outFor', { held })}</span> : null}
                  </span>
                  <span className="text-xs text-muted" style={{ whiteSpace: 'nowrap' }}>{dt(e.occurredAt)} · {timeAgoLong(t, e.occurredAt)}</span>
                </div>
                {e.note && <div className="key-history-item-meta text-xs text-muted">{e.note}</div>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
