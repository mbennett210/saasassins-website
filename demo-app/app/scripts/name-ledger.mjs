#!/usr/bin/env node
// name-ledger — every place the app ships the brand's identity, and why it may stay (UI_RULES §129).
//
// THE NAME GUARANTEE. A new brand is a new brands/<id>/brand.json, applied by `npm --prefix app run brand`;
// nothing else in the app changes. Any name, wordmark, domain, phone or street written anywhere else
// survives the swap and shows the old client, in the app, a document, an email or a push. This enumerates
// the shipped surface mechanically (the colour ledger's universe: src, api, index.html, public, the
// brand-asset scripts) and fails on every occurrence that is not the brand's own source or output and not
// kept on purpose with its reason on record.
//
// NEEDLES: the shell's first brand in any spelling (Clean Space, CleanSpace, cleanspace, CLEANSPACE,
// Clean&nbsp;Space, cleanspaceonline.com), and every identity string of the ACTIVE brand
// (brands/<active>/brand.json, brand.mjs identityStrings): its name, wordmark, short name, app title, slug,
// app host, domain, website, email, phone, street, city, tagline, services, signatory (name, title, email)
// and sender addresses. Each matches in any spelling (needleFor): any case, other separators between its
// words (a JSX line break, a hyphen, an escaped space), and a phone in any grouping of its digits, with or
// without the country code.
//
// CLASSES
//   identity    the brand's generated outputs: src/brand/identity.generated.js, src/brand/quote.generated.js
//               (the quote's pages from the pack's quote.html) and the lines brand.mjs writes in index.html,
//               public/manifest.json and public/sw.js
//   identifier  kept on purpose (owner decision 2026-09-25: identifiers stay; a fresh clone renames them once
//               at setup, REBRAND.md): env and constant names, storage and template keys, event and header
//               names, content ids, tags, file names. Each rule below carries its reason.
//   comment     inside a code comment
//   migration   code that rewrites this client's saved records (a historical data fix): it must name them
//   fiction     the brand's city and street in the demo's fictional data, set in its region on purpose (FICTION;
//               the place needles, plus the locale needles the source scan adds: localeNeedles)
//   allowed     `brand:allow — <reason>` on the line or the line above (a reason is required)
//   excluded    standalone mockups the app never loads
//   leak        anything else: the brand written into code. CI fails on any (test-name-ledger.mjs).
//
//   node scripts/name-ledger.mjs            summary + every leak; exit 1 if any
//   node scripts/name-ledger.mjs --json     the full ledger
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { universe } from './color-ledger.mjs';
import { activeBrandId, loadBrand, identityStrings, localeOf, ownedLines } from './brand.mjs';

const APP = fileURLToPath(new URL('..', import.meta.url));

export const EXCLUDE = new Map([
  ['public/icons.svg', 'the Vite starter\'s social-icon sprite: no app code references it'],
]);

