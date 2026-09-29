// The 2026-06-21 Messaging blackout, pinned as content laws (the routing
// decision is inline in serverless handlers, so these are wiring pins in the
// style of test-windowed-jobs-assumptions):
//
//   1. The personal-inbox routing set comes from the inbox_accounts TABLE
//      (listAccountEmails) — NEVER the blob's connectedInboxes, which was
//      empty in production and diverted 100% of inbound mail to marketing.
//   2. The Gmail poll buffers ALL INBOX mail — the old replies-to-our-mail-
//      only filter discarded fresh "End of shift report" emails before they
//      were even stored (zero inbound rows for 5+ weeks).
//   3. Ingest is per-row fault-isolated — one malformed row must not wedge
//      the feed forever (the cursor only advances on success otherwise).
//   4. The client fork routes on the server-provided set (piggybacked on the
//      poll response), not the blob.
//   5. The ingest cron hard-fails (500) so Vercel cron monitoring sees red.
//
// Run: node scripts/test-inbox-routing.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (label, cond) => { if (cond) { pass += 1; console.log(`  ✓ ${label}`); } else { fail += 1; console.error(`  ✗ ${label}`); } };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const ingest = read('../api/inbox/ingest.js');
ok('ingest routes on listAccountEmails (DB truth)', /listAccountEmails\(\)/.test(ingest));
ok('ingest never reads the blob connectedInboxes for routing', !/state\.connectedInboxes/.test(ingest));
ok('ingest is per-row fault-isolated (try inside the row loop)', /for \(const r of rows\) \{\s*(\/\/[^\n]*\n\s*)*try \{/.test(ingest));
ok('ingest cron hard-fails with 500', /res\.status\(500\)\.json\(\{ ok: false/.test(ingest));

const poll = read('../api/_lib/gmailPoll.js');
ok('poll buffers all INBOX mail (reply-only filter removed)', !/getSentMessageIds/.test(poll));
ok('poll still gates on the INBOX label (the spam gate)', /labelIds\.includes\('INBOX'\)/.test(poll));

const inbound = read('../api/inbox/inbound.js');
ok('poll endpoint piggybacks personalInboxes from the DB', /listAccountEmails\(\)/.test(inbound) && /personalInboxes,/.test(inbound));

const listener = read('../src/components/InboundListener.jsx');
ok('client fork prefers the server-provided personal set', /res\.personalInboxes/.test(listener));

const accounts = read('../api/_lib/accounts.js');
ok('listAccountEmails reads inbox_accounts', /from\('inbox_accounts'\)\.select\('email'\)/.test(accounts));

console.log(`\ninbox routing: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
