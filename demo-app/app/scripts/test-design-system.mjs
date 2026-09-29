// test-design-system — the design system can never silently drift from the code.
//
// The design system (app/design-system/, published as the "Clean Space" Design System
// artifact) is the reference every new screen and every new client build is made from. It
// is only worth that if it is TRUE, so this suite fails the build when:
//
//   1. TOKENS drift: the committed snapshot (design-system/tokens.json) no longer equals what
//      the theme cascade produces today (the desktop values, and the phone values the
//      `@media … { :root }` blocks set, kept in its meta), a :root variable is neither published as a token nor
//      listed as a recipe, a token lost its usage note, or a type role's CSS rule vanished.
//      Fix: classify the variable in design-system/tokens.config.json, then run
//      `npm --prefix app run design-system` and commit the refreshed tokens.json.
//   2. COMPONENTS drift: a bundled export's file is gone, a card lacks its README/preview,
//      a content folder belongs to nothing, or a card component's props no longer match the
//      props documented in content/components/index.d.ts.
//   3. RULES drift: a numbered rule in UI_RULES.md / THEME_CLEANSPACE.md / STYLING.md /
//      STRUCTURE.md is not classified in design-system/rules.json (or a registry entry names
//      a rule that no longer exists or was reworded), or an entry cites a check that does not
//      exist, or calls itself "gated" without citing a check CI actually runs.
//
// Offline, read-only, no browser: pure parsing of files in this repo.
import fs from 'node:fs';
import path from 'node:path';
import { APP, DS, readJson, buildTokens, enumerateRules, knownChecks, STATUSES, sourceProps, dtsProps, parseRules, readAppCss } from './design-system-lib.mjs';

let failures = 0;
const fail = (msg) => { failures++; console.error('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

// ── 1. tokens ──────────────────────────────────────────────────────────────────────────
console.log('design-system: tokens');
const config = readJson(path.join(DS, 'tokens.config.json'));
const { tokens, errors } = buildTokens(config);
errors.forEach(fail);
const snapshot = readJson(path.join(DS, 'tokens.json'));
const flat = (t) => {
  const m = new Map();
  for (const [fam, v] of Object.entries(t)) if (v && Array.isArray(v.tokens)) for (const x of v.tokens) m.set(`${fam}:${x.name}`, JSON.stringify([x.value, x.usage]));
  for (const g of t.type.groups) for (const s of g.styles) m.set(`type:${s.name}`, JSON.stringify(s));
  for (const [k, v] of Object.entries(t.type.families)) m.set(`family:${k}`, v);
  for (const b of t.meta?.responsive || []) for (const x of b.tokens) m.set(`${b.media}:${x.name}`, JSON.stringify([x.value, x.resolved]));
  return m;
};
if (JSON.stringify(tokens) !== JSON.stringify(snapshot)) {
  const a = flat(snapshot);
  const b = flat(tokens);
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k));
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  fail(`design-system/tokens.json is stale: ${changed.length} changed, ${added.length} added, ${removed.length} removed${[...changed, ...added, ...removed].length ? ` (${[...changed, ...added, ...removed].slice(0, 8).join(', ')}${changed.length + added.length + removed.length > 8 ? ', …' : ''})` : ' (order or notes)'}. Run \`npm --prefix app run design-system\` and commit the refreshed snapshot.`);
} else if (!errors.length) ok(`${tokens.color.tokens.length} colours + ${Object.keys(config.families).length} families${tokens.meta?.responsive ? ` + ${tokens.meta.responsive.reduce((n, b) => n + b.tokens.length, 0)} responsive values` : ''} match the theme cascade`);

// The brand outputs for code that cannot read a CSS variable (document/email templates, canvas), for the
// browser chrome (manifest, theme-color) and the client theme's GENERATED block (data-URI icons) are
// generated from the same cascade.
{
  const { buildBrandJs, chromeTargets, themeTarget, OUT, ROLES } = await import('./brand-js.mjs');
  const { text, errors: brandErrors } = buildBrandJs();
  brandErrors.forEach(fail);
  const theme = themeTarget();
  if (theme.error) fail(theme.error);
  const stale = [];
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
  if (cur !== text) stale.push('src/brand/tokens.generated.js');
  const primary = /primary: '([^']+)'/.exec(text)?.[1];
  const targets = [...(primary ? chromeTargets(primary) : []), ...(theme.target ? [theme.target] : [])];
  for (const [file, before, after] of targets) if (before !== after) stale.push(path.relative(APP, file).split(path.sep).join('/'));
  if (stale.length) fail(`brand outputs are stale (${stale.join(', ')}): run \`npm --prefix app run brand:js\` and commit them.`);
  else if (!brandErrors.length && !theme.error) ok(`${Object.keys(ROLES).length} brand roles (src/brand/tokens.generated.js), the manifest, theme-color and the client theme's GENERATED block match the theme cascade`);
}

