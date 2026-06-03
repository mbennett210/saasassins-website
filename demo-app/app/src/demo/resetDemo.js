import { clearState } from '../store/persist';

// Reset the demo to a pristine state: wipe the seeded CRM store (forcing a fresh
// reseed from INITIAL_STATE on reload) plus the demo-only cart, info-seen,
// brand-personalization, and guided-tour keys, then reload. Lets a prospect who
// rearranged the sandbox (or reskinned it / saw the tour) start over clean.
export function resetDemo() {
  try {
    clearState();
    window.localStorage.removeItem('pp.demo.cart.v1');
    window.localStorage.removeItem('pp.demo.infoSeen.v1');
    window.localStorage.removeItem('pp.demo.brand.v1');
    window.localStorage.removeItem('pp.demo.tourSeen.v1');
  } catch {
    /* ignore */
  }
  window.location.reload();
}
