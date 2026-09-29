// app/scripts/register-rebaseline.mjs
// P0 re-baseline enumerator (DEV_PLAYBOOK Part 2 P0 step 1; Part 0.7 rules 1 and 9).
// Mechanically partitions every docs/playbook/FINDINGS_REGISTER.md entry by whether a file it
// cites changed between a base and a head commit, so re-verification coverage comes from an
// enumerator whose counts reconcile, never from judgment about which findings "look" affected.
// Offline and read-only: reads the register and git; writes only the --json file you name.
//
//   node app/scripts/register-rebaseline.mjs --base <sha> [--head <ref>] [--check] [--list] [--json <out>]
//
//   T  touched     a cited path changed in base..head          -> re-verify in full
//   U  untouched   cited paths resolve, none changed            -> carry forward "C @head (code same)", spot-check
//   N  no path     no cited token resolves to a tracked path    -> re-verify in full
//   T entries are split by how the change was matched: exact path, a unique suffix (e.g. `api/x.js`
//   for `app/api/x.js`), or only through an ambiguous basename / directory / glob (weakest).
//   --check exits 1 when INDEX rows and entry blocks disagree (missing / extra / duplicate IDs) or
//   T + U + N != the number of entries.
//   --dispatch [max] prints the fan-out lists (Part 0.7 rule 2), all derived mechanically:
//     T and N each sorted by register Area (SEC, DATA, OPS, …) then ID, cut into near-equal groups of <= max (default 16);
//     U-absence: U entries whose title claims an absence ("no", "never", "not", "missing", "untested",
//       "omits", "nothing", …) — new files can close these without touching the cited paths;
//     U-sample: a seeded ~10% sample of U (sha256(id + head) % 10 === 0) to validate "code same".
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(name);

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const ROOT = git('rev-parse', '--show-toplevel').trim();
const REGISTER = opt('--register', join(ROOT, 'docs', 'playbook', 'FINDINGS_REGISTER.md'));
const BASE = opt('--base');
const HEAD = opt('--head', 'HEAD');
if (!BASE) {
  console.error('usage: register-rebaseline.mjs --base <sha> [--head <ref>] [--check] [--list] [--json <out>]');
  process.exit(2);
}
const baseSha = git('rev-parse', '--verify', `${BASE}^{commit}`).trim();
const headSha = git('rev-parse', '--verify', `${HEAD}^{commit}`).trim();

// ---- the register -------------------------------------------------------------------------
const text = readFileSync(REGISTER, 'utf8').replace(/\r\n/g, '\n');

// INDEX rows: | [CS-001](#cs-001) | Critical | SEC | title | P1 | V | verified |
const INDEX_ROW = /^\| \[(CS-\d{3})\]\([^)]*\) \| (\w+) \| (\w+) \| (.*) \| (P\d+) \| (\w) \| ([^|]+?) \|$/gm;
const index = new Map();
const indexDupes = [];
for (const m of text.matchAll(INDEX_ROW)) {
  const [, id, sev, area, title, phase, ev, status] = m;
  if (index.has(id)) indexDupes.push(id);
  index.set(id, { id, sev, area, title: title.trim(), phase, ev, status: status.trim() });
}

