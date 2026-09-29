// test-color-ledger — the re-skin guarantee as a CI gate (UI_RULES §121).
//
// A re-skin swaps the theme's token values and regenerates the brand outputs; any colour written
// anywhere else survives the swap and leaks the old brand. color-ledger.mjs enumerates every colour
// literal the app ships (src, the server, the static shell, the brand-asset generators) and classifies
// each one. This suite:
//   1. runs it over the real tree: zero leaks, zero allows without a reason, and the universe still
//      reaches every surface that renders a colour (so a refactor that drops a directory fails);
//   2. proves each detection on fixtures, so a weakened detector fails too (a gate that passes because
//      it stopped looking is worse than no gate);
//   3. renders what a customer receives (the quote and the inspection report, which the server also prints
//      to PDF, their PDF bars, the server's emails) and checks every colour in it against the brand palette.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildLedger, scanText, colorsIn } from './color-ledger.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };

// ── 1. the real tree ─────────────────────────────────────────────────────────
console.log('color-ledger over the real tree');
const { files, leaks, badAllows, summary } = buildLedger();
ok(leaks.length === 0, `zero leaks (${summary.literals} literals in ${summary.files} files: ${summary.theme} theme, ${summary.allowed} allowed, ${summary.mask} mask, ${summary.content} content, ${summary.excluded} excluded)`);
for (const l of leaks.slice(0, 25)) console.error(`      ${l.file}:${l.line}  ${l.lit}`);
ok(badAllows.length === 0, 'every design:allow no-raw-hex carries a reason');
for (const b of badAllows) console.error(`      ${b.file}:${b.line}  ${b.why}`);

