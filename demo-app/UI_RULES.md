# Shell UI Rules

> Cosmetic and interaction rules for the shell build. These are *additive* to `app/src/STYLING.md` (which governs design tokens / aliases / recipes) and govern *how UI is composed and behaves*. Both files travel together when porting the shell to a new client.

This file is the source of truth for layout/interaction conventions. When you add a new page or component, follow these rules. When you change one, update this file in the same commit.

---

## 1. Container hygiene — no pointless nesting

**Rule.** A container only earns its existence if it adds visual grouping that isn't already provided by an inner element. If the inner element (table, card, list) already has a border + radius + shadow, do not wrap it in a `.card` for "extra padding."

**Where it applies.**
- List pages with a single table: `Clients`, `Invoices`, `Reminders`, `Team`, `ClientDetail` tab tables. The `<table>` lives directly inside `<div class="table-wrap">` — no surrounding `<div class="card">`.
- Dashboard KPI clusters: `Operational Performance`, `Financial Snapshot`. The `<div class="stat-grid">` with its `StatCard` children sits directly under the page; the section heading uses `.dash-section-title` (no card border).
- Detail-page section cards that wrap (header + table + optional inline form): `InvoiceDetail` Line Items / Payments, `ContactDetail` Related-tab Invoices / Jobs / Conversations. The header persists outside (Rule 2), the `.table-wrap` stands alone with its own border, and any inline editing form fields/actions sit directly below the table — no `.card.detail-card` wrapper around the whole section.
- Settings cards with a single form/card child: handled structurally — see Rule 5.

**How to apply.** When you'd otherwise write
```jsx
<div className="card"><div className="table-wrap">…</div></div>
```
write
```jsx
<div className="table-wrap">…</div>
```
The `.table-wrap` recipe carries its own background/shadow/margin so it stands alone. Same for `StatCard`s — they have their own border/shadow.

For section cards that wrap a header + table-wrap + sometimes an inline form (the `InvoiceDetail` / `ContactDetail` pattern), drop the outer `.card.detail-card` and let each child stand on its own:

```jsx
{/* before */}
<div className="card detail-card">
  <div className="section-head"><h3>…</h3>{button}</div>
  <div className="table-wrap">…</div>
  {editing && <div className="form-row">…</div>}
  {editing && <div className="modal-actions">…</div>}
</div>

{/* after */}
<div>
  <div className="section-head"><h3>…</h3>{button}</div>
  <div className="table-wrap">…</div>
  {editing && <div className="form-row">…</div>}
  {editing && <div className="modal-actions">…</div>}
</div>
```
Keep the wrapping `<div>` so the section is one grid cell / one block. Drop the visual `card detail-card` chrome.

**Don't apply** to true *primary-content* cards that have their own dense, structured body (e.g. the `InvoiceDetail` "Summary" card with its `<dl>`, the `ContactDetail` Overview profile card). Those legitimately are the page's main content surface and earn their `.card.detail-card`. The test: if dropping the outer card would leave a heading + a single visually-bordered child (table-wrap, stat-grid, list), drop it. If the body is a definition list / stacked fields / mixed prose, keep it.

---

## 2. Section titles persist outside containers

**Rule.** When a "larger container" is dropped per Rule 1 but had a heading inside, the heading persists as a standalone element above the content. Use `.dash-section-title` (smaller, muted, uppercased) for KPI-style cluster headings.

**Where it applies.** Dashboard KPI clusters. The section heading sits between the dashboard hero and the stat-grid, with no card around it.

**Don't apply** to detail-page section titles inside `.card.detail-card` — those keep their in-card heading style (`.dash-card-title` / `.section-title`).

---

## 3. Bulk-action bars persist — no layout shift on selection

**Rule.** Any UI element that appears/disappears based on selection state must instead **always be rendered** as a container. When nothing is selected, show neutral placeholder copy and **hide the action controls entirely** (do not render them). The result: selecting an item never pushes the content below it down, but the empty bar stays clean with only instructional text.

**Where it applies.**
- `Clients` (Contacts tab): bulk-bar with tag/owner/archive actions
- `Clients` (Accounts tab): bulk-bar with archive action
- `Invoices`: bulk-bar with mark-paid/export/clear
- `Pipeline`: bulk-bar with move-to-stage/owner/archive

