// ─────────────────────────────────────────────────────────────────────────────
// Feature flags — modules kept in the codebase but switched OFF for this client.
//
// A flag here gates ONLY visibility + client-side activation (the nav entry, the
// route, the background scheduler, the onboarding + Roles surfaces). The feature's
// state slices, reducer cases, selectors, pages, lib and backend all stay wired
// and intact, so opting the feature back in is a ONE-LINE reversal (flip the flag
// to true and redeploy) — never a rebuild. Keep the flag grep-able: to find every
// surface a flag guards, search the codebase for its name.
// ─────────────────────────────────────────────────────────────────────────────

// Marketing (email drip sequences). NOT a contracted section for Clean Space, so
// it is kept dormant (2026-09-22) pending a possible opt-in. This flag hides:
//   • the nav entry (Sales → Marketing)                  — lib/navData.js (the sidebar AND
//     global search read it; `enabled: false` hides it from both)
//   • the /marketing route + <MarketingScheduler/> mount — App.jsx
//   • the QuickStart onboarding card                     — pages/settings/QuickStart.jsx
//   • the Roles permission section                       — pages/settings/Roles.jsx
// The module itself (pages/marketing/*, lib/marketing*, app/api/marketing/*, and
// the seven marketing* state slices) stays in the tree, untouched and reversible.
// To restore Marketing: set this to true and redeploy. See brain/modules/marketing.md.
export const MARKETING_ENABLED = false;