// Kept identifiers: [test on the matched text and its surrounding token, reason]. A token is the run of
// characters around the match up to whitespace, a quote, a bracket or a comma.
export const IDENTIFIERS = [
  [(m) => m === 'CLEANSPACE', 'an environment variable, constant or doc name (CLEANSPACE_ORG_ID, CLEANSPACE_SWEPT.md, THEME_CLEANSPACE): renaming it breaks the deployment and every reference'],
  [(m, t) => /\bcleanspace\.auth\b/.test(t), 'the Supabase session storage key: renaming it signs every user out'],
  [(m, t) => /\bcleanspace_[a-z0-9_]+_v\d+\b/.test(t), 'a localStorage key or a quote template_key saved with each quote: renaming it orphans what is stored under it'],
  [(m, t) => /\bcleanspace:[a-z-]+/.test(t), 'a DOM event name the app dispatches and listens for'],
  [(m, t) => /x-cleanspace-/i.test(t), 'an HTTP header name integrations send and verify: renaming it breaks every configured webhook'],
  [(m, t) => /^cid:cleanspace-signature$|^['"`<]?cleanspace-signature['"`>]?[;,)]*$/.test(t) || /cid:cleanspace-signature/.test(t), 'the content-id that ties the email signature image to its HTML'],
  [(m, t) => /^['"`]?cleanspace-(digest|test)['"`]?,?$/.test(t), 'a push notification tag: a newer push of the same tag replaces the older one'],
  [(m, t) => /cleanspace-app@/.test(t), 'the build tag on support tickets, which the support portal groups by'],
  [(m, t, line) => /`cleanspace_\$\{Date\.now/.test(line) || /`<cleanspace-\$\{crypto/.test(line), 'a MIME boundary or Message-ID prefix: machine-read, never shown'],
  [(m, t) => /^app:$/.test(t) || /^['"]cleanspace['"],?$/.test(t), 'the app field on monitor records, which the alert channel filters on'],
  [(m, t) => /theme-cleanspace\.css/.test(t), 'the client theme\'s file name, which index.css imports'],
  [(m, t, line) => /`CleanSpace-\$\{crypto\.randomBytes/.test(line), 'the prefix of a throwaway password nobody reads: any prefix works'],
  [(m, t) => /cleanspace-(logo|glyph-ink|mark|logo-src)\.(png|jpg)/.test(t),'a logo file path: saved in the org\'s data (company.logoUrl) and read by the brand-asset generators; brand.mjs writes each brand\'s images to these paths'],
];

// The brand pack's generated modules: the identity, and the quote's pages in the brand's own words (CS-388)
const GENERATED = new Set(['src/brand/identity.generated.js', 'src/brand/quote.generated.js']);

// The demo's fictional data, set in the brand's region on purpose: the brand's city and street there are
// fiction, not a hint that should follow the brand. The place needles (its city and street: place) and the
// locale needles are classed so; the brand's name and contacts there are still a leak (CS-400).
export const FICTION = new Map([
  ['src/data/seed.js', 'the demo org\'s fictional book, set in the brand\'s region: a clone rewrites it if it wants its own (REBRAND.md §5)'],
  ['src/lib/csv.js', 'the CSV template\'s sample rows: fictional contacts in the brand\'s region'],
  ['src/data/demoStubs.js', 'the localStorage-stub demo seed (Quotes and Quality): fictional accounts, sites and people in the brand\'s region'],
  ['src/data/sampleData.js', 'the PolishPoint prototype\'s sample data: a generic, fictional service business'],
  ['src/data/dashboardLayoutPreview.js', 'the home-page layout preview\'s fictional accounts (CS-013/CS-066), set in the brand\'s region'],
  ['scripts/seed-backend.mjs', 'the backend demo seed: fictional QC, jobs and time-entry data in the brand\'s region'],
]);

// Code that rewrites this client's own saved records (historical data fixes): it has to name them.
export const MIGRATIONS = [
  [(r, line) => r === 'src/store/persist.js' && /@cleanspace\\?\.co\b/.test(line),'a historical fix of this client\'s saved user emails (@cleanspace.co → the full domain): it matches only their old records'],
];

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Between the words of a value: up to three runs of white space (a line break and the indent after it count
// once), punctuation marks (a hyphen, a dot, an ampersand) or escaped spaces (&nbsp;, %20). A run of white space
// is taken whole (`(?!\s)`): split between the repeats, a long run backtracked cubically (28 s on 5,000 spaces).
const SEP = '(?:\\s+(?!\\s)|[^\\p{L}\\p{N}\\s]|&nbsp;|%20){0,3}';
/**
 * The needle for one identity value, matching it in any spelling (CS-389): in any case, with other separators
 * between its words, and a phone in any grouping of its digits, with or without the country code.
 */
export function needleFor(label, value) {
  if (label === 'phone') {
    const d = value.replace(/\D/g, '');
    const national = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
    return new RegExp(`(?<!\\d)(?:\\+?1${SEP})?\\(?${[...national].join(SEP)}(?!\\d)`, 'gu');
  }
  return new RegExp(value.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(escRe).join(SEP), 'giu');
}
// The shell's first brand in any spelling, plus a brand's identity strings (case-insensitive: a name in
// capitals or a lowercased domain is the same leak)
export function needles(brand) {
  const out = [/clean(?:[\s_\u00a0-]|&nbsp;|%20)?space/gi];
  if (brand) for (const [label, s] of identityStrings(brand)) {
    const re = needleFor(label, s);
    // the brand's street and city are a place: fiction in the demo's fictional data, a leak anywhere else (CS-400)
    if (label === 'street' || label === 'city') re.place = true;
    out.push(re);
  }
  return out;
}

/**
 * The brand's locale, for the source scan only (CS-392): its city, and its area code as a phone writes it,
 * "(754)". A form hint or a line of copy that shows the client's own city follows the brand; the demo's
 * fictional book (FICTION) is set there on purpose. Not a rendered check: the book shows the region on screen.
 */
export function localeNeedles(brand) {
  const { locality, areaCode } = localeOf(brand.company);
  const out = [];
  if (locality.length >= 4) out.push(Object.assign(needleFor('city', locality), { locale: true }));
  if (areaCode) out.push(Object.assign(new RegExp(`\\(${areaCode}\\)`, 'g'), { locale: true }));
  return out;
}

// [start, end) ranges of comments. JS: // (not after ':' as in a URL) and /* */, skipping strings and
// template literals (with ${} nesting); CSS: /* */; HTML/SVG: <!-- -->; JSON: none.
export function commentRanges(text, kind) {
  const out = [];
  if (kind === 'json') return out;
  if (kind === 'css') { for (const m of text.matchAll(/\/\*[\s\S]*?\*\//g)) out.push([m.index, m.index + m[0].length]); return out; }
  if (kind === 'html') { for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) out.push([m.index, m.index + m[0].length]); return out; }
  const n = text.length;
  // contexts: code (with its own brace count; `fromTpl` when a template's ${ opened it) or a template
  const stack = [{ t: 'code', braces: 0, fromTpl: false }];
  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = text[i];
    if (top.t === 'tpl') {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); i++; continue; }
      if (c === '$' && text[i + 1] === '{') { stack.push({ t: 'code', braces: 0, fromTpl: true }); i += 2; continue; }
      i++; continue;
    }
    if (c === '/' && text[i + 1] === '/' && text[i - 1] !== ':') { const e = text.indexOf('\n', i); const end = e < 0 ? n : e; out.push([i, end]); i = end; continue; }
    if (c === '/' && text[i + 1] === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; out.push([i, end]); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      i = j + 1; continue;
    }
    if (c === '`') { stack.push({ t: 'tpl' }); i++; continue; }
    if (c === '{') { top.braces++; i++; continue; }
    if (c === '}') {
      if (top.braces === 0 && top.fromTpl) stack.pop(); // the ${ } closes: back into its template
      else top.braces--;
      i++; continue;
    }
    i++;
  }
  return out;
}

const kindOf = (r) => (/\.css$/.test(r) ? 'css' : /\.(html|svg)$/.test(r) ? 'html' : /\.(json|webmanifest)$/.test(r) ? 'json' : 'js');
const tokenAt = (text, at, len) => {
  let a = at; let b = at + len;
  while (a > 0 && !/[\s'"()[\]{},]/.test(text[a - 1])) a--;
  while (b < text.length && !/[\s'"()[\]{},]/.test(text[b])) b++;
  // keep one enclosing quote or backtick, which some rules key on
  if (/['"`]/.test(text[a - 1] || '')) a--;
  if (/['"`]/.test(text[b] || '')) b++;
  return text.slice(a, b);
};

// Classify every match of `needleList` in one text. `r` is the file's path under app/ (it picks the comment
// syntax, the generator's owned lines, exclusions and migrations); `kind` overrides the comment syntax
// ('text' for rendered page text, which has none).
export function classify(r, raw, needleList, { kind, fiction } = {}) {
  const lines = raw.split(/\r?\n/);
  const owned = ownedLines(r, raw); // the lines brand.mjs writes in index.html, the manifest and sw.js
  const allowMap = new Map();
  const bad = [];
  lines.forEach((ln, i) => {
    const m = /brand:allow(?:\s+[—-]{1,2}\s+(.*?))?\s*(?:\*\/|-->|\}|$)/.exec(ln);
    if (!m) return;
    if (!m[1] || !m[1].trim()) { bad.push({ file: r, line: i + 1, why: 'brand:allow needs a reason' }); return; }
    allowMap.set(i + 1, m[1].trim()); allowMap.set(i + 2, m[1].trim());
  });
  const comments = kind === 'text' ? [] : commentRanges(raw, kind || kindOf(r));
  const inComment = (at) => comments.some(([a, b]) => at >= a && at < b);
  const lineAt = (at) => raw.slice(0, at).split('\n').length;
  // every needle match, merged where they overlap (the longest first). soft = a place or locale needle: fiction
  // in the demo's fictional data. A range is soft only when every match over it is soft (a name over a place is
  // still a leak).
  const hits = [];
  for (const re of needleList) for (const m of raw.matchAll(re)) hits.push([m.index, m.index + m[0].length, !!(re.locale || re.place)]);
  hits.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = []; // [start, end, soft only]
  for (const h of hits) { const last = merged[merged.length - 1]; if (last && h[0] < last[1]) { last[1] = Math.max(last[1], h[1]); last[2] = last[2] && h[2]; } else merged.push([...h]); }
  const rows = [];
  for (const [a, b, softOnly] of merged) {
    const text = raw.slice(a, b);
    const line = lineAt(a);
    const lineText = lines[line - 1] || '';
    const token = tokenAt(raw, a, b - a);
    let cls = 'leak'; let reason;
    if (EXCLUDE.has(r)) { cls = 'excluded'; reason = EXCLUDE.get(r); }
    else if (GENERATED.has(r) || owned?.has(line)) { cls = 'identity'; reason = 'written by brand.mjs from the brand pack'; }
    else if (inComment(a)) cls = 'comment';
    else if (softOnly && (fiction || FICTION.has(r))) { cls = 'fiction'; reason = FICTION.get(r) || 'rendered fictional demo data'; }
    else {
      const id = IDENTIFIERS.find(([t]) => t(text, token, lineText));
      const mig = MIGRATIONS.find(([t]) => t(r, lineText));
      if (id) { cls = 'identifier'; reason = id[1]; }
      else if (mig) { cls = 'migration'; reason = mig[1]; }
      else if (allowMap.has(line)) { cls = 'allowed'; reason = allowMap.get(line); }
    }
    rows.push({ file: r, line, text, token, cls, reason });
  }
  return { rows, bad };
}

/** One file's ledger against a brand (the shell's name in any spelling plus the brand's identity strings). */
export const scanText = (r, raw, brand) => classify(r, raw, [...needles(brand), ...(brand ? localeNeedles(brand) : [])]);

export function buildLedger({ brand } = {}) {
  const active = brand === undefined ? loadBrand(activeBrandId()).brand : brand;
  const files = universe();
  const ledger = [];
  const bad = [];
  for (const f of files) {
    const { rows, bad: b } = scanText(f, fs.readFileSync(path.join(APP, f), 'utf8'), active);
    ledger.push(...rows); bad.push(...b);
  }
  const by = (c) => ledger.filter((x) => x.cls === c).length;
  const leaks = ledger.filter((x) => x.cls === 'leak');
  const summary = { files: files.length, occurrences: ledger.length, identity: by('identity'), identifier: by('identifier'), comment: by('comment'), migration: by('migration'), fiction: by('fiction'), allowed: by('allowed'), excluded: by('excluded'), leaks: leaks.length, badAllows: bad.length };
  return { files, ledger, leaks, bad, summary, brand: active };
}

const invoked = path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url);
if (invoked) {
  const { ledger, leaks, bad, summary, brand } = buildLedger();
  if (process.argv.includes('--json')) console.log(JSON.stringify({ summary, ledger, bad }, null, 1));
  else {
    console.log(`name-ledger (${brand?.id || 'no active brand'}) — ${summary.files} files · ${summary.occurrences} occurrences: ${summary.identity} identity (generated), ${summary.identifier} identifiers kept, ${summary.comment} in comments, ${summary.migration} in data migrations, ${summary.fiction} in fictional demo data, ${summary.allowed} allowed, ${summary.excluded} excluded, ${summary.leaks} leak(s)`);
    if (leaks.length) {
      const per = {};
      for (const l of leaks) per[l.file] = (per[l.file] || 0) + 1;
      console.log('\nleaks by file:\n  ' + Object.entries(per).sort((x, y) => y[1] - x[1]).map(([f, c]) => `${String(c).padStart(4)}  ${f}`).join('\n  '));
      if (process.argv.includes('--all')) console.log('\nleaks:\n  ' + leaks.map((l) => `${l.file}:${l.line}  ${l.text}   [${l.token.slice(0, 60)}]`).join('\n  '));
    }
    if (bad.length) console.log('\nmalformed allows:\n  ' + bad.map((x) => `${x.file}:${x.line} — ${x.why}`).join('\n  '));
  }
  process.exitCode = leaks.length || bad.length ? 1 : 0;
}
