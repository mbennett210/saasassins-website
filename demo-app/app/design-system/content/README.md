Clean Space is the operations app a commercial cleaning company runs on: schedule the cleans, message customers and crews, track time and variance, invoice. The brand is **black and gold, flat**: black frames, gold marks, navy links, white cards on a cool slate ground. Everything here is taken from the live app, so a screen built with it looks like the product.

## Voice and copy

The app talks like a good operations manager: short, specific, calm. It says what happened or what to do next, and nothing else.

- **Name things the way the business does.** A *Customer* is a company (never "Account"); its people are *contacts*. A scheduled job is a *clean*; the people doing it are the *crew* or a *cleaner*; where it happens is the *location*. Managers supervise customers; the owner role reads *Super Admin*.
- **Title Case** for page titles, nav rows, modal titles and CTA buttons: "Add Customer", "Record Payment", "Save Changes", "Mark Paid". **Sentence case** for everything else: field labels (CSS uppercases the small ones), help text, toasts, empty states, menu options.
- **Buttons are verbs**, with their noun when they open or create something ("Add Invoice", "New Job"). No "+" prefix and no plus icon. Small in-context actions stay short: "Edit", "Cancel", "Copy link", "Try again".
- **Toasts confirm saves** in the past tense, two or three words, no exclamation marks: "Note added", "Job updated", "Tag added". Status changes, toggles and bulk actions don't toast.
- **Errors say the fix**, as an instruction: "Enter an amount", "Enter a valid email address.", "Pick an employee", "Could not read that image."
- **Empty states** name what's missing and the next step: "No customers yet" / "Add your first customer, or Import CSV to bring in your whole book." A quiet day reads "You're all caught up. Nothing waiting on you."
- **Confirmations** name the thing and the consequence: "INV-1047 and its 2 payments will be removed. This can't be undone."
- **"You"** for the reader ("You don't have permission to assign roles."). When a control is off, it says why in visible text under it, never only in a tooltip.
- **Numbers**: money always shows cents ("$3,080.00") and stacks in tabular figures; dates are short ("Sep 23"); time ranges read "6:00 PM – 8:30 PM"; durations "2h 30m".
- **No emoji** in the product. Two setup warnings carry a ⚠️; carets, closes and checks are the text glyphs ▾ × ✓ and the back pill's ←. (The customer-facing quote document is a separate surface and uses emoji bullets; don't bring them into the app.)

## Colour

Ink, gold and navy on a cool slate ladder. Component CSS reads tokens only; there is no hex outside the theme.

| Role | Token | Value |
|---|---|---|
| Brand black: primary buttons, header bands, headings on gold | `color-brand-primary-500` (`primary`) | #18181b |
| The sidebar rail, the login backdrop, ink on the gold pill | `color-brand-primary-700` (`primary-deep`) | #09090b |
| Gold: CTAs, the active nav pill, the active tab underline, highlights | `color-brand-secondary-500` | #ffd45a |
| Navy: links and tappable names | `color-link` | #283ca1 |
| L1 page ground | `color-surface-base` (`page-bg`) | #f4f5f7 |
| L2 cards, tables, modals | `color-surface-raised` (`card-bg`) | #ffffff |
| L0 wells, row-card containers | `color-surface-sunken` (`inset-bg`) | #e8ebef |
| Hairline on every card, table, field | `card-border` | #e4e7eb |
| Headings and values / body / faint | `text-primary` / `text-body` / `text-faint` | #0f172a / #1e293b / #475569 |

