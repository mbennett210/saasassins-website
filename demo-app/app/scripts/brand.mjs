#!/usr/bin/env node
// brand — apply a brand pack: brands/<id>/ → every brand output the app ships (UI_RULES §121, §129).
//
// A new client is a new brand pack; nothing else in the app changes. The pack is brands/<id>/brand.json
// (the identity, the four base colours, the logo sources) and the logo images beside it. This script
// writes it everywhere the app reads it:
//   src/brand/identity.generated.js   IDENTITY: the name, contact details, signatory, senders (for code)
//   src/brand/quote.generated.js      QUOTE_BODY: the quote's pages in the brand's words (brands/<id>/quote.html)
//   index.html                        <title>, application-name, apple-mobile-web-app-title
//   public/manifest.json              name, short_name, description
//   public/sw.js                      the push notifications' default title (APP_NAME)
//   src/theme-cleanspace.css          the BRAND PALETTE block: every ramp and surface, derived from the four
//                                     base colours or pinned (scripts/brand-colors.mjs), and refused when a
//                                     contrast check fails
//   then, from the new theme, what brand:js writes (BRAND, the manifest and theme-color, the GENERATED
//   block), the design system's token snapshot (design-system/tokens.json), and the images
//   (scripts/gen-brand-images.mjs: the app icons, favicon, the sidebar logo and the phone nav's mark).
// The name ledger (name-ledger.mjs, CI through test-name-ledger.mjs) proves no other file writes the brand's
// identity; the colour ledger (color-ledger.mjs, test-color-ledger.mjs) proves the same of its colours.
//
//   npm --prefix app run brand -- <id>        apply brands/<id>
//   node scripts/brand.mjs --check [<id>]     exit 1 when an output is stale or a contrast check fails
//                                             (default: the active brand, recorded in identity.generated.js)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEX, PIN_KEYS, PALETTE_BLOCK, paletteBlock } from './brand-colors.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));
export const BRANDS = path.join(APP, '..', 'brands');
export const IDENTITY_OUT = path.join(APP, 'src', 'brand', 'identity.generated.js');
export const QUOTE_OUT = path.join(APP, 'src', 'brand', 'quote.generated.js');
export const CLIENT_THEME = path.join(APP, 'src', 'theme-cleanspace.css'); // a kept identifier: index.css imports it
const INDEX = path.join(APP, 'index.html');
const MANIFEST = path.join(APP, 'public', 'manifest.json');
const SW = path.join(APP, 'public', 'sw.js');

// The brand file's shape: every field is required and a non-empty string unless marked optional.
const SCHEMA = {
  version: 'number', id: 'string', name: 'string', wordmark: 'string', shortName: 'string', appTitle: 'string',
  description: 'string', monogram: 'string', slug: 'string', appUrl: 'string',
  company: {
    domain: 'string', website: 'string', email: 'string', phone: 'string', street: 'string', city: 'string',
    tagline: 'string', services: 'string', signatory: { name: 'string', role: 'string', title: 'string', email: 'string' },
  },
  email: { quotesFrom: 'string', authFrom: 'string' },
};
// the colour and logo sections, validated on their own (validateColors, validateLogos)
const SECTIONS = new Set(['colors', 'logos']);
const BASE_COLOURS = ['primary', 'secondary', 'link', 'neutral'];

// The optional brand-pack fields this shell understands, for a pack-making tool (Forge) to read from a shell
// commit before it writes them: 'color-logos' = logos.*.color and logos.mark.tile (REBRAND.md §1, UI_RULES §121).
export const PACK_FEATURES = Object.freeze(['color-logos']);

// A logo's fields, per key: the mark may carry a colour mark and a tile choice, the lockup a colour lockup.
const LOGO_FIELDS = { mark: ['file', 'box', 'color', 'tile'], lockup: ['file', 'box', 'color'] };
// A colour file (the client's logo in its own colours, for a light ground) is png, svg or webp — never jpg,
// which cannot be transparent.
const COLOUR_FILE = /^[\w.-]+\.(png|svg|webp)$/i;

