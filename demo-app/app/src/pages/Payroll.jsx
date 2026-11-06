// Payroll — the pay run. Four layout DIRECTIONS (Register / Wizard / Roster / Review) over one
// data hook, selected through the SAME picker mechanism as the Account-Manager dashboard layout
// picker. Since wave W3-P the hook is a THIN READER of the server pay run (payrollApi.preview):
// pay is APPROVAL-BASED IN ARREARS, so a period is Open until a Super Admin closes it, closing
// pays the approved hours and downloads the final CSV, and anything still waiting rolls forward
// to the next payroll (or blocks the close, per the org's policy). Scope: pull payroll + export.
import { useCallback, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useSelector } from '../store';
import { selectCurrentUser } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { usePickReview } from '../store/ClientReviewProvider';
import { useToast } from '../components/Toast';
import Icon from '../components/Icon';
import { fmtDate } from '../lib/dates';
import { payrollPayCsv } from '../lib/payroll';
import * as payrollApi from '../lib/payrollApi';
import { usePayrollRun } from './payroll/usePayrollRun';
import { csvFileName } from './payroll/periodLock';
import { fmtHours, fmtSigned } from './payroll/shared';
import PayrollLineDrawer from './payroll/PayrollLineDrawer';
import ClosePeriodDialog from './payroll/ClosePeriodDialog';
import PayrollLayoutReview from '../components/PayrollLayoutReview';
import { PAYROLL_PICK_ID, PAYROLL_DIRECTIONS, PAYROLL_DEFAULT_DIR } from '../components/PayrollLayoutPicker';

const DIR_CMP = Object.fromEntries(PAYROLL_DIRECTIONS.map((d) => [d.key, d.Cmp]));
const cadenceLabel = (c) => (c === 'semimonthly' ? 'semi-monthly' : c);

// Hours or pay lines in this period from people since REMOVED from the team can't be priced
// (their pay rate left with them), so they aren't rows — but they must not vanish from the
// totals silently either. Removing someone with pay still owed is blocked, so this shows only
// for older periods (or records from before the block).
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

// The go/no-go card on an OPEN period: what's still waiting before this period can be closed.
// Held and pending time is NEVER priced into gross — this is where the manager sees it.
function ReadinessCard({ rolledForward, readiness }) {
  const { pendingCount = 0, pendingMinutes = 0, openCount = 0, otHeldMinutes = 0 } = rolledForward || {};
  const anything = pendingCount > 0 || openCount > 0 || otHeldMinutes > 0;
  return (
    <div className={`pay-readiness ${anything ? 'warn' : 'ok'}`}>
      <div className="pay-readiness-head">
        <span className="pay-readiness-dot" aria-hidden />
        <h4 className="pay-readiness-h">{anything ? 'Before you close' : 'Ready to close'}</h4>
      </div>
      {anything ? (
        <>
          <ul className="pay-readiness-list">
            {pendingCount > 0 && (
              <li>
                <strong>{pendingCount}</strong> {pendingCount === 1 ? 'punch' : 'punches'} waiting for approval
                <span className="pay-muted"> · {fmtHours(pendingMinutes)}</span>
                {readiness.some((g) => g.pendingCount) && (
                  <span className="pay-readiness-by">
                    {readiness.filter((g) => g.pendingCount).map((g) => `${g.supervisorName}: ${g.pendingCount}`).join(' · ')}
                  </span>
                )}
              </li>
            )}
            {otHeldMinutes > 0 && <li><strong>{fmtHours(otHeldMinutes)}</strong> overtime awaiting approval</li>}
            {openCount > 0 && <li><strong>{openCount}</strong> still clocked in</li>}
          </ul>
          <p className="pay-readiness-foot">
            Only approved hours are paid. Approve waiting punches on the <Link to="/approvals">Approvals</Link> page; anything still waiting is paid on the next payroll once approved.
            {' '}<Link to="/approvals?tab=missing">Missing time</Link> lists scheduled cleans with no clock-in.
          </p>
        </>
      ) : (
        <p className="pay-readiness-foot">Every clock-in in this period is approved. <Link to="/approvals?tab=missing">Missing time</Link> lists any scheduled cleans with no clock-in.</p>
      )}
    </div>
  );
}

