import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Badge from './Badge';
import Icon from './Icon';
import EmptyState from './EmptyState';
import TableSearch from './TableSearch';
import ListPager from './ListPager';
import FormField from './FormField';
import FilterSelect from './FilterSelect';
import Modal from './Modal';
import TimeEntryModal, { TimeDeleteDialog, TimeRestoreDialog } from './TimeEntryModal';
import { useToast } from './Toast';
import * as timeApi from '../lib/timeApi';
import { TIME_REFUSAL_KEYS, effectiveTimeFilter } from '../lib/timeRules';
import { punchActionGate } from '../lib/filters/timeApprovals';
import { metersToFeet } from '../lib/geo';
import { useStore } from '../store';
import { useTimeScope } from '../hooks/useTimeScope';
import { GEOFENCE_REASON_KEYS } from '../lib/clockRules';
import { usePermission } from '../hooks/usePermission';
import { useFromHere } from '../hooks/useFromHere';
import { useTableSearch } from '../hooks/useTableSearch';
import { usePagedRows } from '../hooks/usePagedRows';
import { compareUsersByName } from '../lib/roles';
import { searchRows } from '../lib/searchRows';
import { fmtDate, fmtDateLong, fmtTime, todayKey, addDaysKey, startOfDayKey } from '../lib/dates';
import { fmtPunchTime } from '../lib/wallClock';
import { useT } from '../i18n/react';
import { english } from '../i18n/core';
import { errorText } from '../i18n/errors';
import { timeShort } from '../i18n/relative';

// Crew punch history for the manager Time Clock surfaces. ONE component, mounted on the
// crew-member page (TeamDetail), the job page (JobDetail) and /time (TimeClock) — each passes
// the ids that scope it. Reads timeApi.entries (GET /api/time/entries, manager-only) into
// component-local state, never the synced blob (§2.1). Renders NOTHING for non-managers: the
// endpoint 403s them anyway.
//
// W4-F (§8.4, finding 3): GET /api/time/entries is company-wide for holders of time.view, so a
// SCOPED manager's read must be constrained to their customers HERE — via effectiveTimeFilter
// (lib/timeRules). A manager with no locations, or on a customer that isn't theirs, reads NOTHING
// and shows the scope message; an empty clientIds list is never sent (the adapter/stub drop it and
// answer company-wide). Owner/admin (unscoped) are unchanged.
//
// W2-U (§8.4): the /time surface passes showFacets — a Cleaner + Customer FilterSelect
// (URL state) scoped to the manager's customers, and an Add time button; and the punch
// detail gains Delete (with a required reason) / Restore alongside Approve / Edit, the
// "Approved by <name> · <when>" line, and a who/what/why edit history. Reject is gone.
const PERIODS = [
  { value: '7d', labelKey: 'timeClock.period.7d', days: 7 },
  { value: '30d', labelKey: 'timeClock.period.30d', days: 30 },
  { value: '90d', labelKey: 'timeClock.period.90d', days: 90 },
];
const CAP = 500;
const DATE_OPTS = { weekday: 'short', month: 'short', day: 'numeric' };

const fmtDur = (mins) => {
  if (!Number.isFinite(mins) || mins < 0) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
};
const minsBetween = (a, b) => Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000));
// Closed rows carry duration_minutes; fall back to the timestamps for older rows.
const closedMins = (e) => {
  if (Number.isFinite(e.duration_minutes)) return e.duration_minutes;
  const m = (new Date(e.clock_out_at).getTime() - new Date(e.clock_in_at).getTime()) / 60000;
  return Number.isFinite(m) && m >= 0 ? Math.round(m) : NaN;
};
// Rows that never count as worked time: voided / no-show, or rejected by a manager.
const isVoid = (e) => e.status === 'voided' || e.status === 'no_show' || e.approval_status === 'rejected';
const isDeleted = (e) => e.status === 'voided';