export function validateColors(colors) {
  if (!colors || typeof colors !== 'object' || Array.isArray(colors)) return ['colors: missing (an object with primary, secondary, link and neutral)'];
  const errors = [];
  for (const k of BASE_COLOURS) if (typeof colors[k] !== 'string' || !HEX.test(colors[k])) errors.push(`colors.${k}: a colour as #rrggbb`);
  for (const k of Object.keys(colors)) if (!BASE_COLOURS.includes(k) && k !== 'pins') errors.push(`colors.${k}: not a brand field`);
  if (colors.pins !== undefined) {
    if (!colors.pins || typeof colors.pins !== 'object' || Array.isArray(colors.pins)) errors.push('colors.pins: an object of palette keys to #rrggbb');
    else for (const [k, v] of Object.entries(colors.pins)) {
      if (!PIN_KEYS.has(k)) errors.push(`colors.pins.${k}: not a palette key (one of ${[...PIN_KEYS].join(', ')})`);
      else if (typeof v !== 'string' || !HEX.test(v)) errors.push(`colors.pins.${k}: a colour as #rrggbb`);
    }
  }
  return errors;
}

export function validateLogos(logos) {
  if (!logos || typeof logos !== 'object' || Array.isArray(logos)) return ['logos: missing (an object with mark and lockup)'];
  const errors = [];
  for (const k of Object.keys(logos)) if (!['mark', 'lockup'].includes(k)) errors.push(`logos.${k}: not a brand field`);
  for (const k of ['mark', 'lockup']) {
    const l = logos[k];
    if (!l || typeof l !== 'object') { errors.push(`logos.${k}: missing (an object with a file)`); continue; }
    for (const f of Object.keys(l)) if (!LOGO_FIELDS[k].includes(f)) errors.push(`logos.${k}.${f}: not a brand field`);
    if (typeof l.file !== 'string' || !/^[\w.-]+\.(png|jpe?g|svg|webp)$/i.test(l.file)) errors.push(`logos.${k}.file: an image file name in the brand's folder (png, jpg, svg or webp)`);
    if (l.color !== undefined && (typeof l.color !== 'string' || !COLOUR_FILE.test(l.color))) errors.push(`logos.${k}.color: the client's logo in its own colours on a transparent ground, a file in the brand's folder (png, svg or webp; not jpg)`);
    if (l.box !== undefined) {
      const b = l.box;
      const ok = b && typeof b === 'object' && ['left', 'top', 'width', 'height'].every((n) => Number.isInteger(b[n]) && b[n] >= 0) && b.width > 0 && b.height > 0 && Object.keys(b).length === 4;
      if (!ok) errors.push(`logos.${k}.box: { left, top, width, height } in whole pixels`);
    }
  }
  // tile is mark-only (LOGO_FIELDS.lockup has no 'tile'): "ink" is today's glyph on the brand ink, "white" the
  // colour mark on a white tile, which needs logos.mark.color to place there.
  const tile = logos.mark?.tile;
  if (tile !== undefined) {
    if (tile !== 'ink' && tile !== 'white') errors.push('logos.mark.tile: "ink" (the brand ink, the default) or "white" (the colour mark on a white tile)');
    else if (tile === 'white' && typeof logos.mark?.color !== 'string') errors.push('logos.mark.tile: "white" needs logos.mark.color (the colour mark to place on the white tile)');
  }
  return errors;
}

const EMAIL = /^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const SENDER = /^[^<>\r\n]+ <[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}>$/i;
const SENDERS = new Set(['email.quotesFrom', 'email.authFrom']); // "Name <address>": the brackets belong
const CITY_LINE = /^(.+?), ([A-Z]{2}) (\d{5}(?:-\d{4})?)$/;

