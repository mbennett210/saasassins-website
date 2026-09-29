// Permission-key integrity: every permission GATE in the code must reference a key the
// vocabulary actually defines, and (informational) every defined key should be used.
//
// WHY. can() falls back to `PERMISSIONS[key]?.defaultRoles || []` for an unknown key —
// i.e. a typo'd or renamed gate (`usePermission('invoices.veiw')`, `perm="reviews.mange"`)
// resolves to an EMPTY role list and silently denies EVERYONE, including the owner, with
// no error. Neither editor shows such a key either, so it's invisible until a user reports
// a missing page. This test ties every enforcement point back to lib/roles.js so that
// drift (a gate pointing at a key the matrix never exposes) fails the build instead.
//
// Scans these reference shapes (all permission keys contain a '.', which anchors the match):
//   usePermission('X')      ·  perm="X" / perm='X' / perm={'X'}   (RequirePerm + nav props)
//   perm: 'X'               ·  check('X')                          (nav-config objects, Sidebar)
//   can(user, 'X', ...)                                            (direct calls, if any)
// and the SERVER gates (api/), where a typo'd key refuses everyone, the owner included:
//   requirePermission(req, res, 'X') · requireRoleOrPermission(req, res, ROLES | [...], 'X')
//   canCommitted(user, 'X', …) · holds('X') (a permissionChecker / orgStateGuard check)
//   (await permissionChecker(a))('X') · bypassPermission: 'X'
// A call may span lines.
// Non-literal args (a variable) can't be checked statically and are skipped by design.
//
//   node scripts/test-permission-references.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PERMISSIONS, ALWAYS_GRANTED, OWNER_CORE } from '../src/lib/roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The full set of legitimate gate targets: matrix keys + the non-revocable universals
// + the owner escape-hatch (both resolve true in can() without being matrix rows).
const VALID = new Set([...Object.keys(PERMISSIONS), ...ALWAYS_GRANTED, ...OWNER_CORE]);

// A permission key is lowercase-initial and dotted (clients.view, settings.roles.edit).
const KEY = "([a-z][a-zA-Z]*(?:\\.[a-zA-Z]+)+)";
const PATTERNS = [
  new RegExp(`usePermission\\(\\s*['"]${KEY}['"]`, 'g'),
  new RegExp(`\\bperm\\s*=\\s*\\{?\\s*['"]${KEY}['"]`, 'g'), // perm="X" / perm='X' / perm={'X'}
  new RegExp(`\\bperm\\s*:\\s*['"]${KEY}['"]`, 'g'),         // perm: 'X'  (nav config objects)
  new RegExp(`\\bcheck\\(\\s*['"]${KEY}['"]`, 'g'),          // Sidebar/FloatingNav helper
  new RegExp(`\\bcan\\([^,\\n]+,\\s*['"]${KEY}['"]`, 'g'),   // direct can(user, 'X')
  new RegExp(`\\brequirePermission\\(\\s*req\\s*,\\s*res\\s*,\\s*['"]${KEY}['"]`, 'g'),
  // the role list may be a name (HR_ROLES) or an inline array (['owner', 'admin'])
  new RegExp(`\\brequireRoleOrPermission\\(\\s*req\\s*,\\s*res\\s*,\\s*(?:\\[[^\\]]*\\]|[\\w.$]+)\\s*,\\s*['"]${KEY}['"]`, 'g'),
  new RegExp(`\\bcanCommitted\\([^,]+,\\s*['"]${KEY}['"]`, 'g'),
  new RegExp(`\\bholds\\(\\s*['"]${KEY}['"]`, 'g'),
  new RegExp(`\\bpermissionChecker\\([^)]*\\)\\s*\\)\\s*\\(\\s*['"]${KEY}['"]`, 'g'), // (await permissionChecker(a))('X')
  new RegExp(`\\bbypassPermission\\s*:\\s*['"]${KEY}['"]`, 'g'),
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(jsx?|mjs)$/.test(name)) out.push(full);
  }
  return out;
}

const scanDirs = ['src', 'api'].map((d) => path.join(ROOT, d)).filter(existsSync);
const files = scanDirs.flatMap(walk);

const referenced = new Set();
const invalid = []; // { key, file, line }
// Whole-file, not line by line: a gate call split across lines (a formatter will do that to a
// long requireRoleOrPermission) must be checked too. `\s` spans the newlines; the line
// number is recovered from the match offset.
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const text = readFileSync(file, 'utf8');
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const key = m[1];
      referenced.add(key);
      if (!VALID.has(key)) invalid.push({ key, file: rel, line: text.slice(0, m.index).split('\n').length });
    }
  }
}

let pass = 0; const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// 1. HARD FAIL: no gate references a key the vocabulary doesn't define.
ok(`🔴 every gate references a defined permission key (${invalid.length} bad ref(s))`, invalid.length === 0);
for (const bad of invalid) {
  ok(`🔴 ${bad.file}:${bad.line} gates on '${bad.key}' which is NOT in PERMISSIONS/ALWAYS_GRANTED/OWNER_CORE`, false);
}

// 2. Sanity: the vocabulary sets themselves are coherent.
for (const k of ALWAYS_GRANTED) ok(`ALWAYS_GRANTED '${k}' is a defined PERMISSIONS key`, k in PERMISSIONS);
for (const k of OWNER_CORE) ok(`OWNER_CORE '${k}' is a defined PERMISSIONS key`, k in PERMISSIONS);

// 3. INFORMATIONAL (never fails the build): keys defined but referenced by no client gate.
//    Legit reasons exist (server-only twins, keys enforced only in stripped app/api on this
//    demo, keys read via a dynamic variable) — so this is a heads-up for the PERM-01
//    "decorative key" review, not a gate. ALWAYS_GRANTED keys are surfaced structurally,
//    not via usePermission, so they're excluded here.
const unreferenced = Object.keys(PERMISSIONS).filter((k) => !referenced.has(k) && !ALWAYS_GRANTED.has(k));

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\npermission-reference integrity: ${pass}/${pass} passed (${referenced.size} keys referenced across ${files.length} files)`);
if (unreferenced.length) {
  console.log(`  note: ${unreferenced.length} defined key(s) not referenced by a client gate (review for PERM-01 decoratives / server-only): ${unreferenced.join(', ')}`);
}
