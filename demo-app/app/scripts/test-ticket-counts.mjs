// The ticket counts behind the customers' "N tickets in 30 days" flags are read as the app opens and kept,
// so the Customers list and a customer's page draw with their flags in place and nothing moves after (CS-962).
//
// WHY. Found 2026-11-02 while measuring CS-960: the Customers list drew, and only then did each page read the
// ticket counts (useTicketFlags, after it mounted), so a customer past the flag's threshold had its red badge
// join its Status cell a moment later; a customer's page showed its badge the same moment late. Live, that
// read takes 0.74 to 0.93 seconds (three page loads, 2026-11-02). Daniel, 2026-11-02, replying "1." to "Read
// the counts when the app opens (Recommended)": the app reads the ticket counts once as it opens and keeps
// them, so the Customers list and a customer's page draw with their red flags already in place and nothing
// moves after; the counts refresh in the background, and a change shows the next time you open the page,
// never while you're on it; it looks the same as today; only a page opened in the app's first second waits
// for the counts (about 0.8 seconds).
//
//   §1  the counts (lib/ticketCountsCache.js), run on their cases with a read and a clock of their own: one
//       read at a time; a page that opens before the first read has answered waits for it, once, or draws
//       without flags after WAIT_MS; a page that opens after draws with the counts at once; a read answering
//       while a page is open changes the next page, never that one; a page open reads again at most once
//       every REFRESH_MS; a failed read keeps the last good counts, and with none nobody is flagged; another
//       person forgets the counts and a read still under way for the person before
//   §2  the hook (hooks/useTicketFlags.js): the app's one copy of the counts, made outside the hook; no read
//       of its own per page; the page's counts taken as it opens and changed only by the one wait; `ready`;
//       prefetchTicketCounts for the shell
//   §3  the pages: the Customers list draws no rows, and a customer's page nothing, until `ready`; the list's
//       empty states don't wait
//   §4  the shell: the office shell reads the counts as the app opens; a cleaner's app shows no flag and
//       doesn't
//
// The browser half, measured 2026-11-02 frame by frame as each is painted (the session's flags-frames2.mjs,
// not in CI): on the demo with its flag set at 1 ticket and the live read's 0.8 seconds given to the demo's,
// at 1280 x 800 the list on today's code drew its rows with no ticket badge and then with 5, and a flagged
// customer's page drew without its badge and then with it; with this, every frame with rows had all 5, and
// every frame of the customer's page its badge, loaded straight and opened in the app.
//
// REGRESSION (THE LAW II.3): on 9d8219c9 there is no lib/ticketCountsCache.js, useTicketFlags reads the counts
// after each page mounts and sets them whenever they answer, nothing waits and the shell reads nothing, so
// §1 to §4 fail there.
//
//   node app/scripts/test-ticket-counts.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => { try { return fs.readFileSync(path.join(APP, rel), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
// One pass, whichever comment starts first: a `/*` inside a `//` line is that line's text, never the start of a
// block. A `//` just after a colon or a quote is a URL or a string's.
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

// ── §1 the counts ─────────────────────────────────────────────────────────────────────────────

let lib = null;
try { lib = await import(pathToFileURL(path.join(APP, 'src/lib/ticketCountsCache.js')).href); } catch { lib = null; }
ok('§1 lib/ticketCountsCache.js keeps the counts (createTicketCounts, REFRESH_MS, WAIT_MS)',
  !!lib && typeof lib.createTicketCounts === 'function' && Number.isFinite(lib.REFRESH_MS) && Number.isFinite(lib.WAIT_MS));
