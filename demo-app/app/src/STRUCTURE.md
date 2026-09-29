# PolishPoint STRUCTURE — the structural design contract

> **Contract version 2.1.0** (this build; §13). This document owns every structural **number** and **skeleton** in a PolishPoint build. Colour is a separate, swappable layer; this file never specifies a colour value.
>
> **Companion artifacts:** the visual source of truth is `theme_polishpoint_swatchboard_v2.html` (open it, everything here is rendered and self-measured green). Colour/token *naming* is owned by the shell's `app/src/STYLING.md`. Interaction behaviour is owned by `UI_RULES.md`.
>
> **This file is portable.** Copy it verbatim into a client repo at `app/src/STRUCTURE.md`. It has no external links and no colour literals, so it stands alone.

---

## §0 · Purpose & precedence

The recurring failure mode in past builds: colour was tokenised but **structure was not**. Control heights, container padding, and gaps lived as per-class literals, so every surface drifted and every "polish pass" decayed. This contract fixes that by making structure a **fixed, measured, enforced** input — the same across every client — while colour stays a dropdown.

**Precedence on conflict:** the board (visual truth) > this file (numbers) > any restatement elsewhere. A value that disagrees between the board and this file is a defect to fix, not a judgement call.

**The three-layer split (zero duplication — a value lives in exactly one place):**

| Layer | Owns | File |
|---|---|---|
| **Structure** | every px/number, control anatomy, container skeletons, the build loop, the lint catalog | **this file** + the board |
| **Colour / token vocabulary** | token *names*, the three-bucket rule (token → alias → recipe), colour values per theme | `app/src/STYLING.md` + `[data-theme]` blocks |
| **Interaction** | behavioural rules (toasts, bulk-bar persistence, back-nav, etc.) | `UI_RULES.md` |

---

## §1 · Token tables

All structural tokens are **colour-independent** — identical in every theme. They live in `:root`. The mobile column is the single `@media (max-width: 639px)` override.

### Spacing — strict 4px grid
| Token | Value | | Token | Value |
|---|---|---|---|---|
| `--space-0` | 0 | | `--space-8` | 32 |
| `--space-1` | 4 | | `--space-9` | 36 |
| `--space-2` | 8 | | `--space-10` | 40 |
| `--space-3` | 12 | | `--space-11` | 44 |
| `--space-4` | 16 | | `--space-12` | 48 |
| `--space-5` | 20 | | `--space-16` | 64 |
| `--space-6` | 24 | | | |
| `--space-7` | 28 | | | |

Every spacing/size value in the system is a multiple of 4. The only sanctioned off-grid values are 1px/2px hairline borders and the type scale (see §3).

### Control heights — the single source every control derives from
| Token | Desktop | Mobile (<640) | Use |
|---|---|---|---|
| `--control-height-xs` | 28 | 28 | dense: table-cell inputs, pagers, icon-only |
| `--control-height-sm` | 32 | 32 | compact toolbars |
| `--control-height-md` | **36** | **40** | DEFAULT — buttons, inputs, selects, pickers, chips |
| `--control-height-lg` | 44 | 44 | large CTA · tap-target floor |

**The rule that kills toolbar drift:** buttons and inputs both set `height: var(--control-height-md)` with `box-sizing: border-box`. Inputs carry horizontal padding only. Font-size may differ freely — the box no longer depends on it.

### Gap ladder — the only gaps you reach for
| Alias | → | Value | Use |
|---|---|---|---|
| `--gap-inline` | `--space-2` | 8 | chips, icon+label, button clusters |
| `--gap-control` | `--space-3` | 12 | between controls; form-row / toolbar gaps |
| `--gap-card` | `--space-4` | 16 | stacked cards, form groups |
| `--gap-section` | `--space-6` | 24 | between page sections |

### Container padding
| Alias | → | Value | Applied to |
|---|---|---|---|
| `--card-pad-sm` | `--space-4` | 16 | stat tiles, dense cards, nested Blocks |
| `--card-pad` | `--space-5` | 20 | DEFAULT `.card` (Container tier) |
| `--card-pad-lg` | `--space-6` | 24 | roomy cards, modals |

### Radius
`--radius-sm` 4 · `--radius-md` 10 · `--radius-lg` 20 · `--radius-xl` 16 · `--radius-full` 9999.
Defaults: `--btn-radius` = md (10) · `--input-radius` = md (10) · `--card-radius` = lg (20) · `--badge-radius` = full.
md / lg are this build's base since 2.1.0 (the kit shipped 8 / 12). A client theme never re-points them: structure is the same in every build, and a client theme holds colours only (UI_RULES §121).
`--radius-control-alt` 6 is a documented "sharper/more professional" alternative (Stripe/Primer) — re-point `--btn-radius` to it as a brand call.

