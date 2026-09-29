# THEME_CLEANSPACE — the CleanSpace color & contrast law

> **This is the client-specific COLOR + CONTRAST law for the CleanSpace build.** It is the "master styling doc" that governs how this app *looks* — the through-app rules that keep every surface sharp and consistent. It is **tracked in git** (committed like `CLAUDE.md` / `UI_RULES.md`; only `mockups/` and build output are gitignored) and it is the doc [`BUILD_INTEGRITY.md`](../../BUILD_INTEGRITY.md) reaches for when it says "brand".
>
> **It complements, never duplicates, the two portable docs:**
> - [`STYLING.md`](./STYLING.md) owns the **token vocabulary** (names, the three-bucket rule, the alias whitelist). Shell-generic.
> - [`STRUCTURE.md`](./STRUCTURE.md) owns every **structural number** (control heights, spacing, radii). Shell-generic. **Nothing here changes a single number** — this is color/contrast only.
> - **This file** owns the **per-client color decisions + the contrast rules that apply throughout the app.** CleanSpace-specific.
>
> **Precedence on conflict:** a *number* → STRUCTURE.md. A *token name* → STYLING.md. A *color value or contrast rule* → this file.

---

## §0 · The direction: **Ink** — ground: **Cool Slate**

> 🔵 **2026-09-13 — the page GROUND moved from warm sand to COOL SLATE.** The warm mid-tone ground (`#E6E0D2`) made the surface layers smear together — worst on Pipeline, where the columns barely separated from the page. The ground is now a cool neutral gray (**L1 `#F4F5F7`** · L0 well `#E8EBEF` · border `#E4E7EB` · cool zebra `#F5F7F9`), keeping the black header bands, gold accents, and white cards. "Ink" still names the *treatment* (black frames, gold marks, white cards, the surface ladder); only the ground hue changed. Picked from a second `/mockup` ground study. Token tables in §1 and R6 are current; the retired warm values are noted inline.

Chosen from the `/mockup` color-direction study (2026-09-12). The problem it fixes: page and cards were the same warm off-white (`#F1EFEB`), table rows differed by ~2% luminance, and borders were a near-invisible warm hairline — the whole app read as one flat wash of "wireframe boxes."

**Ink** keeps the brand (near-black `#18181B` + gold `#FFD45A`) and the warm identity, but earns contrast three ways:

1. **White cards on a deeper-warm page** — surfaces separate by *elevation*, no shadow (flat doctrine holds).
2. **Black header bands frame every block of data** — the signature move. Table `<th>` rows are solid black with light labels; the black *is* the frame.
3. **Gold marks what's live** — hover, active/selected, sort caret. Navy for links. Black for headings, primary buttons, nav-active.

> The warm page (deeper, not cream, not cool slate) preserves the 2026-08-16 "off cream, onto warm gray" call. Ink did **not** flip the app cool — it added elevation + black framing on top of the warm ground.

---

## §1 · Token overrides (what Ink actually sets)

All values live in the theme layer only ([`theme.css`](./theme.css) defaults → [`theme-cleanspace.css`](./theme-cleanspace.css) color → [`theme-flat.css`](./theme-flat.css) treatment, imported **last**, wins). Component CSS never carries a hex — it reads these tokens. The brand-derived values (the three ramps, the page and well, the hairline, the field, the zebra, the link, the upcoming card) sit in `theme-cleanspace.css`'s BRAND PALETTE block, which `npm --prefix app run brand` writes from `brands/cleanspace/brand.json`, where every one of them is pinned (UI_RULES §121). Change them there, then run `brand`: a hand edit to the block fails `brand --check`.

| Token | Value | Role |
|---|---|---|
| `--color-surface-offwhite` → `--color-surface-base` | `#F4F5F7` | **L1** page ground (cool light gray — was warm `#E6E0D2`) |
| `--color-surface-raised` | `#FFFFFF` | **L2** cards / tables / modals — white (pops off the page) |
| `--color-surface-sunken` | `#E8EBEF` | **L0** recessed — wells + row-card containers; a clear step below the page so white surfaces pop |
| `--color-surface-overlay` | `#ffffff` | modals stay crisp white |
| `--table-header-bg` | `--color-brand-primary-500` (`#18181B`) | **black header band** |
| `--table-header-fg` *(new token)* | `--color-text-on-primary` (`#fff`) | light label on the black band |
| `--table-row-even` | `#FFFFFF` | white row |
| `--table-row-odd` | `#F5F7F9` | cool zebra tint |
| `--table-row-hover` | `rgba(--color-brand-secondary-rgb, .18)` | gold hover |
| `--card-border` | `#E4E7EB` | cool hairline — card / table / field edges |

