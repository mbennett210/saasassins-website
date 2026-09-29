// check-bundle-stubs.mjs — the CS-010 / CS-038 regression gate (BUILD_INTEGRITY II.3).
//
// WHY THIS EXISTS. Production shipped the Quotes flow on a browser localStorage stub
// for weeks: the Vercel project built `npm run build:demo`, so `app/.env.demo`'s
// `VITE_QUOTES_STUB=1` was inlined and `quotesApi` ran with a null backend — every staff
// quote saved only to that browser, invisible to everyone else and to the customer
// e-sign link (CS-010). The same env-only switch let the integrations/team adapters and
// the Twilio connect/simulator engage their stubs in a hosted build (CS-038). No build
// gate stopped it. This is the Sept-1 payroll-loss class of bug wearing a different hat.
//
// WHAT IT ASSERTS. A *production* bundle must contain NO reachable browser-stub adapter.
// The fix (lib/quotesApi.js, integrationsApi.js, teamApi.js, twilio.js, and the CS-038
// remainder lib/email.js, connectedInboxes.js, oauthWorkspaces.js — all via lib/demoMode.js)
// gates every stub branch on the STATIC `import.meta.env.MODE`/`.PROD` that Vite inlines
// at build time, so in a production build (`MODE === 'production'`) the whole stub branch
// is dead code and esbuild removes it — sentinel string and all. A demo build
// (`MODE === 'demo'`, e.g. `build:demo`, and the demo/visual dev servers) keeps the stub
// and its sentinel. So the sentinels are PRESENT iff a stub is reachable.
//
// MARKERS (any present in a scanned JS asset => the build is stubbed => FAIL). They are
// string literals, so they survive minification, and they dead-code-eliminate out of a
// clean production build:
//   - cs-stub:<adapter>       explicit sentinel pushed from each stub-only code path
//                             (lib/demoMode.js markStub; DCE'd from a production build).
//                             This is the durable, going-forward signal.
//   - cs-build-nonprod:<mode> build-mode beacon (demoMode.js; MODE !== 'production').
//   - legacy stub-body strings ('weekly cleaning services', 'whsec_stub_'/'rlw_stub_',
//                             'Carrier rejected: number unreachable') — each lives ONLY
//                             inside a stub adapter body, so it is present in TODAY's live
//                             (pre-fix) bundle, which has no sentinels yet, and DCE's from
//                             a fixed production build. These make the check RED on the
//                             live site with no code changes, and never false-fail a fix.
//
// NOT used as gating markers:
//   - `var t=null` (PROD_ENV.md §7.3): the minified form of the quotes BACKEND folding to
//     null, but the same token appears in the production index chunk from unrelated
//     minified code (measured 2026-09-24) — it would false-fail a clean build.
//   - the stub localStorage keys (cleanspace_quotes_stub_v2 / _integrations_stub_v1):
//     they are ALSO exported from src/data/demoStubs.js (a stub-key list), which ships to
//     production regardless of whether the adapter stub is reachable — false positive.
//
// CS-398 (env inlining). Vite replaces a NAMED read (`import.meta.env.KEY`/`?.KEY`) with one
// value, but a WHOLE-OBJECT `import.meta.env` read with the ENTIRE env object literal — every
// VITE_-prefixed var, which on Vercel includes the deploy's system vars (VITE_VERCEL_GIT_*,
// commit author login, repo owner/slug/id, deployment ids, the observability config). This
// gate catches that leak two ways: (1) `--build` sets an UNREFERENCED VITE_ canary var and
// fails if its value reaches dist — only a whole-object read can pull an unreferenced var in
// (the fast source-side twin is test-env-inline-scan.mjs); (2) the `vite-vercel-env` marker
// below fails on any VITE_VERCEL_ key NAME in a scanned asset, which is what makes `--url`
// RED on today's live site (the store chunk carries the inlined object) and GREEN once the
// named-read fix deploys. No source references a VITE_VERCEL_ name, so it never false-fails.
//
// USAGE
//   node scripts/check-bundle-stubs.mjs --dist dist            # scan a built dir
//   node scripts/check-bundle-stubs.mjs --build                # build prod to a temp dir, scan, clean up (OFFLINE)
//   node scripts/check-bundle-stubs.mjs --url https://cleanspace-gilt.vercel.app   # scan the LIVE chunks (read-only GETs)
//   node scripts/check-bundle-stubs.mjs --dist dist --json     # machine-readable
//
// OFFLINE CONTRACT. `--dist` and `--build` never touch the network; `--build` shells out
// to `vite build` (offline). Only `--url` makes requests, and only read-only GETs of the
// public HTML + hashed JS assets. The run-tests wrapper (test-bundle-stubs.mjs) uses
// `--build`, so the offline suite never hits the network.
//
// EXIT 0 = no stub reachable. EXIT 1 = a stub marker was found (or the target is empty /
// unreachable). EXIT 2 = usage error.

