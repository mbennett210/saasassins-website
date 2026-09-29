# MOBILE_QA — keeping mobile solid & uniform

> The mobile QA plan for this build (and every clone). Three automated layers + one
> manual pass, all **local, free, and reusable**. They answer three different
> questions — a page can pass one and fail another, so we keep all three.
>
> | Question | Layer | Tool | Command |
> |---|---|---|---|
> | Does it **fit**? (no h-scroll, nothing blank) | 1 · fit-gate | `responsive-sweep.mjs` (puppeteer-core) | `npm run lint:responsive` |
> | Does it **look** right — can I scan it? | 2 · contact sheet | same sweep, `--shots` | `npm run shots` |
> | Did it **stay** uniform? (regressions) | 3 · visual-regression | Playwright `toHaveScreenshot` | `npm run test:visual` |
> | Does the **whole app** look uniform across real devices? | 4 · manual | Responsively App | (desktop app) |

The **device/route matrix is shared**: viewports `375 · 820 · 1024` (phone · real-iPad
seam · landscape) across all layers, and the route list lives in
[`tests/routes.mjs`](tests/routes.mjs) (visual) + `scripts/app-routes.mjs`
(fit: every surface App.jsx routes to, read from the router). A clone inherits every layer for free — it only re-points the seeded
detail-route ids and regenerates baselines.

---

## Layer 1 — Fit-gate (already shipped)

[`scripts/responsive-sweep.mjs`](scripts/responsive-sweep.mjs) drives the real app at
5 viewports and **fails the build** on: horizontal scroll, a table hidden with no
`.mobile-card-list` replacing it (blank surface), or a table↔card row-count mismatch.
This proves the page *fits* — it does **not** prove it *looks* uniform (a 1px-perfect
layout can still be visually inconsistent). Run it with a `--mode demo` server up:

```bash
npm run dev -- --mode demo --port 5193      # in one terminal
npm run lint:responsive -- --url http://localhost:5193
```

## Layer 2 — Contact sheet (`npm run shots`)

The same harness with `--shots` captures one full-page screenshot per route × viewport
and writes a single **gallery** at `app/mobile-shots/index.html` (viewport tabs, grid of
thumbnails cropped to the top 540px, click-through to full). It's the *eyeball* layer:
open it and scan a whole viewport's worth of screens at once to catch spacing/alignment
drift the fit-gate can't see. Artifacts are gitignored (regenerate any time).

```bash
npm run shots -- --url http://localhost:5193
# → app/mobile-shots/index.html
```

## Layer 3 — Visual regression (`npm run test:visual`)

[Playwright](https://playwright.dev/docs/test-snapshots) captures a pixel baseline per
route × **device project** (`phone-375`, `ipad-820`, `landscape-1024` in
[`playwright.config.js`](playwright.config.js)) and **fails when a screen changes** —
the regression guard for every future re-skin. The spec
([`tests/visual/pages.spec.js`](tests/visual/pages.spec.js)) freezes the clock
(`page.clock.install`) so the seed's runtime-relative dates render identically every run.

```bash
npx playwright install chromium      # one-time: fetch the browser
npm run test:visual:update           # generate/refresh baselines (first run)
npm run test:visual                  # compare against baselines (the gate)
npx playwright show-report           # HTML diff report on failure
```

### ⚠️ Baseline determinism — the one thing that makes this robust vs. flaky
Playwright names baselines by **browser + OS** and pixels differ across OSes, so a
baseline generated on Windows (`-win32`) will **not** match Linux CI (`-linux`). Pick
ONE source-of-truth environment and commit only those baselines:

- **Recommended (portable):** generate + compare in the official Playwright **Docker**
  image (Linux), so local and CI produce identical pixels. Because host `node_modules`
  are win32/native, install fresh inside the container:
  ```bash
  docker run --rm -v "$PWD":/work -w /work/app \
    mcr.microsoft.com/playwright:v1.63.0-jammy \
    bash -c "npm ci && npm run test:visual:update"   # then commit tests/visual/__screenshots__
  ```
  (Tag must match the installed `@playwright/test` — currently **v1.63.0** — in `package-lock.json`. The config's
  `webServer` starts the dev server inside the container, so no host networking is needed.)
- **Local-only (quick, Windows):** run `test:visual:update` locally and treat the
  `-win32` baselines as a dev convenience — but the **committed / CI** baselines must be
  the Docker/Linux set, or CI will red-flag every run. Baselines that aren't the SoT go
  in `.gitignore`.

Wire `npm run test:visual` into the pre-push hook / CI **next to** `lint:responsive` —
fit + uniformity together. Tune `maxDiffPixelRatio` (currently 0.01) once baselines are
stable.

## Layer 4 — Responsively App (manual design pass)

[Responsively](https://responsively.app/)
([responsively-org/responsively-app](https://github.com/responsively-org/responsively-app),
open-source Electron browser) mirrors the running dev server across **30+ device frames
at once** with synced scroll/click, a shared element inspector, and one-click
screenshots of every device. Use it while styling to confirm the whole app reads
uniformly across real devices — the human companion to the automated layers.

1. Install from responsively.app (Mac/Windows/Linux) or the GitHub releases.
2. Start the demo server: `npm run dev -- --mode demo --port 5193`.
3. Point Responsively at `http://localhost:5193`; hot-reload is supported.
4. Add device profiles matching our matrix (iPhone SE/13 → 375, iPad Air → 820,
   iPad landscape → 1024) alongside its built-ins; scan every surface in one view.

---

## Adding a route or a device (reusable)
- **Route:** add it to [`tests/routes.mjs`](tests/routes.mjs) (visual). The fit sweep reads App.jsx
  itself (`scripts/app-routes.mjs`); a route that takes a parameter needs a stable seeded id in its
  `PARAMS` (`test-app-routes.mjs` fails until it has one, and the sweep fails a demo page that says "not found").
- **Device/viewport:** add a project to [`playwright.config.js`](playwright.config.js)
  and a row to `VIEWPORTS` in the sweep — keep the two matrices aligned.
- **New client clone:** everything above ships in the shell. The clone re-points seeded
  ids, runs `test:visual:update` in Docker once to seed its baselines, and commits them.

## Changelog
- **2026-09-12** — Created. Added `--shots` contact-sheet mode to the fit-sweep; scaffolded
  the Playwright visual-regression suite (shared route matrix, device projects, clock-freeze,
  Docker baseline flow); documented the Responsively manual pass.
