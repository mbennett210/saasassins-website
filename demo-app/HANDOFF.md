# Shell Build — Handoff

**Last session end (2026-06-02):** **Marketing module backported from Rainier** — cold-email drip sequences with company-shared rotation inboxes, AI-routed replies, per-contact enrollments. Runs fully in stub mode on the shell (no backend). Storage v37 → v38. Also landed a small residual UI-primitive backport (Modal portal, eslint api/ block) earlier in the session. Details below.

## What just shipped (2026-06-02) — Marketing module

Backported the full Marketing module from `RainierFacilitySolutions/rainier-app` (the `rainier` remote is configured locally). Audit confirmed it runs **with no backend**: sends route through `lib/connectedInboxes.sendViaInbox()` which simulates locally when `VITE_EMAIL_BACKEND_URL` is unset; the inbound listener no-ops offline; replies are exercised via a "Simulate a reply" button.

Landed in 6 commits (a0a902c → 546f46f):
1. **Libs** — `lib/marketingScheduler.js` (new, pure-compute), `lib/connectedInboxes.js` (superset: +fromName/+attachments/+pollInbound), `lib/attachments.js` (marketing IndexedDB helpers). Correlation headers de-Rainier-ified `X-Rainier-Marketing-*` → `X-PP-Marketing-*`.
2. **Store** — 21 reducer actions + cases, 18 selectors, 5 seed entities + marketingSettings, persist `migrateV37toV38` (additive, idempotent), STORAGE_KEY → `pp.store.v38`.
3. **Permissions** — `marketing.view` / `marketing.manage` / `marketing.connectInbox` (owner+admin) + a Marketing group in the Roles editor.
4+5. **UI + wiring** — `pages/Marketing.jsx` + `pages/marketing/*` (8 tabs/modals) + `ConnectMarketingInboxModal` + `GmailConnectInstructions` (scrubbed of all Rainier copy), two root listeners mounted in `App.jsx`, `/marketing` route, Sidebar nav entry, `selectNonMasterPipelines` shim selector.
6. **CSS** — `.marketing-*` / `.enroll-*` block appended to index.css (no `.inbox-*` collisions).

**Verified:** v38 migration boots clean; /marketing renders all 4 tabs; Settings reply-routing pipeline picker works; created a sequence end-to-end through the modal (persists to store with a steps array); mobile pass clean at 320/375/641 (zero horizontal scroll).

**Deferred (backend workstream — NOT done):** real Gmail OAuth + sending via `api/inbox/*`, inbound webhook delivery, Supabase migrations. A future backend's inbound webhook must echo the `X-PP-Marketing-*` headers. This is the same deferred backend track noted for auth/forms/quotes.

**Earlier in the session:** residual Rainier UI-primitive backport — `Modal.jsx` createPortal-to-body + `eslint.config.js` api/ block (commit ed3677c). The rest of that backport wave (themed Select, FormField, roles fallback, UI_RULES) was already on origin from the other-session rebrand work.

---

## Prior session (2026-05-20)

**Mobile-header re-themed to PolishPoint primary blue.** Built the `swatchboard-to-theme.mjs` converter + four generated themes (Blue, Forge, Midnight, Pink) as a theme library. SOP for per-client re-skinning documented in `app/src/STYLING.md`.

## What this repo is

`Kronelius/shell-build` is the master shell — a complete, generic operations CRM for cleaning / facility-services businesses. Built as a React + Vite SPA in `app/`. Branded as PolishPoint. Per-client deployments clone this repo as their starting point, then swap brand config + theme + seed.

## What just shipped (2026-05-20)

