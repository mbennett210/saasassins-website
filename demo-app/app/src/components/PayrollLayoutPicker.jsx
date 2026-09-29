import { useEffect, useState } from 'react';
import Modal from './Modal';
import Icon from './Icon';
import ConfirmDialog from './ConfirmDialog';
import ReviewNotes from '../pages/review/ReviewNotes';
import { usePickReview } from '../store/ClientReviewProvider';
import { newSitting } from '../lib/clientReview';
import RegisterView from '../pages/payroll/RegisterView';
import WizardView from '../pages/payroll/WizardView';
import RosterView from '../pages/payroll/RosterView';
import ReviewView from '../pages/payroll/ReviewView';

// The Payroll layout decision — same selector mechanism as the Account-Manager
// dashboard layout picker (client-review `picks` slice via usePickReview), but the
// four directions are LIVE, working views, so the preview renders the real thing
// over the real pay period and the choice actually drives the page.
export const PAYROLL_PICK_ID = 'payroll-layout';

export const PAYROLL_DIRECTIONS = [
  { key: 'Register', name: 'Register grid', desc: 'Every person on one dense worksheet', Cmp: RegisterView },
  { key: 'Wizard',   name: 'Guided wizard', desc: 'Period → hours → adjustments → export', Cmp: WizardView },
  { key: 'Roster',   name: 'Roster + drawer', desc: 'A calm list with a totals rail', Cmp: RosterView },
  { key: 'Review',   name: 'Review-first', desc: 'Totals, deltas and flags up front', Cmp: ReviewView },
];
export const PAYROLL_DIR_NAME = Object.fromEntries(PAYROLL_DIRECTIONS.map((d) => [d.key, d.name]));
export const PAYROLL_DEFAULT_DIR = 'Register';

const HINTS = {
  Register: "The accountant's worksheet — every person a row, a sticky company total. Fastest to scan; toggle 'Show all pay types' to break out bonus/reimb/tip/deduction.",
  Wizard: 'A short guided run: confirm the period, review hours, add adjustments, review totals, then export. Lowest-error path.',
  Roster: 'A people-first list with a running totals rail on the right; open a person for the full breakdown and line editor.',
  Review: 'Leads with the company gross, the change vs the previous period, and a flag list of what moved. Most on-brand with Variance.',
};

export default function PayrollLayoutPicker({ open, onClose, viewProps }) {
  // One sitting per OPEN (CS-402): a pick from a past visit LOCKS; "Change" must confirm and
  // the reducer keeps the prior pick in history.
  const [sitting, setSitting] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { if (open) { setSitting(newSitting()); setConfirmed(false); } }, [open]);
  const pick = usePickReview(PAYROLL_PICK_ID, sitting);
  const [tab, setTab] = useState(pick.choice || PAYROLL_DEFAULT_DIR);
  const [expanded, setExpanded] = useState(false);
  const editable = !pick.locked || confirmed;

  const handleClose = () => { setExpanded(false); onClose(); };

  const dir = PAYROLL_DIRECTIONS.find((d) => d.key === tab) || PAYROLL_DIRECTIONS[0];
  const ActiveCmp = dir.Cmp;
  // Read-only preview: the real views + real data, but no drawer / edit / export.
  const previewProps = { ...viewProps, canEdit: false, onOpenPerson: () => {}, onExport: () => {} };

  return (
    <Modal open={open} onClose={handleClose} title="Choose your payroll layout" size={expanded ? 'full' : 'lg'}>
      <div className={`dlp${expanded ? ' dlp-expanded' : ''}`}>
        <div className="dlp-intro">
          <div className="dlp-intro-text">
            <span className="dlp-tag">In review</span>
            <p>Four ways to run payroll. Preview each over your live pay period, then choose the one you want. Leave a note if you&rsquo;d like changes.</p>
          </div>
          <button type="button" className="btn btn-outline dlp-expand" onClick={() => setExpanded((v) => !v)} aria-pressed={expanded}>
            <Icon name="expand" size={14} />{expanded ? 'Exit full screen' : 'Full screen'}
          </button>
        </div>

        <div className="dlp-tabs">
          {PAYROLL_DIRECTIONS.map((d, i) => (
            <button type="button" key={d.key} className={`dlp-vtab${tab === d.key ? ' is-active' : ''}`} onClick={() => setTab(d.key)}>
              <span className="dlp-vt-letter">{String.fromCharCode(65 + i)}</span>
              <span className="dlp-vt-name">{d.name}</span>
              <span className="dlp-vt-desc">{d.desc}</span>
            </button>
          ))}
        </div>

        <div className="dlp-ptools">
          <span className="dlp-plbl">Preview · your live pay period · {viewProps.period.label}</span>
        </div>

        <div className="dlp-preview pay-preview">
          <ActiveCmp {...previewProps} />
        </div>
        <div className="dlp-hint">{HINTS[tab]}</div>

        <div className="dlp-foot">
          <ReviewNotes entry={pick.entry} onAdd={(t) => pick.addNote(t)} placeholder={'Optional note for the team — e.g. “Love Review, but show OT hours on each flag.”'} />
          {!editable ? (
            <div className={`dlp-decision ${pick.status}`}>
              {pick.status === 'chosen' && <Icon name="check" size={14} />}
              <span>
                {pick.status === 'chosen'
                  ? <>You chose <strong>{PAYROLL_DIR_NAME[pick.choice]}</strong>. Saved and shared with the team.</>
                  : <>Changes requested on <strong>{PAYROLL_DIR_NAME[pick.choice]}</strong>. The team will see your note.</>}
              </span>
              <button type="button" className="linklike dlp-link" onClick={() => setConfirmOpen(true)}>Change</button>
            </div>
          ) : (
            <div className="dlp-foot-row">
              <span className="dlp-foot-left">
                {pick.status === 'chosen'
                  ? <>You chose <strong>{PAYROLL_DIR_NAME[pick.choice]}</strong>. Pick another or request changes.</>
                  : pick.status === 'changes'
                    ? <>Changes requested on <strong>{PAYROLL_DIR_NAME[pick.choice]}</strong>. Update your pick below.</>
                    : 'Your pick is saved to your review list and shared with the team.'}
              </span>
              <div className="dlp-foot-actions">
                {(pick.status === 'chosen' || pick.status === 'changes') && (
                  <button type="button" className="btn btn-outline" onClick={() => pick.reset({ confirm: confirmed })}>Undo</button>
                )}
                <button type="button" className="btn btn-secondary" onClick={() => pick.requestChanges(tab, { confirm: confirmed })}>Request changes</button>
                <button type="button" className="btn btn-primary" onClick={() => pick.choose(tab, { confirm: confirmed })}>Choose this layout</button>
              </div>
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Change your layout pick?"
        message={`You ${pick.status === 'chosen' ? 'chose' : 'requested changes on'} ${PAYROLL_DIR_NAME[pick.choice]}. The earlier pick stays listed in its history.`}
        confirmLabel="Change pick"
        onConfirm={() => setConfirmed(true)}
        onClose={() => setConfirmOpen(false)}
      />
    </Modal>
  );
}
