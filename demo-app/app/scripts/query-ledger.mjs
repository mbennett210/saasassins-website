#!/usr/bin/env node
// query-ledger.mjs — the P0 query-site ledger (DEV_PLAYBOOK 2.0 / P0 step 5). Offline, read-only.
//
// It lists every Supabase data call in app/api and app/src — .from( (table), storage.from(
// (bucket), .rpc( (function) and .channel( (topic) — and for each records file:line, the
// table/bucket/function, the verb, the client (service-role vs user JWT, resolved PER FILE),
// and whether an .order, a .range/.limit and an organization_id filter are present. P3, P4
// and P7 classify the rows later. It writes docs/playbook/QUERY_LEDGER.md.
//
//   node scripts/query-ledger.mjs            # dry run: print the counts, write nothing
//   node scripts/query-ledger.mjs --write    # (re)generate the ledger
//   node scripts/query-ledger.mjs --out <p>  # write target (default docs/playbook/QUERY_LEDGER.md)
//
// STATIC ANALYSIS, best-effort by design (2.0: "resolve where you statically can and mark
// the rest"): comments/strings are masked; module-level `const T = 'literal'` table names are
// resolved; a variable-named table (e.g. app/api/_lib/time/* `db.from(TABLE)`) resolves when
// TABLE is such a const, else is marked <dynamic:…>. Flags are read from the fluent chain AND
// from a builder captured into a variable and extended (paged reads: `let q = …; q = q.range()`).
// The ledger is a SHARED record the orchestrator commits; this script only builds it.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const LEDGER_REL = 'docs/playbook/QUERY_LEDGER.md';
const SCOPES = ['app/api', 'app/src'];
const CODE_EXT = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx']);

// Fallback client class by bare name, used only when a per-file assignment/import didn't
// resolve the token. The per-file map (resolveClients) always wins.
const FALLBACK_CLIENT = {
  getSupabase: 'service-role', getServiceSupabase: 'service-role', createServiceClient: 'service-role',
  db: 'service-role', sb: 'service-role', service: 'service-role', admin: 'service-role',
  supabase: 'user-jwt', supabaseRead: 'user-jwt', supabaseReadOnly: 'user-jwt',
  anonClient: 'user-jwt', getAnonSupabase: 'user-jwt',
};
const NON_SUPABASE_FROM = new Set(['Array', 'Buffer', 'Object', 'Date', 'Set', 'Map']);

// Mark every character that lies inside a // or /* */ comment (so a call in a comment is
// skipped). Strings are tracked only to avoid mistaking a // inside a string for a comment.
export function commentMask(src) {
  const mask = new Uint8Array(src.length);
  let state = 'code';
  for (let i = 0; i < src.length;) {
    const c = src[i]; const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { mask[i] = mask[i + 1] = 1; state = 'line'; i += 2; continue; }
      if (c === '/' && c2 === '*') { mask[i] = mask[i + 1] = 1; state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'sq'; i += 1; continue; }
      if (c === '"') { state = 'dq'; i += 1; continue; }
      if (c === '`') { state = 'tpl'; i += 1; continue; }
      i += 1; continue;
    }
    if (state === 'line') { if (c === '\n') { state = 'code'; i += 1; continue; } mask[i] = 1; i += 1; continue; }
    if (state === 'block') { mask[i] = 1; if (c === '*' && c2 === '/') { mask[i + 1] = 1; state = 'code'; i += 2; continue; } i += 1; continue; }
    if (state === 'sq') { if (c === '\\') { i += 2; continue; } if (c === "'") state = 'code'; i += 1; continue; }
    if (state === 'dq') { if (c === '\\') { i += 2; continue; } if (c === '"') state = 'code'; i += 1; continue; }
    if (state === 'tpl') { if (c === '\\') { i += 2; continue; } if (c === '`') state = 'code'; i += 1; continue; }
  }
  return mask;
}

