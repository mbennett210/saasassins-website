# Shell Build — Handoff

**Last session end (2026-06-07):** **Re-homed the demo to `saasassinsdev.com/polishpoint` + shipped a product landing page + re-priced to the agreed sheet midpoints** (`polishpoint-demo` branch). The SPA index (`/polishpoint`) is now a real product landing; the live app's home moved to `/polishpoint/demo`; checkout stays at `/polishpoint/checkout`. SMS broke out of Core into its own add-on, and three not-built sheet lines (Forms, Sales Automation, Data Migration) were added as paywall-gated add-ons. Details below. (Prior 2026-06-03: AI demo concierge; 2026-06-02: Marketing module, storage v38 — preserved below.)

## What just shipped (2026-06-07) — Re-home + sheet pricing + product landing

Consolidated the PolishPoint demo off the old **polishpointdev.com** to live under **saasassinsdev.com/polishpoint**, added the product landing page, and set every price to the agreed pricing-sheet MIDPOINTS. Everything is gated on `IS_DEMO`, so per-client product builds are untouched.

**Route flip (demo build only):**
- `/polishpoint` (SPA index) → **product landing** (was: straight into the app).
- `/polishpoint/demo` → **live app home** (Dashboard). `App.jsx` mounts `HomeRoute` at `path="demo"` when `IS_DEMO`, keeps `index → HomeRoute` for per-client builds.
- `/polishpoint/checkout` → unchanged.
- Every "home = `/`" reference flipped to `/demo` in demo mode: `Sidebar` Dashboard link, `NotFound` / `RequirePerm` home links, `CheckoutPage` / `CheckoutSuccess` nav buttons, `DemoChrome` cart-FAB hide logic (now hides on `/` + `/checkout`, shows across the app incl. `/demo`), `PlacementCTAs` dashboard placement, `tour/infoPoints.js` dashboard path, and `api/assistant.js` `FEATURE_ROUTES.dashboard`.

**Pricing → sheet midpoints** (display `src/demo/modules.catalog.js` ↔ charge `api/_modules.js` ↔ concierge `api/assistant.js`, kept in lockstep):
- Core $1,500 → **$2,000**; Marketing → renamed **Email Marketing** $600 → **$2,000**; ipr → renamed **Invoicing + Quoting** $400 → **$1,500**; QuickBooks $300 → **$2,000**; Inventory → renamed **Inventory / Key Tracking** $400 → **$1,500**; EMS $800 → **$3,500**; Field Ops $600 → **$2,750**.
- **SMS / Texting (Twilio + A2P)** pulled OUT of Core into its own **$625** add-on (per decision this session). Core's "SMS via Twilio + A2P" feature bullet removed.
- New paywall-gated add-ons (`featured: true`, no `route` → info dialog, still purchasable): **Forms / Lead Capture $750**, **Sales Automation $1,500**, **Data Migration $500**.
- **No store/seed/persist bump** — the catalog is a static module, not store state (still v38). Cart only persists module ids; we added ids, removed none.

**Landing page** (`src/demo/pages/DemoLanding.jsx`, now the index route, PolishPoint-blue theme): hero + CTAs ("Explore the live demo" → `/demo`, "See pricing" → `#pricing`); add-on module grid; Core-included band; full **pricing table** (`#pricing` — all 11 sheet lines at midpoints with Core / Built / Add-on tags) + caption; closing CTA band. New `.pp-pricing-*` + `.pp-demo-cta` styles in `demo.css` (token-compliant, mobile-collapse to stacked cards).

**Static site:** `showcase.html` "Visit PolishPoint" CTA repointed from `https://www.polishpointdev.com/` → `/polishpoint` (internal; dropped `target=_blank`/external arrow). The top-nav "Live Demo" buttons (`index/about/contact/showcase`) already point to relative `/polishpoint/demo` — which now lands straight in the live app — so they were left as-is.

**Verified (dev:demo + production build):** landing renders all 11 pricing rows at correct midpoints; "Explore the live demo" → `/polishpoint/demo` (Dashboard with sidebar + cart FAB); sidebar Dashboard link returns to `/demo`; the 4 new add-ons open paywall info dialogs (SMS shows $625 + Add to cart + 5 features); checkout total math correct (Core $2,000 + Field Ops $2,750 = $4,750); "Back to demo" → `/demo`; ESLint clean on all changed files; mobile pass (no horizontal scroll, `scrollWidth === clientWidth`) at 320 / 375 / 641 on landing + checkout; `npm run build` (build:demo + assemble) succeeds; zero console errors. Raster `preview_screenshot` still times out in this environment — verified via DOM assertions + snapshots (same as the 2026-06-03 session).