**How to apply.**

1. JSX: render the bar unconditionally with an `is-empty` modifier when count is 0. Controls render only when count > 0, left-justified (no flex spacer).
   ```jsx
   <div className={`bulk-bar ${selection.size === 0 ? 'is-empty' : ''}`}>
     <span>
       {selection.size > 0
         ? `${selection.size} selected`
         : 'Select <items> for bulk actions'}
     </span>
     {selection.size > 0 && (
       <>
         {/* ...controls (no disabled={selection.size === 0} needed)... */}
         <button className="btn btn-outline btn-sm" onClick={clearSelection}>Cancel</button>
       </>
     )}
   </div>
   ```
2. CSS: `.bulk-bar.is-empty` softens the visual (transparent bg, dashed border, muted text). No dimming rules needed since controls are absent.
3. Do NOT use a flex spacer to push controls right — controls follow the "{N} selected" text directly (left-justified).

**Generalizes to:** any "context bar" tied to selection or transient state (filter chips, batch toolbars). If it would CLS on appearance, render it always.

---

## 4. Click-target ergonomics — checkboxes ≥ 18px

**Rule.** Native checkboxes are ~13px in most browsers and require a precise click. The shell sets a global rule that bumps every `input[type="checkbox"]` to **18×18px** (≈ 50% larger linear hit area) with `cursor: pointer` and `accent-color: var(--primary)`.

**Where it applies.** Every checkbox in the app. Already enforced via global CSS in `index.css` (`input[type="checkbox"] { width: 18px; height: 18px; ... }`).

**How to extend.** When a checkbox needs an even larger hit area (cards, mobile lists), wrap it in a `<label>` — the global rule sets `cursor: pointer` on `label:has(> input[type="checkbox"])`, and the label area transfers clicks to the input natively.

**Why 18px (not 20 / 24).** 18px gives the user-requested ~50% increase without breaking visual rhythm in tight tables. If a future audit shows touch ergonomics still need work on mobile, bump to 20px and keep this file in sync.

---

## 5. Settings layout — sidebar bottom = main card bottom

**Rule.** In a two-column layout where one side is a sub-nav and the other is a primary content card, the bottom edges of the two columns must align. The pattern is:

- Outer grid uses `align-items: stretch` so both columns stretch to the row height.
- The content column uses `display: flex; flex-direction: column;` and the *last* card/form/`table-wrap` inside it uses `flex: 1 1 auto; margin-bottom: 0;` to absorb leftover height.

**Where it applies.** Settings pages (`SettingsLayout` wraps every settings sub-page). The CSS rule that enforces it lives at `.settings-content > * > .card:last-child` (and its `form.card` / `table-wrap` siblings).

**Generalizes to:** any future shell layout that puts a sub-nav alongside a content area. If the bottoms don't line up, the eye reads it as misaligned.

---

## 6. Margin between page-head-text and primary card

**Rule.** In settings pages (and other layouts that use `.page-head-text` directly above a card), the heading block has `margin-bottom: 30px` to its primary card. CSS rule: `.settings-content .page-head-text { margin-bottom: 30px; }`.

**Why.** A tighter margin felt cramped against the card border; 30px gives a clear breath without breaking compact density.

**Generalizes to:** any place a `.page-head-text` sits directly above a primary `.card`. If it appears elsewhere in the app and looks tight, scope the margin rule there too rather than making it global (because the title can also sit above tables, lists, etc., where the gap is different).

---

## 7. Selectors / segmented controls — unified pill, equal-width segments, hug content

**Rule.** Every tab / segmented control in the app shares one geometry recipe:

