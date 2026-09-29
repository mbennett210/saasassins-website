# Shell Styling — Token Vocabulary & Rules

> The shell is themeable. Every color, size, shadow, radius, and motion value in this app resolves to a named token — never a literal. A customer theme is just a different set of token *values*; the shell's component code never changes when we re-skin it.
>
> ⚠️ **This build = CleanSpace (black + gold, flat).** The example values below are the shell's **generic seed** (e.g. a blue `--color-brand-primary-500: #1E8FE8`) — illustrative, NOT what renders. The live CleanSpace theme overrides brand-primary to **black `#18181B`**, adds a gold secondary **`#FFD45A`**, and applies a **flat** treatment (no gradients / glows). For the actual rendered values see [`theme-cleanspace.css`](./theme-cleanspace.css) + [`THEME_CLEANSPACE.md`](./THEME_CLEANSPACE.md); for button / interaction rules (incl. the **no-green-buttons** law) see [`UI_RULES.md`](../../UI_RULES.md) §11.

---

## North Star

1. **The shell's styling vocabulary is canonical and matches the Swatchboard.** When the Swatchboard emits `tokens.css` in Phase 1, dropping it into the shell should "just work" with no mapping layer.
2. **Themes change values, never names.** A contributor adding a new component picks from the existing token names. They don't invent new ones. A genuinely new token goes through the Swatchboard's Material Change Protocol first.
3. **Three buckets, three rules.** Every styling value in the shell is either a *token*, an *alias*, or a *recipe*. Know the bucket before you write it.

---

## The Three-Bucket Rule

### Token — canonical primitive
Lowest-level raw value. Comes from the Swatchboard (or matches its spec).

```css
--color-brand-primary-500: #1E8FE8;
--radius-md: 10px;
--space-4: 16px;
--font-size-md: 14px;
```

**Rule:** never invent a new token name in the shell. Propose it via the Swatchboard Material Change Protocol.

### Alias — a semantic role pointing at a token
Thin pass-through that lets component CSS read semantically. Only used for shell-wide role concepts.

```css
--card-bg: var(--color-surface-raised);
--btn-radius: var(--radius-md);
--color-avatar-1: var(--color-brand-primary-500);
```

**Rules:**
- Aliases live at the top of `theme.css` only. Never define an alias inside a component's CSS.
- Every alias resolves to a `var(--token)` reference. Never to a literal.

### Recipe — a composition of tokens into a visual effect
Gradients, layered shadows, glow stacks, multi-layer backgrounds. These are theme-specific compositions.

```css
--btn-primary-grad: linear-gradient(135deg, var(--color-brand-primary-400), var(--color-brand-primary-600));
--card-shadow-primary:
  inset 0 1px 0 rgba(var(--color-white-rgb), 0.9),
  inset 0 0 0 1px rgba(var(--color-brand-primary-rgb), 0.18),
  0 4px 14px rgba(var(--color-brand-primary-rgb), 0.12);
```

**Rules:**
- Every value inside a recipe is either a `var(--token)` reference or an allowed literal (transforms like `translateY(1px)`, easings like `ease-out`, display modes, `transparent`). **Never hex, px, or raw rgb tuples**, not even for shadow black: compose `rgba(var(--color-black-rgb), X)` (UI_RULES §121; `test-color-ledger.mjs` fails a colour baked into a recipe).
- Recipes live in the `RECIPES` section of their theme file. They will migrate to `element_variants.recipe` JSONB rows in Swatchboard Phase 2.

---

## Naming Convention

All CSS variables: `--{category}-{role}-{step}` with dashes only.

| Pattern | Example |
|---|---|
| `--color-{family}-{step}` | `--color-brand-primary-500`, `--color-neutral-300` |
| `--color-{role}-{variant}` | `--color-text-muted`, `--color-surface-raised`, `--color-border-default` |
| `--radius-{step}` | `--radius-md` |
| `--shadow-{step}` | `--shadow-md` |
| `--space-{n}` | `--space-4` (16px on a 4px grid) |
| `--font-{property}-{step}` | `--font-size-md`, `--font-weight-semibold`, `--line-height-tight` |
| `--duration-{step}` | `--duration-base` |
| `--ease-{curve}` | `--ease-out` |
| `--z-{layer}` | `--z-modal` |
| `--breakpoint-{step}` | `--breakpoint-md` |

