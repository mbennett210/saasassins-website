// Payroll — the pay run. Four layout DIRECTIONS (Register / Wizard / Roster / Review)
// over one data hook, selected through the SAME picker mechanism as the Account-Manager
// dashboard layout picker: a modal with live previews + a Choose/Request-changes/Note
// footer, persisted to the client-review `picks` slice (survives reload) and surfaced
// by a banner at the top of the page. Scope: calculate + export CSV (no tax filing).
import { useCallback, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSelector } from '../store';
import { selectCurrentUser } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { usePickReview } from '../store/ClientReviewProvider';
import { useToast } from '../components/Toast';
import Icon from '../components/Icon';
import { payrollPayCsv } from '../lib/payroll';
import { usePayrollRun } from './payroll/usePayrollRun';
import { PAY_TYPE, fmtHours, fmtSigned } from './payroll/shared';
import PayrollLineDrawer from './payroll/PayrollLineDrawer';
import PayrollLayoutReview from '../components/PayrollLayoutReview';
import { PAYROLL_PICK_ID, PAYROLL_DIRECTIONS, PAYROLL_DEFAULT_DIR } from '../components/PayrollLayoutPicker';

const DIR_CMP = Object.fromEntries(PAYROLL_DIRECTIONS.map((d) => [d.key, d.Cmp]));

// Hours or pay lines in this period from people since REMOVED from the team can't be
// priced (their pay rate left with them), so they aren't rows — but they must not
// vanish silently from the totals either. Removing someone with pay still owed is
// blocked, so this only shows for older periods (or records from before the block).
function RemovedNote({ removed }) {
  const label = (p) => {
    const bits = [];
    if (p.minutes) bits.push(`${fmtHours(p.minutes)} clocked`);
    if (p.lineNet) bits.push(`${fmtSigned(p.lineNet)} in pay lines`);
    return `${p.name || 'a removed team member'}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  };
  const names = removed.map(label);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  const one = removed.length === 1;
  return (
    <div className="callout callout-info pay-removed-note">
      <strong>Not on this run:</strong> {list}, {one ? 'who was' : 'who were'} removed from the team.
      {' '}{one ? 'Their pay rate was' : 'Their pay rates were'} removed with them, so this pay can't be calculated here or included in the export.
    </div>
  );
}

export default function Payroll() {
  const toast = useToast();
  const currentUser = useSelector(useCallback((s) => selectCurrentUser(s), []));
  const canEdit = usePermission('payroll.edit');

  // The chosen layout is a client-review pick (persisted), NOT a URL param — same as
  // the dashboard layout picker. Falls back to the default until a pick is made.
  const pick = usePickReview(PAYROLL_PICK_ID);
  const view = PAYROLL_DIRECTIONS.some((d) => d.key === pick.choice) ? pick.choice : PAYROLL_DEFAULT_DIR;

  // Pay period lives in the URL (?p= offset) so a period is shareable/back-restorable.
  const [searchParams, setSearchParams] = useSearchParams();
  const setOffset = (n) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (!n) next.delete('p'); else next.set('p', String(n));
    return next;
  }, { replace: true });
  const offset = parseInt(searchParams.get('p') || '0', 10) || 0;

  const { period, prevPeriod, rows, removed, summary, pending, held, loading, error } = usePayrollRun(offset);

  const [openUserId, setOpenUserId] = useState(null);
  const openRow = rows.find((r) => r.user.id === openUserId && !r.excluded) || null;

  const onExport = () => {
    if (loading || error) { toast.error('The pay run hasn’t fully loaded, so there is nothing to export yet.'); return; }
    const csvRows = rows.filter((r) => r.gross != null).map((r) => ({
      userName: r.user.name,
      payTypeLabel: (PAY_TYPE[r.payType] || {}).label || '',
      regularMinutes: r.hours ? r.hours.regularMinutes : null,
      otMinutes: r.hours ? r.hours.otMinutes : null,
      base: r.base, gross: r.gross, byCategory: r.totals.byCategory,
    }));
    if (!csvRows.length) { toast.error('No one on payroll this period'); return; }
    const csv = payrollPayCsv(csvRows, { fromIso: period.fromIso, toIso: period.toIso });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `payroll-${period.fromKey}_to_${period.toKey}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Payroll CSV exported');
  };

  const viewProps = { rows, period, prevPeriod, summary, pending, held, canEdit, onOpenPerson: (r) => setOpenUserId(r.user.id), onExport };
  const ActiveView = DIR_CMP[view];

  return (
    <div className="pay-page">
      <div className="pay-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Payroll</h1>
          <p className="pay-sub">{period.label} · {period.cadence === 'semimonthly' ? 'semi-monthly' : period.cadence}</p>
        </div>
        <div className="pay-head-controls">
          <span
            className={`pay-gate ${(error || pending || held.count) ? 'warn' : ''}`}
            title={held.count ? 'Labor on cancelled cleans is held from pay until a manager approves each punch (from Time clock or Variance).' : undefined}
          >
            <span className="pay-gate-dot" />
            {/* Never claim "Hours approved" about a run that hasn't loaded. */}
            {loading ? 'Loading hours…'
              : error ? 'Hours not loaded'
                : held.count ? `${held.count} held from pay` : (pending ? `${pending} pending approval` : 'Hours approved')}
          </span>
          <div className="pay-stepper">
            <button type="button" className="btn-icon btn-icon-ghost" onClick={() => setOffset(offset - 1)} aria-label="Previous pay period"><Icon name="chevronLeft" size={16} /></button>
            <span className="pay-stepper-cur">{period.label}</span>
            <button type="button" className="btn-icon btn-icon-ghost" onClick={() => setOffset(offset + 1)} aria-label="Next pay period" disabled={offset >= 0}><Icon name="chevronRight" size={16} /></button>
          </div>
          {/* Never export a run that is still loading or failed to load — its rows are
              empty or partial, and the file would go to the payroll company as if whole. */}
          <button className="btn btn-primary" onClick={onExport} type="button" disabled={loading || !!error}><Icon name="upload" size={15} /> Export CSV</button>
        </div>
      </div>

      <PayrollLayoutReview viewProps={viewProps} />

      {loading ? (
        <div className="pay-loading">Loading pay run…</div>
      ) : error ? (
        <div className="pay-error">{error}</div>
      ) : (
        <>
          {removed.length > 0 && <RemovedNote removed={removed} />}
          <ActiveView {...viewProps} />
        </>
      )}

      {openRow && (
        <PayrollLineDrawer row={openRow} period={period} canEdit={canEdit} currentUserId={currentUser && currentUser.id} onClose={() => setOpenUserId(null)} />
      )}
    </div>
  );
}