// ── 2. components ──────────────────────────────────────────────────────────────────────
console.log('design-system: components');
const comps = readJson(path.join(DS, 'components.json'));
const content = path.join(DS, 'content', 'components');
for (const e of comps.exports) if (!fs.existsSync(path.join(APP, e.from))) fail(`components.json exports ${e.name} from ${e.from}, which does not exist`);
const exportNames = new Set(comps.exports.map((e) => e.name));
const marker = (name) => {
  const f = path.join(content, name, 'preview.html');
  return fs.existsSync(f) ? /^<!-- @dsCard\b([^\n]*?)-->/.exec(fs.readFileSync(f, 'utf8'))?.[1] ?? null : undefined;
};
for (const c of comps.cards) {
  if (!exportNames.has(c)) fail(`card ${c} is not exported by the bundle (components.json exports)`);
  if (!fs.existsSync(path.join(content, c, 'README.md'))) fail(`card ${c} has no content/components/${c}/README.md`);
  const m = marker(c);
  if (m === undefined) fail(`card ${c} has no preview.html`);
  else if (m === null) fail(`card ${c}: preview.html line 1 is not an @dsCard marker`);
  else if (/\bpage\b/.test(m)) fail(`card ${c} is a bundle export but its marker says "page"`);
}
for (const s of comps.showcases) {
  if (!fs.existsSync(path.join(content, s, 'README.md'))) fail(`showcase ${s} has no README.md`);
  const m = marker(s);
  if (!m || !/\bpage\b/.test(m)) fail(`showcase ${s}: preview.html must start with an @dsCard marker carrying "page" (it is not a bundle export)`);
}
const known = new Set([...comps.cards, ...comps.showcases, 'Cover']);
for (const d of fs.readdirSync(content, { withFileTypes: true })) if (d.isDirectory() && !known.has(d.name)) fail(`content/components/${d.name} is neither a card, a showcase nor the Cover (list it in components.json or remove it)`);
if (fs.existsSync(path.join(content, 'Cover')) && fs.readdirSync(path.join(content, 'Cover')).join() !== 'preview.html') fail('content/components/Cover must hold only preview.html (anything else turns the cover into a component)');
const dts = fs.readFileSync(path.join(content, 'index.d.ts'), 'utf8');
let parity = 0;
for (const e of comps.exports.filter((x) => /^[A-Z]/.test(x.name) && !x.named)) {
  const documented = dtsProps(dts, `${e.name}Props`);
  if (documented === null) continue;
  const actual = sourceProps(e.from, e.name);
  if (actual === null) { fail(`${e.name}: could not find function ${e.name}( in ${e.from}`); continue; }
  const missing = actual.filter((p) => !documented.includes(p));
  const phantom = documented.filter((p) => !actual.includes(p));
  if (missing.length) fail(`${e.name} takes ${missing.join(', ')} but index.d.ts ${e.name}Props does not document it; update the types and the card README`);
  if (phantom.length) fail(`index.d.ts ${e.name}Props documents ${phantom.join(', ')}, which ${e.from} no longer reads`);
  parity++;
}
if (!failures) ok(`${comps.exports.length} exports, ${comps.cards.length} cards, ${comps.showcases.length} showcases; props match the source for ${parity} components`);