No dots, no camelCase, no abbreviations. The Swatchboard stores names with dots (e.g. `color.surface.raised`); the emitted CSS file translates them to dashes (`--color-surface-raised`).

---

## Canonical Vocabulary

### Color — brand
```
--color-brand-primary-{50, 100, 400, 500, 600, 700}
--color-brand-secondary-{50, 100, 400, 500, 600, 700}    (optional — use when theme has a second brand color)
```
Plus RGB triplets for alpha compositing in recipes:
```
--color-brand-primary-rgb
--color-brand-primary-400-rgb
--color-brand-primary-600-rgb
```

### Color — neutral scale
```
--color-neutral-{50, 100, 200, 300, 400, 500, 600, 700, 800, 900}
--color-neutral-rgb    (alpha compositing — defaults to 500)
```
Default values match the Swatchboard seed (Tailwind `neutral`). Themes may override with a tonally-shifted scale (e.g. `slate`) when stylistically motivated.

### Color — surface
```
--color-surface-base        (page / app background)
--color-surface-raised      (card / elevated surface)
--color-surface-sunken      (inset / recessed surface)
--color-surface-overlay     (modal / backdrop surface)
```

### Color — text
```
--color-text-primary        (headings, dominant text)
--color-text-body           (body copy)
--color-text-muted          (secondary, captions)
--color-text-faint          (disabled, placeholder)
--color-text-on-primary     (text rendered over --color-brand-primary-500)
```

### Color — border
```
--color-border-subtle       (hairlines inside cards)
--color-border-default      (card edge, input edge)
--color-border-strong       (emphasized divider, focus ring base)
```

### Color — semantic
```
--color-semantic-success-{50, 200, 400, 500, 600, 700}
--color-semantic-warning-{50, 200, 400, 500, 600, 700}
--color-semantic-error-{50, 200, 400, 500, 600, 700}
--color-semantic-info-{50, 200, 400, 500, 600, 700}        (optional)
```
Plus `--color-semantic-{success|warning|error}-rgb` for alpha compositing.

### Color — accent (shell extension)
```
--color-accent-purple-{50, 200, 400, 500, 600}
--color-accent-orange-{50, 200, 400, 500, 600}
--color-accent-teal-{50, 200, 400, 500, 600}
```
**Status:** extension beyond the Swatchboard's Layer 1 spec. Flagged for promotion via Material Change Protocol. Use sparingly — only when brand/semantic don't fit (e.g. per-cell metric-strip tints).

### Base primitives
```
--color-white-rgb           255, 255, 255
--color-black-rgb           0, 0, 0
```
RGB triplets for alpha compositing of pure white/black (highlights, shadows).

### Radius
```
--radius-none       0
--radius-sm         4px
--radius-md         10px      (buttons, inputs)
--radius-lg         20px      (cards)
--radius-xl         16px
--radius-full       9999px    (pills, badges, avatars)
```
Structure is the same in every build: a client theme sets colours only (UI_RULES §121), so radii live in `theme.css` (md / lg 10 / 20 since STRUCTURE 2.1.0).

### Shadow (primitives)
```
--shadow-sm         subtle lift (hover hints)
--shadow-md         card elevation
--shadow-lg         modal, popover elevation
--shadow-inset      recessed feel
```
The flat treatment uses one of them: component CSS reads only the alias `--shadow-overlay` (the `--shadow-lg` step) for anything floating; design-lint's `shadow-tier` fails any other `--shadow-*` read (UI_RULES §40, register CS-344).
Complex compositions (neumorphic stacks, colored glows, inset+outer combos) are **recipes**, not tokens.

### Focus ring
```
--focus-ring-width    2px    ring thickness (numbers owned by STRUCTURE.md §1)
--focus-ring-offset   2px    gap before an outline-style :focus-visible ring
--focus-ring-color           ALIAS (see below): theme-tinted, ≥3:1 on every surface a field sits on
```
Composed by the `--input-focus-shadow` recipe (`0 0 0 var(--focus-ring-width) var(--focus-ring-color)`), the ONE text-field focus ring (UI_RULES §119).

