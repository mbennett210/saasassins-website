// test-name-ledger — the name guarantee as a CI gate (UI_RULES §129).
//
// A new client is a new brand file (brands/<id>/brand.json, applied by `npm --prefix app run brand`). Any
// name, wordmark, domain, phone, street or owner written anywhere else survives the swap and shows the old
// client in the app, a document or an email. name-ledger.mjs enumerates every occurrence in what the app
// ships and classifies it. This suite:
//   1. runs it over the real tree: zero leaks, zero allows without a reason, and the universe still reaches
//      every surface that shows a name (so a refactor that drops a directory fails);
//   2. proves each detection on fixtures, so a weakened detector fails too (a gate that passes because it
//      stopped looking is worse than no gate);
//   3. swaps a throwaway brand into the generated identity, in memory, and renders what a customer receives
//      (the quote, the inspection report, the letterhead, the client and server emails, every draft in the
//      review catalog) and what the demo seeds: each carries the throwaway brand and nothing of the active one.
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildLedger, scanText, classify, needles, IDENTIFIERS, MIGRATIONS, EXCLUDE } from './name-ledger.mjs';
import { activeBrandId, loadBrand, identityText, identityStrings, localeOf, readQuote, validateQuote, quoteText } from './brand.mjs';
import { derivePalette } from './brand-colors.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };

const active = loadBrand(activeBrandId());
if (active.error) { console.error(active.error); process.exit(1); }
const BRAND = active.brand;

// A throwaway brand (section 3 renders under it; section 2's fixtures use it too). Its identity replaces the
// generated one for this whole process, registered before anything can load it: an app module imported for
// its helpers (the rebrand sweep reads app-routes.mjs, which reads the monogram) would otherwise cache the
// real identity first.
const PROBE = {
  version: 1, id: 'probe', name: "Nørd & O'Hara Facility Care", wordmark: "Nørd&O'Hara", shortName: 'Nørd Care', appTitle: 'Nørd Care Ops',
  description: 'Operations for Nørd Care.', monogram: 'NO', slug: 'nord-care', appUrl: 'https://ops.nordcare.example',
  company: {
    domain: 'nordcare.example', website: 'www.nordcare.example', email: 'hello@nordcare.example', phone: '1-555-010-0199',
    street: '77 Probe Way', city: 'Testville, ZZ 00000', tagline: 'A Probe Holdings Company', services: 'Probe Cleaning & Testing Services',
    signatory: { name: 'Ada Lovelace-Byron', role: 'Director', title: 'Director of Probing', email: 'ada@nordcare.example' },
  },
  email: { quotesFrom: 'Nørd Care <quotes@mail.nordcare.example>', authFrom: 'Nørd Care <login@mail.nordcare.example>' },
};
// PROBE's own quote pages (a brand pack's quote.html): a quoteTemplate.js imported with ?pages=probe reads them
const PROBE_SENTINEL = 'These pages are the probe brand’s own words, and no other brand’s.';
const PROBE_QUOTE = [
  '  <!-- Cover -->',
  '  <div class="page cover"><div class="big r1">{{wordmark.1}}</div>{{#wordmark.2}}<div class="big r2">{{wordmark.2}}</div>{{/wordmark.2}}',
  '    <p>For {{field.clientName|Client Name}} at {{field.companyName|Company Name}}</p><img class="logo" src="{{logo}}" alt="{{name}}" /></div>',
  '  <!-- Cover letter -->',
  `  <div class="page pb"><p>{{date}}</p><p>${PROBE_SENTINEL} {{name}}, {{company.street}}, {{company.city}}, {{company.phone}}, {{company.website}}, {{company.tagline}}.</p>`,
  '    <p>{{signatory.name}}, {{signatory.title}}</p>',
  '    <p>${{field.amount|Amount}}, {{field.frequency|Frequency}}, {{field.dayOfWeek|Days}}, {{field.restrooms|Restrooms}}</p>',
  '    <p>I, {{agreement.name}}, for {{agreement.company}}.</p>',
  '    <div class="sigtable"><div>{{signature.client}}{{#client.company}}<div class="sigcap sigsub">{{client.company}}</div>{{/client.company}}</div><div>{{signature.admin}}</div></div></div>',
].join('\n');
const IDENTITY_URL = pathToFileURL(path.join(APP, 'src', 'brand', 'identity.generated.js')).href;
const QUOTE_URL = pathToFileURL(path.join(APP, 'src', 'brand', 'quote.generated.js')).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (/quote\.generated\.js$/.test(spec) && ctx.parentURL?.endsWith('?pages=probe')) { const r = next(spec, ctx); return { ...r, url: `${r.url}?pages=probe` }; }
    try { return next(spec, ctx); } catch (e) {
      // the app's own imports omit the extension (Vite resolves them)
      if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/i.test(spec)) for (const ext of ['.js', '.jsx', '/index.js']) { try { return next(spec + ext, ctx); } catch { /* next */ } }
      throw e;
    }
  },
  load(url, ctx, next) {
    if (url === IDENTITY_URL) return { format: 'module', source: identityText(PROBE), shortCircuit: true };
    if (url === `${QUOTE_URL}?pages=probe`) return { format: 'module', source: quoteText(PROBE, PROBE_QUOTE), shortCircuit: true };
    const r = next(url, ctx);
    if (/\/app\/src\//.test(url) && r.source && String(r.source).includes('import.meta.env')) {
      r.source = `if (!import.meta.env) import.meta.env = { MODE: 'test', PROD: false, DEV: true };\n${r.source}`;
    }
    return r;
  },
});

