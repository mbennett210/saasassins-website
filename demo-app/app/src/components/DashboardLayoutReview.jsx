import { useState } from 'react';
import Icon from './Icon';
import { usePermission } from '../hooks/usePermission';
import { usePickReview } from '../store/ClientReviewProvider';
import DashboardLayoutPicker, { LAYOUT_PICK_ID, LAYOUT_NAME } from './DashboardLayoutPicker';

// The "choose your Account-Manager Dashboard layout" review affordance that rides
// at the top of the Dashboard. While the pick is pending it's a full banner; once
// chosen it collapses to a quiet "layout: X · change" line. Gated to the review
// audience (drafts.view = owner/admin), so crew never see it.
export default function DashboardLayoutReview() {
  const canReview = usePermission('drafts.view');
  const pick = usePickReview(LAYOUT_PICK_ID);
  const [open, setOpen] = useState(false);
  if (!canReview) return null;

  const chosen = pick.status === 'chosen';
  const changes = pick.status === 'changes';

  return (
    <>
      {chosen ? (
        <div className="dash-layout-note">
          <span className="dash-layout-note-l">
            <Icon name="check" size={13} /> Account dashboard layout: <strong>{LAYOUT_NAME[pick.choice]}</strong>
          </span>
          <button type="button" className="btn btn-outline" onClick={() => setOpen(true)}>Change</button>
        </div>
      ) : (
        <div className={`dash-layout-banner${changes ? ' changes' : ''}`}>
          <span className="dash-layout-pill">{changes ? 'Changes requested' : 'In review'}</span>
          <div className="dash-layout-copy">
            <strong>Choose how your account dashboard looks.</strong>{' '}
            <span>{changes ? 'You asked for changes — review or update your pick.' : 'We built 4 layout directions for you to pick from.'}</span>
          </div>
          <button type="button" className="btn btn-primary dash-layout-cta" onClick={() => setOpen(true)}>
            Review layout options
          </button>
        </div>
      )}
      <DashboardLayoutPicker open={open} onClose={() => setOpen(false)} />
    </>
  );
}