if (lib && typeof lib.createTicketCounts === 'function') {
  const { createTicketCounts, REFRESH_MS, WAIT_MS } = lib;
  ok('§1 a page waits at most a few seconds for the first read (WAIT_MS, 1 to 5 seconds)', WAIT_MS >= 1000 && WAIT_MS <= 5000, String(WAIT_MS));
  ok('§1 a page open reads again at most once a minute or so (REFRESH_MS, 30 seconds to 5 minutes)', REFRESH_MS >= 30000 && REFRESH_MS <= 300000, String(REFRESH_MS));

  // A read the case answers when it likes, a clock and timers of its own.
  const rig = () => {
    const r = { t: 1000, reads: [], timers: new Map(), id: 0 };
    r.read = () => new Promise((resolve, reject) => { r.reads.push({ resolve, reject }); });
    r.later = (fn, ms) => { r.id += 1; r.timers.set(r.id, { fn, at: r.t + ms }); return r.id; };
    r.cancel = (id) => { r.timers.delete(id); };
    r.tick = (ms) => { r.t += ms; for (const [id, x] of [...r.timers]) if (x.at <= r.t) { r.timers.delete(id); x.fn(); } };
    r.counts = createTicketCounts({ read: r.read, now: () => r.t, later: r.later, cancel: r.cancel });
    return r;
  };
  const M1 = new Map([['cl_1', 12], ['cl_2', 3]]);
  const M2 = new Map([['cl_1', 13], ['cl_3', 10]]);

  {
    const r = rig();
    r.counts.setOwner('u1');
    const s0 = r.counts.snapshot('u1');
    ok('§1 before the first read has answered, a page is not ready and has no counts', s0.ready === false && s0.counts === null);
    let woke = 0;
    r.counts.whenSettled(() => { woke += 1; });
    r.counts.refresh();
    r.counts.refresh();
    await settle();
    ok('§1 one read at a time: a second ask while one is under way starts none', r.reads.length === 1, String(r.reads.length));
    r.reads[0].resolve(M1);
    await settle();
    const s1 = r.counts.snapshot('u1');
    ok('§1 the first read answering makes the counts ready', s1.ready === true && s1.counts === M1);
    ok('§1 …and wakes the page waiting for it, once', woke === 1, String(woke));
    r.tick(WAIT_MS + 10);
    ok('§1 …and not again when its wait would have run out', woke === 1, String(woke));
    let now = 0;
    r.counts.whenSettled(() => { now += 1; });
    ok('§1 a page that opens after draws with the counts at once', now === 1);

    r.t = 1000 + REFRESH_MS - 50; // the first read began at 1000
    r.counts.refresh();
    await settle();
    ok('§1 a page open within REFRESH_MS of the last read reads nothing', r.reads.length === 1, String(r.reads.length));
    r.t = 1000 + REFRESH_MS + 50;
    r.counts.refresh();
    await settle();
    ok('§1 …and once it has gone, reads again', r.reads.length === 2, String(r.reads.length));
    const before = r.counts.snapshot('u1');
    r.reads[1].resolve(M2);
    await settle();
    ok('§1 a read answering while a page is open changes the next page that opens', r.counts.snapshot('u1').counts === M2);
    ok('§1 …never the page already open (what it took is as it was)', before.counts === M1);

    r.tick(REFRESH_MS + 1);
    r.counts.refresh();
    await settle();
    r.reads[2].reject(new Error('offline'));
    await settle();
    const s3 = r.counts.snapshot('u1');
    ok('§1 a failed read keeps what the last good one said', s3.ready === true && s3.counts === M2);

    r.tick(REFRESH_MS + 1);
    r.counts.refresh();
    await settle();
    r.reads[3].resolve({ not: 'a map' });
    await settle();
    ok('§1 an answer that is not counts flags nobody', r.counts.snapshot('u1').counts instanceof Map && r.counts.snapshot('u1').counts.size === 0);

    ok('§1 another person\'s page is not ready with these counts', r.counts.snapshot('u2').ready === false && r.counts.snapshot('u2').counts === null);
    r.counts.setOwner('u2');
    ok('§1 another person signed in forgets them', r.counts.snapshot('u1').ready === false && r.counts.snapshot('u2').ready === false);
    r.counts.refresh();
    await settle();
    ok('§1 …and reads theirs at once, whenever the last read was', r.reads.length === 5, String(r.reads.length));
  }
  {
    const r = rig();
    r.counts.setOwner('u1');
    let woke = 0;
    r.counts.whenSettled(() => { woke += 1; });
    r.counts.refresh();
    await settle();
    r.tick(WAIT_MS - 1);
    ok('§1 a page waits for a read that hasn\'t answered…', woke === 0, String(woke));
    r.tick(2);
    ok('§1 …until WAIT_MS has gone, then draws without flags', woke === 1 && r.counts.snapshot('u1').ready === false);
    r.reads[0].resolve(M1);
    await settle();
    ok('§1 …and isn\'t woken again when the read answers late (that is for the next page)', woke === 1, String(woke));
  }
  {
    const r = rig();
    r.counts.setOwner('u1');
    let woke = 0;
    const stop = r.counts.whenSettled(() => { woke += 1; });
    r.counts.refresh();
    await settle();
    stop();
    r.reads[0].resolve(M1);
    await settle();
    r.tick(WAIT_MS + 1);
    ok('§1 a page closed while it waited is never woken', woke === 0, String(woke));
  }
  {
    const r = rig();
    r.counts.setOwner('u1');
    r.counts.refresh();
    await settle();
    r.reads[0].reject(new Error('403'));
    await settle();
    const s = r.counts.snapshot('u1');
    ok('§1 a first read that fails is an answer: ready, and nobody flagged', s.ready === true && s.counts === null);
  }
  {
    const r = rig();
    r.counts.setOwner('u1');
    r.counts.refresh();
    await settle();
    r.counts.setOwner('u2');
    r.reads[0].resolve(M1);
    await settle();
    ok('§1 a read under way for the person before never lands for the next', r.counts.snapshot('u2').ready === false && r.counts.snapshot('u2').counts === null);
  }
}

// ── §2 the hook ───────────────────────────────────────────────────────────────────────────────