### Spacing (4px grid)
```
--space-0     0
--space-1     4px
--space-2     8px
--space-3     12px
--space-4     16px
--space-5     20px
--space-6     24px
--space-7     28px
--space-8     32px
--space-10    40px
--space-12    48px
--space-16    64px
```

### Structure (numbers owned by STRUCTURE.md §1)
```
--control-height-xs   28px   dense tier: .btn-sm (through --btn-height-sm) and .btn-icon; the contract's
                             table-cell controls and pagers don't read it yet
--control-height-sm   32px   compact tier: this build's action button (UI_RULES §115)
--control-height-md   36px   the contract default; 40px at ≤640px (theme.css's phone block)
--control-height-lg   44px   large CTA · the tap-target floor

--border-width-sm     1px    the hairline that carries hierarchy (flat doctrine)
--border-width-md     2px    fields, emphasis
--border-width-lg     3px    left-accent rails only
```
Colour-independent and identical in every theme: a client theme never overrides them. A control's height reads a control-height tier and a hairline reads `--border-width-sm`, never a literal. The role aliases that point components at these (`--btn-height`, the gap ladder, the container paddings) are listed under Aliases.

### Typography
```
--font-family-sans            primary UI font
--font-family-mono            monospace (numerics, code)

--font-size-2xs               10px      (micro labels)
--font-size-xs                11px      (caption)
--font-size-xs2               12px      (small copy: .btn-sm, tag chips, the back pill — STRUCTURE §1)
--font-size-sm                13px      (body-sm)
--font-size-md                14px      (body default)
--font-size-lg                16px      (body-lg, small heading)
--font-size-xl                20px      (heading)
--font-size-2xl               24px      (display-sm)
--font-size-3xl               30px      (display)
--font-size-4xl               36px      (display-lg)

--font-weight-regular         400
--font-weight-medium          500
--font-weight-semibold        600
--font-weight-bold            700

--line-height-tight           1.2
--line-height-normal          1.5
--line-height-relaxed         1.75

--letter-spacing-tight        -0.02em
--letter-spacing-normal       0
--letter-spacing-wide         0.04em
--letter-spacing-wider        0.08em
```

### Motion
```
--duration-fast               100ms
--duration-base               200ms
--duration-slow               350ms

--ease-in                     cubic-bezier(0.4, 0, 1, 1)
--ease-out                    cubic-bezier(0, 0, 0.2, 1)
--ease-in-out                 cubic-bezier(0.4, 0, 0.2, 1)
--ease-spring                 cubic-bezier(0.175, 0.885, 0.32, 1.275)
```

### Z-index
```
--z-base                      1
--z-dropdown                  100
--z-sticky                    200
--z-overlay                   300
--z-modal                     400
--z-toast                     500
```

### Breakpoints
```
--breakpoint-sm               640px         (mobile → tablet)
--breakpoint-md               1024px        (tablet → desktop)
```
*Note:* CSS `@media` queries can't consume `var()`. These tokens are reference values for JS (`matchMedia`) and documentation. Component `@media` queries inline the px values — keep them in sync with this file.

---

## Aliases (shell-wide roles)

These are the ONLY aliases allowed in the shell. They exist so component CSS reads semantically. If you need a new alias, add it here — never invent one in a component file.