- **Black frames, gold marks, navy links.** Black carries structure: primary buttons, the black header band on every data table, the rail. Gold marks what is live: the active nav pill, the affirmative CTA, the active section tab, table-row hover (`table-row-hover`, 18% gold), the search highlight. Highlights and active states are always gold; orange is never a brand colour (the orange accent tokens are unused).
- **Gold takes ink, never white.** Gold is light: text on it is `color-brand-primary-500` or `-700` (12.5:1 and 14:1). On white it separates by only 1.4:1, so gold never carries meaning on its own.
- **There are no green buttons.** The affirmative button is gold (`.btn-gold`, and `.btn-success` renders the same gold). Green is status only.
- **Status colours are constant** and never re-themed: success `#059669`, warning `#b45309`, error `#b91c1c`, neutral slate `#64748b`. Map them through the helpers (`statusBadgeVariant`, the variance `flagBadgeVariant`), never by hand. Status always shows its word too. Review stars are amber the same way (`rating-star`; `rating-star-empty` for the unfilled ones).
- **Documents and emails wear the brand too.** The quote, the inspection report (in the app, on its public link and as a PDF) and the emails the app sends take their colours from these tokens: black bands, table heads and headings; gold as a fill, never as text (on white it separates by 1.4:1); status colours as above. A new brand changes them with the app (UI_RULES §121).
- **Surfaces separate by elevation, not shadow.** Page L1, cards L2, wells L0 (THEME_CLEANSPACE R1, R6). Nothing sits on a parent of its own colour: white row-cards go in an L0 container or are tinted by status; a white panel inside a white modal steps down to L0 or takes a hairline. The hairline is the minimum separation, never zero.
- **Schedule rows are tinted by status** (`sched-card-*-bg` and `-bd`) with a 4px rail in the status colour: green done, amber in progress, red missed, gold upcoming.
- **Contrast.** Text on every surface clears 12:1 (`text-primary` and `text-body`); `text-faint` holds 7:1. The app keeps a few pairs below AA, noted on their tokens and kept exact here: white on the green badge and green text on white (3.8:1), the yellow badge (3.6:1), placeholders (2.3:1, deliberately faint), the off toggle track (1.5:1), hairlines (1.2:1). Never let colour alone carry those meanings.

## Type

**Poppins** (400, 500, 600, 700, from Google Fonts) for everything, form controls included (they inherit the page's family; a bare button once rendered in the browser's Arial), falling back to the system sans. Titles are Poppins at 700; there is no second face in the product.

- Scale in use: 10, 11, 12, 13, 14, 16, 20px from the tokens (`font-size-2xs` to `font-size-xl`; 12px is `font-size-xs2`, for small buttons, tag chips, the back pill and empty-state copy), plus sizes the CSS writes directly: 9px (rail caps, `type-rail-caps`), 22px (detail titles) and 28px (stat values). Feature CSS also still writes 12px and off-scale sizes (15, 17–19, 21, 24, 26, 32px and half-pixel steps).
- Body is 14px (`type-body`), table cells 13px, field labels 11px/600 uppercase at 0.04em (`type-label-caps`), page titles 20px/700, modal titles 16px/700, stat values 28px/700 at −0.01em.
- Inside a card there is one value size and one sub-head style; a label demotes by weight and colour, never by a smaller size (UI_RULES §112).
- Uppercase is for labels and eyebrows only, with tracking (0.04em labels, 0.06–0.08em micro caps). Never set a sentence in caps.
- Number columns use `font-variant-numeric: tabular-nums` (`.money`).
- Fields render at 16px on phones (`font-input-size`) so iOS never zooms.
- The eight script faces in `type.families` (Allura, Alex Brush, Yellowtail, Satisfy, Dancing Script, Mr Dafoe, Herr Von Muellerhoff, Rouge Script) exist only for type-to-sign signatures, rendered at 52px.

## Space and layout

