import { useEffect } from 'react';
import { createPortal } from 'react-dom';

// Bottom-sheet modal for mobile — the shared "mobile selector modal" (THEME_CLEANSPACE
// R9). Slides up from the bottom, thumb-reachable, dismiss on backdrop / Escape / close.
// Used for the filter drawer and the mobile select pickers so every mobile picker is
// the SAME surface instead of anchored popovers spilling off their trigger.
export default function MobileSheet({ open, onClose, title, children, footer }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // lock the page behind the sheet
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  // Portal to <body> so the fixed backdrop escapes the page-level stacking context
  // (<main> carries z-index:1, which would otherwise trap the sheet — and its footer —
  // BENEATH the mobile floating nav .cs-fnav, a sibling of <main> at z-index:60). Portaled
  // out, the full-viewport scrim (--z-modal:400) covers the whole shell including the nav,
  // so the nav sits dimmed + inert behind the scrim and the sheet's footer is always
  // reachable. Mirrors Modal.jsx; this is the standing rule for every mobile popup — see
  // UI_RULES.md §105.
  return createPortal(
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <div className="sheet-head">
          <h3 className="sheet-title">{title}</h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
