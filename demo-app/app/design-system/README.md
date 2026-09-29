# The Clean Space design system

The reference every screen and every future build is made from: tokens, type, the component
kit, the brand book and the rule registry. It is published as a claude.ai **Design System
artifact** (title "Clean Space"; shared by link, which its page's Share menu can change):

https://claude.ai/artifact/KgZR5ZmuYEB7Dy9et6yTky

It is a **mirror of the code, never a second source of truth.** Every value is read from the app
(`app/src/theme*.css`, `app/src/index.css`, `app/src/components`), and `test-design-system.mjs`
fails the build the moment the code and this folder disagree.

## What lives here

| Path | What | Edited by |
|---|---|---|
| `tokens.config.json` | Which `:root` variables are published as tokens, in what order, with what usage note; which are recipes; which CSS rule each text style is read from. **No values.** | hand |
| `tokens.json` | The token snapshot the generator writes from the live cascade. Committed so a theme change shows up as a diff and the gate can compare. | generated |
| `components.json` | What the bundle (`window.CleanSpace`) exports, which exports get a card, which cards are CSS showcases. | hand |
| `rules.json` | Every numbered rule in `UI_RULES.md`, `THEME_CLEANSPACE.md`, `STYLING.md` and `STRUCTURE.md`, classified by what holds it: gated / checked / construction / review / superseded. | hand (L2) |
| `controls.json` | The control ledger (UI_RULES §128): the kit's control classes, and every other clickable control family classified as a row, card, nav, variant or exception, with the reason. Rendered to `guidelines/controls.md`. `test-control-ledger.mjs` (CI) fails an unclassified or stale family. | hand |
| `assets.json` | The artifact's uploaded logos, app icons and icon SVGs (blob ids). | hand, after an upload |
| `content/` | The brand book (`README.md`), `guidelines/`, every component card (`README.md` + `preview.html`), `index.d.ts`, asset-group notes, the cover. | hand |
| `dist/` | Everything the artifact serves, rebuilt from source. Gitignored. | generated |

## The one command

```bash
npm --prefix app run design-system
```

Reads the cascade, rebuilds `tokens.json`, bundles the kit with the app's own bundler (rolldown,
react-router replaced by an inert stand-in), ships `app/src/index.css` whole as `bundle.css` behind
the recipe layer, renders every Icon glyph to SVG, copies `content/`, and renders `rules.json` into
`guidelines/rules.md`. It refuses to run while a `:root` variable is unclassified.

## The gate

`app/scripts/test-design-system.mjs` runs in `run-tests` (so in CI). It fails when:

- **a theme value changed**, including a phone-only value in an `@media … { :root }` block (kept in
  `tokens.json`'s `meta.responsive`), and `tokens.json` wasn't regenerated → run the command, commit `tokens.json`;
- **a `:root` variable is new** → add it to `tokens.config.json` as a token (with a usage note) or
  under `recipes`, then run the command;
- **a type role's CSS rule vanished**, or a token lost its usage note;
- **a kit component's prop names changed** and `content/components/index.d.ts` doesn't list the same
  names (types are not compared) → update the types and that card's README;
- **a card, showcase or exported file is missing**, or a content folder belongs to nothing;
- **a rule heading was added, retitled or removed** in one of the four rule docs and `rules.json` wasn't
  updated → classify it (trace the check that holds it, or mark it review), or remove the entry;
- **an entry cites a check that doesn't exist**, or says "gated" without citing a check CI runs (a suite
  `run-tests.mjs --list` prints, or a lint `.github/workflows/ci.yml` runs).

## Changing the theme or the kit safely

A token migration (a literal becoming `var(--token)`) must change nothing on screen. Prove it:

```bash
npm --prefix app run dev -- --mode demo --port 5393
node app/scripts/style-snapshot.mjs --url http://localhost:5393 --out before.json.gz
# … make the change …
node app/scripts/style-snapshot.mjs --url http://localhost:5393 --out after.json.gz
node app/scripts/style-snapshot.mjs --diff before.json.gz after.json.gz
```

The snapshot records every element's box and 59 computed properties on every surface App.jsx routes
to (`scripts/app-routes.mjs`, 43 paths today) at 1280 and 375px (clock frozen, randomness seeded,
animations off), so the diff must read "identical".

## Rules: how to add one

A new numbered section in `UI_RULES.md` (or a new `R`, STYLING rule or STRUCTURE section) fails
the gate until `rules.json` classifies it. Classify from evidence: open the check you cite and
confirm it exercises the rule; say "review" when nothing does. The gate compares a rule's heading,
not its body: when you rewrite what a rule says, re-check its entry by hand. STYLING.md counts only
its numbered "Rules (enforced)" list; its prose rules (naming, aliases, recipes) are not classified yet. `guidelines/rules.md` in the
published system is the readable form: it is the list of what is enforced and what is still
only a promise.

## Publishing

Publishing is a deliberate step, done by Claude with the Artifact tool (it needs the claude.ai
session, not a token). The artifact's `SKILL.md` is the contract; in short:

1. Run the command. Read the live artifact (`read` with its url), then its `project/design-system.json`
   and every file you may replace (`paths`), and compare them with `dist/project/`.
2. Upload any new icon or logo first (`dist/uploads/…`), then record its blob id in `assets.json`.
3. Copy only the files that differ under one folder at their `project/…` paths, plus the index with
   every key kept and `lastChange` updated (`via: "GitHub · Clean-space-admin/cleanspace@<sha>"`, or the
   local branch and sha before a push). Publish them in ONE call: `url`, `root` = that folder,
   `file_path` = the index, `files` = the rest (never `index.html`, `SKILL.md` or `artifact-type/`; the
   React files under `components/lib/` stay). Refused because the page saved meanwhile: read again,
   redo the diff, publish once more.

## A new client build

The structure, treatment, interaction rules and every check are shell-wide; only the brand (its
identity, colours and logos: UI_RULES §121, §129), copy and voice change per client. For a clone:
apply the client's brand pack (`brands/<id>/`, `npm --prefix app run brand -- <id>`; the guide is
`REBRAND.md`), which writes the theme's palette, BRAND, the manifest, the select chevron, the token
snapshot and the logos; `npm --prefix app run colors` and `npm --prefix app run names` must report 0
leaks. Then rewrite `content/README.md` and the asset notes for the new brand, re-run the command, and
create a new Design System artifact for that client from the same `dist/`.
