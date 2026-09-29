import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useClientReview } from '../store/ClientReviewProvider';
import { useIsMobile } from '../hooks/useIsMobile';
import { useToast } from '../components/Toast';
import EmptyState from '../components/EmptyState';
import { DECISIONS, DECISION_SECTION_BY_ID } from '../data/buildDecisions';
import { EMAIL_DRAFTS } from '../data/emailDrafts';
import { isDecisionAnswered, isDraftResolved } from '../lib/clientReview';
import ReviewHub from './review/ReviewHub';
import ReviewFocus from './review/ReviewFocus';
import { areaTitle } from './review/reviewShared';

// Review — the hub-plus-focus review section (Direction D). It holds the 39 email/SMS/document
// drafts to sign off AND Matt's 123 build-decision questions, all on the shared clientReview
// slice. DESKTOP ONLY, like Pipeline and Quotes: on a phone it renders a short notice, no
// phone layout (the sidebar/floating nav also hide it below 640px). The full UI runs at the
// iPad width and up.
//
// URL model: ?area=<sectionId|drafts|new|open>&item=<id>. No area → the hub. Entering an area
// PUSHES (so the browser Back returns to the hub); Next/Back/Skip REPLACE (so the walk isn't a
// wall of history entries). The new/open lists are dynamic, so they're snapshotted on entry
// and stay stable while walking; on a refresh they recompute, and a vanished item starts at 0.

const DRAFT_IDS = EMAIL_DRAFTS.map((d) => d.id);

export default function Review() {
  const isMobile = useIsMobile();
  if (isMobile) {
    return (
      <div className="page">
        <div className="page-head"><h1>Review</h1></div>
        <EmptyState
          title="Review is built for a computer or iPad"
          message="Open this page on a computer or iPad to answer build questions and sign off drafts."
        />
      </div>
    );
  }
  return <ReviewDesktop />;
}

// The deterministic id list for a section or the drafts area (order = catalog order).
function staticAreaIds(area) {
  if (area === 'drafts') return DRAFT_IDS;
  const sec = DECISION_SECTION_BY_ID[area];
  return sec ? sec.questions.map((q) => q.id) : [];
}

function ReviewDesktop() {
  const [params, setParams] = useSearchParams();
  const cr = useClientReview();
  const toast = useToast();
  const area = params.get('area');
  const itemParam = params.get('item');
  const isDynamic = area === 'new' || area === 'open';

  // The open/new lists depend on what's been answered, so they must be a SNAPSHOT taken on
  // entry — otherwise answering an item mid-walk would reshuffle the list under the cursor.
  // Section/drafts lists are deterministic, so recomputing them is a no-op.
  const dynList = (a) => {
    if (a === 'new') {
      return [
        ...DECISIONS.filter((q) => cr.isNewDecision(q.id)).map((q) => q.id),
        ...EMAIL_DRAFTS.filter((d) => cr.isNewDraft(d.id)).map((d) => d.id),
      ];
    }
    return [
      ...DECISIONS.filter((q) => !isDecisionAnswered(cr.review.decisions[q.id])).map((q) => q.id),
      ...EMAIL_DRAFTS.filter((d) => !isDraftResolved(cr.review.drafts[d.id])).map((d) => d.id),
    ];
  };

  // Compute the walking list. When the area matches the held snapshot we reuse it (a stable
  // walk); otherwise (entry, deep-link, refresh) we compute fresh THIS render — always correct,
  // no flicker — and the effect below persists it so answering an item mid-walk can't reshuffle
  // the dynamic new/open lists under the cursor. On the hub the snapshot resets, so re-entering
  // the same area takes a fresh snapshot.
  const [snap, setSnap] = useState({ area: null, ids: [] });
  const ids = !area
    ? []
    : (snap.area === area ? snap.ids : (isDynamic ? dynList(area) : staticAreaIds(area)));
  useEffect(() => {
    if (!area) { if (snap.area !== null) setSnap({ area: null, ids: [] }); return; }
    if (snap.area !== area) setSnap({ area, ids });
    // Snapshot on the AREA change only — the walk's item-only changes keep the frozen list.
  }, [area]); // eslint-disable-line react-hooks/exhaustive-deps
  const idx = area ? Math.max(0, ids.indexOf(itemParam)) : 0;

  const goHub = () => setParams({}, { replace: true });
  const walk = (nextIdx) => setParams({ area, item: ids[nextIdx] || '' }, { replace: true });
  const onNext = () => {
    if (idx + 1 >= ids.length) { goHub(); toast.success(`Done with ${areaTitle(area)}.`); }
    else walk(idx + 1);
  };
  const onBack = () => { if (idx > 0) walk(idx - 1); };

  // Open an area from the hub: start at its first OPEN item (a section / drafts), else 0;
  // the new/open lists are already only open items, so they start at 0.
  const openArea = (a) => {
    const list = (a === 'new' || a === 'open') ? dynList(a) : staticAreaIds(a);
    if (!list.length) { toast.info('Nothing here right now.'); return; }
    let start = 0;
    if (a !== 'new' && a !== 'open') {
      const firstOpen = list.findIndex((id) => (a === 'drafts'
        ? !isDraftResolved(cr.review.drafts[id])
        : !isDecisionAnswered(cr.review.decisions[id])));
      start = firstOpen >= 0 ? firstOpen : 0;
    }
    setParams({ area: a, item: list[start] }, { replace: false }); // push, so Back → hub
  };

  if (!area) return <ReviewHub onOpenArea={openArea} />;
  return (
    <ReviewFocus
      area={area}
      ids={ids}
      idx={idx}
      onBack={onBack}
      onNext={onNext}
      onSkip={onNext}
      onExit={goHub}
    />
  );
}
