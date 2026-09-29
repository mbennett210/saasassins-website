// endpoint-lint — the build-failing sweep behind playbook II.6, "no endpoint left behind".
//
// THE LAW: "Maintain a live endpoint inventory and regenerate it at clone time, before
// go-live, and at every audit… Diff against the previous inventory — anything added needs
// auth + docs; anything removed needs its callers swept." Plus: "Every endpoint declares
// its auth stance at creation", and Track A's routing law — every API DOMAIN needs BOTH the
// catch-all handler AND its vercel.json rewrite, "or pretty URLs 404 while direct paths
// work — the classic half-shipped endpoint."
//
// WHY A TOOL. The 2026-07-27 audit found the inventory law had NO ARTIFACT: BUILD_INTEGRITY
// §2 documented the `find` command but stored no output, so there was nothing to diff route
// 34 against. The routes were in good shape because the build was careful — but one had
// already slipped through ungated (`inbox/connect/google.js`, no declared stance). Careful
// is not a gate.
//
// WHAT IT CHECKS
//   1. Every route file on disk has an entry in ENDPOINTS.md      (added-without-docs)
//   2. Every entry in ENDPOINTS.md still exists on disk           (removed-without-sweep)
//   3. Every route declares an auth stance this tool can see      (ungated-by-accident)
//   4. Every catch-all domain has its vercel.json rewrite         (the half-shipped endpoint)
//
// Stance detection is BY CAPABILITY, not by helper name — the playbook is explicit that "a
// grep for requireRole structurally cannot find the route that rolled its own check (that
// exact route was privilege escalation to OAuth credentials)". So a hand-rolled bearer/HMAC
// check counts, and so does an explicit `AUTH STANCE:` comment for routes that are public
// by design. What does NOT count is silence.
//
// Usage:
//   node scripts/endpoint-lint.mjs            # from app/ — exit 1 on drift
//   node scripts/endpoint-lint.mjs --write    # regenerate ENDPOINTS.md from disk
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = fileURLToPath(new URL('../api/', import.meta.url));
const INVENTORY = fileURLToPath(new URL('../api/ENDPOINTS.md', import.meta.url));
const VERCEL = fileURLToPath(new URL('../vercel.json', import.meta.url));
const WRITE = process.argv.includes('--write');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir)) {
    const p = path.join(dir, e);
    if (fs.statSync(p).isDirectory()) {
      if (e === '_lib') continue; // helpers, not endpoints
      walk(p, out);
    } else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

// Detect the auth stance BY CAPABILITY. Order matters: the strongest gate wins.
function detectStance(src) {
  const m = src.match(/requireRole\s*\(\s*req\s*,\s*res\s*,\s*\[([^\]]*)\]/);
  if (m) return `requireRole([${m[1].replace(/['"\s]/g, '').split(',').filter(Boolean).join(', ')}])`;
  if (/requireAuthority\s*\(/.test(src)) return 'requireAuthority';
  if (/requireSiteAssignment\s*\(/.test(src)) return 'requireSiteAssignment';
  if (/CRON_SECRET/.test(src)) return 'cron-secret (fails closed)';
  if (/safeEqual\s*\(\s*bearerToken|verifyInbound\s*\(/.test(src)) return 'per-endpoint bearer / HMAC';
  if (/requireAuth\s*\(/.test(src)) return 'requireAuth (session bearer)';
  // BY SHAPE, NOT BY NAME. Any `requireXxx(req, res, …)` is a gate, whatever it is called.
  // A fixed name-list is precisely the failure the playbook warns about — this tool's first
  // run reported `/inbox/[id]/send` and `/test` as UNGATED when both call
  // `requireInboxOwner(req, res, id)`, a domain-specific ownership gate. The name-list could
  // not see it. Matching the calling convention instead makes new gates visible by default.
  const dyn = src.match(/\b(require[A-Z]\w*)\s*\(\s*req\s*,\s*res/);
  if (dyn) return `${dyn[1]} (domain gate)`;
  if (/verifyState\s*\(/.test(src)) return 'signed OAuth state (HMAC, 10-min TTL)';
  if (/verify\w*Token\s*\(/.test(src)) return 'signed-token (public, token-scoped)';
  if (/getQuoteByToken\s*\(/.test(src)) return 'public, token-scoped';
  // An explicit declaration for routes that are deliberately public.
  if (/AUTH STANCE:|PUBLIC .*(?:no auth|route)/i.test(src)) return 'declared PUBLIC (see header)';
  return null;
}

const files = walk(API).sort();
const routes = files.map((f) => {
  const src = fs.readFileSync(f, 'utf8');
  const route = '/' + path.relative(API, f).replace(/\\/g, '/').replace(/\.js$/, '');
  return { route, stance: detectStance(src), file: path.relative(API, f).replace(/\\/g, '/') };
});

// Catch-all domains need a vercel.json rewrite (Track A routing law).
const vercel = JSON.parse(fs.readFileSync(VERCEL, 'utf8'));
const rewrites = (vercel.rewrites || []).map((r) => r.source);
const catchAlls = routes.filter((r) => /\[\[?\.\.\..+\]\]?$/.test(r.route));
const missingRewrite = catchAlls.filter((r) => {
  const domain = r.route.replace(/\/\[\[?\.\.\..+\]\]?$/, ''); // /quotes/[...path] -> /quotes
  return !rewrites.some((s) => s.startsWith(`/api${domain}/`) || s === `/api${domain}`);
});

if (WRITE) {
  const lines = [
    '# API endpoint inventory',
    '',
    '> **Generated — do not hand-edit.** `npm --prefix app run lint:endpoints -- --write`',
    '>',
    '> This file is the artifact playbook II.6 requires: "maintain a live endpoint inventory…',
    '> diff against the previous inventory — anything added needs auth + docs; anything removed',
    '> needs its callers swept." `endpoint-lint` fails the build when this file and `app/api/`',
    '> disagree, or when a route carries no detectable auth stance.',
    '>',
    '> Stances are detected BY CAPABILITY, not by helper name — a hand-rolled bearer/HMAC check',
    '> counts, because "a grep for requireRole structurally cannot find the route that rolled',
    '> its own check."',
    '',
    `**${routes.length} endpoints** · ${catchAlls.length} catch-all domains · `
      + `${new Set(routes.map((r) => r.stance)).size} distinct stances`,
    '',
    '| Route | Auth stance |',
    '|---|---|',
    ...routes.map((r) => `| \`${r.route}\` | ${r.stance || '🔴 **NONE DETECTED**'} |`),
    '',
  ];
  fs.writeFileSync(INVENTORY, lines.join('\n'), 'utf8');
  console.log(`\nendpoint-lint: wrote ${routes.length} endpoints to api/ENDPOINTS.md\n`);
  process.exit(0);
}

if (!fs.existsSync(INVENTORY)) {
  console.error('\n✖ api/ENDPOINTS.md does not exist. Generate it:');
  console.error('    npm --prefix app run lint:endpoints -- --write\n');
  process.exit(1);
}

const inv = fs.readFileSync(INVENTORY, 'utf8');
const listed = new Set([...inv.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]));
const onDisk = new Set(routes.map((r) => r.route));

const added = [...onDisk].filter((r) => !listed.has(r));
const removed = [...listed].filter((r) => !onDisk.has(r));
const stanceless = routes.filter((r) => !r.stance);

console.log(`\nendpoint-lint — ${routes.length} endpoints on disk · ${listed.size} in the inventory · `
  + `${catchAlls.length} catch-alls`);

const problems = [];
if (added.length) problems.push(['ADDED but not in the inventory (needs auth + docs)', added]);
if (removed.length) problems.push(['IN THE INVENTORY but gone from disk (sweep its callers)', removed]);
if (stanceless.length) problems.push(['NO DETECTABLE AUTH STANCE', stanceless.map((r) => r.route)]);
if (missingRewrite.length) problems.push(['CATCH-ALL WITH NO vercel.json REWRITE (pretty URLs will 404)',
  missingRewrite.map((r) => r.route)]);

if (problems.length) {
  for (const [title, items] of problems) {
    console.error(`\n✖ ${title}:`);
    for (const i of items) console.error(`    ${i}`);
  }
  console.error('\n  After adding or removing a route:  npm --prefix app run lint:endpoints -- --write');
  console.error('  A route with no stance must declare one — a gate call, or an "AUTH STANCE:" header.\n');
  process.exit(1);
}
console.log('  ✓ inventory matches disk · every route has a stance · every catch-all has its rewrite\n');