### Border widths & elevation
`--border-width-sm` 1 (default hairline — the hierarchy carrier) · `--border-width-md` 2 (focus, emphasis) · `--border-width-lg` 3 (left-accent rails ONLY, rare).
**Exactly one shadow tier:** `--shadow-overlay` (`0 12px 28px rgba(0,0,0,0.12)`), used only for modals/popovers/raised-hover. Flat surfaces carry a hairline, not a shadow.

### Focus ring
`--focus-ring-width` 2 · `--focus-ring-offset` 2 · `--focus-ring-color` (theme-tinted, ≥3:1 against adjacent surfaces — bump opacity on dark themes). Applied via `:focus-visible`.

### Type scale
| Token | px | Role | | Token | px | Role |
|---|---|---|---|---|---|---|
| `--font-size-2xs` | 10 | tile eyebrows | | `--font-size-lg` | 16 | body-lg, small heading |
| `--font-size-xs` | 11 | badges | | `--font-size-xl` | 20 | heading |
| `--font-size-xs2` | 12 | field labels, help | | `--font-size-2xl` | 24 | display-sm |
| `--font-size-sm` | 13 | button labels, table cells | | `--font-size-3xl` | 30 | display |
| `--font-size-md` | 14 | body default | | `--font-size-4xl` | 36 | display-lg |

Weights 400/500/600/700. Line-heights tight 1.2 / normal 1.5 / relaxed 1.6.
**Responsive type:** `--font-body-size` 14→16 mobile · `--font-input-size` 14→**16 on mobile (hard requirement — prevents iOS focus-zoom)** · headings step down one size <640 (`--h1-size` 30→24, `--h2-size` 24→20, `--h3-size` 20→16).

Default font pairing: **Inter (body) + Poppins (headings)**. Toggleable; a brand call.

---

## §2 · Control contract (per-control anatomy)

| Control | Height | Horizontal pad | Font | Notes |
|---|---|---|---|---|
| `.btn` (+roles) | md | `0 var(--space-4)` | sm/600 | roles: primary / secondary / success / gold / danger / outline / link. Two sizes: `.btn` (32) and `.btn-sm` (28, tables and dense clusters) only; `-xs` and `-lg` are retired (UI_RULES §115). On a grey surface a neutral action is `-secondary` (filled): `-outline` has no fill. |
| `.btn-icon` | xs (28) | — | lg (16) / 600 | an icon-only square, 40 on phones; `-ghost` / `-danger` / `-primary` looks. Its type sets a text glyph (+, −, ↑, ↓) at icon weight. The surface close `.modal-close` is the same size, round. UI_RULES §123. |
| `.input`, `.select` | md | `0 var(--space-3)` | input-font | `-sm`/`-lg`/`-xs`. Select adds right pad for caret. |
| `textarea.input` | auto | `var(--space-2) var(--space-3)` | input-font | **min-height** floors: `.textarea-sm` 64 (~2 rows), `.textarea-md` 112 (~4), `.textarea-lg` 208 (~8). min-height ≈ rows×21 + 16 pad + border, rounded up to a 4px step. Grows past the floor. |
| table-cell input | xs (28) | `0 var(--space-2)` | sm | dense; aligns with `.btn-sm` (28, this build's xs button tier) in the same row. |
| checkbox / radio | 16×16 box | — | md | 8px label gap. |
| `.seg` (segmented) | md/sm/lg | track `padding: 3px` | sm | **a pill in a padded track** — see §5 (UI_RULES §7). |
| `.chip` | sm (32) | `0 var(--space-3)` | sm/600 | any clickable pill; `.on` fills black. `.chip-sm` = xs (28), `0 var(--space-2)`, xs2, in rows and dense pickers; `.chip-danger` the alert filter. UI_RULES §124. |
| `.badge-trigger` | the badge's | 0 | — | a status badge that opens its menu (the customer status, a key's status). |
| `.menu-option` | auto (48 in a phone sheet) | `var(--space-2) var(--space-3)` | md | a menu row; `.on` tinted 600; `-danger`, `-action`. UI_RULES §127. |
| `.linklike` | inline | 0 | inherits | a link in running text; `-danger` red. It inherits through `:where(.linklike)`, so a row class or a type utility that sizes it wins. A text button is `.btn.btn-link` (32). UI_RULES §126. |
| `.add-tile` | min sm (32) | `var(--space-2) var(--space-3)` | sm/600 | the dashed add slot; its container sets width and height. UI_RULES §125. |
| `.badge` | inline | `var(--space-1) var(--space-2)` | xs/600 | pill; six semantic families. |
| `.page-btn` (pagination) | xs (28) | — | sm | square-ish. |
| `.avatar` | md (sm/lg) | — | sm | circle = control-height. |

