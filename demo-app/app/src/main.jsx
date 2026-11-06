import DemoLanding from './demo/DemoLanding'; // polishpoint-demo
import { demoEntry } from './demo/demoConfig'; // polishpoint-demo
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// First, so its listeners are on before Android hands over its install offer (which can come before
// the first paint): the Home Screen welcome's browser side (UI_RULES §178).
import './lib/installApp.js'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { installErrorBuffer } from './lib/errorBuffer.js'
import { isAuthConfigured } from './lib/supabaseClient'
import { ensureDemoData } from './lib/demoBootstrap'
import { onChunkLoadFailure } from './lib/staleBuild'
import { preloadCurrentLanguage } from './i18n/runtime'

// Console-error ring buffer for "Report an issue" diagnostics — installed
// before first render so errors thrown during boot are already captured when
// a user files a report. Last ~10 errors, truncated; see lib/errorBuffer.js.
installErrorBuffer()

// Any on-demand chunk that fails to load (not just route pages: `import('qrcode')` too) is
// either a tab that outlived a deploy or a phone with no signal. Vite reports it here before
// the import rejects; lib/staleBuild decides which: a reload onto the current build (guarded
// against loops) — or, with no signal, NOTHING, because offline a reload lands on the
// browser's "no internet" page and the app is gone (CS-665). Not preventDefault()-ed, so the
// importer still sees the rejection (lazyRoute shows the offline screen, or waits for the reload).
window.addEventListener('vite:preloadError', () => { onChunkLoadFailure() })

// Client sandbox only (Supabase not configured): seed the localStorage stub
// backends BEFORE React renders so /variance and the other stub-backed surfaces
// open populated. Seeds ONCE and then persists; a full refresh is on ?demo=reset.
// No-op in a real (authenticated) deployment. See lib/demoBootstrap.js.
if (!isAuthConfigured()) ensureDemoData()

// Register the PWA service worker once on boot. Gated on browser support so
// dev environments that don't ship a service worker (e.g., older browsers)
// silently no-op rather than throwing. The registration is fire-and-forget;
// subscription/permission flows happen later from Account → Notifications.
// The worker (public/sw.js) does push AND keeps the app's shell and the crew's screens on
// the phone for working with no signal (CS-665), so it registers in EVERY built bundle —
// the login-free demo build too, which is how the offline path is proven
// (scripts/test-offline-shell.mjs). It cannot pin an old bundle: pages come from the network
// first, and only hashed build files (whose names change with their content) come from the
// phone first. The dev server registers it only with a backend (for push); there its
// generated build lines keep their defaults and it caches nothing.
if ((import.meta.env.PROD || isAuthConfigured()) && 'serviceWorker' in navigator && import.meta.env.BASE_URL === '/') { // polishpoint-demo
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
      /* registration failure is non-fatal — push just won't work */
    });
  });
}

// No-zoom enforcement for the fixed-layout app shell. iOS Safari ignores the
// viewport `user-scalable=no`/`maximum-scale` for a deliberate pinch, so block
// the WebKit pinch gesture events directly. passive:false so preventDefault
// applies; these events only fire on iOS/Safari (harmless no-op elsewhere) and
// only on multi-finger gestures, so single-tap/scroll are unaffected.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}

// The first paint waits, briefly, for this device's language when it is not English (CS-193):
// Spanish and Creole are lazy downloads, and without the wait a Spanish cleaner's app opens
// in English and flips a moment later. Bounded, so a slow or failed download never holds the
// app back: it opens in English and switches in place when the words arrive. English (and a
// catalog already cached) resolves at once.
Promise.race([
  preloadCurrentLanguage(),
  new Promise((resolve) => setTimeout(resolve, 1200)),
]).finally(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <ErrorBoundary>
        {demoEntry() === 'landing' ? <DemoLanding /> : <App />}
      </ErrorBoundary>
    </StrictMode>,
  )
})