// the universe reaches every surface that renders a colour. The server path is built from segments so
// run-tests does not read a path literal here as "this suite needs the backend".
const server = ['api', '_lib', 'quotes', 'emails.js'].join('/');
const must = [
  'src/index.css', 'src/theme.css', 'src/lib/quoteTemplate.js', 'src/lib/inspectionReportTemplate.js',
  'src/brand/doc.js', 'src/brand/logo.js', 'src/brand/tokens.generated.js', 'index.html',
  'public/manifest.json', 'public/sw.js', 'scripts/gen-brand-images.mjs',
];
if (fs.existsSync(path.join(APP, 'api'))) must.push(server);
const missing = must.filter((f) => !files.includes(f));
ok(missing.length === 0, `the universe includes ${must.length} sentinel files${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
ok(files.some((f) => f.endsWith('.jsx')) && files.some((f) => /^src\/pages\//.test(f)), 'the universe includes the pages and components');

// ── 2. fixtures: each detection class, and each thing that must NOT count ───────
console.log('detections on fixtures');
const statuses = (rel, text) => scanText(rel, text).rows.map((r) => `${r.lit}:${r.status}`);
const leaksIn = (rel, text) => scanText(rel, text).rows.filter((r) => r.status === 'leak').map((r) => r.lit);
const expectLeak = (label, rel, text, lit) => ok(leaksIn(rel, text).some((l) => l.startsWith(lit)), `${label} → leak ${lit}`);
const expectClean = (label, rel, text) => { const l = leaksIn(rel, text); ok(l.length === 0, `${label} → no leak${l.length ? ` (got ${l.join(', ')})` : ''}`); };

// CSS
expectLeak('hex in a CSS declaration', 'src/x.css', '.a { color: #212269; }', '#212269');
expectLeak('named colour in a custom property', 'src/x.css', ':root { --x: navy; }', 'navy');
expectLeak('named colour in a gradient', 'src/x.css', '.a { background-image: linear-gradient(white, red); }', 'white');
expectLeak('named colour in a filter', 'src/x.css', '.a { filter: drop-shadow(0 0 2px black); }', 'black');
expectLeak('rgba() with numbers', 'src/x.css', '.a { box-shadow: 0 1px 2px rgba(20, 25, 50, .1); }', 'rgba(');
expectClean('rgba() of a token', 'src/x.css', '.a { background: rgba(var(--color-black-rgb), 0.4); }');
expectClean('font and animation names', 'src/x.css', '.a { font-family: Tomato, sans-serif; animation-name: red; }');
expectClean('class names and comments', 'src/x.css', '/* a white card */ .badge.green { background: var(--badge-green-grad); }');
ok(statuses('src/x.css', '.a { mask-image: linear-gradient(to right, black 90%, transparent); }').includes('black:mask'), 'a mask colour → mask, not a leak');
// the theme layer: a palette entry is fine; a colour baked into a recipe survives a re-skin
ok(statuses('src/theme-acme.css', ':root { --primary: #123456; }').includes('#123456:theme'), 'a palette entry in a theme → theme');
ok(statuses('src/theme.css', ':root { --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.08); }').some((s) => s.endsWith(':leak')), 'a colour baked into a base-theme recipe → leak');
ok(statuses('src/theme-acme.css', ":root { --icon: url(\"data:image/svg+xml,%3Csvg stroke='%2394a3b8'/%3E\"); }").some((s) => s.endsWith(':leak')), 'a data-URI icon baked into a client theme → leak');
ok(statuses('src/theme-acme.css', ":root {\n  /* ── GENERATED by `npm --prefix app run brand:js` from this theme's tokens; do not edit ── */\n  --icon: url(\"data:image/svg+xml,%3Csvg stroke='%2394a3b8'/%3E\");\n  /* ── end GENERATED ── */\n}").every((s) => s.endsWith(':theme')), "the client theme's GENERATED block → theme");
expectClean('a recipe composed from channels', 'src/theme.css', ':root { --shadow-md: 0 4px 12px rgba(var(--color-black-rgb), 0.08); }');
// JS / JSX
expectLeak('hex string', 'src/x.jsx', "const c = '#c0392b';", '#c0392b');
expectLeak('hex in an inline style string', 'src/x.js', 'const h = `<div style="color:#334155">`;', '#334155');
expectLeak('named colour in an inline style string', 'src/x.js', "const h = '<hr style=\"border-top:1px solid silver\">';", 'silver');
expectLeak('named colour in a style object', 'src/x.jsx', "<div style={{ color: 'white' }} />", 'white');
expectLeak('named colour under a paint key', 'src/x.js', "const series = { stroke: 'red' };", 'red');
expectLeak('named paint on a JSX SVG element', 'src/x.jsx', '<path fill="white" d="M0 0" />', 'white');
expectLeak('named paint in an SVG string', 'src/x.js', "const s = \"<circle fill='orange' r='3'/>\";", 'orange');
expectLeak('%23 colour in a data URI', 'src/x.js', "const u = \"data:image/svg+xml;utf8,<svg><rect fill='%23FFD45A'/></svg>\";", '#FFD45A');
expectLeak('canvas ink', 'src/x.jsx', "ctx.fillStyle = '#0b1020';", '#0b1020');
// a hex inside a CSS shorthand under any style key (the class the first detector missed: S102)
expectLeak('hex in a shorthand under borderTop', 'src/x.jsx', "<div style={{ borderTop: '1px solid #e5e7eb' }} />", '#e5e7eb');
expectLeak('hex in a standalone CSS value string', 'src/x.js', "const BORDER = '1px solid #d0d3e2';", '#d0d3e2');
expectLeak('an all-digit hex in a CSS value', 'src/x.jsx', "<hr style={{ border: '1px solid #555' }} />", '#555');
expectLeak('a named colour in a shorthand under borderTop', 'src/x.jsx', "<div style={{ borderTop: '1px solid silver' }} />", 'silver');
expectLeak('a shadow under boxShadow', 'src/x.jsx', "<div style={{ boxShadow: '0 0 0 3px rgba(20, 25, 50, .13)' }} />", 'rgba(');
expectLeak('a hex after https:// on the same line', 'src/x.jsx', '<input placeholder="https://…" style={{ border: \'1px solid #d0d3e2\' }} />', '#d0d3e2');
expectClean('a Badge variant in tag data', 'src/x.js', "const tag = { label: 'VIP', color: 'red' };");
expectClean('a number after #', 'src/x.jsx', "const t = `Cheque #1042 · Invoice #123`;");
expectClean('an order number in prose', 'src/x.jsx', "const t = 'Order #123456 shipped';");
expectClean('prose with a colon', 'src/x.jsx', "const t = 'Status: red flag raised';");
expectClean('a palette read', 'src/x.js', 'const h = `<div style="color:${DOC.ink}">`;');
// allows
ok(statuses('src/x.jsx', "// design:allow no-raw-hex — Google's brand mark\nconst g = '#4285F4';").includes('#4285F4:allowed'), 'an allow with a reason → allowed');
ok(scanText('src/x.jsx', "// design:allow no-raw-hex\nconst g = '#4285F4';").bad.length === 1, 'an allow without a reason → a finding');
// the static shell
expectLeak('a manifest colour outside the brand outputs', 'public/app.webmanifest', '{ "theme_color": "#212269" }', '#212269');
ok(statuses('public/manifest.json', '{ "theme_color": "#18181b" }').includes('#18181b:theme'), 'the generated manifest colour → theme (a brand output)');

// ── 3. rendered: what a customer receives carries only brand colours ────────────────────
// The ledger reads source. This renders the documents and emails the app sends (the server prints the
// same templates to PDF) and checks every colour in them against the brand palette: a BRAND value, or a
// BRAND colour at an opacity (DOC's alpha()). Register CS-166.
console.log('rendered documents and emails');
{
  const { BRAND } = await import(pathToFileURL(path.join(APP, 'src', 'brand', 'tokens.generated.js')).href);
  const hex6 = (h) => { let x = h.replace('#', ''); if (x.length <= 4) x = x.split('').map((c) => c + c).join(''); return `#${x.slice(0, 6)}`; };
  const channelsOf = (h) => { const x = hex6(h).slice(1); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)).join(','); };
  const palette = new Set(Object.values(BRAND).filter((v) => v.startsWith('#')).map(hex6));
  const channels = new Set([...palette].map(channelsOf));
  const inPalette = (c) => {
    if (c.startsWith('#')) return palette.has(hex6(c));
    const m = /^rgba?\((\d+),(\d+),(\d+)/.exec(c);
    return !!m && channels.has(`${m[1]},${m[2]},${m[3]}`);
  };
  ok(inPalette(BRAND.primary) && inPalette(`rgba(${channelsOf(BRAND.primary)},0.5)`) && !inPalette('#1f2a6e') && !inPalette('rgba(20,25,50,0.13)'), 'the palette check accepts brand values (and a brand colour at an opacity) and refuses the old navy');

  const lib = (f) => pathToFileURL(path.join(APP, 'src', 'lib', f)).href;
  const { buildQuoteHtml, PRINT_HEADER, PRINT_FOOTER } = await import(lib('quoteTemplate.js'));
  // the PDF running bar is a stretched 1×1 PNG (Chromium's header template ignores backgrounds): its colour
  // lives inside the image, where no text scan reaches, so it must BE the brand-colour image
  const { DOC, solidPng } = await import(pathToFileURL(path.join(APP, 'src', 'brand', 'doc.js')).href);
  const bar = solidPng(DOC.brand);
  ok(PRINT_HEADER.includes(bar) && PRINT_FOOTER.includes(bar), "the quote PDF's running header and footer bars are images of the brand colour");
  const { buildInspectionReportHtml, REPORT_PRINT_FOOTER } = await import(lib('inspectionReportTemplate.js'));
  const report = {
    inspection: {
      templateName: 'Monthly quality walk', clientName: 'Northside Auto Group', inspectorName: 'Kyler Nguyen', performedAt: '2026-09-22T15:00:00Z', result: 'needs_follow_up', overallScore: 72,
      schema: { areas: [{ id: 'a1', label: 'Lobby', items: [{ id: 'i1', label: 'Floors' }, { id: 'i2', label: 'Glass' }] }, { id: 'a2', label: 'Restrooms', items: [{ id: 'i3', label: 'Fixtures' }, { id: 'i4', label: 'Supplies' }] }] },
    },
    items: [{ itemKey: 'i1', rating: 'pass' }, { itemKey: 'i2', rating: 'fail', comment: 'Streaks' }, { itemKey: 'i3', rating: 'na' }],
    photos: [{ id: 'p1', kind: 'video', url: 'https://example.test/v.mp4', caption: 'Lobby', areaId: 'a1' }],
  };
  // [name, html, the fewest colours it must carry (so an empty render can't pass)]
  const docs = [
    ['the quote', buildQuoteHtml({ clientName: 'Northside Auto Group', contactName: 'Morgan Hayes', restrooms: '4' }, {}), 10],
    ["the quote's PDF header", PRINT_HEADER, 1],
    ["the quote's PDF footer", PRINT_FOOTER, 1],
    ['the inspection report', buildInspectionReportHtml(report, {}), 10],
    ['the inspection report (PDF)', buildInspectionReportHtml(report, { forPdf: true }), 10],
    ["the report's PDF footer", REPORT_PRINT_FOOTER, 1],
  ];
  // the server's emails (skipped on a branch without the server)
  if (fs.existsSync(path.join(APP, 'api'))) {
    const srv = (...p) => pathToFileURL(path.join(APP, 'api', ...p)).href;
    const { signRequestEmail, signedCopyEmail } = await import(srv('_lib', 'quotes', 'emails.js'));
    const quote = { contact_name: 'Morgan Hayes', client_signer_name: 'Morgan Hayes', fields: { companyName: 'Northside Auto Group' } };
    docs.push(['the sign-request email', signRequestEmail({ quote, link: 'https://example.test/sign/abc' }).html, 3]);
    docs.push(['the signed-copy email (to the client)', signedCopyEmail({ quote, toClient: true }).html, 3]);
    docs.push(['the signed-copy email (internal)', signedCopyEmail({ quote, toClient: false }).html, 3]);
    const { buildUnsubscribeCompliance } = await import(srv('_lib', 'marketing', 'compliance.js'));
    const c = buildUnsubscribeCompliance({ recipient: 'morgan@example.test', isHtml: true, config: {}, companyName: 'Northside', inboxEmail: 'hello@example.test' });
    docs.push(['the marketing unsubscribe footer', typeof c === 'string' ? c : JSON.stringify(c), 2]);
  }
  for (const [name, html, min] of docs) {
    const found = colorsIn(html);
    const off = [...new Set(found.filter((c) => !inPalette(c)))];
    ok(off.length === 0 && found.length >= min, `${name}: ${found.length} colour(s), all brand values${off.length ? ` (off-palette: ${off.join(', ')})` : ''}${found.length < min ? ` (expected at least ${min})` : ''}`);
  }
}

