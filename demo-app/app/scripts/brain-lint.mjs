#!/usr/bin/env node
/**
 * brain-lint — keeps brain/ cards truthful (zero-dependency).
 *
 * The brain is only worth its tokens if a wrong card is impossible to miss.
 * Three tiers:
 *   structure — caps (cards ≤120 lines, INDEX ≤80), required frontmatter,
 *               canonical section order for module cards, ≤5 landmines.
 *   truth     — every route/action/selector/permission a card names exists in
 *               code; every `sources` path exists; every INITIAL_STATE key is
 *               owned by exactly one card's `slices:` (no orphans, no doubles).
 *   freshness — `git diff <verified_sha>..HEAD -- <sources>`. For the 4 store
 *               megafiles (reducer/selectors/persist/seed) a card is stale only
 *               if changed lines touch its OWN named symbols — otherwise every
 *               store commit would flag every card (alarm fatigue → rot).
 *
 * Usage:
 *   node app/scripts/brain-lint.mjs                 # check, report, exit 0/1
 *   node app/scripts/brain-lint.mjs --manifest      # dump code truth as JSON (for card generation)
 *   node app/scripts/brain-lint.mjs --stamp         # write `status: stale` onto freshness-failing cards
 *   node app/scripts/brain-lint.mjs --stamp-fresh all|<name...>   # stamp verified/verified_sha at HEAD
 *   node app/scripts/brain-lint.mjs --json          # machine-readable report
 *
 * Exit: 0 pass / 1 violations / 2 internal error. Unstamped cards (null
 * verified_sha) are a warning, not a failure — they simply have no freshness.
 * Run by the /ship ritual: a failure blocks the ritual, never a deploy.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');            // repo root
const BRAIN = path.join(ROOT, 'brain');

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const MANIFEST = flag('--manifest');
const STAMP = flag('--stamp');
const JSON_OUT = flag('--json');
const stampFreshIdx = args.indexOf('--stamp-fresh');
const STAMP_FRESH = stampFreshIdx >= 0 ? (args.slice(stampFreshIdx + 1).filter((a) => !a.startsWith('--'))) : null;

const MEGAFILES = new Set([
  'app/src/store/reducer.js',
  'app/src/store/selectors.js',
  'app/src/store/persist.js',
  'app/src/data/seed.js',
]);
const CAPS = { index: 80, default: 120 };
const MODULE_SECTION_ORDER = ['Surfaces', 'State', 'Backend', 'Permissions', 'Cross-module FKs', 'Landmines', 'Pointers'];

// ---- code-truth extraction ----------------------------------------------
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

function blockAfter(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error(`marker not found: ${marker}`);
  const open = src.indexOf('{', i);
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  throw new Error(`unbalanced braces after: ${marker}`);
}

function extractActions() {
  const block = blockAfter(stripComments(read('app/src/store/reducer.js')), 'export const ACTIONS');
  return [...block.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)].map((m) => m[1]);
}
function extractSelectors() {
  const src = stripComments(read('app/src/store/selectors.js'));
  return [...src.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
}
function extractStateKeys() {
  const block = blockAfter(stripComments(read('app/src/data/seed.js')), 'export const INITIAL_STATE');
  const keys = [];
  let depth = 0;
  for (const line of block.split('\n')) {
    if (depth === 1) {
      const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*[:,]/);
      if (m) keys.push(m[1]);
    }
    for (const ch of line) {
      if (ch === '{' || ch === '[' || ch === '(') depth++;
      else if (ch === '}' || ch === ']' || ch === ')') depth--;
    }
  }
  return [...new Set(keys)];
}
function extractRoutes() {
  const src = read('app/src/App.jsx');
  const paths = new Set([...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1].replace(/^\//, '')));
  if (/<Route index/.test(src)) paths.add('/');
  return [...paths];
}
function extractPerms() {
  const block = blockAfter(stripComments(read('app/src/lib/roles.js')), 'export const PERMISSIONS');
  return [...block.matchAll(/'([A-Za-z][\w.]*)'\s*:/g)].map((m) => m[1]);
}

// ---- card parsing --------------------------------------------------------
export function parseFrontmatter(text) {
  // Normalize line endings FIRST. The key/list regexes below end in `$` with no `m`
  // flag, and JS regex `.` excludes \r (it counts as a line terminator) — so on a
  // Windows CRLF checkout every `key: value` line fails to match and the card parses
  // as ZERO frontmatter keys. That surfaced as "frontmatter missing `title`" on all
  // 29 cards, including ones that plainly have it. Callers keep the RAW text for
  // --stamp writes, so this never rewrites a file's line endings.
  const src = text.replace(/\r\n?/g, '\n');
  if (!src.startsWith('---')) return { fm: {}, body: src };
  const end = src.indexOf('\n---', 3);
  if (end < 0) return { fm: {}, body: src };
  const fmRaw = src.slice(3, end);
  const body = src.slice(src.indexOf('\n', end + 1) + 1);
  const fm = {};
  let listKey = null;
  for (const line of fmRaw.split('\n')) {
    const li = line.match(/^\s+-\s+(.+)$/);
    if (li && listKey) { fm[listKey].push(li[1].trim()); continue; }
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawVal] = kv;
    const val = rawVal.replace(/\s+#.*$/, '').trim();   // strip trailing comments
    if (val === '' ) { fm[key] = []; listKey = key; continue; }
    listKey = null;
    if (val.startsWith('[')) {
      fm[key] = val.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    } else {
      fm[key] = val.replace(/^['"]|['"]$/g, '');
    }
  }
  return { fm, body };
}

const backtickTokens = (line) => [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

function parseCard(file) {
  const text = fs.readFileSync(file, 'utf8');
  const { fm, body } = parseFrontmatter(text);
  const lines = text.split('\n');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const card = {
    file: rel, text, fm, lineCount: lines.length,
    routes: [], actions: [], selectors: [], bodySlices: [], perms: [], landmineCount: 0, sections: [],
  };
  let section = null;
  for (const line of body.split('\n')) {
    const h = line.match(/^## (.+?)\s*$/);
    if (h) { section = h[1]; card.sections.push(section); continue; }
    if (/^\*\*Routes:\*\*/.test(line)) card.routes.push(...backtickTokens(line));
    if (/^\*\*Actions:\*\*/.test(line)) card.actions.push(...backtickTokens(line));
    if (/^\*\*Selectors:\*\*/.test(line)) card.selectors.push(...backtickTokens(line));
    if (/^\*\*Slices:\*\*/.test(line)) card.bodySlices.push(...backtickTokens(line));
    if (section === 'Permissions') card.perms.push(...backtickTokens(line).filter((t) => /^[a-z][\w]*(\.[\w]+)+$/.test(t)));
    if (section === 'Landmines' && /^\s*-\s+/.test(line)) card.landmineCount++;
  }
  return card;
}