import { readdirSync, readFileSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const APP_DIR = fileURLToPath(new URL('..', import.meta.url)); // app/

// ── the gating markers ────────────────────────────────────────────────────────
const MARKERS = [
  // Durable, going-forward: present iff a stub adapter code path is reachable in the build.
  { id: 'stub-sentinel',      re: /cs-stub:(quotes|integrations|team|twilio|email|connectedInboxes|oauthWorkspaces)/g, why: 'a browser-stub adapter code path is reachable (lib/demoMode.js markStub)' },
  { id: 'build-mode-nonprod', re: /cs-build-nonprod:(?!production)[a-z0-9_-]+/gi, why: 'the bundle was built in a non-production Vite mode (e.g. --mode demo)' },
  // Legacy stub-body strings — catch a PRE-FIX bundle (e.g. today's live site) with no
  // sentinels. Each is stub-adapter-body-only and DCE's from a fixed production build.
  { id: 'legacy-quotes-stub',       re: /weekly cleaning services/g,             why: 'the Quotes localStorage stub body is bundled (CS-010)' },
  { id: 'legacy-integrations-stub', re: /whsec_stub_|rlw_stub_/g,                why: 'the Integrations webhook stub body is bundled (CS-038)' },
  { id: 'legacy-twilio-stub',       re: /Carrier rejected: number unreachable/g, why: 'the Twilio simulated-delivery stub body is bundled (CS-038)' },
  // Team-login stub (CS-038). `stub_${Math.random` is the createTeamLogin stub id — unique to
  // teamApi (the integrations stub ids are `whsec_stub_`/`rlw_stub_`, above). teamApi never
  // faked at runtime (its STUB was false in prod), but the guarded-`env` alias didn't fold in
  // Vite 8, so the dead stub body SHIPPED; the mode-first optional-chained gate DCEs it now.
  { id: 'legacy-team-stub',         re: /stub_\$\{Math\.random/g,                why: 'the team-login stub body is bundled (CS-038)' },
  // Email-backend family (email / connectedInboxes / oauthWorkspaces) — the CS-038 remainder.
  // Each string lives ONLY inside that adapter's stub body, so it is present in a pre-fix
  // bundle (stub reachable) and DCE's from the fixed production build. `ws_${Math.random`
  // is the Workspaces register-stub id (the seeded ids are the static `ws_seed_*`, which
  // stay — so this pattern matches only the stub, never the seed).
  { id: 'legacy-email-stub',        re: /Recipient mailbox bounced \(simulated\)/g, why: 'the email send-simulation stub body is bundled (CS-038)' },
  { id: 'legacy-inbox-stub',        re: /stub\.marcus@/g,                        why: 'the Connected Inboxes connect-stub body is bundled (CS-038)' },
  { id: 'legacy-workspaces-stub',   re: /ws_\$\{Math\.random/g,                  why: 'the Google Workspaces register-stub body is bundled (CS-038)' },
  // CS-398 — a Vercel system-env key name in a scanned asset means a whole-object
  // `import.meta.env` read inlined the entire env object (the deploy's git/commit/repo/
  // observability vars). No source references a VITE_VERCEL_ name, so a clean build never
  // trips it; it is PRESENT in today's live store chunk and DCE's from the named-read fix.
  { id: 'vercel-env-leak',          re: /VITE_VERCEL_[A-Z0-9_]+/g,               why: 'a Vercel system env var is inlined in the bundle — a whole-object import.meta.env read (CS-398)' },
];

function parseArgs(argv) {
  const a = { json: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dist') a.dist = argv[++i];
    else if (t === '--url') a.url = argv[++i];
    else if (t === '--build') a.build = true;
    else if (t === '--json') a.json = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else { a.bad = t; }
  }
  return a;
}

// Scan one asset's text for every marker; return the list of hits.
function scanText(name, text, markers = MARKERS) {
  const hits = [];
  for (const m of markers) {
    m.re.lastIndex = 0;
    const found = new Set();
    let mm;
    while ((mm = m.re.exec(text)) !== null) { found.add(mm[0]); if (!m.re.global) break; }
    if (found.size) hits.push({ marker: m.id, why: m.why, asset: name, samples: [...found].slice(0, 4) });
  }
  return hits;
}

function walkJs(dir) {
  const out = [];
  const visit = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const s = statSync(p);
      if (s.isDirectory()) visit(p);
      else if (e.endsWith('.js') || e.endsWith('.html')) out.push(p);
    }
  };
  visit(dir);
  return out;
}

function scanDist(dir, markers = MARKERS) {
  if (!existsSync(dir)) { console.error(`✖ dist not found: ${dir}`); process.exit(1); }
  const files = walkJs(dir);
  if (!files.length) { console.error(`✖ no .js/.html assets under ${dir}`); process.exit(1); }
  const hits = [];
  for (const f of files) hits.push(...scanText(basename(f), readFileSync(f, 'utf8'), markers));
  return { scanned: files.length, hits };
}

function buildProd() {
  const out = mkdtempSync(join(tmpdir(), 'cs-bundle-stubs-'));
  // Plain production build (MODE=production), the artifact `npm run build` ships. No
  // VITE_* env is needed: the stub guards key on MODE, not on Supabase being configured.
  // Run the LOCAL vite bin through this Node (no npx, no network) so the run-tests wrapper
  // stays honestly offline.
  // CS-398 canary: an UNREFERENCED VITE_ var. A named read can never pull it in, so its value
  // reaches dist ONLY through a whole-object `import.meta.env` read (which inlines the entire
  // env object — how the Vercel system vars leaked). We assert dist does not contain it.
  const canary = 'cs398envcanary' + randomBytes(16).toString('hex');
  const viteBin = join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  execFileSync(process.execPath, [viteBin, 'build', '--outDir', out, '--emptyOutDir'], {
    cwd: APP_DIR, stdio: 'pipe',
    env: { ...process.env, VITE_CS398_ENV_CANARY: canary },
  });
  return { dir: out, canary };
}

async function scanUrl(base) {
  const root = base.replace(/\/+$/, '');
  const seen = new Set();
  const queue = [];
  const enqueue = (u) => { if (u && !seen.has(u)) { seen.add(u); queue.push(u); } };

  const html = await (await fetch(root + '/')).text();
  // Asset URLs referenced from the HTML (entry + modulepreload).
  for (const m of html.matchAll(/[./]*assets\/[A-Za-z0-9_.-]+\.js/g)) enqueue(m[0].replace(/^[./]+/, '/'));
  if (!queue.length) { console.error('✖ no assets/*.js referenced from the live HTML'); process.exit(1); }

  const hits = [];
  let scanned = 0;
  // One-level crawl: lazy chunks (e.g. quotesApi) are import()-referenced from the entry
  // chunk, so scan each fetched chunk for further hashed asset names too.
  while (queue.length) {
    const rel = queue.shift();
    const url = rel.startsWith('http') ? rel : root + rel;
    let text;
    try { const r = await fetch(url); if (!r.ok) continue; text = await r.text(); }
    catch { continue; }
    scanned++;
    hits.push(...scanText(basename(rel), text));
    for (const m of text.matchAll(/(?:assets\/)?[A-Za-z0-9_]+-[A-Za-z0-9_-]{6,}\.js/g)) {
      const name = basename(m[0]);
      enqueue('/assets/' + name);
    }
  }
  return { scanned, hits };
}

async function main() {
  const a = parseArgs(process.argv);
  if (a.help || a.bad) {
    const msg = a.bad ? `unknown arg: ${a.bad}\n` : '';
    console.error(`${msg}usage: check-bundle-stubs.mjs (--dist <dir> | --build | --url <base>) [--json]`);
    process.exit(a.bad ? 2 : 0);
  }
  const modes = [a.dist && 'dist', a.build && 'build', a.url && 'url'].filter(Boolean);
  if (modes.length !== 1) {
    console.error('usage: exactly one of --dist <dir>, --build, --url <base>');
    process.exit(2);
  }

  let result, label, tmp;
  try {
    if (a.url) { label = a.url; result = await scanUrl(a.url); }
    else if (a.build) {
      const built = buildProd();
      tmp = built.dir;
      label = `production build (${built.dir})`;
      // Fail if the unreferenced VITE_ canary reached dist (a whole-object env read, CS-398).
      const canaryMarker = {
        id: 'env-inline-canary', re: new RegExp(built.canary, 'g'),
        why: 'an UNREFERENCED VITE_ var reached dist — a whole-object import.meta.env read inlined the entire env object (CS-398)',
      };
      result = scanDist(built.dir, [...MARKERS, canaryMarker]);
    } else {
      label = a.dist;
      result = scanDist(a.dist);
    }
  } finally {
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
  }

  const { scanned, hits } = result;
  if (a.json) console.log(JSON.stringify({ target: label, scanned, hits }, null, 2));

  if (hits.length) {
    if (!a.json) {
      console.error(`\n✖ check-bundle-stubs: ${hits.length} stub marker(s) in ${label} (${scanned} asset(s) scanned)\n`);
      for (const h of hits) console.error(`    [${h.marker}] ${h.asset}: ${h.samples.join(', ')}\n        → ${h.why}`);
      console.error('\n  A production bundle must not contain a reachable browser-stub adapter (CS-010, CS-038).');
      console.error('  If this is a demo build (build:demo), that is expected — check a `npm run build` artifact.\n');
    }
    process.exit(1);
  }
  if (!a.json) console.log(`✓ check-bundle-stubs: no stub markers in ${label} (${scanned} asset(s) scanned)`);
  process.exit(0);
}

main().catch((e) => { console.error(`✖ check-bundle-stubs failed: ${e.message}`); process.exit(1); });
