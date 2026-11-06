// test-color-logos — the optional colour-logo brand-pack fields (UI_RULES §121, §129; REBRAND.md §1).
//
// A pack may carry the client's own logo in its own colours: logos.lockup.color (their whole logo, on a
// transparent ground) and logos.mark.color (their icon alone), each png/webp/svg, never jpg; logos.mark.tile
// "white" places the colour mark on a white icon tile instead of the one-colour glyph on the brand ink; and
// logos.lockup.sidebar "white" keeps the one-colour knock-out on the sidebar. All are optional: a pack without
// them draws the one-colour images. This suite fails when:
//   1. the schema stops accepting the new keys, or stops refusing a bad one (tile "white" with no mark.color,
//      sidebar "color" with no lockup.color, a colour file that is not png/webp/svg, an unknown key), or
//      loadBrand stops checking a colour file exists;
//   2. the sidebar logo goes wrong: a colour logo that reads on the sidebar (≥ the graphics floor, coverage-
//      weighted) is shown as is, one that does not is shown on a white plate in its own colours, and sidebar
//      "white" keeps the white knock-out;
//   3. tile "white" stops putting the colour mark on a white tile;
//   4. the documents' letterhead stops becoming the colour logo (a data URI) when the field is set, or stops
//      being today's generated mark when it is not;
//   5. the colour ledgers mis-handle a colour raster / a generated module holding a base64 image (a false
//      leak, or a hole that lets a real UI colour literal through);
//   6. the login card's logo stops reading on it (CS-564: it showed the sidebar's white knock-out on a white
//      card, so the sign-in page had no logo): the logo for a light ground is the colour lockup, or the lockup
//      in the brand ink, and the login page shows that one;
//   7. the active brand (Clean Space, no colour fields) stops matching its pack.
// Temp packs live in a temp folder — never under brands/ (brandIds lists every folder there, and other suites
// iterate them).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };

// Dynamic imports so a missing new export shows as a clean failed check, not a module link error.
const brand = await import('./brand.mjs');
const gen = await import('./gen-brand-images.mjs');
const { contrast } = await import('./brand-colors.mjs');
const colorLedger = await import('./color-ledger.mjs');
const nameLedger = await import('./name-ledger.mjs');
const sharp = (await import('sharp')).default;

const { validate, validateLogos, loadBrand, BRANDS } = brand;
// the active pack (recorded in identity.generated.js): Clean Space in this repo, the client's after a re-skin
const ACTIVE = loadBrand(brand.activeBrandId()).brand;

// A cleanspace-shaped base brand object (colours + identity) we can spread and mutate for schema fixtures.
const CLEAN = JSON.parse(fs.readFileSync(path.join(BRANDS, 'cleanspace', 'brand.json'), 'utf8'));
const clone = () => JSON.parse(JSON.stringify(CLEAN));

// ── image helpers (temp fixtures only; never written under brands/) ────────────
const solid = (w, h, rgb, alpha = 1) => sharp({ create: { width: w, height: h, channels: 4, background: { r: rgb[0], g: rgb[1], b: rgb[2], alpha } } }).png().toBuffer();
// a colour block centred on a transparent margin, so trim() recovers the flat colour
async function blockOnClear(w, h, rgb) {
  const inner = await solid(Math.round(w * 0.6), Math.round(h * 0.6), rgb, 1);
  return sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: inner, gravity: 'center' }]).png().toBuffer();
}
const parseHex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Write a temp pack folder with valid mark.file + lockup.file (one-colour sources) and any colour files.
async function makePack(root, id, logos, files = {}) {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'brand.json'), JSON.stringify({ ...clone(), id, logos }, null, 2));
  // a light glyph on a dark field for mark.file; a dark lockup on white for lockup.file
  fs.writeFileSync(path.join(dir, logos.mark.file), await sharp({ create: { width: 240, height: 240, channels: 4, background: { r: 10, g: 10, b: 12, alpha: 1 } } })
    .composite([{ input: await solid(120, 120, [255, 255, 255]), gravity: 'center' }]).png().toBuffer());
  fs.writeFileSync(path.join(dir, logos.lockup.file), await sharp({ create: { width: 400, height: 100, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: await solid(300, 40, [15, 15, 18]), gravity: 'center' }]).png().toBuffer());
  fs.writeFileSync(path.join(dir, 'quote.html'), `${brand.readQuote('cleanspace')}\n`); // cleanspace's tokenised pages: loadBrand needs a valid quote
  for (const [name, buf] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), buf);
  return dir;
}