// ── 1. the real tree ─────────────────────────────────────────────────────────
console.log(`name-ledger over the real tree (active brand: ${BRAND.id})`);
const { files, leaks, bad, summary } = buildLedger();
ok(leaks.length === 0, `zero leaks (${summary.occurrences} occurrences in ${summary.files} files: ${summary.identity} identity, ${summary.identifier} identifiers, ${summary.comment} comments, ${summary.migration} migrations, ${summary.fiction} fiction, ${summary.allowed} allowed, ${summary.excluded} excluded)`);
for (const l of leaks.slice(0, 25)) console.error(`      ${l.file}:${l.line}  ${l.text}   [${l.token.slice(0, 60)}]`);
ok(bad.length === 0, 'every brand:allow carries a reason');
for (const b of bad) console.error(`      ${b.file}:${b.line}  ${b.why}`);
ok(summary.identity >= 10, `the generated identity is read as identity (${summary.identity} matches), so the needles are live`);
ok([...IDENTIFIERS, ...MIGRATIONS].every(([t, why]) => typeof t === 'function' && typeof why === 'string' && why.length > 20) && [...EXCLUDE.values()].every((why) => why.length > 20), 'every kept identifier, migration and exclusion states its reason');

// the universe reaches every surface that shows a name. Server paths are built from segments so run-tests
// does not read a path literal here as "this suite needs the backend".
const must = [
  'src/brand/identity.generated.js', 'src/brand/quote.generated.js', 'src/brand/logo.js', 'src/lib/quoteTemplate.js', 'src/lib/inspectionReportTemplate.js',
  'src/lib/email.js', 'src/lib/documentTitle.js', 'src/data/seed.js', 'src/data/demoStubs.js', 'src/data/emailDrafts.js',
  'src/pages/PublicQuote.jsx', 'src/pages/Login.jsx', 'index.html', 'public/manifest.json', 'public/sw.js',
];
const hasApi = fs.existsSync(path.join(APP, 'api'));
if (hasApi) for (const p of [['_lib', 'quotes', 'emails.js'], ['_lib', 'users.js'], ['_lib', 'email.js'], ['_lib', 'push', 'dispatch.js']]) must.push(['api', ...p].join('/'));
const missing = must.filter((f) => !files.includes(f));
ok(missing.length === 0, `the universe includes ${must.length} sentinel files${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
// public/ ships verbatim into every deployment, so it holds only what the app loads: a design mockup or a
// brand source there is served on a new client's site with the old brand in it (register CS-202)
const shipped = fs.readdirSync(path.join(APP, 'public'), { recursive: true }).map((f) => String(f).split(path.sep).join('/'));
const stray = shipped.filter((f) => /mockup/i.test(f) || /^brand-src(\/|$)/.test(f));
ok(stray.length === 0, `public/ ships no design mockups or brand sources (CS-202)${stray.length ? ` (found: ${stray.join(', ')})` : ''}`);

// ── 1b. a new client's ordinary details are not read as identity leaks (CS-400) ──
// Measured with the real scanner on the active pack with one field changed (the register's method). A short
// title or services phrase (the description rule in brand.mjs) and the demo book's own city and street (the
// place classed fiction in the fictional data, below) each gave false leaks before the fix; each gives none now.
console.log("a new client's ordinary details are not false leaks (CS-400)");
const withField = (p, v) => { const b = JSON.parse(JSON.stringify(BRAND)); const ks = p.split('.'); const last = ks.pop(); ks.reduce((o, k) => o[k], b)[last] = v; return b; };
for (const [p, v] of [
  ['company.signatory.title', 'Office Manager'], ['company.signatory.title', 'Account Manager'],
  ['company.signatory.title', 'General Manager'], ['company.signatory.title', 'Operations Manager'],
  ['company.signatory.title', 'Property Manager'],
  ['company.services', 'Janitorial'], ['company.services', 'Floor Care'],
  ['company.city', 'Fort Lauderdale, FL 33301'], ['company.city', 'Miami, FL 33101'],
  ['company.street', '200 E Las Olas Blvd'],
]) {
  const l = buildLedger({ brand: withField(p, v) }).leaks;
  ok(l.length === 0, `a client with ${p.split('.').pop()} "${v}" is not a false leak${l.length ? ` (${l.length}: ${[...new Set(l.map((x) => `${x.file}:${x.line}`))].slice(0, 6).join(', ')})` : ''}`);
}
// a place is fiction only in the demo's fictional data: the brand's own street written into a component is a leak
{
  const rows = scanText('src/components/Somewhere.jsx', `const s = '${BRAND.company.street}';`, BRAND).rows;
  ok(rows.some((r) => r.cls === 'leak') && !rows.some((r) => r.cls === 'fiction'), "the brand's street in a component (not fictional data) is a leak, not fiction");
}

// ── 2. fixtures: each class, and each thing that must NOT hide a leak ────────────
console.log('detections on fixtures');
const cls = (rel, text, brand = BRAND) => scanText(rel, text, brand).rows.map((r) => `${r.text}:${r.cls}`);
const expect = (label, rel, text, want, brand) => {
  const got = cls(rel, text, brand);
  ok(got.includes(want) && got.every((g) => !g.endsWith(':leak') || want.endsWith(':leak')), `${label} → ${want.split(':').pop()}${got.includes(want) ? '' : ` (got ${got.join(', ') || 'nothing'})`}`);
};
const expectNone = (label, rel, text, brand) => { const got = cls(rel, text, brand); ok(got.length === 0, `${label} → no match${got.length ? ` (got ${got.join(', ')})` : ''}`); };
// leaks: the name in code, in every spelling and field
expect('the name in a string', 'src/x.js', "const t = 'Welcome to Clean Space';", 'Clean Space:leak');
expect('the wordmark', 'src/x.js', 'const t = "CleanSpace alert";', 'CleanSpace:leak');
expect('the name in capitals', 'src/x.js', "const t = 'CLEAN SPACE';", 'CLEAN SPACE:leak');
// (a fixture that names a brand field uses the active brand's own value, so this suite passes under any brand)
expect('the website in JSX text after a URL scheme (its // is not a comment)', 'src/x.jsx', `<p>Visit https://${BRAND.company.website} today</p>`, `${BRAND.company.website}:leak`);
expect('the domain in an href', 'src/x.jsx', `<a href="https://${BRAND.company.domain}/about">About</a>`, `${BRAND.company.domain}:leak`);
expect('the name after an apostrophe in JSX text', 'src/x.jsx', "<p>Don't miss it</p>\n<p>Clean Space</p>", 'Clean Space:leak');
expect('the name after an apostrophe on the same JSX line', 'src/x.jsx', "<p>It's here</p> // Clean Space", 'Clean Space:leak');
expect('the name in a nested template', 'src/x.js', 'const t = `a ${x ? `Clean Space` : \'b\'} c`;', 'Clean Space:leak');
expect('a // inside a template literal is not a comment', 'src/x.js', 'const u = `see https://x.test//Clean Space`;', 'Clean Space:leak');
expect('the name in a CSS content string', 'src/x.css', ".x::after { content: 'Clean Space'; }", 'Clean Space:leak');
expect('the name in HTML text', 'src/x.html', '<p>Clean Space</p>', 'Clean Space:leak');
expect('the name in JSON (no comments there)', 'src/x.json', '{ "note": "Clean Space" }', 'Clean Space:leak');
expect("the brand's phone", 'src/x.js', `const p = '${BRAND.company.phone}';`, `${BRAND.company.phone}:leak`);
// an identity value in another spelling is the same leak (CS-389): the phone in any grouping, with or without
// the country code, and a value's words split by other separators, a line break or an escaped space
{
  const d = BRAND.company.phone.replace(/\D/g, '');
  const [a, b, c] = ((n) => [n.slice(0, 3), n.slice(3, 6), n.slice(6)])(d.length === 11 && d[0] === '1' ? d.slice(1) : d);
  for (const p of [`(${a}) ${b}-${c}`, `${a}.${b}.${c}`, `${a}${b}${c}`, `+1 ${a} ${b} ${c}`, `1 (${a}) ${b}-${c}`]) {
    expect(`the brand's phone written ${p}`, 'src/x.js', `const p = '${p}';`, `${p}:leak`);
  }
  ok(cls('src/x.js', `const n = '9${a}${b}${c}';`).length === 0 && cls('src/x.js', `const n = '${a}${b}${c}1';`).length === 0, "the phone's digits inside a longer number are not a match");
  const [w1, ...rest] = BRAND.company.street.split(' ');
  const street = `${w1}\n        ${rest.join(' ')}`;
  expect("the brand's street across a JSX line break", 'src/x.jsx', `<p>${street}</p>`, `${street}:leak`);
  const tag = BRAND.company.tagline.replace(' ', '&nbsp;');
  expect("the brand's tagline with an escaped space", 'src/x.html', `<p>${tag}</p>`, `${tag}:leak`);
  expect('the name with an escaped space', 'src/x.html', '<p>Clean&nbsp;Space</p>', 'Clean&nbsp;Space:leak');
  // a long run of white space after a value's first word scans in linear time: the separator was cubic, 28 s on
  // 5,000 spaces (the fix wave's re-verification)
  const runs = [`7${' '.repeat(4000)}z`, `Clean${'\n'.repeat(4000)}z`, `${BRAND.company.street.split(' ')[0]}${'\t'.repeat(4000)}z`];
  const t0 = performance.now();
  for (const text of runs) cls('src/x.js', text);
  const ms = Math.round(performance.now() - t0);
  ok(ms < 1500, `a 4,000-character run of white space after a value's first word scans in linear time (${ms} ms for ${runs.length} runs)`);
}
expect("the brand's street", 'src/x.js', `const s = '${BRAND.company.street}';`, `${BRAND.company.street}:leak`);
expect("the brand's owner", 'src/x.js', `const o = '${BRAND.company.signatory.name}';`, `${BRAND.company.signatory.name}:leak`);
expect("the brand's owner in capitals", 'src/x.js', `const o = '${BRAND.company.signatory.name.toUpperCase()}';`, `${BRAND.company.signatory.name.toUpperCase()}:leak`);
expect("the brand's tagline", 'src/x.js', `const t = '${BRAND.company.tagline}';`, `${BRAND.company.tagline}:leak`);
expect('a download name built from the name', 'src/x.jsx', "a.download = 'cleanspace-review-qr.png';", 'cleanspace:leak');
expect('an unversioned storage-looking key', 'src/x.js', "const k = 'cleanspace_notes';", 'cleanspace:leak');
// comments
expect('a line comment', 'src/x.js', '// Clean Space', 'Clean Space:comment');
expect('a block comment', 'src/x.js', '/* Clean Space */ const a = 1;', 'Clean Space:comment');
expect('a comment after a string holding an apostrophe', 'src/x.js', 'const s = "it\'s"; // Clean Space', 'Clean Space:comment');
expect('a comment after a template', 'src/x.js', 'const t = `${a}`; // Clean Space', 'Clean Space:comment');
expect('a CSS comment', 'src/x.css', '/* Clean Space */ .a { color: red; }', 'Clean Space:comment');
expect('an HTML comment', 'src/x.html', '<!-- Clean Space --><p>Hi</p>', 'Clean Space:comment');
// kept identifiers, and their limits
expect('an environment variable', 'src/x.js', 'const id = process.env.CLEANSPACE_ORG_ID;', 'CLEANSPACE:identifier');
expect('the session storage key', 'src/x.js', "localStorage.getItem('cleanspace.auth');", 'cleanspace:identifier');
expect('a versioned storage key', 'src/x.js', "const K = 'cleanspace_time_entries_stub_v1';", 'cleanspace:identifier');
expect('an event name', 'src/x.js', "window.dispatchEvent(new Event('cleanspace:refresh'));", 'cleanspace:identifier');
expect('a header name', 'src/x.js', "const sig = headers['x-cleanspace-signature'];", 'cleanspace:identifier');
expect('the signature content-id', 'src/x.js', "const h = '<img src=\"cid:cleanspace-signature\">';", 'cleanspace:identifier');
expect('a push tag', 'src/x.js', "const n = { tag: 'cleanspace-digest', body };", 'cleanspace:identifier');
expect("the client theme's file name", 'src/x.css', "@import './theme-cleanspace.css';", 'cleanspace:identifier');
expect('a logo file path', 'src/x.js', "const logoUrl = '/cleanspace-logo.png';", 'cleanspace:identifier');
expect('a MIME boundary', 'src/x.js', 'const b = `cleanspace_${Date.now()}`;', 'cleanspace:identifier');
expect('a build tag', 'src/x.js', "const tag = `cleanspace-app@${sha}`;", 'cleanspace:identifier');
// migrations: only in the files that rewrite this client's saved records
expect('a historical fix in persist.js', 'src/store/persist.js', "if (u.email.endsWith('@cleanspace.co')) u.email += 'online.com';", 'cleanspace:migration');
expect('the same line anywhere else', 'src/x.js', "if (u.email.endsWith('@cleanspace.co')) u.email += 'online.com';", 'cleanspace:leak');
// the brand's locale (CS-392): its city or its area code as a form hint shows the old client's region under a
// new brand; in the demo's fictional book it is fiction, and the brand's name there is still a leak
{
  const { locality, areaCode } = localeOf(BRAND.company);
  expect("the brand's city as a form hint", 'src/x.jsx', `<FormField label="City" placeholder="${locality}" />`, `${locality}:leak`);
  expect("the brand's area code in a phone hint", 'src/x.jsx', `<FormField label="Phone" placeholder="(${areaCode}) 555-0100" />`, `(${areaCode}):leak`);
  expect("the brand's city in the demo's fictional book", 'src/data/seed.js', `const site = { city: '${locality}' };`, `${locality}:fiction`);
  expect("the brand's name in the fictional book", 'src/data/seed.js', "const t = 'Clean Space';", 'Clean Space:leak');
}
// allows
expect('an allow with a reason', 'src/x.js', "// brand:allow — a legal notice that must name the old company\nconst t = 'Clean Space';", 'Clean Space:allowed');
ok(scanText('src/x.js', "// brand:allow\nconst t = 'Clean Space';", BRAND).bad.length === 1, 'an allow without a reason → a finding');
// exclusions and the generator's own outputs
expect('an excluded file (the unused Vite sprite)', 'public/icons.svg', '<svg><title>Clean Space</title></svg>', 'Clean Space:excluded');
expect('the generated identity', 'src/brand/identity.generated.js', 'export const IDENTITY = { "name": "Clean Space" };', 'Clean Space:identity');
expect("the generated quote pages (the pack's own words)", 'src/brand/quote.generated.js', 'export const QUOTE_BODY = `<p>Clean Space</p>`;', 'Clean Space:identity');
expect("index.html's title (a line the generator writes)", 'index.html', `<head>\n<title>${BRAND.appTitle}</title>\n</head>`, `${BRAND.appTitle}:identity`);
expect("index.html's body text", 'index.html', '<head>\n<title>Clean Space CRM</title>\n</head>\n<body><p>Clean Space</p></body>', 'Clean Space:leak');
expect("a second <title> in index.html (the generator writes only the first)", 'index.html', '<title>Clean Space CRM</title>\n<svg><title>Clean Space</title></svg>', 'Clean Space:leak');
expect("the manifest's name", 'public/manifest.json', '{\n  "name": "Clean Space",\n  "short_name": "Clean Space"\n}', 'Clean Space:identity');
expect("a shortcut's name in the manifest", 'public/manifest.json', '{\n  "name": "Clean Space",\n  "shortcuts": [{ "name": "Open Clean Space" }]\n}', 'Clean Space:leak');
expect("the service worker's APP_NAME", 'public/sw.js', 'const APP_NAME = "Clean Space";', 'Clean Space:identity');
expect('any other line of the service worker', 'public/sw.js', "const APP_NAME = \"Clean Space\";\nconst T = 'Clean Space';", 'Clean Space:leak');
// the needles follow the active brand (PROBE, defined at the top), and the shell's name is always one
expect("another brand's name, when it is active", 'src/x.js', `const t = "${PROBE.name}";`, `${PROBE.name}:leak`, PROBE);
expectNone("another brand's name, when it is not", 'src/x.js', `const t = "${PROBE.name}";`, BRAND);
expect("the shell's name, under another brand", 'src/x.js', "const t = 'Clean Space';", 'Clean Space:leak', PROBE);
// rendered text: the classifier reads it with no comment syntax, and a kept identifier on screen stays kept
const shown = (text) => classify('(rendered)', text, needles(BRAND), { kind: 'text' }).rows.map((r) => `${r.text}:${r.cls}`);
const header = shown('Send the header X-CleanSpace-Signature with each request');
ok(header.length === 1 && header[0].endsWith(':identifier'), `rendered: a header name shown in integration settings stays an identifier${header.length === 1 ? '' : ` (got ${header.join(', ') || 'nothing'})`}`);
ok(shown('Questions? Write to us // Clean Space').includes('Clean Space:leak'), 'rendered: a // in page text is not a comment');
// the rendered sweep's check on a captured page (rebrand-sweep.mjs, lint:rebrand): the text, the title and
// each label are read; a kept identifier on screen is not a finding
const { findForbidden } = await import('./rebrand-sweep.mjs');
const page = { text: `Welcome to ${BRAND.name}. Sign requests with X-CleanSpace-Signature.`, title: `(2) ${BRAND.appTitle}`, attrs: [['alt', BRAND.name], ['placeholder', `you@${BRAND.company.domain}`], ['aria-label', 'Search']] };
const found = findForbidden(page, [BRAND]).map((f) => `${f.where}:${f.text}`).sort();
ok(found.join() === [`alt:${BRAND.name}`, `document title:${BRAND.appTitle}`, `placeholder:${BRAND.company.domain}`, `text:${BRAND.name}`].sort().join(), `the sweep finds the name in the text, the title, an alt and a placeholder, and not in a kept header name (got ${found.join(', ')})`);
ok(findForbidden({ text: 'Welcome to Nørd Care.', title: 'Nørd Care Ops', attrs: [] }, [BRAND]).length === 0, 'the sweep passes a page that shows only the new brand');
// its colour check: a painted colour from the forbidden brand's palette fails, in any property, unless the
// active brand's palette shares it; white and black belong to every brand
const { forbiddenColours, paintedForbidden } = await import('./rebrand-sweep.mjs');
// another palette than the active brand's (two candidates, so the fixture holds under any brand)
const other = [{ id: 'other', colors: { primary: '#093F3A', secondary: '#FFB38A', link: '#1D4ED8', neutral: '#78716C' } }, { id: 'other', colors: { primary: '#2B1B4A', secondary: '#9BE3C4', link: '#0B63C4', neutral: '#6B7280' } }]
  .find((o) => o.colors.primary.toLowerCase() !== BRAND.colors.primary.toLowerCase());
const otherInk = [1, 3, 5].map((i) => parseInt(other.colors.primary.slice(i, i + 2), 16)).join(', ');
const fc = forbiddenColours([BRAND], other);
const inkRgb = [1, 3, 5].map((i) => parseInt(derivePalette(BRAND.colors).values['primary-500'].slice(i, i + 2), 16)).join(', ');
const hits = paintedForbidden([
  { where: 'th', prop: 'background-color', value: `rgb(${inkRgb})`, doc: false },
  { where: 'a.nav', prop: 'box-shadow', value: `rgba(${inkRgb}, 0.08) 0px 1px 2px 0px`, doc: false },
  { where: 'p', prop: 'color', value: `rgb(${otherInk})`, doc: false },
  { where: 'div.card', prop: 'background-color', value: 'rgb(255, 255, 255)', doc: false },
], fc);
ok(fc.size >= 20 && hits.length === 2 && hits.every((h) => /primary-500/.test(h.step)), `the sweep's colour check flags ${BRAND.id}'s ink painted as a fill or inside a shadow, and not the new brand's ink or white (${fc.size} forbidden values)`);
ok(forbiddenColours([BRAND], BRAND).size === 0, 'a brand forbids none of the colours it paints itself');

// ── 3. a throwaway brand, swapped in: what a customer receives follows it ──────────
// The generated identity is replaced in memory (a module load hook), so nothing on disk changes. Every
// document, email and draft is rendered under PROBE and checked: PROBE's name is there, and none of the
// active brand's identity strings (nor the shell's name in any spelling) is, except kept identifiers.
console.log(`rendered under a throwaway brand ("${PROBE.name}")`);
{
  const imp = (...p) => import(pathToFileURL(path.join(APP, ...p)).href);
  const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#0?39;|&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
  const oldStrings = needles(BRAND);
  const leaksIn = (text) => classify('(rendered)', text, oldStrings, { kind: 'text' }).rows.filter((r) => r.cls === 'leak').map((r) => r.text);
  // fictional demo data (the seeded org, the demo quotes and inspections) reads a place needle as fiction, the
  // same way the source scan does in FICTION files (CS-400); the brand's name and contacts there are still leaks
  const leaksInFiction = (text) => classify('(rendered)', text, oldStrings, { kind: 'text', fiction: true }).rows.filter((r) => r.cls === 'leak').map((r) => r.text);
  // what a person reads, kept for section 4: a string, or an email's subject, body and html
  const prose = [];
  const flat = (out) => (typeof out === 'string' ? out : Object.values(out || {}).filter((v) => typeof v === 'string').join('\n'));
  // what a reader sees of HTML: the text between the tags, joined, so a name split across elements
  // ("<div>CLEAN</div><div>SPACE</div>") reads as the name it spells
  const visible = (s) => s.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const check = (name, out, { mustShow = [PROBE.name], read = true, fiction = false } = {}) => {
    const raw = typeof out === 'string' ? out : JSON.stringify(out);
    const text = `${decode(raw)}\n${decode(visible(raw))}`;
    if (read) prose.push([name, decode(flat(out))]);
    const found = [...new Set((fiction ? leaksInFiction : leaksIn)(text))];
    const absent = mustShow.filter((s) => !text.includes(s));
    ok(found.length === 0 && absent.length === 0, `${name}${found.length ? ` shows the old brand: ${found.slice(0, 5).join(', ')}` : ''}${absent.length ? ` lacks ${absent.join(', ')}` : ''}`);
  };

  const { IDENTITY } = await imp('src', 'brand', 'identity.generated.js');
  ok(IDENTITY.name === PROBE.name && IDENTITY.company.address === `${PROBE.company.street}, ${PROBE.company.city}` && Object.isFrozen(IDENTITY.company.signatory), 'the swapped identity loads (deep-frozen, with the joined address)');

  const { buildQuoteHtml, PRINT_HEADER, PRINT_FOOTER } = await imp('src', 'lib', 'quoteTemplate.js');
  const fields = { clientName: 'Northside Auto Group', contactName: 'Morgan Hayes', restrooms: '4' };
  const sig = PROBE.company.signatory;
  check('the quote', buildQuoteHtml(fields, {}), { mustShow: [PROBE.name, PROBE.company.phone, PROBE.company.street, PROBE.company.website, PROBE.company.tagline, sig.name, sig.title] });
  check('the signed quote', buildQuoteHtml(fields, { locked: true, adminDate: '2026-09-25', clientDate: '2026-09-26', clientPrintedName: 'Morgan Hayes' }), { mustShow: [PROBE.name, `${sig.name}, ${sig.role}`] });
  check("the quote's PDF header", PRINT_HEADER, { mustShow: [PROBE.name, PROBE.company.services] });
  check("the quote's PDF footer", PRINT_FOOTER, { mustShow: [PROBE.name, PROBE.company.phone] });
  const { buildInspectionReportHtml, REPORT_PRINT_FOOTER } = await imp('src', 'lib', 'inspectionReportTemplate.js');
  const report = {
    inspection: { templateName: 'Monthly quality walk', clientName: 'Northside Auto Group', inspectorName: 'Kyler Nguyen', performedAt: '2026-09-22T15:00:00Z', result: 'pass', overallScore: 92,
      schema: { areas: [{ id: 'a1', label: 'Lobby', items: [{ id: 'i1', label: 'Floors' }] }] } },
    items: [{ itemKey: 'i1', rating: 'pass' }], photos: [],
  };
  check('the inspection report', buildInspectionReportHtml(report, {}));
  check('the inspection report (PDF)', buildInspectionReportHtml(report, { forPdf: true }));
  check("the report's PDF footer", REPORT_PRINT_FOOTER);
  const { DOC_LOGO } = await imp('src', 'brand', 'logo.js');
  check('the letterhead mark', decodeURIComponent(DOC_LOGO), { mustShow: [PROBE.name, PROBE.monogram] }); // as the browser reads the data URI
  // the mark sits in an <img src="…"> attribute: a browser decodes the attribute's entities, then the data
  // URI's percent-escapes, then parses the SVG as XML. A bare & (a name like PROBE's) breaks the image.
  const svgSeen = decodeURIComponent(decode(DOC_LOGO).replace(/^data:image\/svg\+xml;utf8,/, ''));
  ok(!/&(?!(amp|lt|gt|apos|quot|#\d+|#x[0-9a-f]+);)/i.test(svgSeen) && svgSeen.includes(decode(PROBE.name).replace(/&/g, '&amp;').replace(/'/g, '&apos;')),
    "the letterhead mark stays well-formed SVG inside an <img> attribute, with an ampersand and an apostrophe in the name");
  check("the quote's cover", buildQuoteHtml(fields, {}).split('<!-- Cover letter -->')[0], { mustShow: [PROBE.name.split(' ')[0].toUpperCase()] });
  // the quote's words are the brand pack's (CS-388): given its own pages, the throwaway brand's quote shows them
  // and no sentence of the active brand's pages (its claims, scope, guarantees and terms)
  ok(validateQuote(PROBE_QUOTE, PROBE).length === 0, "the throwaway brand's own quote pages are valid");
  const probeQuote = await import(`${pathToFileURL(path.join(APP, 'src', 'lib', 'quoteTemplate.js')).href}?pages=probe`);
  const own = decode(visible(probeQuote.buildQuoteHtml(fields, {})));
  const activePages = readQuote(BRAND.id) || '';
  const sentences = [...new Set(decode(visible(activePages.replace(/\{\{[^}]*\}\}/g, ' '))).split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= 40))];
  const kept = sentences.filter((s) => own.includes(s));
  ok(own.includes(PROBE_SENTINEL) && sentences.length >= 5 && kept.length === 0, `the quote's pages come from the brand pack: the throwaway brand's own words show, and none of ${sentences.length} sentences of ${BRAND.id}'s${own.includes(PROBE_SENTINEL) ? '' : ' (its own words are missing: the template writes its own)'}${kept.length ? ` (kept: ${kept.slice(0, 3).join(' | ')})` : ''}`);
  const client = await imp('src', 'lib', 'email.js');
  check('the quote email', client.buildQuoteEmail({ title: 'Nightly clean', amount: 1160, link: 'https://x.test/q/1', contactName: 'Morgan Hayes' }));
  check('the sign-request email', client.buildSignRequestEmail({ contactName: 'Morgan Hayes', companyName: 'Northside Auto Group', link: 'https://x.test/q/1' }));
  if (hasApi) {
    const server = await imp('api', '_lib', 'quotes', 'emails.js');
    const quote = { contact_name: 'Morgan Hayes', client_signer_name: 'Morgan Hayes', fields: { companyName: 'Northside Auto Group' } };
    check("the server's sign-request email", server.signRequestEmail({ quote, link: 'https://x.test/sign/abc' }));
    check("the server's signed copy (to the client)", server.signedCopyEmail({ quote, toClient: true }));
    check("the server's signed copy (internal)", server.signedCopyEmail({ quote, toClient: false }), { mustShow: [] });
    const saved = process.env.RESEND_DEFAULT_FROM;
    delete process.env.RESEND_DEFAULT_FROM;
    const { defaultFrom } = await imp('api', '_lib', 'email.js');
    ok(defaultFrom() === PROBE.email.quotesFrom, "the server's default sender is the brand's (with no RESEND_DEFAULT_FROM)");
    if (saved !== undefined) process.env.RESEND_DEFAULT_FROM = saved;
  }
  const { EMAIL_DRAFTS } = await imp('src', 'data', 'emailDrafts.js');
  let rendered = 0;
  const bodies = [];
  for (const d of EMAIL_DRAFTS) {
    if (typeof d.render !== 'function') continue;
    const out = d.render();
    rendered += 1;
    const text = decode(JSON.stringify(out));
    prose.push([`the "${d.name}" draft`, decode(flat(out))]);
    if (typeof out?.body === 'string') bodies.push([d.name, decode(out.body)]);
    const found = [...new Set(leaksIn(text))];
    if (found.length) ok(false, `the "${d.name}" draft shows the old brand: ${found.slice(0, 5).join(', ')}`);
  }
  ok(rendered >= 10, `all ${rendered} drafts in the review catalog render under the throwaway brand${rendered >= 10 ? '' : ' (expected at least 10)'}`);
  const { INITIAL_STATE } = await imp('src', 'data', 'seed.js');
  const owner = INITIAL_STATE.users.find((u) => u.role === 'owner');
  ok(INITIAL_STATE.company.name === PROBE.name && INITIAL_STATE.company.owner === sig.name && owner?.name === sig.name && owner?.email === sig.email && owner?.initials === 'AL' && INITIAL_STATE.company.logoInitials === PROBE.monogram,
    "the seed's org and first Super Admin are the brand's (name, owner, email, initials, monogram)");
  check('the seeded demo org', INITIAL_STATE, { mustShow: [PROBE.name, PROBE.company.domain, sig.name], read: false, fiction: true });
  // the seed's own org address follows the brand (CS-400): with the place classed fiction, this positive check
  // keeps the coverage — a stale org address left on the previous client's street or city is caught here
  ok(typeof INITIAL_STATE.company.address === 'string' && INITIAL_STATE.company.address.includes(PROBE.company.street) && INITIAL_STATE.company.address.includes(PROBE.company.city),
    `the seed's org address shows the brand's street and city (got "${INITIAL_STATE.company.address}")`);
  // the seed's mail follows the owner (CS-390): every seeded email lands on an inbox the seed holds, no seeded
  // message or signature names the active brand's owner (PROBE's owner has taken the place), and the team inbox
  // signs with the company's phone
  const inboxes = new Set([...(INITIAL_STATE.connectedInboxes || []), ...(INITIAL_STATE.marketingInboxes || [])].map((i) => i.email.toLowerCase()));
  const orphans = (INITIAL_STATE.messages || []).filter((m) => m.toInboxEmail && !inboxes.has(m.toInboxEmail.toLowerCase())).map((m) => `${m.id} → ${m.toInboxEmail}`);
  ok(inboxes.size >= 2 && orphans.length === 0, `every seeded email is addressed to a seeded inbox (${inboxes.size} inboxes)${orphans.length ? `; orphaned: ${orphans.join(', ')}` : ''}`);
  const words = (t) => String(t || '').split(/[^\p{L}\p{N}]+/u);
  const MONTHS = new Set(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
  // the seeded messages and signatures that name an owner, and the word the check reads. The first name alone is
  // ambiguous — only the full name is the owner's — when the demo shares it with a fictional person (CS-399), when
  // the seeded prose uses it as an everyday word (its lower-case form appears as a word, e.g. "will"), or when it
  // is an English month ("May 15"); reading it as the owner then flagged the demo's ordinary prose (CS-400).
  const ownerMentions = (state, ownerName) => {
    const first = ownerName.split(/\s+/)[0];
    const lower = first.toLowerCase();
    const people = [...(state.users || []).map((u) => u.name), ...(state.contacts || []).map((c) => c.firstName || c.name), ...(state.clients || []).map((c) => c.primaryContact)]
      .filter((n) => n && n !== ownerName).map((n) => String(n).split(/\s+/)[0]);
    const texts = [...(state.messages || []).map((m) => [m.id, m.text]), ...(state.marketingInboxes || []).map((i) => [i.id, i.signature])];
    const shared = people.includes(first) || (first !== lower && texts.some(([, t]) => words(t).includes(lower))) || MONTHS.has(lower);
    return { needle: shared ? ownerName : first, said: texts.filter(([, t]) => (shared ? String(t || '').includes(ownerName) : words(t).includes(first))).map(([id]) => id) };
  };
  const mentioned = ownerMentions(INITIAL_STATE, BRAND.company.signatory.name);
  ok(mentioned.said.length === 0, `no seeded message or signature names ${BRAND.id}'s owner ("${mentioned.needle}")${mentioned.said.length ? `: ${mentioned.said.join(', ')}` : ''}`);
  // an owner who shares a first name with one of the demo's fictional people (its second owner is Dana Cole, a
  // customer is Dana Park) is not named by their lines: only the owner's full name counts then
  ok(ownerMentions(INITIAL_STATE, 'Dana Whitfield').said.length === 0 && ownerMentions({ messages: [{ id: 'x', text: 'Ask Dana Whitfield first.' }] }, 'Dana Whitfield').said.join() === 'x',
    'an owner who shares a first name with a fictional person in the demo is found by their full name, not flagged for the fictional one\'s lines');
  // an owner whose first name the demo writes as an everyday word (its lower-case form, "will") or as an English
  // month ("May 15") is read by the full name too, so the demo's ordinary prose is not mistaken for the owner (CS-400)
  ok(ownerMentions(INITIAL_STATE, 'Will Harper').said.length === 0 && ownerMentions(INITIAL_STATE, 'May Chen').said.length === 0,
    'an owner named Will or May is not flagged for the demo\'s "will" / "May" prose');
  ok(ownerMentions({ messages: [{ id: 'x', text: 'Ask Will Harper first. We will call.' }] }, 'Will Harper').said.join() === 'x',
    'an owner named Will is still found by their full name');
  ok(ownerMentions({ messages: [{ id: 'x', text: 'Hi Matt, see you then.' }] }, 'Matt Giunco').said.join() === 'x',
    'a plain first name (not shared, not an everyday word or a month) stays in first-name mode');
  const team = (INITIAL_STATE.marketingInboxes || []).find((i) => i.senderName === PROBE.name);
  ok(!!team && team.signature.includes(PROBE.company.phone), `the seeded team inbox signs with the company's phone${team ? '' : ' (no team inbox found)'}`);
  // the stored-owner correction (persist.js v53 → v54) writes the seed's owner, so it follows the brand as the
  // seed does: a re-branded build must not put the previous client's owner back on a returning browser (CS-391)
  const { correctOwnerIdentity } = await imp('src', 'lib', 'ownerRename.js');
  const fixed = correctOwnerIdentity([{ id: owner.id, name: 'Marcus Alvarez', initials: 'MA', email: 'marcus@x.test', role: 'owner' }])[0];
  ok(fixed.name === owner.name && fixed.initials === owner.initials && fixed.email === owner.email, `the stored-owner correction writes the brand's owner, as the seed does (got ${fixed.name}, ${fixed.initials}, ${fixed.email})`);
  for (const t of INITIAL_STATE.reminderTemplates || []) prose.push([`the seeded "${t.key}" reminder`, `${t.subject || ''}\n${t.body || ''}`]);
  const { buildDemoStubs } = await imp('src', 'data', 'demoStubs.js');
  check('the seeded demo quotes and inspections', buildDemoStubs(), { mustShow: [sig.name], read: false, fiction: true });
  const oldShown = identityStrings(BRAND).map(([, s]) => s);
  ok(oldShown.length >= 15 && oldShown.includes(BRAND.company.signatory.name), `the check forbids ${oldShown.length} identity strings of "${BRAND.id}" (its owner among them)`);

  // ── 4. the identity reads as prose ─────────────────────────────────────────────
  // The same renders, read as sentences. The em-dash sweep (12185f5) turned "— Name" sign-offs into a stray or
  // doubled period, and a template put the brand's name where the client's belongs (CS-386, CS-387).
  console.log('the identity reads as prose (the same renders)');
  const strip = (s) => s.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ');
  const broken = prose.flatMap(([name, text]) => {
    const t = strip(text);
    return [...t.matchAll(/(?<!\.)\.\.(?!\.)|[.!?]["'”)\]]?\s+\.(?=\s|$)/g)].map((m) => `${name}: …${t.slice(Math.max(0, m.index - 40), m.index + 30).replace(/\s+/g, ' ')}…`);
  });
  ok(prose.length >= 50 && broken.length === 0, `no doubled or stray period in ${prose.length} renders and seeded reminders${broken.length ? `:\n      ${broken.slice(0, 20).join('\n      ')}` : ''}`);
  const twice = bodies.flatMap(([n, b]) => b.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.split(PROBE.name).length > 2).map((s) => `${n}: "${s.trim()}"`));
  ok(bodies.length >= 20 && twice.length === 0, `no draft names the brand twice in one sentence (${bodies.length} bodies)${twice.length ? `:\n      ${twice.join('\n      ')}` : ''}`);
  const gmail = fs.readFileSync(path.join(APP, 'src', 'components', 'GmailConnectInstructions.jsx'), 'utf8');
  ok(!/marcus@/i.test(gmail) && gmail.includes("IDENTITY.company.signatory.email.split('@')[0]") && !/<\/em>\)\.\s*\r?\n\s*no per-inbox/.test(gmail), "the Gmail help's sender example pairs the signatory's name with the signatory's address, in one sentence");
}

if (failed) { console.error(`\n✗ test-name-ledger: ${failed} check(s) failed`); process.exit(1); }
console.log('\n✓ test-name-ledger: the name guarantee holds and every detection fires');
