import { useClientReview } from '../../store/ClientReviewProvider';
import { draftAnsweredAt, waitingNotes } from '../../lib/clientReview';
import { EMAIL_DRAFTS } from '../../data/emailDrafts';
import EmptyState from '../../components/EmptyState';
import { fmtDate } from '../../lib/dates';
import { DRAFT_KIND_LABEL } from './reviewShared';

// Waiting on us (CS-864, Daniel's pick A, 2026-10-23): the drafts the client sent back with a
// note that we have not changed yet. A short list, not a walk: each draft, the day it came back,
// the note it came back with and Open the draft (Drafts to sign off, at that draft). Nothing here
// asks the client for anything; changing the words (EMAIL_DRAFT_CHANGED) moves a draft back to
// Drafts to sign off, marked New. Reached from the hub's Waiting on us tile (?area=waiting).
export default function ReviewWaiting({ onExit, onOpenDraft }) {
  const cr = useClientReview();
  const rows = EMAIL_DRAFTS.filter((d) => cr.isDraftWaiting(d.id)).map((d) => {
    const entry = cr.review.drafts[d.id];
    return { draft: d, at: draftAnsweredAt(entry), notes: waitingNotes(entry, cr.draftChangedOn(d.id)) };
  });

  return (
    <div className="page">
      <div className="review-focus review-wait">
        <div className="review-focus-head">
          <button type="button" className="detail-back" onClick={onExit}>← All areas</button>
          <span className="review-focus-title">Waiting on us</span>
          <span className="review-focus-count">{rows.length}</span>
        </div>
        {rows.length > 0 ? (
          <>
            <p className="review-focus-blurb review-wait-blurb">
              Drafts you sent back with a note. We’re changing the words; each one goes back to Drafts to sign off marked New. Nothing here needs you.
            </p>
            <div className="review-wait-rows">
              {rows.map(({ draft, at, notes }) => (
                <div key={draft.id} className="review-wait-row">
                  <div className="review-wait-row-top">
                    <span className="review-wait-row-nm">{draft.name}</span>
                    {at && <span className="review-wait-row-at">Sent back {fmtDate(at)}</span>}
                  </div>
                  <div className="review-wait-row-kind">{DRAFT_KIND_LABEL[draft.kind] || 'Email'} to {draft.recipient} · {draft.category}</div>
                  {notes.map((n, i) => <blockquote key={i} className="review-wait-note">{n.text}</blockquote>)}
                  <button type="button" className="btn btn-link review-wait-open" onClick={() => onOpenDraft(draft.id)}>Open the draft →</button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <EmptyState title="Nothing is waiting on us" message="Every draft you sent back has been changed. The changed ones are in Drafts to sign off, marked New." />
        )}
      </div>
    </div>
  );
}