const COLOURS = { primary: '#18181b', primaryDeep: '#09090b', onPrimary: '#ffffff' };
// the ground the sidebar logo (company.logoUrl) is shown on: the dark sidebar (the login card has its own logo)
const GROUNDS = [{ label: 'the sidebar', color: '#09090B' }];
const WHITE = '#FFFFFF';
const TEAL = '#2E6F8E'; // reads on both the deep ink and white
const NAVY = '#16244D'; // reads on white but not on the deep ink

// ── 1. the schema ──────────────────────────────────────────────────────────────
console.log('the schema');
{
  const withLogos = (logos) => validate({ ...clone(), logos });
  const base = { mark: { file: 'm.png', box: { left: 0, top: 0, width: 10, height: 10 } }, lockup: { file: 'l.png' } };
  ok(typeof validateLogos === 'function', 'validateLogos is exported');
  // accepts the new keys
  ok(withLogos({ mark: { file: 'm.png', color: 'm-color.png', tile: 'white' }, lockup: { file: 'l.png', color: 'l-color.png' } }).length === 0,
    'a pack with logos.*.color and mark.tile "white" is accepted');
  ok(withLogos({ mark: { file: 'm.png', color: 'm.svg' }, lockup: { file: 'l.png', color: 'l.webp' } }).length === 0, 'colour files may be svg or webp');
  ok(withLogos({ mark: { file: 'm.png', tile: 'ink' }, lockup: { file: 'l.png' } }).length === 0, 'tile "ink" needs no colour mark (it is today\'s glyph on the ink)');
  ok(withLogos(base).length === 0, 'a pack with neither field is still accepted');
  // refuses the bad ones
  const has = (errs, want) => errs.some((e) => e.startsWith(want));
  ok(has(withLogos({ mark: { file: 'm.png', tile: 'white' }, lockup: { file: 'l.png' } }), 'logos.mark.tile'), 'tile "white" with no mark.color → refused');
  ok(has(withLogos({ mark: { file: 'm.png', tile: 'silver' }, lockup: { file: 'l.png' } }), 'logos.mark.tile'), 'a tile that is not "ink"/"white" → refused');
  ok(has(withLogos({ mark: { file: 'm.png', color: 'm.jpg' }, lockup: { file: 'l.png' } }), 'logos.mark.color'), 'a colour file that is jpg (no transparency) → refused');
  ok(has(withLogos({ mark: { file: 'm.png', color: 'm.gif' }, lockup: { file: 'l.png' } }), 'logos.mark.color'), 'a colour file that is not png/webp/svg → refused');
  ok(has(withLogos({ mark: { file: 'm.png', color: '../x.png' }, lockup: { file: 'l.png' } }), 'logos.mark.color'), 'a colour file with a path → refused');
  ok(has(withLogos({ mark: { file: 'm.png' }, lockup: { file: 'l.png', tile: 'white' } }), 'logos.lockup.tile'), 'tile on the lockup (mark-only) → refused');
  ok(withLogos({ mark: { file: 'm.png' }, lockup: { file: 'l.png', color: 'l-color.png', sidebar: 'color' } }).length === 0
    && withLogos({ mark: { file: 'm.png' }, lockup: { file: 'l.png', color: 'l-color.png', sidebar: 'white' } }).length === 0
    && withLogos({ mark: { file: 'm.png' }, lockup: { file: 'l.png', sidebar: 'white' } }).length === 0,
    'logos.lockup.sidebar "color" or "white" is accepted ("white" needs no colour lockup: it is the knock-out)');
  ok(has(withLogos({ mark: { file: 'm.png' }, lockup: { file: 'l.png', sidebar: 'color' } }), 'logos.lockup.sidebar'), 'sidebar "color" with no lockup.color → refused');
  ok(has(withLogos({ mark: { file: 'm.png' }, lockup: { file: 'l.png', color: 'l-color.png', sidebar: 'plate' } }), 'logos.lockup.sidebar'), 'a sidebar that is not "color"/"white" → refused');
  ok(has(withLogos({ mark: { file: 'm.png', sidebar: 'white' }, lockup: { file: 'l.png' } }), 'logos.mark.sidebar'), 'sidebar on the mark (lockup-only) → refused');
  ok(has(withLogos({ mark: { file: 'm.png', tint: 'x' }, lockup: { file: 'l.png' } }), 'logos.mark.tint'), 'an unknown logo field is still refused');
  // loadBrand checks the colour files exist on disk
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-color-logos-schema-'));
  try {
    await makePack(tmp, 'present', { mark: { file: 'm.png', color: 'm-color.png', tile: 'white' }, lockup: { file: 'l.png', color: 'l-color.png' } },
      { 'm-color.png': await solid(64, 64, [200, 40, 40]), 'l-color.png': await blockOnClear(200, 60, parseHex(TEAL)) });
    ok(!loadBrand('present', tmp).error, `a pack whose colour files exist loads${loadBrand('present', tmp).error ? `: ${loadBrand('present', tmp).error}` : ''}`);
    await makePack(tmp, 'absent', { mark: { file: 'm.png', color: 'gone.png', tile: 'white' }, lockup: { file: 'l.png' } });
    ok(/logos\.mark\.color: no gone\.png/.test(loadBrand('absent', tmp).error || ''), 'a missing colour file → refused by loadBrand');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ── 2. the sidebar logo ──────────────────────────────────────────────────────────
console.log('the sidebar logo');
const meanRgb = async (buf) => {
  const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let n = 0, r = 0, g = 0, b = 0;
  for (let i = 0; i < info.width * info.height; i++) { const a = data[i * 4 + 3]; if (a > 10) { n++; r += data[i * 4]; g += data[i * 4 + 1]; b += data[i * 4 + 2]; } }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
};
const pixel = async (buf, x, y) => { const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); const i = (y * info.width + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
const imagesOf = async (id, dir) => Object.fromEntries(await gen.renderBrandImages(loadBrand(id, dir).brand, COLOURS, { grounds: GROUNDS, dir }));
{
  ok(typeof gen.sidebarLogoDecision === 'function', 'sidebarLogoDecision is exported');
  ok(gen.LOGO_GROUND_CONTRAST === 3, 'the graphics contrast floor is 3:1');
  ok(gen.LOGO_GROUND_TOKENS.length === 1 && gen.LOGO_GROUND_TOKENS[0][1] === 'color-brand-primary-700', 'the sidebar logo is measured on the sidebar alone (the login card has its own logo)');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-color-logos-sidebar-'));
  try {
    // A: a colour that reads on the deep ink → shown as is
    await makePack(tmp, 'reads', { mark: { file: 'm.png' }, lockup: { file: 'l.png', color: 'l-color.png' } },
      { 'l-color.png': await blockOnClear(300, 80, parseHex(TEAL)) });
    const dA = await gen.sidebarLogoDecision(loadBrand('reads', tmp).brand, GROUNDS, { dir: tmp });
    ok(dA && dA.mode === 'color' && dA.color === true && dA.reads === true, `a colour logo that reads on the sidebar → shown as is (${dA?.min}:1)`);
    ok(dA && dA.grounds.every((g) => Math.abs(g.ratio - contrast(TEAL, g.color)) < 0.06), 'the measured ratio is the coverage-weighted WCAG contrast of the logo against the ground');

    // B: a navy that doesn't read on the deep ink → its own colours on a white plate
    await makePack(tmp, 'navy', { mark: { file: 'm.png' }, lockup: { file: 'l.png', color: 'l-color.png' } },
      { 'l-color.png': await blockOnClear(300, 80, parseHex(NAVY)) });
    const dB = await gen.sidebarLogoDecision(loadBrand('navy', tmp).brand, GROUNDS, { dir: tmp });
    ok(dB && dB.mode === 'plate' && dB.color === true && dB.reads === false, `a navy logo on the deep ink (${dB?.min}:1 < ${gen.LOGO_GROUND_CONTRAST}) → on a white plate, still in its colours`);
    ok(contrast(NAVY, '#09090B') < gen.LOGO_GROUND_CONTRAST && contrast(NAVY, WHITE) >= gen.LOGO_GROUND_CONTRAST, `the sample navy ${NAVY} fails on the deep ink (${contrast(NAVY, '#09090B').toFixed(2)}:1) and reads on white (${contrast(NAVY, WHITE).toFixed(2)}:1)`);

    // D: mostly navy with a white box beside it (Clean Corner's lockup: its endorsement sits on white). Its mean
    // contrast on the deep ink clears 3:1, but most of it doesn't read there → the plate, not as is
    // (a see-through margin, as a real logo has: the trim takes its ground from the corner pixel)
    const mixed = await sharp({ create: { width: 340, height: 140, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: await solid(180, 100, parseHex(NAVY)), left: 20, top: 20 }, { input: await solid(120, 100, [255, 255, 255]), left: 200, top: 20 }]).png().toBuffer();
    await makePack(tmp, 'mixed', { mark: { file: 'm.png' }, lockup: { file: 'l.png', color: 'l-color.png' } }, { 'l-color.png': mixed });
    const dD = await gen.sidebarLogoDecision(loadBrand('mixed', tmp).brand, GROUNDS, { dir: tmp });
    ok(dD && dD.min >= gen.LOGO_GROUND_CONTRAST && dD.share < gen.LOGO_READS_SHARE && dD.mode === 'plate',
      `a logo whose mean reads on the sidebar (${dD?.min}:1) but only ${Math.round((dD?.share || 0) * 100)}% of it does → on the plate (a mean hides the part that vanishes)`);
    ok(dA && dA.share === 1 && dB && dB.share === 0, `the share that reads is measured per pixel (all of the teal, none of the navy: ${dA?.share}, ${dB?.share})`);

    // C: the same navy with sidebar "white" → the knock-out, as the pack asks
    await makePack(tmp, 'navywhite', { mark: { file: 'm.png' }, lockup: { file: 'l.png', color: 'l-color.png', sidebar: 'white' } },
      { 'l-color.png': await blockOnClear(300, 80, parseHex(NAVY)) });
    const dC = await gen.sidebarLogoDecision(loadBrand('navywhite', tmp).brand, GROUNDS, { dir: tmp });
    ok(dC && dC.mode === 'white' && dC.color === false, 'sidebar "white" → the white knock-out, whatever the colours');

    // the images follow the decision
    const reads = (await imagesOf('reads', tmp))['cleanspace-logo.png'];
    const [ar, ag, ab] = await meanRgb(reads);
    ok(Math.round(ar) < 250 || Math.round(ag) < 250 || Math.round(ab) < 250, `A: the sidebar logo is the colour logo (mean rgb ${Math.round(ar)},${Math.round(ag)},${Math.round(ab)})`);
    const plate = (await imagesOf('navy', tmp))['cleanspace-logo.png'];
    const pm = await sharp(plate).metadata();
    const corner = await pixel(plate, Math.round(pm.width / 2), 2);
    const middle = await pixel(plate, Math.round(pm.width / 2), Math.round(pm.height / 2));
    const [nr, ng, nb] = parseHex(NAVY);
    ok(corner[0] === 255 && corner[1] === 255 && corner[2] === 255 && corner[3] === 255, `B: the sidebar logo sits on an opaque white plate (edge pixel ${corner.join(',')})`);
    ok(Math.abs(middle[0] - nr) < 20 && Math.abs(middle[1] - ng) < 20 && Math.abs(middle[2] - nb) < 20, `B: the logo keeps its own colour on the plate (middle ${middle.slice(0, 3).join(',')}, expected ~${NAVY})`);
    const [wr, wg, wb] = await meanRgb((await imagesOf('navywhite', tmp))['cleanspace-logo.png']);
    ok(Math.round(wr) === 255 && Math.round(wg) === 255 && Math.round(wb) === 255, `C: the sidebar logo is the white knock-out (mean rgb ${Math.round(wr)},${Math.round(wg)},${Math.round(wb)})`);
    const imgsA = await gen.renderBrandImages(loadBrand('reads', tmp).brand, COLOURS, { grounds: GROUNDS, dir: tmp });
    ok(imgsA.logoDecision && imgsA.logoDecision.mode === 'color', 'renderBrandImages exposes the logo decision (for the review page)');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ── 2b. the nav bar shows the mark alone (logos.sidebar "mark") ────────────────────────────────────
// A brand whose nav bar wants just its icon: the sidebar logo is drawn from the MARK, while the login card and
// the documents' letterhead keep the lockup, which carries the name (Daniel, 2026-09-30: "just their icon for the
// top of the Nav Bar though, not all the text and everything else").
console.log('the nav bar shows the mark');
{
  ok(brand.PACK_FEATURES.includes('sidebar-mark'), "brand.mjs tells a pack-making tool (Forge) the pack may set logos.sidebar");
  const bad = (v) => validateLogos({ mark: { file: 'm.png' }, lockup: { file: 'l.png' }, sidebar: v });
  ok(validateLogos({ mark: { file: 'm.png' }, lockup: { file: 'l.png' }, sidebar: 'mark' }).length === 0
    && validateLogos({ mark: { file: 'm.png' }, lockup: { file: 'l.png' }, sidebar: 'lockup' }).length === 0
    && validateLogos({ mark: { file: 'm.png' }, lockup: { file: 'l.png' } }).length === 0,
    'logos.sidebar may be "mark", "lockup", or left out (the lockup, as before)');
  ok(bad('icon').some((e) => /logos\.sidebar/.test(e)) && bad(true).some((e) => /logos\.sidebar/.test(e)),
    'anything else is refused with the field named');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-color-logos-navmark-'));
  try {
    // the aspect tells the two apart: the fixture mark is square (240×240), the lockup is 4:1 (400×100)
    const aspect = async (buf) => { const m = await sharp(buf).metadata(); return m.width / m.height; };

    // A: a colour mark that doesn't read on the ink → the mark, in its colours, on a white plate
    await makePack(tmp, 'navmark', { mark: { file: 'm.png', color: 'm-color.png' }, lockup: { file: 'l.png', color: 'l-color.png' }, sidebar: 'mark' },
      { 'm-color.png': await blockOnClear(240, 240, parseHex(NAVY)), 'l-color.png': await blockOnClear(400, 100, parseHex(NAVY)) });
    const dM = await gen.sidebarLogoDecision(loadBrand('navmark', tmp).brand, GROUNDS, { dir: tmp });
    ok(dM && dM.which === 'mark' && dM.mode === 'plate', `with logos.sidebar "mark" the decision measures the mark (${dM?.which}, ${dM?.mode})`);
    const imgs = await imagesOf('navmark', tmp);
    const navA = await aspect(imgs['cleanspace-logo.png']);
    ok(Math.abs(navA - 1) < 0.35, `the nav bar's logo is the square mark, not the wide lockup (aspect ${navA.toFixed(2)})`);
    ok((await meanRgb(imgs['cleanspace-logo.png']))[2] > 60, 'it keeps the mark\'s own colours (on its white plate), not a flat knock-out');
    // the separation that matters: the login card and the letterhead still carry the lockup
    const lightA = await aspect(imgs[gen.LIGHT_LOGO]);
    ok(lightA > 2.5, `the login card still shows the lockup, which carries the name (aspect ${lightA.toFixed(2)})`);
    const doc = await gen.renderDocLogo(loadBrand('navmark', tmp).brand, { dir: tmp });
    const docA = await aspect(Buffer.from(String(doc).split(',')[1], 'base64'));
    ok(docA > 2.5, `the documents' letterhead still shows the lockup (aspect ${docA.toFixed(2)})`);

    // B: no colour mark → the mark's own glyph, knocked out in the colour of text on the ink
    await makePack(tmp, 'navplain', { mark: { file: 'm.png' }, lockup: { file: 'l.png' }, sidebar: 'mark' });
    const dP = await gen.sidebarLogoDecision(loadBrand('navplain', tmp).brand, GROUNDS, { dir: tmp });
    const imgsP = await imagesOf('navplain', tmp);
    const navB = await aspect(imgsP['cleanspace-logo.png']);
    const meanB = await meanRgb(imgsP['cleanspace-logo.png']);
    ok(dP === null && Math.abs(navB - 1) < 0.35 && meanB.every((c) => c > 230),
      `a one-colour pack gets the mark knocked out in the text colour (aspect ${navB.toFixed(2)}, mean ${meanB.map((c) => Math.round(c)).join(',')})`);

    // C: the default is unchanged — without the field the nav bar shows the lockup
    await makePack(tmp, 'navdefault', { mark: { file: 'm.png' }, lockup: { file: 'l.png' } });
    const navC = await aspect((await imagesOf('navdefault', tmp))['cleanspace-logo.png']);
    ok(navC > 2.5, `without logos.sidebar the nav bar shows the lockup, as before (aspect ${navC.toFixed(2)})`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ── 3. tile "white": the colour mark on a white tile ─────────────────────────────
console.log('tile "white"');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-color-logos-tile-'));
  try {
    const MARK = [200, 40, 40];
    await makePack(tmp, 'wtile', { mark: { file: 'm.png', color: 'm-color.png', tile: 'white' }, lockup: { file: 'l.png' } }, { 'm-color.png': await solid(240, 240, MARK) });
    await makePack(tmp, 'itile', { mark: { file: 'm.png' }, lockup: { file: 'l.png' } });
    const iconsOf = async (id) => Object.fromEntries(await gen.renderBrandImages(loadBrand(id, tmp).brand, COLOURS, { grounds: GROUNDS, dir: tmp }));
    const white = await iconsOf('wtile');
    const ink = await iconsOf('itile');
    const px = async (buf, x, y) => { const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); const i = (y * info.width + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };
    // the maskable icon is a full-bleed square, so its corner is the tile
    const [cr, cg, cb] = await px(white['icon-maskable-512.png'], 6, 6);
    ok(cr === 255 && cg === 255 && cb === 255, `tile "white": the icon corner is white (got ${cr},${cg},${cb})`);
    const [ir] = await px(ink['icon-maskable-512.png'], 6, 6);
    ok(ir < 60, `tile "ink" (today): the same corner is the brand ink (got ${ir} in R)`);
    // the mark's own colour is present at the centre
    const [mr, mg, mb] = await px(white['icon-512.png'], 256, 256);
    ok(Math.abs(mr - MARK[0]) < 40 && Math.abs(mg - MARK[1]) < 40 && Math.abs(mb - MARK[2]) < 40, `tile "white": the mark's colour is at the centre (got ${mr},${mg},${mb}, expected ~${MARK.join(',')})`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ── 4. the documents' letterhead ─────────────────────────────────────────────────
console.log('the documents\' letterhead');
{
  ok(typeof gen.renderDocLogo === 'function', 'renderDocLogo is exported');
  ok(typeof gen.docLogoModule === 'function', 'docLogoModule is exported');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-color-logos-doc-'));
  try {
    await makePack(tmp, 'wcolor', { mark: { file: 'm.png' }, lockup: { file: 'l.png', color: 'l-color.png' } }, { 'l-color.png': await blockOnClear(1600, 400, parseHex(TEAL)) });
    await makePack(tmp, 'nocolor', { mark: { file: 'm.png' }, lockup: { file: 'l.png' } });
    const withColor = await gen.renderDocLogo(loadBrand('wcolor', tmp).brand, { dir: tmp });
    ok(typeof withColor === 'string' && withColor.startsWith('data:image/png;base64,'), 'with logos.lockup.color the letterhead is an inline PNG data URI');
    const meta = await sharp(Buffer.from(withColor.split(',')[1], 'base64')).metadata();
    ok(meta.width <= 600, `the embedded letterhead PNG is kept modest (${meta.width}px wide ≤ 600)`);
    const noColor = await gen.renderDocLogo(loadBrand('nocolor', tmp).brand, { dir: tmp });
    ok(noColor === null, 'without the field renderDocLogo returns null (so DOC_LOGO stays today\'s generated mark)');
    // the generated module: a data URI, or null
    ok(/DOC_LOGO_IMAGE\s*=\s*null/.test(gen.docLogoModule(null)), 'docLogoModule(null) exports DOC_LOGO_IMAGE = null');
    ok(gen.docLogoModule('data:image/png;base64,AAAA').includes('data:image/png;base64,AAAA'), 'docLogoModule(uri) embeds the data URI');
    // logo.js composes DOC_LOGO_IMAGE || the monogram: prove both branches by writing the generated module and
    // reading logo.js's DOC_LOGO in a fresh process (ESM caches logo.generated.js by URL within one process).
    ok(docLogoFromLogoJs('data:image/png;base64,ZZZ=') === 'data:image/png;base64,ZZZ=', 'logo.js: DOC_LOGO is the colour image when the generated module supplies one');
    ok(docLogoFromLogoJs(null).startsWith('data:image/svg+xml;utf8,'), 'logo.js: DOC_LOGO is the generated SVG monogram when there is none');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// logo.js's DOC_LOGO for a chosen DOC_LOGO_IMAGE: write the generated module, read it in a child process, then
// restore the committed module. A child gives a fresh ESM cache, so both branches load cleanly.
function docLogoFromLogoJs(image) {
  const file = path.join(APP, 'src', 'brand', 'logo.generated.js');
  const orig = fs.readFileSync(file, 'utf8');
  try {
    fs.writeFileSync(file, gen.docLogoModule(image));
    const url = pathToFileURL(path.join(APP, 'src', 'brand', 'logo.js')).href;
    return execFileSync(process.execPath, ['-e', `import(${JSON.stringify(url)}).then((m) => process.stdout.write(m.DOC_LOGO))`], { encoding: 'utf8' });
  } finally { fs.writeFileSync(file, orig); }
}

// ── 5. the colour and name gates handle a colour raster / a base64 module ─────────
console.log('the colour and name gates');
{
  // color-ledger: a generated module holding a base64 image is not a leak…
  const mod = "export const DOC_LOGO_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';\n";
  const modLeaks = colorLedger.scanText('src/brand/logo.generated.js', mod).rows.filter((r) => r.status === 'leak');
  ok(modLeaks.length === 0, `a generated module holding a base64 image → no colour leak${modLeaks.length ? ` (got ${modLeaks.map((r) => r.lit).join(', ')})` : ''}`);
  // …but a real colour literal beside the image is still caught (no hole)
  const holed = colorLedger.scanText('src/brand/logo.generated.js', `${mod}const c = '#c0392b';\n`).rows.filter((r) => r.status === 'leak');
  ok(holed.some((r) => r.lit.startsWith('#c0392b')), 'a real hex beside the base64 is still a leak (the base64 opens no hole)');
  // colorsIn (the rendered-document check) does not read colours out of a base64 letterhead
  ok(colorLedger.colorsIn('<img src="data:image/png;base64,iVBORw0KGgo/9j+" alt="x">').length === 0, 'colorsIn reads no colour out of a base64 image data URI');
  // name-ledger: the same module names nothing
  const nameLeaks = nameLedger.scanText('src/brand/logo.generated.js', mod, loadBrand('cleanspace').brand).rows.filter((r) => r.cls === 'leak');
  ok(nameLeaks.length === 0, 'the base64 module leaks no brand identity');
}

// ── 6. the login card's logo (CS-564) ────────────────────────────────────────────
console.log('the login card\'s logo');
{
  const { readCascade } = await import('./design-system-lib.mjs');
  const byName = new Map(readCascade().map((r) => [r.name, r.resolved]));
  const card = byName.get(gen.LIGHT_GROUND_TOKEN[1]);
  ok(/^#[0-9a-f]{6}$/i.test(card || ''), `the login card's ground resolves from the theme (${gen.LIGHT_GROUND_TOKEN[1]} = ${card})`);
  const readsOn = async (buf, ground) => { const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); return gen.coverageWeightedContrast(data, info, ground); };
  const near = (rgb, hex, tol = 24) => parseHex(hex).every((v, i) => Math.abs(rgb[i] - v) < tol);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-color-logos-light-'));
  try {
    // a colour pack: the logo for a light ground is the colour lockup as is (no plate: the card is white already)
    await makePack(tmp, 'navy', { mark: { file: 'm.png' }, lockup: { file: 'l.png', color: 'l-color.png' } }, { 'l-color.png': await blockOnClear(300, 80, parseHex(NAVY)) });
    const light = (await imagesOf('navy', tmp))[gen.LIGHT_LOGO];
    const lightRgb = await meanRgb(light);
    const lightRatio = await readsOn(light, WHITE);
    ok(near(lightRgb, NAVY) && lightRatio >= gen.LOGO_GROUND_CONTRAST, `a colour pack: the login's logo is the colour lockup, reading on white (${lightRatio.toFixed(2)}:1)`);
    // a one-colour pack: the lockup's strokes in the brand ink, which reads on white
    await makePack(tmp, 'mono', { mark: { file: 'm.png' }, lockup: { file: 'l.png' } });
    const mono = (await imagesOf('mono', tmp))[gen.LIGHT_LOGO];
    const monoRatio = await readsOn(mono, WHITE);
    ok(near(await meanRgb(mono), COLOURS.primary) && monoRatio >= gen.LOGO_GROUND_CONTRAST, `a one-colour pack: the login's logo is the lockup in the brand ink, reading on white (${monoRatio.toFixed(2)}:1)`);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // the page: the image the sign-in card shows reads on it. CS-564: it showed the org's logoUrl, the sidebar's
  // white knock-out, on the white card, so the sign-in page had no visible logo.
  const login = fs.readFileSync(path.join(APP, 'src', 'pages', 'Login.jsx'), 'utf8');
  const src = /className="login-logo"\s+src=\{([^}]+)\}/.exec(login)?.[1]?.trim();
  const { LIGHT_LOGO_URL } = await import('../src/brand/logo.js');
  // the login reads the seed's company (pre-auth there is no store); its logoUrl, from the seed's source (the seed
  // module's own imports need Vite's resolution)
  const seedLogo = /\blogoUrl:\s*'([^']+)'/.exec(fs.readFileSync(path.join(APP, 'src', 'data', 'seed.js'), 'utf8'))?.[1];
  ok(seedLogo === '/cleanspace-logo.png', `the seed's company.logoUrl is the sidebar logo (${seedLogo})`);
  const shown = src === 'LIGHT_LOGO_URL' ? LIGHT_LOGO_URL : src === 'company.logoUrl' ? seedLogo : null;
  ok(!!shown, `the login page's logo is one this test can resolve (src={${src}})`);
  const shownFile = shown ? path.join(APP, 'public', shown.replace(/^\//, '')) : null;
  const shownRatio = shownFile && fs.existsSync(shownFile) ? await readsOn(fs.readFileSync(shownFile), card) : 0;
  ok(shownRatio >= gen.LOGO_GROUND_CONTRAST, `the logo the login page shows (${shown}) reads on the login card (${shownRatio.toFixed(2)}:1, needs ${gen.LOGO_GROUND_CONTRAST})`);
  ok(LIGHT_LOGO_URL === `/${gen.LIGHT_LOGO}`, 'logo.js LIGHT_LOGO_URL is the file the brand step writes');
  // why the login has its own: a one-colour pack's sidebar logo (the org's logoUrl) is knocked out for the dark rail
  if (!ACTIVE.logos.lockup.color) {
    const sidebar = await readsOn(fs.readFileSync(path.join(APP, 'public', seedLogo.replace(/^\//, ''))), card);
    ok(sidebar < gen.LOGO_GROUND_CONTRAST, `${ACTIVE.name}'s sidebar logo (the white knock-out) doesn't read on the white card (${sidebar.toFixed(2)}:1), which is why the login has its own`);
  }
}

// ── 7. the active brand matches its pack ─────────────────────────────────────────
console.log(`the active brand (${ACTIVE.id}) matches its pack`);
{
  // the letterhead the brand step draws follows the active pack, whose logos an in-place re-skin changes: the
  // generated monogram (null) without a colour lockup, that lockup as an inline PNG with one
  const drawn = gen.renderDocLogo ? await gen.renderDocLogo(ACTIVE) : undefined;
  ok(ACTIVE.logos.lockup.color ? /^data:image\/png;base64,/.test(drawn || '') : drawn === null,
    `${ACTIVE.name}'s pack ${ACTIVE.logos.lockup.color ? 'has a colour lockup, so its letterhead is that logo (an inline PNG)' : 'has no colour lockup, so its letterhead stays the generated monogram'}`);
  // the committed letterhead follows whichever pack is active (a re-skin commits the client's): null, the
  // generated monogram, for a pack with no colour lockup; that pack's colour lockup as an inline PNG otherwise
  const logoGen = path.join(APP, 'src', 'brand', 'logo.generated.js');
  const committed = fs.existsSync(logoGen) ? fs.readFileSync(logoGen, 'utf8') : '';
  const colourPack = !!ACTIVE.logos.lockup.color;
  ok(colourPack ? /DOC_LOGO_IMAGE\s*=\s*"data:image\/png;base64,[A-Za-z0-9+/]+=*"/.test(committed) : /DOC_LOGO_IMAGE\s*=\s*null/.test(committed),
    `the committed logo.generated.js holds ${colourPack ? `${ACTIVE.name}'s colour lockup (an inline PNG)` : 'null (the generated monogram)'}, as the active pack (${ACTIVE.id}) says`);
  const run = (args) => { try { return execFileSync(process.execPath, [path.join(APP, 'scripts', args[0]), ...args.slice(1)], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return `exit ${e.status}: ${e.stdout || ''}${e.stderr || ''}`; } };
  ok(/match brands\//.test(run(['brand.mjs', '--check'])), '`brand.mjs --check` reports every output current (logo.generated.js included)');
  ok(/match brands\//.test(run(['gen-brand-images.mjs', '--check'])), '`gen-brand-images.mjs --check` reports every image current');
}

// pack feature marker (for tools like Forge)
ok(Array.isArray(brand.PACK_FEATURES) && brand.PACK_FEATURES.includes('color-logos'), "brand.mjs exports PACK_FEATURES including 'color-logos'");

if (failed) { console.error(`\n✗ test-color-logos: ${failed} check(s) failed`); process.exit(1); }
console.log('\n✓ test-color-logos: the optional colour-logo fields work and Clean Space is unchanged');
