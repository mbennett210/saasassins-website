# PolishPoint demo (saasassinsdev.com/polishpoint)

The live demo the SaaSassins site serves at `/polishpoint`: Clean Space's app, re-skinned to PolishPoint, running
login-free on sample data. `app/` and `brands/` are an export of Clean Space's committed code
(`~/Claude/Clean Space`) with a PolishPoint layer on top; `CLEAN_SPACE_BASE.txt` names the Clean Space commit.

The other Markdown files at this folder's root (HANDOFF, SHELL_ROADMAP, SHELL_MOBILE_RESPONSIVE, SUPABASE_READINESS,
UI_RULES, E2E_SECURITY_CHECK) and `shell.html`, `swatchboard/` and `theme-polishpoint-blue.css` describe the June
shell this demo replaced. They are history, not instructions.

## Bringing it up to date with Clean Space

```bash
git -C ~/Claude/"Clean Space" fetch          # only if origin/main should be newer
node scripts/sync-polishpoint-demo.mjs       # from the website repo's root; --ref <sha> for another commit
```

The script (read its header) exports Clean Space at the ref, carries over the files the demo owns, applies the
PolishPoint edits, installs, applies the PolishPoint brand pack with Clean Space's own brand step, swaps the result
into `demo-app/`, builds it and checks the bundle names no other brand and holds no key or backend address. Every
edit names the exact text it replaces: if Clean Space's code moved, it stops before touching `demo-app/` and names
the file. Update that line of `PATCHES` to the new text and run it again.

Never edit Clean Space's files in `app/` by hand: the next sync replaces them. A change to the demo goes in the
script's `PATCHES` or in one of the files the demo owns.

## What the demo owns (kept across syncs)

| Path | What it is |
|---|---|
| `app/src/demo/DemoLanding.jsx`, `demoLanding.css` | The public landing at `/polishpoint`: hero, Core platform, Modules, Book a call |
| `app/src/demo/modules.catalog.js` | The Core list and the module cards. Every card is a module that is in the live demo, with a link to its page; keep it in step with the app after a sync |
| `app/src/demo/demoConfig.js` | `ROUTER_BASE` / `APP_ROOT` (the app lives at `/polishpoint/demo`), `demoEntry()` (landing vs app vs an old deep link), the Book a call link |
| `app/src/demo/AnchoredPortal.jsx`, `anchoredPortal.css` | Draws a dropdown at the page's top level while its CSS still places it under its trigger (the bells, the messaging filters); `.claude/styling.json` names it a pop-up part |
| `app/src/demo/ToastLayer.jsx`, `toastLayer.css` | Clean Space's toasts at the page's top level, over the bars pinned to the bottom (the dock's button, the phone's floating menu, the hub's New request) and under any pop-up a person opens, one at a time on a phone, with room at a page's end while one shows |
| `app/src/demo/centering.css` | Clean Space's shared parts with their words in their middle in Poppins (counts, badges, tabs, chips, small buttons, avatars, the section tabs' underline), each part its own size; imported after `index.css` |
| `app/src/lib/assetUrl.js` | Prefixes runtime `/file.png` paths with the `/polishpoint` base |
| `brands/polishpoint/` | The brand pack (name, contacts, colours, logos, quote pages) |

## What the PolishPoint layer does

- **Login-free, shared demo.** Clean Space's `--mode demo` blanks every backend (`app/.env.demo`), so the app opens
  on the seeded data with no sign-in, and the user menu keeps its "Switch view (sandbox)" list: any team member
  (crew, admins, operations, account and supply managers) plus "Preview the customer hub". Clean Space's live app
  has individual logins; this demo must not.
- **Mounted on the site.** Assets under `/polishpoint/`, the landing at `/polishpoint`, the app at
  `/polishpoint/demo` (its own router root, so every `/` inside the app is the app's home). Old links such as
  `/polishpoint/schedule` are sent on to `/polishpoint/demo/schedule`. The service worker is not registered here.
- **No Clean Space build review.** The Review page, the NEW pills (desktop and phone), the Dashboard and Payroll
  layout-review banners and Report an issue are hidden; the webhook help reads `X-PolishPoint-Signature`.
- **Quotes and Marketing on** (Daniel's pick, 2026-11-05). Clean Space keeps them off. Reviews stays off.
- **Every panel and pop-up at the page's top level** (the styling rules, and Forge's file check on each sync's
  lines): the notification bells, the messaging filters, the messages dock, the menu's section panel and the toasts
  are portaled to `<body>`, each dismiss spares its portaled panel, and Clean Space's unused review mockup is left
  out. The toasts sit over the bars pinned to the bottom and under any pop-up, sheet or full screen a person opens
  (as Clean Space draws them), and while one shows the page, the hub and the phone menu get that much room at their
  end, so no button stays under it (Forge's `covered` measure).
- **Words in their parts' middle** (Daniel's pick, 2026-11-05). Clean Space's measures draw a fallback font; this
  repo's load Poppins, in which Clean Space's counts, badges, tabs and chips read 0.5 to 0.7px high. `centering.css`
  moves each part's words without changing its size, and the Pipeline icon's "$" is a path (an SVG `<text>` defeats
  Forge's icon measure). After a sync, run `styling_check`: a new or renamed part shows up there.

## Running and checking it

```bash
npm --prefix demo-app/app run dev -- --mode demo --port 5213   # http://localhost:5213/polishpoint (landing), /polishpoint/demo (app)
npm run build                                                  # what Vercel runs: the demo build + the static site into dist/
```

`?demo=reset` on any demo URL clears the browser's copy of the sample data and reseeds it.

Before shipping a sync, with `dist/` served the way `vercel.json` serves it (filesystem first, then
`/polishpoint/:path*` to `/polishpoint`):
- Clean Space's rebrand sweep, every route at phone and desktop width (run in `demo-app/app`; it needs Google
  Chrome): `node scripts/rebrand-sweep.mjs --url http://localhost:<port>/polishpoint/demo`;
- the landing and a sample of app pages at 1440, 375 and 320 wide: no sideways scroll, no console errors;
- the user menu's switcher, a cleaner's view, and the customer hub preview.
