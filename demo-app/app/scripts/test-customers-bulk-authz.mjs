// The Customers hub bulk actions must be gated exactly like their single-record
// twins on ClientDetail — and hidden entirely when no bulk action is available.
//
// WHY (adversarial review, S78 → owner-approved fix 2026-09-23): /clients is
// reachable by URL for anyone with clients.view OR contacts.view (crew hold both by
// default; the nav hiding the link is NOT a gate). The bulk bar showed on any
// selection with an ungated "Apply tags" (TAG_CLIENT) and "Delete" (DELETE_CLIENT
// per id), and the row checkboxes were ungated too — so a crew member could bulk
// -delete the whole customer book. The single-record twins already gate: tags ←
// clients.edit (ClientDetail TagPicker), Delete ← clients.delete. Delete ALSO needs
// useCanEditJobs (owner/admin, or a manager with schedule.edit): a customer delete
// cascades to its jobs and the server's jobsGuard puts that job half BACK for anyone
// without schedule.edit, orphaning the cleans (they keep feeding the ops-alerts
// cron) — so a delete the caller can't complete is not offered.
//
// This is a SOURCE-SHAPE suite (like test-client-inspections.mjs Layer C): the gates
// live in JSX render logic, which the offline suites don't render, so it asserts the
// wiring by shape. Every assertion below is FALSE against the pre-fix source (which
// had no useCanEditJobs / canBulkDelete / canBulkSelect and an ungated bulk bar,
// checkbox column and Delete button). The behavior itself is proven by the browser
// drive (HANDOFF).
//
//   node scripts/test-customers-bulk-authz.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
// Whitespace-insensitive containment: robust to reindenting / line wrapping, but still
// pins the exact wiring (the tokens, operators and order must all be present).
const has = (src, needle) => src.replace(/\s+/g, ' ').includes(needle.replace(/\s+/g, ' '));
const count = (src, needle) => src.replace(/\s+/g, ' ').split(needle.replace(/\s+/g, ' ')).length - 1;

// ── Clients.jsx — the Customers hub bulk bar + selection UI ──────────────────
{
  const src = read('../src/pages/Clients.jsx');

  // The gate inputs: both hooks are read UNCONDITIONALLY (Rules of Hooks), then combined.
  ok('Clients imports useCanEditJobs from the permission hooks',
    /import\s*\{[^}]*\buseCanEditJobs\b[^}]*\}\s*from\s*'\.\.\/hooks\/usePermission'/.test(src));
  ok('Clients reads clients.delete', has(src, "const canDeleteClients = usePermission('clients.delete');"));
  ok('Clients reads useCanEditJobs into a variable (not short-circuited)', has(src, 'const canEditJobs = useCanEditJobs();'));

  // The three derived gates.
  ok('canBulkTag is clients.edit (the customer TagPicker key)', has(src, 'const canBulkTag = canEditClients;'));
  ok('canBulkDelete requires clients.delete AND the jobs-write tier', has(src, 'const canBulkDelete = canDeleteClients && canEditJobs;'));
  ok('canBulkSelect is either bulk action', has(src, 'const canBulkSelect = canBulkTag || canBulkDelete;'));

  // The selection UI is HIDDEN when no bulk action is available: the bulk bar and BOTH
  // checkbox cells (select-all header + per-row) sit behind canBulkSelect.
  ok('the bulk bar is gated on canBulkSelect (not on the selection alone)',
    has(src, '{canBulkSelect && selectedIds.size > 0 && ('));
  ok('the bulk bar is NOT gated on selectedIds.size alone (pre-fix shape is gone)',
    !has(src, '{selectedIds.size > 0 && ( <div className="bulk-bar">'));
  ok('both checkbox cells (th + td) are gated on canBulkSelect', count(src, '{canBulkSelect && (') >= 2);

  // Each bulk action's control sits behind its own gate.
  ok('Apply tags controls are gated on canBulkTag', has(src, '{canBulkTag && ('));
  ok('the Delete button is gated on canBulkDelete', has(src, '{canBulkDelete && ('));
  ok('the danger Delete button opens the confirm dialog only inside that gate',
    /\{canBulkDelete && \([^]*?btn-danger[^]*?setConfirmDeleteOpen\(true\)/.test(src));

  // Defense in depth: the dispatchers refuse when the gate is absent (stale UI state).
  ok('bulkApplyTags no-ops without canBulkTag', has(src, 'if (!canBulkTag || bulkTagIds.length === 0) return;'));
  ok('bulkDelete no-ops without canBulkDelete', has(src, 'if (!canBulkDelete) return;'));
}

// ── ClientDetail.jsx — the single-record twin (same delete rule) ─────────────
{
  const src = read('../src/pages/ClientDetail.jsx');
  ok('ClientDetail imports useCanEditJobs',
    /import\s*\{[^}]*\buseCanEditJobs\b[^}]*\}\s*from\s*'\.\.\/hooks\/usePermission'/.test(src));
  ok('ClientDetail reads useCanEditJobs into a variable', has(src, 'const canEditJobs = useCanEditJobs();'));
  ok('ClientDetail delete needs clients.delete AND the jobs-write tier', has(src, 'const canDelete = canDeleteClient && canEditJobs;'));
  ok('  ...and no longer gates delete on clients.delete alone', !has(src, 'const canDelete = canDeleteClient;'));
}

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
console.log('');
process.exit(fails.length ? 1 : 0);
