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
// CS-663 (2026-10-13): customers are ARCHIVED, never deleted (Matt's "Never delete customers").
// The same rule carries over to Archive, which takes each customer's upcoming cleans off the
// schedule: clients.delete ("Archive customers") AND the jobs-write tier AND every clean loaded
// (useJobsHydrated — a partial set would leave some cleans behind). The archive itself is
// test-customer-archive.mjs; this suite pins the gates.
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
  ok('Clients reads clients.delete ("Archive customers")', has(src, "const canArchiveClients = usePermission('clients.delete');"));
  ok('Clients reads whether every clean has loaded', has(src, 'const jobsHydrated = useJobsHydrated();'));
  ok('Clients reads useCanEditJobs into a variable (not short-circuited)', has(src, 'const canEditJobs = useCanEditJobs();'));

  // The three derived gates.
  ok('canBulkTag is clients.edit (the customer TagPicker key)', has(src, 'const canBulkTag = canEditClients;'));
  ok('canBulkArchive requires clients.delete AND the jobs-write tier AND every clean loaded', has(src, 'const canBulkArchive = canArchiveClients && canEditJobs && jobsHydrated;'));
  ok('canBulkSelect is either bulk action', has(src, 'const canBulkSelect = canBulkTag || canBulkArchive;'));
  ok('🔴 there is no bulk Delete any more (CS-663)', !/\bDELETE_CLIENT\b/.test(src) && !has(src, 'canBulkDelete'));

  // The selection UI is HIDDEN when no bulk action is available: the bulk bar and BOTH
  // checkbox cells (select-all header + per-row) sit behind canBulkSelect.
  ok('the bulk bar is gated on canBulkSelect (not on the selection alone)',
    has(src, '{canBulkSelect && selectedIds.size > 0 && ('));
  ok('the bulk bar is NOT gated on selectedIds.size alone (pre-fix shape is gone)',
    !has(src, '{selectedIds.size > 0 && ( <div className="bulk-bar">'));
  ok('both checkbox cells (th + td) are gated on canBulkSelect', count(src, '{canBulkSelect && (') >= 2);

  // Each bulk action's control sits behind its own gate.
  ok('Apply tags controls are gated on canBulkTag', has(src, '{canBulkTag && ('));
  ok('the Archive button is gated on canBulkArchive', has(src, '{canBulkArchive && !showingArchived && ('));
  ok('the Archive button opens the confirm dialog only inside that gate',
    /\{canBulkArchive && !showingArchived && \([^]*?setConfirmArchiveOpen\(true\)/.test(src));

  // Defense in depth: the dispatchers refuse when the gate is absent (stale UI state).
  ok('bulkApplyTags no-ops without canBulkTag', has(src, 'if (!canBulkTag || bulkTagIds.length === 0) return;'));
  ok('bulkArchive no-ops without canBulkArchive', has(src, 'if (!canBulkArchive) return;'));
}

// ── ClientDetail.jsx — the single-record twin (same archive rule) ─────────────
{
  const src = read('../src/pages/ClientDetail.jsx');
  ok('ClientDetail imports useCanEditJobs',
    /import\s*\{[^}]*\buseCanEditJobs\b[^}]*\}\s*from\s*'\.\.\/hooks\/usePermission'/.test(src));
  ok('ClientDetail reads useCanEditJobs into a variable', has(src, 'const canEditJobs = useCanEditJobs();'));
  ok('ClientDetail archive needs clients.delete AND the jobs-write tier AND every clean loaded', has(src, 'const canArchive = canArchiveClient && canEditJobs && jobsHydrated;'));
  ok('  ...and never gates it on clients.delete alone', !has(src, 'const canArchive = canArchiveClient;'));
}

console.log(`\n${pass}/${pass + fails.length} passed`);
for (const f of fails) console.log(`  FAIL  ${f}`);
console.log('');
process.exit(fails.length ? 1 : 0);
