import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { installErrorBuffer } from './lib/errorBuffer.js'
import { isAuthConfigured } from './lib/supabaseClient'
import { ensureDemoData } from './lib/demoBootstrap'
import { recoverFromStaleBuild } from './lib/staleBuild'

// Console-error ring buffer for "Report an issue" diagnostics — installed
// before first render so errors thrown during boot are already captured when
// a user files a report. Last ~10 errors, truncated; see lib/errorBuffer.js.
installErrorBuffer()

// Any on-demand chunk that fails to load (not just route pages: `import('qrcode')` too) is
// almost always a tab that outlived a deploy. Vite reports it here before the import
// rejects; reload onto the current build (guarded against loops, lib/staleBuild). Not
// preventDefault()-ed, so the importer still sees the rejection and waits for the reload.
window.addEventListener('vite:preloadError', () => { recoverFromStaleBuild() })

// Client sandbox only (Supabase not configured): seed the localStorage stub
// backends BEFORE React renders so /variance and the other stub-backed surfaces
// open populated. Seeds ONCE and then persists; a full refresh is on ?demo=reset.
// No-op in a real (authenticated) deployment. See lib/demoBootstrap.js.
if (!isAuthConfigured()) ensureDemoData()

// Register the PWA service worker once on boot. Gated on browser support so
// dev environments that don't ship a service worker (e.g., older browsers)
// silently no-op rather than throwing. The registration is fire-and-forget;
// subscription/permission flows happen later from Account → Notifications.
// SKIPPED in the local sandbox (no auth): a stale SW cache must not pin an old
// bundle, and ?demo=reset expects the freshest bundle each time.
if (isAuthConfigured() && 'serviceWorker' in navigator) {
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

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
