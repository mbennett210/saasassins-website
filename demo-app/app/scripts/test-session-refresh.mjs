// Resume refresh (S77 #4): returning to the foreground after being away pulls a fresh
// token, so a role change made while the tab was hidden — a demotion above all — reaches
// the UI without waiting out the ~1h JWT auto-refresh. The client is claims-first while
// the server enforces the role live, so a stale token only misleads the client.
//
// A: the pure decision `shouldRefreshOnResume` (src/lib/sessionRefresh.js).
// B: AuthProvider is wired to it — it listens for resume, and on a real absence refreshes
//    the Supabase session; and RoleSyncBanner's complementary one-shot split refresh is
//    intact (the online-foreground path this does NOT replace).
//
// Offline. Run: node scripts/test-session-refresh.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { shouldRefreshOnResume, RESUME_REFRESH_AWAY_MS } from '../src/lib/sessionRefresh.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const T = RESUME_REFRESH_AWAY_MS;
const base = { visibilityState: 'visible', hiddenSince: 1_000, now: 1_000 + T, hasSession: true, refreshing: false };

// ── A. the decision ──────────────────────────────────────────────────────────
ok('the threshold is a real interval', Number.isFinite(T) && T >= 1_000);
ok('🔴 away ≥ threshold, visible, signed in → refresh (the demotion-while-hidden case)',
  shouldRefreshOnResume(base) === true);
ok('exactly at the threshold → refresh', shouldRefreshOnResume({ ...base, now: 1_000 + T }) === true);
ok('a quick flick (away < threshold) → no refresh',
  shouldRefreshOnResume({ ...base, now: 1_000 + T - 1 }) === false);
ok('never went hidden (hiddenSince 0) → no refresh', shouldRefreshOnResume({ ...base, hiddenSince: 0 }) === false);
ok('  ...null hiddenSince too', shouldRefreshOnResume({ ...base, hiddenSince: null }) === false);
ok('still hidden (a hidden→hidden or blur event) → no refresh',
  shouldRefreshOnResume({ ...base, visibilityState: 'hidden' }) === false);
ok('no session (login screen) → no refresh', shouldRefreshOnResume({ ...base, hasSession: false }) === false);
ok('a refresh already in flight → no refresh (coalesces focus + visibilitychange)',
  shouldRefreshOnResume({ ...base, refreshing: true }) === false);
ok('a custom awayMs is honored', shouldRefreshOnResume({ ...base, now: 1_000 + 500, awayMs: 400 }) === true
  && shouldRefreshOnResume({ ...base, now: 1_000 + 300, awayMs: 400 }) === false);

// ── B. the wiring ──────────────────────────────────────────────────────────────
const ap = read('src/auth/AuthProvider.jsx');
ok('AuthProvider imports the pure decision', /import \{ shouldRefreshOnResume \} from '\.\.\/lib\/sessionRefresh'/.test(ap));
ok('🔴 it decides via the helper, not an inline rule', /shouldRefreshOnResume\(\{/.test(ap));
ok('  ...feeding it the live inputs', /visibilityState: document\.visibilityState/.test(ap)
  && /hasSession: !!sessionRef\.current/.test(ap));
ok('🔴 it refreshes the Supabase session when the decision says so', /supabase\.auth\.refreshSession\(\)/.test(ap));
// The refresh must be GATED on the helper's result and come after it, or the wiring would
// refresh on every resume regardless of the decision (the helper would be decorative).
ok('🔴 the refresh is gated on the helper result (`if (!ok) return;` before it)',
  /const ok = shouldRefreshOnResume\(\{/.test(ap) && /if \(!ok\) return;/.test(ap)
  && ap.indexOf('if (!ok) return;') < ap.indexOf('supabase.auth.refreshSession()'));
// The away-marker resets on every visible event, so a focus with no intervening hide can't
// re-fire — the guard against refreshing on every quick focus.
ok('🔴 hiddenSince resets to 0 on a visible event', /if \(document\.visibilityState === 'visible'\) hiddenSince = 0;/.test(ap));
ok('  ...guarded by the configured client', /if \(!supabase\) return undefined;/.test(ap.slice(ap.indexOf('Resume refresh'))));
ok('it marks hiddenSince when the tab goes hidden', /document\.visibilityState === 'hidden'\) hiddenSince = Date\.now\(\)/.test(ap));
ok('it listens for every resume signal (visibility, PWA pageshow, focus)',
  /addEventListener\('visibilitychange', onVis\)/.test(ap)
  && /addEventListener\('pageshow', resume\)/.test(ap)
  && /addEventListener\('focus', resume\)/.test(ap));
ok('  ...and removes each on cleanup', (ap.match(/removeEventListener\('(visibilitychange|pageshow|focus)'/g) || []).length === 3);
ok('the refresh is best-effort (a throw never crashes the provider)',
  /Promise\.resolve\(supabase\.auth\.refreshSession\(\)\)\s*\.catch\(/.test(ap) && /\.finally\(\(\) => \{ refreshing = false; \}\)/.test(ap));
// The refresh doesn't need its own claim plumbing: TOKEN_REFRESHED runs through the
// existing onAuthStateChange → setSession, and useAuth reads role off session.user.
ok('the session subscription that carries the new token is still present',
  /onAuthStateChange\(\(event, s\) =>/.test(ap) && /setSession\(s \?\? null\)/.test(ap));

// ── B2. RoleSyncBanner's complementary path is intact (not replaced) ─────────────
const banner = read('src/components/RoleSyncBanner.jsx');
ok('RoleSyncBanner still one-shot refreshes on a claim-vs-roster split',
  /supabase\.auth\.refreshSession\(\)/.test(banner)
  && /refreshedFor\.current === key/.test(banner)
  && /claimRole && claimRole !== blobRole/.test(banner));

console.log(`\ntest-session-refresh: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exit(1);
}