### Mobile-header color fix
- `app/src/theme-polishpoint.css` and `theme-polishpoint-blue.css` (repo root): mobile-header tokens (`--mobile-header-bg`, `--mobile-header-border`, `--mobile-sub-color`, `--hamburger-color`) now resolve to brand-primary / on-primary tokens instead of the leftover dark-navy neutrals from the previous app. The mobile header now renders in PolishPoint blue (#1E8FE8) with a primary-600 edge and white hamburger.

### Swatchboard → theme converter
- `app/scripts/swatchboard-to-theme.mjs` — CLI that ingests a legacy swatchboard HTML file and emits a shell-ready `theme-<slug>.css` matching `STYLING.md`'s canonical vocabulary. OKLCH math derives missing scale steps from the swatchboard's anchor aliases; light/dark mode auto-detected from `--page-bg` brightness; correct recipe template chosen per mode; WCAG-based `--color-text-on-primary` selection.
- `app/scripts/templates/recipes-light.css` — light-theme recipe block (factored out of the existing `theme-polishpoint.css`).
- `app/scripts/templates/recipes-dark.css` — new dark-theme recipe block: white inset highlights dropped to near-zero, drop shadows deepened toward black, sidebar gradient endpoints flipped to neutral-900.

### Theme library (four generated variants)
- `app/src/theme-polishpoint-blue.css` — light, `#1E8FE8` anchor. Validated end-to-end via @import swap + live-preview diff; renders identically to the hand-tuned `theme-polishpoint.css`.
- `app/src/theme-polishpoint-forge.css` — dark, `#F97316` (orange) anchor.
- `app/src/theme-polishpoint-midnight.css` — dark, `#C9A84C` (gold) anchor; picks dark text on primary because white-on-gold fails WCAG.
- `app/src/theme-polishpoint-pink.css` — light, `#EC4899` anchor.

### Docs
- `app/src/STYLING.md` — added "Re-skinning the shell — SOP" section with theme library table, converter usage, Scenario A (client has swatchboard) + Scenario B (client has only a hex) workflows, deploy model, and expected lift (~10 min per re-skin once Scenario B's `--primary-hex` flag exists).

### Swatchboard sources
- `swatchboard/swatchboards.zip` + `swatchboard/unzipped/theme_polishpoint_{blue,forge,midnight,pink}_swatchboard.html` — the four canonical swatchboards are checked in for reference + re-runs of the converter.

## Open / suggested next pickup

1. **Eyeball Forge or Midnight on the live preview.** The `recipes-dark.css` template is the only piece that's net-new design work (white insets → near-zero, drop shadows deepened). It compiled and the tokens resolve, but no human has visually validated dark surfaces in the live app yet. To check: swap `index.css` line 3 to `@import './theme-polishpoint-forge.css';`, eyeball the dashboard at mobile + desktop, then swap back. Risk: a recipe value looks off and needs a tweak — fix is in the template, not the converter.

2. **Build the `--primary-hex` converter flag** (~30 min). Makes Scenario B (client gives only a hex color) a one-command operation:
   ```bash
   node app/scripts/swatchboard-to-theme.mjs <baseline-swatchboard> \
     --slug acme --primary-hex "#7C3AED" --name "Acme Corp"
   ```
   Currently Scenario B requires running the converter on a baseline swatchboard then hand-editing the brand-primary scale lines. Adopt this enhancement when re-skin volume justifies.

3. **Optional: drop swatchboard-compatibility aliases into `theme.css`** (~10 min). Adds `--sidebar-hover`, `--sidebar-active`, `--green/amber/red/blue/purple/slate-bg/text/border` trio aliases. Only worth it if you ever want to embed swatchboard preview HTML inside the shell (e.g., a Storybook-style page). Skipped this session because nothing breaks without it.

4. **First per-client clone** — use the SOP in `STYLING.md` to create the next client deployment. Pick the closest theme family, run the converter (or hand-edit per Scenario B), push to a new client repo under their GitHub org.

5. **Continue CORE roadmap** in `SHELL_ROADMAP.md` — this theme-tooling work is supporting infrastructure, not a roadmap item. Pick up the next `[ ]` in CORE for the next session.

## Running the app

```bash
cd app
npm install              # first time
npm run dev              # http://localhost:5173 (or first free port)
```

`npm run dev` automatically runs the manifest prebuild step. `npm run build` does the same for production.

## Re-skin SOP (summary)

The full procedure lives in `app/src/STYLING.md` § "Re-skinning the shell — SOP". One-line summary:

```bash
node app/scripts/swatchboard-to-theme.mjs <swatchboard.html> --slug <client> --name "<Name>"
# paste BRAND, swap @import, drop logo, regen icons → ~10 min total
```

## Historical context (preserved)

- `app/src/store/persist.js` migration functions still reference `@rainierfs.com` and `@rainierfacilitysolutions.com` — only operate on Rainier-era localStorage, never triggered in fresh shell-build clones (start at v37). Past migration code stays verbatim per project conventions.
