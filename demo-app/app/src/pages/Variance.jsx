// The Variance report — the headline Swept-replacement differentiator. Actual
// clocked labor vs the per-account expected, multi-cleaner-attributed, ±threshold
// flagged, over many periods. Server-aggregated over a bounded window (real
// backend) or the timeApi stub (demo) — both via the SAME src/lib/variance.js
// engine. The report is a component-local projection (useState), never the blob.
// CLEANSPACE_SWEPT.md §5.5.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Badge from '../components/Badge';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import EmptyState from '../components/EmptyState';
import FilterBar from '../components/filters/FilterBar';
import { useUrlFilters } from '../hooks/useUrlFilters';
import { varianceFilterSpecs } from '../lib/filters/varianceFilters';
import { useFromHere } from '../hooks/useFromHere';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import { report as fetchReport } from '../lib/varianceApi';
import { metersToFeet } from '../lib/geo';
import { GEOFENCE_REASON_LABELS } from '../lib/clockRules';
import * as timeApi from '../lib/timeApi';
import TimeEntryModal from '../components/TimeEntryModal';
import DriveTimeReport from '../components/DriveTimeReport';
import { flagBadgeVariant, flagLabel, varianceFlag } from '../lib/variance';
import { driveFlagLabel } from '../lib/driveTime';
import * as driveApi from '../lib/driveApi';
import { currentWeekMinutesByUser, otStatus, startOfPayWeek, minutesToHours } from '../lib/payroll';
import { fmtDuration, fmtDelta, fmtDate, fmtTime, startOfWeek, startOfMonth, dayKey, todayKey, composeIso, addDaysKey, startOfDayKey, startOfQuarterKey, startOfYearKey } from '../lib/dates';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from '../components/ListPager';

const EMPTY = [];

// Two-letter initials for a cleaner's avatar in the drill-down ledger.
const cleanerInitials = (name) =>
  (name || '').split(' ').filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2) || '—';

const PERIODS = [
  { value: 'last_night', label: 'Last night' },
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'wtd', label: 'WTD' },
  { value: 'mtd', label: 'MTD' },
  { value: 'qtd', label: 'QTD' },
  { value: 'ytd', label: 'YTD' },
  { value: 'custom', label: 'Custom' },
];

// Resolve a period pill (+ custom from/to) into an ISO window. "Last night" is a
// noon-to-noon window (yesterday 12:00 → today 12:00, capped at now) so one
// overnight shift falls in one bucket. All boundaries anchor to the ORG's calendar
// day (company.timezone), so a clean finishing after midnight lands in the right
// local day and the report reads the same for the office and an off-site VA.
function resolvePeriod(period, custom, now = new Date()) {
  const end = now.toISOString();
  const todayK = dayKey(now);
  const back = (n) => startOfDayKey(addDaysKey(todayK, -n)).toISOString(); // org day-start N days ago
  switch (period) {
    case 'last_night': {
      const todayNoon = new Date(composeIso(todayK, '12:00'));
      const from = composeIso(addDaysKey(todayK, -1), '12:00');
      const to = now < todayNoon ? now.toISOString() : todayNoon.toISOString();
      return { fromIso: from, toIso: to };
    }
    case '24h': return { fromIso: new Date(now.getTime() - 86400000).toISOString(), toIso: end };
    case '7d': return { fromIso: back(7), toIso: end };
    case '30d': return { fromIso: back(30), toIso: end };
    case '90d': return { fromIso: back(90), toIso: end };
    case 'wtd': return { fromIso: startOfWeek(now).toISOString(), toIso: end };
    case 'mtd': return { fromIso: startOfMonth(now).toISOString(), toIso: end };
    case 'qtd': return { fromIso: startOfDayKey(startOfQuarterKey(todayK)).toISOString(), toIso: end };
    case 'ytd': return { fromIso: startOfDayKey(startOfYearKey(todayK)).toISOString(), toIso: end };
    case 'custom': return {
      fromIso: custom?.from ? composeIso(custom.from, '00:00') : null,
      toIso: custom?.to ? composeIso(custom.to, '23:59') : null,
    };
    default: return { fromIso: null, toIso: null };
  }
}

