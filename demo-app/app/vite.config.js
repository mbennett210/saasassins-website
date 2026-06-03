import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import brand from './vite-plugin-brand.js'

// https://vite.dev/config/
//
// Base path is env-driven so the SAME codebase serves two targets from one repo:
//   • per-client product build → base '/'             (default; no env needed)
//   • marketing demo build     → base '/polishpoint/' (VITE_BASE_PATH, mode "demo")
// React Router reads import.meta.env.BASE_URL (derived from `base`) for its
// basename, so routing, asset URLs, and the service-worker scope all follow the
// same prefix. See .env.demo + the *:demo npm scripts.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    base: env.VITE_BASE_PATH || '/',
    plugins: [react(), brand()],
    server: {
      // Honor PORT env var (set by Claude Preview runtime when autoPort is on);
      // fall back to 5173 for plain `npm run dev`.
      port: Number(process.env.PORT) || 5173,
      strictPort: false,
    },
  }
})