export function validate(brand, schema = SCHEMA, at = '') {
  const errors = [];
  for (const [key, type] of Object.entries(schema)) {
    const v = brand?.[key];
    const where = at ? `${at}.${key}` : key;
    if (typeof type === 'object') {
      if (!v || typeof v !== 'object' || Array.isArray(v)) errors.push(`${where}: missing (an object)`);
      else errors.push(...validate(v, type, where));
    } else if (typeof v !== type || (type === 'string' && !v.trim())) errors.push(`${where}: missing or not a ${type}`);
    // one line, no stray spaces: every value lands in a title, a header line or a sentence. The Unicode line
    // breaks count too: a pattern's `.` and `$` stop at them, so the next run would split sw.js's APP_NAME line
    else if (type === 'string' && (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(v) || v !== v.trim())) errors.push(`${where}: one line, without leading or trailing spaces`);
    // values land in HTML attributes and in the letterhead's SVG data URI, which these would break
    else if (type === 'string' && !SENDERS.has(where) && /[<>"%\\]/.test(v)) errors.push(`${where}: no < > " % or \\ characters`);
  }
  if (!at) {
    for (const key of Object.keys(brand || {})) if (!(key in SCHEMA) && !SECTIONS.has(key)) errors.push(`${key}: not a brand field`);
    errors.push(...validateColors(brand?.colors), ...validateLogos(brand?.logos));
    for (const [key, sub] of [['company', SCHEMA.company], ['email', SCHEMA.email], ['company.signatory', SCHEMA.company.signatory]]) {
      const obj = key.split('.').reduce((o, k) => o?.[k], brand);
      if (obj && typeof obj === 'object') for (const k of Object.keys(obj)) if (!(k in sub)) errors.push(`${key}.${k}: not a brand field`);
    }
    if (brand?.version !== 1) errors.push('version: this generator reads version 1');
    if (typeof brand?.id === 'string' && !/^[a-z0-9-]+$/.test(brand.id)) errors.push('id: lowercase letters, digits and hyphens only (it names the brand\'s folder)');
    if (typeof brand?.slug === 'string' && !/^[a-z0-9-]+$/.test(brand.slug)) errors.push('slug: lowercase letters, digits and hyphens only (it starts download file names)');
    if (typeof brand?.monogram === 'string' && brand.monogram.length > 3) errors.push('monogram: at most 3 characters');
    const c = brand?.company || {};
    if (typeof c.domain === 'string' && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(c.domain)) errors.push('company.domain: a bare domain such as example.com');
    if (typeof c.email === 'string' && !EMAIL.test(c.email)) errors.push('company.email: an email address');
    // the app's addresses are US (its state list, ZIPs): the form hints take the city, state and ZIP from here
    if (typeof c.city === 'string' && !CITY_LINE.test(c.city)) errors.push('company.city: "City, ST 12345" (the city, the state\'s two letters, the ZIP)');
    if (typeof c.signatory?.email === 'string' && !EMAIL.test(c.signatory.email)) errors.push('company.signatory.email: an email address');
    if (typeof brand?.appUrl === 'string' && !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(brand.appUrl)) errors.push('appUrl: https://host, no path');
    for (const k of ['quotesFrom', 'authFrom']) if (typeof brand?.email?.[k] === 'string' && !SENDER.test(brand.email[k])) errors.push(`email.${k}: a sender such as "Name <quotes@example.com>"`);
  }
  return errors;
}

// ── the quote: brands/<id>/quote.html ────────────────────────────────────────────
// The quote document's pages in the brand's own words: its claims, scope, guarantees and terms (CS-388). Tokens
// mark where the brand's identity, the quote's fields, the signatures and the letterhead go; quoteTemplate.js
// keeps the layout (the stylesheet, the running bars, the signing) and fills them:
//   {{name}}, {{company.<field>}}, {{signatory.<field>}}, {{wordmark.1}}, {{wordmark.2}}, {{logo}}, {{doc.ink}}
//   {{field.<key>|<hint>}}      an editable field of the quote; the hint shows while it is empty
//   {{date}}, {{client.company}}, {{agreement.name}}, {{agreement.company}}, {{signature.client}}, {{signature.admin}}
//   {{#<token>}}…{{/<token>}}   its inside only when the token has a value
export const QUOTE_FIELDS = ['clientName', 'companyName', 'amount', 'frequency', 'dayOfWeek', 'restrooms'];
export const QUOTE_TOKENS = new Set([
  'name', 'wordmark.1', 'wordmark.2', 'logo', 'doc.ink',
  ...['street', 'city', 'phone', 'website', 'domain', 'email', 'tagline', 'services'].map((k) => `company.${k}`),
  ...['name', 'title', 'role', 'email'].map((k) => `signatory.${k}`),
  'date', 'client.company', 'agreement.name', 'agreement.company', 'signature.client', 'signature.admin',
]);
// what the editor and the signing read: a quote without one cannot be filled in or signed
export const QUOTE_REQUIRED = ['date', 'signature.client', 'signature.admin', ...QUOTE_FIELDS.map((k) => `field.${k}`)];

/** A brand's quote pages (LF line ends, without the file's final line end), or null when it has none. */
export function readQuote(id, dir = BRANDS) {
  const file = path.join(dir, id, 'quote.html');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '') : null;
}

/** The quote's errors: an unknown or unclosed token, a missing field or signature, markup that runs, a colour literal. */
export function validateQuote(text, brand) {
  const errors = [];
  const seen = new Set();
  const open = [];
  for (const [whole, mark, body] of text.matchAll(/\{\{([#/]?)([^{}]*)\}\}/g)) {
    const field = /^field\.(\w+)\|([^|<>"]+)$/.exec(body);
    if (field ? mark || !QUOTE_FIELDS.includes(field[1]) : !QUOTE_TOKENS.has(body)) { errors.push(`quote.html: unknown token ${whole}`); continue; }
    if (mark === '#') open.push(body);
    else if (mark === '/') { if (open.pop() !== body) errors.push(`quote.html: ${whole} closes no open {{#${body}}}`); }
    else seen.add(field ? `field.${field[1]}` : body);
  }
  if (open.length) errors.push(`quote.html: {{#${open.join('}}, {{#')}}} is never closed`);
  for (const k of QUOTE_REQUIRED) if (!seen.has(k)) errors.push(`quote.html: needs {{${k}${k.startsWith('field.') ? '|<hint>' : ''}}} (the editor and the signing read it)`);
  // an attribute starts after white space, a slash or a quoted value's closing quote (<img/onerror=…>, src="x"onerror=…)
  if (/<script|<iframe|<object|<embed|[\s/"']on[a-z]+\s*=|javascript:/i.test(text)) errors.push('quote.html: no scripts, frames, event handlers or javascript: links');
  if (/(?<!&)#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i.test(text)) errors.push('quote.html: no colour literals: {{doc.ink}}, or a class of the quote\'s stylesheet (UI_RULES §121)');
  if (brand) for (const [label, s] of identityStrings(brand)) if (text.toLowerCase().includes(s.toLowerCase())) errors.push(`quote.html: writes the brand's ${label} ("${s}"): use its token, so the quote follows the brand file`);
  return errors;
}

export function quoteText(brand, body) {
  const literal = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  return `// GENERATED by \`npm --prefix app run brand -- ${brand.id}\` from brands/${brand.id}/quote.html. Do not edit: change the
// brand's quote, then regenerate. test-brand.mjs fails when this file no longer matches it.
// The quote's pages in the brand's own words, with the {{tokens}} quoteTemplate.js fills (UI_RULES §129).
export const QUOTE_BODY = \`${literal}\`;
`;
}

export function loadBrand(id, dir = BRANDS) {
  const file = path.join(dir, id, 'brand.json');
  if (!fs.existsSync(file)) return { error: `no brand file at brands/${id}/brand.json` };
  let brand;
  try { brand = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { error: `brands/${id}/brand.json: ${e.message}` }; }
  const errors = validate(brand);
  if (brand.id !== id) errors.push(`id: "${brand.id}" does not match its folder "${id}"`);
  for (const k of ['mark', 'lockup']) {
    for (const which of ['file', 'color']) {
      const f = brand.logos?.[k]?.[which];
      if (typeof f === 'string' && !fs.existsSync(path.join(dir, id, f))) errors.push(`logos.${k}.${which}: no ${f} in brands/${id}/`);
    }
  }
  const quote = readQuote(id, dir);
  if (quote === null) errors.push(`quote.html: missing (the quote's pages in the brand's words: REBRAND.md §1)`);
  else errors.push(...validateQuote(quote, errors.length ? null : brand));
  return errors.length ? { error: `brands/${id}/brand.json:\n  ${errors.join('\n  ')}` } : { brand };
}

// Every brand under brands/, by folder name
export const brandIds = (dir = BRANDS) => fs.readdirSync(dir).filter((d) => fs.existsSync(path.join(dir, d, 'brand.json'))).sort();

// The strings that identify a brand to a person, as [label, value]: what the name ledger forbids in code and
// the rebrand sweep forbids on screen once another brand is active. Four characters at least, so a short
// value (the monogram, the signatory's role) cannot match ordinary words. A description — the signatory's
// title, the services and the tagline — counts only at three words or more, as needleFor reads words (a hyphen
// or an ampersand splits two words as a space does): a shorter one ("Owner", "Office Manager", "Janitorial",
// "Floor Care") is a role the app's own screens name or the trade's vocabulary, not the brand's identity
// (CS-400, replacing CS-399's white-space test — reading each such word as identity flagged it as a leak).
export function identityStrings(brand) {
  const c = brand.company;
  const addr = (s) => /<([^>]+)>/.exec(s)?.[1];
  const desc = (s) => (typeof s === 'string' && s.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length >= 3 ? s : null);
  return [
    ['name', brand.name], ['wordmark', brand.wordmark], ['short name', brand.shortName], ['app title', brand.appTitle],
    ['slug', brand.slug], ['app host', brand.appUrl.replace(/^https:\/\//, '')],
    ['domain', c.domain], ['website', c.website], ['email', c.email], ['phone', c.phone], ['street', c.street], ['city', c.city],
    ['tagline', desc(c.tagline)], ['services', desc(c.services)],
    ['signatory', c.signatory.name], ['signatory title', desc(c.signatory.title)], ['signatory email', c.signatory.email],
    ['quotes sender', addr(brand.email.quotesFrom)], ['auth sender', addr(brand.email.authFrom)],
  ].filter(([, s]) => typeof s === 'string' && s.length >= 4);
}

/**
 * The brand's locale, from its address and phone: the city, the state and the ZIP of "City, ST 12345", and the
 * phone's area code. The form hints show them (a new location's city, a new contact's phone), so a clone's hints
 * are its own region's (CS-392).
 */
export function localeOf(company) {
  const m = CITY_LINE.exec(company.city || '');
  const d = String(company.phone || '').replace(/\D/g, '');
  const national = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
  return {
    locality: m ? m[1] : String(company.city || '').split(',')[0].trim(), region: m ? m[2] : '', postalCode: m ? m[3] : '',
    areaCode: national.length === 10 ? national.slice(0, 3) : '',
  };
}

// The identity code reads: the brand file minus the colour and asset sections, plus what follows from it: the
// joined address, the locale (localeOf), and the signatory's initials (the seeded owner's avatar and the
// stored-owner correction).
export function identityOf(brand) {
  const rest = { ...brand };
  for (const k of ['colors', 'logos', 'version']) delete rest[k];
  const words = rest.company.signatory.name.split(/\s+/);
  const initials = (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  return { ...rest, company: { ...rest.company, signatory: { ...rest.company.signatory, initials }, address: `${rest.company.street}, ${rest.company.city}`, ...localeOf(rest.company) } };
}

export function identityText(brand) {
  return `// GENERATED by \`npm --prefix app run brand -- ${brand.id}\` from brands/${brand.id}/brand.json. Do not edit: change the
// brand file, then regenerate. test-brand.mjs fails when this file no longer matches it.
// The brand's identity for code that shows it: the name, wordmark, app title, contact details and sender
// addresses (UI_RULES §129). Never write one of these values anywhere else (the name ledger checks).
const deepFreeze = (o) => { for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v); return Object.freeze(o); };
export const IDENTITY = deepFreeze(${JSON.stringify(identityOf(brand), null, 2)});
`;
}

const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const json = JSON.stringify;
// The static outputs, by path under app/: [the line's anchor, what it becomes]. Each rewrites only the lines
// it owns (one value per line, so a rewrite never adds or removes a line), leaving the rest of the file as it
// is. The replacements are functions, so a `$1` or `$&` in a client's name is written literally.
const STATIC = {
  'index.html': [
    [/<title>[^<]*<\/title>/, (b) => `<title>${escHtml(b.appTitle)}</title>`],
    [/(<meta name="application-name" content=")[^"]*(")/, (b, m) => `${m[1]}${escHtml(b.shortName)}${m[2]}`],
    [/(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/, (b, m) => `${m[1]}${escHtml(b.shortName)}${m[2]}`],
  ],
  'public/manifest.json': [
    [/("name"\s*:\s*)"(?:[^"\\]|\\.)*"/, (b, m) => `${m[1]}${json(b.name)}`],
    [/("short_name"\s*:\s*)"(?:[^"\\]|\\.)*"/, (b, m) => `${m[1]}${json(b.shortName)}`],
    [/("description"\s*:\s*)"(?:[^"\\]|\\.)*"/, (b, m) => `${m[1]}${json(b.description)}`],
  ],
  'public/sw.js': [
    [/^const APP_NAME = .*$/m, (b) => `const APP_NAME = ${json(b.name)}; // GENERATED by \`npm --prefix app run brand\` from the brand file`],
  ],
};
const STATIC_FILES = { 'index.html': INDEX, 'public/manifest.json': MANIFEST, 'public/sw.js': SW };

/** A static output's text rewritten for a brand (the file's other lines untouched). */
export const rewriteStatic = (rel, text, brand) => (STATIC[rel] || []).reduce((t, [re, to]) => t.replace(re, (...m) => to(brand, m)), text);

/** The anchors a static output has lost (the generator cannot write those values), as their patterns. */
export const missingAnchors = (rel, text) => (STATIC[rel] || []).filter(([re]) => !re.test(text)).map(([re]) => re.source);

// A brand whose every value differs from any real one: rewriting with it changes exactly the owned lines.
const PROBE = { appTitle: '⁣probe-title', shortName: '⁣probe-short', name: '⁣probe-name', description: '⁣probe-description' };
/** The 1-based line numbers of a static output that the generator writes, or null for any other file. */
export function ownedLines(rel, text) {
  if (!STATIC[rel]) return null;
  const before = text.split(/\r?\n/);
  const after = rewriteStatic(rel, text, PROBE).split(/\r?\n/);
  return new Set(before.flatMap((l, i) => (l !== after[i] ? [i + 1] : [])));
}

// [file, before, after] for each static output
export function staticTargets(brand) {
  return Object.entries(STATIC_FILES).map(([rel, file]) => {
    const text = fs.readFileSync(file, 'utf8');
    return [file, text, rewriteStatic(rel, text, brand)];
  });
}

export function activeBrandId() {
  if (!fs.existsSync(IDENTITY_OUT)) return null;
  const m = /"id": "([a-z0-9-]+)"/.exec(fs.readFileSync(IDENTITY_OUT, 'utf8'));
  return m ? m[1] : null;
}

/**
 * The design system's token snapshot (app/design-system/tokens.json), from the theme cascade on disk: it
 * mirrors the theme (UI_RULES §120), so a brand's palette changes it. { target: [file, before, after] } or { error }.
 */
export async function designTokensTarget() {
  const { DS, readJson, readCascade, parseRules, readAppCss, buildTokens } = await import('./design-system-lib.mjs');
  const file = path.join(DS, 'tokens.json');
  const { tokens, errors } = buildTokens(readJson(path.join(DS, 'tokens.config.json')), { cascade: readCascade(), rules: parseRules(readAppCss()) });
  if (errors.length) return { error: `the design system's token config and the theme disagree: ${errors.join('; ')}` };
  return { target: [file, fs.readFileSync(file, 'utf8'), `${JSON.stringify(tokens, null, 2)}\n`] };
}

/** The client theme with the brand's palette in its BRAND PALETTE block: { target: [file, before, after], checks } or { error }. */
export function paletteTarget(brand, raw = fs.readFileSync(CLIENT_THEME, 'utf8')) {
  const lf = raw.replace(/\r\n/g, '\n');
  const m = PALETTE_BLOCK.exec(lf);
  if (!m) return { error: `${path.basename(CLIENT_THEME)} has no BRAND PALETTE block: add the "── BRAND PALETTE: GENERATED by \`npm --prefix app run brand\` …" and "── end BRAND PALETTE ──" comments inside its :root rule` };
  const { text, checks } = paletteBlock(brand, m[1]);
  const next = lf.replace(PALETTE_BLOCK, () => text);
  return { target: [CLIENT_THEME, raw, raw.includes('\r\n') ? next.replace(/\n/g, '\r\n') : next], checks };
}

// Every text output for a brand, as [file, before, after] (before === after when current), and the palette's
// contrast checks. The brand:js outputs and the images follow from these (see the CLI below).
export function brandTargets(brand) {
  const cur = fs.existsSync(IDENTITY_OUT) ? fs.readFileSync(IDENTITY_OUT, 'utf8') : '';
  const palette = paletteTarget(brand);
  if (palette.error) throw new Error(palette.error);
  const curQuote = fs.existsSync(QUOTE_OUT) ? fs.readFileSync(QUOTE_OUT, 'utf8') : '';
  const targets = [[IDENTITY_OUT, cur, identityText(brand)], [QUOTE_OUT, curQuote, quoteText(brand, readQuote(brand.id))], ...staticTargets(brand), palette.target];
  targets.checks = palette.checks;
  return targets;
}

const invoked = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (invoked) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const check = process.argv.includes('--check');
  const id = args[0] || activeBrandId();
  if (!id) { console.error('brand: name a brand (npm --prefix app run brand -- <id>); brands/ holds ' + fs.readdirSync(BRANDS).join(', ')); process.exit(1); }
  const { brand, error } = loadBrand(id);
  if (error) { console.error(error); process.exit(1); }
  const { brandJsTargets } = await import('./brand-js.mjs');
  const { renderBrandImages, staleImages, writeImages, docLogoTarget, logoGrounds } = await import('./gen-brand-images.mjs');
  const { readCascade } = await import('./design-system-lib.mjs');
  const grounds = () => logoGrounds(new Map(readCascade().map((r) => [r.name, r.resolved])));
  let targets;
  try { targets = brandTargets(brand); } catch (e) { console.error(`brand: ${e.message}`); process.exit(1); }
  const rel = (f) => path.relative(APP, f).split(path.sep).join('/');
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const lost = targets.flatMap(([f, before]) => missingAnchors(rel(f), before).map((a) => `${rel(f)} (${a})`));
  if (lost.length) { console.error(`brand: an output lost a line the generator writes: ${lost.join(', ')}. Restore it, then rerun.`); process.exit(1); }
  const failing = targets.checks.filter((c) => !c.pass);
  if (failing.length) {
    console.error(`brand (${id}): ${failing.length} contrast check(s) fail; change a base colour or pin a step in brands/${id}/brand.json:`);
    for (const c of failing) console.error(`  ${c.name}: ${c.ratio}:1, needs ${c.floor}:1 (${c.fg} on ${c.bg}; ${c.rule})`);
    process.exit(1);
  }
  const images = (colors) => renderBrandImages(brand, { primary: colors.primary, primaryDeep: colors.primaryDeep, onPrimary: colors.onPrimary }, { grounds: grounds() });
  const write = ([file, before, after]) => {
    if (norm(before) === norm(after)) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, before.includes('\r\n') ? after.replace(/\r?\n/g, '\r\n') : after);
    return true;
  };
  if (check) {
    const stale = targets.filter(([, before, after]) => norm(before) !== norm(after)).map(([f]) => rel(f));
    const js = brandJsTargets();
    if (js.errors.length) { console.error(`brand (${id}): ${js.errors.join('; ')}`); process.exit(1); }
    stale.push(...js.targets.filter(([, before, after]) => norm(before) !== norm(after)).map(([f]) => rel(f)));
    const ds = await designTokensTarget();
    if (ds.error) { console.error(`brand (${id}): ${ds.error}`); process.exit(1); }
    if (norm(ds.target[1]) !== norm(ds.target[2])) stale.push(rel(ds.target[0]));
    stale.push(...(await staleImages(await images(js.colors))).map((f) => `public/${f}`));
    const doc = await docLogoTarget(brand);
    if (norm(doc[1]) !== norm(doc[2])) stale.push(rel(doc[0]));
    if (stale.length) { console.error(`brand (${id}): stale outputs: ${[...new Set(stale)].join(', ')}. Run \`npm --prefix app run brand -- ${id}\` and commit them.`); process.exit(1); }
    console.log(`brand (${id}): the identity, the quote's pages, the static shell, the theme's palette (${targets.checks.length} contrast checks pass), BRAND, the design system's tokens, the letterhead and the images match brands/${id}`);
  } else {
    const wrote = targets.filter(write).map(([f]) => rel(f));
    // the theme is written: brand:js's outputs follow from the new cascade, the images from the new BRAND
    const js = brandJsTargets();
    if (js.errors.length) { console.error(`brand (${id}): ${js.errors.join('; ')}`); process.exit(1); }
    wrote.push(...js.targets.filter(write).map(([f]) => rel(f)));
    const ds = await designTokensTarget();
    if (ds.error) { console.error(`brand (${id}): ${ds.error}`); process.exit(1); }
    if (write(ds.target)) wrote.push(rel(ds.target[0]));
    const rendered = await images(js.colors);
    const staleImg = await staleImages(rendered);
    writeImages(rendered);
    wrote.push(...staleImg.map((f) => `public/${f}`));
    if (write(await docLogoTarget(brand))) wrote.push('src/brand/logo.generated.js');
    console.log(`brand (${id}): ${targets.checks.length} contrast checks pass; wrote ${[...new Set(wrote)].join(', ') || 'nothing (already current)'}`);
  }
}