// Re-aggregate the clean rows for the by-cleaner / by-location group-by. A clean
// worked by N cleaners contributes to N cleaner rows, each credited that cleaner's
// OWN minutes (shares sum back to the labor total — the multi-cleaner fix).
function aggregateByCleaner(rows) {
  const map = new Map();
  for (const r of rows) {
    for (const c of r.cleaners) {
      const cur = map.get(c.userId) || { key: c.userId, name: c.userName, cleanCount: 0, laborMinutes: 0, flaggedCount: 0 };
      cur.cleanCount += 1;
      cur.laborMinutes += c.durationMinutes || 0;
      if (r.flag === 'over' || r.flag === 'under') cur.flaggedCount += 1;
      map.set(c.userId, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.laborMinutes - a.laborMinutes);
}
function aggregateByLocation(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.siteId || r.clientId || r.key;
    const cur = map.get(key) || { key, name: r.clientName, sub: r.clientName, cleanCount: 0, laborMinutes: 0, flaggedCount: 0, varSum: 0, varCount: 0 };
    cur.cleanCount += 1;
    cur.laborMinutes += r.laborMinutes || 0;
    if (r.flag === 'over' || r.flag === 'under') cur.flaggedCount += 1;
    if (r.variance != null) { cur.varSum += r.variance; cur.varCount += 1; }
    map.set(key, cur);
  }
  return [...map.values()]
    .map((g) => ({ ...g, avgVariance: g.varCount ? Math.round(g.varSum / g.varCount) : null }))
    .sort((a, b) => b.flaggedCount - a.flaggedCount || b.laborMinutes - a.laborMinutes);
}

function downloadCsv(rows) {
  const head = ['Date', 'Account', 'Cleaners', 'Expected (min)', 'Actual (min)', 'Variance (min)', 'Flag'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.join(',')];
  for (const r of rows) {
    const cleaners = r.cleaners.map((c) => `${c.userName} (${c.durationMinutes}m)`).join('; ');
    lines.push([
      r.scheduledStart ? `${fmtDate(r.scheduledStart)} ${fmtTime(r.scheduledStart)}` : '',
      r.clientName, cleaners,
      r.expectedMinutes ?? '', r.actualMinutes ?? '', r.variance ?? '', flagLabel(r.flag),
    ].map(esc).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `variance-${todayKey()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// Paid travel between jobs. "Paid (min)" is what payroll uses — it differs from
// the recorded drive only where a manager adjusted the leg, and the reason rides
// along so the export explains itself.
function downloadDriveCsv(rows) {
  const head = ['Date', 'Cleaner', 'From', 'To', 'Left', 'Arrived', 'Drive (min)', 'Estimate (min)', 'Over (min)', 'Flag', 'Paid (min)', 'Adjusted by', 'Adjustment reason'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.startAt ? fmtDate(r.startAt) : '',
      r.userName, r.fromClientName, r.toClientName,
      r.startAt ? fmtTime(r.startAt) : '', r.endAt ? fmtTime(r.endAt) : '',
      r.actualMinutes, r.estimateMinutes ?? '', r.flag === 'over' ? r.overMinutes : '',
      driveFlagLabel(r.flag), r.paidMinutes ?? r.actualMinutes,
      r.override?.createdByName || '', r.override?.reason || '',
    ].map(esc).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `drive-time-${todayKey()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function StatCard({ label, value, tone }) {
  return (
    <div className={`stat-card${tone ? ` tone-${tone}` : ''}`}>
      <div className="stat-val">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function Variance() {
  const state = useStore();
  const navigate = useNavigate();
  const nav = useFromHere();
  const { currentUser } = useAuth();
  const toast = useToast();
  const canAct = usePermission('variance.actions');
  const canExport = usePermission('variance.export');
  const canPayroll = usePermission('payroll.view');
  const canEdit = usePermission('time.edit.all');
  const canApprove = usePermission('time.approve');

  const [searchParams, setSearchParams] = useSearchParams();
  // Two reports share this page's period + filter chrome: clocked labor vs
  // expected, and paid travel BETWEEN cleans. URL-persisted so a link restores the
  // exact view (UI_RULES §21).
  const view = searchParams.get('view') === 'drive' ? 'drive' : 'labor';
  const period = searchParams.get('p') || 'last_night';
  const custom = { from: searchParams.get('cf') || '', to: searchParams.get('ct') || '' };
  const setParam = (key, value, def) => {
    const next = new URLSearchParams(searchParams);
    if (value === '' || value == null || value === def) next.delete(key); else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const filters = useUrlFilters(varianceFilterSpecs);
  const filterCtx = useMemo(() => ({ state, user: currentUser }), [state, currentUser]);
  const groupBy = filters.values.group || 'clean';

  const [data, setData] = useState(null); // { rows, summary, basis, threshold, truncated }
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [openEntries, setOpenEntries] = useState([]); // who's on the clock now (projection)
  const [manualOpen, setManualOpen] = useState(false);
  const [correctTarget, setCorrectTarget] = useState(null);
  const [otRows, setOtRows] = useState([]); // cleaners at/over 40h THIS week (projection)
  // Why the watch may be wrong: 'hours' = the week's punches didn't load (it can't say who
  // is near 40h); 'drive' = punches loaded but paid drive didn't (labor only — it may
  // under-warn). Said on the strip; an empty strip used to read as "nobody near OT".
  const [otIssue, setOtIssue] = useState(null);
  const [driveRows, setDriveRows] = useState([]); // hoisted from the drive view for the shared CSV button

  const ops = state.opsSettings || {};
  const request = useMemo(() => {
    const window = resolvePeriod(period, custom);
    return {
      fromIso: window.fromIso,
      toIso: window.toIso,
      filters: {
        siteIds: filters.values.loc?.length ? filters.values.loc : null,
        userIds: filters.values.cleaner?.length ? filters.values.cleaner : null,
        flaggedOnly: filters.values.flagged === '1',
      },
      config: {
        basis: ops.expectedBasis || 'labor',
        thresholds: { overMins: ops.varianceFlagOverMins ?? 15, underMins: ops.varianceFlagUnderMins ?? 15 },
      },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, custom.from, custom.to, filters.values.loc, filters.values.cleaner, filters.values.flagged, ops.expectedBasis, ops.varianceFlagOverMins, ops.varianceFlagUnderMins]);

  // The drive view's window, memoized on the SAME deps as `request`. resolvePeriod
  // defaults `now` to this instant, so calling it inline in render would hand the
  // child a new toIso every pass and spin its fetch effect forever.
  const driveWindow = useMemo(
    () => resolvePeriod(period, custom),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [period, custom.from, custom.to],
  );

  const load = useCallback(async () => {
    if (view !== 'labor') return;   // the drive view owns its own fetch
    setError(null); setData(null);
    try { setData(await fetchReport(request)); } catch (e) { setError(e.message || 'Could not load the variance report.'); }
  }, [request, view]);
  useEffect(() => { load(); }, [load]);

  const loadOpen = useCallback(async () => {
    try { setOpenEntries(await timeApi.open()); } catch { /* projection — best-effort */ }
  }, []);
  useEffect(() => { loadOpen(); }, [loadOpen]);

  // Approaching-40h lens: this week's CLOCKED labor per cleaner (operational —
  // approved or not), surfaced so a manager sees OT building BEFORE payroll. This
  // is independent of the selected report period. Best-effort projection.
  const loadOt = useCallback(async () => {
    try {
      const now = new Date();
      const ws = startOfPayWeek(now, 0);
      const we = new Date(ws); we.setDate(we.getDate() + 7);
      const entries = await timeApi.rollup({ fromIso: ws.toISOString(), toIso: we.toISOString() });
      // Paid drive time is hours worked, so the 40h watch has to include it — or it
      // under-warns for exactly the cleaners doing the most driving. The payroll read
      // (complete for the week, compact rows) also keeps this background poll off the
      // billable route lookup.
      let driveSegments = [];
      let driveLoaded = true;
      try {
        const drive = await driveApi.report({
          fromIso: ws.toISOString(), toIso: we.toISOString(), payroll: true,
          config: { maxGapMins: ops.driveMaxGapMins }, sites: state.sites,
        });
        driveSegments = drive?.rows || [];
      } catch { driveLoaded = false; /* labor-only OT watch is still useful — flagged as such */ }
      const byUser = currentWeekMinutesByUser(entries, { now: now.getTime(), weekStartDay: 0, driveSegments });
      const flagged = [...byUser.values()]
        .map((u) => ({ ...u, status: otStatus(u.minutes) }))
        .filter((u) => u.status)
        .sort((a, b) => b.minutes - a.minutes);
      setOtRows(flagged);
      setOtIssue(driveLoaded ? null : 'drive');
    } catch { setOtRows([]); setOtIssue('hours'); }
  }, [ops.driveMaxGapMins, state.sites]);
  useEffect(() => { loadOt(); }, [loadOt]);

  const approve = async (entryId, approval) => {
    try {
      await timeApi.approveEntry({ entryId, approval });
      toast.success(approval === 'rejected' ? 'Entry rejected' : 'Entry approved');
      load();
    } catch (e) { toast.error(e.message || 'Could not update approval'); }
  };
  const afterEdit = () => { load(); loadOpen(); loadOt(); };

  const rows = data?.rows || [];
  const cleanerRows = useMemo(() => aggregateByCleaner(rows), [rows]);
  const locationRows = useMemo(() => aggregateByLocation(rows), [rows]);
  // One pager per group-by view — all declared unconditionally (only one view
  // renders at a time). SAFE for the star: the StatCards read data.summary
  // (server-aggregated), the on-the-clock/OT strips read otRows/openEntries, and
  // the CSV reads the full `rows` — NONE of them read these page slices. resetKey:
  // request, so loading a new period/filter snaps every view back to page 1.
  const cleanerPager = usePagedRows(cleanerRows, { resetKey: request });
  const locationPager = usePagedRows(locationRows, { resetKey: request });
  const cleanPager = usePagedRows(rows, { resetKey: request });
  const basisLabel = (data?.basis || ops.expectedBasis) === 'wallclock' ? 'wall-clock' : 'labor-minutes';

  return (
    <div className="page">
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1>Variance</h1>
          {view === 'drive' ? (
            <p className="page-sub">Paid drive time between cleans: clock out at one site to clock in at the next, compared to the mapped drive. The trip from home to the first clean, and home from the last, is never counted.</p>
          ) : (
            <p className="page-sub">Clocked labor vs expected, per clean. Multi-cleaner attributed, flagged at ±{data?.threshold?.overMins ?? ops.varianceFlagOverMins ?? 15} min. Basis: {basisLabel}.</p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {canEdit && view === 'labor' && <button className="btn btn-primary" onClick={() => setManualOpen(true)}>Add time entry</button>}
          {canPayroll && <button className="btn btn-primary" onClick={() => navigate('/payroll')}><Icon name="invoices" size={15} /> Payroll</button>}
          {canExport && view === 'labor' && rows.length > 0 && (
            <button className="btn btn-success" onClick={() => downloadCsv(rows)}><Icon name="upload" size={15} /> Export CSV</button>
          )}
          {canExport && view === 'drive' && driveRows.length > 0 && (
            <button className="btn btn-success" onClick={() => downloadDriveCsv(driveRows)}><Icon name="upload" size={15} /> Export CSV</button>
          )}
        </div>
      </div>

      {/* Which report — labor vs paid travel between cleans */}
      <div className="tab-container-line" role="group" aria-label="Report">
        <button type="button" className={`tab-btn ${view === 'labor' ? 'active' : ''}`} onClick={() => setParam('view', 'labor', 'labor')}>Labor variance</button>
        <button type="button" className={`tab-btn ${view === 'drive' ? 'active' : ''}`} onClick={() => setParam('view', 'drive', 'labor')}>Drive time</button>
      </div>

      {/* Period pills */}
      <div className="tab-container-line variance-periods" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button key={p.value} type="button" className={`tab-btn ${period === p.value ? 'active' : ''}`} onClick={() => setParam('p', p.value, 'last_night')}>
            {p.label}
          </button>
        ))}
      </div>
      {period === 'custom' && (
        <div className="facet-daterange-custom" style={{ marginBottom: 12 }}>
          <input type="date" className="input" aria-label="From" value={custom.from} onChange={(e) => setParam('cf', e.target.value)} />
          <span className="facet-daterange-sep" aria-hidden>–</span>
          <input type="date" className="input" aria-label="To" value={custom.to} onChange={(e) => setParam('ct', e.target.value)} />
        </div>
      )}

      {/* Operational strips sit above the facets: they're live status for the whole
          page (both reports), not a property of the filtered result set. */}
      {/* Approaching / over 40h this week (operational OT lens) */}
      {(otRows.length > 0 || otIssue) && (
        <div className="onclock-strip ot-strip" role="status">
          <span className="onclock-label"><Icon name="warning" size={14} /> Overtime watch (this week)</span>
          {otIssue === 'hours' ? (
            <span className="onclock-chip">This week’s hours didn’t load, so nobody near 40h can be shown</span>
          ) : otRows.map((u) => (
            <Badge key={u.userId} variant={u.status === 'over' ? 'red' : 'amber'}>
              {u.userName} · {minutesToHours(u.minutes)}h{u.status === 'over' ? ' · OT' : ' · nearing 40h'}
            </Badge>
          ))}
          {otIssue === 'drive' && (
            <span className="onclock-chip">
              {otRows.length ? 'Labor only: paid drive time didn’t load' : 'Nobody near 40h on labor alone: paid drive time didn’t load'}
            </span>
          )}
          {otIssue && <button type="button" className="btn btn-outline" onClick={loadOt}>Retry</button>}
        </div>
      )}

      {/* Who's on the clock right now (live projection) */}
      {openEntries.length > 0 && (
        <div className="onclock-strip" role="status">
          <span className="onclock-label"><Icon name="schedule" size={14} /> On the clock now</span>
          {openEntries.map((e) => (
            <span className="onclock-chip" key={e.id}>{e.user_name || 'Cleaner'} · {e.client_name || e.site_name || '—'} · since {fmtTime(e.clock_in_at)}</span>
          ))}
        </div>
      )}

      {view === 'drive' ? (
        <DriveTimeReport
          window={driveWindow}
          canAct={canAct}
          onRowsChange={setDriveRows}
        />
      ) : (
      <>
      <FilterBar
        specs={varianceFilterSpecs}
        values={filters.values}
        setValue={filters.setValue}
        clearAll={filters.clearAll}
        activeCount={filters.activeCount}
        ctx={filterCtx}
      />

      {/* Summary */}
      {data?.summary && (
        <div className="stat-grid variance-stats">
          <StatCard label="Cleans" value={data.summary.cleanCount} />
          <StatCard label="Flagged" value={data.summary.flaggedCount} tone={data.summary.flaggedCount > 0 ? 'danger' : null} />
          <StatCard label="Avg variance" value={data.summary.avgVarianceMins != null ? fmtDelta(data.summary.avgVarianceMins) : '—'} />
          <StatCard label="Total labor" value={fmtDuration(data.summary.totalLaborMinutes)} />
        </div>
      )}
      {data?.truncated && (
        <p className="text-muted text-xs" style={{ margin: '0 0 8px' }}>
          <Icon name="warning" size={12} /> Showing the most recent results in this window. Narrow the period or filters to see everything.
        </p>
      )}

      {/* Body */}
      {error ? (
        <div className="card" style={{ textAlign: 'center', padding: 24 }}>
          <p style={{ color: 'var(--danger)' }}>{error}</p>
          <button className="btn btn-outline" onClick={load}>Retry</button>
        </div>
      ) : data === null ? (
        <div className="card" style={{ padding: 24 }}>Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<Icon name="chart" size={28} />} title="No clocked cleans in this window" message="When crew clock in and out, their cleans show here against the expected time." />
      ) : groupBy === 'cleaner' ? (
        <div className="table-wrap mobile-stack">
          <table>
            <thead><tr><th>Cleaner</th><th>Cleans</th><th>Labor</th><th>Flagged</th></tr></thead>
            <tbody>
              {cleanerPager.pageRows.map((c) => (
                <tr key={c.key}>
                  <td className="cell-primary"><span className="truncate" title={c.name}>{c.name}</span></td><td data-label="Cleans">{c.cleanCount}</td><td data-label="Labor">{fmtDuration(c.laborMinutes)}</td>
                  <td data-label="Flagged">{c.flaggedCount > 0 ? <Badge variant="red">{c.flaggedCount}</Badge> : <span className="text-muted">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ListPager pager={cleanerPager} noun="cleaners" />
        </div>
      ) : groupBy === 'location' ? (
        <div className="table-wrap mobile-stack">
          <table>
            <thead><tr><th>Location</th><th>Cleans</th><th>Labor</th><th>Avg variance</th><th>Flagged</th></tr></thead>
            <tbody>
              {locationPager.pageRows.map((l) => (
                <tr key={l.key}>
                  <td className="cell-primary"><span className="truncate" title={l.name}>{l.name}</span></td><td data-label="Cleans">{l.cleanCount}</td><td data-label="Labor">{fmtDuration(l.laborMinutes)}</td>
                  <td data-label="Avg variance">{l.avgVariance != null ? fmtDelta(l.avgVariance) : '—'}</td>
                  <td data-label="Flagged">{l.flaggedCount > 0 ? <Badge variant="red">{l.flaggedCount}</Badge> : <span className="text-muted">0</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ListPager pager={locationPager} noun="locations" />
        </div>
      ) : (
        <div className="table-wrap mobile-stack">
          <table>
            <thead><tr><th></th><th>Clean</th><th>Crew</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Flag</th></tr></thead>
            <tbody>
              {cleanPager.pageRows.map((r) => (
                <RowGroup
                  key={r.key} row={r} expanded={expanded === r.key}
                  onToggle={() => setExpanded(expanded === r.key ? null : r.key)}
                  canApprove={canApprove} canEdit={canEdit}
                  onApprove={approve} onCorrect={(entry) => setCorrectTarget(entry)}
                  navigate={navigate} nav={nav}
                  thresholds={data?.threshold || { overMins: ops.varianceFlagOverMins ?? 15, underMins: ops.varianceFlagUnderMins ?? 15 }}
                />
              ))}
            </tbody>
          </table>
          <ListPager pager={cleanPager} noun="cleans" />
        </div>
      )}
      </>
      )}

      <TimeEntryModal open={manualOpen} onClose={() => setManualOpen(false)} mode="manual" onSaved={afterEdit} />
      <TimeEntryModal open={!!correctTarget} onClose={() => setCorrectTarget(null)} mode="correct" entry={correctTarget} onSaved={afterEdit} />
    </div>
  );
}

// An 'override' verdict means three different things — the location's geofence is off, the
// office turned it off for THIS cleaner (step 4b / R7), or the cleaner clocked in off-site
// anyway — so the reason on the punch names which. A bare "override" badge read as "the
// cleaner bypassed the ring" for a punch nobody bypassed. An unlabelled reason (a manager's
// typed correction) keeps the plain badge and shows as stored.
function geoBadge(result, overrideReason) {
  if (result === 'inside') return <Badge variant="green">on-site</Badge>;
  if (result === 'outside') return <Badge variant="red">off-site</Badge>;
  if (result === 'override') {
    const label = GEOFENCE_REASON_LABELS[overrideReason];
    return <Badge variant="amber" title={label || overrideReason || undefined}>{label || 'override'}</Badge>;
  }
  if (result === 'no_site_coords' || result === 'unavailable') return <Badge variant="slate">no GPS</Badge>;
  return null;
}
function approvalBadge(status) {
  if (status === 'approved') return <Badge variant="green">approved</Badge>;
  if (status === 'rejected') return <Badge variant="red">rejected</Badge>;
  return <Badge variant="white">pending</Badge>;
}

function RowGroup({ row, expanded, onToggle, canApprove, canEdit, onApprove, onCorrect, navigate, nav, thresholds }) {
  // A clean's time entries are a child component's own list, so each expanded row
  // pages independently (a hook can't live in the parent's rows.map). Usually a
  // handful of cleaners — the pager only appears past 20.
  const entriesPager = usePagedRows(row.entries || EMPTY);
  // Per-cleaner expected = the clean baseline split evenly across the crew, so the
  // drill's Expected/Actual/Variance columns SUM back to the clean header exactly
  // (the Totals row proves it). Even-split is the labor-basis-correct allocation —
  // labor actual is Σ each cleaner's minutes, so expected has to divide the same way.
  const expPerCleaner = (row.expectedMinutes != null && row.cleanerCount)
    ? Math.round(row.expectedMinutes / row.cleanerCount)
    : null;
  return (
    <>
      <tr className={`variance-row${expanded ? ' expanded' : ''}`} onClick={onToggle} style={{ cursor: 'pointer' }}>
        <td className="cell-chevron"><Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} /></td>
        <td className="cell-primary">
          <div className="variance-clean-site truncate" title={row.clientName}>{row.clientName}</div>
          <div className="text-muted text-xs">{row.scheduledStart ? `${fmtDate(row.scheduledStart)} ${fmtTime(row.scheduledStart)}` : ''}</div>
        </td>
        <td data-label="Crew">{row.cleanerCount} {row.cleanerCount === 1 ? 'cleaner' : 'cleaners'}</td>
        <td data-label="Expected">{row.expectedMinutes != null ? fmtDuration(row.expectedMinutes) : <span className="text-muted">—</span>}</td>
        <td data-label="Actual">{row.actualMinutes != null ? fmtDuration(row.actualMinutes) : <span className="text-muted">In progress</span>}</td>
        <td data-label="Variance">{row.variance != null ? <strong>{fmtDelta(row.variance)}</strong> : <span className="text-muted">—</span>}</td>
        <td data-label="Flag"><Badge variant={flagBadgeVariant(row.flag)}>{flagLabel(row.flag)}</Badge></td>
      </tr>
      {expanded && (
        <tr className="variance-drill">
          <td colSpan={7}>
            <div className="variance-drill-panel">
              <div className="variance-drill-bar">
                <span className="variance-drill-head">Time entries · {row.cleanerCount} {row.cleanerCount === 1 ? 'cleaner' : 'cleaners'}</span>
                {row.jobId && (
                  <button className="btn btn-primary" onClick={() => navigate(`/schedule/${row.jobId}`, { state: nav })}>
                    View clean details <Icon name="chevronRight" size={14} style={{ color: 'var(--color-brand-secondary-500)' }} />
                  </button>
                )}
              </div>
              <div className="variance-entries-wrap">
                <table className="variance-entries">
                  <thead>
                    <tr>
                      <th>Cleaner</th>
                      <th className="col-num">Expected</th>
                      <th className="col-num">Actual</th>
                      <th className="col-num">Variance</th>
                      <th>Clock-in</th>
                      <th>Approval</th>
                      <th className="col-review">Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entriesPager.pageRows.map((e) => {
                      const actual = e.clockOutAt ? e.durationMinutes : null;
                      const perVar = (expPerCleaner != null && actual != null) ? actual - expPerCleaner : null;
                      const perFlag = varianceFlag(perVar, expPerCleaner != null, thresholds);
                      const varClass = perFlag === 'over' ? 'var-over' : perFlag === 'under' ? 'var-under' : 'var-ok';
                      return (
                        <tr key={e.id}>
                          <td>
                            <div className="entry-cleaner">
                              <Avatar initials={cleanerInitials(e.userName)} variant={(String(e.userId || '').length % 5) + 1} size="sm" />
                              <div className="entry-idbox">
                                <div className="entry-name truncate" title={e.userName}>{e.userName}{!e.clockOutAt ? <span className="text-muted text-xs"> · on the clock</span> : ''}</div>
                                <div className="entry-window text-xs">{e.clockInAt ? fmtTime(e.clockInAt) : '—'}{e.clockOutAt ? `–${fmtTime(e.clockOutAt)}` : ''}</div>
                              </div>
                            </div>
                          </td>
                          <td className="col-num">{expPerCleaner != null ? fmtDuration(expPerCleaner) : <span className="text-muted">—</span>}</td>
                          <td className="col-num entry-actual">{actual != null ? fmtDuration(actual) : <span className="text-muted">In progress</span>}</td>
                          <td className={`col-num entry-var ${varClass}`}>{perVar != null ? fmtDelta(perVar) : <span className="text-muted">—</span>}</td>
                          <td>{geoBadge(e.geofenceResult, e.overrideReason)}{e.distanceM != null && <span className="text-muted text-xs"> {metersToFeet(e.distanceM)} ft</span>}</td>
                          <td>{approvalBadge(e.approvalStatus)}</td>
                          <td className="col-review variance-entry-actions">
                            {canApprove && e.clockOutAt && e.approvalStatus !== 'approved' && <button className="btn btn-sm btn-gold" onClick={() => onApprove(e.id, 'approved')}>Approve</button>}
                            {canApprove && e.clockOutAt && e.approvalStatus !== 'rejected' && <button className="btn btn-sm btn-outline" onClick={() => onApprove(e.id, 'rejected')}>Reject</button>}
                            {canEdit && <button className="btn btn-sm btn-outline" onClick={() => onCorrect({ ...e, siteName: row.siteName, clientName: row.clientName })}>Correct</button>}
                          </td>
                        </tr>
                      );
                    })}
                    {row.expectedMinutes != null && (
                      <tr className="variance-entries-total">
                        <td className="total-label">Totals · {row.cleanerCount} {row.cleanerCount === 1 ? 'cleaner' : 'cleaners'}</td>
                        <td className="col-num">{fmtDuration(row.expectedMinutes)}</td>
                        <td className="col-num">{row.actualMinutes != null ? fmtDuration(row.actualMinutes) : <span className="text-muted">—</span>}</td>
                        <td className={`col-num ${row.flag === 'over' ? 'var-over' : row.flag === 'under' ? 'var-under' : 'var-ok'}`}>{row.variance != null ? fmtDelta(row.variance) : <span className="text-muted">—</span>}</td>
                        <td></td>
                        <td></td>
                        <td></td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <ListPager pager={entriesPager} noun="entries" />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
