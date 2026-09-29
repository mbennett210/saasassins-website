// Single source of truth for whether the DEMO (localStorage-stub) backends are
// engaged — shared by timeApi / varianceApi / driveApi / qcApi / securityApi /
// accountMediaApi, which used to each compute their own copy of the same test.
//
// ⏱️ WHY THIS IS LOAD-BEARING (Sept 1 incident): the June-era production builds
// shipped with the demo time clock engaged. Crew phones froze on those builds
// (mobile tabs live for months without reloading, and the AutoUpdater didn't
// exist until Jul 13), so every crew clock-in for months went to per-phone
// localStorage — a perfect local experience, zero server writes, zero errors,
// and payroll data that "registered nowhere". Two rules prevent a recurrence:
//
//   1. IN A PRODUCTION BUILD THE DEMO FLAG IS DEAD. `VITE_TIME_STUB` only
//      engages the stubs when the bundle is NOT a production build
//      (import.meta.env.PROD is false). A prod deploy can no longer be demoed
//      by a stray env var — the only way prod runs stubs is having no Supabase
//      auth configured at all, which is unmistakably a broken deploy.
//   2. WHEN THE COMBINATION IS EVEN POSSIBLE (dev build + real auth + flag),
//      DemoBackendsBanner paints an unmissable warning across the app so
//      nobody mistakes demo data for saved data again.
// Extensioned specifier (Vite resolves either) so this module — now imported by teamApi
// for markStub — is loadable by bare Node too (scripts/test-orphan-adopt.mjs /
// test-team-logins.mjs import teamApi). Without the .js, Node ESM cannot resolve it.
import { isAuthConfigured } from './supabaseClient.js';

const flagSet = typeof import.meta !== 'undefined' && import.meta.env?.VITE_TIME_STUB === '1';
const isProdBuild = typeof import.meta !== 'undefined' && !!import.meta.env?.PROD;

export function demoBackendsEngaged() {
  return !isAuthConfigured() || (flagSet && !isProdBuild);
}

// True in the DANGEROUS combination only: real auth is configured but the demo
// stubs are engaged anyway (a dev build with VITE_TIME_STUB). Local mode with no
// auth at all is the intentional prototype experience and gets no warning.
export function demoOverRealAuth() {
  return isAuthConfigured() && demoBackendsEngaged();
}

// ── stub-reachability registry + build-mode beacon (check-bundle-stubs.mjs) ─────
// The FLAG-based stub adapters (quotesApi / integrationsApi / teamApi) and the Twilio
// stub each call markStub('cs-stub:<name>') from INSIDE a branch that is statically dead
// in a production build. Those adapters gate the branch on the PLAIN import.meta.env.MODE
// / .PROD that Vite inlines at build time, so in `npm run build` (MODE === 'production')
// the branch — call, sentinel string and stub body — is dead code esbuild removes, while
// a demo build (MODE === 'demo': build:demo, and the --mode demo dev servers) keeps it.
// That is what makes the sentinel PRESENT iff a stub is reachable, and it is why CS-010
// (Quotes ran on the browser stub in production for weeks) cannot recur silently.
//
// The globalThis write is a real side effect, so a minifier cannot drop the sentinel as
// an unused string. activeStubs() lets any surface enumerate what engaged.
export function markStub(sentinel) {
  try {
    const g = globalThis;
    (g.__csActiveStubs || (g.__csActiveStubs = [])).push(sentinel);
  } catch { /* noop — never let a diagnostic marker break a render */ }
  return sentinel;
}
export function activeStubs() {
  try { return (globalThis.__csActiveStubs || []).slice(); } catch { return []; }
}

// Build-mode beacon. import.meta.env.MODE is inlined at build time, so this whole
// statement dead-code-eliminates from a production build (MODE === 'production') and is
// ABSENT from that artifact; a demo/dev build keeps the literal `cs-build-nonprod:<mode>`
// for check-bundle-stubs.mjs (which ignores a `:production` suffix, so it stays green even
// in the unlikely event a minifier leaves the dead branch behind).
if (typeof import.meta !== 'undefined' && import.meta.env?.MODE && import.meta.env.MODE !== 'production') {
  markStub('cs-build-nonprod:' + import.meta.env.MODE);
}