function collectCards() {
  const out = [];
  const addDir = (d) => {
    const full = path.join(BRAIN, d);
    if (!fs.existsSync(full)) return;
    for (const f of fs.readdirSync(full)) if (f.endsWith('.md')) out.push(parseCard(path.join(full, f)));
  };
  for (const f of ['INDEX.md', 'CLIENT.md']) {
    const p = path.join(BRAIN, f);
    if (fs.existsSync(p)) out.push(parseCard(p));
  }
  addDir('architecture'); addDir('modules'); addDir('recipes');
  return out;
}

// ---- checks --------------------------------------------------------------
function main() {
  const truth = {
    actions: extractActions(),
    selectors: extractSelectors(),
    slices: extractStateKeys(),
    routes: extractRoutes(),
    permissions: extractPerms(),
  };
  if (MANIFEST) { process.stdout.write(JSON.stringify(truth, null, 2) + '\n'); return 0; }

  const cards = collectCards();
  if (!cards.length) { console.error('brain-lint: no cards found under brain/'); return 1; }
  const violations = [];   // { file, tier, msg }
  const warnings = [];
  const v = (file, tier, msg) => violations.push({ file, tier, msg });

  const actionSet = new Set(truth.actions);
  const selectorSet = new Set(truth.selectors);
  const sliceSet = new Set(truth.slices);
  const routeSet = new Set(truth.routes);
  const permSet = new Set(truth.permissions);

  // structure + truth per card
  const sliceOwners = new Map();   // slice -> [cards]
  for (const c of cards) {
    const kind = c.fm.kind || 'module';
    const cap = kind === 'index' ? CAPS.index : CAPS.default;
    if (c.lineCount > cap) v(c.file, 'structure', `${c.lineCount} lines exceeds the ${cap}-line cap`);
    for (const key of ['title', 'type', 'kind', 'status']) if (!(key in c.fm)) v(c.file, 'structure', `frontmatter missing \`${key}\``);
    if (kind === 'module' && !(c.fm.sources || []).length) v(c.file, 'structure', 'module card has no `sources`');
    if (kind === 'module') {
      const idx = c.sections.filter((s) => MODULE_SECTION_ORDER.includes(s)).map((s) => MODULE_SECTION_ORDER.indexOf(s));
      if (idx.some((n, i) => i > 0 && n < idx[i - 1])) v(c.file, 'structure', 'sections out of canonical order');
    }
    if (c.landmineCount > 5) v(c.file, 'structure', `${c.landmineCount} landmines (max 5)`);

    for (const r of c.routes) {
      if (r !== '/' && !r.startsWith('/')) continue;   // Routes-line prose tokens (component names, perms) aren't routes
      const norm = r.replace(/^\//, '');
      const ok = r === '/' || routeSet.has(norm) || routeSet.has(norm.split('/').slice(-1)[0]) || routeSet.has(norm.split('/').slice(-2).join('/'));
      if (!ok) v(c.file, 'truth', `route \`${r}\` not found in App.jsx`);
    }
    for (const a of c.actions) if (!actionSet.has(a)) v(c.file, 'truth', `action \`${a}\` not in reducer ACTIONS`);
    for (const s of c.selectors) if (!selectorSet.has(s)) v(c.file, 'truth', `selector \`${s}\` not exported by selectors.js`);
    for (const p of c.perms) if (!permSet.has(p)) v(c.file, 'truth', `permission \`${p}\` not in lib/roles.js PERMISSIONS`);
    for (const src of c.fm.sources || []) {
      if (fs.existsSync(path.join(ROOT, src))) continue;
      // Static-demo backend strip: `app/api` is deliberately removed from this deployed
      // tree (recoverable from history — see brain/CLIENT.md). The cards still document the
      // shell's backend architecture, which is truth about the SHELL, just not present in a
      // static demo. Treat an absent `app/api/**` source as a NOTE, not a failure — but ONLY
      // while `app/api` is actually stripped; a go-live build that restores the backend makes
      // a missing api path a real error again. Structural check (dir presence), no hardcoded
      // SHA, so it survives the git-archive reclone the /new-client-demo skill performs.
      if (/^app\/api\//.test(src) && !fs.existsSync(path.join(ROOT, 'app/api'))) {
        warnings.push(`${c.file}: source \`${src}\` absent — app/api stripped for the static demo (recoverable; see brain/CLIENT.md)`);
        continue;
      }
      v(c.file, 'truth', `source path \`${src}\` does not exist`);
    }
    for (const sl of c.fm.slices || []) {
      if (!sliceSet.has(sl)) v(c.file, 'truth', `slice \`${sl}\` not an INITIAL_STATE key`);
      sliceOwners.set(sl, [...(sliceOwners.get(sl) || []), c.file]);
    }
  }
  for (const [sl, owners] of sliceOwners) if (owners.length > 1) v('brain/', 'truth', `slice \`${sl}\` owned by ${owners.length} cards: ${owners.join(', ')}`);
  const orphans = truth.slices.filter((sl) => !sliceOwners.has(sl));
  if (orphans.length) v('brain/', 'truth', `INITIAL_STATE keys owned by no card: ${orphans.join(', ')}`);

  // freshness (git-driven, symbol-scoped for megafiles)
  let git = true;
  try { execSync('git rev-parse --verify HEAD', { cwd: ROOT, stdio: 'pipe' }); } catch { git = false; warnings.push('git unavailable — freshness tier skipped'); }
  const staleCards = [];
  if (git) {
    for (const c of cards) {
      const sha = c.fm.verified_sha;
      if (!sha || sha === 'null') { if ((c.fm.kind || 'module') !== 'index') warnings.push(`${c.file}: unstamped (no verified_sha) — no freshness check`); continue; }
      const sources = c.fm.sources || [];
      if (!sources.length) continue;
      let changed;
      try {
        changed = execSync(`git diff --name-only ${sha}..HEAD -- ${sources.map((s) => `"${s}"`).join(' ')}`, { cwd: ROOT, stdio: 'pipe' }).toString().trim().split('\n').filter(Boolean);
      } catch { v(c.file, 'freshness', `verified_sha \`${sha}\` unknown to git`); continue; }
      const symbols = [...c.actions, ...c.selectors, ...(c.fm.slices || [])];
      let stale = false;
      for (const f of changed.map((f) => f.replace(/\\/g, '/'))) {
        if (!MEGAFILES.has(f)) { stale = true; v(c.file, 'freshness', `source \`${f}\` changed since ${sha}`); continue; }
        const diff = execSync(`git diff ${sha}..HEAD -- "${f}"`, { cwd: ROOT, stdio: 'pipe' }).toString();
        const touched = diff.split('\n').filter((l) => /^[+-][^+-]/.test(l)).join('\n');
        const hit = symbols.find((sym) => new RegExp(`\\b${sym}\\b`).test(touched));
        if (hit) { stale = true; v(c.file, 'freshness', `\`${f}\` diff since ${sha} touches \`${hit}\``); }
      }
      if (stale) staleCards.push(c);
    }
  }

  // stamping
  if (STAMP && staleCards.length) {
    for (const c of staleCards) {
      const updated = c.text.replace(/^status:.*$/m, 'status: stale          # stamped by brain-lint --stamp');
      fs.writeFileSync(path.join(ROOT, c.file), updated);
      console.log(`stamped stale: ${c.file}`);
    }
  }
  if (STAMP_FRESH) {
    const head = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: 'pipe' }).toString().trim();
    const today = new Date().toLocaleDateString('sv-SE');   // local YYYY-MM-DD, not UTC tomorrow
    const targets = STAMP_FRESH.includes('all') || !STAMP_FRESH.length
      ? cards.filter((c) => (c.fm.kind || '') !== 'index')
      : cards.filter((c) => STAMP_FRESH.some((n) => c.file.includes(n)));
    for (const c of targets) {
      let t = c.text.replace(/^status:.*$/m, 'status: active')
        .replace(/^verified:.*$/m, `verified: ${today}`)
        .replace(/^verified_sha:.*$/m, `verified_sha: ${head}`);
      fs.writeFileSync(path.join(ROOT, c.file), t);
      console.log(`stamped fresh @ ${head}: ${c.file}`);
    }
  }

  // report
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ violations, warnings, cards: cards.length }, null, 2) + '\n');
  } else {
    for (const w of warnings) console.log(`⚠ ${w}`);
    if (!violations.length) {
      console.log(`brain-lint: ${cards.length} cards clean (structure + truth${git ? ' + freshness' : ''}).`);
    } else {
      for (const { file, tier, msg } of violations) console.log(`✗ [${tier}] ${file} — ${msg}`);
      console.log(`brain-lint: ${violations.length} violation(s) across ${cards.length} cards.`);
    }
  }
  return violations.length ? 1 : 0;
}

// Run only when invoked as the CLI, so `test-brain-lint-frontmatter.mjs` can import
// parseFrontmatter without the whole lint firing (and calling process.exit) on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exit(main()); }
  catch (e) { console.error('brain-lint internal error:', e.message); process.exit(2); }
}
