// Server-side permission gates (Sept 3): requirePermission runs the SAME can() the
// client uses, so a per-user grant is honored server-side, not just in the UI. This
// pins the three things that make that safe:
//   1. NO-WIDENING — every converted gate maps to a permission whose defaultRoles are
//      a SUBSET of the roles the old requireRole allowed. This is what makes "mapped
//      too weak" (an access hole) impossible to ship unnoticed.
//   2. can() lockstep — a grant enables, a revoke disables, role default otherwise.
//   3. Source-shape — the helper authorizes on the claim role + claim id + the two
//      protected blob slices; the AUTHORITY guards never use it bare (a grant must
//      never confer the power to grant).
//
//   node scripts/test-permission-gate.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { can, PERMISSIONS } from '../src/lib/roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
let pass = 0; const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// The role sets each converted gate USED to allow (the pre-permission requireRole).
// The `manager` tier (added 2026-09-13) defaults to FULL access — same posture as
// owner, pared back per-client in Settings → Roles — so it is an authorized member of
// every gate's role set and belongs in each baseline. The guard still catches a REAL
// widening (e.g. admin onto an owner/manager-only financial gate, or crew onto a
// manager gate), because those roles stay out of the baselines below.
const MANAGER = ['owner', 'admin', 'manager'];
const VIEW = ['owner', 'admin', 'manager', 'crew'];
const OWNER = ['owner', 'manager'];

// Every gate converted from requireRole(oldRoles) → requirePermission(key).
const CONVERSIONS = [
  // simple single-gate files
  { where: 'variance/report', key: 'variance.view', old: MANAGER },
  { where: 'inbox/connect', key: 'marketing.connectInbox', old: MANAGER },
  { where: 'inbox/disconnect', key: 'marketing.connectInbox', old: MANAGER },
  { where: 'heartbeat/GET', key: 'settings.team.view', old: MANAGER },
  { where: 'workspaces', key: 'integrations.manage', old: OWNER },
  { where: 'site-security/set', key: 'ops.edit', old: MANAGER },
  { where: 'account-media/delete', key: 'ops.edit', old: MANAGER },
  // time
  { where: 'time/correct', key: 'time.edit.all', old: MANAGER },
  { where: 'time/manual', key: 'time.edit.all', old: MANAGER },
  { where: 'time/approve', key: 'time.approve', old: MANAGER },
  { where: 'time/open', key: 'variance.view', old: MANAGER },
  { where: 'time/rollup', key: 'variance.view', old: MANAGER },
  { where: 'time/entries', key: 'time.view', old: MANAGER },
  { where: 'time/drive-report', key: 'variance.view', old: MANAGER },
  { where: 'time/drive-override', key: 'time.edit.all', old: MANAGER },
  // quotes
  { where: 'quotes/list|get|download', key: 'quotes.view', old: MANAGER },
  { where: 'quotes/create|save', key: 'quotes.create', old: MANAGER },
  { where: 'quotes/admin-sign|send', key: 'quotes.send', old: MANAGER },
  { where: 'quotes/void|delete', key: 'quotes.delete', old: MANAGER },
  // qc
  { where: 'qc/problems.create|update', key: 'problems.manage', old: VIEW },
  { where: 'qc/*.list|get|report|pdf', key: 'qc.view', old: VIEW },
  { where: 'qc/templates.edit', key: 'qc.templates.edit', old: MANAGER },
  { where: 'qc/inspections.create|submit', key: 'qc.inspect', old: MANAGER },
  { where: 'qc/checklists.submit', key: 'qc.checklist.perform', old: VIEW },
  // reviews
  { where: 'reviews/read', key: 'reviews.view', old: MANAGER },
  { where: 'reviews/manage', key: 'reviews.manage', old: MANAGER },
  // Role list kept AND the key added (requireRoleOrPermission / a bypass key, 2026-09-23 —
  // the old lists refused the manager tier). The role list still passes on its own, so the
  // subset rule here guards the KEY half: its defaults must not reach past the old roles.
  { where: 'time/clock-in|clock-out|replay punch bypass', key: 'time.edit.all', old: MANAGER },
  { where: 'time/watchdog recipients', key: 'variance.view', old: MANAGER },
  { where: 'site-security/reveal bypass', key: 'ops.revealCodes', old: MANAGER },
  { where: 'settings/webhooks|outbound|deliveries read', key: 'integrations.view', old: OWNER },
  { where: 'settings/webhooks|outbound change + secrets', key: 'integrations.manage', old: OWNER },
  { where: 'hr-files/download-url', key: 'hr.view', old: MANAGER },
  { where: 'hr-files/upload-url|delete', key: 'hr.edit', old: MANAGER },
];

// ── 1. NO-WIDENING ───────────────────────────────────────────────────────────
const subset = (a, b) => a.every((r) => b.includes(r));
for (const c of CONVERSIONS) {
  const def = PERMISSIONS[c.key]?.defaultRoles;
  ok(`${c.where}: key '${c.key}' exists in the schema`, Array.isArray(def));
  ok(`🔴 ${c.where}: '${c.key}' defaults (${def}) ⊆ old roles (${c.old}) — no widening`, Array.isArray(def) && subset(def, c.old));
}