// Entry blocks: '### CS-### · …' up to the next '### ' or '## ' heading.
const lines = text.split('\n');
const blocks = new Map();
const blockDupes = [];
for (let i = 0; i < lines.length; i++) {
  const h = /^### (CS-\d{3}) · /.exec(lines[i]);
  if (!h) continue;
  let j = i + 1;
  while (j < lines.length && !/^#{2,3} /.test(lines[j])) j++;
  if (blocks.has(h[1])) blockDupes.push(h[1]);
  blocks.set(h[1], lines.slice(i, j).join('\n'));
  i = j - 1;
}

// ---- tracked files and the change set ------------------------------------------------------
const lsTree = (sha) => git('ls-tree', '-r', '--name-only', sha).split('\n').filter(Boolean);
const universe = [...new Set([...lsTree(baseSha), ...lsTree(headSha)])].sort();
const universeSet = new Set(universe);

const changed = new Set();
for (const ln of git('diff', '--name-status', '-M', baseSha, headSha).split('\n').filter(Boolean)) {
  const parts = ln.split('\t');
  for (const p of parts.slice(1)) changed.add(p); // a rename marks both the old and the new path
}

// commit -> files, oldest first
const commits = [];
{
  const log = git('log', '--reverse', '--format=@@%h%x09%s', '--name-only', `${baseSha}..${headSha}`);
  let cur = null;
  for (const ln of log.split('\n')) {
    if (ln.startsWith('@@')) {
      const [sha, ...subj] = ln.slice(2).split('\t');
      cur = { sha, subject: subj.join('\t'), files: new Set() };
      commits.push(cur);
    } else if (ln.trim() && cur) cur.files.add(ln.trim());
  }
}

// ---- cited-path resolution -----------------------------------------------------------------
const PATHISH = /^[A-Za-z0-9_.@\-/[\]{},*]+$/;
const EXT = /\.(m?js|jsx|cjs|ts|tsx|css|sql|json|md|toml|ya?ml|html|txt|sh)$/i;

function expandBraces(tok) {
  const m = /^(.*?)\{([^{}]*)\}(.*)$/.exec(tok);
  if (!m) return [tok];
  return m[2].split(',').flatMap((alt) => expandBraces(m[1] + alt + m[3]));
}

function candidates(body) {
  const out = new Set();
  for (const bt of body.matchAll(/`([^`\n]+)`/g)) {
    for (let w of bt[1].split(/\s+/)) {
      w = w.replace(/^["'(<]+|["'),;>]+$/g, '');
      w = w.replace(/:\d[\d,\-–]*.*$/, '').replace(/#.*$/, '').replace(/^\.\//, '').replace(/\/$/, '/');
      if (!w || !PATHISH.test(w)) continue;
      if (!w.includes('/') && !EXT.test(w)) continue; // a bare word, not a path
      if (/^https?:|^\/\/|^\.\.\//.test(w)) continue;
      for (const e of expandBraces(w)) out.add(e);
    }
  }
  return [...out];
}

// token -> { kind: exact|suffix|ambiguous|dir|glob|none, paths: [...] }
function resolveToken(tok) {
  if (tok.includes('*')) {
    const re = new RegExp('(^|/)' + tok.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*') + '$');
    const paths = universe.filter((f) => re.test(f));
    return { kind: paths.length ? 'glob' : 'none', paths };
  }
  if (tok.endsWith('/')) {
    const paths = universe.filter((f) => f.startsWith(tok) || f.includes('/' + tok));
    return { kind: paths.length ? 'dir' : 'none', paths };
  }
  if (universeSet.has(tok)) return { kind: 'exact', paths: [tok] };
  const suffix = universe.filter((f) => f.endsWith('/' + tok));
  if (suffix.length === 1) return { kind: 'suffix', paths: suffix };
  if (suffix.length > 1) return { kind: 'ambiguous', paths: suffix };
  const asDir = universe.filter((f) => f.startsWith(tok + '/'));
  if (asDir.length) return { kind: 'dir', paths: asDir };
  return { kind: 'none', paths: [] };
}

const STRENGTH = { exact: 3, suffix: 2, ambiguous: 1, dir: 1, glob: 1 };
const entries = [];
for (const [id, body] of blocks) {
  const cited = new Map(); // path -> strongest kind that cited it
  for (const tok of candidates(body)) {
    const r = resolveToken(tok);
    for (const p of r.paths) {
      const prev = cited.get(p);
      if (!prev || STRENGTH[r.kind] > STRENGTH[prev]) cited.set(p, r.kind);
    }
  }
  const hits = [...cited].filter(([p]) => changed.has(p));
  const best = hits.reduce((b, [, k]) => Math.max(b, STRENGTH[k]), 0);
  const partition = cited.size === 0 ? 'N' : hits.length ? 'T' : 'U';
  const match = partition !== 'T' ? null : best === 3 ? 'exact' : best === 2 ? 'suffix' : 'weak';
  const touchCommits = partition === 'T'
    ? commits.filter((c) => hits.some(([p]) => c.files.has(p))).map((c) => c.sha)
    : [];
  const meta = index.get(id) || { sev: '?', area: '?', phase: '?', ev: '?', status: '?', title: '' };
  entries.push({
    id, sev: meta.sev, area: meta.area, phase: meta.phase, evidence: meta.ev, status: meta.status,
    partition, match, citedCount: cited.size,
    changedPaths: hits.map(([p, k]) => ({ path: p, via: k })), commits: touchCommits,
  });
}
entries.sort((a, b) => a.id.localeCompare(b.id));

// ---- reconcile + report --------------------------------------------------------------------
const idsIndex = [...index.keys()];
const idsBlocks = [...blocks.keys()];
const missingBlock = idsIndex.filter((id) => !blocks.has(id));
const missingIndex = idsBlocks.filter((id) => !index.has(id));
const count = (pred) => entries.filter(pred).length;
const T = count((e) => e.partition === 'T');
const U = count((e) => e.partition === 'U');
const N = count((e) => e.partition === 'N');
const SEVS = ['Critical', 'High', 'Medium', 'Low'];
const bySev = (part) => SEVS.map((s) => `${s} ${count((e) => e.partition === part && e.sev === s)}`).join(' · ');

console.log(`register-rebaseline  base ${baseSha.slice(0, 7)}  head ${headSha.slice(0, 7)}  register ${relative(ROOT, REGISTER).replace(/\\/g, '/')}`);
console.log(`commits ${commits.length} · files changed ${changed.size} · tracked universe ${universe.length}`);
console.log(`INDEX rows ${idsIndex.length} · entry blocks ${idsBlocks.length}`);
console.log(`T touched   ${String(T).padStart(3)}  (${bySev('T')})  match: exact ${count((e) => e.match === 'exact')}, suffix ${count((e) => e.match === 'suffix')}, weak ${count((e) => e.match === 'weak')}`);
console.log(`U untouched ${String(U).padStart(3)}  (${bySev('U')})`);
console.log(`N no path   ${String(N).padStart(3)}  (${bySev('N')})`);
console.log(`T + U + N = ${T + U + N}`);

if (flag('--list')) {
  for (const part of ['T', 'U', 'N']) {
    console.log(`\n${part}: ${entries.filter((e) => e.partition === part).map((e) => e.id).join(' ')}`);
  }
}

if (flag('--dispatch')) {
  const maxRaw = Number(opt('--dispatch'));
  const max = Number.isInteger(maxRaw) && maxRaw > 0 ? maxRaw : 16;
  const AREAS = ['SEC', 'DATA', 'OPS', 'INT', 'FUNC', 'UX', 'PERF', 'TEST', 'DOC', 'SCOPE'];
  const chunk = (ids) => {
    const n = Math.ceil(ids.length / max);
    const size = Math.ceil(ids.length / n);
    return Array.from({ length: n }, (_, k) => ids.slice(k * size, (k + 1) * size)).filter((g) => g.length);
  };
  // Sort by Area (register order), then ID, and cut the whole partition into near-equal chunks, so
  // related findings share an agent without leaving a tail of tiny single-area groups.
  const areaRank = (a) => (AREAS.includes(a) ? AREAS.indexOf(a) : AREAS.length);
  const groups = (part) => {
    const sorted = entries
      .filter((e) => e.partition === part)
      .sort((a, b) => areaRank(a.area) - areaRank(b.area) || a.id.localeCompare(b.id));
    return chunk(sorted.map((e) => e.id)).map((ids) => ({
      area: [...new Set(ids.map((id) => entries.find((e) => e.id === id).area))].join('+'),
      ids,
    }));
  };
  const ABSENCE = /\b(no|never|not|missing|untested|omits?|nothing|without|lacks?|unverified|unset|dead|stale|isn't|aren't|doesn't|cannot|can't)\b/i;
  let assigned = 0;
  for (const part of ['T', 'N']) {
    console.log(`\n${part} dispatch groups (<= ${max} per agent):`);
    groups(part).forEach((g, k) => {
      assigned += g.ids.length;
      console.log(`  ${part}${String(k + 1).padStart(2, '0')} ${g.area.padEnd(5)} (${String(g.ids.length).padStart(2)}): ${g.ids.join(' ')}`);
    });
  }
  const uEntries = entries.filter((e) => e.partition === 'U');
  const absence = uEntries.filter((e) => ABSENCE.test(index.get(e.id)?.title || '')).map((e) => e.id);
  const sample = uEntries
    .filter((e) => createHash('sha256').update(e.id + headSha).digest()[0] % 10 === 0)
    .map((e) => e.id);
  console.log(`\nU-absence (${absence.length}): ${absence.join(' ')}`);
  console.log(`U-sample  (${sample.length}): ${sample.join(' ')}`);
  console.log(`\ndispatch reconcile: T+N assigned ${assigned} == T+N ${T + N} -> ${assigned === T + N ? 'OK' : 'MISMATCH'}`);
  if (assigned !== T + N && flag('--check')) process.exitCode = 1;
}

const out = opt('--json');
if (out) {
  writeFileSync(out, JSON.stringify({
    generatedBy: 'app/scripts/register-rebaseline.mjs',
    base: baseSha, head: headSha,
    commits: commits.map((c) => ({ sha: c.sha, subject: c.subject, files: [...c.files] })),
    counts: { index: idsIndex.length, blocks: idsBlocks.length, T, U, N },
    entries,
  }, null, 2) + '\n');
  console.log(`\nwrote ${out}`);
}

const problems = [];
if (indexDupes.length) problems.push(`duplicate INDEX ids: ${indexDupes.join(' ')}`);
if (blockDupes.length) problems.push(`duplicate entry blocks: ${blockDupes.join(' ')}`);
if (missingBlock.length) problems.push(`INDEX ids with no entry block: ${missingBlock.join(' ')}`);
if (missingIndex.length) problems.push(`entry blocks with no INDEX row: ${missingIndex.join(' ')}`);
if (T + U + N !== idsBlocks.length) problems.push(`T+U+N ${T + U + N} != entry blocks ${idsBlocks.length}`);
if (problems.length) {
  console.log('\nRECONCILE FAILED:\n  ' + problems.join('\n  '));
  if (flag('--check')) process.exitCode = 1;
} else {
  console.log('\nreconcile OK: every INDEX row has one entry block and every entry is in exactly one partition');
}