**`--table-header-fg` is the one new token this direction introduced.** It exists because `th` text was hardcoded to `--text-muted` (dark) — invisible on a black band. It defaults to `--text-muted` in `theme.css` (light-header shells) and is themed to `--color-text-on-primary` here. Consumers: `table th` and `.month-head` in [`index.css`](./index.css) (the calendar header shares the band).

---

## §2 · The rules that apply throughout

These are **law for every surface**, not table-only. New UI conforms on the first pass.

### R1 — Surfaces separate by elevation
Page = warm `--color-surface-base`. Anything that holds content (card, table, tile, modal) = `--color-surface-raised` (white). Recessed wells inside a card = `--color-surface-sunken`. **Never** paint a card the same color as the page.

### R2 — Data blocks wear a black header band
Any header row that labels a block of data — table `<th>`, the month-calendar head — is `--table-header-bg` (black) with `--table-header-fg` (light), uppercase, `--font-size-xs`. The band is the frame; it needs no heavy border under it. Rows below: white with a warm zebra (`--table-row-odd`), **gold** hover, black body text.

### R3 — Black frames, gold marks, navy links — semantics stay put
- **Black** (`--primary`, `#18181B`): headings, primary buttons, nav-active fill, header bands.
- **Gold** (`--color-brand-secondary-500`, `#FFD45A`): the gold **CTA** buttons (`.btn-gold` / `.btn-success` — both gold), hover, the active/selected marker, sort caret. **"Gold buttons" = the brand-*secondary* CTA; the `.btn-secondary` *class* is the NEUTRAL white button, not gold.** Gold fills pair with **dark** text (gold is light), and gold is never text on a light ground: its darkest step reads under 3:1 on white or a gold tint. On a gold fill the text is the ink; an action set apart in a list takes the link colour. test-brand.mjs checks every rule that paints text in a gold step against its ground, under every brand pack (CS-395).
- **Navy** (`--color-link`, `#283CA1`): tappable names + links.
- **Semantic status colors are CONSTANT and never restyled by a theme:** success green `#059669`, warning amber `#B45309`, error red `#B91C1C`, neutral slate `#64748B`. They mean the same thing on every screen; map them through the domain helpers (e.g. `flagBadgeVariant()`), never by hand at a call site. See [`STYLING.md` §Semantic Badge mappings](./STYLING.md).

### R4 — Repeated controls of one kind share an alignment axis  ⟵ *build rule*
> The rule caught in review 2026-09-12: a "Reschedule" button placed inline after a status badge starts at a different x in every row (badge widths differ) — ragged and sloppy.

- **A row-level action lives in its own dedicated trailing column** — never inline after variable-width content (a badge, a status, wrapping text). Give the column a fixed/consistent width and right-align its control, so every action of that kind forms one clean vertical line down the table. A row with no action leaves the cell empty; the column still reserves its width.
- **One control size-tier per toolbar row** (height-locked — see [`STRUCTURE.md` §3](./STRUCTURE.md)); the tops/bottoms align by construction.
- **Button clusters** (modal footers, form actions) align on a shared baseline; primary-right, secondary-left, consistent every time.
- **The table must be adjusted to obey this** — if a status/action shares a cell, split it into its own column. This is a correctness rule, not a preference: candidate for a `lint:align` check once the pattern is swept clean.

### R5 — Contrast floor
Body text on white ≥ WCAG AA (7:1 here, `--text-body` on white). A brand pack's palette is held to this law by its 22 contrast checks (`scripts/brand-colors.mjs`: `npm --prefix app run brand` refuses a failing palette, and test-brand.mjs runs them on every pack). Muted text is for de-emphasis, never for anything a user must read to act. Hairlines (`--card-border`) must be visible against both the page and white cards — if a border disappears, bump it one step, don't delete it.