// ── 2. can() lockstep — the exact decisions requirePermission delegates ───────
const U = (role) => ({ id: 'u1', role });
ok('crew without a grant is DENIED an owner/admin key', can(U('crew'), 'marketing.connectInbox', null, []) === false);
ok('🔴 crew WITH a per-user grant is ALLOWED (the whole point)',
  can(U('crew'), 'marketing.connectInbox', null, [{ userId: 'u1', grants: ['marketing.connectInbox'] }]) === true);
ok('🔴 admin WITH a per-user revoke is DENIED (admin minus a view)',
  can(U('admin'), 'quotes.delete', null, [{ userId: 'u1', revokes: ['quotes.delete'] }]) === false);
ok('revoke beats grant for the same key', can(U('crew'), 'reviews.manage', null, [{ userId: 'u1', grants: ['reviews.manage'], revokes: ['reviews.manage'] }]) === false);
ok('admin gets an owner+admin default key with no override', can(U('admin'), 'reviews.view', null, []) === true);
ok('crew does NOT get an owner+admin default key with no override', can(U('crew'), 'reviews.view', null, []) === false);
ok('crew keeps a crew-inclusive key by default', can(U('crew'), 'qc.checklist.perform', null, []) === true);
ok('a grant is scoped to the RIGHT user id (not another)',
  can(U('crew'), 'time.approve', null, [{ userId: 'someone-else', grants: ['time.approve'] }]) === false);

// ── 3. source-shape ──────────────────────────────────────────────────────────
const authz = read('api/_lib/authz.js');
ok('permissionChecker runs can() on the claim role + claim id + the committed slices',
  /export async function permissionChecker[\s\S]{0,300}const me = \{ id: a\?\.orgUserId, role: a\?\.role \};[\s\S]{0,200}canCommitted\(me, permKey, slices\)/.test(authz));
ok('  canCommitted is the app\'s can() on the raw rows, and a row it can\'t read denies',
  /export function canCommitted\(user, permKey, \{ permissions, overrides \}\) \{\s*try \{\s*return can\(user, permKey, permissions, overrides\) === true;\s*\} catch \{\s*return false;/.test(authz));
ok('  requirePermission and requireRoleOrPermission both decide through it',
  /export async function requirePermission[\s\S]{0,300}holdsOrRefuse\(a, res, permKey\)/.test(authz)
  && /export async function requireRoleOrPermission[\s\S]{0,400}holdsOrRefuse\(a, res, permKey\)/.test(authz)
  && /async function holdsOrRefuse[\s\S]{0,200}await permissionChecker\(a\)/.test(authz));
ok('  it reads the protected slices (matrix + overrides), not standingCrewIds',
  /readProtectedSlices\([\s\S]{0,120}userPermissionOverrides:state->userPermissionOverrides/.test(authz));

const ROUTE_FILES = [
  'api/variance/[...path].js', 'api/inbox/connect/start.js', 'api/inbox/[id]/disconnect.js',
  'api/state/heartbeat.js', 'api/workspaces/[...path].js', 'api/site-security/[...path].js',
  'api/account-media/[...path].js', 'api/quotes/[...path].js',
  'api/qc/[...path].js', 'api/reviews/[...path].js', 'api/time/[...path].js',
  'api/hr-files/[...path].js',
];
for (const f of ROUTE_FILES) {
  ok(`🔴 ${f} no longer calls requireRole (converted to requirePermission)`, !/requireRole\(/.test(read(f)));
}

// The AUTHORITY surfaces must never adopt requirePermission BARE — a grant must never
// confer the power to grant. orgStateGuard (Team administration) and jobsGuard
// (schedule.edit) consult the committed matrix through can() directly, beside their
// own limits; jobsGuard also must not answer 403 (a 403 on the jobs path wedges tabs).
ok('🔴 orgStateGuard does not call requirePermission', !/requirePermission\(/.test(read('api/_lib/orgStateGuard.js')));
ok('🔴 jobsGuard does not call requirePermission (it sanitizes, never rejects)', !/requirePermission\(/.test(read('api/_lib/jobsGuard.js')));
ok('🔴 jobsGuard reads the matrix only through can() on the committed slices',
  /can\(\{ id: selfId, role \}, SCHEDULE_EDIT, matrixForCan\(permissions\), overridesForCan\(overrides\)\)/.test(read('api/_lib/jobsGuard.js')));
// The settings users routes consult the matrix since 2026-09-23, but only through
// teamAuthority.loginRefusal, next to limits held by role and identity: never a bare
// requirePermission gate, and still claim-backed authority only.
{
  const src = read('api/settings/[...path].js');
  ok('🔴 settings users routes never gate on a bare requirePermission (limits by role + identity: loginRefusal) and stay claim-backed',
    !/requirePermission\s*\(|import[^;]*\brequirePermission\b/.test(src) && /loginRefusal\(/.test(src) && /roleSource !== 'claim'/.test(src));
}
// The same file's integrations section asks feature keys through permissionChecker
// (2026-09-23); the login section (invite / claims / disable / delete / reset) is an
// AUTHORITY surface and must never take a bare feature check from it. (Where it consults
// the matrix at all, that goes through limits held by role and identity, not these.)
{
  const src = read('api/settings/[...path].js');
  const users = src.slice(src.indexOf("if (seg0 === 'users') {"), src.indexOf('// ── integrations config'));
  ok('🔴 settings: the login section is found and takes no bare feature check (permissionChecker / holds / requirePermission / can)',
    users.length > 500 && !/permissionChecker|holds\(|requirePermission|\bcan\(/.test(users));
}

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\npermission gates: ${pass}/${pass} passed`);
