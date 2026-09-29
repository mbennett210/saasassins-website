import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { execSync } from 'node:child_process'

// Monotonic build id inlined into the bundle, stamped on every org_state / jobs write
// (src/lib/appBuild.js). It is what makes the fleet-reload gate machine-checkable:
// "zero writes with updated_by_build < min_client_build across a soak" is the only
// real evidence that no pre-deploy tab can still resurrect a slice mid-prune.
// Evaluated once when this config loads, i.e. per build / per dev-server start.
const APP_BUILD = String(Date.now());

// Short git SHA for diagnostics (support reports stamp `cleanspace-app@<sha>`).
// Vercel exposes the commit at build time; local builds ask git; anything else
// (a tarball build) degrades to '' and callers render 'dev'.
const APP_SHA = (() => {
  const fromEnv = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromEnv) return String(fromEnv).slice(0, 7);
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return ''; }
})();

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load app/.env* so the /api proxy target can be overridden per-machine.
  const env = loadEnv(mode, process.cwd(), '');
  // Local dev proxies /api to the LIVE shared backend by default, so local work runs
  // against the SAME Supabase data the team and client see during construction (one
  // shared view). Override with VITE_API_PROXY in app/.env.local to point at a local
  // `vercel dev` (http://localhost:3000) once the vercel-dev :rest* routing bug is fixed.
  const API_PROXY = env.VITE_API_PROXY || 'https://cleanspace-gilt.vercel.app';
  return {
    // Base path is env-driven so the same shell serves the per-client product at '/' and the
    // marketing demo under '/polishpoint/' (VITE_BASE_PATH, set in .env.demo). React Router
    // reads import.meta.env.BASE_URL for its basename, so routes + assets follow the prefix.
    base: env.VITE_BASE_PATH || '/',
    plugins: [react()],
    define: {
      'import.meta.env.VITE_APP_BUILD': JSON.stringify(APP_BUILD),
      'import.meta.env.VITE_APP_SHA': JSON.stringify(APP_SHA),
    },
    server: {
      // Honor PORT env var (set by Claude Preview runtime when autoPort is on).
      // Otherwise a bare `npm run dev` binds 5214, CleanSpace's DEDICATED connected/
      // Supabase dev port, and HOLDS it (strictPort) instead of drifting to 5215+, so
      // the per-origin Supabase login (localStorage['cleanspace.auth'] on localhost:5214)
      // survives across sessions. (5213 is the login-free demo's own dedicated port.)
      port: Number(process.env.PORT) || 5214,
      strictPort: !process.env.PORT,
      // Proxy serverless /api/* to API_PROXY (the live prod backend by default; see above).
      proxy: {
        '/api': { target: API_PROXY, changeOrigin: true },
      },
    },
  };
})
