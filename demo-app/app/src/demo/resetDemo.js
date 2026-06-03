import { clearState } from '../store/persist';

// Reset the demo to a pristine state: wipe the seeded CRM store (forcing a fresh
// reseed from INITIAL_STATE on reload) plus the demo-only cart, info-seen, and
// brand-personalization keys, then reload. Lets a prospect who rearranged the
// sandbox (or reskinned it with their own brand) start over clean.
export function resetDemo() {
  try {
    clearState();
    window.localStorage.removeItem('pp.demo.cart.v1');
    window.localStorage.removeItem('pp.demo.infoSeen.v1');
    window.localStorage.removeItem('pp.demo.brand.v1');
  } catch {
    /* ignore */
  }
  window.location.reload();
}