**Native controls:** `.input`/`.select` are pinned to `color-scheme: light` and `<select>` options are forced to `--card-bg` / `--text-primary`. A styled (`appearance:none`) select leaves its option-popup **background-color** unset, so some browsers/OS render the popup dark while the option text stays dark → **black-on-black** (the Date-range bug, fixed 2026-09-12). Verified app-wide with a runtime WCAG contrast sweep (8 pages + a modal) — no text below ~3:1 except intentional de-emphasis (e.g. the dashboard goal "/ N" denominators at 2.56).

### R6 — No same-on-same nesting (per-surface contrast)  ⟵ *build rule*
> The wireframe bug (caught 2026-09-12): a surface sitting on a parent of the SAME fill, separated by only a faint hairline or nothing — white row-cards in a white container, a white section in a white modal. It reads as empty outlined boxes. **NOTHING may blend into its parent.**

**The surface LADDER — three tones, deliberately spread so adjacent levels never blend:**

| Level | Token | Value | Where |
|---|---|---|---|
| **L0** recessed | `--color-surface-sunken` (`--inset-bg`) | `#E8EBEF` | wells / insets inside a card; the **container that holds row-cards** (e.g. the timeline, Pipeline columns) |
| **L1** page | `--color-surface-base` (`--page-bg`) | `#F4F5F7` | the app background |
| **L2** raised | `--color-surface-raised` / `-overlay` (`--card-bg`) | `#FFFFFF` | cards, tables, **modals**, row-cards |

Rules:
- **A surface never sits on a parent of the same level** — step by ≥1 level. A card (L2) on the page (L1) pops; a container that holds white row-cards is **L0**; a nested block/well inside a card drops to **L0**.
- **A modal is L2 (white).** Anything inside it that would be white-on-white — a preview pane, a nested card, a summary well, a scrollable list — drops to **L0** (or carries a `--card-border` hairline if it must stay white). **Every modal declares its internal surfaces in the map below.**
- **Row-card lists** (timeline, agenda, etc.): container = L0, rows = L2, plus a **status colour rail** (R3 semantics) as an extra anchor.
- Where a level-step is impossible, a visible `--card-border` (`#E4E7EB`) hairline is **mandatory** — a hairline is the minimum separation, never zero.

**Per-surface / per-modal contrast map** (from the same-on-same deep-dive — *audit in progress, table populating*):

| Surface / modal | Same-on-same risk | Treatment |
|---|---|---|
| Day-view timeline | white rows in a white container | ✅ superseded by **R7** — white container + status-tinted rows |
| Modal list surfaces (Stage / Pipeline / Orphaned-threads / New-DM / New-internal-thread pickers) | white row-cards split by the near-invisible `--border-light` | step the list container to L0 `--inset-bg` (or bump dividers to `--card-border`) — *fix pending* |
| CSV import preview (`.csv-preview-table`) | undefined `--bg-soft` → the sticky header fell back to WHITE under the global `table th`'s white label (white-on-white, headers unreadable); the duplicate-row rule styled a class the modal no longer emits | ✅ fixed 2026-09-24 (UI_RULES §119) — the `th` inherits the black header band; the dead `.csv-row-ok` / `.csv-row-duplicate` rules deleted (rows are `csv-row-{create,update,skip,invalid}`); the dropzone keeps white + its dashed `--card-border` hairline (an L0 fill would swallow the dashes) |
| Integrations webhook chip + DKIM card; ConversationMessagePanel | undefined `--surface-muted` → near-white on white | ✅ fixed 2026-09-24 — L0 `--inset-bg` (no new name) |

Everything else audited (CRM/billing, forms/settings, dashboard, detail pages, messaging, drafts, dropdowns, tabs) is clean — surfaces sit on the transparent page and pop as white, or already step to L0 / carry a `--card-border`.

---

### R7 — The schedule (cardinal rule)  ⟵ *build rule*
The schedule is the reference surface; its pattern is fixed:
- **Container = WHITE** (`--card-bg`) on the warm page.
- **Row-cards are tinted BY STATUS** (soft `-50` fills), never white — they pop off the white container by *fill*: `--sched-card-{done,prog,miss,upcoming}-bg`, each with its matching `--sched-card-*-bd` hairline.
- **Constant status accent on every row** — a 4px left **rail** + timeline **dot** in the semantic colour (green / amber / red / gold), plus the solid status **badge**.
- **Row action** (Reschedule) is right-aligned per R4.
- **Segmented view-switcher rail** (Day / Week / Month / …): **white track, black active selector** (`.tab-container-line`). This is the segmented-rail rule.