// ── 3. rules ───────────────────────────────────────────────────────────────────────────
console.log('design-system: rules');
const before = failures;
const registry = readJson(path.join(DS, 'rules.json'));
const enumerated = enumerateRules();
const entries = new Map();
for (const r of registry.rules) {
  if (entries.has(r.id)) fail(`rules.json lists ${r.id} twice`);
  entries.set(r.id, r);
}
const areaIds = new Set(registry.areas.map((a) => a.id));
const { scripts, files, designRules, gatedScripts, ciTests } = knownChecks();
if (!ciTests) fail('the gate cannot tell which suites CI runs: `run-tests.mjs --list` printed no "offline suites" list, or ci.yml no longer runs run-tests.mjs');
const isGatedCheck = (c) => (ciTests || new Set()).has(c) || gatedScripts.has(c);
for (const e of enumerated) {
  const r = entries.get(e.id);
  if (!r) { fail(`${e.source} ${e.ref} "${e.title}" is not classified in design-system/rules.json (id ${e.id})`); continue; }
  if (r.title !== e.title) fail(`${e.id}: the rule's title changed ("${e.title}"); re-check its classification and update rules.json`);
  if (r.source !== e.source || r.ref !== e.ref) fail(`${e.id}: source/ref should be ${e.source} ${e.ref}`);
}
const ids = new Set(enumerated.map((e) => e.id));
for (const r of registry.rules) {
  if (!ids.has(r.id)) { fail(`rules.json has ${r.id}, which no rule doc defines any more`); continue; }
  if (!STATUSES.includes(r.status)) fail(`${r.id}: status "${r.status}" is not one of ${STATUSES.join(', ')}`);
  if (!areaIds.has(r.area)) fail(`${r.id}: area "${r.area}" is not in rules.json areas`);
  if (!r.note || !r.note.trim()) fail(`${r.id}: needs a note saying what holds it (or what doesn't)`);
  for (const c of r.checks || []) {
    const [name, rule] = c.split('#');
    const exists = scripts.has(name) || files.has(name);
    if (!exists) fail(`${r.id}: cites check "${c}", which is neither a package.json lint/test script nor a scripts/test-*.mjs file`);
    if (rule && name === 'lint:design' && !designRules.has(rule)) fail(`${r.id}: design-lint has no rule "${rule}"`);
  }
  if (r.status === 'gated' && !(r.checks || []).some((c) => isGatedCheck(c.split('#')[0]))) fail(`${r.id}: "gated" but none of its checks run in CI (a suite \`run-tests.mjs --list\` runs, or a ci.yml verify lint)`);
  if (r.status === 'checked' && !(r.checks || []).length) fail(`${r.id}: "checked" must name the check`);
  if (r.status === 'superseded' && !(r.supersededBy || []).every((id) => ids.has(id))) fail(`${r.id}: supersededBy must name existing rule ids`);
  if (r.status === 'superseded' && !(r.supersededBy || []).length) fail(`${r.id}: superseded by what?`);
  if (!['gated', 'checked'].includes(r.status) && r.coverage) fail(`${r.id}: coverage applies only to gated/checked rules`);
}
if (failures === before) ok(`${enumerated.length} rules enumerated = ${registry.rules.length} classified (${STATUSES.map((s) => `${s} ${registry.rules.filter((r) => r.status === s).length}`).join(', ')})`);

// ── 4. previews: a component preview shows only button classes the app defines ────────────
// A card's preview.html renders against the kit, so it is reference material a reader copies. A
// retired button class there (the retired .btn-xs was live in two previews, register CS-376) shows
// a dead class as live. A general "every class the preview uses is defined" check is NOT robust: a
// preview's own <style> helpers (.pv, .pv-cap) and some kit classes it renders are not in index.css.
// So this scopes to the BUTTON FAMILY, which tokenizes unambiguously (a token that is `btn` or
// starts with `btn-`; `nav-btn` and the like are not it) and whose one source is index.css. A
// btn / btn-* class a preview uses that index.css does not define fails.
console.log('design-system: preview button classes');
const btnDefined = new Set(
  parseRules(readAppCss()).flatMap((r) => r.selectors)
    .flatMap((s) => [...s.matchAll(/\.(btn(?:-[\w-]+)?)(?![\w-])/g)].map((m) => m[1])),
);
const previewBefore = failures;
for (const c of [...comps.cards, ...comps.showcases, 'Cover']) {
  const f = path.join(content, c, 'preview.html');
  if (!fs.existsSync(f)) continue;
  const used = new Set();
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/class(?:Name)?\s*[:=]\s*['"]([^'"]*)['"]/g)) {
    for (const tok of m[1].split(/\s+/)) if (tok === 'btn' || tok.startsWith('btn-')) used.add(tok);
  }
  for (const tok of used) if (!btnDefined.has(tok)) fail(`${c}/preview.html uses .${tok}, a button class app/src/index.css does not define (a retired or misspelled class reads as live; register CS-376)`);
}
if (failures === previewBefore) ok('every btn / btn-* class in the component previews is defined in index.css');

if (failures) {
  console.error(`\ntest-design-system: ${failures} failure(s). The design system must match the code; see the header of this file for the fix per section.`);
  process.exit(1);
}
console.log('\ntest-design-system: design system matches the code');
