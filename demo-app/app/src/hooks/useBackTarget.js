// THE ONE PLACE "where does Back go?" is decided.
//
// 🔴 WHY THIS EXISTS (Daniel, 2026-07-28): "Purchasing → Distributors (press Manage) takes
// you to settings, then it's just a back arrow and takes you to 'Settings', which is not
// back." The referrer was being passed correctly by the LINK — `Purchasing.jsx` already
// sent `state={nav}` — and then thrown away by the RECEIVER, because `SettingsLayout`
// hardcoded `<Link to="/settings">`. Four more back buttons had the same shape:
// OrderDetail, QuoteBuilder, QuoteEditor and ChangeOrderDetail each hardcoded their own
// list route. Only `DetailHeader` read the referrer, so only the four pages using it
// worked. Five hand-rolled implementations of one rule is why four of them were wrong.
//
// The rule, unchanged from DetailHeader's original: the referrer in `location.state`
// WINS; the page's own fallback is used only when the user arrived by direct URL or a
// refresh (when there is no history entry to go back to).
//
// Pair with `useFromHere()` on the sending side — that hook builds the `{from, fromLabel}`
// this one reads. A link that omits it silently regresses Back for that entry point,
// which is what `lint:backnav` now fails the build on.
import { useNavigate, useLocation } from 'react-router-dom';

export function useBackTarget(fallbackTo, fallbackLabel = 'Back') {
  const navigate = useNavigate();
  const location = useLocation();
  const target = location.state?.from || fallbackTo;
  const label = location.state?.fromLabel || fallbackLabel;
  // `navigate(-1)` only as a last resort: with neither a referrer nor a fallback there is
  // nothing better, but it is genuinely worse — it can walk the user out of the app.
  const goBack = (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (target) navigate(target);
    else navigate(-1);
  };
  return { target, label, goBack, href: target || '#' };
}
