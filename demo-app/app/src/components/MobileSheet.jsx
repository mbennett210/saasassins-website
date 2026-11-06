import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n/react';
import { useEscapeLayer } from '../hooks/useEscapeLayer';

// Bottom-sheet modal for mobile — the shared "mobile selector modal" (THEME_CLEANSPACE
// R9). Slides up from the bottom, thumb-reachable, dismiss on backdrop / Escape / close.
// Used for the filter drawer and the mobile select pickers so every mobile picker is
// the SAME surface instead of anchored popovers spilling off their trigger.
//
// Optional header extras (both default to nothing): `titleAside` renders right after the
// title text (a count), `actions` sits beside the close button (a text button such as
// "Mark all read"), so a sheet needs no extra toolbar row above its content.
export default function MobileSheet({ open, onClose, title, titleAside, actions, children, footer }) {
  const t = useT();
  // Esc (a keyboard on a tablet or phone) closes only the newest layer (UI_RULES §181): this
  // sheet over a pop-up closes alone, and a sheet opened from inside this one closes first.
  useEscapeLayer(open, onClose);
  useEffect(() => {
    if (!open) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; // lock the page behind the sheet
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  // Portal to <body> so the fixed backdrop escapes the page-level stacking context
  // (<main> carries z-index:1, which would otherwise trap the sheet — and its footer —
  // BENEATH the mobile floating nav .cs-fnav, a sibling of <main> at z-index:60). Portaled
  // out, the full-viewport scrim (--z-modal:400) covers the whole shell, and the nav slides
  // away while the sheet is open (.sheet-backdrop is on index.css's POP-UP LIST), so the
  // sheet's footer is always reachable. Mirrors Modal.jsx; this is the standing rule for
  // every mobile popup — see UI_RULES.md §105.
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
          <h3 className="sheet-title">{title}{titleAside}</h3>
          {actions && <div className="sheet-head-actions">{actions}</div>}
          <button type="button" className="modal-close" onClick={onClose} aria-label={t('common.close')}>×</button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}
