import { useEffect, useState } from 'react';
import Modal from './Modal';
import Icon from './Icon';
import ConfirmDialog from './ConfirmDialog';
import ReviewNotes from '../pages/review/ReviewNotes';
import { usePickReview } from '../store/ClientReviewProvider';
import { newSitting } from '../lib/clientReview';
import { RANGES } from '../data/dashboardLayoutPreview';
import {
  LAYOUT_VARIANTS, LAYOUT_NAME, RANGE_SHORT,
  VariantA, VariantB, VariantC, VariantD,
} from './dashboardLayouts';

// The one design-decision this picker records (see clientReview picks slice).
export const LAYOUT_PICK_ID = 'dashboard-layout';

// The variant renderers + metadata now live in ./dashboardLayouts (shared with the
// live per-role AccountDashboard). Re-exported here so existing importers of THIS
// file (DashboardLayoutReview) keep resolving LAYOUT_VARIANTS / LAYOUT_NAME unchanged.
export { LAYOUT_VARIANTS, LAYOUT_NAME };

const HINTS = {
  A: 'Sorted by GPM, lowest first. In the app: click a row to open the account, a header to re-sort.',
  B: 'Health color on the left edge; the meter marks the bonus threshold. Click a card to open the account.',
  C: 'Portfolio KPIs on top, account list on the left, the selected account’s detail on the right — no pop-up.',
  D: 'Accounts grouped by health so the problems land first — organized around the bonus threshold.',
};

export default function DashboardLayoutPicker({ open, onClose }) {
  // One sitting per OPEN of the picker (CS-402). A fresh id each open, so a pick made in a
  // past visit LOCKS and "Change" must confirm; the reducer keeps the prior in history.
  const [sitting, setSitting] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => { if (open) { setSitting(newSitting()); setConfirmed(false); } }, [open]);
  const pick = usePickReview(LAYOUT_PICK_ID, sitting);
  const [tab, setTab] = useState(pick.choice || 'A');
  const [range, setRange] = useState('d30');
  const [cSel, setCSel] = useState('0004');
  const [expanded, setExpanded] = useState(false);
  const editable = !pick.locked || confirmed;

  // Reset to the standard size on close so it always opens compact.
  const handleClose = () => { setExpanded(false); onClose(); };

  return (
    <Modal open={open} onClose={handleClose} title="Choose your dashboard layout" size={expanded ? 'full' : 'lg'}>
      <div className={`dlp${expanded ? ' dlp-expanded' : ''}`}>
        <div className="dlp-intro">
          <div className="dlp-intro-text">
            <span className="dlp-tag">In review</span>
            <p>Four ways to show your 20 accounts. Preview each over live data, then choose the one you want. Leave a note if you&rsquo;d like changes.</p>
          </div>
          <button type="button" className="btn btn-outline dlp-expand" onClick={() => setExpanded((v) => !v)} aria-pressed={expanded}>
            <Icon name="expand" size={14} />{expanded ? 'Exit full screen' : 'Full screen'}
          </button>
        </div>

        <div className="dlp-tabs">
          {LAYOUT_VARIANTS.map((v) => (
            <button type="button" key={v.key} className={`dlp-vtab${tab === v.key ? ' is-active' : ''}`} onClick={() => setTab(v.key)}>
              <span className="dlp-vt-letter">{v.key}</span>
              <span className="dlp-vt-name">{v.name}</span>
              <span className="dlp-vt-desc">{v.desc}</span>
            </button>
          ))}
        </div>

        <div className="dlp-ptools">
          <span className="dlp-plbl">Preview · live seed data</span>
          <div className="segmented" role="group" aria-label="Preview range">
            {RANGES.map((r) => (
              <button type="button" key={r.key} className={`segmented-btn ${range === r.key ? 'active' : ''}`} onClick={() => setRange(r.key)}>{RANGE_SHORT[r.key]}</button>
            ))}
          </div>
        </div>

        <div className="dlp-preview">
          {tab === 'A' && <VariantA range={range} />}
          {tab === 'B' && <VariantB range={range} />}
          {tab === 'C' && <VariantC range={range} cSel={cSel} onSel={setCSel} />}
          {tab === 'D' && <VariantD range={range} />}
        </div>
        <div className="dlp-hint">{HINTS[tab]}</div>

        <div className="dlp-foot">
          <ReviewNotes entry={pick.entry} onAdd={(t) => pick.addNote(t)} placeholder={'Optional note for the team — e.g. “Love C, but move the past-due column to the front.”'} />
          {!editable ? (
            <div className={`dlp-decision ${pick.status}`}>
              {pick.status === 'chosen' && <Icon name="check" size={14} />}
              <span>
                {pick.status === 'chosen'
                  ? <>You chose <strong>Direction {pick.choice} · {LAYOUT_NAME[pick.choice]}</strong>. Saved and shared with the team.</>
                  : <>Changes requested on <strong>Direction {pick.choice} · {LAYOUT_NAME[pick.choice]}</strong>. The team will see your note.</>}
              </span>
              <button type="button" className="linklike dlp-link" onClick={() => setConfirmOpen(true)}>Change</button>
            </div>
          ) : (
            <div className="dlp-foot-row">
              <span className="dlp-foot-left">
                {pick.status === 'chosen'
                  ? <>You chose <strong>Direction {pick.choice}</strong>. Pick another or request changes.</>
                  : pick.status === 'changes'
                    ? <>Changes requested on <strong>Direction {pick.choice}</strong>. Update your pick below.</>
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
        message={`You ${pick.status === 'chosen' ? 'chose' : 'requested changes on'} Direction ${pick.choice}. The earlier pick stays listed in its history.`}
        confirmLabel="Change pick"
        onConfirm={() => setConfirmed(true)}
        onClose={() => setConfirmOpen(false)}
      />
    </Modal>
  );
}
