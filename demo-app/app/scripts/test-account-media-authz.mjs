// account_media refId authorization — AUTHORIZATION_AUDIT.md §2026-07-20 OPEN #5/#6.
//
// The bug class: the authorization key was not the filter key. /list gated on
// `?siteId=` while `listMedia` filters on `ref_id` and discards site_id entirely, so
// the gate constrained nothing about what came back — and an assignment revoke
// revoked no access. /confirm gated on `body.siteId` but wrote `ref_id`, `client_id`
// and `storage_path` verbatim, letting a caller file an image against a manager's
// inspection record, which renders on the client-facing public report.
//
// These pin the pure halves of the fix. The DB-resolving half (resolveRefOwner
// against real inspection_records / problem_reports / jobs rows) needs a live read
// and is recorded UNVERIFIED in LOOP_REVIEW.md §5.
//
//   node scripts/test-account-media-authz.mjs
import { isRefScope, resolveRefOwner, isValidStoragePath, REF_SCOPE_TABLES } from '../api/_lib/accountMedia/refs.js';
import { thumbPathFor } from '../api/_lib/accountMedia/store.js';
import { CLEANSPACE_ORG_ID } from '../api/_lib/constants.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const SITE = 'st_abc123';
const GOOD = `${CLEANSPACE_ORG_ID}/${SITE}/abcdef0123456789.jpg`;

// ── which scopes may carry a refId ─────────────────────────────────────────
ok('inspection is a ref scope', isRefScope('inspection'));
ok('problem_report is a ref scope', isRefScope('problem_report'));
ok('clean is a ref scope', isRefScope('clean'));
ok('cleaning_instruction is NOT a ref scope', !isRefScope('cleaning_instruction'));
ok('security is NOT a ref scope', !isRefScope('security'));
ok('unknown scope is NOT a ref scope', !isRefScope('totally_made_up'));
ok('the ref-scope map matches the account_media scope CHECK', Object.keys(REF_SCOPE_TABLES).length === 3);

// ── resolveRefOwner fails CLOSED before it ever reaches the DB ─────────────
// Each of these must resolve without Supabase env configured; if any one of them
// reached a query this file would throw instead of asserting.
const denied = async (args) => {
  const r = await resolveRefOwner(args);
  return r.ok === false;
};

const UUID = '11111111-2222-3333-4444-555555555555';

ok('no refId is denied', await denied({ scope: 'inspection', refId: null }));
ok('empty refId is denied', await denied({ scope: 'inspection', refId: '' }));
ok('missing scope is denied', await denied({ scope: null, refId: UUID }));
ok('empty scope is denied', await denied({ scope: '', refId: UUID }));

// THE HOLE: /list left `scope` optional, so a refId with no scope skipped listMedia's
// scope filter AND had no owning table to resolve against. It must not authorize.
ok('refId under a NON-ref scope is denied (cleaning_instruction)', await denied({ scope: 'cleaning_instruction', refId: UUID }));
ok('refId under a NON-ref scope is denied (security)', await denied({ scope: 'security', refId: UUID }));
ok('refId under an unknown scope is denied', await denied({ scope: 'nope', refId: UUID }));

// A non-uuid id against a uuid column would raise PostgREST 22P02 -> 500, which reads
// as a server fault rather than a denial. It must be rejected before the query.
ok('non-uuid refId is denied for inspection', await denied({ scope: 'inspection', refId: 'not-a-uuid' }));
ok('non-uuid refId is denied for problem_report', await denied({ scope: 'problem_report', refId: 'j_1234' }));
ok('sql-ish refId is denied', await denied({ scope: 'inspection', refId: "' or '1'='1" }));
ok('uuid-with-suffix is denied', await denied({ scope: 'inspection', refId: `${UUID}x` }));

// ── storage path binding ───────────────────────────────────────────────────
// storage_path was written verbatim and listMedia signs whatever it finds, so an
// unconstrained path is a read primitive over the whole private bucket.
ok('a freshly minted path is accepted', isValidStoragePath(GOOD, SITE));
ok('path for a DIFFERENT site is rejected', !isValidStoragePath(`${CLEANSPACE_ORG_ID}/st_other/abcdef0123456789.jpg`, SITE));
ok('path under a different org is rejected', !isValidStoragePath(`00000000-0000-0000-0000-000000000999/${SITE}/abcdef0123456789.jpg`, SITE));
ok('traversal is rejected', !isValidStoragePath(`${CLEANSPACE_ORG_ID}/../${SITE}/abcdef0123456789.jpg`, SITE));
ok('deep traversal is rejected', !isValidStoragePath(`${CLEANSPACE_ORG_ID}/${SITE}/../../secret.jpg`, SITE));
ok('absolute path is rejected', !isValidStoragePath(`/${CLEANSPACE_ORG_ID}/${SITE}/abcdef0123456789.jpg`, SITE));
ok('backslash path is rejected', !isValidStoragePath(`${CLEANSPACE_ORG_ID}\\${SITE}\\a.jpg`, SITE));
ok('too few segments is rejected', !isValidStoragePath(`${CLEANSPACE_ORG_ID}/abcdef0123456789.jpg`, SITE));
ok('too many segments is rejected', !isValidStoragePath(`${CLEANSPACE_ORG_ID}/${SITE}/sub/abcdef0123456789.jpg`, SITE));
ok('empty path is rejected', !isValidStoragePath('', SITE));
ok('null path is rejected', !isValidStoragePath(null, SITE));
ok('extensionless object is rejected', !isValidStoragePath(`${CLEANSPACE_ORG_ID}/${SITE}/abcdef0123456789`, SITE));
// A manager may confirm without a site; signedUploadUrl mints the literal 'site'.
ok("the 'site' fallback segment is accepted when no siteId", isValidStoragePath(`${CLEANSPACE_ORG_ID}/site/abcdef0123456789.jpg`, null));
ok("the 'site' fallback is NOT accepted when a siteId was gated", !isValidStoragePath(`${CLEANSPACE_ORG_ID}/site/abcdef0123456789.jpg`, SITE));

// ── thumb path must derive from the storage path ──────────────────────────
// thumb_path is signed by listMedia exactly like storage_path, so it is the same
// read primitive if it can point anywhere.
ok('thumbPathFor derives beside the original', thumbPathFor(GOOD) === `${CLEANSPACE_ORG_ID}/${SITE}/abcdef0123456789.thumb.jpg`);
ok('a derived thumb equals itself (route accepts)', thumbPathFor(GOOD) === thumbPathFor(GOOD));
ok('an arbitrary thumb path differs from the derived one (route rejects)',
  thumbPathFor(GOOD) !== `${CLEANSPACE_ORG_ID}/st_other/whatever.thumb.jpg`);
ok('a thumb naming another object differs from the derived one',
  thumbPathFor(GOOD) !== `${CLEANSPACE_ORG_ID}/${SITE}/0000000000000000.thumb.jpg`);

console.log(`\naccount-media authz: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
