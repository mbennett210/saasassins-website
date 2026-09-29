// Guard: app/vercel.json must NOT schedule a cron for a module whose feature flag is OFF.
//
// CS-117: Marketing is dormant (MARKETING_ENABLED = false in src/lib/features.js — that flag
// hides the nav, route, search and QuickStart), but /api/marketing/run stayed in the crons
// array and ran EVERY MINUTE in production: it read the org_state blob up to 3x per tick and,
// with any sequence left active, would keep emailing customers once an inbox connected, with
// no in-app off switch. A dormant module has no business running a scheduled job.
//
//   node scripts/test-cron-feature-flags.mjs
//
// This is a CLASS guard, not a one-off: it maps each feature-flag-gated cron module to its
// flag (imported — the source of truth, never a restated literal, THE LAW II.3) and fails if
// vercel.json schedules a cron for any module whose flag is false. Add a row to FLAG_BY_MODULE
// when a new feature flag lands, and this covers it automatically.
//
// REGRESSION (BUILD_INTEGRITY §6a): while MARKETING_ENABLED is false, add
// { "path": "/api/marketing/run", ... } back to app/vercel.json crons → this suite goes red.
// Remove it (or flip the flag on) → green.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MARKETING_ENABLED } from '../src/lib/features.js';

// module segment of a cron path  ->  the flag that must be TRUE for it to be scheduled.
// A cron whose module is NOT listed here is unconstrained (it belongs to an always-on module).
const FLAG_BY_MODULE = {
  marketing: MARKETING_ENABLED,
};

const vercelPath = fileURLToPath(new URL('../vercel.json', import.meta.url));
const vercel = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));
const crons = Array.isArray(vercel.crons) ? vercel.crons : [];

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) { pass += 1; } else { fails.push(detail ? `${label} — ${detail}` : label); } };

// The module a cron path names: /api/<module>/<action> -> <module>.
const moduleOf = (p) => String(p || '').split('/').filter(Boolean)[1] || null;

for (const c of crons) {
  const mod = moduleOf(c.path);
  if (mod == null || !(mod in FLAG_BY_MODULE)) continue; // always-on module: no constraint
  ok(
    `cron ${c.path} only scheduled when its module flag is ON`,
    FLAG_BY_MODULE[mod] === true,
    `${mod} flag is ${FLAG_BY_MODULE[mod]} but ${c.path} (${c.schedule}) is still scheduled`,
  );
}

// Sanity: the guard is actually exercising the flag map (a typo'd module key that never
// matches would make this vacuously green). At least one flag-gated module must be known.
ok('the flag map is non-empty (guard is live)', Object.keys(FLAG_BY_MODULE).length > 0);

if (fails.length) { console.error('\ncron-feature-flags FAILURES:'); for (const f of fails) console.error(`  ✗ ${f}`); }
console.log(`\ncron-feature-flags: ${pass} passed, ${fails.length} failed`);
process.exit(fails.length ? 1 : 0);