- **A 4px token grid, with role aliases for new work.** The gaps: 8px inline (`gap-inline`), 12px between controls (`gap-control`), 16px for stacked blocks (`gap-card`, read today only by the sheet body; page cards still stack 14px apart, detail cards 12px), 24px between sections (`gap-section`, not read yet). Padding: 20px in a card (`card-pad`), 24px in a modal (`card-pad-lg`), 16px in a dense card (`card-pad-sm`, not read yet).
- **The shell**: a 240px black rail on the left (`sidebar-w`), a 52px top bar holding the global search (`topbar-h`), content padded 24px on top, 40px at the sides, 80px below.
- **Page scaffolds.** List: page head, filter bar or table controls, the table, the pager. Detail: the detail header, section tabs, then cards (`.detail-grid`, 2fr and 1fr). Settings: the page head, then one card of fields with its save button. Copy a scaffold; don't improvise structure.
- **No pointless nesting.** A table, stat grid or list already has a frame: don't wrap it in a card, and keep its heading outside, above it (UI_RULES §1, §2).
- **Alignment.** One control height per toolbar row; a row action lives in its own reserved trailing column so every button of its kind forms one vertical line (THEME_CLEANSPACE R4).
- **Breakpoints**: 640px and below is a phone (tables become stacked cards, filter bars become a "Filters (N)" sheet, pickers open as bottom sheets, the rail becomes a drawer and a floating glass nav appears); 900px stacks detail grids; 1024px separates tablet from desktop. Stat grids auto-fit rather than fixing a column count.

## Shape and depth

- **Radii**: 10px on buttons and fields (`btn-radius`, `input-radius`), 20px on cards, tables, modals and filter bars (`card-radius`), 12px on stat tiles and timeline cards, and full pills (`badge-radius`) for badges, chips, segmented tracks, avatars, toggles and the back pill.
- **Flat.** Hairlines carry hierarchy. No gradients, glows or drop shadows on surfaces. One overlay shadow, `shadow-overlay` (the `shadow-lg` step), for anything floating: modals, menus (the pickers included), toasts, sheets, the search panel.
- **The one exception** is the phone's floating nav, a deliberate liquid-glass material (a frost gradient, blur and a soft shadow) scoped to that nav alone.

## Controls and states

- Heights: buttons 32px (`btn-height`, the `control-height-sm` tier), 28px `btn-sm` (`btn-height-sm`) only in table rows and dense clusters. A few contexts set their own: the clock control (42 and 56px minimum), on phones the Messaging header (44px), and the message-pane actions (28px squares when the pane is 640px or narrower). Fields and select triggers are 43px (`9px 12px`, a 2px edge, 14px text); on phones fields and select triggers are 46px with 16px text, so iOS never zooms (one declared shape, UI_RULES §109). Toggles are 36×20, the Roles grid's three-state switch included. An icon-only control is a 28px square (40px on phones): white with a hairline, quiet (no edge until hovered), danger (removes a row, with the trash icon) or filled black. A surface closes with a 28px grey circle holding a ×; a chip's ×, a search field's clear and a thumbnail's corner × are the three small glyphs (UI_RULES §123). A clickable pill is a chip: 32px, 13/600, white with a hairline, black when on; 28px in a row or a dense picker (UI_RULES §124). Adding an item where the items live is a dashed add tile: 1px `border-mid`, 10px corners, a 13/600 black label (UI_RULES §125). A text action is a navy link inside the text (`.linklike`) or a 32px text button (`.btn.btn-link`) in a toolbar or panel head (UI_RULES §126). A menu row is 14px with `8px 12px` padding, washed on hover and tinted when chosen; in a phone sheet it is a 48px row (UI_RULES §127). Checkboxes are a custom 20px box (6px corners, a 1.5px `border-mid` edge, a 36px hit area) that fills ink with a white tick when checked.
- Hover: filled buttons and link tiles lift 1px; black deepens to `primary-hover`, gold to `color-brand-secondary-600`; rows take an 8% ink or 16 to 18% gold wash.
- Focus: a field turns white with a 2px ink edge and the one field ring, `input-focus-shadow` (2px of `focus-ring-color`, brand ink at 60%, at least 4.37:1 on every surface a field sits on); the select trigger and the table search take the same ring. A checkbox takes a 3px `primary-soft` ring; buttons, icon squares, closes, chips and add tiles take a 2px ink outline at a 2px offset.
- Disabled: 50% opacity at the same height. A control the server would refuse for this viewer is off, with the reason written under it.

## Motion

Small and quick. Colour and border transitions run about 0.15s; filled buttons and link tiles lift 1px on hover; a modal's scrim fades in over 0.15s while the card slides up 10px over 0.2s; bottom sheets slide up over `duration-base` with `ease-out`. Nothing loops or decorates. Under reduced motion the phone search's morph is instant.

