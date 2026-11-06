// test-document-title — the browser tab's title has one writer (CS-563).
//
// lib/documentTitle.js owns document.title. It takes the title it first finds as the app's own (index.html's, the
// brand's app title) and puts the unread count in front of it: "(2) Clean Space CRM". A page that writes
// document.title itself replaces the app's name in the tab, and because the manager keeps the first title it finds,
// a page that writes before the manager's first read (the approvals page did, `document.title = 'Approvals'`, on a
// load or reload of /approvals) leaves every page's tab reading "(2) Approvals" for the rest of the session. This
// suite:
//   1. finds every write to document.title in the app and the server, and allows it only in lib/documentTitle.js;
//   2. proves the detector on fixtures (a gate that stopped seeing writes would pass forever);
//   3. drives the manager: the app's title is the base, a count goes in front of it, a reset takes it off.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const MANAGER = 'src/lib/documentTitle.js';
let failed = 0;
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed += 1; console.error(`  ✗ ${msg}`); } };

// a write: document.title = … (or +=, -=, …) and document['title'] = …; never a comparison (==, ===) or a read.
// Comment lines are skipped, so a note that quotes a write isn't one.
const WRITE = /\bdocument\s*(?:\.\s*title|\[\s*(['"`])title\1\s*\])\s*(?:[+\-*/]?=)(?!=)/;
export function titleWrites(text) {
  const out = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
    if (WRITE.test(line)) out.push({ line: i + 1, text: t });
  });
  return out;
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(js|jsx|mjs)$/.test(e.name)) out.push(full);
  }
  return out;
}

// ── 1. the real tree ─────────────────────────────────────────────────────────
console.log('who writes the tab title');
const files = [...walk(path.join(APP, 'src')), ...walk(path.join(APP, 'api'))];
const rel = (f) => path.relative(APP, f).split(path.sep).join('/');
const writes = files.flatMap((f) => titleWrites(fs.readFileSync(f, 'utf8')).map((w) => ({ file: rel(f), ...w })));
const stray = writes.filter((w) => w.file !== MANAGER);
ok(files.length > 100 && files.some((f) => rel(f).startsWith('src/pages/')) && files.some((f) => rel(f).startsWith('api/')),
  `the scan reaches the pages, the components and the server (${files.length} files)`);
ok(stray.length === 0, `only ${MANAGER} writes document.title (${stray.length} other write${stray.length === 1 ? '' : 's'})`);
for (const w of stray) console.error(`      ${w.file}:${w.line}  ${w.text}`);
ok(writes.some((w) => w.file === MANAGER), 'the manager itself still writes it (a scan that found nothing would prove nothing)');

// ── 2. the detector ──────────────────────────────────────────────────────────
console.log('the detector');
const FIXTURES = [
  ["useEffect(() => { document.title = 'Approvals'; }, []);", 1],
  ['document.title=`(${n}) ${base}`;', 1],
  ["document.title += ' · Reports';", 1],
  ["document['title'] = 'x';", 1],
  ["if (document.title === 'Approvals') return;", 0],
  ['const t = document.title;', 0],
  ["// document.title = 'Approvals' was here", 0],
  [" * a page must not set document.title = 'x'", 0],
];
for (const [src, n] of FIXTURES) ok(titleWrites(src).length === n, `${n ? 'finds' : 'ignores'}: ${src}`);

// ── 3. the manager ───────────────────────────────────────────────────────────
console.log('the manager');
const { IDENTITY } = await import('../src/brand/identity.generated.js');
// the tab names the SOFTWARE: index.html's <title> is the pack's product app title (UI_RULES §129)
const APP_TITLE = IDENTITY.product.appTitle;
globalThis.document = { title: APP_TITLE };
const { setUnreadCount, resetTitle } = await import('../src/lib/documentTitle.js');
setUnreadCount(2);
const counted = document.title;
setUnreadCount(0);
const cleared = document.title;
setUnreadCount(5);
resetTitle();
ok(counted === `(2) ${APP_TITLE}` && cleared === APP_TITLE && document.title === APP_TITLE,
  `the app's title is the base; a count goes in front of it and comes off again ("${counted}")`);

if (failed) { console.error(`\n✗ document title: ${failed} check(s) failed`); process.exit(1); }
console.log('\n✓ document title: one writer, and it keeps the app\'s name in the tab');
