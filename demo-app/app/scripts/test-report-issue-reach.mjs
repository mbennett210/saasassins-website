// CS-049 regression: "Report an issue" must be reachable by the people meant to use it.
//
// It existed ONLY in the desktop sidebar footer. The mobile sidebar is off-canvas and
// never opened, and the FloatingNav menu had no entry — so crew in the field, the intended
// reporters, had no route to it at all. The crash screen, the moment you most need to
// report something, offered only a Reload button. And the support proxy's outbound fetch
// had no timeout, so a stalled CRM left the reporter on a spinner with no outcome.
//
// Offline: reads the source of the surfaces plus the route's exported constant. A
// component test would need a DOM; what CS-049 is actually about is whether an ENTRY
// EXISTS on each surface, which is a structural claim.
// Run: node app/scripts/test-report-issue-reach.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CRM_TIMEOUT_MS } from '../api/support/report.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

// The event name is the contract between the surfaces that ASK and the one that owns the
// modal. Written once here so a rename has to break this suite rather than the phone nav.
const OPEN_EVENT = 'cs:open-report';

console.log('CS-049 — Report an issue is reachable on a phone and from a crash\n');

// ── 1. The phone ─────────────────────────────────────────────────────────────
const fnav = src('src/components/FloatingNav.jsx');
ok(/Report an issue/.test(fnav), 'FloatingNav (the phone menu) has a "Report an issue" entry');
ok(fnav.includes(OPEN_EVENT), `FloatingNav dispatches ${OPEN_EVENT}`);
// It must not be permission-gated: anyone who can reach a broken screen may report it.
const reportRow = fnav.slice(fnav.indexOf('Report an issue') - 800, fnav.indexOf('Report an issue') + 200);
ok(!/check\(/.test(reportRow.split('onClick')[0].split('<button').pop() || ''),
  'the phone entry is not permission-gated');

// ── 2. Something must ANSWER that event, or the row is a dead button ─────────
// Since the Cleaner Hub (brief A, 2026-10-13) the answer is ONE host AppLayout mounts for every role:
// the crew shell draws no Sidebar, so a listener there would leave a cleaner's ask unanswered.
const host = src('src/components/ReportIssueHost.jsx');
const layout = src('src/layouts/AppLayout.jsx');
const sidebar = src('src/components/Sidebar.jsx');
ok(host.includes(`addEventListener('${OPEN_EVENT}'`), `ReportIssueHost listens for ${OPEN_EVENT}`);
ok(host.includes('removeEventListener'), 'the listener is cleaned up on unmount');
ok(host.includes('<ReportIssueModal'), 'ReportIssueHost owns the one ReportIssueModal');
const crewAt = layout.indexOf('if (crew) {');
const crewShell = crewAt >= 0 ? layout.slice(crewAt, layout.indexOf('\n  }\n', crewAt)) : '';
ok(crewShell.includes('<ReportIssueHost') && layout.slice(crewAt + crewShell.length).includes('<ReportIssueHost'),
  'AppLayout mounts the host in BOTH shells — the crew shell and the office shell');
ok(!sidebar.includes('<ReportIssueModal') && sidebar.includes(`new CustomEvent('${OPEN_EVENT}')`), 'the Sidebar\'s button asks the host (it owns no second copy)');
ok(src('src/pages/MyDay.jsx').includes(OPEN_EVENT), 'the cleaner\'s Home offers it from the account menu (the crew shell has no tray)');

// ── 3. The crash screen ──────────────────────────────────────────────────────
const eb = src('src/components/ErrorBoundary.jsx');
// CS-193: the words are the catalog's line, shown in the reader's language.
ok(/t\('crash\.report'\)/.test(eb) && /'crash\.report': 'Report this problem',/.test(src('src/i18n/catalog/en.js')),
  'the crash screen offers to report the crash');
ok(eb.includes('submitReport'), 'it files the report itself (the store and router it needs are what crashed)');
// Matched as an import or a JSX element, not as the word — the file names the component in
// a comment explaining exactly why it cannot be used here.
ok(!/import\s+.*ReportIssueModal|<ReportIssueModal/.test(eb),
  'it does NOT mount ReportIssueModal — that needs the store, the router and Toast, which sit BELOW this boundary');
ok(/reportFailed/.test(eb), 'a failed report is shown, not swallowed');
ok(/componentStack|this\.state\.stack/.test(eb), 'the crash diagnostics ride along with the report');

// ── 4. The proxy's outbound call is bounded ──────────────────────────────────
const route = src('api/support/report.js');
ok(/AbortSignal\.timeout\(CRM_TIMEOUT_MS\)/.test(route), 'the CRM fetch is bounded by AbortSignal.timeout(CRM_TIMEOUT_MS)');
ok(Number.isFinite(CRM_TIMEOUT_MS) && CRM_TIMEOUT_MS > 0, 'CRM_TIMEOUT_MS is a positive number');
ok(CRM_TIMEOUT_MS <= 30_000, 'the timeout is well inside a serverless function budget');
// The timeout must abort into the existing "unreachable" answer, not a new unhandled path.
const fetchBlock = route.slice(route.indexOf('r = await fetch('), route.indexOf('if (r.status === 201)'));
ok(/catch\s*\{/.test(fetchBlock) && /502/.test(fetchBlock),
  'an aborted fetch falls into the catch that already answers 502 "temporarily unavailable"');
// The token is in the URL, so nothing about this call may be logged verbatim.
ok(!/console\.(error|log)\([^)]*\$\{base\}|console\.(error|log)\([^)]*token/.test(route),
  'no log line interpolates the CRM base URL or the portal token');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