## Iconography

- One set: the `Icon` component's 49 hand-picked glyphs on a 24px grid, stroked at 2px with round caps and joins in `currentColor`, so an icon takes its text colour. Most paths follow Heroicons' outline geometry, drawn heavier. Four glyphs are filled (phone, mail, messaging, grip); `dollarCircle` draws its "$" as text.
- Sizes: 20px in the nav and by default, 14 to 15px for chevrons and the search magnifier, 12px inside small buttons, 28px in empty states. Nav icons use `vector-effect: non-scaling-stroke` so the stroke is a crisp 2px at any size.
- Icons categorise and label; they never stand in for a button's verb, and a create button never carries a plus.
- The glyphs ship as SVGs in the Icons group, and as `window.CleanSpace.Icon`.

## Logos

- On the black rail and other dark grounds: `cleanspace-logo.png`, the white lockup.
- On light grounds: `cleanspace-glyph-ink.png`, the mark in `#09090b`.
- App and home-screen icons: the App icons group, a white mark on the brand black.
- The logo sets "CleanSpace" as one word; running text says "Clean Space". Use the files as they are.

## Building with this system

- Load `tokens.css`, then `components/bundle.css` (the app's own stylesheet, which also imports Poppins). For components, load React 18 and `components/bundle.js`, which assigns `window.CleanSpace`.
- The app layers styling in three buckets. **Tokens** and **aliases** are in `tokens.json` (aliases are the `{…}` colours such as `primary`, `card-bg`, `text-body`, `inset-bg`). **Recipes** (gradients, rgba mixes, the flat treatment's "none" shadows, the glass nav) sit in the `:root` block at the top of `bundle.css`. Component CSS reads `var(--…)` only.
- Much of the system is a class API rather than components: `.btn` with a role, `.card` and `.detail-card`, `.table-wrap` over a plain `<table>`, `.input` with `.form-group` and `.form-label`, `.badge` with a variant, `.tab-container-line` with `.tab-btn`, `.filter-bar`, `.tl-*` for the schedule. The cards below show each with its real markup.
- Links and navigation inside the bundled components are inert (the app routes with react-router).

## Not synced

- **Structure defined but not yet applied.** `control-height-md` (36px, 40px on phones), `control-height-lg`, `border-width-lg`, `gap-section`, `card-pad-sm` and `focus-ring-offset` exist for the structure contract (`app/src/STRUCTURE.md` §1), but no rule reads them yet. Fields are sized by their padding (43px on desktop), not by a control height, and most feature CSS still writes numbers directly; the kit's own rules read the tokens for most heights, hairlines, gaps, paddings and overlay shadows but still carry literals (e.g. field and select-trigger padding 9px 12px, `.filter-bar` 12px 14px, `.toast` 12px 16px, `.page-head` gap 10px, 1px borders on `.btn`, `.modal-card` and `.sheet-head`). §1 also names `space-9`, `space-11`, `radius-control-alt`, `font-body-size` and heading sizes, which the app does not define.
- **Runtime geometry** the app sets from script, left out: `--cs-vh`, `--vv-top`, `--kb-inset`, `--pipeline-col-count`, `--pane-left`, `--pane-right`.
- `main-pad-bottom` (`calc(space-16 + space-4)`, 80px) stays in `bundle.css`.
- **Fonts** are Google-hosted in the app (Poppins, the signature faces); no font files are shipped.
- **Components.** Built from the app's source with its own bundler, read-only, for React 18, with react-router replaced by an inert stand-in. Not bundled, because they need the app's store, router or backends: the Sidebar (shown as markup), FloatingNav, MasterSearch, NotificationsBell, UserSwitcher, the entity pickers (TagPicker, ContactPicker, ClientPicker, ServicePicker, CrewPicker), BulkActionBar, and the domain modals and panels (NewJobModal, ClockControl, PipelineBoard and others).
- Left out as not brand: `app/public/icons.svg` (the Vite starter's social-icon sprite) and the mockup HTML files.
