# Shell Mobile Responsive — Audit & Carryover Spec

**Status:** Living doc. Use this to keep the shell baseline (`Kronelius/shell-build`) mobile-clean so every client deployment ships sane from day one. Originated from the master shell build's mobile-responsiveness audit.

**Mandate:** **Zero horizontal scroll on any viewport, anywhere in the app.** Including data tables, modals, settings, messaging — no exceptions. If a layout cannot fit at 375px, it must be re-shaped (cards, drawers, stacked forms), not allowed to scroll sideways.

**Target viewport baseline:** 375 × 812 (iPhone SE / 11 / 12 / 13 / 14 mini class). All layouts must also be sane down to 320px, but 375px is the canonical test width.

**Enforcement:** A pre-commit screenshot pass (320 / 375 / 641) is documented in [`CLAUDE.md`](CLAUDE.md) under "Pre-commit visual verification." Fires at commit time only — not during active development — so the core feature work isn't taxed by incremental mobile review. Run the pass on any commit that touches a UI surface; skip on logic-only changes with a commit-message note.

---

## Table of contents

1. [Already shipped fixes](#1-already-shipped-fixes)
2. [Audit — every offender, ranked](#2-audit--every-offender-ranked)
3. [Canonical fix patterns (CSS recipes)](#3-canonical-fix-patterns-css-recipes)
4. [Per-page implementation checklist](#4-per-page-implementation-checklist)
5. [The mobile Contacts redesign (reference)](#5-the-mobile-contacts-redesign-reference)
6. [Testing protocol](#6-testing-protocol)
7. [Edge cases / regression risks](#7-edge-cases--regression-risks)

---

## 1. Already shipped fixes

### Sidebar edge-notch leak on mobile (FIXED — this session)

**Symptom:** When the sidebar is closed on mobile (`translateX(-100%)`), the active nav button's right-pointing triangle tip and the `::after` edge-shadow pseudo-element extend past the sidebar's right edge and remain visible at the left of the screen.

**Root cause:** The sidebar uses `overflow: visible` so the active-nav triangle can poke 19px past the right edge on desktop. That same overflow lets the decorations escape the sidebar's transformed box on mobile.

**Fix (already merged):** In `app/src/index.css` under `@media (max-width: 640px)`:

```css
.sidebar       { overflow: hidden;  }   /* clip when closed */
.sidebar.mobile-open { overflow: visible; }   /* restore for triangle when open */
```

**Carryover note:** Apply the same pattern to any future sidebar variant. Any element that intentionally overflows its container for decorative effect (notches, glows, drop-shadows that escape) must be clipped on mobile when the parent is positioned off-screen.

---

## 2. Audit — every offender, ranked

Findings from full-codebase audit at `app/src/**`. Severity is impact on a 375px viewport. Line numbers are accurate as of this writing — re-grep when porting.

### CRITICAL

| # | Location | Issue | Fix |
|---|---|---|---|
| C1 | `app/src/index.css` `.msg-3pane` | 3-pane messaging grid: `340px 6px minmax(480px, 1fr) 6px 320px` = ~1140px hard floor. Media queries exist at 1280/1024/768 but **not** at 640. | Add `@media (max-width: 640px) { .msg-3pane { grid-template-columns: minmax(0, 1fr); } }` and route between list / thread / detail as separate views on mobile. |
| C2 | `app/src/pages/Clients.jsx:238–316` | Contacts table — 8 cols (checkbox, Name, Company, Lifecycle, Owner, Tags, Updated, chevron) inside `.table-wrap { overflow-x: auto }`. | Card list at ≤640px. See §5 mockup. |
| C3 | `app/src/pages/Clients.jsx:350–386` | Accounts table — 8 cols (Account, Primary contact, Service, Frequency, Last Service, Revenue, Status, chevron). | Card list at ≤640px. |
| C4 | `app/src/pages/Invoices.jsx:155–195` | Invoices list table — 9 cols (checkbox, Invoice, Client, Issued, Due, Total, Balance, Status, chevron). Worst case for width. | Card list at ≤640px. |
| C5 | `app/src/pages/InvoiceDetail.jsx:209–263` | Line-items table with **fixed pixel widths**: Qty 80px + Unit Price 120px + Line Total 120px + delete 40px = 360px before Description. | Stacked label/value rows at ≤640px; preserve table at ≥641px. |
| C6 | `app/src/components/CreateInvoiceModal.jsx:140–165` | Same fixed-width pattern: 70 + 110 + 40 = 220px before Description. Modal body itself overflows. | Same stacked pattern; also fix modal width (see C13). |

### HIGH

| # | Location | Issue | Fix |
|---|---|---|---|
| H1 | `app/src/index.css:811` `.filter-bar > *` | `min-width: 160px` on every filter child. With six children + gap + padding the bar overflows. | At ≤640px: collapse to a single search input + "Filters" pill that opens a drawer; per-child `min-width: 0; flex: 1 1 100%`. |
| H2 | `app/src/index.css:194` `.table-wrap` | `overflow-x: auto` is the catch-all that hides the underlying problem. | Keep the rule for desktop, but pair every `.table-wrap` table with a card-list alternative for mobile (CSS toggles display). |
| H3 | `app/src/index.css:827` `.tab-container` | `overflow-x: auto` on tab strips with many tabs. | Pin to wrapping (`flex-wrap: wrap`) at ≤640px, or use a select fallback for tab strips with >3 entries. |
| H4 | `app/src/index.css:513` `.modal` / `app/src/index.css:507` `.modal-card-lg` | `max-width: 480px` / `800px` don't shrink on mobile. | At ≤640px: `max-width: calc(100vw - 24px); max-height: calc(100vh - 32px); margin: 16px 12px`. |
| H5 | `app/src/pages/settings/Notifications.jsx` (Inbox tab table) | Delivery inbox table — 6 cols. | Card list at ≤640px. |
| H6 | `app/src/pages/settings/Team.jsx:48–79` | Team table — 6 cols (Name, Email, Role, Access, Status, chevron). | Card list at ≤640px. |
| H7 | `app/src/pages/settings/Roles.jsx:98–108` | Permission matrix — Permission column + N role columns at fixed 100px each. With 4+ roles it overflows. | Stacked accordion at ≤640px (one section per role; checklist per permission). |
| H8 | `app/src/pages/settings/TeamDetail.jsx:163–195` | Permission overrides table. | Card list at ≤640px. |
| H9 | `app/src/pages/settings/Services.jsx:68–145` | Services + frequencies tables. | Card list at ≤640px. |
| H10 | `app/src/pages/ClientDetail.jsx:218–355` | Three tables (service history, sites, contacts). | Card list at ≤640px. |
| H11 | `app/src/pages/ContactDetail.jsx:346–393` | Two tables (invoices, jobs). | Card list at ≤640px. |
| H12 | `app/src/pages/Dashboard.jsx:415–449` | Top Clients / Overdue Invoices tables inside `.dash-cols` grid. | Card list at ≤640px. |

### MEDIUM

| # | Location | Issue | Fix |
|---|---|---|---|
| M1 | `app/src/index.css:1087` `.toast` | `min-width: 240px` leaves only 135px margin at 375px. | At ≤640px: `min-width: 0; width: calc(100vw - 32px); right: 16px; left: 16px`. |
| M2 | `app/src/index.css:2247` `.snippet-popover` | Fixed `width: 320px` on absolutely-positioned popover. | At ≤640px: `width: calc(100vw - 24px); left: 12px; right: 12px`. |
| M3 | `app/src/components/CsvImportModal.jsx:233–236` & `app/src/index.css:2674` | CSV preview table with `white-space: nowrap` on every cell. | At ≤640px: allow wrap, shrink font to 11px, and explicitly scope `overflow-x: auto` only on this table — but warn user that wide CSVs are easier to review on desktop. |
| M4 | `app/src/pages/Clients.jsx:212` | Inline `<div style={{ minWidth: 200 }}>` on bulk-bar TagPicker. | Drop the inline `minWidth` on mobile; let it flex. |
| M5 | `app/src/index.css` `.form-row` (grid 1fr 1fr) | Two-column form rows don't stack on mobile. | At ≤640px: `grid-template-columns: minmax(0, 1fr)`. |
| M6 | `app/src/index.css:264` `.page-head` | `flex-wrap: wrap` works, but with long titles + 2 buttons the actions still overflow. | At ≤640px: stack vertically; `.page-head-actions { width: 100%; }` and each button `flex: 1`. |

### LOW

| # | Location | Issue | Fix |
|---|---|---|---|
| L1 | `app/src/index.css` `.pipeline-card-name` | `white-space: nowrap` on Kanban card title — truncates aggressively. | At ≤640px: `white-space: normal; -webkit-line-clamp: 2; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden`. |
| L2 | `app/src/index.css:845` `.week-grid` / `:890` `.month-grid` | 7-column calendar grids squeeze to ~53px per cell. Doesn't overflow but unreadable. | Calendar mobile views: switch week → agenda list; month → mini-month + day list. (Out of scope for shell baseline; flag for future.) |
| L3 | Long emails / IDs anywhere they're shown raw | Not always wrapped. | Add `overflow-wrap: anywhere` on `.email`, `.id-chip`, table cells with arbitrary user content. |

---

## 3. Canonical fix patterns (CSS recipes)

These belong in `app/src/index.css` under the existing `@media (max-width: 640px)` block (or a new dedicated mobile section near the bottom). Use them for every shell + every client variant.

### 3.1 Page head — vertical stack on mobile

```css
@media (max-width: 640px) {
  .page-head {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  .page-head-actions {
    width: 100%;
    margin-left: 0;
  }
  .page-head-actions .btn { flex: 1; }
}
```

### 3.2 Filter bar — collapse to drawer

JSX side: render either the full filter bar (≥641px) or a search input + "Filters" pill (≤640px). Use a CSS-driven swap with `display: none` on the `.filter-bar` and a separate `.filter-bar-mobile` block. Drawer component: reuse the existing `Modal` primitive with a `.drawer` variant.

CSS:

```css
.filter-bar-mobile { display: none; }

@media (max-width: 640px) {
  .filter-bar       { display: none; }
  .filter-bar-mobile{
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }
  .filter-bar-mobile .search { flex: 1; }
  .filter-bar-mobile .filter-pill {
    background: var(--card-bg);
    border-radius: var(--radius-md);
    box-shadow: var(--card-shadow);
    padding: 0 14px;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
    color: var(--primary);
  }
  .filter-bar-mobile .filter-pill .count {
    background: var(--primary);
    color: #fff;
    font-size: 11px;
    padding: 0 6px;
    border-radius: 999px;
    min-width: 18px;
    text-align: center;
    line-height: 18px;
    font-weight: 700;
  }
}
```

### 3.3 Table → card list

Pattern: render both surfaces, hide the irrelevant one with media queries. Two new components in `app/src/components/`:

- `MobileCardList.jsx` — generic wrapper, accepts `items` + a render-prop.
- Per-entity card row components (e.g. `ContactCardRow`, `AccountCardRow`, `InvoiceCardRow`).

CSS:

```css
.mobile-card-list { display: none; }

@media (max-width: 640px) {
  .table-wrap { display: none; }
  .mobile-card-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .mobile-card {
    background: var(--card-bg);
    border-radius: 16px;
    box-shadow: var(--card-shadow);
    padding: 12px 14px;
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    column-gap: 10px;
    row-gap: 4px;
    align-items: center;
    cursor: pointer;
  }
  .mobile-card .name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mobile-card .sub {
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mobile-card .meta {
    grid-column: 2 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    margin-top: 6px;
    padding-top: 8px;
    border-top: 1px dashed var(--card-border);
  }
}
```

### 3.4 Bulk bar — sticky bottom

```css
@media (max-width: 640px) {
  .bulk-bar {
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: max(12px, env(safe-area-inset-bottom));
    margin-bottom: 0;
    z-index: 40;
    box-shadow: 0 12px 28px rgba(0,0,0,.25);
  }
  /* Pad list bottom so the last card isn't hidden behind the sticky bar */
  .bulk-bar ~ .mobile-card-list,
  .bulk-bar ~ .table-wrap {
    padding-bottom: 80px;
  }
}
```

### 3.5 Modals — fit viewport

```css
@media (max-width: 640px) {
  .modal,
  .modal-card-lg {
    max-width: calc(100vw - 24px) !important;
    max-height: calc(100vh - 32px);
    margin: 16px 12px;
  }
  .modal-body {
    overflow-y: auto;
    overflow-x: hidden;
  }
  /* Two-column form rows always stack on mobile */
  .modal .form-row { grid-template-columns: minmax(0, 1fr); }
}
```

### 3.6 Toast / popover — fit viewport

```css
@media (max-width: 640px) {
  .toast-stack { left: 16px; right: 16px; bottom: 16px; }
  .toast       { min-width: 0; width: 100%; }
  .snippet-popover {
    width: calc(100vw - 24px);
    left: 12px !important;
    right: 12px !important;
  }
}
```

### 3.7 Sidebar overflow clipping (already shipped — pattern reference)

```css
@media (max-width: 640px) {
  .sidebar              { overflow: hidden; }
  .sidebar.mobile-open  { overflow: visible; }
}
```

### 3.9 Stacked rows (form-shaped tables)

Use this for tables that are really **forms** — invoice line items, payment rows, time entries, anything with editable numeric columns. Each row becomes a self-contained card with the description on its own line and a 3-column grid (or N-column, equal `1fr`) for the numeric fields.

```css
@media (max-width: 640px) {
  .li-table { display: none; }   /* hide the table */
  .li-stack { display: flex; flex-direction: column; gap: 10px; }

  .li-stack .li-item {
    background: var(--card-bg);
    border-radius: 14px;
    box-shadow: var(--card-shadow-soft, var(--card-shadow));
    padding: 14px;
  }
  .li-stack .li-desc {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 10px;
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .li-stack .li-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px;
  }
  .li-stack .li-grid label {
    display: block;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--text-muted);
    margin-bottom: 3px;
  }
}
```

JSX side: render both `<table class="li-table">` and `<div class="li-stack">` with the same data; CSS swaps which is visible. The numeric inputs reuse the existing `FormField` styles inside the grid cells.

### 3.10 Role accordion (matrix tables)

Use this for the Roles & Permissions matrix and any future table where rows are records and columns are options to toggle (e.g. notification settings × channels). On desktop the matrix is dense; on mobile it becomes one accordion panel per column (role / channel / etc.) containing a flat list of rows with a per-row toggle.

```css
@media (max-width: 640px) {
  .role-matrix-table { display: none; }
  .role-accordion    { display: flex; flex-direction: column; gap: 8px; }

  .role-panel {
    background: var(--card-bg);
    border-radius: 14px;
    box-shadow: var(--card-shadow-soft, var(--card-shadow));
    overflow: hidden;
  }
  .role-panel-head {
    padding: 12px 14px;
    display: flex;
    align-items: center;
    gap: 10px;
    cursor: pointer;
  }
  .role-panel-head .role-name { flex: 1; font-weight: 700; }
  .role-panel-head .role-count { color: var(--text-muted); font-weight: 600; font-size: 11px; }
  .role-panel-head .chev { transition: transform .2s; }
  .role-panel.open .chev { transform: rotate(180deg); }
  .role-panel-body { display: none; padding: 0 14px 12px; border-top: 1px solid var(--card-border); }
  .role-panel.open .role-panel-body { display: block; }

  .perm-group { margin-top: 10px; }
  .perm-group h4 {
    font-size: 10px; font-weight: 700; letter-spacing: .06em;
    text-transform: uppercase; color: var(--text-muted);
    margin: 0 0 6px;
  }
  .perm-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 0; border-top: 1px solid var(--card-border);
  }
  .perm-row:first-of-type { border-top: none; }
  .perm-row .name { flex: 1; min-width: 0; }
  .perm-row .danger-pill {
    font-size: 9px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; padding: 2px 6px; border-radius: 999px;
    background: var(--badge-amber-bg); color: var(--badge-amber-text);
    border: 1px solid var(--badge-amber-border);
  }
}
```

State: open/closed is local React state (`useState`). Default: first non-Owner role open, others collapsed. Sensitive permissions keep their existing amber pill from the desktop version. The "Reset all to defaults" button moves into the page head on mobile (use §3.1 stacking).

### 3.11 Global guard (defense in depth)

Add this once, at the top of `index.css`. Catches any future regression where a stray element pushes past the viewport.

```css
html, body { overflow-x: hidden; }
.main      { overflow-x: hidden; }   /* main content area */
* { min-width: 0; }                  /* flex children default to shrinkable */
```

The `* { min-width: 0 }` rule fixes the flexbox gotcha where `min-content` defaults to the largest unbreakable token, expanding flex children past their parent. Safe to apply globally; if a specific element actually needs a minimum, override locally.

---

## 4. Per-page implementation checklist

When porting back to the shell, walk this list. Each item should land in one PR or be explicitly deferred.

- [ ] **Global** — apply §3.11 guard rules in `index.css`.
- [ ] **Sidebar** — confirm §3.7 is present (already in this repo).
- [ ] **Page head** — apply §3.1 to `.page-head`.
- [ ] **Filter bar** — implement §3.2 + drawer modal variant.
- [ ] **Bulk bar** — apply §3.4.
- [ ] **Modals** — apply §3.5.
- [ ] **Toasts / popovers** — apply §3.6.
- [ ] **`/contacts`** — Contacts table → card list (`ContactCardRow`).
- [ ] **`/contacts` (Accounts tab)** — Accounts table → card list (`AccountCardRow`).
- [ ] **`/invoices`** — Invoices list → card list (`InvoiceCardRow`).
- [ ] **`/invoices/:id`** — Line-items + payments tables → stacked rows (§3.9).
- [ ] **`/settings/notifications`** (Delivery Inbox tab) — Inbox table → card list.
- [ ] **`/messaging`** — `.msg-3pane` 640px breakpoint + route-based view swap (list → thread).
- [ ] **`/settings/team`** — Members table → card list.
- [ ] **`/settings/roles`** — Permission matrix → accordion (§3.10).
- [ ] **`/settings/team/:id`** — Overrides table → card list.
- [ ] **`/settings/services`** — Services + frequencies tables → card lists.
- [ ] **`/clients/:id`** — Service history / sites / contacts tables → card lists.
- [ ] **`/clients/contact/:id`** — Invoices / jobs tables → card lists.
- [ ] **Dashboard** — Top clients / overdue invoices tables → card lists.
- [ ] **CSV import preview** — allow wrap + shrink font, scope explicit overflow only here.
- [ ] **Pipeline card titles** — apply §L1 line-clamp.

---

## 5. Mobile redesign mockups (reference)

Two visual reference files. Open directly in a browser, or visit them at the dev server URLs while it's running.

| File | Covers | URL |
|---|---|---|
| [`app/public/mobile-contacts-mockup.html`](app/public/mobile-contacts-mockup.html) | Contacts list — 3 states (default, bulk selection with sticky bar, filter drawer open). The canonical card-list pattern. | `/mobile-contacts-mockup.html` |
| [`app/public/mobile-mockups.html`](app/public/mobile-mockups.html) | Six additional patterns: Invoices list, Invoice line items (stacked rows §3.9), Reminders inbox, Team members, Roles & Permissions accordion (§3.10), Messaging list + thread (route-based view swap). | `/mobile-mockups.html` |

### Mockup index

| # | Surface | Audit row | Pattern |
|---|---|---|---|
| 0 | Contacts list | C2 | §3.3 card list (canonical reference) |
| 1 | Invoices list | C4 | §3.3 card list with money + status meta |
| 2 | Invoice line items | C5 / C6 | §3.9 stacked rows |
| 3 | Reminders inbox | H5 | §3.3 card list with channel-icon variant |
| 4 | Team members | H6 | §3.3 card list with role-pill meta |
| 5 | Roles & Permissions | H7 | §3.10 role accordion |
| 6 | Messaging | C1 | route-based view swap (`/messaging` → `/messaging/:id`) |

### Contacts card anatomy

The contacts mockup shows three states side-by-side: default list, bulk selection (sticky bar), filter drawer open. Card layout:

```
┌─────────────────────────────────────────┐
│ ☐  [Av]  Jane Doe                  ›   │
│          jane.doe@acmecleaning.com     │
│          ━━━━━━━━━━━━━━━━━━━━━━━━━     │
│          [Customer] [VIP] [tag]+1 2d   │
└─────────────────────────────────────────┘
```

- **Row 1:** checkbox · avatar · name · chevron
- **Row 2:** email (truncates with ellipsis)
- **Row 3 (meta strip):** lifecycle badge + up to 2 tag chips + overflow count + relative timestamp

Whole card is tappable → `/clients/contact/:id`. Checkbox stops propagation.

**Data parity with the desktop table:**

| Desktop column | Mobile card location |
|---|---|
| Checkbox | Row 1, leftmost |
| Name + email | Row 1 + 2 |
| Company | Pushed to detail page (kept off card to save vertical space; can be added to row 2 as `email · company` if needed) |
| Lifecycle | Row 3 badge |
| Owner | Pushed to detail page (or shown as small avatar in row 3 if needed) |
| Tags | Row 3 chips |
| Updated | Row 3 timestamp |
| Chevron | Row 1, rightmost |

If the user pushes back on hiding Company / Owner: add a small line under the email — `Acme Cleaning · Owner: Kyle` — but watch the vertical density. Default is to keep it lean.

---

## 6. Testing protocol

After any layout change, verify with this checklist before marking done:

1. **Resize verification at 5 widths:** 320, 375, 414, 640, 641 (the breakpoint boundary). Use the browser's responsive design mode or the preview tool's `preview_resize`.
2. **Scroll the page side-to-side at each width.** If anything moves horizontally, you've regressed.
3. **Open every modal at 375px** — confirm it fits with margin and the close button is reachable.
4. **Toggle the sidebar open + closed at 375px** — confirm no decoration pokes out.
5. **In the browser dev tools, run** `document.documentElement.scrollWidth === document.documentElement.clientWidth` — must be `true`. Add this as a Playwright/Cypress assertion if/when test coverage lands.

### Quick eval to spot offending elements

Paste in dev tools console at 375px width:

```js
[...document.querySelectorAll('*')].filter(el => {
  const r = el.getBoundingClientRect();
  return r.right > window.innerWidth + 1;
}).map(el => ({ el, w: el.getBoundingClientRect().right }))
```

Returns a list of every element whose right edge is past the viewport. Fix top-down — usually the parent fix cascades.

---

## 7. Edge cases / regression risks

These aren't broken right now but could regress, or have subtle behavior worth flagging.

1. **Money / number columns with `white-space: nowrap`.** When the column gets squeezed, the cell content stays wide and pushes the table. Either drop the nowrap on mobile or guarantee the table is replaced by cards on mobile (preferred — see §3.3).
2. **Avatar groups / tag chip rows.** If the count grows unbounded, the row will eventually exceed viewport. Always cap with `+N more` after 2–3 visible items in mobile contexts.
3. **Inline emails / IDs in copy.** Long unbroken strings need `overflow-wrap: anywhere`. Apply at `.email`, `.id-chip`, table cells, and any text-renders-arbitrary-user-input class.
4. **Calendar grids.** 7-column day grids are technically not overflowing but are unreadable below ~480px. Future work: agenda-list view for mobile, gated to the `Schedule` page.
5. **Charts / SVGs.** None currently overflow, but bar charts (`.rev-chart`) can grow unbounded with data. Always wrap charts in a clamped parent and use `viewBox` / `preserveAspectRatio` so they shrink instead of pushing width.
6. **Third-party embeds (future).** Stripe Elements, intercom widgets, etc. — wrap in `overflow-x: hidden` containers and verify on mobile when added.
7. **Data tables at zoom 200%.** Browser zoom effectively narrows the viewport. The card-list pattern handles this for free; tables don't.
8. **Right-to-left languages (future).** All sticky-bottom + sticky-side rules use `left/right`, not `inline-start/end`. If RTL lands, audit again.
9. **Notch / safe-area insets.** Sticky bottom bars must use `env(safe-area-inset-bottom)` (see §3.4). Otherwise the home-indicator chops the bar on iOS.
10. **iOS Safari `100vh` bug.** Don't use `100vh` for full-height containers on mobile — Safari's URL bar makes it overshoot. Use `100dvh` or `min-height: -webkit-fill-available`.

---

## Notes for shell maintainer

- Land §3 patterns into the shell `index.css` first — they're cheap and protective.
- Land §4 page-by-page conversions in dependency order: components first (`MobileCardList`, `ContactCardRow`, etc.), then page swaps.
- Bump `INITIAL_STATE.version` + `STORAGE_KEY` only if state shape changes. None of these fixes change state — version stays at v7.
- This doc is a snapshot. Re-grep line numbers when porting; they'll drift.
- Per-client themes (`theme-polishpoint.css`, future `theme-{client}.css`) **do not need any of these rules**. The fixes are theme-agnostic — they live in `index.css` and use token references.

---

*Generated 2026-05-03. Canonical home: shell repo (`Kronelius/shell-build`). Update whenever new mobile-shape patterns land in the shell.*
