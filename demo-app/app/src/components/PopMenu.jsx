import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDismissTap } from '../hooks/useDismissTap';
import { useIsMobile } from '../hooks/useIsMobile';
import MobileSheet from './MobileSheet';
import { floatPlacement } from '../lib/floatPlacement';

// PopMenu: the shared floating-panel surface for the app's anchored pickers and
// menus (Select, the *Picker family, ClientStatusMenu, UserSwitcher, the filter
// facets, the messaging FiltersPopover). It owns the ONE decision every one of
// them was hand-rolling: DESKTOP renders an anchored popover (the caller's own
// .xxx-menu class) dismissed by a capture-phase click-outside that eats the tap
// (UI_RULES §100); MOBILE renders the panel inside a portaled MobileSheet
// (UI_RULES §105 / THEME_CLEANSPACE R9) so it escapes .main's stacking context,
// gets a real backdrop, closes on an outside tap and never taps through to the
// page behind.
//
// Usage: keep the trigger and (on desktop) the panel inside `anchorRef` so the
// trigger's own click still toggles and the click-outside spares them:
//   <div className="select-shell" ref={wrapRef}>
//     <button onClick={() => setOpen((o) => !o)}>…</button>
//     <PopMenu open={open} onClose={() => setOpen(false)} anchorRef={wrapRef}
//              className="select-menu" role="listbox" sheetTitle="Choose">
//       {options}
//     </PopMenu>
//   </div>
//
// On mobile the panel keeps its own class (so its list layout still applies; its rows are the
// kit's .menu-option, 48px in a sheet) plus `pop-in-sheet`, which drops
// the anchored geometry so the sheet owns the frame + scroll (see index.css).
//
// `float` (desktop; CS-724): for a picker inside something that CLIPS — a table row, whose
// .table-wrap scrolls sideways (overflow-x auto, which makes overflow-y hidden), so an anchored
// menu on a bottom row is cut off. The panel is drawn through a portal in fixed position at the
// trigger (lib/floatPlacement: below it when it fits, else on the side with more room), with the
// class `is-float`; the click-outside spares it as the second ref; a scroll outside it or a resize
// moves the trigger from under it, so it closes (the key-status menu's rule, pages/Keys). On a phone
// it is the sheet, as always.
export default function PopMenu({ open, onClose, anchorRef, className = '', role, sheetTitle, float = false, children, ...rest }) {
  const isMobile = useIsMobile();
  const floating = float && !isMobile;
  const menuRef = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; });
  // Desktop-only: on mobile the MobileSheet owns its own dismissal (backdrop + Esc). A floating
  // panel lives outside `anchorRef` (in a portal), so it is spared as the second ref.
  useDismissTap({ open: open && !isMobile, ref: anchorRef, ref2: floating ? menuRef : null, onDismiss: onClose });

  // A floating panel is placed before it paints, then closes on a scroll outside it or a resize.
  useLayoutEffect(() => {
    if (!open || !floating) return undefined;
    const menu = menuRef.current;
    const anchor = anchorRef?.current;
    if (menu && anchor) {
      const p = floatPlacement(anchor.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
      // Both ends of both axes, so nothing is left to the stylesheet (scripts/position-lint.mjs).
      Object.assign(menu.style, {
        left: `${p.left}px`,
        right: 'auto',
        width: `${p.width}px`,
        maxHeight: `${p.maxHeight}px`,
        top: p.top == null ? 'auto' : `${p.top}px`,
        bottom: p.bottom == null ? 'auto' : `${p.bottom}px`,
      });
      menu.dataset.side = p.up ? 'up' : 'down';
    }
    const onScroll = (e) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      closeRef.current?.();
    };
    const onResize = () => closeRef.current?.();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, floating, anchorRef]);

  if (!open) return null;

  if (isMobile) {
    return (
      <MobileSheet open onClose={onClose} title={sheetTitle}>
        <div className={`${className} pop-in-sheet`.trim()} role={role} {...rest}>{children}</div>
      </MobileSheet>
    );
  }

  if (floating) {
    return createPortal(
      <div ref={menuRef} className={`${className} is-float`.trim()} role={role} {...rest}>{children}</div>,
      document.body,
    );
  }

  return <div className={className} role={role} {...rest}>{children}</div>;
}
