// test-brand — the brand generator (scripts/brand.mjs) as a CI gate (UI_RULES §129).
//
// A brand is one file, brands/<id>/brand.json; `npm --prefix app run brand -- <id>` writes it everywhere the
// app reads it. This suite fails when:
//   1. a brand file is malformed, or the committed outputs (src/brand/identity.generated.js, index.html,
//      public/manifest.json, public/sw.js) no longer match the active brand's file (someone edited an output,
//      or changed the brand file without regenerating);
//   2. the schema stops catching a bad value (fixtures: each rule, and the values it must accept);
//   3. the generator writes anything but the lines it owns, escapes a value wrongly, or does not round-trip:
//      apply a throwaway brand to every output in memory, apply the active brand back, and the bytes match.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BRANDS, IDENTITY_OUT, validate, loadBrand, brandIds, identityOf, identityText, identityStrings, localeOf,
  rewriteStatic, ownedLines, missingAnchors, activeBrandId, brandTargets, readQuote, validateQuote, quoteText,
} from './brand.mjs';
import { derivePalette, contrastChecks, paletteBlock, TOKENS, channels, contrast } from './brand-colors.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };
const norm = (s) => s.replace(/\r\n/g, '\n');

// ── 1. the brand files and the committed outputs ─────────────────────────────
console.log('brand files and outputs');
const ids = brandIds();
ok(ids.length >= 1, `brands/ holds ${ids.length} brand file(s): ${ids.join(', ')}`);
for (const id of ids) {
  const { error } = loadBrand(id);
  ok(!error, `brands/${id}/brand.json is valid${error ? `:\n${error}` : ''}`);
}
const activeId = activeBrandId();
ok(!!activeId && ids.includes(activeId), `the active brand ("${activeId}", recorded in identity.generated.js) has a brand file`);
const active = loadBrand(activeId);
if (active.error) { console.error(active.error); process.exit(1); }
const BRAND = active.brand;
const stale = brandTargets(BRAND).filter(([, before, after]) => norm(before) !== norm(after)).map(([f]) => path.relative(APP, f));
ok(stale.length === 0, `every output matches brands/${activeId}/brand.json${stale.length ? ` (stale: ${stale.join(', ')}; run \`npm --prefix app run brand -- ${activeId}\`)` : ''}`);
let cli = '';
try { cli = execFileSync(process.execPath, [path.join(APP, 'scripts', 'brand.mjs'), '--check'], { encoding: 'utf8' }); } catch (e) { cli = `exit ${e.status}: ${e.stderr}`; }
ok(/match brands\//.test(cli), '`node scripts/brand.mjs --check` agrees');

// ── 2. the schema ────────────────────────────────────────────────────────────
console.log('the schema');
const clone = () => JSON.parse(JSON.stringify(BRAND));
const set = (b, key, v) => { const ks = key.split('.'); const last = ks.pop(); const o = ks.reduce((x, k) => x[k], b); if (v === undefined) delete o[last]; else o[last] = v; return b; };
const rejects = (label, key, v, want) => {
  const errs = validate(set(clone(), key, v));
  ok(errs.some((e) => e.startsWith(want)), `${label} → rejected${errs.length ? '' : ' (no error)'}`);
};
ok(validate(clone()).length === 0, 'the active brand passes');
rejects('a missing name', 'name', undefined, 'name:');
rejects('an empty wordmark', 'wordmark', '   ', 'wordmark:');
rejects('a missing signatory', 'company.signatory', undefined, 'company.signatory:');
rejects("a missing signatory's email", 'company.signatory.email', undefined, 'company.signatory.email:');
rejects('a number where text belongs', 'company.phone', 7542540375, 'company.phone:');
rejects('an unknown top-level field', 'fax', '555', 'fax:');
rejects('an unknown company field', 'company.fax', '555', 'company.fax:');
rejects('an unknown signatory field', 'company.signatory.nickname', 'M', 'company.signatory.nickname:');
rejects('another schema version', 'version', 2, 'version:');
rejects('an id with capitals', 'id', 'CleanSpace', 'id:');
rejects('a slug with a space', 'slug', 'clean space', 'slug:');
rejects('a four-letter monogram', 'monogram', 'CSPC', 'monogram:');
rejects('a domain with a scheme', 'company.domain', 'https://example.com', 'company.domain:');
rejects('an email without a domain', 'company.email', 'office', 'company.email:');
rejects('an app URL with a path', 'appUrl', 'https://example.com/app', 'appUrl:');
rejects('an app URL over http', 'appUrl', 'http://example.com', 'appUrl:');
rejects('a sender without its address', 'email.quotesFrom', 'quotes@example.com', 'email.quotesFrom:');
rejects('a value on two lines', 'company.tagline', 'One\nTwo', 'company.tagline:');
// a Unicode line break ends a line for a pattern's `.` and `$`: the next run would rewrite only part of sw.js's
// APP_NAME line and leave it broken (CS-394)
rejects('a line separator (U+2028) in a name', 'name', 'Acme\u2028Co', 'name:');
rejects('a paragraph separator (U+2029) in a tagline', 'company.tagline', 'One\u2029Two', 'company.tagline:');
rejects('a next-line character (U+0085) in the services', 'company.services', 'One\u0085Two', 'company.services:');
rejects('a value with a trailing space', 'name', 'Acme ', 'name:');
rejects('a double quote in a name (it lands in HTML attributes)', 'name', 'The "Best" Co', 'name:');
rejects('an angle bracket in a name', 'shortName', 'Acme <Ops>', 'shortName:');
rejects('a percent sign in a name (the letterhead is a data URI)', 'name', '100% Clean', 'name:');
const accepts = (label, key, v) => { const errs = validate(set(clone(), key, v)); ok(errs.length === 0, `${label} → accepted${errs.length ? ` (got ${errs.join('; ')})` : ''}`); };
accepts('an ampersand and an apostrophe in a name', 'name', "Smith & O'Neil Cleaning");
accepts('letters outside ASCII', 'wordmark', 'Nørdrén');
accepts('a port on the app URL', 'appUrl', 'https://localhost:5213');
// the address line carries the locale the form hints read (CS-392): "City, ST 12345"
rejects('a city without its state and ZIP', 'company.city', 'Fort Lauderdale', 'company.city:');
rejects('a state spelled out', 'company.city', 'Portland, Maine 04101', 'company.city:');
accepts('a ZIP+4', 'company.city', 'Miami, FL 33142-1234');
{
  const at = (city, phone) => identityOf({ ...clone(), company: { ...clone().company, city, phone } }).company;
  const a = at('Portland, ME 04101', '1-555-010-0142');
  ok(a.locality === 'Portland' && a.region === 'ME' && a.postalCode === '04101' && a.areaCode === '555', `the locale comes from the address line and the phone (got ${a.locality}, ${a.region}, ${a.postalCode}, ${a.areaCode})`);
  const b = at('Miami, FL 33142-1234', '(305) 555-0100');
  ok(b.postalCode === '33142-1234' && b.areaCode === '305' && localeOf(BRAND.company).locality.length > 0, 'a ZIP+4, and a phone written without the country code');
}
// colours: the four base colours, and pins of known palette keys
rejects('no colours', 'colors', undefined, 'colors:');
rejects('a base colour missing', 'colors.link', undefined, 'colors.link:');
rejects('a base colour in shorthand', 'colors.primary', '#123', 'colors.primary:');
rejects('an unknown colour field', 'colors.accent', '#123456', 'colors.accent:');
rejects('a pin of an unknown palette key', 'colors.pins', { 'primary-450': '#123456' }, 'colors.pins.primary-450:');
rejects('a pin that is not a colour', 'colors.pins', { 'primary-600': 'black' }, 'colors.pins.primary-600:');
accepts('a brand with no pins (every step derived)', 'colors.pins', undefined);
// logos: the mark and the lockup, each a file in the brand's folder and an optional crop box
rejects('no logos', 'logos', undefined, 'logos:');
rejects('no lockup', 'logos.lockup', undefined, 'logos.lockup:');
rejects('a logo file with a path', 'logos.mark.file', '../elsewhere/mark.png', 'logos.mark.file:');
rejects('a crop box in fractions', 'logos.mark.box', { left: 0.5, top: 0, width: 10, height: 10 }, 'logos.mark.box:');
rejects('an unknown logo field', 'logos.mark.tint', '#ffffff', 'logos.mark.tint:');
// loadBrand: the file, its JSON, and its folder
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-brand-'));
try {
  const put = (id, text, logos = true, quote = true) => {
    fs.mkdirSync(path.join(tmp, id), { recursive: true });
    fs.writeFileSync(path.join(tmp, id, 'brand.json'), text);
    if (logos) for (const k of ['mark', 'lockup']) fs.writeFileSync(path.join(tmp, id, BRAND.logos[k].file), '');
    if (quote) fs.writeFileSync(path.join(tmp, id, 'quote.html'), `${readQuote(BRAND.id)}\n`);
  };
  put('good', JSON.stringify({ ...clone(), id: 'good' }));
  put('moved', JSON.stringify(clone()));
  put('broken', '{ "id": "broken", ');
  put('nologo', JSON.stringify({ ...clone(), id: 'nologo' }), false);
  put('noquote', JSON.stringify({ ...clone(), id: 'noquote' }), true, false);
  ok(!loadBrand('good', tmp).error, 'a valid file loads');
  ok(/does not match its folder/.test(loadBrand('moved', tmp).error || ''), "a file whose id is not its folder's name → rejected");
  ok(/brand\.json:/.test(loadBrand('broken', tmp).error || ''), 'a file that is not JSON → rejected');
  ok(/no brand file/.test(loadBrand('absent', tmp).error || ''), 'a missing file → rejected');
  ok(/logos\.mark\.file: no /.test(loadBrand('nologo', tmp).error || ''), "a logo file missing from the brand's folder → rejected");
  ok(/quote\.html: missing/.test(loadBrand('noquote', tmp).error || ''), "a brand without its quote's pages → rejected (CS-388)");
  ok(brandIds(tmp).join() === 'broken,good,moved,nologo,noquote', 'brandIds lists the folders that hold a brand.json');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
// the quote's pages (brands/<id>/quote.html, CS-388): known tokens only, every field and both signatures,
// nothing that runs, no colour literal, and the brand's identity only through its tokens
{
  const Q = readQuote(BRAND.id);
  const refuses = (label, text, want) => { const e = validateQuote(text, BRAND); ok(e.some((x) => x.includes(want)), `the quote: ${label} → refused${e.length ? '' : ' (no error)'}`); };
  ok(!!Q && validateQuote(Q, BRAND).length === 0, `brands/${BRAND.id}/quote.html is valid`);
  refuses('an unknown token', `${Q}{{nme}}`, 'unknown token {{nme}}');
  refuses('a field without its hint', `${Q}{{field.amount}}`, 'unknown token');
  refuses('a field the quote does not have', `${Q}{{field.tip|Tip}}`, 'unknown token');
  refuses('a section never closed', `${Q}{{#logo}}x`, 'never closed');
  refuses('a section closed out of turn', `${Q}{{/logo}}`, 'closes no open');
  refuses('no signature for the brand', Q.replace('{{signature.admin}}', ''), 'needs {{signature.admin}}');
  refuses('no amount to fill in', Q.split(/\{\{field\.amount\|[^}]*\}\}/).join(''), 'needs {{field.amount|<hint>}}');
  refuses('a script', `${Q}<script>alert(1)</script>`, 'no scripts');
  refuses('an event handler', `${Q}<img src="x" onerror="alert(1)">`, 'no scripts');
  // HTML also starts an attribute after a slash or right after a quoted value (the fix wave's re-verification)
  refuses('a handler after a slash', `${Q}<img/onerror=alert(1)>`, 'no scripts');
  refuses('a handler right after a quoted value', `${Q}<img src="x"onerror="alert(1)">`, 'no scripts');
  refuses('a colour literal', `${Q}<p style="color:#ff0000">x</p>`, 'no colour literals');
  refuses("the brand's name written out", `${Q}<p>${BRAND.name}</p>`, "writes the brand's name");
  ok(validateQuote(`${Q}<p>it&#8217;s</p>`, BRAND).length === 0, 'the quote: a numeric character reference is not a colour');
  const odd = 'a `b` ${c} \\d';
  const m = await import(`data:text/javascript,${encodeURIComponent(quoteText(BRAND, odd))}`);
  ok(m.QUOTE_BODY === odd, 'quote.generated.js holds the pages exactly (a backtick, ${ and a backslash escaped)');
}

// ── 3. the generator ─────────────────────────────────────────────────────────
console.log('the generator');
// the identity code reads: the brand minus the colour and asset sections, with the joined address, deep-frozen
const withSections = { ...clone(), colors: { brand: '#000000' }, logos: { light: 'x.png' } };
const idn = identityOf(withSections);
ok(!('colors' in idn) && !('logos' in idn) && !('version' in idn) && idn.company.address === `${BRAND.company.street}, ${BRAND.company.city}`, 'identityOf drops colours, logos and version and joins the address');
const mod = await import(`data:text/javascript,${encodeURIComponent(identityText(BRAND))}`);
ok(JSON.stringify(mod.IDENTITY) === JSON.stringify(identityOf(BRAND)), 'the generated module exports exactly identityOf(brand)');
ok(Object.isFrozen(mod.IDENTITY) && Object.isFrozen(mod.IDENTITY.company) && Object.isFrozen(mod.IDENTITY.company.signatory), 'IDENTITY is frozen all the way down');
ok(identityText(BRAND).includes(`brands/${BRAND.id}/brand.json`) && /Do not edit/.test(identityText(BRAND)), 'the generated file names its source and says not to edit it');
ok(fs.readFileSync(IDENTITY_OUT, 'utf8').includes(`"id": "${activeId}"`), 'identity.generated.js records the active brand id');
// the static outputs: a throwaway brand changes exactly the owned lines, escaped for each file, and round-trips
const PROBE = {
  ...clone(), id: 'probe', name: "Nørd & O'Hara Facility Care", shortName: "Nørd & O'Hara", appTitle: "Nørd & O'Hara Ops",
  description: "Operations for Nørd & O'Hara.", slug: 'nord-care',
};
const owned = { 'index.html': 3, 'public/manifest.json': 3, 'public/sw.js': 1 };
for (const [rel, n] of Object.entries(owned)) {
  const text = fs.readFileSync(path.join(APP, rel), 'utf8');
  const lines = ownedLines(rel, text);
  ok(lines && lines.size === n, `${rel}: the generator owns ${n} line(s)${lines ? ` (found ${lines.size})` : ''}`);
  const out = rewriteStatic(rel, text, PROBE);
  const a = text.split(/\r?\n/); const b = out.split(/\r?\n/);
  const changed = a.flatMap((l, i) => (l !== b[i] ? [i + 1] : []));
  ok(a.length === b.length && changed.length === n && changed.every((i) => lines.has(i)), `${rel}: a new brand changes exactly those lines`);
  ok(rewriteStatic(rel, out, BRAND) === text, `${rel}: applying ${BRAND.id} back restores it byte for byte`);
  if (rel === 'index.html') ok(out.includes('<title>Nørd &amp; O\'Hara Ops</title>') && out.includes('content="Nørd &amp; O\'Hara"'), 'index.html: the values are HTML-escaped');
  if (rel === 'public/manifest.json') { const m = JSON.parse(out); ok(m.name === PROBE.name && m.short_name === PROBE.shortName && m.description === PROBE.description, 'manifest.json: still JSON, carrying the new values'); }
  if (rel === 'public/sw.js') { const m = /^const APP_NAME = (".*?");/m.exec(out); ok(!!m && JSON.parse(m[1]) === PROBE.name, 'sw.js: APP_NAME is a valid string literal of the new name'); }
}
ok(ownedLines('src/App.jsx', 'x') === null, 'any other file owns no generated lines');

// ── 4. the palette ───────────────────────────────────────────────────────────
console.log('the palette');
{
  const checksOf = (colors) => contrastChecks(derivePalette(colors).values);
  const base = { primary: BRAND.colors.primary, secondary: BRAND.colors.secondary, link: BRAND.colors.link, neutral: BRAND.colors.neutral };
  const all = checksOf(BRAND.colors);
  ok(all.length >= 20 && all.every((c) => c.pass), `${BRAND.id}'s palette passes all ${all.length} contrast checks`);
  ok(checksOf(base).every((c) => c.pass), `${BRAND.id}'s base colours pass them derived, with no pins`);
  for (const id of ids) {
    const { brand } = loadBrand(id);
    const f = checksOf(brand.colors).filter((c) => !c.pass);
    ok(f.length === 0, `brands/${id}: every contrast check passes${f.length ? ` (fails: ${f.map((c) => `${c.name} ${c.ratio}`).join('; ')})` : ''}`);
  }
  // the mixing table, pinned: a change to a ratio changes every unpinned brand's palette, so it must be deliberate
  const d = derivePalette({ primary: '#204060', secondary: '#FFCC66', link: '#1D4ED8', neutral: '#6B7280' }).values;
  const golden = { 'neutral-50': '#fafafa', 'neutral-400': '#9ea3ac', 'neutral-900': '#18191c', 'primary-50': '#f4f5f7', 'primary-400': '#587088', 'primary-500': '#204060', 'primary-700': '#0d1a26', 'secondary-100': '#ffedc9', 'secondary-700': '#b38f47', 'surface-page': '#f5f5f6', border: '#e5e7e9', 'upcoming-border': '#f3e6cb', link: '#1d4ed8' };
  const off = Object.entries(golden).filter(([k, v]) => d[k].toLowerCase() !== v);
  ok(off.length === 0, `derived steps match the table's golden values${off.length ? ` (off: ${off.map(([k, v]) => `${k} ${d[k]} ≠ ${v}`).join(', ')})` : ''}`);
  const pinned = derivePalette({ ...base, pins: { 'primary-600': '#010203' } });
  ok(pinned.values['primary-600'] === '#010203' && pinned.pinned.join() === 'primary-600' && pinned.values['primary-700'] === pinned.derived['primary-700'], 'a pin replaces exactly its step, keeping its spelling');
  // each check fires: a palette that breaks it is refused
  const cases = [
    ['a light primary', { ...base, primary: '#7FB3E6' }, 'text on the brand ink'],
    ['the deepest ink pinned light', { ...base, pins: { 'primary-700': '#DDDDDD' } }, 'text on the deepest ink'],
    ['a dark secondary', { ...base, secondary: '#7A4A00' }, 'the ink on the accent'],
    // CS-393: this accent passes on its own fill (4.51:1) but the CTA's hover fill, one step darker, reads 3.62:1
    ['an accent whose hover step is too dark', { ...base, secondary: '#B46E61' }, "the ink on the accent's hover"],
    ['a light primary', { ...base, primary: '#7FB3E6' }, 'the ink on white'],
    ['a light link', { ...base, link: '#8FB0F0' }, 'links on white'],
    ['a light link', { ...base, link: '#8FB0F0' }, 'links on the page'],
    ['a light neutral', { ...base, neutral: '#A3A3A3' }, 'neutral 500 on white'],
    ['a light neutral', { ...base, neutral: '#A3A3A3' }, 'neutral 600 on the page'],
    ['body text pinned grey', { ...base, pins: { 'neutral-800': '#6B7280' } }, 'body text (neutral 800) on white'],
    ['body text pinned grey', { ...base, pins: { 'neutral-800': '#6B7280' } }, 'body text on a well'],
    ['the upcoming card pinned dark', { ...base, pins: { 'upcoming-bg': '#555555' } }, 'body text on the upcoming card'],
    ['a light primary', { ...base, primary: '#7FB3E6' }, 'the focus ring on white'],
    ['a light primary', { ...base, primary: '#7FB3E6' }, 'the focus ring on a field'],
    ['a light primary', { ...base, primary: '#7FB3E6' }, 'the focus ring on the page'],
    ['a light primary', { ...base, primary: '#7FB3E6' }, 'the focus ring on a well'],
    ['a mid-tone primary', { ...base, primary: '#0B4F4A' }, 'the focus ring against the focused border'],
    ['a hairline pinned near white', { ...base, pins: { border: '#FCFCFC' } }, 'a hairline on white'],
    ['a hairline pinned near white', { ...base, pins: { border: '#FCFCFC' } }, 'a hairline on the page'],
    ['the page pinned white', { ...base, pins: { 'surface-page': '#FFFFFF' } }, 'the page against a card'],
    ['the well pinned to the page', { ...base, pins: { 'surface-sunken': '#F4F5F7', 'surface-page': '#F4F5F7' } }, 'a well against the page'],
    ['the zebra pinned white', { ...base, pins: { zebra: '#FFFFFF' } }, 'the zebra row against white'],
  ];
  const fired = new Set();
  for (const [label, colors, check] of cases) {
    const failing = checksOf(colors).filter((c) => !c.pass).map((c) => c.name);
    const hit = failing.find((n) => n.startsWith(check));
    if (hit) fired.add(hit);
    else ok(false, `${label} → "${check}" should fail (failing: ${failing.join('; ') || 'none'})`);
  }
  ok(all.every((c) => fired.has(c.name)), `each of the ${all.length} contrast checks fails on a palette built to break it${all.filter((c) => !fired.has(c.name)).length ? ` (never fired: ${all.filter((c) => !fired.has(c.name)).map((c) => c.name).join('; ')})` : ''}`);
  // the accent as text (CS-395): every rule that paints text in an accent step sits on a ground that keeps it
  // readable (4.5:1, R5) under every brand's palette. A rule's ground is its own background, or GROUND names the
  // one it sits on; MARKS paint a glyph in the accent, not text (R3's gold marker).
  const GROUND = {
    '.avatar': ['primary-500', "the avatar's fill: --avatar-1…5 are the ink in the client theme"],
    '.pay-rail-total-l': ['primary-500', "on .pay-rail-total's ink"],
    '.pay-foot-l': ['primary-500', "on .pay-drawer-foot's ink"],
    '.review-hero-num': ['primary-500', "the Review hub's gold attention number on .review-hero's ink"],
    '.review-hero-caught-ic': ['primary-500', "the all-caught-up check glyph on .review-hero's ink"],
  };
  const MARKS = new Set(['.activity-card-payment .activity-card-icon', '.thread-section-header svg', '.btn-icon.starred', '.btn-icon.starred svg']);
  const css = fs.readFileSync(path.join(APP, 'src', 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim().replace(/\s+/g, ' '), m[2]])
    .flatMap(([sel, d]) => { const c = /(?:^|[;\s])color:\s*var\(--color-brand-secondary-(\d+)\)/.exec(d); return c && !MARKS.has(sel) ? [[sel, `secondary-${c[1]}`, d]] : []; });
  const groundOf = (sel, d) => {
    const bg = /background(?:-color)?:\s*var\(--(?:color-brand-)?(primary|secondary)(?:-(\d+))?\)/.exec(d);
    return bg ? `${bg[1]}-${bg[2] || '500'}` : GROUND[sel]?.[0] || '#ffffff';
  };
  ok(rules.length >= 6 && Object.keys(GROUND).every((s) => rules.some(([sel]) => sel === s)), `index.css paints text in the accent in ${rules.length} rules, each checked (every ground named in GROUND is still in use)`);
  for (const id of ids) {
    const v = derivePalette(loadBrand(id).brand.colors).values;
    const low = rules.map(([sel, step, d]) => { const g = groundOf(sel, d); return [sel, step, g, contrast(v[step], v[g] || g)]; }).filter(([, , , r]) => r < 4.5);
    ok(low.length === 0, `brands/${id}: the accent as text reads at 4.5:1 or more on its ground${low.length ? ` (below: ${low.map(([s, st, g, r]) => `${s} ${st} on ${g} ${r.toFixed(2)}`).join('; ')})` : ''}`);
  }
  // the block: every palette token once, a channel triplet that matches its colour
  const { text } = paletteBlock(BRAND);
  const decl = (tok) => new RegExp(`--${tok}: ([^;]+);`).exec(text)?.[1];
  ok(TOKENS.every(([, tok]) => text.split(`--${tok}:`).length === 2), `the BRAND PALETTE block declares each of its ${TOKENS.length} tokens once`);
  ok(decl('color-brand-primary-rgb') === channels(decl('color-brand-primary-500')) && decl('color-neutral-rgb') === channels(decl('color-neutral-900')), 'each channel triplet is its colour\'s');
}
// a lost anchor fails loudly instead of writing nothing; a `$` pattern in a name is written literally
ok(Object.keys(owned).every((rel) => missingAnchors(rel, fs.readFileSync(path.join(APP, rel), 'utf8')).length === 0), 'every output still carries each line the generator writes');
ok(missingAnchors('public/sw.js', "self.addEventListener('push', () => {});").length === 1 && missingAnchors('index.html', '<head></head>').length === 3, 'an output that lost those lines is reported, not silently skipped');
const dollar = { ...PROBE, name: 'Cash$1 & $& Co', shortName: 'Cash$2', appTitle: "Cash$' Ops", description: 'Pay $$ less.' };
const man = JSON.parse(rewriteStatic('public/manifest.json', fs.readFileSync(path.join(APP, 'public', 'manifest.json'), 'utf8'), dollar));
ok(man.name === dollar.name && man.short_name === dollar.shortName && man.description === dollar.description && rewriteStatic('index.html', '<title>x</title>', dollar) === "<title>Cash$' Ops</title>", 'a name holding $1, $& or $$ is written literally');
let refused = '';
try { execFileSync(process.execPath, [path.join(APP, 'scripts', 'brand.mjs'), '--check', 'no-such-brand'], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { refused = String(e.stderr); }
ok(/no brand file at brands\/no-such-brand/.test(refused), 'the CLI refuses a brand that has no file');
// identity strings: what the ledger and the sweep forbid once another brand is active
const strs = new Map(identityStrings(BRAND).map(([k, v]) => [k, v]));
ok(strs.get('name') === BRAND.name && strs.get('signatory') === BRAND.company.signatory.name && strs.get('quotes sender') === /<([^>]+)>/.exec(BRAND.email.quotesFrom)[1], 'identity strings carry the name, the owner and the sender addresses');
ok(![...strs.values()].includes(BRAND.monogram) && ![...strs.values()].includes(BRAND.company.signatory.role), 'short values (the monogram, the role) are not identity strings, so they cannot match ordinary words');
// a description — the signatory title, the services, the tagline — is the brand's identity only at three words
// or more, as needleFor reads words (a hyphen or an ampersand splits two words as a space does); a one- or
// two-word one is a role the app's own screens name ("Owner", "Office Manager") or the trade's vocabulary
// ("Janitorial", "Floor Care"), and reading it as identity flagged every such word as a leak (CS-400, replacing
// CS-399's white-space test; Reskin Studio's first real run: 501 false leaks)
const titled = (title) => identityStrings({ ...BRAND, company: { ...BRAND.company, signatory: { ...BRAND.company.signatory, title } } }).map(([, v]) => v);
const serviced = (services) => identityStrings({ ...BRAND, company: { ...BRAND.company, services } }).map(([, v]) => v);
const taglined = (tagline) => identityStrings({ ...BRAND, company: { ...BRAND.company, tagline } }).map(([, v]) => v);
ok(!titled('Owner').includes('Owner') && !titled('Office Manager').includes('Office Manager'), 'a one- or two-word title is not an identity string (it is a role the app names)');
ok(!titled('Owner-Operator').includes('Owner-Operator') && titled('Owner-Operator').includes('Owner-Operator') === titled('Owner Operator').includes('Owner Operator'), '"Owner-Operator" is not an identity string and is read like "Owner Operator" (needleFor reads both as two words)');
ok(!serviced('Janitorial').includes('Janitorial') && !serviced('Floor Care').includes('Floor Care'), "a one- or two-word services phrase is the trade's vocabulary, not identity");
ok(!taglined('Clean Team').includes('Clean Team'), 'a two-word tagline is not an identity string');
ok(titled('Owner & Facility Services Consultant').includes('Owner & Facility Services Consultant'), 'a title of three words or more stays an identity string');
ok(serviced('Supervised Janitorial, Floor Care & Facility Services').includes('Supervised Janitorial, Floor Care & Facility Services'), 'a services phrase of three words or more stays an identity string');
ok(fs.existsSync(path.join(BRANDS, '..', 'app', 'package.json')), 'brands/ sits at the repository root, beside app/');

if (failed) { console.error(`\n✗ test-brand: ${failed} check(s) failed`); process.exit(1); }
console.log('\n✓ test-brand: every brand file is valid, the outputs are current and the generator round-trips');
