// The close-period confirm (wave W3-P §8.5). A closed pay period is INSERT-only and pays the
// approved hours; the confirm states the period, the people and the gross, and exactly what
// rolls forward to the next payroll (pending punches / hours, overtime awaiting approval,
// still-clocked-in). It is a Modal (not the shared ConfirmDialog) because closing is async and
// multi-outcome: a stale preview reloads and re-asks, and a success downloads the final CSV —
// ConfirmDialog renders only a string and auto-closes on confirm, so it can't hold that flow.
import Modal from '../../components/Modal';
import { money, fmtDate } from '../../lib/dates';
import { fmtHours } from './shared';

export default function ClosePeriodDialog({ open, period, payDateKey = null, summary, rolledForward, busy, onConfirm, onClose }) {
  if (!open) return null;
  const { pendingCount = 0, pendingMinutes = 0, openCount = 0, otHeldMinutes = 0 } = rolledForward || {};
  const rolls = [];
  if (pendingCount > 0) rolls.push(`${pendingCount} ${pendingCount === 1 ? 'punch' : 'punches'} pending (${fmtHours(pendingMinutes)})`);
  if (otHeldMinutes > 0) rolls.push(`${fmtHours(otHeldMinutes)} overtime awaiting approval`);
  if (openCount > 0) rolls.push(`${openCount} still clocked in`);

  return (
    <Modal open={open} onClose={onClose} title="Close this pay period?" size="sm">
      <div className="pay-close-confirm">
        <p className="confirm-message">
          Close <strong>{period.label}</strong> for <strong>{summary.onPayroll}</strong> {summary.onPayroll === 1 ? 'person' : 'people'} at a gross of <strong>{money(summary.gross)}</strong>.
          {/* PAY-2: the PAYDAY, because that is the date the office is committing to and the one
              the exported file is named by — a period label alone never says when it pays. */}
          {payDateKey && <> Paid on <strong>{fmtDate(`${payDateKey}T12:00:00`, { weekday: 'long', month: 'long', day: 'numeric' })}</strong>.</>}
        </p>
        {rolls.length > 0 ? (
          <div className="callout callout-info pay-close-rolls">
            <strong>Rolls forward to the next payroll:</strong>
            <ul>{rolls.map((t) => <li key={t}>{t}</li>)}</ul>
            <span className="pay-muted">Only approved hours are paid now; anything still waiting is paid on the next payroll once approved.</span>
          </div>
        ) : (
          <p className="pay-muted">Every hour in this period is approved — nothing rolls forward.</p>
        )}
        <p className="pay-muted">Closing pulls the final CSV and locks this period. It can't be reopened.</p>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={onConfirm} disabled={busy}>{busy ? 'Closing…' : 'Close & export'}</button>
      </div>
    </Modal>
  );
}
