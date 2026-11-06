// Every screen that reads the signed-in person from useAuth() names a key the hook returns.
//
// WHY (S131, Builder R): the Hours Approval page read `const { user } = useAuth()`, but the hook
// returns `currentUser` (and `authenticatedUser`, `claimRole`, …), never `user`. Destructuring a
// key the hook does not return gives `undefined` with no error, so the page ran as nobody:
//   · its own-punch skip (canActOnPunch → refusesOwn) never fired, so a manager was offered
//     Approve on their own punch and the server refused it (own-entry);
//   · the manager list's "Me (name)" label never matched;
//   · a scoped manager's Missing-time report read every manager's cleans (managerId null), only
//     narrowed afterwards by the scope filter;
//   · an Operations Manager's team filter (S131) never showed (isOpsManager(undefined) is false).
// The checks: the hook's own `return { … }` is the source of truth for its keys; every
// `const { … } = useAuth()` destructure and every `useAuth().key` read in src/ names one of them.
//
// Offline, static. Run: node scripts/test-use-auth-keys.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(APP, 'src');
const HOOK = path.join(SRC, 'hooks', 'useAuth.js');

let pass = 0; let fail = 0;
const check = (label, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ok   ${label}`); } else { fail += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// ── the hook's returned keys, read from its own source ────────────────────────────────────────
const hookSrc = readFileSync(HOOK, 'utf8');
const fnAt = hookSrc.indexOf('export function useAuth(');
const body = fnAt >= 0 ? hookSrc.slice(fnAt) : '';
const ret = body.match(/return\s*\{([^}]*)\};/);
const keyOf = (part) => part.split(':')[0].split('=')[0].trim();
const returned = new Set(ret ? ret[1].split(',').map(keyOf).filter(Boolean) : []);
console.log('useAuth() returns:', [...returned].join(', ') || '(none found)');
check('the hook source exposes a `return { … }` with keys', returned.size > 0);
check('`currentUser` is one of them (the reader every screen should use)', returned.has('currentUser'));

// ── every reader in src/ ──────────────────────────────────────────────────────────────────────
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(jsx?|mjs)$/.test(name)) files.push(p);
  }
})(SRC);

const bad = [];
let readers = 0;
for (const file of files) {
  if (file === HOOK) continue;
  const src = readFileSync(file, 'utf8');
  if (!src.includes('useAuth(')) continue;
  const rel = path.relative(APP, file);
  for (const m of src.matchAll(/const\s*\{([^}]*)\}\s*=\s*useAuth\(\)/g)) {
    readers += 1;
    for (const part of m[1].split(',')) {
      const key = keyOf(part.replace(/\/\/[^\n]*/g, ''));
      if (!key || key.startsWith('...')) continue;
      if (!returned.has(key)) bad.push(`${rel}: destructures \`${key}\``);
    }
  }
  for (const m of src.matchAll(/useAuth\(\)\.([A-Za-z_$][\w$]*)/g)) {
    // a comment naming the hook (`useAuth().currentUser — …`) still has to name a real key
    readers += 1;
    if (!returned.has(m[1])) bad.push(`${rel}: reads useAuth().${m[1]}`);
  }
}
console.log(`${readers} readers across src/`);
check('there are readers to check (the scan is live)', readers > 10, `${readers}`);
check('every reader names a key useAuth() returns', bad.length === 0, bad.join('; '));

// ── the page this guard was written for ───────────────────────────────────────────────────────
const approvals = readFileSync(path.join(SRC, 'pages', 'Approvals.jsx'), 'utf8');
check('Hours Approval reads the signed-in person as currentUser',
  /const\s*\{\s*currentUser(\s*:\s*user)?\s*\}\s*=\s*useAuth\(\)/.test(approvals));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
