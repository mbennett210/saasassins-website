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
export const MARKETING_ENABLED = true; // polishpoint-demo: on in the demo

// Quotes (the e-signature proposals: build one, the customer gets an email with a link to
// review and sign it, then a signed copy). Matt does proposals and e-signatures in PandaDoc,
// and answered Review's MISC-7 "Hide it — we use PandaDoc" (2026-10-23, 9:16 AM PT), so it is
// kept dormant. This flag hides:
//   • the nav entry (Finances → Quotes)                 — lib/navData.js (the sidebar AND
//     global search read it; `enabled: false` hides it from both)
//   • search's "New quote" action                       — lib/masterSearch/registry.js
//   • the /quotes and /quotes/:id routes                — App.jsx
//   • the QuickStart onboarding card                    — pages/settings/QuickStart.jsx
//   • the Roles permission section                      — pages/settings/Roles.jsx
// Its four emails left Review the same day (reviewManifest.json retiredDrafts). The public
// signing page (/quote/:token) stays, so a link already sent still opens; the pages, lib,
// app/api/quotes and the quotes table stay in the tree, untouched and reversible.
// To restore Quotes: set this to true and redeploy. See brain/modules/billing.md.
export const QUOTES_ENABLED = true; // polishpoint-demo: on in the demo
