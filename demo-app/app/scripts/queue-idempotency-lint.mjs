#!/usr/bin/env node
/**
 * queue-idempotency-lint — playbook II.7 "offline write queue" enforcer (zero-dependency).
 *
 * THE LAW (SaaSassins-Client-Build-Playbook.md II.7, and Part V's ledger entry):
 *
 *     "Offline write queue | Persisted pending queue, replayed through CAS on reconnect;
 *      idempotent actions (caller-minted ids + dedupe — BOTH halves)."
 *     "Reducer idempotency needs caller-minted ids AND dedupe — either alone is nothing."
 *
 * WHY IT IS A BUILD-FAILING SWEEP AND NOT A CODE REVIEW. `store/index.jsx` records EVERY
 * dispatched action except HYDRATE/RESET into the pending queue, and `sync.js` adoptRemote
 * replays that queue on top of an adopted remote document. If a save COMMITS server-side but
 * its response is lost, the client replays actions the remote state already contains. A
 * reducer case that mints its own id produces a NEW entity on every replay — the CleanSpace
 * failure that double-recorded payments. Today the only blanket protection is `sync.js`'s
 * `if (saving) return`, which is a scheduling window, not idempotency by construction.
 *
 * Fixing one action is not fixing the bug (Part V: four guarded/unguarded sibling pairs) —
 * hence a sweep with a frozen baseline. Existing debt is enumerated and frozen; a NEW
 * self-minting reducer case fails the build. The baseline ratchets DOWN only.
 *
 * TWO RULES:
 *   mint-without-dedupe   — a reducer case calls newId() but carries no id-existence guard
 *                           that returns state unchanged. Baselined per action.
 *   guarded-caller-mints  — for an action the baseline lists as `guarded`, EVERY dispatch
 *                           site must mint the id at the CALLER. A guarded reducer whose
 *                           caller stopped minting is a dedupe check keyed on a fresh id
 *                           every replay: the check passes, the entity duplicates, and
 *                           nothing looks wrong. This rule is what keeps a fix fixed.
 *
 * Usage:
 *   node queue-idempotency-lint.mjs [--root <dir>] [--baseline <file>]
 *                                   [--update-baseline] [--json] [--verbose]
 *
 * Exit: 0 pass / 1 new violations / 2 internal error.
 */
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.resolve(opt('--root', 'src'));
const BASELINE_FILE = path.resolve(opt('--baseline', 'queue-idempotency.baseline.json'));
const UPDATE = flag('--update-baseline');
const DETECTOR_CHANGED = opt('--detector-changed', null);
const JSON_OUT = flag('--json');
const VERBOSE = flag('--verbose');

const REDUCER = path.join(ROOT, 'store', 'reducer.js');
const STORE_INDEX = path.join(ROOT, 'store', 'index.jsx');

// ---------------------------------------------------------------------------
// Masking: blank out comment and string CONTENT so structural regexes cannot be
// fooled by prose. This is load-bearing — reducer.js documents the very shapes
// this lint looks for ("return state", ".some("), and a comment describing a
// dedupe guard must never be mistaken for one. Length and line breaks are
// preserved so every index still maps back to a real line number.
// ---------------------------------------------------------------------------
function mask(src) {
  const out = src.split('');
  const blank = (i) => { if (src[i] !== '\n') out[i] = ' '; };
  let i = 0;
  const n = src.length;
  // Template-literal nesting: each entry tracks the brace depth inside a ${ }.
  const tmpl = [];
  while (i < n) {
    const c = src[i]; const c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') { blank(i); i++; } continue; }
    if (c === '/' && c2 === '*') {
      blank(i); blank(i + 1); i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { blank(i); i++; }
      if (i < n) { blank(i); blank(i + 1); i += 2; }
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c; i++; // keep the opening quote so `newId('x')` still reads as a call
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') { blank(i); i++; if (i < n) { blank(i); i++; } continue; }
        if (src[i] === '\n') break; // unterminated — bail rather than eat the file
        blank(i); i++;
      }
      i++; continue;
    }
    if (c === '`') { tmpl.push({ depth: 0, inExpr: false }); i++; blankTemplate(); continue; }
    if (c === '}' && tmpl.length && tmpl[tmpl.length - 1].inExpr && tmpl[tmpl.length - 1].depth === 0) {
      // closing a ${ } — back to literal text
      tmpl[tmpl.length - 1].inExpr = false; i++; blankTemplate(); continue;
    }
    if (tmpl.length && tmpl[tmpl.length - 1].inExpr) {
      if (c === '{') tmpl[tmpl.length - 1].depth++;
      else if (c === '}') tmpl[tmpl.length - 1].depth--;
    }
    i++;
  }
  // Consume template literal TEXT (not its ${} expressions) from position i.
  function blankTemplate() {
    while (i < n) {
      if (src[i] === '\\') { blank(i); i++; if (i < n) { blank(i); i++; } continue; }
      if (src[i] === '`') { tmpl.pop(); i++; return; }
      if (src[i] === '$' && src[i + 1] === '{') {
        tmpl[tmpl.length - 1].inExpr = true; tmpl[tmpl.length - 1].depth = 0;
        i += 2; return; // expression content stays visible
      }
      blank(i); i++;
    }
  }
  return out.join('');
}