**Flagged (Vercel dashboard / Stripe — outside the repo):**
- The new midpoint prices go **LIVE to Stripe on the next deploy** (checkout uses live keys via `api/_modules.js`). Confirm before deploying if that's not intended yet.
- If `polishpointdev.com` is still attached to this Vercel project, add a host-conditional 308 redirect → `https://saasassinsdev.com/polishpoint` (offered, not added — depends on the domain's current attachment).

---

## What just shipped (2026-06-03) — Demo concierge (AI chat)

Net-new **prospect-facing** chat concierge for the sales demo. Gated on `IS_DEMO`, so none of it compiles into per-client product builds. Commit `9b2f166` (8 files, +888).

**Files:**
- `api/assistant.js` (new) — Vercel serverless OpenAI proxy. Key stays server-side (same posture as `api/checkout.js`); grounded on `_modules.js` server prices; tool-calling (navigate / add-to-cart / open-cart / checkout); `DEMO_CHAT_ENABLED` kill switch; best-effort in-memory rate limit; input caps. Global `fetch`, no new deps. `GET` returns a health check.
- `app/src/lib/demoAssistant.js` (new) — adapter. Calls the proxy when `VITE_ASSISTANT_BACKEND_URL` is set, else a grounded local stub; falls back to the stub on ANY backend error. **Intentionally NOT pinned to stub under `IS_DEMO`** (unlike twilio/email/push) — it's a read-only Q&A endpoint, like checkout, so the demo is allowed to reach it.
- `app/src/demo/assistant/conciergeKnowledge.js` (new) — catalog/tour-derived stub brain, suggested prompts, and the validated action vocabulary (drops hallucinated module ids / routes).
- `app/src/demo/assistant/ConciergeWidget.jsx` + `assistant.css` (new) — bottom-left launcher + panel, streaming reveal, chips, disclosure. Executes returned actions via `useNavigate` + `useCart`.
- `app/src/demo/components/DemoChrome.jsx` — mounts the widget and hands it `onOpenCart` (the cart-drawer open state lives here).
- `.env.example` (root) + `app/.env.example` — documented `OPENAI_API_KEY` / `OPENAI_MODEL` / `DEMO_CHAT_ENABLED` (server) and `VITE_ASSISTANT_BACKEND_URL` (frontend).

**No store changes:** conversation state is in-memory in the widget — no seed/persist/STORAGE_KEY bump (still v38).

**Verified (stub path — what `dev:demo` runs):** grounded Q&A ("How much is Marketing?" → "$600 one-time"); "take me to the pipeline" routes to `/pipeline` and the info-pin appears (it drove the tour); "add field ops to my order" → cart `["fieldops"]`, badge 1; zero console errors; lint clean on all four new frontend files. Mobile pass at 320/375/641 (zero horizontal scroll, panel on-screen) verified via assertions + `preview_inspect`.

> **Note (2026-06-07):** concierge pricing answers now reflect the new midpoints automatically (the stub reads the catalog; the proxy reads `_modules.js`). The dashboard tour/navigate target moved to `/demo` in both `infoPoints.js` and `api/assistant.js`.

**Bug caught + fixed in verification:** "…to my order" matched the cart-summary intent before add-to-cart; reordered intent priority in the stub brain.

**Deferred (productionization — NOT done):**
- **Live-LLM path is code-complete but NOT runtime-verified** — plain `vite dev` doesn't serve `/api`. To activate: set `OPENAI_API_KEY` server-side + `VITE_ASSISTANT_BACKEND_URL=/api/assistant` in the demo's Vercel env (or run `vercel dev` locally). Until then it runs on the stub.
- Raster `preview_screenshot` timed out in this environment (every attempt), so the commit-time screenshot pass is still owed at a workstation where the tool works; the no-horizontal-scroll assertions did pass at all three viewports.
- Durable rate limiting (Vercel KV / Upstash; current limiter is in-memory per warm instance).
- True token streaming (currently request/response + client-side typewriter reveal).
- Pass cart contents into the model context; prospect-question analytics.

---

## What just shipped (2026-06-02) — Marketing module

Backported the full Marketing module from an earlier proving build (a private upstream remote). Audit confirmed it runs **with no backend**: sends route through `lib/connectedInboxes.sendViaInbox()` which simulates locally when `VITE_EMAIL_BACKEND_URL` is unset; the inbound listener no-ops offline; replies are exercised via a "Simulate a reply" button.

Landed in 6 commits (a0a902c → 546f46f):
1. **Libs** — `lib/marketingScheduler.js` (new, pure-compute), `lib/connectedInboxes.js` (superset: +fromName/+attachments/+pollInbound), `lib/attachments.js` (marketing IndexedDB helpers). Correlation headers renamed to the PolishPoint namespace `X-PP-Marketing-*`.
2. **Store** — 21 reducer actions + cases, 18 selectors, 5 seed entities + marketingSettings, persist `migrateV37toV38` (additive, idempotent), STORAGE_KEY → `pp.store.v38`.
3. **Permissions** — `marketing.view` / `marketing.manage` / `marketing.connectInbox` (owner+admin) + a Marketing group in the Roles editor.
4+5. **UI + wiring** — `pages/Marketing.jsx` + `pages/marketing/*` (8 tabs/modals) + `ConnectMarketingInboxModal` + `GmailConnectInstructions` (scrubbed of all prior-build copy), two root listeners mounted in `App.jsx`, `/marketing` route, Sidebar nav entry, `selectNonMasterPipelines` shim selector.
6. **CSS** — `.marketing-*` / `.enroll-*` block appended to index.css (no `.inbox-*` collisions).

**Verified:** v38 migration boots clean; /marketing renders all 4 tabs; Settings reply-routing pipeline picker works; created a sequence end-to-end through the modal (persists to store with a steps array); mobile pass clean at 320/375/641 (zero horizontal scroll).

**Deferred (backend workstream — NOT done):** real Gmail OAuth + sending via `api/inbox/*`, inbound webhook delivery, Supabase migrations. A future backend's inbound webhook must echo the `X-PP-Marketing-*` headers. This is the same deferred backend track noted for auth/forms/quotes.

**Earlier in the session:** residual UI-primitive backport — `Modal.jsx` createPortal-to-body + `eslint.config.js` api/ block (commit ed3677c). The rest of that backport wave (themed Select, FormField, roles fallback, UI_RULES) was already on origin from the other-session rebrand work.

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

> **Update (2026-06-03, `polishpoint-demo` branch):** the standalone `theme-polishpoint-{forge,midnight,pink}.css` files listed above were removed. The sales demo themes its checkout *preview* (the MiniApp swatchboards) instead of live-reskinning the app, so those dormant theme files were dead weight on this branch. `theme-polishpoint.css` (active) + `theme-polishpoint-blue.css` remain; the swatchboard HTML sources (below) are kept, so any variant can be regenerated via the converter.

### Docs
- `app/src/STYLING.md` — added "Re-skinning the shell — SOP" section with theme library table, converter usage, Scenario A (client has swatchboard) + Scenario B (client has only a hex) workflows, deploy model, and expected lift (~10 min per re-skin once Scenario B's `--primary-hex` flag exists).

### Swatchboard sources
- `swatchboard/swatchboards.zip` + `swatchboard/unzipped/theme_polishpoint_{blue,forge,midnight,pink}_swatchboard.html` — the four canonical swatchboards are checked in for reference + re-runs of the converter.

## Open / suggested next pickup

1. **Confirm + deploy the re-home.** Verify the new midpoint prices in the live Stripe dashboard are intended before the next production deploy, then deploy. If `polishpointdev.com` is still attached to this Vercel project, set up the redirect → `saasassinsdev.com/polishpoint`.

2. **Demo concierge — go live + harden.** Activate the live LLM by setting `OPENAI_API_KEY` (server) + `VITE_ASSISTANT_BACKEND_URL=/api/assistant` (frontend) in the demo's Vercel env, then smoke-test `/api/assistant` (the `GET` health check + a POST). Then harden: durable rate limiting (Vercel KV / Upstash), optionally true token streaming, feed cart contents into the model context, and add prospect-question analytics. Also run the raster screenshot pass on a workstation where `preview_screenshot` works.

3. **Build the `--primary-hex` converter flag** (~30 min). Makes Scenario B (client gives only a hex color) a one-command operation:
   ```bash
   node app/scripts/swatchboard-to-theme.mjs <baseline-swatchboard> \
     --slug acme --primary-hex "#7C3AED" --name "Acme Corp"
   ```
   Currently Scenario B requires running the converter on a baseline swatchboard then hand-editing the brand-primary scale lines. Adopt this enhancement when re-skin volume justifies.

4. **Optional: drop swatchboard-compatibility aliases into `theme.css`** (~10 min). Adds `--sidebar-hover`, `--sidebar-active`, `--green/amber/red/blue/purple/slate-bg/text/border` trio aliases. Only worth it if you ever want to embed swatchboard preview HTML inside the shell (e.g., a Storybook-style page). Skipped this session because nothing breaks without it.

5. **First per-client clone** — use the SOP in `STYLING.md` to create the next client deployment. Pick the closest theme family, run the converter (or hand-edit per Scenario B), push to a new client repo under their GitHub org.

6. **Continue CORE roadmap** in `SHELL_ROADMAP.md` — pick up the next `[ ]` in CORE for the next session.

## Running the app

```bash
cd app
npm install              # first time
npm run dev              # http://localhost:5173 (or first free port)
```

`npm run dev` automatically runs the manifest prebuild step. `npm run build` does the same for production. The marketing demo uses `npm run dev:demo` / `build:demo` (mode `demo`, base `/polishpoint/`).

## Re-skin SOP (summary)

The full procedure lives in `app/src/STYLING.md` § "Re-skinning the shell — SOP". One-line summary:

```bash
node app/scripts/swatchboard-to-theme.mjs <swatchboard.html> --slug <client> --name "<Name>"
# paste BRAND, swap @import, drop logo, regen icons → ~10 min total
```

## Historical context (preserved)

- `app/src/store/persist.js` legacy migration functions have been genericized (no external brand or email-domain references); the pre-v37 hops are now inert version bumps that never run in fresh clones (which start at v38) or in the demo (which ignores localStorage).
