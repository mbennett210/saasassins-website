import { useClientReview } from '../../store/ClientReviewProvider';
import { isDecisionAnswered, isDraftResolved } from '../../lib/clientReview';
import { DECISION_SECTIONS } from '../../data/buildDecisions';
import { EMAIL_DRAFTS } from '../../data/emailDrafts';
import Icon from '../../components/Icon';
import ProgressRing from './ProgressRing';
import { fmtAddedShort } from './reviewShared';

// The hub: a hero that sums up what needs attention and what's new, then one tile per
// decision section (in catalog order) plus a Drafts tile. A tile opens focus mode on that
// area. Counts come from the shared review state, so every seat sees the same numbers.
export default function ReviewHub({ onOpenArea }) {
  const cr = useClientReview();

  const sections = DECISION_SECTIONS.map((s) => {
    const total = s.questions.length;
    const answered = s.questions.filter((q) => isDecisionAnswered(cr.review.decisions[q.id])).length;
    const nw = s.questions.filter((q) => cr.isNewDecision(q.id)).length;
    return { id: s.id, title: s.title, total, answered, unanswered: total - answered, nw };
  });

  const draftTotal = EMAIL_DRAFTS.length;
  const draftResolved = EMAIL_DRAFTS.filter((d) => isDraftResolved(cr.review.drafts[d.id])).length;
  const draftPending = draftTotal - draftResolved;
  const draftNew = EMAIL_DRAFTS.filter((d) => cr.isNewDraft(d.id)).length;

  const attention = cr.reviewAttention;
  const newCount = cr.reviewNewCount;
  const updated = cr.latestUpdate ? fmtAddedShort(cr.latestUpdate) : null;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Review</h1>
        <p className="page-sub">Build decisions and drafts to sign off. New items show up here as we add them.</p>
      </div>

      <div className="review-hero">
        {attention > 0 ? (
          <>
            <div className="review-hero-figure">
              <div className="review-hero-num">{attention}</div>
              <div className="review-hero-fig-label">need your attention</div>
            </div>
            <div className="review-hero-mid">
              <div className="review-hero-lead">
                {newCount > 0 ? `${newCount} new from the latest update (${updated})` : 'Nothing new waiting'}
              </div>
              <div className="review-hero-sub">
                {cr.openDecisions} questions unanswered · {draftPending} drafts pending
              </div>
            </div>
            <div className="review-hero-actions">
              {newCount > 0 && (
                <button type="button" className="btn btn-gold" onClick={() => onOpenArea('new')}>Start with what’s new</button>
              )}
              <button type="button" className="btn btn-secondary" onClick={() => onOpenArea('open')}>Answer everything open</button>
            </div>
          </>
        ) : (
          <div className="review-hero-caught">
            <span className="review-hero-caught-ic" aria-hidden="true"><Icon name="check" size={22} /></span>
            <div className="review-hero-mid">
              <div className="review-hero-lead">You’re all caught up</div>
              <div className="review-hero-sub">Nothing needs your attention right now.</div>
            </div>
          </div>
        )}
      </div>

      <div className="review-tiles">
        {sections.map((s) => (
          <button key={s.id} type="button" className="review-tile" onClick={() => onOpenArea(s.id)}>
            <ProgressRing done={s.answered} total={s.total} />
            <span className="review-tile-body">
              <span className="review-tile-nm">{s.title}</span>
              <span className="review-tile-st">
                {s.unanswered > 0 ? `${s.unanswered} unanswered` : 'All answered'}
                {s.nw > 0 && <span className="review-badge-new review-tile-new">{s.nw} new</span>}
              </span>
            </span>
          </button>
        ))}
        <button type="button" className="review-tile" onClick={() => onOpenArea('drafts')}>
          <ProgressRing done={draftResolved} total={draftTotal} />
          <span className="review-tile-body">
            <span className="review-tile-nm">Drafts to sign off</span>
            <span className="review-tile-st">
              {draftPending > 0 ? `${draftPending} pending` : 'All signed off'}
              {draftNew > 0 && <span className="review-badge-new review-tile-new">{draftNew} new</span>}
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}
