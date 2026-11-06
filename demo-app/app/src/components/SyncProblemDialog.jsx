import Modal from './Modal';
import { useSyncProblem, useSelector, shallowEqual } from '../store';
import { describeRefusedAction } from '../store/syncProblems';
import { useT } from '../i18n/react';

// The slices a label names a record from — by reference, so the shell doesn't re-render this
// on every unrelated dispatch.
const selectNamedSlices = (s) => ({
  users: s.users, clients: s.clients, payrollLines: s.payrollLines, reimbursements: s.reimbursements, timeOff: s.timeOff,
});

// The BLOCKING message for a save problem the person must read. Before CS-008 a change the
// server refused vanished — together with everything saved beside it — under a status that said
// "synced"; now the rest of the batch is saved and this names each refused change, with the
// server's reason, until the person closes it. It also says when the shared record is over its
// size limit (413, CS-009), which no retry can fix. Mounted ONCE in the app shell (AppLayout).
//
// The labels are catalog lines in the reader's language; the reason is the SERVER's own words
// (an API error body stays English, UI_RULES §140), shown verbatim under its label rather than
// spliced into a translated sentence.
export default function SyncProblemDialog() {
  const t = useT();
  const { problem, dismiss } = useSyncProblem();
  // Names are read from the CURRENT state: a refused customer delete is back by now.
  const state = useSelector(selectNamedSlices, shallowEqual);
  if (!problem) return null;
  if (problem.kind === 'tooLarge') {
    // CS-009: the shared record is over its size budget (413), so NOTHING new can be saved by
    // anyone. Retrying cannot fix it, so the person is told once (the save keeps backing off
    // behind this, the edits kept on the device), with the server's own words for the cause.
    return (
      <Modal open onClose={dismiss} title={t('syncProblem.tooLargeTitle')} size="sm">
        <p className="confirm-message">{t('syncProblem.tooLargeLead')}</p>
        {/* i18n-ok — the server's own words (an API error body stays English, UI_RULES §140) */}
        {problem.error && <p className="sync-problem-reason">{problem.error}</p>}
        <p className="confirm-message">{t('syncProblem.tooLargeNext')}</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={dismiss}>{t('syncProblem.ok')}</button>
        </div>
      </Modal>
    );
  }
  if (problem.kind !== 'refused' || !(problem.refused || []).length) return null;
  return (
    <Modal open onClose={dismiss} title={t('syncProblem.refusedTitle')} size="sm">
      <p className="confirm-message">{t('syncProblem.refusedLead')}</p>
      <ul className="sync-problem-list">
        {problem.refused.map((r, i) => {
          const { key, params } = describeRefusedAction(r.action, state);
          const reason = (r.violations || []).join('; ');
          return (
            // A refusal has no id of its own; the list is fixed while the message is open.
            <li key={i}>
              <strong>{t(key, params)}</strong>
              {/* i18n-ok — the server's own words (an API error body stays English, UI_RULES §140) */}
              {reason && <span className="sync-problem-reason">{reason}</span>}
            </li>
          );
        })}
      </ul>
      <p className="confirm-message">{t('syncProblem.refusedNext')}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={dismiss}>{t('syncProblem.ok')}</button>
      </div>
    </Modal>
  );
}
