// The supply spend behind the customers' "Over supply budget" flag is read as the app opens and kept, so the
// Customers list and a customer's page draw with the flag in place and nothing moves after (CS-963).
//
// WHY. Found 2026-11-02 while fixing CS-962: the Customers list and a customer's page each read the supply
// budgets after they drew (useSupplyBudgets, one GET /api/supplies/budgets per page), so an over-budget
// customer's "Over supply budget" badge joined its Status cell a moment late and, on a computer, the Status
// column widened and the list's rows grew (975 → 1160px on the demo). Daniel, 2026-11-02 (4:26 PM PST), picked
// "Same fix, after this release (Recommended)": the app reads the supply budgets as it opens and keeps them, so
// the list and a customer's page draw with the flag already in place; a change shows on the next page open; the
// Supplies page keeps its own read, so its figures still update right after an order changes.
//
//   §1  the kept read (lib/keptRead.js, which the ticket counts use too), run on its cases with a read and a
//       clock of its own: what it keeps, shaped by `accept`; one read at a time; a page opened before the first
//       read has answered waits once, at most WAIT_MS; a read answering while a page is open changes the next
//       page, never that one; a failed read keeps the last good answer and says it failed; a person's Retry
//       (`force`) reads at once; a read made elsewhere (`take`, the Supplies page's own) is kept for the next
//       page, and an older read answering after it never puts the older figures back; another person forgets
//       it, and a read under way for the person before never lands
//   §2  the hook (hooks/useSupplyBudgets.js): the app's one kept copy, made outside the hooks, its read the
//       budgets route's; useKeptSupplyBudgets (the list's and a customer's page's) reads nothing itself, takes
//       the kept copy as the page opens and changes it only by the one wait or a person's Retry, and says
//       `ready`; useSupplyBudgets (the Supplies page's and the report's) keeps its own read and hands each
//       answer to the kept copy; prefetchSupplyBudgets for the shell
//   §3  the pages: the Customers list and a customer's page take the kept copy and wait for it with the ticket
//       counts (no rows, and nothing, until both are ready); the list's empty states don't wait; the Supplies
//       page and the supply usage report keep their own read
//   §4  the shell: the office shell reads the supply budgets as the app opens, for someone who may see
//       supplies; a cleaner's app reads nothing (no flag there)
//
// The browser half, measured 2026-11-02 frame by frame as each is painted (the session's supply-frames.mjs, not in
// CI): on the demo with the budgets read given 1.5 seconds (live it took 0.97 to 1.85) and the ticket counts 0.8,
// at 1280 x 800 and 390 x 844, on 516d0b3c the list drew its rows without "Over supply budget" and then with it
// (1133 → 1169px at 1280 x 800) and the over-budget customer's page drew without it and then with it, loaded
// straight and opened in the app alike; with this, every frame with rows had it, at one height, and so did every
// frame of the customer's page. Someone without supplies.view reads nothing and waits for nothing.
//
// REGRESSION (THE LAW II.3): on 516d0b3c there is no lib/keptRead.js, every page reads the budgets itself after
// it draws (useSupplyBudgets, the one hook), nothing waits for them and the shell reads nothing, so §1 to §4 fail.
//
//   node app/scripts/test-supply-budgets.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
// One pass, whichever comment starts first: a `/*` inside a `//` line (Supplies.jsx's "/supplies/*") is that
// line's text, never the start of a block. A `//` just after a colon or a quote is a URL or a string's.
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\/|(^|[^:'"`\\])\/\/[^\n]*/gm, (m, pre) => (pre === undefined ? '' : pre));

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const settle = () => new Promise((r) => setImmediate(r));

// A call's text: from `name(` to its matching `)`.
function callBody(src, name, from = 0) {
  const i = src.indexOf(`${name}(`, from);
  if (i < 0) return '';
  let depth = 0;
  for (let j = i + name.length; j < src.length; j += 1) {
    if (src[j] === '(') depth += 1;
    else if (src[j] === ')') { depth -= 1; if (depth === 0) return src.slice(i, j + 1); }
  }
  return '';
}
// A function's text: from `export function name(` to the next top-level `export ` or the end.
function fnBody(src, name) {
  const i = src.indexOf(`export function ${name}(`);
  if (i < 0) return '';
  const next = src.indexOf('\nexport ', i + 10);
  return src.slice(i, next < 0 ? undefined : next);
}

// ── §1 the kept read ──────────────────────────────────────────────────────────────────────────

let lib = null;
try { lib = await import(pathToFileURL(path.join(APP, 'src/lib/keptRead.js')).href); } catch { lib = null; }
ok('§1 lib/keptRead.js keeps a read (createKeptRead, REFRESH_MS, WAIT_MS)',
  !!lib && typeof lib.createKeptRead === 'function' && Number.isFinite(lib.REFRESH_MS) && Number.isFinite(lib.WAIT_MS));
if (lib && typeof lib.createKeptRead === 'function') {
  const { createKeptRead, REFRESH_MS, WAIT_MS } = lib;
  let tickets = null;
  try { tickets = await import(pathToFileURL(path.join(APP, 'src/lib/ticketCountsCache.js')).href); } catch { tickets = null; }
  ok('§1 the ticket counts keep theirs the same way (the same REFRESH_MS and WAIT_MS)',
    !!tickets && tickets.REFRESH_MS === REFRESH_MS && tickets.WAIT_MS === WAIT_MS);

  // The budgets' own shape: { clientId → cents }, anything else kept as none spent.
  const accept = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : {});
  const rig = () => {
    const r = { t: 1000, reads: [], timers: new Map(), id: 0 };
    r.read = () => new Promise((resolve, reject) => { r.reads.push({ resolve, reject }); });
    r.later = (fn, ms) => { r.id += 1; r.timers.set(r.id, { fn, at: r.t + ms }); return r.id; };
    r.cancel = (id) => { r.timers.delete(id); };
    r.tick = (ms) => { r.t += ms; for (const [id, x] of [...r.timers]) if (x.at <= r.t) { r.timers.delete(id); x.fn(); } };
    r.kept = createKeptRead({ read: r.read, accept, now: () => r.t, later: r.later, cancel: r.cancel });
    return r;
  };
  const A1 = { cl_1: 23680, cl_2: 5000 };
  const A2 = { cl_1: 24100 };
  const A3 = { cl_1: 30000, cl_3: 100 };

  {
    const r = rig();
    r.kept.setOwner('u1');
    const s0 = r.kept.snapshot('u1');
    ok('§1 before the first read has answered, a page is not ready and has nothing', s0.ready === false && s0.value === null);
    let woke = 0;
    r.kept.whenSettled(() => { woke += 1; });
    r.kept.refresh();
    r.kept.refresh();
    await settle();
    ok('§1 one read at a time: a second ask while one is under way starts none', r.reads.length === 1, String(r.reads.length));
    r.reads[0].resolve(A1);
    await settle();
    const s1 = r.kept.snapshot('u1');
    ok('§1 the first read answering makes it ready, with the answer', s1.ready === true && s1.value === A1 && s1.failed === false);
    ok('§1 …and wakes the page waiting for it, once', woke === 1, String(woke));

    r.t = 1000 + REFRESH_MS - 50;
    r.kept.refresh();
    await settle();
    ok('§1 a page open within REFRESH_MS of the last read reads nothing', r.reads.length === 1, String(r.reads.length));
    r.kept.refresh({ force: true });
    await settle();
    ok('§1 …but a person\'s Retry (`force`) reads at once', r.reads.length === 2, String(r.reads.length));
    r.kept.refresh({ force: true });
    await settle();
    ok('§1 …and not twice while that read is under way', r.reads.length === 2, String(r.reads.length));
    const before = r.kept.snapshot('u1');
    r.reads[1].resolve(A2);
    await settle();
    ok('§1 a read answering while a page is open changes the next page that opens', r.kept.snapshot('u1').value === A2);
    ok('§1 …never the page already open (what it took is as it was)', before.value === A1);

    r.tick(REFRESH_MS + 1);
    r.kept.refresh();
    await settle();
    r.reads[2].reject(new Error('offline'));
    await settle();
    const s3 = r.kept.snapshot('u1');
    ok('§1 a failed read keeps what the last good one said, and says it failed', s3.ready === true && s3.value === A2 && s3.failed === true);

    r.tick(REFRESH_MS + 1);
    r.kept.refresh();
    await settle();
    r.reads[3].resolve(['not', 'figures']);
    await settle();
    const s4 = r.kept.snapshot('u1');
    ok('§1 an answer of the wrong shape is kept as `accept` makes it (none spent), and the read no longer failed',
      s4.value && typeof s4.value === 'object' && !Array.isArray(s4.value) && Object.keys(s4.value).length === 0 && s4.failed === false);

    r.kept.take('u1', A3);
    ok('§1 a read made elsewhere (`take`) is kept for the next page that opens', r.kept.snapshot('u1').value === A3);
    r.kept.take('u2', A1);
    ok('§1 …but never one made for another person', r.kept.snapshot('u1').value === A3 && r.kept.snapshot('u2').ready === false);
    r.kept.refresh();
    await settle();
    ok('§1 …and it counts as the last read: a page opening just after reads nothing', r.reads.length === 4, String(r.reads.length));

    ok('§1 another person\'s page is not ready with this read', r.kept.snapshot('u2').ready === false && r.kept.snapshot('u2').value === null);
    r.kept.setOwner('u2');
    ok('§1 another person signed in forgets it', r.kept.snapshot('u1').ready === false && r.kept.snapshot('u2').ready === false);
    r.kept.refresh();
    await settle();
    ok('§1 …and reads theirs at once, whenever the last read was', r.reads.length === 5, String(r.reads.length));
  }
  {
    const r = rig();
    r.kept.setOwner('u1');
    r.kept.refresh();
    await settle();
    r.kept.take('u1', A3);
    r.reads[0].resolve(A1);
    await settle();
    ok('§1 a read that began before a `take` and answers after it never puts the older figures back', r.kept.snapshot('u1').value === A3);
  }
  {
    const r = rig();
    r.kept.setOwner('u1');
    let woke = 0;
    r.kept.whenSettled(() => { woke += 1; });
    r.kept.take('u1', A1);
    ok('§1 a `take` before the first read has answered makes it ready and wakes a waiting page', r.kept.snapshot('u1').ready === true && woke === 1, String(woke));
  }
  {
    const r = rig();
    r.kept.setOwner('u1');
    let woke = 0;
    r.kept.whenSettled(() => { woke += 1; });
    r.kept.refresh();
    await settle();
    r.tick(WAIT_MS - 1);
    ok('§1 a page waits for a read that hasn\'t answered…', woke === 0, String(woke));
    r.tick(2);
    ok('§1 …until WAIT_MS has gone, then draws without it', woke === 1 && r.kept.snapshot('u1').ready === false);
    r.reads[0].resolve(A1);
    await settle();
    ok('§1 …and isn\'t woken again when the read answers late (that is for the next page)', woke === 1, String(woke));
  }
  {
    const r = rig();
    r.kept.setOwner('u1');
    r.kept.refresh();
    await settle();
    r.reads[0].reject(new Error('403'));
    await settle();
    const s = r.kept.snapshot('u1');
    ok('§1 a first read that fails is an answer: ready, nothing kept, and it says it failed', s.ready === true && s.value === null && s.failed === true);
  }
  {
    const r = rig();
    r.kept.setOwner('u1');
    r.kept.refresh();
    await settle();
    r.kept.setOwner('u2');
    r.reads[0].resolve(A1);
    await settle();
    ok('§1 a read under way for the person before never lands for the next', r.kept.snapshot('u2').ready === false && r.kept.snapshot('u2').value === null);
  }
}

// ── §2 the hook ───────────────────────────────────────────────────────────────────────────────

const hookSrc = stripJsComments(read('src/hooks/useSupplyBudgets.js'));
const keptHook = fnBody(hookSrc, 'useKeptSupplyBudgets');
const ownHook = fnBody(hookSrc, 'useSupplyBudgets');
const outside = (() => { const i = hookSrc.indexOf('export function '); return i < 0 ? hookSrc : hookSrc.slice(0, i); })();
ok('§2 the app\'s one kept copy of the budgets, made outside the hooks from lib/keptRead.js',
  /import\s*\{[^}]*\bcreateKeptRead\b[^}]*\}\s*from\s*'\.\.\/lib\/keptRead(\.js)?'/.test(hookSrc) && /createKeptRead\(\{\s*read:/.test(outside));
ok('§2 …its read the budgets route\'s', /read:\s*\(\)\s*=>\s*suppliesApi\.budgets\(\)/.test(outside));
ok('§2 the list\'s and a customer\'s page\'s hook (useKeptSupplyBudgets) reads nothing itself', !!keptHook && !/suppliesApi\.budgets\(/.test(keptHook));
ok('§2 …takes the kept copy as the page opens (useState from its snapshot)', /useState\(\(\)\s*=>\s*\(?\s*canView\s*\?\s*keptSpend\.snapshot\(\w+\)/.test(keptHook));
ok('§2 …and someone who may not see supplies takes "ready, nothing kept": nothing to wait for',
  /canView\s*\?\s*keptSpend\.snapshot\(\w+\)\s*:\s*\{\s*ready:\s*true,\s*value:\s*null,\s*failed:\s*false\s*\}/.test(keptHook));
{
  const sets = keptHook.match(/setSeen\(/g) || [];
  const waitCall = callBody(keptHook, 'keptSpend.whenSettled');
  const retry = (() => { const i = keptHook.indexOf('force: true'); return i < 0 ? '' : keptHook.slice(i, i + 200); })();
  ok('§2 …and changes it only by the wait for the first read, or a person\'s Retry', sets.length === 2 && /setSeen\(/.test(waitCall) && /setSeen\(/.test(retry), `${sets.length} setSeen`);
}
ok('§2 …asks for a read in the background as the page opens (refresh in its effect, run once)',
  /useEffect\(\(\)\s*=>\s*\{[\s\S]*?keptSpend\.refresh\(\)[\s\S]*?\},\s*\[\]\)/.test(keptHook));
// `ready` is what the page took as it opened, alone: were it to read the permission again, a permission that
// changes while the page is open (the owner's View as, which switches in place) would blank the list for good.
ok('§2 …and says whether the page may draw (`ready`), from what it took as it opened alone',
  /ready:\s*seen\.ready\s*\}/.test(keptHook) && !/ready:\s*[^,}\n]*canView/.test(keptHook));
ok('§2 the Supplies page\'s hook (useSupplyBudgets) keeps its own read', !!ownHook && /suppliesApi\.budgets\(\)/.test(ownHook));
ok('§2 …and hands each answer to the kept copy, for the next page that opens', /keptSpend\.take\(/.test(ownHook));
ok('§2 prefetchSupplyBudgets names the person and starts the read',
  /export function prefetchSupplyBudgets\(\w+\)\s*\{[\s\S]*?keptSpend\.setOwner\([\s\S]*?keptSpend\.refresh\(\)/.test(hookSrc));

// ── §3 the pages ──────────────────────────────────────────────────────────────────────────────

{
  const src = stripJsComments(read('src/pages/Clients.jsx'));
  const wait = src.search(/!ticketFlags\.ready\s*\|\|\s*!supplyBudgets\.ready\s*\?\s*\(\s*null\s*\)/);
  const noMatches = src.indexOf('title="No matches"');
  const table = src.indexOf('className="table-wrap mobile-stack"');
  ok('§3 the Customers list takes the kept budgets', /const supplyBudgets = useKeptSupplyBudgets\(\);/.test(src) && !/useSupplyBudgets\(\)/.test(src));
  ok('§3 …and draws no rows until they and the ticket counts are ready', wait > -1 && table > wait, `wait at ${wait}, table at ${table}`);
  ok('§3 …and its empty states ("No customers yet", "No matches") don\'t wait', noMatches > -1 && wait > -1 && noMatches < wait);
}
{
  const src = stripJsComments(read('src/pages/ClientDetail.jsx'));
  const lastHook = src.lastIndexOf('useCustomerTextStatus(');
  const notFound = src.indexOf('if (!client) {');
  const wait = src.search(/if \(!ticketFlags\.ready \|\| !supplyBudgets\.ready\) return /);
  const page = src.indexOf('<div className="page-pad">\n      <DetailHeader');
  ok('§3 a customer\'s page takes the kept budgets', /const supplyBudgets = useKeptSupplyBudgets\(\);/.test(src) && !/useSupplyBudgets\(\)/.test(src));
  ok('§3 …and draws nothing until they and the ticket counts are ready', wait > -1 && page > wait, `wait at ${wait}, page at ${page}`);
  ok('§3 …waiting after every hook and the not-found page, so the hooks run on every draw', wait > lastHook && wait > notFound && lastHook > -1 && notFound > -1);
}
ok('§3 the Supplies page keeps its own read (its figures update right after an order changes)', /const budgets = useSupplyBudgets\(\);/.test(stripJsComments(read('src/pages/Supplies.jsx'))));
ok('§3 the supply usage report keeps its own read', /const budgets = useSupplyBudgets\(\);/.test(stripJsComments(read('src/pages/reports/SupplyUsageReport.jsx'))));

// ── §4 the shell ──────────────────────────────────────────────────────────────────────────────

{
  const src = stripJsComments(read('src/layouts/AppLayout.jsx'));
  ok('§4 the office shell reads the supply budgets as the app opens (prefetchSupplyBudgets from the hook)',
    /import\s*\{[^}]*\bprefetchSupplyBudgets\b[^}]*\}\s*from\s*'\.\.\/hooks\/useSupplyBudgets'/.test(src)
    && /if\s*\(!crew\s*&&\s*seesSupplies\)\s*prefetchSupplyBudgets\(/.test(src));
  ok('§4 …only for someone who may see supplies, asked on every draw (supplies.view, not behind a condition)', /const seesSupplies = usePermission\('supplies\.view'\);/.test(src));
  const crewBranch = src.slice(src.indexOf('if (crew) {'));
  ok('§4 a cleaner\'s app reads nothing (no flag there)', src.indexOf('if (crew) {') > -1 && !/prefetchSupplyBudgets/.test(crewBranch));
}

if (fails.length) {
  console.log(`test-supply-budgets: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`test-supply-budgets: ${pass} passed, 0 failed`);
}
