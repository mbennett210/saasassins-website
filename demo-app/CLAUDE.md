# PolishPoint Platform — Build Notes

## CRITICAL — File modification rule

**When a file changes, write the FULL file. Do not use partial/patch-style edits.**

Every modified file must be emitted as a complete replacement (Write tool, not Edit). This applies to source code, CSS, markdown, JSON — every file type. Reasoning: partial edits create cross-machine inconsistency risk when multiple workstations sync the repo; a fully-replaced file is unambiguous in git diffs and unambiguous on pull. **No exceptions.**

(System default prefers Edit for diff size; this project's rule overrides that default.)

## Doc set (read in this order at session start)

1. **`CLAUDE.md`** (this file) — stable project context, conventions, file map. Auto-loaded.
2. **`HANDOFF.md`** — session-to-session continuity: what just shipped, open issues, suggested next pickup.
3. **`SHELL_ROADMAP.md`** — living roadmap with sprints + per-module Definition of Done checklists. Source of truth for what's done / in progress / pending.
4. **`UI_RULES.md`** — cosmetic + interaction rules (container hygiene, persistent bulk bars, click-target ergonomics, toast policy, etc). Read before adding/modifying UI.
5. **`app/src/STYLING.md`** — token vocabulary + three-bucket rule for colors/radii/shadows/typography. UI rules read from this vocabulary.

## Session Start Checklist (do this FIRST, every session)
Before responding to any request in this folder:
1. **Verify a proper git clone exists.** Run `git rev-parse --is-inside-work-tree` and `git remote -v`. If either fails or no `origin` remote is set, STOP and tell the user — do not proceed with work until the clone is sound.
2. **Sync with GitHub.** Run `git fetch` and compare local `HEAD` to `origin/<current-branch>`. Report the result (up-to-date, ahead, behind, or diverged).
3. **If behind and the working tree is clean**, offer to fast-forward before continuing. If ahead or diverged, flag it — don't auto-push or auto-merge.
4. **Read `HANDOFF.md`** for session continuity (what just shipped, what's next, gotchas).
5. **Read `SHELL_ROADMAP.md`** to know the active roadmap state — find the next `[ ]` and read its Definition of Done before starting.
6. Only after reporting sync status + reading both docs should you start on the user's actual request.

## Session End / As Work Lands
- **Tick off DoD items** in `SHELL_ROADMAP.md` (`[ ]` → `[x]`) the moment a piece ships — don't batch.
- **Bump seed version + storage key in lockstep** when state shape changes: `INITIAL_STATE.version` in `seed.js` AND `STORAGE_KEY` in `persist.js`. Currently on **v38** / `'pp.store.v38'`.
- **At session end, refresh `HANDOFF.md`** with:
  - What shipped this session (entities, files touched, biggest diffs)
  - Open issues / partial work / blockers
  - Suggested next pickup point (usually the next `[ ]` in SHELL_ROADMAP)
- **Commit in logical chunks when the user asks** (don't auto-commit). When the user does ask, **default to splitting by concern** (feature / mobile / docs / refactor / etc.) and execute — don't ask "split or single?" Project log shows single-purpose commits as the norm; that's the precedent. Only stop to ask when the chunks would be unusually small or the boundaries are genuinely ambiguous.

## Pre-commit visual verification (mobile-responsive screenshot pass)

Before committing **any change that touches a UI surface** (component, page, theme, CSS — anything the browser renders), run a mobile-responsive screenshot pass to confirm the change ties properly and stays visible/convenient at iPhone-class viewports. This is the gate that prevents the slow accumulation of broken-mobile state that requires a multi-hour fix-up exercise after the fact (see [`SHELL_MOBILE_RESPONSIVE.md`](SHELL_MOBILE_RESPONSIVE.md) for the contract being enforced).

**Timing — IMPORTANT:** This pass fires **only at commit time, not during development.** Build the core feature/fix first without worrying about mobile responsiveness — that's how we keep iteration cheap and avoid burning tokens on incremental visual checks. Once the change is ready to commit, run the pass; if mobile breaks, fix it in the same commit before pushing.

**Protocol** (use the `preview_*` MCP tools — never ask the user to verify manually):

1. Resize the preview to each viewport in turn:
   - **320×568** — iPhone SE 1st gen (the floor; layout must be sane)
   - **375×812** — canonical baseline (iPhone SE / 13 mini class)
   - **641×800** — desktop boundary (confirm no regression to the desktop layout)
2. At each viewport, navigate to every surface the change touched, plus any surface that *consumes* the changed component, and capture a `preview_screenshot`.
3. At each viewport, run the no-horizontal-scroll assertion via `preview_eval`:
   ```js
   document.documentElement.scrollWidth === document.documentElement.clientWidth
   ```
   This must return `true`. Zero horizontal scroll is a hard rule from the spec.
4. Verify by eye: nothing truncates mid-word inside CTAs/pills, no element overlaps another, popovers/modals fit inside the viewport, action buttons remain reachable.

**Exempt from this pass** (no screenshot signal to gain):
- Pure logic changes — reducer/selectors/seed/storage migration/permissions/lib utilities/comments
- Test-only or doc-only commits
- Refactors that produce identical render output

If a commit is exempt, note it briefly in the commit message ("logic-only — mobile pass deferred") so a future visual sweep can be scheduled if needed. **When in doubt, run the pass.** Tokens spent here are an order of magnitude cheaper than the next "mash + jumble" rescue.

## Project status

This is the **master shell build** — a reusable foundation we deploy to every client. The primary product lives in `app/` — a React + Vite SPA with a real data model, router, state store, and permission system. Seed data is genericized ("PolishPoint" company + 8 placeholder team members) so the shell clones cleanly; per-client onboarding overwrites the company entity, team roster, and brand via `app/src/brand.config.js` + `theme-<client>.css`.

Add-on packages (IPR, QuickBooks, Inventory Management, EMS, Field Ops) are listed in `SHELL_ROADMAP.md` for shell continuity but are **not built unless sold per client**.

### Active roadmap

The active build plan lives in [`SHELL_ROADMAP.md`](SHELL_ROADMAP.md) — read it at session start. It is the source of truth for what's done, in progress, and pending. **Update it as items land** (flip `[ ]` → `[x]`).

Current focus: the **CORE** section of the roadmap. Everything below the CORE section is unsold and frozen.

### Build depth expectation

When implementing a roadmap item that's IN scope (Core), build it **production-shaped, not placeholder-shaped**. A module is not done until every surface in its Definition of Done is built, wired, and verified. Default to extensive — entity + reducer + selectors + every UI surface + permissions + activity logging + edge cases + storage-key bump — in one pass.

**Do NOT speculatively build unsold add-on items.** If an unsold module gets requested, push back: confirm it's been sold before starting.

### Deployment model (post-shell)

Once shell Core is complete:
1. Commit finished shell to `Kronelius/shell-build` as the canonical baseline.
2. For each new client: create a repo under the **client's GitHub credentials** (e.g. `<ClientOrg>/app`), push shell as initial commit, add **Kronelius as collaborator** with admin/write access for ongoing maintenance.
3. Per-client work is config + data only (theme, services, users, content, migrations) — never code forks. Bug fixes and feature backports flow shell → client repos as PRs from Kronelius.

## Primary files

| Path | Purpose |
|---|---|
| `app/` | React + Vite SPA — the real product. `npm --prefix app run dev` serves it on port 5173. |
| `app/src/App.jsx` | Router. All routes are guarded by `<RequirePerm>`. |
| `app/src/store/` | Context + reducer store. `reducer.js` is the complete action surface; `selectors.js` is the read-only surface; `persist.js` handles localStorage with version-gated reseeds (currently `pp.store.v38`). |
| `app/src/data/seed.js` | INITIAL_STATE — company, users, services, clients, contacts, tags, invoices, jobs, connectedInboxes, marketing (inboxes/sequences/enrollments/sends/replies/settings), etc. Bumps `version` when schema changes to force a fresh reseed. |
| `app/src/lib/roles.js` | Role labels, permission keys, `can(user, permKey, permissions, overrides)` checker. `can()` falls back to `PERMISSIONS[key].defaultRoles` when a key isn't in the live matrix. |
| `app/src/hooks/usePermission.js` | Hooks that wire `can()` to current user + overrides. |
| `app/src/pages/Clients.jsx` | CRM hub (mounted at `/contacts`). 2 sub-tabs: Contacts (default), Accounts. |
| `app/src/pages/Pipeline.jsx` | Standalone Kanban board at `/pipeline`. Wraps `components/PipelineBoard`. |
| `app/src/pages/Marketing.jsx` | Cold-email module at `/marketing`. 4 tabs: Sequences / Inboxes / Replies / Settings. Tab bodies in `pages/marketing/*`. Powered by `lib/marketingScheduler.js` + `lib/connectedInboxes.js` (stub-capable). |
| `app/src/pages/ContactDetail.jsx` | Full contact profile. Tabs: Overview / Activity / Related / Notes. |
| `app/src/pages/ClientDetail.jsx` | Account profile. Tabs: Overview / Contacts / Sites / Service History / Invoices / Notes. |
| `app/src/pages/settings/` | Account, Company, Services, Team, TeamDetail (with per-user permission overrides card), Roles (permission matrix), Notifications. |
| `app/src/components/` | Shared UI primitives + domain components (TagChip, TagPicker, ContactPicker, AddContactModal, VisibilitySelect, PipelineCard, PipelineBoard, DetailHeader, FormField, Modal, ConfirmDialog, Toast, Badge, Avatar, Icon, EmptyState, UserSwitcher, RequirePerm). |
| `app/src/theme.css` | Token vocabulary — tokens → aliases → recipes. See `app/src/STYLING.md`. |
| `app/src/STYLING.md` | The styling contract. Respect the three-bucket rule. |
| `app/UI_RULES.md` | Cosmetic + interaction rules (layout, selection bars, click targets, toasts, etc). Update this file when establishing a new UI pattern. |
| `shell.html` | Original static HTML wireframe. Kept for reference only — **the live product is `app/`**, not this file. |
| `app/src/theme-polishpoint.css` | PolishPoint Blue theme — the active shell baseline. Swap for `theme-<client>.css` per per-client deployment. |
| `app/src/brand.config.js` | Single source of truth for non-CSS brand surfaces (name, primary hex, logo filename). Consumed by `vite-plugin-brand.js` (index.html), `scripts/build-manifest.mjs` (manifest.json), `scripts/gen-pwa-icons.mjs` (PWA icons), and `lib/documentTitle.js`. |
| `theme-polishpoint-blue.css` | Repo-root canonical PolishPoint Blue palette reference. |

## Running the app

```bash
npm --prefix app install    # first time
npm --prefix app run dev    # http://localhost:5173
```

Dev-server preset is in `.claude/launch.json` as `polishpoint-app`.

## Data model notes

- **`Contact`** is the person-level CRM entity. `email` is the unique identifier. Contacts can be attached to a company (`companyId`) or stand alone as leads / prospects / vendors.
- **`Client`** (aka Account in the UI) is the company/billing entity. Has `primaryContactId` pointing at the designated person.
- **Cross-module FKs**: invoices have `billingContactId`, sites have `siteContactId`, conversations have `contactId`. All optional.
- **`Tag`** entities have scope `contact` / `client` / `all` and a color alias (maps to Badge variants).
- **`userPermissionOverrides`** is a sparse list `[{ userId, grants, revokes }]`. Empty rows are pruned on save.
- **Schema versioning**: bump `INITIAL_STATE.version` in `seed.js` AND the `STORAGE_KEY` in `persist.js` when you change the shape. A version mismatch forces a fresh reseed from INITIAL_STATE.

## Navigation conventions

- **Back arrows return to where the user came from.** `DetailHeader` reads `location.state?.from` and falls back to the `backTo` prop only when the user arrived via direct URL / refresh.
- **Every link or `navigate()` call that opens a detail page must carry a referrer.** At the top of the component, call `const nav = useFromHere();` (from `app/src/hooks/useFromHere.js`), then pass `state={nav}` on `<Link>` or `{ state: nav }` as the second arg to `navigate(url, ...)`. Skipping this silently regresses the back button for that entry point.
- **List pages keep filter state in the URL** (`useSearchParams` with `replace: true`), not `useState`. This is what makes the referrer meaningful — Back restores the exact filtered view. When adding a new filter to Clients / Invoices / Schedule, extend the `setParam` pattern already in place. Top-level nav clicks (sidebar → `/schedule`, `/invoices`, etc.) do NOT need `state={nav}` — only deep-links to a specific record do.

## Permissions cheat sheet

Roles: `owner` (Super Admin in UI) / `admin` / `crew`. Defaults are in `lib/roles.js`; the live matrix lives in `state.permissions` and is editable at `/settings/roles` (Super Admin only). Overrides grant or revoke permissions per user; `can()` resolves revoke > grant > role default.

Key CRM perms: `contacts.view`, `contacts.view.all`, `contacts.edit`, `contacts.edit.own`, `contacts.delete`, `contacts.assignOwner`, `tags.manage`, `pipeline.view`, `pipeline.edit`. Super Admin gates: `staff.assignRoles`, `staff.editOverrides`.

## Design system

- Tokens + aliases + recipes only — no hardcoded colors, no inline hex. See `app/src/STYLING.md`.
- Badge color variants: `green` / `amber` / `red` / `blue` / `slate` / `purple`. Reused by tag chips.
- Token vocabulary is shared with the Swatchboard. Reference files:
  - `C:\Users\danie\Documents\PolishPoint\Blue\theme_polishpoint_blue_swatchboard.html`
  - `C:\Users\danie\Documents\PolishPoint\Blue\blue-theme-mockup.html` (legacy visual reference, not canonical)