Wired: `.tl-day-card` / `.tl-card` / `.tl-dot` / `.tab-container-line` (`index.css`) + `--sched-card-*` tokens (`theme-cleanspace.css`). *Applied to the Day view; extend to Agenda / Week / Month next.*

### R8 — Detail-page mobile format  ⟵ *build rule*
Detail pages (and any KPI/stat surface) adapt to phone widths — never a squeezed desktop layout:
- **KPI / stat-card grids auto-fit**, never a fixed column count: `grid-template-columns: repeat(auto-fit, minmax(150px, 1fr))`. Collapses to 1 col at ~320, 2 at ~375, up on desktop — values never clip. (`.overview-kpis`, `.stat-grid` in `index.css`.) A hard `repeat(2,1fr)` at 640 was clipping `$3,080.00` at 320 — the bug this rule retires.
- **`min-width: 0` on every grid/flex child** that holds a value or long text — the anti-clip guardrail (an unbreakable string like a currency value otherwise overflows and gets clipped inside an `overflow:hidden` card).
- **Section tabs are a scrolling-chip rail** — one line, `overflow-x:auto`, scrollbar hidden, a right-edge mask fade cueing "more →" (`.section-tabs`). Never a fixed row that clips the last tab.

Verify on the contact sheet (`npm run shots`) at 320/375; an intended `.section-tabs` horizontal scroll is fine (it's a scroll, not page overflow — the fit-sweep reports it, doesn't fail it).

### R9 — Mobile filters, selectors & clusters  ⟵ *build rule*
On phones (≤640) the filter/selector controls change *form*, they don't just shrink:
- **Filter bars collapse to a "Filters (N)" button + bottom-sheet** (`MobileSheet` + `FilterBar`). The page content stays visible; facets live in the sheet with Clear-all / Show-results. Fixes every FilterBar page (Schedule, Variance, Keys, Invoices, Inspections, Clients) at once.
- **`MobileSheet` is the ONE mobile picker surface** — a bottom sheet (drag grip, backdrop + Escape dismiss). Mobile pickers open here, never as anchored popovers spilling off their trigger.
- **Selection clusters are single-row scrolling-chip rails** — segmented view-switchers, period pills, tab rows: `overflow-x:auto`, scrollbar hidden, right-edge fade (`.tab-container-line`, `.section-tabs`). Never a fixed row that wraps or clips.
- **Toolbars fit the viewport** — the schedule date-nav stacks (title row, then `‹ Today ›` centered) so no control clips.

Wired: `components/MobileSheet.jsx`, `components/filters/FilterBar.jsx`, the `@media (max-width:640px)` schedule block + `.sheet*` / `.filter-bar-mobile` in `index.css`. *In progress: per-facet bottom-sheet select pickers + fully unified cluster styling; then the per-page fan-out across all 34 routes.*

---

## §3 · Where it's wired

| File | Owns |
|---|---|
| [`theme.css`](./theme.css) | shell defaults incl. the `--table-header-fg` fallback |
| [`theme-cleanspace.css`](./theme-cleanspace.css) | **the color values** in §1 (surfaces, table, brand, semantic) |
| [`theme-flat.css`](./theme-flat.css) | treatment; sets the winning `--table-header-bg`/`-fg` (imported last). Composes from brand tokens, so it re-skins per palette. |
| [`index.css`](./index.css) | component CSS — reads tokens only. Touched here: `table th` + `.month-head` text → `--table-header-fg`. |

**Clone note:** the color values are CleanSpace-specific. The black-header treatment sits in `theme-flat.css` (the portable layer) but is expressed through brand tokens (`--color-brand-primary-500` / `--color-text-on-primary`), so a future clone with a different palette gets a header band in *its* brand, not CleanSpace black. Only the values in `theme-cleanspace.css` carry per-client identity.

---

## §4 · Enforcement & verification

Ink is token-centered, so it propagates to every tokenized surface at once — but "propagates" is not "verified." Every styling change climbs the ladder ([`BUILD_INTEGRITY.md` §6a](../../BUILD_INTEGRITY.md)):