// Module-level `const/let/var X = 'literal'` (no ${…}) → Map(name → value). Used to resolve
// a variable table name like `const TABLE = 'time_entries'; db.from(TABLE)`.
export function resolveConsts(src) {
  const m = new Map();
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
  let x;
  while ((x = re.exec(src))) if (!x[3].includes('${')) m.set(x[1], x[3]);
  // one-hop in-file aliases: `const BUCKET = SIGNATURE_BUCKET;` where the RHS is a known
  // literal const. A couple of passes settles the short chains this codebase uses.
  const alias = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*;/g;
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false; alias.lastIndex = 0;
    while ((x = alias.exec(src))) if (!m.has(x[1]) && m.has(x[2])) { m.set(x[1], m.get(x[2])); changed = true; }
    if (!changed) break;
  }
  return m;
}

// Per-file client class map: Map(varName → 'service-role' | 'user-jwt').
export function resolveClients(src) {
  const m = new Map();
  let x;
  const imp = /import\s*{([^}]*)}\s*from\s*['"][^'"]*supabaseClient[^'"]*['"]/g;
  while ((x = imp.exec(src))) {
    for (const raw of x[1].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop();
      if (name) m.set(name, 'user-jwt');
    }
  }
  const svc = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:getSupabase|getServiceSupabase|createServiceClient)\s*\(/g;
  while ((x = svc.exec(src))) m.set(x[1], 'service-role');
  const cc = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*createClient\s*\(([^;]*)\)/g;
  while ((x = cc.exec(src))) {
    if (/SERVICE_ROLE/.test(x[2])) m.set(x[1], 'service-role');
    else if (/anon|ANON|publishable/.test(x[2])) m.set(x[1], 'user-jwt');
  }
  return m;
}

const classify = (token, clients) => clients.get(token) || FALLBACK_CLIENT[token] || 'unresolved';

// The receiver expression immediately before a `.` at dotIdx.
function receiverBefore(src, dotIdx) {
  let j = dotIdx - 1;
  while (j >= 0 && (/\s/.test(src[j]) || src[j] === '?')) j -= 1; // skip ws + optional-chaining ?
  if (j < 0) return null;
  const c = src[j];
  if (c === ')') {
    let depth = 0; let k = j;
    for (; k >= 0; k -= 1) { const ch = src[k]; if (ch === ')') depth += 1; else if (ch === '(') { depth -= 1; if (depth === 0) break; } }
    let e = k - 1; while (e >= 0 && /\s/.test(src[e])) e -= 1;
    let s = e; while (s >= 0 && /[\w$]/.test(src[s])) s -= 1;
    return { kind: 'call', callee: src.slice(s + 1, e + 1) };
  }
  if (/[\w$]/.test(c)) {
    let s = j; while (s >= 0 && /[\w$]/.test(src[s])) s -= 1;
    return { kind: 'id', token: src.slice(s + 1, j + 1), prevDot: src[s] === '.' ? s : -1 };
  }
  return { kind: 'other' };
}

function clientBefore(src, dotIdx, clients) {
  const r = receiverBefore(src, dotIdx);
  if (!r) return { client: 'unresolved', storage: false };
  if (r.kind === 'call') return { client: classify(r.callee, clients), storage: false };
  if (r.kind === 'id') {
    if (r.token === 'storage' && r.prevDot >= 0) return { ...clientBefore(src, r.prevDot, clients), storage: true };
    return { client: classify(r.token, clients), storage: false, token: r.token };
  }
  return { client: 'unresolved', storage: false };
}

function firstArg(src, openIdx) {
  let i = openIdx + 1; let depth = 0;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  const start = i;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth -= 1; }
    else if (c === ',' && depth === 0) break;
  }
  return src.slice(start, i).trim();
}

