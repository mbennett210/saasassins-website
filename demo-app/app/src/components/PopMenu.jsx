import { useDismissTap } from '../hooks/useDismissTap';
import { useIsMobile } from '../hooks/useIsMobile';
import MobileSheet from './MobileSheet';

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
export default function PopMenu({ open, onClose, anchorRef, className = '', role, sheetTitle, children, ...rest }) {
  const isMobile = useIsMobile();
  // Desktop-only: on mobile the MobileSheet owns its own dismissal (backdrop + Esc).
  useDismissTap({ open: open && !isMobile, ref: anchorRef, onDismiss: onClose });

  if (!open) return null;

  if (isMobile) {
    return (
      <MobileSheet open onClose={onClose} title={sheetTitle}>
        <div className={`${className} pop-in-sheet`.trim()} role={role} {...rest}>{children}</div>
      </MobileSheet>
    );
  }

  return <div className={className} role={role} {...rest}>{children}</div>;
}