// Terminal states first, then the manager's DECISION, then the mechanical close, then
// "still needs a look". A voided punch reads "Deleted" (the manager Delete replaced Reject).
// The status's catalog key (CS-193); the badge shows it in the reader's language.
function statusKey(e) {
  if (e.status === 'voided') return 'punch.status.deleted';
  if (!e.clock_out_at) return 'punch.status.onTheClock';
  if (e.status === 'no_show') return 'punch.status.noShow';
  if (e.approval_status === 'approved') return 'punch.status.approved';
  if (e.approval_status === 'rejected') return 'punch.status.rejected';
  if (e.status === 'auto_closed') return 'punch.status.autoClosed';
  return 'punch.status.pending';
}
const BADGE_VARIANT = {
  'punch.status.onTheClock': 'green', 'punch.status.deleted': 'red', 'punch.status.noShow': 'red',
  'punch.status.approved': 'green', 'punch.status.rejected': 'red', 'punch.status.autoClosed': 'amber',
};
function StatusBadge({ e }) {
  const t = useT();
  const key = statusKey(e);
  return <Badge variant={BADGE_VARIANT[key] || 'amber'}>{t(key)}</Badge>;
}

// Same geofence-result vocabulary as the Variance drill-down (lib/geo.js's
// verdict shape), duplicated here rather than imported because Variance's badge
// is a page-local function, not a shared export. The 'override' WORDING is shared,
// though — GEOFENCE_REASON_LABELS (lib/clockRules.js) — because "override" alone reads
// as "the cleaner bypassed the ring" for a punch where the office had turned the geofence
// off, for the location or for that one cleaner (step 4b / R7).
function GeoBadge({ result, overrideReason }) {
  const t = useT();
  if (result === 'inside') return <Badge variant="green">{t('punch.geo.onSite')}</Badge>;
  if (result === 'outside') return <Badge variant="red">{t('punch.geo.offSite')}</Badge>;
  if (result === 'override') {
    const key = GEOFENCE_REASON_KEYS[overrideReason];
    const label = key ? t(key) : null;
    return <Badge variant="amber" title={label || overrideReason || undefined}>{label || t('punch.flag.override')}</Badge>;
  }
  if (result === 'no_site_coords' || result === 'unavailable') return <Badge variant="slate">{t('punch.geo.noGps')}</Badge>;
  return null;
}

// One edit-history row: who / what (from → to, times in the org zone) / why (§8.4). Clock-time
// fields render their ISO from/to as org-zone times — naming the zone in the repeated hour of
// the night the clocks go back (CS-668), where "1:15 AM → 1:15 AM" hid an hour; other fields
// (status, approval) print raw.
const CLOCK_FIELDS = new Set(['clock_in_at', 'clock_out_at']);
function historyText(h, usersById) {
  const who = h.by ? (usersById.get(h.by)?.name || null) : (h.byName || h.by_name || null);
  const fields = String(h.field || 'entry').split(',');
  const fmtVal = (v) => (fields.some((f) => CLOCK_FIELDS.has(f.trim())) && v ? fmtPunchTime(v) : v);
  const change = (h.from !== undefined && h.to !== undefined && (h.from != null || h.to != null))
    ? ` ${fmtVal(h.from) ?? '—'} → ${fmtVal(h.to) ?? '—'}`
    : '';
  return `${who ? `${who} · ` : ''}${h.field || 'entry'}${change}${h.reason ? ` · ${h.reason}` : ''}`;
}

