// can() hardening (2026-08-03): a valid identity is never stranded off the
// ALWAYS_GRANTED daily hubs, an OWNER can never be locked out of the fix-it
// permissions (OWNER_CORE), and a null caller still fails closed.
// lib/roles.js is dependency-free → imported directly.
//
//   node scripts/test-can-claim-only.mjs
import { can, OWNER_CORE, ALWAYS_GRANTED } from '../src/lib/roles.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass += 1; else { fail += 1; console.error(`✖ ${n}`); } };

const NO_MATRIX = null; // no live matrix → can() falls back to defaultRoles

// ── claim-only OWNER (synthesized user, __fromClaim) — the David-as-owner shape ─
const owner = { id: 'u_o', role: 'owner', __fromClaim: true };
ok('owner: ALWAYS_GRANTED hub (time.clock)', can(owner, 'time.clock', NO_MATRIX, null) === true);
ok('owner: OWNER_CORE (settings.roles.edit)', can(owner, 'settings.roles.edit', NO_MATRIX, null) === true);
ok('owner: dashboard.view', can(owner, 'dashboard.view', NO_MATRIX, null) === true);
ok('owner: an owner-default perm (clients.delete)', can(owner, 'clients.delete', NO_MATRIX, null) === true);

// ── claim-only CREW ───────────────────────────────────────────────────────────
const crew = { id: 'u_c', role: 'crew', __fromClaim: true };
ok('crew: keeps ALWAYS_GRANTED (schedule.view)', can(crew, 'schedule.view', NO_MATRIX, null) === true);
ok('crew: denied dashboard.view', can(crew, 'dashboard.view', NO_MATRIX, null) === false);
ok('crew: denied settings.roles.edit', can(crew, 'settings.roles.edit', NO_MATRIX, null) === false);

// ── degenerate identities ──────────────────────────────────────────────────────
ok('null user → everything false (signed-out fails closed)', can(null, 'time.clock', NO_MATRIX, null) === false);
const roleless = { id: 'u_x' }; // truthy user, no role — corrupt roster row
ok('roleless user: ALWAYS_GRANTED still granted (never a dead app)', can(roleless, 'time.clock', NO_MATRIX, null) === true);
ok('roleless user: elevated permission still denied', can(roleless, 'dashboard.view', NO_MATRIX, null) === false);

// ── owner escape hatch survives an EMPTIED live-matrix record ("permissions change") ─
const emptied = [{ id: 'settings.roles.edit', roles: [] }, { id: 'dashboard.view', roles: [] }];
ok('owner keeps settings.roles.edit even when its matrix record is emptied', can(owner, 'settings.roles.edit', emptied, null) === true);
ok('owner keeps dashboard.view even when its matrix record is emptied', can(owner, 'dashboard.view', emptied, null) === true);

// ── shape pins ─────────────────────────────────────────────────────────────────
ok('OWNER_CORE contains the fix-it permissions', OWNER_CORE.has('settings.roles.edit') && OWNER_CORE.has('dashboard.view'));
ok('ALWAYS_GRANTED still holds the four daily hubs', ['time.clock', 'schedule.view', 'messaging.use', 'settings.account'].every((k) => ALWAYS_GRANTED.has(k)));

console.log(`\ntest-can-claim-only: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
