// Marketing-demo config. IS_DEMO is on only in the demo build (MODE === 'demo' → build:demo and the
// --mode demo dev servers); a product build leaves it false, so the landing never renders there and the
// router keeps its root.
// Optional chaining so this module is safe to import under plain node too, where import.meta.env is undefined.
export const IS_DEMO = import.meta?.env?.MODE === 'demo';

// Where the build is mounted: '/polishpoint' on the SaaSassins site (VITE_BASE_PATH in .env.demo), '' at a root.
const BASE = (import.meta?.env?.BASE_URL || '/').replace(/\/$/, '');

// The live app's router root. The landing owns /polishpoint and the app /polishpoint/demo, so every '/' inside
// the app (its home, "Back to Dashboard", a menu's Home) is the app's own dashboard, never the landing.
export const APP_ROOT = `${BASE}/demo`;
export const ROUTER_BASE = IS_DEMO ? APP_ROOT : '/';

// A page inside the live app, as a plain link (the landing renders outside the app's router).
export const demoHref = (route = '/') => (route === '/' ? APP_ROOT : `${APP_ROOT}${route}`);

// Which page this load is: the landing (exactly /polishpoint), the app (/polishpoint/demo and below), or a deep
// link from before the app moved under /demo (/polishpoint/schedule), sent on to the same page there.
export function demoEntry() {
  if (!IS_DEMO) return 'app';
  const { pathname, search, hash } = window.location;
  const p = pathname.replace(/\/+$/, '');
  if (p === BASE) return 'landing';
  if (p === APP_ROOT || p.startsWith(`${APP_ROOT}/`)) return 'app';
  if (p.startsWith(`${BASE}/`)) {
    window.location.replace(APP_ROOT + p.slice(BASE.length) + search + hash);
    return 'redirect';
  }
  return 'app';
}

// Every "Book a call" opens PolishPoint's own booking page (the same one polishpointdev.com uses).
export const BOOK_A_CALL_URL = 'https://calendly.com/hello-polishpointdev/demo?primary_color=00b0ff';

export function bookACall() {
  window.open(BOOK_A_CALL_URL, '_blank', 'noopener,noreferrer');
}
