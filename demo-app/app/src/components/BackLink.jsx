// The shared "← Back" control. Renders an anchor whose href is the REAL destination, so
// the target is visible on hover and middle-click/⌘-click open it properly, while the
// click handler routes through the SPA.
//
// `className` exists because the three placements were styled independently before they
// shared behaviour (`detail-back` on a detail page, `set-back` in the settings shell,
// `qb-back` on the builder-style pages). Keeping the classes keeps this a behaviour
// change only — no page moves by a pixel.
//
// See `useBackTarget` for the rule, and `useFromHere` for the sending half.
import { useBackTarget } from '../hooks/useBackTarget';

export default function BackLink({ to, label = 'Back', className = 'detail-back' }) {
  const { href, label: text, goBack } = useBackTarget(to, label);
  return <a href={href} className={className} onClick={goBack}>← {text}</a>;
}