```
--font                    → --font-family-sans
--page-bg                 → --color-surface-base
--card-bg                 → --color-surface-raised
--inset-bg                → --color-surface-sunken
--card-border             → --color-border-default
--border-light            → --color-border-subtle
--border-mid              → --color-border-default
--text-primary            → --color-text-primary
--text-body               → --color-text-body
--text-muted              → --color-text-muted
--text-faint              → --color-text-faint
--primary                 → --color-brand-primary-500
--primary-light           → --color-brand-primary-400
--primary-hover           → --color-brand-primary-600
--primary-deep            → --color-brand-primary-700
--primary-soft            → --color-brand-primary-100
--primary-bg              → --color-brand-primary-50
--success                 → --color-semantic-success-500
--warning                 → --color-semantic-warning-500
--danger                  → --color-semantic-error-500
--focus-ring-color        → --color-brand-primary-500  (shell default; a theme may re-tint it in its RECIPES,
                                                        keeping ≥3:1 — CleanSpace: brand ink at 60%)
--card-radius             → --radius-lg
--btn-radius              → --radius-md
--input-radius            → --radius-md
--badge-radius            → --radius-full
--btn-height              → --control-height-sm   (the one action-button height, UI_RULES §115;
                                                   re-point it to move every standard-size .btn)
--btn-height-sm           → --control-height-xs   (.btn-sm: data-table rows and named clusters)
--gap-inline              → --space-2             (chips, icon + label, button clusters)
--gap-control             → --space-3             (between controls: toolbars, form rows, the pager)
--gap-card                → --space-4             (stacked cards, form groups)
--gap-section             → --space-6             (between page sections)
--card-pad-sm             → --space-4             (dense cards, stat tiles, nested blocks)
--card-pad                → --space-5             (the default .card)
--card-pad-lg             → --space-6             (modals, roomy cards)
--shadow-overlay          → --shadow-lg           (the one overlay shadow: modals, menus, toasts, sheets)
--font-input-size         → --font-size-md; --font-size-lg at ≤640px (fields, so iOS never zooms on focus)
--sidebar-bg              → --color-neutral-900
--sidebar-border          → --color-neutral-800
--color-avatar-{1..5}     → (theme-specific color token assignment)
--avatar-{1..5}           → var(--color-avatar-{1..5})  (legacy form, kept for existing selectors)
```

---

## Rules (enforced)

1. **No hardcoded color values anywhere.** Any `#hex`, `rgb(...)`, `rgba(...)` or named colour outside a theme palette entry is a bug: in component CSS, JSX, the document and email templates, the server's pages and the brand-asset scripts. Reference a token, or compose in a recipe; shadow black is `rgba(var(--color-black-rgb), α)`. Code that cannot read a CSS variable reads `BRAND` / `DOC` from `src/brand/`. Enforced in CI by `scripts/test-color-ledger.mjs` (via `run-tests`), UI_RULES §121; a justified exception carries `design:allow no-raw-hex — <reason>`.
2. **No hardcoded radii or shadows.** Use `var(--radius-*)` and `var(--shadow-*)`, never a raw px or multi-layer shadow in a component file.
3. **No inventing token names in the shell.** New token = Swatchboard Material Change Protocol. No exceptions.
4. **No aliases inside component files.** Aliases belong in `theme.css`. A component reads `var(--card-bg)` but never defines it.
5. **Recipes don't contain literal color/size values.** Every recipe input is a `var(--token)`, a channel composition (`rgba(var(--color-black-rgb), X)`) or an allowed literal (transforms, easings, display modes, `transparent`). A colour baked into a recipe fails `test-color-ledger.mjs`: a client theme cannot override it. A value a variable cannot reach (an icon drawn in a data URI) is generated by `brand:js` into the client theme's GENERATED block (UI_RULES §121).
6. **`@media` query breakpoints stay in sync with `--breakpoint-*` tokens.** If you change a breakpoint, update both the token and every call site.
7. **Buttons are never green (CleanSpace brand law).** Affirmative / CTA buttons are **gold** — `.btn-gold`, or `.btn-success` which is overridden to gold in `index.css`. Primary/utility = `.btn-primary` (black), destructive = `.btn-danger` (red), neutral = `.btn-secondary`. The `--success` / `--color-semantic-success-*` / `--badge-green-grad` greens are **status-only** (badges, "done" dots, positive amounts) — never a button or interactive fill. Full role matrix: `UI_RULES.md` §11.
8. **Every `var(--x)` resolves to a definition.** A token/alias here, a client re-tint in its theme's RECIPES, or a runtime var set from JS. A fallback never excuses a missing name: `var(--danger-bg, #fee2e2)` renders the fallback forever and hides the typo. Point the read at the token it means instead. Enforced in CI by `scripts/test-css-vars-defined.mjs` (via `run-tests`), UI_RULES §119.

---

## Freedoms (author's call)

1. **Pick any scale step.** Card radius = `--radius-md` or `--radius-lg`? Author chooses. The scale gives you structure; which step fits is a design call.
2. **Compose tokens into recipes freely.** Gradients, shadow stacks, multi-layer backgrounds — as long as inputs are tokens, the composition is yours.
3. **New components don't need new tokens.** If the vocabulary covers it (95% of cases), just wire it up.
4. **Semantic aliases or direct tokens — your call inside a component.** `var(--card-bg)` and `var(--color-surface-raised)` are both valid when the role matches.

