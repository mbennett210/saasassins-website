// The Drive-time view of the Variance page — paid travel BETWEEN jobs.
//
// One row per leg: the cleaner clocked out of one clean and clocked into the next,
// and that gap is paid drive time. The commute from home to the first clean and
// from the last clean home is never counted (it can't be — a leg needs a clock-out
// on one side and a clock-in on the other). Each leg is compared to the mapped
// drive time between the two sites and flagged when it runs over.
//
// Server-aggregated over a bounded window (real backend) or the timeApi stub
// (demo) — both via the SAME src/lib/driveTime.js engine. Component-local
// projection (useState), never the blob. Reuses the Variance report's period
// pills, FilterBar, StatCards and mobile-stack table (UI_RULES §21 / §24).
import { useCallback, useEffect, useMemo, useState } from 'react';
import Badge from './Badge';
import Icon from './Icon';
import Modal from './Modal';
import FormField from './FormField';
import EmptyState from './EmptyState';
import FilterBar from './filters/FilterBar';
import { useUrlFilters } from '../hooks/useUrlFilters';
import { driveFilterSpecs } from '../lib/filters/driveFilters';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import * as driveApi from '../lib/driveApi';
import {
  driveFlagBadgeVariant, driveFlagLabel,
  DEFAULT_DRIVE_MAX_GAP_MINS, DEFAULT_DRIVE_FLAG_PCT, DEFAULT_DRIVE_GRACE_MINS,
} from '../lib/driveTime';
import { fmtDuration, fmtDate, fmtTime } from '../lib/dates';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from './ListPager';

