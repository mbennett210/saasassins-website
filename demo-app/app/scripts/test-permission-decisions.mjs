// Matt's permission decisions of 2026-09-29 (MISC-2, MISC-3, MISC-4 → CS-206), each
// pinned where it is DECIDED — the permission matrix and the crew write merge — so a
// later tightening cannot silently undo an owner's call.
//
//   MISC-2  Can cleaners add office notes on a customer?            → YES
//   MISC-3  Can admins see the "Hours by cleaner" report?           → YES
//   MISC-4  Who can update the Indeed review count?                 → whoever MANAGES reviews
//           (RETIRED 2026-10-20: the count left with Google reviews, its page and its
//           org_state rule — test-google-reviews-retired.mjs holds that gone)
//
// Every assertion names the SERVER twin as well as the app gate: the register's finding
// (CS-206) was that the two disagreed about all three.
//
//   node app/scripts/test-permission-decisions.mjs
import { readFileSync } from 'node:fs';
import { can, seedPermissions } from '../src/lib/roles.js';
import { mergeCrewChanges } from '../api/_lib/crewMerge.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// The COMMITTED matrix, exactly as the app ships it — `can()` falls back to each key's
// defaultRoles for a key the matrix has no row for, so the seed is the honest input.
const MATRIX = seedPermissions();
const NO_OVERRIDES = [];
const holder = (role, id) => ({ id, role, status: 'active' });

const OWNER = holder('owner', 'u_owner');
const ADMIN = holder('admin', 'u_admin');
const MANAGER = holder('manager', 'u_mgr');
const CREW = holder('crew', 'u_crew');
const held = (user, key, overrides = NO_OVERRIDES) => can(user, key, MATRIX, overrides);

// ── MISC-2 · a cleaner may add an office note on a customer ────────────────────────
{
  // The app gate: ClientDetail's Notes section (and its "Add office note" composer) is
  // gated on clients.view, which crew hold.
  ok('MISC-2 app gate: crew hold clients.view (the Notes composer\'s gate)', held(CREW, 'clients.view') === true);
  const detail = read('../src/pages/ClientDetail.jsx');
  ok('MISC-2 the composer is still gated on canView, not an edit key',
    /\{canView && \(\s*\n\s*<div className="card" style=\{\{ marginBottom: 16 \}\}>/.test(detail)
    || /canView && \(/.test(detail.slice(detail.indexOf('Add office note') - 1200, detail.indexOf('Add office note'))));

  // 🔴 The SERVER twin. A crew session posts a PROJECTION of the blob and the server
  // merges only allowlisted changes (CS-002). A note the app let a cleaner type would be
  // silently dropped unless the merge keeps it, so the decision lives here as much as in
  // the gate: a new clientActivities row on an IN-SCOPE customer survives, with the author
  // stamped server-side, and one on another customer's account does not.
  const full = {
    users: [{ ...CREW, name: 'Cleaner', notificationPrefs: {} }],
    clients: [{ id: 'c_mine', name: 'Mine', notes: '' }, { id: 'c_theirs', name: 'Theirs', notes: '' }],
    sites: [{ id: 's_mine', clientId: 'c_mine' }],
    contacts: [], conversations: [], messages: [], notifications: [],
    clientActivities: [], keys: [], keyEvents: [], jobs: [],
  };
  const scope = { clientIds: ['c_mine'] };
  const posted = {
    ...full,
    clientActivities: [
      { id: 'act_new', clientId: 'c_mine', kind: 'note', body: 'Gate code changed', authorUserId: 'someone-else', occurredAt: '2026-09-29T02:00:00.000Z' },
      { id: 'act_foreign', clientId: 'c_theirs', kind: 'note', body: 'not mine', authorUserId: CREW.id },
    ],
  };
  const { next, dropped } = mergeCrewChanges({ full, posted, userId: CREW.id, scope });
  const kept = (next.clientActivities || []).find((a) => a.id === 'act_new');
  ok('MISC-2 server twin: a cleaner\'s office note on their own customer is COMMITTED', !!kept);
  ok('MISC-2 server twin: its author is stamped from the login, not the body', kept?.authorUserId === CREW.id);
  ok('MISC-2 server twin: a note on a customer outside their scope is dropped',
    !(next.clientActivities || []).some((a) => a.id === 'act_foreign')
    && dropped.some((d) => d.slice === 'clientActivities' && d.reason === 'out-of-scope-client'));
}

// ── MISC-3 · an admin may see "Hours by cleaner" ───────────────────────────────────
{
  // The report is Reports › Hours by cleaner. Three gates decide whether an admin sees it:
  // the route (reports.view), and the two reads it runs (time/rollup and time/drive-report,
  // both requirePermission('variance.view')). All three must hold, or the tab renders and
  // the numbers never arrive.
  ok('MISC-3 route gate: admin holds reports.view', held(ADMIN, 'reports.view') === true);
  ok('MISC-3 data gate: admin holds variance.view (time/rollup + drive-report)', held(ADMIN, 'variance.view') === true);
  ok('MISC-3 and a manager still does too', held(MANAGER, 'reports.view') && held(MANAGER, 'variance.view'));
  ok('MISC-3 crew still see no report hub', held(CREW, 'reports.view') === false);
  // The hours it shows are payroll-equivalent, and payroll itself stays owner+manager
  // (Q24's financials pattern) — Matt's yes widens the REPORT, not the pay run.
  ok('MISC-3 admin still hold no payroll.view (the report is not the pay run)', held(ADMIN, 'payroll.view') === false);

  const reports = read('../src/pages/Reports.jsx');
  ok('MISC-3 the Hours report is still mounted in the hub', /Hours by cleaner/.test(reports));
  const api = read('../api/time/[...path].js');
  ok("MISC-3 rollup's server gate is still variance.view",
    /action === 'rollup'[\s\S]{0,200}?requirePermission\(req, res, 'variance\.view'\)/.test(api));
}

console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error('  ✗ ' + f);
process.exitCode = fails.length === 0 ? 0 : 1;