---

## Adding a new component — checklist

Before committing a new component's CSS:

- [ ] All colors reference `var(--color-*)` tokens (or `BRAND` / `DOC` where a CSS variable can't be read). `npm --prefix app run colors` must report 0 leaks.
- [ ] All radii reference `var(--radius-*)`. No raw `px` in `border-radius`.
- [ ] All shadows reference `var(--shadow-*)` primitives — or, if composing a multi-layer shadow, define it as a recipe in `theme.css` (or the theme's `RECIPES` section).
- [ ] Spacing uses `var(--space-*)` wherever possible. Document genuinely component-specific one-offs with a comment.
- [ ] Font sizes use `var(--font-size-*)`. No raw `px` in `font-size`.
- [ ] Any new aliases you introduced → moved to `theme.css`.
- [ ] Any new recipes are in the `RECIPES` section of the theme file.

---

## Adding a new token

New tokens come from the Swatchboard, not the shell. Process:

1. Check if an existing token covers the need — often the answer is yes with a creative scale-step choice.
2. If genuinely missing, propose the addition via the Swatchboard Material Change Protocol (see `Kronelius/PolishPoint-Swatchboard/PROTOCOL.md`).
3. Once approved and seeded, the Swatchboard emits the new token in `tokens.css`.
4. Add the token name to this file under "Canonical Vocabulary."

---

## Known gaps & pending-tokenization

Values currently missing from the Swatchboard's 8 categories. Handle inline until promoted.

- **Opacity scale** — currently inline (`0.5`, `0.15`). If repeated, propose `--opacity-{muted, default, strong}`.
- **Blur / backdrop-filter** — no token. Glass-morphism effects use literal `blur(Xpx)` inside recipes for now. Consider a `--blur-{sm, md, lg}` category if patterns emerge.
- **Accent colors** — `--color-accent-*` is a shell-side extension. Flagged for promotion to Swatchboard Layer 1.
- **Hardcoded spacing & font-sizes in component CSS** — `app/src/index.css` still contains many raw px values (e.g. `padding: 24px 28px`, `font-size: 10px`). These will migrate to `var(--space-*)` / `var(--font-size-*)` in a follow-up pass. The kit's own rules now read the structural tokens for their heights, hairlines, main gaps, paddings and overlay shadow, but still carry literals (e.g. `.toast` padding `12px 16px`, `.page-head` gap `10px`); feature CSS still writes numbers, and only `lint:design` reports them (in CI as a ratchet since 2026-09-24: new findings fail, the existing ones are frozen). New components must use tokens from day one.

---

## Semantic Badge mappings (variance flags)

The Variance report (Swept replacement) maps a clean's flag to a Badge color variant via `flagBadgeVariant()` in `app/src/lib/variance.js` — keep this the single source so server and UI never diverge:

| Flag | Variant | Why |
|---|---|---|
| `over` | `red` | Labor exceeded the budget — unbudgeted cost, the thing to chase |
| `under` | `amber` | Cleaner left early / short — quality risk, worth a look |
| `on_target` | `green` | Within ±threshold |
| `incomplete` | `blue` | Still on the clock — no final number yet |
| `no_baseline` | `slate` | No expected time set — excluded from flags/averages, never coerced to 0 |

Don't hardcode these colors at call sites; import `flagBadgeVariant` / `flagLabel`. New semantic mappings (e.g. QC pass/fail) follow the same pattern: one mapping function next to its domain logic. The Phase 2 clock/variance component CSS lives in the `SWEPT REPLACEMENT` block at the end of `index.css` (tokens for color, px for layout to match the file's convention).

---

## Transition state (Phase 0)

- The Swatchboard currently has 16 grayscale color tokens seeded (Phase 0). All other categories below are defined in this doc but are not yet rows in Supabase.
- **Swatchboard Phase 1:** brand/semantic colors, typography, spacing, shadow, motion, breakpoints, z-index land in Supabase via normal token editing.
- **Swatchboard Phase 2:** recipes migrate from `theme*.css` `RECIPES` sections to `element_variants.recipe` JSONB rows.
- Until Phase 1 completes, this doc is the canonical vocabulary. Both `theme.css` (unthemed default) and `theme-polishpoint-blue.css` (reference themed) conform to it.