function StatCard({ label, value, tone }) {
  return (
    <div className={`stat-card${tone ? ` tone-${tone}` : ''}`}>
      <div className="stat-val">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function DriveTimeReport({ window: reportWindow, canAct, onRowsChange }) {
  const state = useStore();
  const { currentUser } = useAuth();
  const toast = useToast();
  const filters = useUrlFilters(driveFilterSpecs);
  const filterCtx = useMemo(() => ({ state, user: currentUser }), [state, currentUser]);

  const [data, setData] = useState(null); // { rows, summary, config, estimatesPending, truncated }
  const [error, setError] = useState(null);
  const [adjustTarget, setAdjustTarget] = useState(null);

  const ops = state.opsSettings || {};
  const sites = state.sites;
  const request = useMemo(() => ({
    fromIso: reportWindow.fromIso,
    toIso: reportWindow.toIso,
    filters: {
      siteIds: filters.values.loc?.length ? filters.values.loc : null,
      userIds: filters.values.cleaner?.length ? filters.values.cleaner : null,
      flaggedOnly: filters.values.flagged === '1',
    },
    // config + sites are consumed ONLY by the demo stub; the real backend reads
    // opsSettings and site coordinates server-side.
    config: {
      maxGapMins: ops.driveMaxGapMins ?? DEFAULT_DRIVE_MAX_GAP_MINS,
      flagPct: ops.driveVarianceFlagPct ?? DEFAULT_DRIVE_FLAG_PCT,
      graceMins: ops.driveVarianceGraceMins ?? DEFAULT_DRIVE_GRACE_MINS,
    },
    sites,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [reportWindow.fromIso, reportWindow.toIso, filters.values.loc, filters.values.cleaner, filters.values.flagged,
    ops.driveMaxGapMins, ops.driveVarianceFlagPct, ops.driveVarianceGraceMins, sites]);

  const load = useCallback(async () => {
    setError(null); setData(null);
    try { setData(await driveApi.report(request)); }
    catch (e) { setError(e.message || 'Could not load the drive-time report.'); }
  }, [request]);
  useEffect(() => { load(); }, [load]);

  const rows = useMemo(() => data?.rows || [], [data]);
  const pager = usePagedRows(rows, { param: 'dpage', resetKey: `${reportWindow.fromIso}|${reportWindow.toIso}|${JSON.stringify(filters.values)}` });
  // Hoist the rows so the page header's Export CSV can serialize the same set the
  // table is showing (one export button for both views, not two).
  useEffect(() => { onRowsChange?.(rows); }, [rows, onRowsChange]);

  const saveAdjust = async ({ excluded, paidMinutes, reason }) => {
    const seg = adjustTarget;
    try {
      await driveApi.setOverride({
        fromEntryId: seg.fromEntryId, toEntryId: seg.toEntryId,
        excluded, paidMinutes, reason,
        actualMinutes: seg.actualMinutes, estimateMinutes: seg.estimateMinutes,
      });
      toast.success('Paid drive time adjusted');
      setAdjustTarget(null);
      load();
    } catch (e) { toast.error(e.message || 'Could not save the adjustment'); }
  };
  const clearAdjust = async () => {
    const seg = adjustTarget;
    try {
      await driveApi.clearOverride({ fromEntryId: seg.fromEntryId, toEntryId: seg.toEntryId });
      toast.success('Adjustment cleared. Paying the recorded time');
      setAdjustTarget(null);
      load();
    } catch (e) { toast.error(e.message || 'Could not clear the adjustment'); }
  };

  const cfg = data?.config || {};
  const flagPct = cfg.flagPct ?? ops.driveVarianceFlagPct ?? DEFAULT_DRIVE_FLAG_PCT;
  const graceMins = cfg.graceMins ?? ops.driveVarianceGraceMins ?? DEFAULT_DRIVE_GRACE_MINS;

  return (
    <>
      <FilterBar
        specs={driveFilterSpecs}
        values={filters.values}
        setValue={filters.setValue}
        clearAll={filters.clearAll}
        activeCount={filters.activeCount}
        ctx={filterCtx}
      />

      {data?.summary && (
        <div className="stat-grid variance-stats">
          <StatCard label="Drive legs" value={data.summary.segmentCount} />
          <StatCard label="Paid drive time" value={fmtDuration(data.summary.payableDriveMinutes)} />
          <StatCard label="Over estimate" value={data.summary.flaggedCount} tone={data.summary.flaggedCount > 0 ? 'danger' : null} />
          <StatCard label="Mapped" value={data.summary.estimateCoverage != null ? `${data.summary.estimateCoverage}%` : '—'} />
        </div>
      )}

      {data?.truncated && (
        <p className="text-muted text-xs" style={{ margin: '0 0 8px' }}>
          <Icon name="warning" size={12} /> Showing the most recent results in this window. Narrow the period or filters to see everything.
        </p>
      )}
      {data?.estimatesPending > 0 && (
        <p className="text-muted text-xs" style={{ margin: '0 0 8px' }}>
          <Icon name="warning" size={12} /> {data.estimatesPending} {data.estimatesPending === 1 ? 'route is' : 'routes are'} still being mapped. Reload in a moment to compare {data.estimatesPending === 1 ? 'that leg' : 'those legs'}.
        </p>
      )}

      {error ? (
        <div className="card" style={{ textAlign: 'center', padding: 24 }}>
          <p style={{ color: 'var(--danger)' }}>{error}</p>
          <button className="btn btn-outline" onClick={load}>Retry</button>
        </div>
      ) : data === null ? (
        <div className="card" style={{ padding: 24 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="schedule" size={28} />}
          title="No drive time in this window"
          message="A leg is recorded when a cleaner clocks out of one clean and into another the same shift. The trip from home to the first clean and home from the last is never counted."
        />
      ) : (
        <div className="table-wrap mobile-stack">
          <table>
            <thead>
              <tr>
                <th>Route</th><th>Cleaner</th><th>Date</th><th>Left – arrived</th>
                <th>Drive</th><th>Estimate</th><th>Over</th><th>Flag</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pager.pageRows.map((r) => (
                <tr key={r.key} className={r.flag === 'over' ? 'variance-row' : undefined}>
                  <td className="cell-primary">
                    <div className="variance-clean-site truncate" title={r.fromClientName === r.toClientName ? r.fromClientName : `${r.fromClientName} → ${r.toClientName}`}>{r.fromClientName === r.toClientName ? r.fromClientName : `${r.fromClientName} → ${r.toClientName}`}</div>
                  </td>
                  <td data-label="Cleaner"><span className="truncate" title={r.userName}>{r.userName}</span></td>
                  <td data-label="Date" className="text-muted text-xs">{r.startAt ? fmtDate(r.startAt) : '—'}</td>
                  <td data-label="Left – arrived" className="text-muted text-xs">{fmtTime(r.startAt)} – {fmtTime(r.endAt)}</td>
                  <td data-label="Drive">
                    <strong>{fmtDuration(r.actualMinutes)}</strong>
                    {r.adjusted && (
                      <div className="text-muted text-xs">
                        {r.paidMinutes > 0 ? `paid ${fmtDuration(r.paidMinutes)}` : 'not paid'}
                      </div>
                    )}
                  </td>
                  <td data-label="Estimate">
                    {r.flag === 'same_site' ? <span className="text-muted">—</span>
                      : r.estimateMinutes != null ? fmtDuration(r.estimateMinutes)
                        : <span className="text-muted">—</span>}
                  </td>
                  <td data-label="Over">
                    {r.flag === 'over' && r.overMinutes != null
                      ? <strong>+{fmtDuration(r.overMinutes)}{r.overPct != null ? ` (${r.overPct}%)` : ''}</strong>
                      : <span className="text-muted">—</span>}
                  </td>
                  <td data-label="Flag">
                    <Badge variant={driveFlagBadgeVariant(r.flag)}>{driveFlagLabel(r.flag)}</Badge>
                    {r.adjusted && <> <Badge variant="blue">Adjusted</Badge></>}
                  </td>
                  <td className="cell-actions">
                    {canAct && (
                      <button type="button" className="btn btn-link btn-sm" onClick={() => setAdjustTarget(r)}>
                        {r.adjusted ? 'Edit pay' : 'Adjust pay'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ListPager pager={pager} noun="legs" />
        </div>
      )}

      {rows.length > 0 && (
        <p className="text-muted text-xs" style={{ marginTop: 8 }}>
          A leg is flagged when the recorded drive runs more than {flagPct}% (plus {graceMins} min) past the mapped drive time between the two locations. Flagging never changes pay on its own.
        </p>
      )}

      <DriveAdjustModal
        segment={adjustTarget}
        onClose={() => setAdjustTarget(null)}
        onSave={saveAdjust}
        onClear={clearAdjust}
      />
    </>
  );
}

// Manager ruling on ONE leg. Recorded travel between job sites is compensable
// time, so nothing is docked automatically — this is the only surface that changes
// what a leg pays, and the reason is required (it lands in the audit row).
function DriveAdjustModal({ segment, onClose, onSave, onClear }) {
  const [form, setForm] = useState({ paidMinutes: '', excluded: false, reason: '' });
  useEffect(() => {
    if (!segment) return;
    const o = segment.override;
    setForm({
      paidMinutes: String(o && !o.excluded && Number.isFinite(o.paidMinutes) ? o.paidMinutes : segment.actualMinutes),
      excluded: !!o?.excluded,
      reason: o?.reason || '',
    });
  }, [segment]);
  if (!segment) return null;

  const submit = (e) => {
    e.preventDefault();
    const paid = Number(form.paidMinutes);
    onSave({
      excluded: form.excluded,
      paidMinutes: form.excluded ? null : (Number.isFinite(paid) ? Math.max(0, Math.round(paid)) : null),
      reason: form.reason.trim(),
    });
  };

  return (
    <Modal open onClose={onClose} title="Adjust paid drive time" size="md">
      <form onSubmit={submit} noValidate>
        <p className="text-muted text-sm" style={{ marginTop: 0 }}>
          <strong>{segment.fromClientName === segment.toClientName ? segment.fromClientName : `${segment.fromClientName} → ${segment.toClientName}`}</strong> · {segment.userName} · {fmtDate(segment.startAt)}<br />
          Recorded {fmtDuration(segment.actualMinutes)} ({fmtTime(segment.startAt)} – {fmtTime(segment.endAt)})
          {segment.estimateMinutes != null && segment.flag !== 'same_site' ? ` · mapped at ${fmtDuration(segment.estimateMinutes)}` : ''}
        </p>

        <FormField
          label="Paid minutes" type="number" min="0" step="5"
          value={form.paidMinutes}
          onChange={(e) => setForm({ ...form, paidMinutes: e.target.value })}
          disabled={form.excluded}
          help="Defaults to the recorded time. Lower it only when you've established the extra time wasn't spent travelling between the two sites."
        />
        <label className="pref-row" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={form.excluded}
            onChange={(e) => setForm({ ...form, excluded: e.target.checked })}
          />
          <span>Don’t pay this leg at all</span>
        </label>
        <FormField
          label="Reason" as="textarea" rows={2} required
          value={form.reason}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          placeholder="e.g. Cleaner confirmed a personal stop on the way"
          help="Recorded with the adjustment so payroll and the cleaner can both see why."
        />

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          {segment.adjusted && <button type="button" className="btn btn-outline" onClick={onClear}>Clear adjustment</button>}
          <button type="submit" className="btn btn-success" disabled={!form.reason.trim()}>Save adjustment</button>
        </div>
      </form>
    </Modal>
  );
}