Every clickable control is one of these kit controls or is classified in `app/design-system/controls.json` (UI_RULES §128); `test-control-ledger.mjs` fails a family that is neither.

**`--control-height-xs` (28) scoping rule:** dense contexts only — table-cell inputs, pagination, icon-only buttons. **Never place an xs control beside an md control in a toolbar.**

---

## §3 · Alignment contract (toolbars)

- **One size tier per row.** Don't mix md and sm controls in the same toolbar.
- Gap between controls = `--gap-control` (12).
- `.toolbar` → `align-items: center` (bare controls, single line).
- `.filter-bar` → `align-items: flex-end` (contains labelled facets: label-above-control columns and bare controls bottom-align to a shared baseline; with uniform heights, tops align too).
- Search input flexes (`flex: 1; min-width: 0`); trailing action buttons are fixed width.
- Because every control is height-locked, a toolbar's controls are flush by construction. The board's `uniform` check asserts max−min height < 1px.

---

## §4 · Container skeletons

Tier vocabulary (from `Role Vocabulary.md`): **Container / Block / Row / Tile.** The 10% tolerance rule applies — a new cardy thing within 10% of a tier's padding+radius snaps to that tier; more than 10% off is a Material Change.

```html
<!-- Container (.card) — pad 20, radius 20 -->
<div class="card">
  <div class="card-head"><h2 class="card-title">Title</h2><div class="card-actions">…</div></div>
  … body …
</div>
<!-- roomy: .card-lg (pad 24) · dense: .card-sm (pad 16) -->

<!-- Block — nested card inside a Container, pad 16, sunken -->
<div class="block"> … </div>

<!-- Tile — standalone stat, pad 16×20 -->
<div class="tile"><div class="tile-label">…</div><div class="tile-val">…</div><div class="tile-delta">…</div></div>

<!-- Row — min-height 44 (= lg control), bottom hairline -->
<div class="row-item"> avatar · meta · trailing action </div>

<!-- Table container -->
<div class="table-card"><table> th=36 · td=44 · cell pad 12×16 · .td-num right-aligns </table></div>

<!-- Modal (widths 400 / 560 / 720) -->
<div class="modal modal-md">
  <div class="modal-head"><h3 class="modal-title">…</h3> close </div>
  <div class="modal-body"> fields (gap --gap-card) </div>
  <div class="modal-foot"> Cancel · Save (gap --gap-inline) </div>
</div>
```

---

## §5 · Treatment rules