export default function Payroll() {
  const toast = useToast();
  const currentUser = useSelector(useCallback((s) => selectCurrentUser(s), []));
  const canEdit = usePermission('payroll.edit');

  const pick = usePickReview(PAYROLL_PICK_ID);
  const view = PAYROLL_DIRECTIONS.some((d) => d.key === pick.choice) ? pick.choice : PAYROLL_DEFAULT_DIR;

  const [searchParams, setSearchParams] = useSearchParams();
  const setOffset = (n) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (!n) next.delete('p'); else next.set('p', String(n));
    return next;
  }, { replace: true });
  const offset = parseInt(searchParams.get('p') || '0', 10) || 0;

  const run = usePayrollRun(offset);
  const { period, isClosed, chip, rows, removed, summary, readiness, rolledForward, closable, closeBlockers, asOf, prevLabel, file, payDateKey, loading, error, reload } = run;

  const [openRowKey, setOpenRowKey] = useState(null);
  const openRow = rows.find((r) => r.key === openRowKey && !r.excluded) || null;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [closing, setClosing] = useState(false);

  // Download the CSV the server built (a closed run's final file, or an open period's draft).
  const download = (draft) => {
    if (loading || error || !file || !file.rows || !file.rows.length) { toast.error('There is nothing to export yet.'); return; }
    const csv = payrollPayCsv(file.rows, { fromIso: file.fromIso, toIso: file.toIso });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = csvFileName(period, { draft, payDateKey }); a.click();
    URL.revokeObjectURL(url);
    toast.success(draft ? 'Draft CSV downloaded' : 'Payroll CSV downloaded');
  };
  // The final CSV from a just-closed run downloads immediately.
  const downloadRun = (runRow) => {
    const f = runRow && runRow.file; if (!f || !f.rows) return;
    const csv = payrollPayCsv(f.rows, { fromIso: f.fromIso, toIso: f.toIso });
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    // PAY-2: the file the specialist files is named by the PAYDAY the run stored, not by today's.
    a.href = url; a.download = csvFileName(period, { draft: false, payDateKey: f.payDateKey || payDateKey }); a.click();
    URL.revokeObjectURL(url);
  };

  const doClose = async () => {
    setClosing(true);
    try {
      const { run: runRow } = await payrollApi.close({ periodKey: period.fromKey, asOf });
      setConfirmOpen(false);
      downloadRun(runRow);
      toast.success('Payroll closed — the final CSV downloaded.');
      reload();
    } catch (e) {
      const code = e && e.code;
      if (code === 'stale') { toast.error('Payroll changed since you loaded it. The numbers were refreshed — review them and close again.'); setConfirmOpen(false); reload(); }
      else if (code === 'period-order') { toast.error('Close the earliest open pay period first.'); }
      else if (code === 'period-closed') { toast.error('That pay period is already closed.'); setConfirmOpen(false); reload(); }
      else if (code === 'pending-blocks-close') { toast.error("Some hours still need a manager's approval, and this org is set not to close until everything is approved."); setConfirmOpen(false); reload(); }
      else if (code === 'not-ended') { toast.error('That pay period has not ended yet.'); }
      else toast.error((e && e.message) || 'Could not close the period.');
    } finally { setClosing(false); }
  };

  const blockedReason = closeBlockers.map((b) => {
    const code = typeof b === 'string' ? b : b.code;
    if (code === 'not-ended') return 'This pay period has not ended yet.';
    if (code === 'period-order') return 'An earlier open pay period must be closed first.';
    if (code === 'pending-blocks-close') return "Every hour must be approved first (this org doesn't allow closing with hours waiting).";
    return null;
  }).filter(Boolean);

  const viewProps = { rows, period, summary, prevLabel, pending: rolledForward.pendingCount, readiness, isClosed, canEdit, onOpenPerson: (r) => setOpenRowKey(r.key), onExport: () => download(!isClosed) };
  const ActiveView = DIR_CMP[view];

  return (
    <div className="pay-page">
      <div className="pay-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Payroll</h1>
          {/* PAY-2 (Matt, 2026-09-29): "semi monthly 1 to 15 on the 20th and 16 to 31 on the 5th
              of the new month." A pay period and its PAYDAY are different dates, and the payday is
              what the office and the payroll specialist work to — so it is on the run, on its close
              dialog, and in the exported file's name. */}
          <p className="pay-sub">
            {period.label} · {cadenceLabel(period.cadence)}
            {payDateKey && <> · pays {fmtDate(`${payDateKey}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' })}</>}
          </p>
        </div>
        <div className="pay-head-controls">
          <span className={`pay-chip ${loading ? '' : (chip.closed ? 'closed' : 'open')}`}>
            <span className="pay-chip-dot" />
            {loading ? 'Loading…'
              : error ? 'Not loaded'
                : chip.closed
                  ? `Closed ${chip.at ? fmtDate(chip.at, { month: 'short', day: 'numeric', year: 'numeric' }) : ''}${chip.by ? ` by ${chip.by}` : ''}`
                  : 'Open'}
          </span>
          <div className="pay-stepper">
            <button type="button" className="btn-icon btn-icon-ghost" onClick={() => setOffset(offset - 1)} aria-label="Previous pay period"><Icon name="chevronLeft" size={16} /></button>
            <span className="pay-stepper-cur">{period.label}</span>
            <button type="button" className="btn-icon btn-icon-ghost" onClick={() => setOffset(offset + 1)} aria-label="Next pay period" disabled={offset >= 0}><Icon name="chevronRight" size={16} /></button>
          </div>
          {canEdit && !isClosed && (
            <>
              <button className="btn btn-outline" onClick={() => download(true)} type="button" disabled={loading || !!error}><Icon name="upload" size={15} /> Download draft</button>
              <button className="btn btn-primary" onClick={() => setConfirmOpen(true)} type="button" disabled={loading || !!error || !closable} title={!closable && blockedReason.length ? blockedReason.join(' ') : undefined}>
                <Icon name="check" size={15} /> Close period &amp; export
              </button>
            </>
          )}
          {canEdit && isClosed && (
            <button className="btn btn-primary" onClick={() => download(false)} type="button" disabled={loading || !!error}><Icon name="upload" size={15} /> Download CSV</button>
          )}
        </div>
      </div>

      {/* polishpoint-demo: no layout review banner */}

      {loading ? (
        <div className="pay-loading">Loading pay run…</div>
      ) : error ? (
        <div className="pay-error">{error} <button type="button" className="linklike" onClick={reload}>Retry</button></div>
      ) : (
        <>
          {!isClosed && <ReadinessCard rolledForward={rolledForward} readiness={readiness} />}
          {!isClosed && !closable && blockedReason.length > 0 && (
            <div className="callout callout-warning pay-blocked-note"><strong>Can't close yet:</strong> {blockedReason.join(' ')}</div>
          )}
          {removed.length > 0 && <RemovedNote removed={removed} />}
          <ActiveView {...viewProps} />
        </>
      )}

      {/* Always mounted: it draws nothing while closed, and slides out with the last row. */}
      <PayrollLineDrawer row={openRow || null} period={period} canEdit={canEdit} periodClosed={isClosed} currentUserId={currentUser && currentUser.id} onClose={() => setOpenRowKey(null)} />

      <ClosePeriodDialog
        open={confirmOpen}
        period={period}
        payDateKey={payDateKey}
        summary={summary}
        rolledForward={rolledForward}
        busy={closing}
        onConfirm={doClose}
        onClose={() => { if (!closing) setConfirmOpen(false); }}
      />
    </div>
  );
}
