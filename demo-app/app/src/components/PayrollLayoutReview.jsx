import { useState } from 'react';
import Icon from './Icon';
import { usePickReview } from '../store/ClientReviewProvider';
import PayrollLayoutPicker, { PAYROLL_PICK_ID, PAYROLL_DIR_NAME } from './PayrollLayoutPicker';

// The "choose your payroll layout" affordance at the top of the Payroll page —
// same mechanism as the dashboard layout review banner. Pending → a full banner;
// once chosen → a quiet "layout: X · Change" line. Everyone who can see Payroll
// (owner/manager) can pick, since the choice drives which live view renders.
export default function PayrollLayoutReview({ viewProps }) {
  const pick = usePickReview(PAYROLL_PICK_ID);
  const [open, setOpen] = useState(false);

  const chosen = pick.status === 'chosen';
  const changes = pick.status === 'changes';

  return (
    <>
      {chosen ? (
        <div className="dash-layout-note">
          <span className="dash-layout-note-l">
            <Icon name="check" size={13} /> Payroll layout: <strong>{PAYROLL_DIR_NAME[pick.choice]}</strong>
          </span>
          <button type="button" className="btn btn-outline" onClick={() => setOpen(true)}>Change</button>
        </div>
      ) : (
        <div className={`dash-layout-banner${changes ? ' changes' : ''}`}>
          <span className="dash-layout-pill">{changes ? 'Changes requested' : 'In review'}</span>
          <div className="dash-layout-copy">
            <strong>Choose how you run payroll.</strong>{' '}
            <span>{changes ? 'You asked for changes — review or update your pick.' : 'We built 4 layout directions for you to pick from.'}</span>
          </div>
          <button type="button" className="btn btn-primary dash-layout-cta" onClick={() => setOpen(true)}>
            Review layout options
          </button>
        </div>
      )}
      <PayrollLayoutPicker open={open} onClose={() => setOpen(false)} viewProps={viewProps} />
    </>
  );
}
