// One customer's activity log, as a sub-tab of their Activity tab (CS-379; Matt's LOG-1..8).
// This is the surface a dispute starts from: what happened on this account, who did it, and
// the PDF + spreadsheet to send (LOG-6).
//
// WHAT IT SHOWS IS DECIDED ON THE SERVER (LOG-4) — the owner everything, an admin everything
// except pay and money, a manager only the customers they supervise, crew nothing. The tab
// renders what /api/activity served and says which scope that was; it never filters for
// security itself (the blob is on-device, so a client filter is not a boundary).
import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import EmptyState from './EmptyState';
import FormField from './FormField';
import FilterSelect from './FilterSelect';
import ListPager from './ListPager';
import { useStore } from '../store';
import usePagedRows from '../hooks/usePagedRows';
import { getOrgTimezone, todayKey, addDaysKey, startOfDayKey } from '../lib/dates';
import {
  ACTION_GROUPS, actionLabel, actorLabel, beforeAfterText, fmtStampIn, RETENTION_YEARS,
} from '../lib/activityLog';
import * as activityApi from '../lib/activityApi';
import { canRetryError } from '../pages/reports/reportKit';

// The windows this tab offers. The whole retention period is the honest maximum — the log
// keeps three years and nothing older exists to fetch.
const RANGES = [
  { value: '30', label: 'Last 30 days', days: 30 },
  { value: '90', label: 'Last 90 days', days: 90 },
  { value: '365', label: 'Last 12 months', days: 365 },
];
const PAGE = 50;

export default function ClientActivityLog({ client }) {
  const state = useStore();
  const tz = getOrgTimezone();
  // The roster, for a row whose actor name was not denormalized (the jobs path).
  const usersById = useMemo(() => new Map((state.users || []).map((u) => [u.id, u])), [state.users]);
  const [range, setRange] = useState('90');
  const [group, setGroup] = useState('');
  const [rows, setRows] = useState(null);      // null = loading
  const [total, setTotal] = useState(0);
  const [scope, setScope] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const win = useMemo(() => {
    const days = RANGES.find((r) => r.value === range)?.days || 90;
    // ORG-zone days, like every other range in the app (THE LAW II.8) — a device in another
    // timezone must not ask for a different window than the schedule and payroll use.
    const from = startOfDayKey(addDaysKey(todayKey(tz), -days), tz);
    return { fromIso: from.toISOString(), toIso: new Date().toISOString() };
  }, [range, tz]);

  const load = useCallback(async (offset) => {
    setBusy(true);
    if (offset === 0) { setRows(null); setError(null); }
    try {
      const r = await activityApi.list({
        ...win, clientId: client.id, group: group || null, offset, limit: PAGE,
      });
      setTotal(r.total || 0);
      setScope(r.scope || (r.stub ? { stub: true } : null));
      setRows((prev) => (offset > 0 && prev ? [...prev, ...(r.entries || [])] : (r.entries || [])));
    } catch (e) {
      setRows(null);
      setError(e);
    } finally { setBusy(false); }
  }, [win, client.id, group]);

  useEffect(() => { load(0); }, [load, reloadKey]);

  const doExport = useCallback(async (format) => {
    setBusy(true);
    try {
      await activityApi.exportFile({ format, clientId: client.id, ...win });
      setError(null);
    } catch (e) { setError(e); } finally { setBusy(false); }
  }, [client.id, win]);

  const groupOptions = useMemo(() => [
    { value: '', label: 'Everything' },
    ...ACTION_GROUPS.map((g) => ({ value: g.id, label: g.label })),
  ], []);

  const clientNameNow = client.name;

  // TWO pagers, and they are not redundant: the SERVER pages what has been FETCHED (50 at a
  // time, because the log grows forever), and this pages what is on SCREEN (UI_RULES §50 /
  // lint:tables — 20 rows, so a busy account's period doesn't render a thousand <tr>s). The
  // reset key is the rows reference, so a fresh period or filter snaps back to page 1.
  const pager = usePagedRows(rows || [], { resetKey: rows });

  if (error) {
    return (
      <EmptyState
        icon={<Icon name="warning" size={28} />}
        title="Couldn’t load the activity log"
        message={error.message || 'The activity log could not be read. Check your connection and try again.'}
        action={canRetryError(error) ? <button type="button" className="btn btn-primary" onClick={() => setReloadKey((k) => k + 1)}>Try again</button> : null}
      />
    );
  }

  return (
    <>
      <div className="filter-bar">
        <FormField label="Period">
          <FilterSelect
            ariaLabel="Period"
            value={range}
            onChange={(v) => setRange(v)}
            options={RANGES.map((r) => ({ value: r.value, label: r.label }))}
          />
        </FormField>
        <FormField label="Action type">
          <FilterSelect ariaLabel="Action type" value={group} onChange={(v) => setGroup(v)} options={groupOptions} />
        </FormField>
      </div>

      <div className="reports-actions">
        <button type="button" className="btn btn-gold" onClick={() => doExport('csv')} disabled={busy || !rows || rows.length === 0}>
          <Icon name="upload" size={15} /> Export spreadsheet
        </button>
        <button type="button" className="btn btn-outline" onClick={() => doExport('pdf')} disabled={busy || !rows || rows.length === 0}>
          <Icon name="upload" size={15} /> Export PDF
        </button>
        <span className="hint reports-run-note">
          {scopeMessage(scope) || `Kept ${RETENTION_YEARS} years. Entries are written when the action happens and can’t be edited.`}
        </span>
      </div>

      {rows === null ? (
        <div className="card reports-body-card">Loading…</div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="chart" size={28} />}
          title="Nothing recorded yet"
          message={`No activity was recorded for ${clientNameNow} in this period.`}
        />
      ) : (
        <>
          <div className="table-wrap mobile-stack">
            <table>
              <thead>
                <tr><th>When</th><th>Who</th><th>Action</th><th>What happened</th></tr>
              </thead>
              <tbody>
                {pager.pageRows.map((r) => {
                  const change = beforeAfterText(r, tz);
                  return (
                    <tr key={r.id}>
                      <td className="cell-primary" style={{ whiteSpace: 'nowrap' }}>{fmtStampIn(r.occurredAt, tz)}</td>
                      <td data-label="Who">{actorLabel(r, usersById)}</td>
                      <td data-label="Action" style={{ whiteSpace: 'nowrap' }}>{actionLabel(r.action)}</td>
                      <td data-label="What happened">
                        <span>{r.summary}</span>
                        {change && <span className="text-muted text-xs" style={{ display: 'block' }}>{change}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <ListPager pager={pager} noun="entries" />
          </div>
          {rows.length < total && (
            <div className="reports-actions">
              <button type="button" className="btn btn-outline" onClick={() => load(rows.length)} disabled={busy}>
                {busy ? 'Loading…' : `Load ${Math.min(PAGE, total - rows.length)} more of ${total}`}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

// What the server served, said plainly, so a scoped view is never mistaken for the whole
// record. `visibility` comes from the read route (LOG-4).
function scopeMessage(scope) {
  if (!scope) return null;
  if (scope.stub) return 'The activity log lives on the server — sign in to the connected app to read it.';
  if (scope.visibility === 'no-money') return 'Pay and money changes are hidden at your access level.';
  return null;
}
