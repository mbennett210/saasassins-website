import EmptyState from '../../components/EmptyState';
import { DECISION_SECTION_BY_ID } from '../../data/buildDecisions';
import DecisionCard from './DecisionCard';
import DraftCard from './DraftCard';
import { findReviewItem, areaTitle } from './reviewShared';

// Focus mode: one item at a time. The header carries the page's ONE back affordance (the
// .detail-back pill, "All areas", UI_RULES §108), the area title, "i of n" and a gold
// progress bar; a single-section area also shows its blurb and an "Already settled" details
// list. Below is the decision or draft card, then Back / Skip / Next (Finish on the last).
// Answering never advances — Next / Skip / Back are the only movement.
export default function ReviewFocus({ area, ids, idx, onBack, onNext, onSkip, onExit }) {
  const total = ids.length;
  const currentId = ids[idx];
  const item = currentId ? findReviewItem(currentId) : null;
  const isCrossArea = area === 'new' || area === 'open' || area === 'drafts';
  const section = isCrossArea ? null : DECISION_SECTION_BY_ID[area];
  const pct = total > 0 ? Math.round((idx / total) * 100) : 0;
  const isLast = idx + 1 >= total;

  return (
    <div className="page">
      <div className="review-focus">
        <div className="review-focus-head">
          <button type="button" className="detail-back" onClick={onExit}>← All areas</button>
          <span className="review-focus-title">{areaTitle(area)}</span>
          <span className="review-focus-count">{total > 0 ? idx + 1 : 0} of {total}</span>
        </div>
        <div className="review-focus-prog" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div>

        {section && (
          <div className="review-focus-intro">
            {section.blurb && <p className="review-focus-blurb">{section.blurb}</p>}
            {section.settled?.length > 0 && (
              <details className="review-settled">
                <summary>Already settled ({section.settled.length})</summary>
                <ul>{section.settled.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </details>
            )}
          </div>
        )}

        {item?.type === 'decision' && <DecisionCard question={item.decision} />}
        {item?.type === 'draft' && <DraftCard draft={item.draft} />}
        {!item && (
          <EmptyState title="Nothing here" message="Everything in this area has been handled." />
        )}

        <div className="review-nav">
          <button type="button" className="btn btn-secondary" onClick={onBack} disabled={idx === 0}>Back</button>
          <span className="review-nav-spacer" />
          <button type="button" className="btn btn-link" onClick={onSkip}>Skip</button>
          <button type="button" className="btn btn-primary" onClick={onNext}>{isLast ? 'Finish' : 'Next'}</button>
        </div>
      </div>
    </div>
  );
}