function argName(raw, consts) {
  const s = (raw || '').trim();
  if (!s) return '<dynamic:>';
  const str = /^(['"`])((?:\\.|(?!\1).)*)\1$/.exec(s);
  if (str && !str[2].includes('${')) return str[2];
  if (/^[A-Za-z_$][\w$]*$/.test(s) && consts.has(s)) return consts.get(s);
  return `<dynamic:${s.replace(/\s+/g, ' ').slice(0, 48)}>`;
}

// The statement text from a call, forward to its terminating ; (depth-aware), extended to
// include a captured builder variable's later calls (paged-read reassignment).
function stmtWindow(src, fromIdx) {
  let depth = 0; let i = fromIdx;
  for (; i < src.length; i += 1) {
    const c = src[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) depth -= 1;
    else if (c === ';' && depth <= 0) { i += 1; break; }
    if (i - fromIdx > 8000) break;
  }
  let win = src.slice(fromIdx, i);
  const stmtStart = Math.max(src.lastIndexOf(';', fromIdx), src.lastIndexOf('{', fromIdx), src.lastIndexOf('\n', fromIdx)) + 1;
  const prefix = src.slice(stmtStart, fromIdx);
  const am = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(prefix);
  const varName = am ? am[1] : null;
  if (varName) {
    const vb = `\\b${varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`;
    const useRe = new RegExp(vb);
    const consumeRe = new RegExp(`(?:await|return|=\\s*await)\\s+[^;]*${vb}`);
    const lines = src.slice(i).split(/\r?\n/);
    for (let li = 0; li < lines.length && li < 60; li += 1) {
      const ln = lines[li];
      if (ln.trim() === '}') break;
      if (useRe.test(ln)) { win += `\n${ln}`; if (consumeRe.test(ln)) break; }
    }
  }
  return win;
}

const lineOf = (src, idx) => { let n = 1; for (let i = 0; i < idx; i += 1) if (src[i] === '\n') n += 1; return n; };

function firstMatch(win, re) { const m = re.exec(win); return m ? m[1] : null; }

// Parse one file's source into call records.
export function parseFile(relPath, content) {
  const src = content;
  const mask = commentMask(src);
  const consts = resolveConsts(src);
  const clients = resolveClients(src);
  const records = [];
  const RE = /\.(from|rpc|channel)\s*\(/g;
  let m;
  while ((m = RE.exec(src))) {
    const dotIdx = m.index;
    if (mask[dotIdx]) continue;
    const method = m[1];
    const openParen = m.index + m[0].length - 1;

    let kind; let client;
    if (method === 'from') {
      const recv = receiverBefore(src, dotIdx);
      if (recv && recv.kind === 'id' && NON_SUPABASE_FROM.has(recv.token)) continue; // Array.from / Buffer.from
      const c = clientBefore(src, dotIdx, clients);
      kind = c.storage ? 'storage' : 'from';
      client = c.client;
    } else if (method === 'rpc') {
      kind = 'rpc';
      client = clientBefore(src, dotIdx, clients).client;
    } else {
      kind = 'channel';
      client = clientBefore(src, dotIdx, clients).client;
    }

    const name = argName(firstArg(src, openParen), consts);
    const win = stmtWindow(src, m.index);
    let verb;
    if (kind === 'rpc') verb = 'rpc';
    else if (kind === 'channel') verb = 'subscribe';
    else if (kind === 'storage') verb = firstMatch(win, /\.(upload|download|remove|createSignedUrls?|getPublicUrl|list|move|copy|update|info|exists)\s*\(/) || 'storage';
    else {
      const mut = /\.(delete|upsert|update|insert)\s*\(/.exec(win);
      verb = mut ? mut[1] : 'select';
    }
    const order = /\.order\s*\(/.test(win);
    const rangeLimit = /\.(range|limit)\s*\(/.test(win);
    const orgFilter = kind === 'rpc'
      ? /(organization_id|\bp_org\b|\borg\b\s*:)/.test(win)
      : /organization_id/.test(win);

    records.push({ file: relPath, line: lineOf(src, dotIdx), kind, name, verb, client, order, rangeLimit, orgFilter });
  }
  return records;
}

function gitFiles() {
  const out = execFileSync('git', ['ls-files', '--', ...SCOPES], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\n').map((s) => s.trim()).filter(Boolean).filter((p) => {
    const dot = p.lastIndexOf('.');
    return dot >= 0 && CODE_EXT.has(p.slice(dot + 1));
  });
}

const esc = (s) => String(s).replace(/\|/g, '\\|');
const yn = (b) => (b ? 'yes' : 'no');

function renderLedger(records, stamp) {
  const cols = ['File:Line', 'Kind', 'Name', 'Verb', 'Client', '.order', '.range/.limit', 'org filter'];
  const head = [
    '# Query ledger (DEV_PLAYBOOK P0 step 5)',
    '',
    '> GENERATED by `app/scripts/query-ledger.mjs`. Every `.from(` / `storage.from(` / `.rpc(` /',
    '> `.channel(` call in app/api and app/src, with its table/bucket/function, verb, client',
    '> (service-role vs user JWT, resolved per file) and whether an order, a range/limit and an',
    '> organization_id filter are present. P3, P4 and P7 classify these rows.',
    '',
    stamp ? `_At \`${stamp}\`: ${records.length} query sites._` : '',
    '',
    `| ${cols.join(' | ')} |`,
    `|${cols.map(() => '---').join('|')}|`,
  ].filter((l) => l !== '');
  const body = records.map((r) => `| ${esc(r.file)}:${r.line} | ${r.kind} | ${esc(r.name)} | ${r.verb} | ${r.client} | ${yn(r.order)} | ${yn(r.rangeLimit)} | ${yn(r.orgFilter)} |`);
  return `${head.join('\n')}\n${body.join('\n')}\n`;
}

function main(argv) {
  const args = argv.slice(2);
  const write = args.includes('--write');
  const outIdx = args.indexOf('--out');
  const outRel = outIdx >= 0 ? args[outIdx + 1] : LEDGER_REL;
  const outAbs = path.isAbsolute(outRel) ? outRel : path.join(ROOT, outRel);

  const records = [];
  for (const f of gitFiles()) {
    try { records.push(...parseFile(f, readFileSync(path.join(ROOT, f), 'utf8'))); } catch { /* unreadable → skip */ }
  }
  records.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));

  const byKind = {}; const byClient = {}; const byScope = { 'app/api': 0, 'app/src': 0 };
  let noOrg = 0; let noOrder = 0; let dynamic = 0;
  for (const r of records) {
    byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    byClient[r.client] = (byClient[r.client] || 0) + 1;
    byScope[r.file.startsWith('app/api') ? 'app/api' : 'app/src'] += 1;
    if ((r.kind === 'from' || r.kind === 'rpc') && !r.orgFilter) noOrg += 1;
    if (r.kind === 'from' && r.verb === 'select' && !r.order) noOrder += 1;
    if (/^<dynamic:/.test(r.name)) dynamic += 1;
  }

  const stamp = (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return 'HEAD'; } })();
  console.log(`query-ledger @ ${stamp}`);
  console.log(`  total query sites: ${records.length}   (app/api ${byScope['app/api']}, app/src ${byScope['app/src']})`);
  console.log(`  by kind:   ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`  by client: ${Object.entries(byClient).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`  from/rpc sites without an organization_id filter: ${noOrg}`);
  console.log(`  from-select reads without an .order: ${noOrder}`);
  console.log(`  dynamic (unresolved) table/name expressions: ${dynamic}`);

  if (write) {
    writeFileSync(outAbs, renderLedger(records, stamp));
    console.log(`  wrote ${outRel}: ${records.length} rows.`);
  } else {
    console.log('  (dry run — pass --write to (re)generate the ledger)');
  }
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main(process.argv);