// ── 4. a client theme holds colours only ────────────────────────────────────────────
// Structure (radii, heights, spacing) and treatment (the flat treatment's `none` shadows) are the same in
// every build, so they live in theme.css / theme-flat.css; a re-skin replaces only colour values. Every
// :root declaration of the client theme must resolve to something colour-bearing: a colour, a channel
// triplet, or a recipe of them (a gradient, a shadow, a data-URI icon). Register CS-346.
console.log('the client theme holds colours only');
{
  const { CLIENT_THEME } = await import('./brand-js.mjs');
  const { readCascade } = await import('./design-system-lib.mjs');
  const resolved = new Map(readCascade().map((t) => [t.name, t.resolved]));
  const text = fs.readFileSync(CLIENT_THEME, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const decls = [...text.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]);
  const colourBearing = (v) => /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(|%23[0-9a-f]{3,8}|^\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*$|\btransparent\b/i.test(v);
  const structural = decls.filter(([n, v]) => !colourBearing(resolved.get(n) ?? v) && !colourBearing(v));
  ok(decls.length > 50, `${decls.length} declarations read from ${path.basename(CLIENT_THEME)}`);
  ok(structural.length === 0, `every one is colour-bearing${structural.length ? ` (${structural.length} are not: ${structural.slice(0, 6).map(([n, v]) => `--${n}: ${v}`).join(', ')}${structural.length > 6 ? ', …' : ''})` : ''}`);
  // the check itself: a radius or a flat `none` in a client theme is caught; colours and recipes are not
  const probe = (v) => !colourBearing(v);
  ok(probe('10px') && probe('none') && !probe('#18181b') && !probe('24, 24, 27') && !probe('0 1px 2px rgba(var(--color-black-rgb), 0.04)'), 'the check flags a length or a `none` and passes a colour, a channel triplet or a colour recipe');
}

if (failed) { console.error(`\n✗ test-color-ledger: ${failed} check(s) failed`); process.exit(1); }
console.log('\n✓ test-color-ledger: the re-skin guarantee holds and every detection fires');