// Read-only expansion of a single punch row + the manager actions (Approve / Edit / Delete /
// Restore). Correct/Approve/Delete/Restore reuse the same infra the Approvals + Variance drive.
function PunchDetailModal({ entry, onClose, nav, user, canEdit, canApprove, usersById, onCorrect, onApprove, onDelete, onRestore }) {
  const t = useT();
  if (!entry) return null;
  const open = !entry.clock_out_at;
  const dur = open ? minsBetween(entry.clock_in_at, new Date().toISOString()) : closedMins(entry);
  const approverName = entry.approved_by ? (usersById.get(entry.approved_by)?.name || null) : null;
  // Only a Super Admin acts on their OWN time (the server refuses `own-entry`) — so a non-owner's
  // own punch shows no actions and the reason, the same gate the Approvals queue uses (W4-F).
  const gate = punchActionGate(user, entry);
  return (
    <Modal open={!!entry} onClose={onClose} title={t('timeClock.detail.title')}>
      <div className="tc-detail">
        <div className="tc-detail-row">
          <div className="tc-detail-label">{t('timeClock.detail.cleaner')}</div>
          <div>{entry.user_name || <span className="text-muted">—</span>}</div>
        </div>
        <div className="tc-detail-row">
          <div className="tc-detail-label">{t('timeClock.detail.location')}</div>
          <div>{entry.client_name || entry.site_name || <span className="text-muted">—</span>}</div>
        </div>
        <div className="tc-detail-row">
          <div className="tc-detail-label">{t('timeClock.detail.in')}</div>
          <div>{fmtDateLong(entry.clock_in_at)} · {fmtPunchTime(entry.clock_in_at)}</div>
        </div>
        <div className="tc-detail-row">
          <div className="tc-detail-label">{t('timeClock.detail.out')}</div>
          <div>{open ? <span className="text-muted">{t('timeClock.detail.stillOn')}</span> : `${fmtDateLong(entry.clock_out_at)} · ${fmtPunchTime(entry.clock_out_at)}`}</div>
        </div>
        <div className="tc-detail-row">
          <div className="tc-detail-label">{t('timeClock.detail.duration')}</div>
          <div>{fmtDur(dur)}{open && <span className="tc-sub"> {t('timeClock.soFar')}</span>}</div>
        </div>
        <div className="tc-detail-row">
          <div className="tc-detail-label">{t('timeClock.detail.status')}</div>
          <div><StatusBadge e={entry} />{entry.job_cancelled_at && <> <Badge variant="slate">{t('punch.flag.cleanCancelled')}</Badge></>}</div>
        </div>
        {entry.approval_status === 'approved' && (entry.approved_at || approverName) && (
          <div className="tc-detail-row">
            <div className="tc-detail-label">{t('timeClock.detail.approvedBy')}</div>
            <div>{approverName || t('timeClock.detail.aManager')}{entry.approved_at ? ` · ${fmtDateLong(entry.approved_at)} ${fmtTime(entry.approved_at)}` : ''}</div>
          </div>
        )}
        <div className="tc-detail-row">
          <div className="tc-detail-label">{t('timeClock.detail.locationCheck')}</div>
          <div>
            <GeoBadge result={entry.geofence_result} overrideReason={entry.override_reason} />
            {Number.isFinite(entry.clock_in_distance_m) && <span className="tc-sub"> {t('timeClock.detail.feetFromSite', { feet: metersToFeet(entry.clock_in_distance_m) })}</span>}
            <span className="tc-sub"> {t('timeClock.detail.atClockIn')}</span>
            {/* The raw reason only where the badge didn't already say it (a manager's typed
                correction reason), so a labelled one isn't printed twice. */}
            {entry.override_reason && !GEOFENCE_REASON_KEYS[entry.override_reason] && (
              <div className="text-muted text-xs tc-detail-override">{t('timeClock.detail.override', { reason: entry.override_reason })}</div>
            )}
          </div>
        </div>
        {/* 🔴 PAY-12 (Matt, 2026-09-29): "all clock-ins and clock-outs need to be recorded at the
            actual site." The clock-out end is geofenced server-side too — the same rule, the same
            badge vocabulary — and this is where one punch's answer is read. Absent on an open
            punch, a manual entry, an auto-close and on every punch from before the migration, so
            the row renders only when there IS a verdict. Nothing is blocked or held by it. */}
        {!open && entry.geofence_result_out && (
          <div className="tc-detail-row">
            <div className="tc-detail-label">{t('timeClock.detail.outLocation')}</div>
            <div>
              <GeoBadge result={entry.geofence_result_out} overrideReason={entry.override_reason_out} />
              {Number.isFinite(entry.clock_out_distance_m) && <span className="tc-sub"> {t('timeClock.detail.feetFromSite', { feet: metersToFeet(entry.clock_out_distance_m) })}</span>}
              {entry.override_reason_out && !GEOFENCE_REASON_KEYS[entry.override_reason_out] && (
                <div className="text-muted text-xs tc-detail-override">{t('timeClock.detail.override', { reason: entry.override_reason_out })}</div>
              )}
            </div>
          </div>
        )}
        {entry.note && (
          <div className="tc-detail-row">
            <div className="tc-detail-label">{t('timeClock.detail.note')}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{entry.note}</div>
          </div>
        )}
        {Array.isArray(entry.edit_history) && entry.edit_history.length > 0 && (
          <div className="tc-detail-row">
            <div className="tc-detail-label">{t('timeClock.detail.history')}</div>
            <ul className="tc-detail-history">
              {entry.edit_history.map((h, i) => (
                <li key={i} className="text-muted text-xs">{timeShort(t, h.at)} · {historyText(h, usersById)}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="modal-actions">
          {entry.job_id && <Link className="btn btn-outline" to={`/schedule/${entry.job_id}`} state={nav} onClick={onClose}>{t('timeClock.detail.viewClean')}</Link>}
          {!gate.canAct ? (
            <span className="text-muted text-xs">{t(gate.reasonKey)}</span>
          ) : isDeleted(entry) ? (
            canEdit && <button type="button" className="btn btn-primary" onClick={() => onRestore(entry)}>{t('timeClock.detail.restore')}</button>
          ) : (
            <>
              {canApprove && entry.clock_out_at && entry.approval_status !== 'approved' && (
                <button type="button" className="btn btn-outline" onClick={() => onApprove(entry.id, entry.row_version)}>{t('timeClock.detail.approve')}</button>
              )}
              {canEdit && <button type="button" className="btn btn-outline" onClick={() => onCorrect(entry)}>{t('timeClock.detail.edit')}</button>}
              {canEdit && <button type="button" className="btn btn-danger" onClick={() => onDelete(entry)}>{t('timeClock.detail.delete')}</button>}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

const punchText = (e) => `${fmtDate(e.clock_in_at, DATE_OPTS)} ${e.user_name || ''} ${e.site_name || ''} ${e.client_name || ''} ${english(statusKey(e))}`;

export default function TimeClockHistory({
  siteIds, clientIds, userIds, jobIds,
  title: titleProp,
  hide = [],
  defaultPeriod = '7d',
  allTime = false,
  searchKey = 'q',
  pageParam = 'page',
  showFacets = false,   // /time: scoped Customer + Cleaner facets (URL) + an Add time button
}) {
  const t = useT();
  const title = titleProp === undefined ? t('timeClock.defaultTitle') : titleProp;
  const state = useStore();
  const canView = usePermission('time.view');
  const canEdit = usePermission('time.edit.all');
  const canApprove = usePermission('time.approve');
  const { unscoped, clientIds: scopeClientIds, user } = useTimeScope();
  const nav = useFromHere();
  const toast = useToast();
  const [period, setPeriod] = useState(defaultPeriod);
  const [{ loading, error, entries, truncated }, setState] = useState({ loading: true, error: null, entries: [], truncated: false });
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useTableSearch(searchKey);
  // URL-backed facet values (empty = "All …"); useTableSearch drops the param when empty.
  const [facetCust, setFacetCust] = useTableSearch('tcCust');
  const [facetCleaner, setFacetCleaner] = useTableSearch('tcCleaner');
  const [detailEntry, setDetailEntry] = useState(null);
  const [correctTarget, setCorrectTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [addOpen, setAddOpen] = useState(false);
  const usersById = useMemo(() => new Map((state.users || []).map((u) => [u.id, u])), [state.users]);

  // Facet options (scoped): on the /time surface a manager only ever sees their customers.
  const scopedClients = useMemo(() => {
    let cs = state.clients || [];
    if (!unscoped && Array.isArray(scopeClientIds)) cs = cs.filter((c) => scopeClientIds.includes(c.id));
    return cs.slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [state.clients, unscoped, scopeClientIds]);
  const customerOptions = useMemo(() => [{ value: '', label: t('timeClock.allCustomers') }, ...scopedClients.map((c) => ({ value: c.id, label: c.name }))], [scopedClients, t]);
  const cleanerOptions = useMemo(() => [
    { value: '', label: t('timeClock.allCleaners') },
    ...(state.users || []).filter((u) => u.status === 'active').slice().sort(compareUsersByName).map((u) => ({ value: u.id, label: u.name })),
  ], [state.users, t]);

  // The customer filter this mount asks for: the /time customer facet if chosen, else the mount's
  // own clientIds prop (a customer page); a person / job page passes none.
  const explicitClientIds = showFacets ? (facetCust ? [facetCust] : undefined) : clientIds;
  // W4-F finding 3: a scoped manager's read is constrained to their customers. An empty scope (no
  // locations) or a customer that isn't theirs sends NO fetch and shows the scope message — never
  // an empty id list, which timeApi/the demo stub DROP and answer company-wide (the leak). Owner /
  // admin (unscoped) are unchanged: they read whatever the mount asked for.
  const { fetch: shouldFetch, clientIds: effClientIds, reason: scopeReason } = effectiveTimeFilter({ unscoped, scopeClientIds, explicitClientIds });
  const effUserIds = showFacets && facetCleaner ? [facetCleaner] : userIds;
  const idsKey = JSON.stringify([siteIds || null, effClientIds || null, effUserIds || null, jobIds || null, shouldFetch]);

  useEffect(() => {
    if (!canView) return undefined;
    // A scoped manager with no locations (or on a customer that isn't theirs) reads NOTHING —
    // resolve to an empty, non-loading state and render the scope message (never a company-wide read).
    if (!shouldFetch) { setState({ loading: false, error: null, entries: [], truncated: false }); return undefined; }
    let alive = true;
    const days = PERIODS.find((p) => p.value === period)?.days || 7;
    const fromIso = allTime ? null : startOfDayKey(addDaysKey(todayKey(), -days)).toISOString();
    setState((s) => ({ ...s, loading: true, error: null }));
    timeApi.entries({ fromIso, toIso: null, siteIds, clientIds: effClientIds, userIds: effUserIds, jobIds, limit: CAP })
      .then((r) => { if (alive) setState({ loading: false, error: null, entries: r.entries || [], truncated: !!r.truncated }); })
      .catch((e) => { if (alive) setState((s) => ({ ...s, loading: false, error: errorText(t, e, 'timeClock.loadFailed') })); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, shouldFetch, period, allTime, idsKey, reloadKey]);

  const q = allTime ? '' : query;
  const rows = useMemo(() => searchRows(entries, q, punchText), [entries, q]);

  const summary = useMemo(() => {
    let mins = 0;
    let open = 0;
    for (const e of rows) {
      if (!e.clock_out_at) { open += 1; continue; }
      if (isVoid(e)) continue;
      const m = closedMins(e);
      if (Number.isFinite(m)) mins += m;
    }
    return { count: rows.length, mins, open };
  }, [rows]);

  const pager = usePagedRows(rows, { param: pageParam, resetKey: `${period}|${q}|${facetCust}|${facetCleaner}` });

  const reload = () => { setDetailEntry(null); setReloadKey((k) => k + 1); };
  const approve = async (entryId, version) => {
    try {
      const [res] = await timeApi.approveEntries([{ entryId, version }]);
      if (res && res.ok === false) toast.error(TIME_REFUSAL_KEYS[res.code] ? t(TIME_REFUSAL_KEYS[res.code]) : t('timeClock.approveFailed'));
      else toast.success(t('timeClock.approved'));
      reload();
    } catch (e) { toast.error(errorText(t, e, 'timeClock.updateFailed')); }
  };
  // Bridge the snake_case row to the camelCase shape TimeEntryModal's 'correct' mode expects.
  const openCorrect = (e) => {
    setDetailEntry(null);
    setCorrectTarget({
      id: e.id, userId: e.user_id, jobId: e.job_id, rowVersion: e.row_version ?? null,
      clockInAt: e.clock_in_at, clockOutAt: e.clock_out_at, approvalStatus: e.approval_status,
      note: e.note || '', userName: e.user_name, siteName: e.site_name, clientName: e.client_name,
    });
  };
  const openDelete = (e) => { setDetailEntry(null); setDeleteTarget(e); };
  const openRestore = (e) => { setDetailEntry(null); setRestoreTarget(e); };

  if (!canView) return null;
  const show = (col) => !hide.includes(col);
  const searching = !allTime && q.trim().length > 0;

  return (
    <div className="tc-block">
      <div className="table-head">
        {title && <h3 className="table-head-title">{title}</h3>}
        {!allTime && (
          <div className="table-controls">
            <TableSearch value={query} onChange={setQuery} placeholder={t('timeClock.search')} ariaLabel={t('timeClock.search')} />
            {searching && <span className="table-count">{t('timeClock.searchCount', { shown: rows.length, total: entries.length })}</span>}
            <span className="spacer" />
            {showFacets && canEdit && <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>{t('timeClock.addTime')}</button>}
            <div className="tab-container-line tc-periods" role="group" aria-label={t('timeClock.period')}>
              {PERIODS.map((p) => (
                <button key={p.value} type="button" className={`tab-btn ${period === p.value ? 'active' : ''}`} onClick={() => setPeriod(p.value)}>
                  {t(p.labelKey)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {showFacets && (
        <div className="filter-bar appr-filters">
          <FormField label={t('timeClock.customer')}><FilterSelect ariaLabel={t('timeClock.customer')} value={facetCust} onChange={setFacetCust} options={customerOptions} /></FormField>
          <FormField label={t('timeClock.cleaner')}><FilterSelect ariaLabel={t('timeClock.cleaner')} value={facetCleaner} onChange={setFacetCleaner} options={cleanerOptions} /></FormField>
        </div>
      )}

      {!shouldFetch ? (
        <EmptyState
          icon={<Icon name="building" size={28} />}
          title={scopeReason === 'out-of-scope' ? t('timeClock.outOfScope') : t('timeClock.noLocations')}
          message={scopeReason === 'out-of-scope' ? undefined : t('timeClock.noLocationsHint')}
        />
      ) : loading ? (
        <div className="text-muted text-sm">{t('timeClock.loading')}</div>
      ) : error ? (
        <div className="tc-error">
          <span className="text-danger">{error}</span>
          <button type="button" className="btn btn-outline" onClick={() => setReloadKey((k) => k + 1)}>{t('common.retry')}</button>
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Icon name="schedule" size={28} />}
          title={t('timeClock.empty')}
          message={allTime ? t('timeClock.emptyClean') : t('timeClock.emptyWindow')}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="search" size={28} />}
          title={t('timeClock.noMatch')}
          message={t('timeClock.noMatchHint', { query: q })}
        />
      ) : (
        <>
          <div className="tc-summary">
            {t('timeClock.summary', { count: summary.count, duration: fmtDur(summary.mins) })}
            {summary.open > 0 && <> · {t.rich('timeClock.summaryOpen', { count: summary.open })}</>}
            {truncated && !searching && <> · {t('timeClock.summaryTruncated', { count: CAP })}</>}
          </div>
          <div className="table-wrap mobile-stack">
            <table>
              <thead>
                <tr>
                  <th>{t('timeClock.col.date')}</th>
                  {show('cleaner') && <th>{t('timeClock.col.cleaner')}</th>}
                  {show('location') && <th>{t('timeClock.col.location')}</th>}
                  <th>{t('timeClock.col.in')}</th>
                  <th>{t('timeClock.col.out')}</th>
                  <th className="tc-num">{t('timeClock.col.duration')}</th>
                  <th>{t('timeClock.col.status')}</th>
                </tr>
              </thead>
              <tbody>
                {pager.pageRows.map((e) => {
                  const open = !e.clock_out_at;
                  const dur = open ? minsBetween(e.clock_in_at, new Date().toISOString()) : closedMins(e);
                  const date = fmtDate(e.clock_in_at, DATE_OPTS);
                  return (
                    <tr key={e.id} className="tc-row" onClick={() => setDetailEntry(e)} style={{ cursor: 'pointer' }}>
                      <td className="name cell-primary">{date}</td>
                      {show('cleaner') && <td data-label={t('timeClock.col.cleaner')}>{e.user_name ? <span className="truncate" title={e.user_name}>{e.user_name}</span> : <span className="text-muted">—</span>}</td>}
                      {show('location') && (
                        <td data-label={t('timeClock.col.location')}>
                          {e.client_name || e.site_name
                            ? <span className="truncate" title={e.client_name || e.site_name}>{e.client_name || e.site_name}</span>
                            : <span className="text-muted">—</span>}
                        </td>
                      )}
                      <td data-label={t('timeClock.col.in')}>{fmtPunchTime(e.clock_in_at)}</td>
                      <td data-label={t('timeClock.col.out')}>{open ? <span className="text-muted">—</span> : fmtPunchTime(e.clock_out_at)}</td>
                      <td data-label={t('timeClock.col.duration')} className="tc-num">{fmtDur(dur)}{open && <span className="tc-sub">{t('timeClock.soFar')}</span>}</td>
                      <td data-label={t('timeClock.col.status')}><StatusBadge e={e} />{e.job_cancelled_at && <> <Badge variant="slate">{t('punch.flag.cleanCancelled')}</Badge></>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun={t('pager.noun.punches')} />
        </>
      )}
      <PunchDetailModal
        entry={detailEntry}
        onClose={() => setDetailEntry(null)}
        nav={nav}
        user={user}
        canEdit={canEdit}
        canApprove={canApprove}
        usersById={usersById}
        onCorrect={openCorrect}
        onApprove={approve}
        onDelete={openDelete}
        onRestore={openRestore}
      />
      <TimeEntryModal open={!!correctTarget} onClose={() => setCorrectTarget(null)} mode="correct" entry={correctTarget} onSaved={reload} />
      <TimeEntryModal open={addOpen} onClose={() => setAddOpen(false)} mode="manual" onSaved={reload} />
      <TimeDeleteDialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} entry={deleteTarget} label={deleteTarget?.user_name} onDeleted={reload} />
      <TimeRestoreDialog open={!!restoreTarget} onClose={() => setRestoreTarget(null)} entry={restoreTarget} label={restoreTarget?.user_name} onRestored={reload} />
    </div>
  );
}
