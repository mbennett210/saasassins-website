// Every read the Approvals page makes is SCOPED to the signed-in manager's customers
// (wave W5-M, F5). A source pin plus the pure rule it must use.
//
// 🔴 WHY A SOURCE PIN. The leak is not in a function — it is in a CALL. `pages/Approvals.jsx`
// asked `timeApi.entriesAll({ fromIso, toIso, lite: true })` with NO clientIds for the
// Missing-time tab and filtered the answer in the browser. `/api/time/entries` answers
// COMPANY-WIDE for any `time.view` holder, and the lite column set carries `user_name` and
// both punch times, so a scoped manager downloaded every other location's cleaners and their
// hours and then hid them. W4-F closed exactly this leak for TimeClockHistory with
// `effectiveTimeFilter`; nothing but a pin over the call sites keeps the next reader honest,
// because a unit test of the filter passes whether or not anyone calls it.
//
// The other two tabs read `timeApi.approvals()`, which the server scopes itself
// (`timeScopeFor` + the customer filter pushed into the query), so they are checked by
// EXCLUSION here: no other raw punch read may appear on the page.
//
//   node app/scripts/test-approvals-read-scope.mjs
import { readFileSync } from 'node:fs';
import { effectiveTimeFilter } from '../src/lib/timeRules.js';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const src = readFileSync(new URL('../src/pages/Approvals.jsx', import.meta.url), 'utf8');
const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// ── 1. the page runs the shared scope rule ───────────────────────────────────
ok('Approvals imports effectiveTimeFilter (the W4-F rule, not a second reading of it)',
  /import\s*\{[^}]*\beffectiveTimeFilter\b[^}]*\}\s*from\s*'\.\.\/lib\/timeRules'/.test(code),
  'no effectiveTimeFilter import');

// ── 2. every raw punch read on the page carries a customer filter ────────────
const reads = [...code.matchAll(/timeApi\.(entries|entriesAll)\s*\(\s*(\{[\s\S]{0,400}?\})\s*\)/g)];
ok('the page makes at least one raw punch read (the Missing-time attendance read)', reads.length >= 1, `${reads.length} found`);
for (const [, fn, args] of reads) {
  ok(`timeApi.${fn}(…) is scoped — it passes clientIds`, /\bclientIds\b/.test(args), args.replace(/\s+/g, ' ').slice(0, 160));
}

// ── 3. …and it is the EFFECTIVE ids, not the raw scope ───────────────────────
// Passing `clientIds: clientIds` straight from useTimeScope would send [] for a manager with
// no locations — and the server and the demo stub both DROP an empty clientIds and answer
// company-wide, which is the leak again, wearing a filter.
ok('the read is skipped entirely when the rule says not to fetch',
  /if\s*\(\s*!\s*\w*[Ff]etch\w*\s*\)/.test(code) || /\bnoLocations\b/.test(code),
  'no early return on the no-scope branch');

// ── 4. the rule itself, on the two Approvals shapes ──────────────────────────
{
  const owner = effectiveTimeFilter({ unscoped: true, scopeClientIds: null });
  ok('owner/admin: fetch company-wide (clientIds null)', owner.fetch === true && owner.clientIds === null, JSON.stringify(owner));
  const mgr = effectiveTimeFilter({ unscoped: false, scopeClientIds: ['cl_a', 'cl_b'] });
  ok('a scoped manager: fetch their customers only', mgr.fetch === true && JSON.stringify(mgr.clientIds) === JSON.stringify(['cl_a', 'cl_b']), JSON.stringify(mgr));
  const none = effectiveTimeFilter({ unscoped: false, scopeClientIds: [] });
  ok('a manager with NO locations: no read at all (never an empty clientIds)', none.fetch === false && none.reason === 'no-scope', JSON.stringify(none));
}

console.log(`\napprovals read scope: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
}