```bash
npm --prefix app run lint:design      # no-raw-hex is BLOCKING — a component hex that dodges the theme fails here
npm --prefix app run build            # it compiles
npm --prefix app run lint:responsive  # the 5-viewport sweep (mobile stacks, iPad seam)
```
Then **drive the real app** (dev server on 5213) and walk the surfaces that changed — tables across pages, the calendar, cards, tiles — screenshots as proof. A green lint is weak evidence for render behavior.

**Alignment audit (R4) — DONE 2026-09-12** (subagent fan-out, 3 agents): swept ~35 tables + list/timeline surfaces across CRM/billing, forms/settings, and ops/field. Exactly ONE violation — the Schedule Day-view "Reschedule" button shared `.tl-card-meta` with the status badges, so a past-due upcoming job rendered `[Missed][Reschedule]` inline and badges went ragged across rows. Fixed by moving the action into its own reserved `.tl-card-action` trailing slot ([Schedule.jsx](./pages/Schedule.jsx) + `.tl-card-action` in [index.css](./index.css)); verified by measurement — all badge right-edges align on one axis, all Reschedule button right-edges on another. Every other table already used the dedicated-trailing-column pattern.

**Open follow-ups (not done):**
- **`.cell-actions` desktop rule + a `lint:align` check:** trailing action columns currently align by native table-sizing + per-cell right-align, not a shared enforced rule; two cells use bare `.text-right`/inline (Tags, ContactDocuments). A shared rule + lint would make R4 mechanically enforced. Care needed: `.cell-actions` is also used for a *left-aligned label* column in ClientDetail, so a blanket `text-align:right` would disturb it.
- **Ink flourishes (secondary):** 3px black top-accent on stat tiles; gold left-rail on selected/active rows (no generic row-selection hook exists yet — add with the component that needs it).
- **Pre-existing `lint:design` red:** baseline drift from the drafts/sandbox commits (untouched by this change) needs its own cleanup pass.

---

## §5 · Changelog
- **2026-09-12** — Created. Ink direction chosen from the `/mockup` color study; core tokens applied (white cards on deeper-warm page, black table-header bands via new `--table-header-fg`, warm zebra + gold hover). R4 control-alignment rule added from review, then swept app-wide via a 3-agent audit — one violation found & fixed (Schedule Day-view action column). Supersedes the never-created `CLEANSPACE_BRAND.md` referenced by `BUILD_INTEGRITY.md`.
- **2026-09-12 (later)** — Widened the surface ladder (L0 `#D7CFBD` / L1 `#E6E0D2` / L2 white) after same-on-same review; added **R6** (no same-on-same, with a per-modal map from a 3-agent deep-dive) and **R7** (the schedule cardinal rule: white container + status-tinted row-cards + segmented rail = white track / black selector). R7 applied to the Day view; the R6 modal fixes are pending.
- **2026-09-13** — **Ground switched from warm sand to COOL SLATE** (L1 `#F4F5F7` / L0 well `#E8EBEF` / border `#E4E7EB` / cool zebra `#F5F7F9`, field fill `#EEF1F5`, messaging bubble `#EEF1F5`). The warm mid-tone ground read muddy — every non-white layer competed in a narrow warm band (Pipeline was the worst case, its columns also on a barely-there 4%-black tint → moved onto the real `--inset-bg` well + `--card-border`). Black header bands, gold accents, and white cards are unchanged. Picked from a second `/mockup` ground study; verified live on Pipeline, Invoices (stat cards / AR-aging cells), and the Customers table.
- **2026-09-24** — **Field focus ring restored + every `var()` defined** (UI_RULES §119). `--focus-ring-width` / `--focus-ring-offset` (2px, STRUCTURE §1) are `theme.css` tokens and `--focus-ring-color` an alias (shell default brand-500); CleanSpace re-tints it to brand ink at 60% in RECIPES — ≥4.37:1 on white / field fill / page / L0 well / zebra / gold hover, 3.82:1 against the ink border it wraps. None were defined after the clone, so every field focused with no ring. The same sweep fixed 19 more undefined reads (incl. the two R6 rows above and the unfilled DemoBackendsBanner); `test-css-vars-defined.mjs` + `test-focus-ring-contrast.mjs` gate both in CI.
