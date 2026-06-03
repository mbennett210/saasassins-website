import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Register the PWA service worker once on boot. Gated on browser support so
// dev environments that don't ship a service worker (e.g., older browsers)
// silently no-op rather than throwing. The registration is fire-and-forget;
// subscription/permission flows happen later from Account → Notifications.
//
// Path + scope follow the Vite base (import.meta.env.BASE_URL) so the same code
// works whether the app is served at '/' (per-client product) or '/polishpoint/'
// (marketing demo). A scope outside the script's own path would fail to register.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL;
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      /* registration failure is non-fatal — push just won't work */
    });
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