const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;

// ---------------------------------------------------------------------------
// Reducer scan
// ---------------------------------------------------------------------------
// Case labels sit at exactly 4 spaces of indent — one `switch` inside one
// `function`. Anything deeper is a nested switch and is deliberately out of
// scope (it belongs to whichever case encloses it).
const CASE_RE = /^ {4}case ACTIONS\.([A-Z0-9_]+):/;
const DEFAULT_RE = /^ {4}default:/;

// Dedupe shape: an `if (…)` whose condition asks whether the id already exists
// and whose consequent returns state untouched. Membership predicates only —
// shape, not a name-list.
const MEMBERSHIP = /\.(?:some|find|findIndex|includes|has)\s*\(/;

// Minting shape: an id whose VALUE comes from calling something, rather than
// from the action. `newId('q')` is the common spelling; `nextInvoiceId(state)`
// is the same defect wearing a different name, and a name-list would miss it —
// exactly the playbook's "audit by capability, not helper name" (a grep for
// `requireRole` structurally cannot find the route that rolled its own check).
// Anchors an id-valued binding: `id:`, `const fooId =`, or a bare `fooId =`.
const ID_ANCHOR = /\bid\s*:|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*[Ii]d\s*=(?!=)|\b[A-Za-z_$][\w$]*[Ii]d\s*=(?!=)/g;
// Pure transforms of a value the caller already supplied — not a mint.
const NOT_A_MINT = new Set(['String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'JSON', 'replaceById', 'removeById']);

// Every function called while producing an id value. The whole VALUE EXPRESSION
// is scanned, not just the token adjacent to `id:` — ADD_INVOICE spells its mint
// `id: action.invoice?.id || nextInvoiceId(state)`, where the mint hides behind a
// caller-id fallback and an adjacency-only match reads it as caller-supplied.
function mintersIn(body) {
  const found = new Set();
  if (/\bnewId\s*\(/.test(body)) found.add('newId'); // wherever it appears, incl. bare reassignment
  ID_ANCHOR.lastIndex = 0;
  let m;
  while ((m = ID_ANCHOR.exec(body))) {
    let i = m.index + m[0].length;
    let depth = 0; let expr = '';
    while (i < body.length) {
      const c = body[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { if (depth === 0) break; depth--; }
      else if ((c === ',' || c === ';' || c === '\n') && depth === 0) break;
      expr += c; i++;
    }
    for (const cm of expr.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (NOT_A_MINT.has(cm[1])) continue;
      // A mint is a BARE call. `.map(` builds a collection and `new Map(` builds a
      // lookup — neither produces an id. Both were false positives here, reached
      // through names like `orderById` that end in "Id" without being one.
      const before = expr.slice(Math.max(0, cm.index - 5), cm.index);
      if (/[.\w$]$/.test(before)) continue;   // method call / property access
      if (/\bnew\s+$/.test(before)) continue; // constructor
      found.add(cm[1]);
    }
  }
  return found;
}

// The action payload the minted entity is built from: `action.<key>`. Three
// spellings in this reducer — an explicit caller-id fallback, a direct spread, and
// a spread through a local alias (`const incoming = action.invoice || {}`).
function payloadKeyOf(body) {
  let m = body.match(/\baction\.([A-Za-z_$][\w$]*)\??\.id\s*\|\|/);
  if (m) return m[1];
  m = body.match(/\bid\s*:\s*[A-Za-z_$][\w$]*\s*\([^)]*\)[\s\S]{0,900}?\.\.\.\s*action\.([A-Za-z_$][\w$]*)/);
  if (m) return m[1];
  for (const am of body.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*action\.([A-Za-z_$][\w$]*)\s*(?:\|\||;)/g)) {
    if (new RegExp(`\\.\\.\\.\\s*${am[1]}\\b`).test(body)) return am[2];
  }
  return null;
}

// Balanced-brace span of `<key>: { … }` inside a dispatch body — including a payload
// built through a single helper wrapper: `payment: buildInvoicePayment({ … })`. The
// scoping still lands on the OBJECT LITERAL the entity is constructed from, so the mint
// check reads `payment.id` and not the sibling target id. Without the wrapper clause,
// `dispatch({ id: targetInvoiceId, payment: buildX({ … }) })` fell back to the whole
// dispatch and passed on the strength of `targetInvoiceId` even after `payment.id`
// stopped minting — the exact trap this scoping exists to close (PA-01 introduced the
// wrapper spelling; the test-queue-idempotency-lint probe on LogPaymentModal covers it).
function nestedObject(body, key) {
  const at = body.search(new RegExp(`\\b${key}\\s*:\\s*(?:[A-Za-z_$][\\w$]*\\s*\\()?\\s*\\{`));
  if (at < 0) return null;
  const open = body.indexOf('{', at);
  let d = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '{') d++;
    else if (body[i] === '}') { d--; if (d === 0) return body.slice(open, i + 1); }
  }
  return null;
}

function scanReducer(src) {
  const m = mask(src);
  const lines = m.split('\n');
  const rawLines = src.split('\n');

  // Collect case labels with their line numbers.
  const labels = [];
  lines.forEach((ln, i) => {
    const c = ln.match(CASE_RE);
    if (c) labels.push({ action: c[1], line: i + 1 });
    else if (DEFAULT_RE.test(ln)) labels.push({ action: null, line: i + 1 });
  });
  if (!labels.length) throw new Error(`no "case ACTIONS.*" labels found at 4-space indent in ${REDUCER}`);

  // Blocks: label → up to the next label. Empty blocks are fall-through and
  // merge forward into the next block that has a body.
  const blocks = [];
  for (let k = 0; k < labels.length; k++) {
    if (labels[k].action === null) continue; // `default:` owns no minting
    const start = labels[k].line;
    const end = (labels[k + 1] ? labels[k + 1].line : lines.length + 1) - 1;
    const body = lines.slice(start, end).join('\n'); // masked, label line excluded
    const rawBody = rawLines.slice(start, end).join('\n'); // unmasked — id PREFIXES only
    const isFallThrough = body.trim() === '';
    blocks.push({ action: labels[k].action, start, end, body, rawBody, isFallThrough });
  }
  // Merge fall-through groups: a labels-only case shares the next real body.
  for (let k = blocks.length - 1; k >= 0; k--) {
    if (!blocks[k].isFallThrough) continue;
    const owner = blocks.slice(k + 1).find((b) => !b.isFallThrough);
    if (owner) { blocks[k].body = owner.body; blocks[k].rawBody = owner.rawBody; blocks[k].end = owner.end; blocks[k].sharedWith = owner.action; }
  }

  const cases = [];
  for (const b of blocks) {
    const minters = mintersIn(b.body);
    if (!minters.size) continue;
    // Prefixes come from the RAW body: the mask blanks string CONTENT, so
    // newId('svc') reads as newId('   ') in the masked copy. Structure is decided
    // on the masked text; only this cosmetic label reads raw.
    const mints = [...b.rawBody.matchAll(/\bnewId\s*\(\s*'([a-zA-Z0-9_]*)'/g)].map((x) => x[1]);

    // ---- dedupe half: `if (<membership predicate>) return state;`
    let dedupe = false;
    const dedupeSites = [];
    for (const r of b.body.matchAll(/\breturn\s+state\s*;/g)) {
      const before = b.body.slice(Math.max(0, r.index - 400), r.index);
      const ifIdx = before.lastIndexOf('if (');
      if (ifIdx < 0) continue;
      const cond = before.slice(ifIdx);
      if (MEMBERSHIP.test(cond)) {
        dedupe = true;
        dedupeSites.push(b.start + lineOf(b.body, r.index));
      }
    }

    // ---- caller-id half: does the minted literal let a caller id win?
    // `{ id: newId('x'), …defaults, ...action.thing }` — the spread lands after
    // the id, so a caller-supplied id overwrites it. Or the explicit
    // `action.id || newId('x')` form. Support ≠ use: the callers still have to
    // mint, which is what `guarded-caller-mints` checks.
    const explicitOr = /\b(?:action|incoming)\.[A-Za-z0-9_.]*\bid\s*\|\|\s*newId\s*\(/.test(b.body);
    let spreadWins = false;
    for (const r of b.body.matchAll(/\bid\s*:\s*newId\s*\(/g)) {
      const after = b.body.slice(r.index, r.index + 900);
      const closeBrace = after.indexOf('}');
      const window = closeBrace > 0 ? after.slice(0, closeBrace) : after;
      if (/\.\.\.\s*(?:action|incoming)\b/.test(window)) spreadWins = true;
    }
    const callerIdSupported = explicitOr || spreadWins;

    // WHICH payload key carries the dedupe key. An action can hold more than one
    // id: ADD_INVOICE_PAYMENT's top-level `id` names the TARGET invoice while the
    // dedupe key is `payment.id`. A caller-side check that accepts any minted id
    // in the dispatch passes a site that stopped minting the one that matters —
    // it did, until a probe caught it. The reducer knows the answer: the minted
    // entity is whatever `action.<key>` is merged into.
    const payloadKey = payloadKeyOf(b.body);

    // ---- blast-radius metadata (triage input, never pass/fail)
    // Both orders count: the money actions PREPEND (`[quote, ...state.quotes]`) so
    // the newest sits on top, and a spread-first-only test read them as non-appending.
    const appends = /\[\s*\.\.\./.test(b.body) || /,\s*\.\.\./.test(b.body) || /\.concat\s*\(/.test(b.body);

    cases.push({
      action: b.action,
      line: b.start,
      minters: [...minters],
      mints: [...new Set(mints)],
      mintCount: (b.body.match(/\bnewId\s*\(/g) || []).length,
      dedupe,
      dedupeSites,
      callerIdSupported,
      payloadKey,
      appends,
      sharedWith: b.sharedWith || null,
    });
  }
  return { cases, totalCases: labels.filter((l) => l.action).length };
}

// ---------------------------------------------------------------------------
// Dispatch-site scan — the `guarded-caller-mints` rule.
// ---------------------------------------------------------------------------
function walk(dir, out) {
  let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.jsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

// Find the dispatch expression enclosing a `type: ACTIONS.X` hit: walk back to the
// nearest `(` that opens a call, then forward to its match.
function dispatchSpan(text, at) {
  let open = -1; let depth = 0;
  for (let i = at; i >= 0 && at - i < 2000; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') { if (depth === 0) { open = i; break; } depth--; }
  }
  if (open < 0) return null;
  let d = 0;
  for (let i = open; i < text.length && i - open < 8000; i++) {
    if (text[i] === '(') d++;
    else if (text[i] === ')') { d--; if (d === 0) return { start: open, end: i }; }
  }
  return null;
}

function scanDispatchSites(guardedActions, payloadKeys) {
  const files = walk(ROOT, []).filter((f) => path.resolve(f) !== path.resolve(REDUCER));
  const sites = [];
  for (const file of files) {
    let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const m = mask(raw);
    for (const action of guardedActions) {
      const re = new RegExp(`type\\s*:\\s*ACTIONS\\.${action}\\b`, 'g');
      let hit;
      while ((hit = re.exec(m))) {
        const span = dispatchSpan(m, hit.index);
        const whole = span ? m.slice(span.start, span.end + 1) : m.slice(hit.index, hit.index + 600);
        // Narrow to the payload the reducer actually dedupes on. Without this,
        // `dispatch({ type: X, id: targetInvoiceId, payment: { … } })` passes on the
        // strength of the TARGET id even after `payment.id` stops being minted.
        const key = payloadKeys[action];
        const scoped = key ? nestedObject(whole, key) : null;
        const body = scoped || whole;
        const scopedTo = scoped ? key : null;
        // "The caller minted it" = the id's value comes from CALLING something,
        // not from a literal and not from the reducer. Same shape rule as the
        // reducer side, and for the same reason: keying this on the name `newId`
        // missed LogInvoiceModal, which mints with the `nextInvoiceId` selector.
        let mints = mintersIn(body).size > 0;
        // Indirect form: `const invoiceId = nextInvoiceId(state); … { id: invoiceId }`.
        // Accept an `id:` bound to an identifier assigned from any bare call in the
        // 60 lines above — same guarantee, different spelling.
        if (!mints) {
          // `id: someVar` and ES6 shorthand `{ id, … }` are the same binding written
          // two ways. Orders.jsx mints into `const id` and passes the shorthand —
          // reading only the colon form called a minting site unguarded.
          // A caller may carry an id it minted EARLIER on an object it is iterating —
          // MarketingScheduler mints `sendId` in getDueSends and dispatches
          // `id: due.sendId`. That is a caller-minted id; it is simply not mintable
          // in this file. A property path counts, EXCEPT off `action`, which would
          // mean the value came from elsewhere rather than from this caller.
          const propRef = body.match(/\bid\s*:\s*([A-Za-z_$][\w$]*)\.[\w$.]+/);
          if (propRef && propRef[1] !== 'action') mints = true;
        }
        if (!mints) {
          // The colon form must be anchored to an OBJECT-KEY position (`{`/`,` before
          // `id:`) exactly as the shorthand alternative already is. An unanchored
          // `\bid\s*:` also matches a member access followed by a ternary/label colon —
          // `siteId: cond ? place.id : undefined` reads `.id :` as an id binding and
          // captures `undefined`, which then short-circuits the shorthand match and
          // sends the tracer looking for `undefined = …(` above. EntityDetail's
          // ternary-`siteId` CREATE_QUOTE dispatch mints `const id = newId('q')` and
          // passes `{ id, … }` shorthand; the unanchored form called it unguarded.
          const idRef = body.match(/[{,]\s*id\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/) || body.match(/[{,]\s*(id)\s*[,}]/);
          if (idRef) {
            const startLine = lineOf(m, span ? span.start : hit.index);
            const above = m.split('\n').slice(Math.max(0, startLine - 61), startLine).join('\n');
            const assign = new RegExp(`\\b${idRef[1]}\\s*=\\s*(?!new\\s)([A-Za-z_$][\\w$]*)\\s*\\(`);
            const am = above.match(assign);
            if (am && !NOT_A_MINT.has(am[1])) mints = true;
          }
        }
        sites.push({
          action,
          rel: path.relative(ROOT, file).split(path.sep).join('/'),
          line: lineOf(m, hit.index),
          mints,
          scopedTo,
        });
      }
    }
  }
  return sites;
}

// ---------------------------------------------------------------------------
// The queue predicate — the premise this whole lint rests on. If store/index.jsx
// stops queueing every action, or starts exempting more than HYDRATE/RESET, the
// blast radius changes and this baseline is describing a world that moved.
// ---------------------------------------------------------------------------
function checkQueuePredicate() {
  let raw; try { raw = fs.readFileSync(STORE_INDEX, 'utf8'); } catch { return { ok: false, why: 'store/index.jsx unreadable' }; }
  const m = mask(raw);
  const q = m.match(/if\s*\(\s*authed[^)]*?ACTIONS\.HYDRATE[^)]*?ACTIONS\.RESET[^)]*?\)\s*\{?\s*\n?\s*pendingRef\.current\.push/);
  if (!q) return { ok: false, why: 'the pending-queue predicate in store/index.jsx no longer matches "queue everything except HYDRATE/RESET" — re-read it and re-scope this lint' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
function main() {
  let src; try { src = fs.readFileSync(REDUCER, 'utf8'); } catch (e) { throw new Error(`cannot read ${REDUCER}: ${e.message}`); }
  const { cases, totalCases } = scanReducer(src);

  const premise = checkQueuePredicate();

  let baseline = { version: 1, minting: {}, guarded: [] };
  if (fs.existsSync(BASELINE_FILE)) { try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')); } catch {} }
  const baseMint = baseline.minting || {};
  const guardedActions = baseline.guarded || [];

  const undeduped = cases.filter((c) => !c.dedupe);
  const deduped = cases.filter((c) => c.dedupe);

  // --- rule 1: mint-without-dedupe, measured against the frozen baseline
  const newFindings = undeduped.filter((c) => !(c.action in baseMint));
  const fixed = Object.keys(baseMint).filter((a) => {
    const cur = cases.find((c) => c.action === a);
    return !cur || cur.dedupe; // gone, or grew the guard
  });

  // --- rule 2: every dispatch site of a guarded action mints at the caller
  const payloadKeys = {};
  for (const c of cases) if (c.payloadKey) payloadKeys[c.action] = c.payloadKey;
  const sites = guardedActions.length ? scanDispatchSites(guardedActions, payloadKeys) : [];
  const unmintedSites = sites.filter((s) => !s.mints);
  const guardedWithoutReducerCheck = guardedActions.filter((a) => {
    const cur = cases.find((c) => c.action === a);
    return !cur || !cur.dedupe; // declared guarded but the reducer half vanished
  });
  const guardedWithNoSites = guardedActions.filter((a) => !sites.some((s) => s.action === a));

  if (UPDATE) {
    const raised = fs.existsSync(BASELINE_FILE)
      ? newFindings.map((c) => `${c.action} (reducer.js:${c.line})`)
      : [];
    // The ratchet cannot tell "the code got worse" from "the detector got sharper",
    // and both raise the count. So raising is possible ONLY by declaring which one
    // it was, in writing, into the baseline file. A plain --update-baseline still
    // refuses — otherwise the one flag that makes regressions visible becomes the
    // flag people reach for to silence them.
    if (raised.length && !DETECTOR_CHANGED) {
      console.error('Refusing to RAISE the baseline (it only ratchets down). Add the dedupe guard first:\n  ' + raised.join('\n  '));
      console.error('\nIf the DETECTOR changed and these are newly-visible pre-existing cases, re-run with:');
      console.error('  --detector-changed "<what changed and why these were invisible before>"');
      process.exit(1);
    }
    if (raised.length && DETECTOR_CHANGED) {
      console.log(`Baseline RAISED by ${raised.length} newly-visible case(s) — declared detector change:\n  ${DETECTOR_CHANGED}`);
      raised.forEach((r) => console.log(`  + ${r}`));
    }
    const minting = {};
    for (const c of undeduped.sort((a, b) => a.line - b.line)) {
      minting[c.action] = {
        line: c.line,
        minters: c.minters,
        mints: c.mints,
        callerIdSupported: c.callerIdSupported,
        appends: c.appends,
        tier: (baseMint[c.action] && baseMint[c.action].tier) || 'untriaged',
      };
    }
    const detectorChanges = baseline.detectorChanges || [];
    if (raised.length && DETECTOR_CHANGED) {
      detectorChanges.push({ at: new Date().toISOString(), added: raised, why: DETECTOR_CHANGED });
    }
    const out = {
      version: 1,
      generatedAt: new Date().toISOString(),
      note: 'Frozen enumeration of reducer cases that mint their own id without a dedupe guard (playbook II.7). Ratchets DOWN only: remove an entry by adding the guard + caller minting, never by re-running --update-baseline on a regression. Raising requires --detector-changed with a written reason, logged below.',
      totals: { reducerCases: totalCases, minting: cases.length, undeduped: undeduped.length, deduped: deduped.length },
      detectorChanges,
      guarded: guardedActions,
      minting,
    };
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(out, null, 2) + '\n');
    console.log(`Baseline written: ${undeduped.length} undeduped minting case(s) frozen · ${deduped.length} deduped · ${guardedActions.length} guarded action(s)`);
    process.exit(0);
  }

  const fail = newFindings.length || unmintedSites.length || guardedWithoutReducerCheck.length || guardedWithNoSites.length || !premise.ok;

  if (JSON_OUT) {
    console.log(JSON.stringify({
      pass: !fail,
      premise,
      totals: { reducerCases: totalCases, minting: cases.length, undeduped: undeduped.length, deduped: deduped.length },
      newFindings, unmintedSites, guardedWithoutReducerCheck, guardedWithNoSites, fixed,
      cases: VERBOSE ? cases : undefined,
      sites: VERBOSE ? sites : undefined,
    }, null, 2));
    process.exit(fail ? 1 : 0);
  }

  console.log(`queue-idempotency-lint — playbook II.7 · ${totalCases} reducer cases · ${cases.length} mint an id · ${deduped.length} guarded · ${undeduped.length} unguarded (baseline ${Object.keys(baseMint).length})`);

  if (!premise.ok) {
    console.log(`\n✖ PREMISE BROKEN: ${premise.why}`);
  }
  if (newFindings.length) {
    console.log('\nNEW self-minting reducer case(s) with no dedupe guard (above baseline):');
    for (const c of newFindings) {
      const how = c.mints.length ? c.mints.map((p) => `newId('${p}')`).join(', ') : c.minters.map((f) => `${f}()`).join(', ');
      console.log(`  store/reducer.js:${c.line}  ACTIONS.${c.action} — mints ${how}`);
      console.log(`      every replay of this action through sync.js adoptRemote invents a new entity.`);
      console.log(`      Fix BOTH halves (see ADD_INVOICE_PAYMENT, store/reducer.js): add an id-existence`);
      console.log(`      guard that returns state, AND mint the id at every dispatch site.`);
    }
  }
  if (guardedWithoutReducerCheck.length) {
    console.log('\nGUARDED action(s) whose reducer dedupe check is GONE:');
    guardedWithoutReducerCheck.forEach((a) => console.log(`  ACTIONS.${a} — baseline says both halves; the reducer half no longer matches.`));
  }
  if (guardedWithNoSites.length) {
    console.log('\nGUARDED action(s) with no dispatch site found:');
    guardedWithNoSites.forEach((a) => console.log(`  ACTIONS.${a} — the callers this rule protects have vanished or been renamed; re-verify, do not silently drop.`));
  }
  if (unmintedSites.length) {
    console.log('\nDispatch site(s) of a GUARDED action that do NOT mint the id at the caller:');
    for (const s of unmintedSites) {
      console.log(`  ${s.rel}:${s.line}  ACTIONS.${s.action}`);
      console.log(`      the reducer's dedupe check is keyed on the id — without a caller-minted one it`);
      console.log(`      compares a fresh id every replay and silently never matches.`);
    }
  }
  if (VERBOSE) {
    console.log('\nAll minting cases:');
    for (const c of cases.sort((a, b) => a.line - b.line)) {
      const tier = (baseMint[c.action] && baseMint[c.action].tier) || (c.dedupe ? 'guarded' : 'untriaged');
      console.log(`  ${String(c.line).padStart(4)}  ${c.dedupe ? '✓' : ' '} ${c.action.padEnd(34)} ${c.mints.map((p) => `'${p}'`).join(',').padEnd(18)} callerId:${c.callerIdSupported ? 'yes' : 'NO '} tier:${tier}`);
    }
    if (sites.length) {
      console.log('\nDispatch sites of guarded actions:');
      sites.forEach((s) => console.log(`  ${s.mints ? '✓' : '✖'} ${s.rel}:${s.line}  ${s.action}`));
    }
  }
  if (fixed.length) console.log(`\nratchet available (run --update-baseline): ${fixed.length} baselined case(s) now guarded — ${fixed.join(', ')}`);

  if (fail) {
    const n = newFindings.length + unmintedSites.length + guardedWithoutReducerCheck.length + guardedWithNoSites.length;
    console.log(`\n${n} finding(s) — FAIL`);
  } else {
    console.log('\nNo new findings. ✓');
  }
  process.exit(fail ? 1 : 0);
}

try { main(); } catch (e) { console.error('queue-idempotency-lint internal error:', e.message); process.exit(2); }
