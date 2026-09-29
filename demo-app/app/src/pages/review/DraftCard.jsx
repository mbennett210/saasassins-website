import { useMemo, useState } from 'react';
import { useDraftReview } from '../../store/ClientReviewProvider';
import { DRAFT_ACCEPTED, DRAFT_CHANGES, newSitting, hasAnyNote } from '../../lib/clientReview';
import { useToast } from '../../components/Toast';
import ConfirmDialog from '../../components/ConfirmDialog';
import ReviewNotes from './ReviewNotes';
import Badge from '../../components/Badge';
import Icon from '../../components/Icon';
import DraftPreview from './DraftPreview';
import { DRAFT_KIND_LABEL, DRAFT_STATE_LABEL } from './reviewShared';
import { fmtDate } from '../../lib/dates';

// One draft in the focus flow: category + build tag + status, the name and where it goes,
// the REAL preview, then a verdict (Accept / Request changes) and add-only notes (§98).
//
// ADDITIVE (CS-402): a verdict is a SIGN-OFF — Accept and Request changes no longer toggle
// back to pending. Given in an EARLIER sitting it LOCKS: the card shows "Accepted <date>" /
// "Changes requested <date>" with a "Change" behind a ConfirmDialog; confirming unlocks THIS
// sitting and the reducer keeps the prior verdict in history. Notes are add-only.
function verdictLabel(status) {
  if (status === DRAFT_ACCEPTED) return 'Accepted';
  if (status === DRAFT_CHANGES) return 'Changes requested';
  return 'Pending';
}
function statusBadge(rev) {
  if (rev.status === DRAFT_ACCEPTED) return <Badge variant="green">Accepted</Badge>;
  if (rev.status === DRAFT_CHANGES) return <Badge variant="amber">Changes requested</Badge>;
  if (hasAnyNote(rev.entry)) return <Badge variant="green">Note added</Badge>;
  return <Badge variant="slate">Pending</Badge>;
}

export default function DraftCard({ draft }) {
  const sitting = useMemo(() => newSitting(), []);
  const rev = useDraftReview(draft.id, sitting);
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const editable = !rev.locked || confirmed;

  const onAccept = () => { rev.accept({ confirm: confirmed }); toast.success('Accepted'); };
  const onRequestChanges = () => { rev.requestChanges({ confirm: confirmed }); toast.info('Changes requested. Add a note below.'); };

  return (
    <div className="review-card">
      <div className="review-meta">
        <span className="review-meta-id">{draft.category}</span>
        {rev.isNew && <span className="review-badge-new">New</span>}
        <span className={`drafts-state ${draft.buildState}`}>{DRAFT_STATE_LABEL[draft.buildState] || 'Draft'}</span>
        {statusBadge(rev)}
      </div>
      <div className="review-q">{draft.name}</div>
      <div className="review-why">{DRAFT_KIND_LABEL[draft.kind] || 'Email'} to {draft.recipient} · {draft.trigger}</div>

      <DraftPreview draft={draft} />

      {!editable ? (
        <div className="drafts-verdict-locked">
          <span className="drafts-verdict-msg">{verdictLabel(rev.status)} {fmtDate(rev.at)}</span>
          <button type="button" className="btn btn-link drafts-verdict-change" onClick={() => setConfirmOpen(true)}>Change</button>
        </div>
      ) : (
        <div className="drafts-verdict-btns">
          <button
            type="button"
            className={`btn btn-secondary drafts-accept ${rev.status === DRAFT_ACCEPTED ? 'on' : ''}`}
            onClick={onAccept}
          >
            <Icon name="check" size={15} /> {rev.status === DRAFT_ACCEPTED ? 'Approved' : 'Accept'}
          </button>
          <button
            type="button"
            className={`btn btn-secondary drafts-changes ${rev.status === DRAFT_CHANGES ? 'on' : ''}`}
            onClick={onRequestChanges}
          >
            <Icon name="edit" size={15} /> Request changes
          </button>
        </div>
      )}

      {rev.history.length > 0 && (
        <details className="review-history">
          <summary>Earlier verdicts ({rev.history.length})</summary>
          <ul>
            {rev.history.map((h, i) => (
              <li key={i}><span className="review-history-val">{verdictLabel(h.status)}</span> <span className="review-history-at">{fmtDate(h.at)}</span></li>
            ))}
          </ul>
        </details>
      )}

      <ReviewNotes entry={rev.entry} onAdd={rev.addNote} placeholder="Notes or changes to make (saved for everyone)" />

      <ConfirmDialog
        open={confirmOpen}
        title="Change this status?"
        message={`This draft was ${verdictLabel(rev.status).toLowerCase()} on ${fmtDate(rev.at)}. The earlier status stays listed under the draft.`}
        confirmLabel="Change status"
        onConfirm={() => setConfirmed(true)}
        onClose={() => setConfirmOpen(false)}
      />
    </div>
  );
}
