import { clearState } from '../store/persist';

// Reset the demo to a pristine state: wipe the seeded CRM store (forcing a fresh
// reseed from INITIAL_STATE on reload) plus the demo-only cart + info-seen keys,
// then reload. Lets a prospect who rearranged the sandbox start over clean.
export function resetDemo() {
  try {
    clearState();
    window.localStorage.removeItem('pp.demo.cart.v1');
    window.localStorage.removeItem('pp.demo.infoSeen.v1');
  } catch {
    /* ignore */
  }
  window.location.reload();
}