1. **Container hugs content** via `display: inline-grid` (not `flex`), so the pill never stretches across an empty row.
2. **Segments are equal width** via `grid-auto-flow: column; grid-auto-columns: 1fr`. Each segment matches the widest label, padded to a uniform footprint.
3. **Container resists parent stretch** via `align-self: flex-start` (so a `flex-direction: column` parent like the Filters popover doesn't blow it back out to 100% width).
4. **Visual chrome:** container `background: var(--inset-bg)`, `border: 1px solid var(--card-border)`, `border-radius: var(--radius-full)`, `padding: 3px`. Inactive button: `background: transparent`, `border-radius: var(--radius-full)`, `font-weight: var(--font-weight-semibold)`. Active button: `background: var(--btn-primary-grad)`, `color: var(--color-text-on-primary)`, `box-shadow: var(--tab-active-shadow)`.
5. **Centered content** inside each button: `display: inline-flex; align-items: center; justify-content: center` (Rule 13). Without `justify-content: center`, content packs to the start of its grid column when the segment is wider than its content.

Three class pairs render identically — pick whichever name matches the surface:

- `.tab-container.tab-container-line` + `.tab-btn` (default for new tabs)
- `.messaging-inbox-toggle` + `.inbox-toggle-btn` (messaging surface)
- `.segmented` + `.segmented-btn` (in-line "match-all/match-any" style toggles)

**Where it applies.**
- `.tab-container.tab-container-line` (Clients Contacts/Accounts, Schedule Day/Week/Month, ContactDetail tabs, ClientDetail tabs, ConversationContextPanel right-panel tabs, Notifications settings)
- `.messaging-inbox-toggle` (Messaging Inbox / Threads / DMs)
- `.segmented` (Filters popover Match all/Match any)

**Don't apply** to the dashboard `.dash-sw-btn` (Overview/Metrics) — intentionally a pill-shaped switcher, a different visual pattern.

**How to add a new selector.** Use one of the three class pairs above (`.tab-container.tab-container-line` is the default for new tabs). Do not invent a fourth style. If the design genuinely needs a new pattern, add it here first.

---

## 8. Toasts only confirm save actions

**Rule.** A toast appears **only** after an explicit form/modal save click. Status changes — toggles, mark-as-X, archive, delete, drag/drop, bulk actions on lists — change the data and let the UI reflect it; no toast.

**What still toasts.**
- Add/Edit/Save buttons on any modal (`AddClientModal`, `AddContactModal`, `CreateInvoiceModal`, etc.)
- Save buttons on detail/settings pages (`Account updated`, `Member saved`, `Profile saved`, …)
- Form-shaped submissions: `Note added`, `Payment recorded`, `Stage added`, CSV import completion
- Errors and validation failures (`toast.error(...)`) — these always toast, regardless of the action

**What never toasts.**
- Status changes (mark paid, voided, archived, deleted)
- Toggles (template enabled/disabled, permission grant/revoke)
- Bulk actions on lists
- Drag/drop moves
- Copy-to-clipboard, exports, simulated test sends

**How to apply.** New code: don't reach for `useToast` unless you're confirming a save. If you wired a toast and aren't sure it qualifies, the default is **don't toast** — the UI update is the confirmation.

---

## 9. Sidebar footer — single border above the user chip

**Rule.** The sidebar footer (containing the user-switcher) draws **one** divider above it via `.sidebar-footer`'s `border-top`. Don't add a second `border-top` to the user-switcher itself. CSS rule: `.user-switcher { position: relative; }` (no border).

**Why.** Stacking two borders that overlap with different inset widths creates a "double line" effect that looks like a CSS bug.

**Generalizes to:** any container-inside-container where both want a top divider. Pick one — the outer container's border or an explicit divider element — never both.

---

## 10. New Job entry-point lives on the Schedule page only

**Rule.** Job creation is initiated from the Schedule page. The sidebar does not carry a "New Job" CTA.

**Why.** Action affordances for a single feature shouldn't appear in the global chrome (sidebar) AND on the page itself; that's redundant clutter. Schedule already has its own "New Job" button + modal.

**Generalizes to:** any feature-specific create CTA. Put it on the page that owns the feature, not in the global sidebar. Sidebar entries should be navigation only.

---

## 11. Button role convention — filled by semantic role, never bare outline as a CTA

**Rule.** Whenever action buttons sit next to each other in a header / toolbar / detail-page row, every button is **filled** with one of four semantic role classes. Never use `.btn-outline` as a primary or co-primary CTA in those rows.

> ⚠️ **Theme portability:** the role classes below resolve to the active swatchboard's brand and semantic colors. `.btn-primary` may render as navy in one theme and orange in another; `.btn-success` is whatever hue the theme uses for affirmative semantic state. **Do not write rules in terms of "blue / green / red" — write in terms of role.** What follows uses role classes only.

**The four role classes:**

| Class | Token source | Role |
|---|---|---|
| `.btn-primary` | `--btn-primary-grad` (brand primary) | Default CTA / utility / affirm-with-record-state action |
| `.btn-success` | `--badge-green-grad` → `--color-semantic-success-*` | Affirmative or auxiliary helper action paired alongside a primary |
| `.btn-danger` / `.btn-deny` | `--color-semantic-error-*` | Destructive / irreversible state change |
| `.btn-secondary` | `--card-bg` + `--card-border` | Neutral filled (use only when the alternative roles overstate) |

**Role assignment for two-button pairs:**
- **Non-destructive pair** → `.btn-primary` + `.btn-success`. The create / record-state action takes `.btn-primary`; the secondary / utility action takes `.btn-success`.
- **Destructive pair (Edit + Delete, Save + Cancel-job, etc.)** → `.btn-primary` + `.btn-danger`. `.btn-danger` substitutes for `.btn-success` when one half of the pair is destructive — pairing rule is "filled + filled," not specifically "primary + success."
- **Affirmative + utility pair (e.g. `Filters` + `New conversation`)** → `.btn-success` + `.btn-primary`.

**Role assignment for triads (three buttons):**
- Common pattern in detail-page headers: `.btn-success` + `.btn-primary` + `.btn-danger` (Message + Edit + Delete). All filled, no outline.

**Role assignment for state-transition rows (4+ buttons, e.g. JobDetail header):**
- Affirmative go-actions → `.btn-success` — e.g. `Start`.
- Utility / completion → `.btn-primary` — e.g. `Mark Done`, `Edit`.
- Destructive → `.btn-danger` — e.g. `Cancel Job`, `Delete`.
- Neutral negatives (no-show / soft-fail) → `.btn-secondary` — e.g. `Mark Missed`. Use this when `.btn-danger` would overstate the action.

**Where it applies.** Every page header, every section header, every toolbar, every detail-page action row, every conversation pane head.

**Where outline IS allowed (the exhaustive list — anything outside these is a rule violation):**
- Modal `Cancel` + `Save` action rows.
- Inline-edit `Cancel` buttons inside section bodies (e.g. note-edit Cancel) — they mirror modal-Cancel behavior.
- Bulk-bar `Cancel` / `Clear` selection buttons — same role: dismiss without consequence.
- Tiny utility actions inside section bodies that don't form a CTA pair (e.g. `Add line` inside an invoice line-item table, `View` / `Replace` on an attachment chip). Use sparingly.

**Reference pairs in the live app (described by role, not hue).**
- Messaging header — `Filters` (`.btn-success`) + `New conversation` / `New DM` (`.btn-primary`)
- Clients page header — `Import CSV` (`.btn-success`) + `Add Contact` / `Add Account` (`.btn-primary`)
- Pipeline toolbar — `Add Pipeline` (`.btn-success`) + `Manage Stages` (`.btn-primary`)
- Invoices header — `Log Payment` (`.btn-success`) + `Log Invoice` (`.btn-primary`)
- ContactDetail header (triad) — `Message` (`.btn-success`) + `Edit` (`.btn-primary`) + `Delete` (`.btn-danger`)
- ClientDetail header — `Message` (`.btn-success`) + `Delete` (`.btn-danger`)
- ConversationMessagePanel — `Remove from view` (`.btn-success`) + `Delete thread` (`.btn-danger`)
- Note Edit/Delete pairs (ContactDetail / ClientDetail Notes tab) — `Edit` (`.btn-primary`) + `Delete` (`.btn-danger`)
- JobDetail header — `Start` (`.btn-success`) + `Mark Done` (`.btn-primary`) + `Cancel Job` (`.btn-danger`) + `Mark Missed` (`.btn-secondary`) + `Edit` (`.btn-primary`) + `Delete` (`.btn-danger`)

---

## 12. No "+" prefix on button labels

**Rule.** Do not prefix button labels with a literal `+ ` or include `<Icon name="plus" />` for create / add CTAs. The verb in the label ("Add Contact", "New Job", "Log Payment", "Invite Member") carries the affordance.

**Why.** Stacked + signs across header rows read as visual clutter rather than clear action language. The user has explicitly called this pattern "tacky and cheap."

**Where it applies.** Every CTA button in the app — page headers, section headers, toolbars, modals, empty-state actions.

**Don't apply** to icon decorations on quick-action cards (e.g. Dashboard `.qa-icon`) where a domain Icon (Schedule, Invoices) communicates category, not "create." Those use `<Icon name="..." />` instead of a literal "+".

---

## 13. Buttons lock to consistent heights and center their content

**Rule.** Adjacent buttons must always share the same outer height. Two pieces enforce this:

1. **Locked height instead of vertical padding.** The base classes set `height` directly and zero out vertical padding so the button's outer dimensions don't drift when content varies (icon + text vs text-only).
   - `.btn { height: var(--space-8); padding: 0 var(--space-4); }`
   - `.btn-sm { height: var(--space-7); padding: 0 var(--space-3); }`
2. **Centered content** via `display: inline-flex; align-items: center; justify-content: center`. Without `justify-content: center`, an icon+label pair packs to the left of a wider parent column (visible inside any equal-width selector — see Rule 7).

**Why.** Without locked heights, a `.btn-sm` containing a 14px `<Icon>` is 26px tall while a text-only `.btn-sm` is 24px. Even a 2px drift between adjacent buttons reads as broken alignment. Locking the height to a space token makes every button in the app render at the same outer height regardless of contents.

**Where it applies.** Every `<button class="btn …">` in the app. The base rules already enforce it; new variants (`.btn-warning`, etc.) inherit automatically.

**Don't apply** custom heights inside variant rules (`.btn-success`, `.btn-primary`, `.btn-sm` modifier rules already in place are the only height-bearing rules). If a layout genuinely needs a taller button (rare — usually a hero CTA), add a separate class like `.btn-lg` here first with its own `--space-*` height token.

---

## 14. Filled CTA glows use halved-intensity shadow recipes

**Rule.** Filled CTA classes (`.btn-primary`, `.btn-success`, `.btn-danger`, `.btn-deny`) carry a tinted outer glow + soft drop shadow + inset highlight. Alpha values across all three layers stay at the **halved** intensity profile:

- Idle: inset `α = 0.125`, outer glow `α = 0.175`, drop shadow `α = 0.14`
- Hover: inset `α = 0.15`, outer glow `α = 0.225`, drop shadow `α = 0.175`

Each layer composes a token, never a literal:
```css
inset 0 1px 0 rgba(var(--color-white-rgb), 0.125),
0 0 22px rgba(var(--color-{family}-rgb), 0.175),
0 4px 14px rgba(var(--color-{family}-rgb), 0.14);
```

The `{family}` slot is the role the class consumes:
- `.btn-primary` → `--btn-primary-glow` / `--btn-primary-glow-hover` recipes (defined per-theme; consume `--color-brand-primary-rgb` and the `*-600-rgb` variant)
- `.btn-success` → composes inline against `--color-semantic-success-rgb`
- `.btn-danger` / `.btn-deny` → composes inline against `--color-semantic-error-rgb`

New filled variants must follow this exact alpha profile and source their tint from a theme-defined `--color-*-rgb` token.

**Why.** The original full-intensity profile (α `.25 / .35 / .28` idle, `.3 / .45 / .35` hover) read as overlit at the chosen brand saturations. The 50% reduction is canon.

**Where it applies.** Every filled-role button in the app, plus the `.toggle.on` switch (which inherits `--btn-primary-glow`).

**Don't apply** the halved profile to `.btn-secondary` (neumorphic light/dark inset, not a tinted glow), `.btn-outline` (no fill), or surface-level shadows on cards / modals / popovers — those are different recipe categories with their own intensity.

---

## 15. Tokens always — no hex, no raw rgb, no inline-fallback hex in component CSS

**Rule.** Every styling value in component CSS (anything in `app/src/` that isn't a theme file) resolves to a `var(--token)` reference. No raw hex, no raw `rgb()` / `rgba()` tuples, no fallback hex inside `var(--token, #hex)` patterns.

Status: as of this session, `app/src/index.css` contains **zero** hex literals and **zero** raw rgb/rgba tuples. Audit script: `grep -E '#[0-9a-fA-F]{3,6}\b' app/src/index.css` and `grep -E 'rgba?\(\s*\d' app/src/index.css` should both return no matches. Run these before merging any change to component CSS.

The minimum token vocabulary for the rules above:

| Domain | Token |
|---|---|
| Text rendered over a filled CTA | `var(--color-text-on-primary)` |
| Brand-primary fill (idle / hover) | `var(--btn-primary-grad)` / `var(--btn-primary-grad-hover)` |
| Success-role fill | `var(--badge-green-grad)` |
| Error / destructive fill | `linear-gradient(135deg, var(--color-semantic-error-400), var(--color-semantic-error-500))` |
| Inset surface (selector chrome, recessed bg) | `var(--inset-bg)` |
| Card / input border | `var(--card-border)` |
| Body text (inactive state) | `var(--text-body)` |
| Headline text (hover / active state) | `var(--text-primary)` |
| Pill / full radius | `var(--radius-full)` |
| Button corner radius | `var(--btn-radius)` |
| Button height — regular / small | `var(--space-8)` / `var(--space-7)` |
| Button horizontal padding — regular / small | `var(--space-4)` / `var(--space-3)` |
| Active-state shadow on tabs | `var(--tab-active-shadow)` |
| White-tint compositing (highlights / overlays) | `rgba(var(--color-white-rgb), <alpha>)` |
| Black-tint compositing (overlays / drop shadows) | `rgba(var(--color-black-rgb), <alpha>)` |
| Tinted glow alpha (per Rule 14) | `rgba(var(--color-{family}-rgb), <alpha>)` |

**Why.** Each customer build ships against a different swatchboard. Component CSS must reference roles, not specific values, or the next theme breaks. Inline-fallback hex (`var(--token, #hex)`) is also forbidden — if the token is required, define it; if it's optional, the fallback hex still bypasses the theme's intent.

**Where it applies.** Every CSS file in `app/src/` outside `theme.css` and `theme-{name}.css`. Inline `style={{...}}` in JSX is held to the same standard — search the codebase for `style={{` containing `#` or `rgba(` and migrate.

**Where literals ARE allowed:**
- Theme files only (`theme.css`, `theme-polishpoint.css`, future `theme-{client}.css`) — this is where token VALUES live by design.
- Recipes inside theme files — alpha values, blur radii, gradient angles, and the `*-rgb` triplet on the `--color-{name}-rgb` aliases are defined as numeric literals there.

**Known gaps (genuine missing tokens — promote via Swatchboard Material Change Protocol):**
- `font-size: 12px` — no canonical step exists between `--font-size-xs` (11) and `--font-size-sm` (13). Used inline by `.btn-sm`, `.segmented-btn`, and a few dense surfaces. Promote `--font-size-2sm` if the 12px step ever needs to vary by theme.
- `--color-neutral-{step}-rgb` triplets — only `--color-neutral-rgb` (the 500 step) is defined. Modal-overlay surfaces that want a darker tint currently use `rgba(var(--color-black-rgb), <alpha>)` as a workaround; if a theme wants a tinted-neutral overlay, promote per-step RGB triplets.
- Border widths and opacity scale — still inline `1px` / `0.5` / `0.15`. Pre-tokenization gap inherited from `STYLING.md`.

The audit ran in this session is complete for color tokens; any new violation introduced after this point is a regression.

---

## Adding a new rule

Before merging a UI change that establishes a pattern likely to repeat, add an entry here. Each entry should have:

1. **Rule** — the one-line statement (imperative)
2. **Where it applies** — concrete pages/components today
3. **How to apply** — JSX or CSS sketch the next contributor can copy
4. **Generalizes to / Don't apply** — boundaries, so the rule isn't over-extended

Keep entries terse. If the *why* is non-obvious, add one line; if it's obvious, skip.

---

## Cross-references

- **`app/src/STYLING.md`** — token vocabulary (colors, radii, shadows, spacing, typography). UI rules read from that vocabulary; never invent values that bypass it.
- **`app/CLAUDE.md`** — project context, file map, deployment model.
- **`app/SHELL_ROADMAP.md`** — what's built, what's pending. Cosmetic rules in this file apply to all CORE-section work.
