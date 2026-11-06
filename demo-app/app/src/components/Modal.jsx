import { useId } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n/react';
import { useEscapeLayer } from '../hooks/useEscapeLayer';
import Centred from './Centred';

// `centred`: the × sits in the close button's middle by its ink (./Centred), opted into per pop-up
// (Daniel's pick, 2026-11-02, "Only this pop-up": the add-member pop-up, components/AddUserModal).
// Every other pop-up draws the × as it always has.
export default function Modal({ open, onClose, title, children, size, centred = false }) {
  const t = useT();
  // Esc closes the pop-up only when it is the newest layer open (UI_RULES §181): a dropdown,
  // sheet or pop-up opened inside it takes Esc first, so what was typed here stays.
  useEscapeLayer(open, onClose);
  // The overlay is a dialog, and its name is the header it already shows — announced as
  // one, not as an unnamed group of text (CS-552). The card carries the role because the
  // overlay is the click-to-dismiss backdrop, not the dialog itself.
  //
  // 🔴 NO `aria-modal="true"`, DELIBERATELY. It is a PROMISE that the rest of the page is
  // inert, and this Modal traps no focus: five Tabs out of an open pop-up land in the nav
  // behind the overlay, and two sibling dialogs can be open at once (the push prompt behind
  // the checklist result at 375px — measured). Claiming inertness a screen reader then acts
  // on, while the keyboard walks straight out, is worse than claiming nothing: it tells the
  // reader a boundary exists where there is none. A real focus trap IS the right fix, but it
  // changes behaviour for all 63 dialogs in the product and needs its own build and review.
  // The naming half stands on its own and ships here.
  const titleId = useId();

  if (!open) return null;
  // Portal to <body> so the fixed overlay escapes any page-level stacking
  // context (e.g. <main> carries z-index:1 and would otherwise trap the
  // modal beneath the sidebar at narrow desktop widths).
  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div
        className={`modal-card ${size ? `modal-card-${size}` : ''}`}
        role="dialog"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button className="modal-close" onClick={onClose} aria-label={t('common.close')}>{centred ? <Centred kind="ink">×</Centred> : '×'}</button>
        </div>
        {children}
      </div>
    </div>,
    document.body
  );
}