- **Flat doctrine.** Hairlines (`--border-width-sm`) carry hierarchy. No gradients, no glows, no neumorphic stacks. Exactly one shadow tier (`--shadow-overlay`), overlays only.
- **Segmented = a pill in a padded track (UI_RULES §7).** The track pads 3px (an `inset-bg` fill and a hairline) and rounds `--radius-full`; the active segment is a `--radius-full` pill inside it. General law: **inner-radius = outer-radius − inset**, which a full pill inside a full pill satisfies at any inset. Since 2.1.0 this build keeps the padded track; the kit's flush fill (inset 0) and its `seg-flush-fill` lint are retired (register CS-346).
- **State recipes.** hover = deeper brand or a 50-level tint · focus = `:focus-visible` 2px ring at 2px offset · disabled = 50% opacity, height unchanged, no colour shift.
- **Dark themes** flip only the colour layer; structure is byte-identical (proven by the board's forge/midnight audits).

**How flat is wired (the clone contract).** Flat is implemented as a shared **`src/theme-flat.css`** treatment layer, imported **last** in `index.css` (after `theme.css` = structure, and after the colour theme). It redefines every recipe token (`--btn-primary-grad`, `--card-shadow`, `--input-border-grad`, `--badge-*-grad`, glows, neumorphic stacks…) to a flat, **colour-token-driven** value, so it flattens *any* palette and re-skins automatically. On a new-app clone: `theme-flat.css` ships in the shell baseline → the clone is flat by default; the per-client colour theme (emitted by the swatchboard→theme generator) carries **colour only**; structure + treatment are constant. Only three things ever vary per client: colour tokens, content, and config. Recipe values point at theme-relative tokens, never a fixed colour (the flat layer resolves `--btn-primary-grad` to `var(--primary)` and `--input-border-grad` to `var(--card-border)`), so contrast holds in every palette and a re-skin needs no change here.

---

## §6 · Page scaffolds

```
LIST      page-head → .toolbar (search + select + primary btn) → optional persistent .bulk-bar → .table-card → optional .pagination
DETAIL    detail header → .grid-2 { main col: .card(s); side col: .tile(s) }  (sections inside a column: bare .section-head + content, no card wrapper)
SETTINGS  page-head-text → .card with .card-head(.card-title) + fields + primary btn
```

**Adding UI = copy the matching scaffold.** The gaps, control heights, and paddings come for free. Never improvise structure.

---

## §7 · Responsive & mobile contract

This shell ships as a PWA to field crews — mobile is structural, not cosmetic.

- **Breakpoints:** 640 (mobile→tablet) + 1024 (tablet→desktop). Mobile-first. 768 is opt-in only if a distinct tablet layout emerges.
- **Tap targets:** primary actions and interactive list rows target **44** (Apple HIG / WCAG 2.5.5 AAA). md controls bump 36→**40** on mobile — above the 24px WCAG 2.5.8 AA minimum — with ≥8px between adjacent targets.
- **Inputs use 16px font on mobile** (`--font-input-size` → `--font-size-lg`) to prevent iOS focus-zoom. Non-negotiable.
- **Per-component adaptation (<640):**
  - Tables → **card-stack** (each row a card of label:value pairs); horizontal-scroll + sticky-first-column fallback for data-heavy rows.
  - Toolbars → single-line **scrolling chips** + a full-width primary below; sticky with `top: var(--safe-top)`.
  - Modals → **bottom sheet** (drag handle, snap ~[50%, 90%]) for light tasks; **full-screen** for >4-field forms (fixed full-width footer CTA in the thumb zone).
  - Sidebar → hidden; **bottom tab bar** (3–5 items, 56–64px incl. safe-area) or drawer.
  - Card grids → 1 col <640 / 2 col to 1024 / `repeat(auto-fit, minmax(220px, 1fr))`.
  - Forms → labels stacked, controls 100% width, 16px font.
- **PWA tokens & rules:** `--safe-top/right/bottom/left` = `env(safe-area-inset-*)`; `viewport-fit=cover`; use `100vh` not `100dvh` (iOS PWA timing bugs); `overscroll-behavior-y: contain`; primary actions in the bottom thumb-zone.

---

## §8 · Dynamic-style policy

Inline `style` is permitted **only for geometry-of-data** — computed widths/percentages (progress bars, chart columns), drag positions, transforms. **Never** colours, control heights, radii, fonts, or spacing — those are tokens/classes. The design-lint (§10) distinguishes dynamic values (template literals, identifiers, ternaries, `%`, `var()`, `calc()`) from literal constants.

---

## §9 · The build loop (mandatory for any UI change)

1. **Draw down** — read §4/§6 for the surface's skeleton + §1 for the numbers. Copy the skeleton; never improvise structure.
2. **Build** — compose KIT classes + `var(--token)` only. No literal px/hex in JSX `style` or CSS.
3. **Re-check (mechanical)** — `npm run lint:design` → zero NEW violations. A genuinely dynamic value gets `/* design:allow <rule> — reason */`. The baseline only ratchets down.
4. **Re-check (visual)** — open the app; confirm the touched surface's control rows are flush (heights = `--control-height-*`), card padding = `--card-pad`, section gaps = `--gap-section`. Compare against the board.
5. **Re-check (contract)** — for kit changes, the board's §27 self-test stays green at both desktop and <640 widths.
6. **Fix and repeat** until all three are green. **Done = mechanical + visual + contract green.**

---

## §10 · Design-lint rule catalog (portable)

Materialized per-repo as `app/scripts/design-lint.mjs` (zero-dependency Node; baseline ratchet in `app/design-lint.baseline.json`; escape hatch `/* design:allow <id> — reason */` on the same or next line).

**Implemented in v2.0.0** (error-level, reliably lexically-detectable): `no-raw-hex`, `no-raw-px`, `no-inline-px`, `off-grid`, `scaffold-inline` — the five that gate today (`seg-flush-fill` was retired in 2.1.0, and `shadow-tier` has since shipped as an error in this build's flat-treatment extension — 4c813e7). The other rows below are the **roadmap**: several are heuristic/warn-level (they risk false positives) and land as the enforcer matures; until then they live in the §9 visual checkpoint + review, not the script. The catalog is listed in full so the intent is on record.

| ID | Severity | Detects |
|---|---|---|
| `no-raw-hex` | error | hex / `rgb(`/`hsl(` colour literal in JSX or component CSS (incl. inline-fallback `var(--x, #hex)`). Exempt: `rgba(var(--…-rgb), α)`, embedded SVG data-URI icons. |
| `no-raw-px` | error | raw px on spacing/height/font-size properties in CSS outside token files. Width/max-width family exempt (layout, not rhythm). |
| `no-inline-px` | error | literal px/number spacing in JSX `style={{}}`; dynamic values (`${}`, identifiers, ternaries, `%`, `var()`, `calc()`) pass. `th/td/col` width exempt. |
| `off-grid` | error | px value not a multiple of 4 (excluding 1–2px borders and the type scale) on spacing/size props. |
| `height-via-token` | error | a control selector (button/input/select/seg…) that sets `height`/`min-height` with a literal instead of `--control-height-*`. |
| `gap-from-ladder` | warn | a `gap`/`margin` on a layout element that isn't a gap-ladder alias. |
| `radius-from-scale` | warn | `border-radius` literal instead of a `--radius-*` / role alias. |
| `shadow-tier` | error | a `box-shadow` that reads a `--shadow-*` tier other than `--shadow-overlay` on a floating surface. |
| `focus-ring-required` | warn | an interactive selector with no `:focus-visible` ring. |
| `seg-flush-fill` | retired | Retired in 2.1.0: this build pads segmented tracks 3px (UI_RULES §7), so a rule that required padding 0 no longer holds. |
| `scaffold-inline` | error | a `style` attribute on an element whose className is a scaffold class (`page-head`, `filter-bar`, `card`, `form-row`, `section-head`…). |
| `input-font-16-mobile` | warn | a mobile input rule with font-size < 16. |
| `tap-target-44` | warn | a primary/row interactive target below 44 on mobile. |

**Baseline ratchet:** per-file per-rule counts. `current > baseline` for any cell = FAIL. `--update-baseline` refuses to raise any cell (down only). Existing debt is frozen; new debt is blocked. Wire into a git pre-push hook (push = the deploy gate); never gate `vite build` (keep the hotfix path open).

---

## §11 · Ownership & cross-references

- **This file** owns numbers, skeletons, the loop, the lint catalog. A number appears here and nowhere else.
- **`STYLING.md`** (shell repo) owns colour/token *names*, the three-bucket rule, the alias whitelist. It points here for structural numbers rather than restating them.
- **`Role Vocabulary.md`** (vault) owns the Container/Block/Row/Tile tier definitions + the 10% rule.
- **`Token Schema.md`** (vault) owns the token *category* registry.
- **The board** (`theme_polishpoint_swatchboard_v2.html`) is the visual truth; this file is its machine/copy mirror. They are stamped with the same contract version.

---

## §12 · Provenance (why these numbers)

Benchmarked against the 2025–26 flat-B2B mainstream:

| System | md control | body | card radius | shadow tiers |
|---|---|---|---|---|
| shadcn/ui · Radix Themes | ~36 | 14 | 8–12 | 1–2 |
| GitHub Primer | 32 | 14 | 6 | 1 |
| Shopify Polaris | ~36 | 14 | 12 | 1–2 |
| IBM Carbon | 40 | 14 | 2 | 2–3 |
| Stripe | ~36 | 13–14 | 4–8 | 1 |
| Apple HIG | 44 (touch) | 16 | 12 | 1–2 |

Our defaults — **36 md control, strict 4px grid, one overlay shadow, 2/2 focus ring, 13–14 body** — sit squarely with Stripe / Linear / Radix. Calibrations from the benchmark: "sm" is 32 (28 became the dense/xs tier); section gap is 24 (2026 "generous whitespace"). Sources: shadcn/ui, Radix Primitives, GitHub Primer, Shopify Polaris, IBM Carbon, Stripe, Apple HIG, Material 3, Linear (public design references).

---

## §13 · Changelog

- **2.1.0 · 2026-09-24** — This build, on the owner's decision (register CS-346): `--radius-md` / `--radius-lg` are 10 / 20 in the base (`theme.css`), no longer re-pointed by the client theme; segmented tracks pad 3px (UI_RULES §7) and `seg-flush-fill` is retired; a client theme holds colours only (UI_RULES §121, held by `test-color-ledger.mjs`). A proven visual no-op: every token resolves as before, and `style-snapshot` found 82 pages × 31,215 elements identical.
- **2.0.0 · 2026-07-05** — Initial structural contract. Structural token family (control heights, gap ladder, card pads, border widths, `--font-size-xs2`, `--shadow-overlay`, focus ring); flat treatment as default; fully-filled-pill segmented rule; tier spec re-bind; full mobile/PWA contract; design-lint catalog. Mirrors `theme_polishpoint_swatchboard_v2.html` v2.0.0. Logged in the vault `Decisions/2026-07-05.md`.
