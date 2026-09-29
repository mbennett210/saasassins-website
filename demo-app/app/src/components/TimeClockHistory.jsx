import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Badge from './Badge';
import Icon from './Icon';
import EmptyState from './EmptyState';
import TableSearch from './TableSearch';
import ListPager from './ListPager';
import Modal from './Modal';
import TimeEntryModal from './TimeEntryModal';
import { useToast } from './Toast';
import * as timeApi from '../lib/timeApi';
import { metersToFeet } from '../lib/geo';
import { GEOFENCE_REASON_LABELS } from '../lib/clockRules';
import { usePermission } from '../hooks/usePermission';
import { useFromHere } from '../hooks/useFromHere';
import { useTableSearch } from '../hooks/useTableSearch';
import { usePagedRows } from '../hooks/usePagedRows';
import { searchRows } from '../lib/searchRows';
import { fmtDate, fmtDateLong, fmtTime, fmtRelative, todayKey, addDaysKey, startOfDayKey } from '../lib/dates';

// Crew punch history for the manager Time Clock surfaces. ONE component, mounted
// on the account page (Time clock tab), the crew-member page, the job page and
// /time — each passes the ids that scope it. Reads timeApi.entries (GET
// /api/time/entries, manager-only) into component-local state, never the synced
// blob (§2.1). Renders NOTHING for non-managers: the endpoint 403s them anyway,
// and a crew member's own punches live on My Day.
//
// Sept 3: managers reported "can't see the crew's clock-in/out history, it isn't
// registering with the locations". The punches were in time_entries, correctly
// linked to job/site/client — but the ONLY page that rendered any punch was the
// Variance report. This is the missing surface, put where the office looks.
//
// Layout: the standalone-table pattern (UI_RULES §1/§72): a bare title over a
// controls row (search + period pills), then the .table-wrap whose own border is
// the frame. No card wrapper (that was the old "box inside a box"). Live search
// is shown on the windowed manager surfaces, not on a single clean's few punches.
const PERIODS = [
  { value: '7d', label: '7 days', days: 7 },
  { value: '30d', label: '30 days', days: 30 },
  { value: '90d', label: '90 days', days: 90 },
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
// A corrupt row (clock-out before clock-in) reads '—', never a confident '0m'.
const closedMins = (e) => {
  if (Number.isFinite(e.duration_minutes)) return e.duration_minutes;
  const m = (new Date(e.clock_out_at).getTime() - new Date(e.clock_in_at).getTime()) / 60000;
  return Number.isFinite(m) && m >= 0 ? Math.round(m) : NaN;
};
// Rows that never count as worked time: voided / no-show, or rejected by a manager.
const isVoid = (e) => e.status === 'voided' || e.status === 'no_show' || e.approval_status === 'rejected';

// Terminal states first, then the manager's DECISION (an approved auto-close is
// approved), then the mechanical close, then "still needs a look". statusLabel
// keeps the badge words and the search haystack in one place.
function statusLabel(e) {
  if (!e.clock_out_at) return 'On the clock';
  if (e.status === 'voided') return 'Voided';
  if (e.status === 'no_show') return 'No-show';
  if (e.approval_status === 'approved') return 'Approved';
  if (e.approval_status === 'rejected') return 'Rejected';
  if (e.status === 'auto_closed') return 'Auto-closed';
  return 'Pending review';
}
const BADGE_VARIANT = { 'On the clock': 'green', Voided: 'red', 'No-show': 'red', Approved: 'green', Rejected: 'red', 'Auto-closed': 'amber' };
function StatusBadge({ e }) {
  const label = statusLabel(e);
  return <Badge variant={BADGE_VARIANT[label] || 'amber'}>{label}</Badge>;
}

// Same geofence-result vocabulary as the Variance drill-down (lib/geo.js's
// verdict shape), duplicated here rather than imported because Variance's badge
// is a page-local function, not a shared export. The 'override' WORDING is shared,
// though — GEOFENCE_REASON_LABELS (lib/clockRules.js) — because "override" alone reads
// as "the cleaner bypassed the ring" for a punch where the office had turned the geofence
// off, for the location or for that one cleaner (step 4b / R7).
function GeoBadge({ result, overrideReason }) {
  if (result === 'inside') return <Badge variant="green">On-site</Badge>;
  if (result === 'outside') return <Badge variant="red">Off-site</Badge>;
  if (result === 'override') {
    const label = GEOFENCE_REASON_LABELS[overrideReason];
    return <Badge variant="amber" title={label || overrideReason || undefined}>{label || 'Override'}</Badge>;
  }
  if (result === 'no_site_coords' || result === 'unavailable') return <Badge variant="slate">No GPS</Badge>;
  return null;
}

// Read-only expansion of a single punch row. The manager surfaces (account tab,
// crew page, job page, /time) only ever showed the table columns; a punch's
// geofence result, note and edit history were invisible unless you already knew
// to open Variance. Correct/Approve reuse the same infra Variance drives.
function PunchDetailModal({ entry, onClose, nav, canEdit, canApprove, onCorrect, onApprove }) {
  if (!entry) return null;
  const open = !entry.clock_out_at;
  const dur = open ? minsBetween(entry.clock_in_at, new Date().toISOString()) : closedMins(entry);
  return (
    <Modal open={!!entry} onClose={onClose} title="Punch details">
      <div className="tc-detail">
        <div className="tc-detail-row">
          <div className="tc-detail-label">Cleaner</div>
          <div>{entry.user_name || <span className="text-muted">—</span>}</div>
        </div>
        <div className="tc-detail-row">
          <div className="tc-detail-label">Location</div>
          <div>
            {entry.client_name || entry.site_name || <span className="text-muted">—</span>}
          </div>
        </div>
        <div className="tc-detail-row">
          <div className="tc-detail-label">Clock-in</div>
          <div>{fmtDateLong(entry.clock_in_at)} · {fmtTime(entry.clock_in_at)}</div>
        </div>
        <div className="tc-detail-row">
          <div className="tc-detail-label">Clock-out</div>
          <div>{open ? <span className="text-muted">Still on the clock</span> : `${fmtDateLong(entry.clock_out_at)} · ${fmtTime(entry.clock_out_at)}`}</div>
        </div>
        <div className="tc-detail-row">
          <div className="tc-detail-label">Duration</div>
          <div>{fmtDur(dur)}{open && <span className="tc-sub"> so far</span>}</div>
        </div>
        <div className="tc-detail-row">
          <div className="tc-detail-label">Status</div>
          <div><StatusBadge e={entry} />{entry.job_cancelled_at && <> <Badge variant="slate">Clean cancelled</Badge></>}</div>
        </div>
        <div className="tc-detail-row">
          <div className="tc-detail-label">Location check</div>
          <div>
            <GeoBadge result={entry.geofence_result} overrideReason={entry.override_reason} />
            {Number.isFinite(entry.clock_in_distance_m) && <span className="tc-sub"> {metersToFeet(entry.clock_in_distance_m)} ft from site</span>}
            {/* The raw reason only where the badge didn't already say it (a manager's typed
                correction reason), so a labelled one isn't printed twice. */}
            {entry.override_reason && !GEOFENCE_REASON_LABELS[entry.override_reason] && (
              <div className="text-muted text-xs tc-detail-override">Override: {entry.override_reason}</div>
            )}
          </div>
        </div>
        {entry.note && (
          <div className="tc-detail-row">
            <div className="tc-detail-label">Note</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{entry.note}</div>
          </div>
        )}
        {Array.isArray(entry.edit_history) && entry.edit_history.length > 0 && (
          <div className="tc-detail-row">
            <div className="tc-detail-label">Edit history</div>
            <ul className="tc-detail-history">
              {entry.edit_history.map((h, i) => (
                <li key={i} className="text-muted text-xs">
                  {fmtRelative(h.at)} · {h.field || 'entry'}{h.reason ? `: ${h.reason}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="modal-actions">
          {entry.job_id && <Link className="btn btn-outline" to={`/schedule/${entry.job_id}`} state={nav} onClick={onClose}>View clean</Link>}
          {canApprove && entry.clock_out_at && entry.approval_status !== 'approved' && (
            <button type="button" className="btn btn-outline" onClick={() => onApprove(entry.id, 'approved')}>Approve</button>
          )}
          {canApprove && entry.clock_out_at && entry.approval_status !== 'rejected' && (
            <button type="button" className="btn btn-outline" onClick={() => onApprove(entry.id, 'rejected')}>Reject</button>
          )}
          {canEdit && <button type="button" className="btn btn-primary" onClick={() => onCorrect(entry)}>Correct</button>}
        </div>
      </div>
    </Modal>
  );
}

// One row's searchable text: date, cleaner, location and status, so a manager can
// filter by any of the things the table shows.
const punchText = (e) => `${fmtDate(e.clock_in_at, DATE_OPTS)} ${e.user_name || ''} ${e.site_name || ''} ${e.client_name || ''} ${statusLabel(e)}`;

export default function TimeClockHistory({
  siteIds, clientIds, userIds, jobIds,
  title = 'Time clock',
  hide = [],            // column keys to omit: 'cleaner' on a person's page, 'location' on a job's
  defaultPeriod = '7d',
  allTime = false,      // a single job's punches are few — no period pills, no search, no window
  searchKey = 'q',      // URL param for the search text; override when two tables share a page
  pageParam = 'page',   // URL param for the page number; override when two paged tables share a page
}) {
  const canView = usePermission('time.view');
  const canEdit = usePermission('time.edit.all');
  const canApprove = usePermission('time.approve');
  const nav = useFromHere(); // so Back on the job page returns HERE, not to /schedule
  const toast = useToast();
  const [period, setPeriod] = useState(defaultPeriod);
  const [{ loading, error, entries, truncated }, setState] = useState({ loading: true, error: null, entries: [], truncated: false });
  const [reloadKey, setReloadKey] = useState(0);
  const [query, setQuery] = useTableSearch(searchKey);
  const [detailEntry, setDetailEntry] = useState(null);
  const [correctTarget, setCorrectTarget] = useState(null);
  // Compared by VALUE: callers pass fresh array literals each render, and a
  // reference-compared dep would refetch on every parent render.
  const idsKey = JSON.stringify([siteIds || null, clientIds || null, userIds || null, jobIds || null]);

  useEffect(() => {
    if (!canView) return undefined;
    let alive = true;
    const days = PERIODS.find((p) => p.value === period)?.days || 7;
    // Anchored to the ORG's calendar day (same as the Variance period pills), so
    // "7 days" means the same thing for the office and an off-site VA.
    const fromIso = allTime ? null : startOfDayKey(addDaysKey(todayKey(), -days)).toISOString();
    setState((s) => ({ ...s, loading: true, error: null }));
    timeApi.entries({ fromIso, toIso: null, siteIds, clientIds, userIds, jobIds, limit: CAP })
      .then((r) => { if (alive) setState({ loading: false, error: null, entries: r.entries || [], truncated: !!r.truncated }); })
      .catch((e) => { if (alive) setState((s) => ({ ...s, loading: false, error: e?.message || 'Could not load clock history' })); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, period, allTime, idsKey, reloadKey]);

  // Search is a windowed-surface affordance only; a single clean's punch list is
  // short and complete, so allTime keeps the full set.
  const q = allTime ? '' : query;
  const rows = useMemo(() => searchRows(entries, q, punchText), [entries, q]);

  const summary = useMemo(() => {
    let mins = 0;
    let open = 0;
    for (const e of rows) {
      if (!e.clock_out_at) { open += 1; continue; }
      if (isVoid(e)) continue; // voided / no-show / rejected never count as clocked
      const m = closedMins(e);
      if (Number.isFinite(m)) mins += m;
    }
    return { count: rows.length, mins, open };
  }, [rows]);

  // 20/page via the shared pager; the page resets to 1 whenever the period or the
  // search query changes so a stale page never renders an empty table (§50).
  const pager = usePagedRows(rows, { param: pageParam, resetKey: `${period}|${q}` });

  const afterEdit = () => { setDetailEntry(null); setReloadKey((k) => k + 1); };
  const approve = async (entryId, approval) => {
    try {
      await timeApi.approveEntry({ entryId, approval });
      toast.success(approval === 'approved' ? 'Entry approved' : 'Entry rejected');
      afterEdit();
    } catch (e) { toast.error(e?.message || 'Could not update the entry'); }
  };
  // Bridges the raw snake_case punch row to the camelCase shape TimeEntryModal's
  // 'correct' mode expects (same shape Variance's RowGroup passes it).
  const openCorrect = (e) => {
    setDetailEntry(null);
    setCorrectTarget({
      id: e.id, userId: e.user_id, jobId: e.job_id,
      clockInAt: e.clock_in_at, clockOutAt: e.clock_out_at,
      note: e.note || '', userName: e.user_name, siteName: e.site_name, clientName: e.client_name,
    });
  };

  if (!canView) return null;
  const show = (col) => !hide.includes(col);
  const searching = !allTime && q.trim().length > 0;

  return (
    <div className="tc-block">
      <div className="table-head">
        {title && <h3 className="table-head-title">{title}</h3>}
        {!allTime && (
          <div className="table-controls">
            <TableSearch value={query} onChange={setQuery} placeholder="Search punches" ariaLabel="Search punches" />
            {searching && <span className="table-count">{rows.length} of {entries.length}</span>}
            <span className="spacer" />
            <div className="tab-container-line tc-periods" role="group" aria-label="Period">
              {PERIODS.map((p) => (
                <button key={p.value} type="button" className={`tab-btn ${period === p.value ? 'active' : ''}`} onClick={() => setPeriod(p.value)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="text-muted text-sm">Loading clock history…</div>
      ) : error ? (
        <div className="tc-error">
          <span className="text-danger">{error}</span>
          <button type="button" className="btn btn-outline" onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<Icon name="schedule" size={28} />}
          title="No clock-ins here yet"
          message={allTime ? 'Nobody has clocked in to this clean.' : 'No crew clock-ins in this window — try a longer period.'}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="search" size={28} />}
          title="No matching punches"
          message={`Nothing matches “${q}”. Try a name, location, date or status.`}
        />
      ) : (
        <>
          <div className="tc-summary">
            {summary.count} punch{summary.count === 1 ? '' : 'es'} · {fmtDur(summary.mins)} clocked
            {summary.open > 0 && <> · <strong>{summary.open} on the clock now</strong></>}
            {truncated && !searching && <> · showing the newest {CAP} — narrow the period for the rest</>}
          </div>
          {/* mobile-stack: opts out of the global ≤640px .table-wrap hide (§3.3) and
              restacks each row as a labelled card on the phone — the office checks
              "did they clock in?" from a phone as often as from a desk. */}
          <div className="table-wrap mobile-stack">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  {show('cleaner') && <th>Cleaner</th>}
                  {show('location') && <th>Location</th>}
                  <th>In</th>
                  <th>Out</th>
                  <th className="tc-num">Duration</th>
                  <th>Status</th>
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
                      {show('cleaner') && <td data-label="Cleaner">{e.user_name ? <span className="truncate" title={e.user_name}>{e.user_name}</span> : <span className="text-muted">—</span>}</td>}
                      {show('location') && (
                        <td data-label="Location">
                          {e.client_name || e.site_name
                            ? <span className="truncate" title={e.client_name || e.site_name}>{e.client_name || e.site_name}</span>
                            : <span className="text-muted">—</span>}
                        </td>
                      )}
                      <td data-label="In">{fmtTime(e.clock_in_at)}</td>
                      <td data-label="Out">{open ? <span className="text-muted">—</span> : fmtTime(e.clock_out_at)}</td>
                      <td data-label="Duration" className="tc-num">{fmtDur(dur)}{open && <span className="tc-sub">so far</span>}</td>
                      <td data-label="Status"><StatusBadge e={e} />{e.job_cancelled_at && <> <Badge variant="slate">Clean cancelled</Badge></>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun="punches" />
        </>
      )}
      <PunchDetailModal
        entry={detailEntry}
        onClose={() => setDetailEntry(null)}
        nav={nav}
        canEdit={canEdit}
        canApprove={canApprove}
        onCorrect={openCorrect}
        onApprove={approve}
      />
      <TimeEntryModal open={!!correctTarget} onClose={() => setCorrectTarget(null)} mode="correct" entry={correctTarget} onSaved={afterEdit} />
    </div>
  );
}