const hookSrc = stripJsComments(read('src/hooks/useTicketFlags.js'));
const hookBody = (() => { const i = hookSrc.indexOf('export function useTicketFlags('); return i < 0 ? '' : hookSrc.slice(i); })();
const outside = (() => { const i = hookSrc.indexOf('export function useTicketFlags('); return i < 0 ? hookSrc : hookSrc.slice(0, i); })();
ok('§2 the app\'s one copy of the counts, made outside the hook from lib/ticketCountsCache.js',
  /import\s*\{[^}]*\bcreateTicketCounts\b[^}]*\}\s*from\s*'\.\.\/lib\/ticketCountsCache'/.test(hookSrc) && /createTicketCounts\(\{\s*read:/.test(outside));
ok('§2 …its read the counts route\'s, over the flag\'s window', /read:\s*\(\)\s*=>\s*qcApi\.ticketCounts\(\{\s*days:\s*TICKET_FLAG_DAYS\s*\}\)/.test(outside));
ok('§2 no page reads the counts itself (no qcApi.ticketCounts in the hook)', !!hookBody && !/qcApi\.ticketCounts\(/.test(hookBody));
ok('§2 the page\'s counts are taken as it opens (useState from the copy\'s snapshot)', /useState\(\(\)\s*=>\s*ticketCounts\.snapshot\(/.test(hookBody));
{
  const sets = hookBody.match(/setSeen\(/g) || [];
  const waitCall = callBody(hookBody, 'ticketCounts.whenSettled');
  ok('§2 …and changed only once, by the wait for the first read (setSeen only inside whenSettled)', sets.length === 1 && /setSeen\(/.test(waitCall), `${sets.length} setSeen`);
}
ok('§2 a page open asks for a read in the background (refresh in its effect, run once)',
  /useEffect\(\(\)\s*=>\s*\{[\s\S]*?ticketCounts\.refresh\(\)[\s\S]*?\},\s*\[\]\)/.test(hookBody));
ok('§2 it says whether the page may draw (`ready`)', /ready:\s*seen\.ready/.test(hookBody));
ok('§2 prefetchTicketCounts names the person and starts the read',
  /export function prefetchTicketCounts\(\w+\)\s*\{[\s\S]*?ticketCounts\.setOwner\([\s\S]*?ticketCounts\.refresh\(\)/.test(hookSrc));

// ── §3 the pages ──────────────────────────────────────────────────────────────────────────────

{
  const src = stripJsComments(read('src/pages/Clients.jsx'));
  // With or without the supply spend's wait beside it (CS-963, test-supply-budgets.mjs).
  const wait = src.search(/!ticketFlags\.ready(\s*\|\|\s*!supplyBudgets\.ready)?\s*\?\s*\(\s*null\s*\)/);
  const noMatches = src.indexOf('title="No matches"');
  const table = src.indexOf('className="table-wrap mobile-stack"');
  ok('§3 the Customers list draws no rows until the counts are ready', wait > -1 && table > wait, `wait at ${wait}, table at ${table}`);
  ok('§3 …and its empty states ("No customers yet", "No matches") don\'t wait', noMatches > -1 && noMatches < wait);
}
{
  const src = stripJsComments(read('src/pages/ClientDetail.jsx'));
  const hook = src.indexOf('useTicketFlags()');
  const lastHook = src.lastIndexOf('useCustomerTextStatus(');
  const notFound = src.indexOf('if (!client) {');
  const wait = src.search(/if \(!ticketFlags\.ready( \|\| !supplyBudgets\.ready)?\) return /);
  const page = src.indexOf('<div className="page-pad">\n      <DetailHeader');
  ok('§3 a customer\'s page draws nothing until the counts are ready', hook > -1 && wait > -1 && page > wait, `wait at ${wait}, page at ${page}`);
  ok('§3 …and waits after every hook and the not-found page, so the hooks run on every draw', wait > lastHook && wait > notFound && lastHook > -1 && notFound > -1);
}

// ── §4 the shell ──────────────────────────────────────────────────────────────────────────────

{
  const src = stripJsComments(read('src/layouts/AppLayout.jsx'));
  ok('§4 the office shell reads the counts as the app opens (prefetchTicketCounts from the hook)',
    /import\s*\{[^}]*\bprefetchTicketCounts\b[^}]*\}\s*from\s*'\.\.\/hooks\/useTicketFlags'/.test(src)
    && /useEffect\(\(\)\s*=>\s*\{\s*if\s*\(!crew\s*&&\s*seesTickets\)\s*prefetchTicketCounts\(/.test(src));
  ok('§4 …only for someone who may read tickets, asked on every draw (qc.view, not behind a condition)', /const seesTickets = usePermission\('qc\.view'\);/.test(src));
  const crewBranch = src.slice(src.indexOf('if (crew) {'));
  ok('§4 a cleaner\'s app reads nothing (no flag there)', src.indexOf('if (crew) {') > -1 && !/prefetchTicketCounts/.test(crewBranch));
}

if (fails.length) {
  console.log(`test-ticket-counts: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`test-ticket-counts: ${pass} passed, 0 failed`);
}
