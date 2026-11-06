import { useMemo, useState } from 'react';
import { useDraftReview } from '../../store/ClientReviewProvider';
import { DRAFT_ACCEPTED, DRAFT_CHANGES, newSitting, hasAnyNote } from '../../lib/clientReview';
import { useToast } from '../../components/Toast';
import ConfirmDialog from '../../components/ConfirmDialog';
import ReviewNotes from './ReviewNotes';
import Badge from '../../components/Badge';
import Icon from '../../components/Icon';
import DraftPreview from './DraftPreview';
import { DRAFT_KIND_LABEL, DRAFT_STATE_LABEL, fmtAddedShort } from './reviewShared';
import { fmtDate } from '../../lib/dates';

// One draft in the focus flow: category + build tag + status, the name and where it goes,
// the REAL preview, then a verdict (Accept / Request changes) and add-only notes (§98).
//
// ADDITIVE (CS-402): a verdict is a SIGN-OFF — Accept and Request changes no longer toggle
// back to pending. Given in an EARLIER sitting it LOCKS: the card shows "Accepted <date>" /
// "Changes requested <date>" with a "Change" behind a ConfirmDialog; confirming unlocks THIS
// sitting and the reducer keeps the prior verdict in history. Notes are add-only.
// A draft UPDATED after its verdict (EMAIL_DRAFT_CHANGED) never locks: it takes a fresh verdict
// straight away, the old one moving to history (task #126).
// A draft SENT BACK with a note that we have not changed yet is Waiting on us (CS-864): an amber
// badge, and a line under its verdict saying we're changing the words.
function verdictLabel(status) {
  if (status === DRAFT_ACCEPTED) return 'Accepted';
  if (status === DRAFT_CHANGES) return 'Changes requested';
  return 'Pending';
}
function statusBadge(rev) {
  if (rev.waiting) return <Badge variant="amber">Waiting on us</Badge>;
  if (rev.status === DRAFT_ACCEPTED) return <Badge variant="green">Accepted</Badge>;
  if (rev.status === DRAFT_CHANGES) return <Badge variant="amber">Changes requested</Badge>;
  if (hasAnyNote(rev.entry)) return <Badge variant="green">Note added</Badge>;
  return <Badge variant="slate">Pending</Badge>;
}

export default function DraftCard({ draft }) {
  // One sitting per card mount, and ReviewFocus mounts one card per draft (keyed by its id).
  const sitting = useMemo(() => newSitting(), []);
  const rev = useDraftReview(draft.id, sitting);
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // UPDATED since the verdict (task #126): the old verdict was on the old words, so the card
  // offers Accept / Request changes again with no "Change" and no confirm box (the hook sends it
  // confirmed), names the old verdict above the buttons and lights neither until a fresh one.
  const updated = !!rev.changedSince;
  const editable = updated || !rev.locked || confirmed;
  const lit = (status) => !updated && rev.status === status;
  // The update this visit opened on, HELD for the rest of the visit: a fresh verdict clears
  // changedSince, and dropping the callout and the old-verdict line then would pull the buttons
  // up under the pointer; the old verdict it moves into history is already named by that line,
  // so "Earlier verdicts" keeps its length too until the next visit (nothing below is shoved).
  // A visit is this card's life: ReviewFocus keys the card by the draft, so coming back is a new one.
  const [held, setHeld] = useState(null);
  if (updated && held?.since !== rev.changedSince) {
    setHeld({ since: rev.changedSince, signedOff: rev.signedOff, status: rev.status, at: rev.at, hist: rev.history.length });
  }
  const shown = updated ? { since: rev.changedSince, signedOff: rev.signedOff, status: rev.status, at: rev.at } : held;
  const history = !updated && shown ? rev.history.slice(0, shown.hist) : rev.history;
  // Waiting on us when this visit opened on it, HELD for the visit like the update line above: a
  // note added or a verdict given now would otherwise put the line in, or take it out, above the
  // notes box under the pointer. The badge in the meta row follows the live state (one line, no
  // reflow), and the next visit shows the line as it is then.
  const [waitShown] = useState(rev.waiting);

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
      {shown && (
        <div className="callout callout-info drafts-changed">
          Updated {fmtAddedShort(shown.since)}, after your answer. Your answer and notes are kept below; take another look and Accept or Request changes.
        </div>
      )}

      <DraftPreview draft={draft} />

      {!editable ? (
        <div className="drafts-verdict-locked">
          <span className="drafts-verdict-msg">{verdictLabel(rev.status)} {fmtDate(rev.at)}</span>
          <button type="button" className="btn btn-link drafts-verdict-change" onClick={() => setConfirmOpen(true)}>Change</button>
        </div>
      ) : (
        <>
          {shown?.signedOff && (
            <div className="drafts-verdict-locked">
              <span className="drafts-verdict-msg">Before this update: {verdictLabel(shown.status)} {fmtDate(shown.at)}</span>
            </div>
          )}
          <div className="drafts-verdict-btns">
            <button
              type="button"
              className={`btn btn-secondary drafts-accept ${lit(DRAFT_ACCEPTED) ? 'on' : ''}`}
              onClick={onAccept}
            >
              <Icon name="check" size={15} /> {lit(DRAFT_ACCEPTED) ? 'Approved' : 'Accept'}
            </button>
            <button
              type="button"
              className={`btn btn-secondary drafts-changes ${lit(DRAFT_CHANGES) ? 'on' : ''}`}
              onClick={onRequestChanges}
            >
              <Icon name="edit" size={15} /> Request changes
            </button>
          </div>
        </>
      )}

      {waitShown && (
        <div className="review-wait-callout">
          <b>Waiting on us.</b> We’re changing the words to match your note. It comes back here marked New for a fresh look.
        </div>
      )}

      {history.length > 0 && (
        <details className="review-history">
          <summary>Earlier verdicts ({history.length})</summary>
          <ul>
            {history.map((h, i) => (
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
