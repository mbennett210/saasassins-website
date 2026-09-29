// Marketing-demo config. IS_DEMO is on only in the demo build (MODE === 'demo' → build:demo and the
// --mode demo dev servers); the per-client product build leaves it false so none of the demo-only UI
// (the landing, the modules pitch, the book-a-call CTAs) compiles in.
// Optional chaining so this module is safe to import under plain node too (navData.js pulls it in, and
// search-lint.mjs imports navData outside Vite, where import.meta.env is undefined).
export const IS_DEMO = import.meta?.env?.MODE === 'demo';

// The app's home route: the dashboard sits at /demo in the demo (the landing owns /), and at / in the product.
export const HOME_PATH = IS_DEMO ? '/demo' : '/';

// Every "Book a call" opens PolishPoint's own booking page (the same one polishpointdev.com uses).
export const BOOK_A_CALL_URL = 'https://calendly.com/hello-polishpointdev/demo?primary_color=00b0ff';

export function bookACall() {
  window.open(BOOK_A_CALL_URL, '_blank', 'noopener,noreferrer');
}
