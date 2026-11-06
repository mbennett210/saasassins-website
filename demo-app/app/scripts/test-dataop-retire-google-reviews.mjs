// The release data-op that takes Google reviews out of the shared record
// (app/scripts/dataop-retire-google-reviews.mjs), OFFLINE: its pure plan and the whole op on a fake
// transport — never a connection.
//   G1  on a production-shaped blob (as read, read-only, on 2026-10-20 at v645: 28 templates with the
//       review request email and text switched ON; the matrix's reviews.view / reviews.manage rows
//       for owner, admin, manager and operations_manager; the `reviews` slice { indeedActual: 0 }):
//       the dry run removes the two templates, the two matrix rows and the slice — and writes NOTHING
//   G2  nothing else moves: every other template (switch and words), every other matrix row, the
//       company, the users, every other slice
//   G3  the rarer leftovers when present: an override naming a reviews key (a row left empty is
//       dropped, a row with other keys keeps them), a member's newGoogleReview preference, the
//       company's googleReviewUrl
//   G4  --apply: a backup first (of the blob as it was), ONE compare-and-swap write, read back clean
//   G5  a second run is a no-op (no write); a blob without any of it is a no-op
//   G6  a CAS conflict writes nothing and fails
//   G7  the op refuses to run from a tree that still has Google reviews (the catalog or the matrix
//       still naming them), and the live section runs the shared guard before any read
//   G8  the offline file transport reads a saved blob and never writes
// REGRESSION (THE LAW II.3): on 9d2669cd there is no op — every check fails.
//   node app/scripts/test-dataop-retire-google-reviews.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${JSON.stringify(detail)})`); };
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const OP = await soft('./dataop-retire-google-reviews.mjs');
const CM = await soft('../src/lib/customerMessages.js');
const ROLES = await soft('../src/lib/roles.js');
ok('the op loads (and importing it opens nothing)', typeof OP.planRetireGoogleReviews === 'function' && typeof OP.runRetireGoogleReviewsOp === 'function', OP.__error);
const canonical = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const RM = OP.RETIRED_MESSAGE_KEYS || [];
const RP = OP.RETIRED_PERMISSION_KEYS || [];

// Production as read on 2026-10-20 (v645): every template the catalog builds plus the welcome email
// (the seed's own set, DEFAULT_REMINDER_TEMPLATES) AND the two review request templates the
// approved-messages release stored, switched on; the matrix as seeded plus the two reviews rows
// (the four office columns, with their labels); the Indeed count.
const reviewTemplate = (key) => ({ id: `rt_${key}`, key, channel: key.endsWith('_sms') ? 'sms' : 'email', subject: key.endsWith('_sms') ? '' : 'How are we doing?', body: 'stored words {review_link}', enabled: true });
const reviewRow = (id, label) => ({ id, label, roles: ['owner', 'admin', 'manager', 'operations_manager'] });
const prodBlob = () => ({
  version: 56,
  company: { name: 'Clean Space', timezone: 'America/New_York', phone: '1-754-254-0375' },
  users: [
    { id: 'u_owner', role: 'owner', status: 'active', notificationPrefs: { newClientMessage: true } },
    { id: 'u_mgr', role: 'manager', status: 'active', notificationPrefs: {} },
  ],
  permissions: [
    ...(ROLES.seedPermissions ? ROLES.seedPermissions() : []),
    reviewRow('reviews.view', 'View reviews / reputation'),
    reviewRow('reviews.manage', 'Manage the Google listing (replies, posts, photos)'),
  ],
  userPermissionOverrides: [{ userId: 'u_mgr', grants: ['quotes.view'], revokes: [] }],
  reminderTemplates: [
    ...(CM.DEFAULT_REMINDER_TEMPLATES || []).map((t) => ({ ...t })),
    reviewTemplate('review_request'),
    reviewTemplate('review_request_sms'),
  ],
  reviews: { indeedActual: 0 },
  clientReview: { sections: {}, drafts: { 'review-request': { status: 'accepted', at: '2026-09-30T14:45:35.374Z' } }, picks: {}, decisions: {} },
  jobs: [],
});
function fakeT(blob, { conflict = false } = {}) {
  const t = { writes: 0, row: { state: structuredClone(blob), version: 645 } };
  t.readOrgState = async () => structuredClone(t.row);
  t.casWrite = async ({ baseVersion, state }) => {
    t.writes += 1;
    if (conflict || baseVersion !== t.row.version) return [];
    t.row = { state: structuredClone(state), version: t.row.version + 1 };
    return [{ version: t.row.version }];
  };
  return t;
}
const quiet = () => { const lines = []; return { log: (...a) => lines.push(a.join(' ')), err: (...a) => lines.push(a.join(' ')), lines }; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dataop-rgr-'));
const backupDir = pathToFileURL(`${tmp}/`);

if (typeof OP.planRetireGoogleReviews === 'function') {
  ok('the retired names are the stored ones the code no longer has', canonical(RM) === canonical(['review_request', 'review_request_sms']) && canonical(RP) === canonical(['reviews.view', 'reviews.manage'])
    && !(CM.CUSTOMER_MESSAGES || []).some((m) => RM.includes(m.key)) && RP.every((k) => !(k in (ROLES.PERMISSIONS || { [k]: 1 }))));

  // ── G1 the dry run on production's shape ──
  const before = prodBlob();
  const plan = OP.planRetireGoogleReviews(before);
  ok('🔴 G1a the review request email and text are REMOVED from reminderTemplates (both were on)', !plan.state.reminderTemplates.some((t) => RM.includes(t.key))
    && canonical(plan.removed.templates) === canonical([{ id: 'rt_review_request', key: 'review_request', enabled: true }, { id: 'rt_review_request_sms', key: 'review_request_sms', enabled: true }]), plan.removed.templates);
  ok('🔴 G1b the two reviews rows leave the stored matrix', !plan.state.permissions.some((p) => RP.includes(p.id)) && canonical(plan.removed.permissions) === canonical(RP), plan.removed.permissions);
  ok('G1c the retired `reviews` slice (the Indeed count) is removed', !('reviews' in plan.state) && canonical(plan.removed.slices) === canonical(['reviews']));
  ok('G1d production has none of the rarer leftovers', plan.removed.overrides.length === 0 && plan.removed.notificationPrefs.length === 0 && plan.removed.companyFields.length === 0);
  const t1 = fakeT(prodBlob());
  const o1 = quiet();
  const rc1 = await OP.runRetireGoogleReviewsOp({ t: t1, org: 'org', apply: false, backupDir, log: o1.log, err: o1.err });
  ok('🔴 G1e the dry run writes NOTHING (and says so, naming what it would remove)', rc1 === 0 && t1.writes === 0 && o1.lines.some((l) => /--dry-run/.test(l))
    && o1.lines.some((l) => /review_request \(rt_review_request, on\)/.test(l)) && o1.lines.some((l) => /reviews\.view, reviews\.manage/.test(l)), o1.lines);

  // ── G2 nothing else ──
  const strip = (s) => { const c = { ...s }; delete c.reminderTemplates; delete c.permissions; delete c.reviews; return c; };
  ok('🔴 G2a no other slice moves (company, users, overrides, clientReview — Matt\'s answer stays)', canonical(strip(plan.state)) === canonical(strip(before)));
  const otherT = (s) => s.reminderTemplates.filter((t) => !RM.includes(t.key));
  ok('G2b every other template is exactly as stored (switch and words)', canonical(otherT(plan.state)) === canonical(otherT(before)) && plan.state.reminderTemplates.length === before.reminderTemplates.length - 2);
  const otherP = (s) => s.permissions.filter((p) => !RP.includes(p.id));
  ok('G2c every other matrix row is exactly as stored', canonical(otherP(plan.state)) === canonical(otherP(before)) && plan.state.permissions.length === before.permissions.length - 2);

  // ── G3 the rarer leftovers ──
  const rare = prodBlob();
  rare.userPermissionOverrides = [
    { userId: 'u_mgr', grants: ['reviews.manage'], revokes: [] },
    { userId: 'u_owner', grants: ['quotes.view'], revokes: ['reviews.view'] },
    { userId: 'u_x', grants: ['marketing.view'], revokes: [] },
  ];
  rare.users[1].notificationPrefs = { newGoogleReview: true, newClientMessage: false };
  rare.company.googleReviewUrl = 'https://g.page/r/x/review';
  const rp = OP.planRetireGoogleReviews(rare);
  ok('G3a an override row left with nothing is dropped; one with other keys keeps them; an unrelated row is untouched',
    canonical(rp.state.userPermissionOverrides) === canonical([{ userId: 'u_owner', grants: ['quotes.view'], revokes: [] }, { userId: 'u_x', grants: ['marketing.view'], revokes: [] }])
    && rp.removed.overrides.length === 2, rp.state.userPermissionOverrides);
  ok('G3b a member\'s newGoogleReview preference is removed, the rest of their preferences kept', canonical(rp.state.users[1].notificationPrefs) === canonical({ newClientMessage: false })
    && canonical(rp.state.users[0]) === canonical(rare.users[0]) && canonical(rp.removed.notificationPrefs) === canonical(['u_mgr']));
  ok('G3c the company\'s googleReviewUrl is removed, every other company field kept', !('googleReviewUrl' in rp.state.company) && rp.state.company.phone === rare.company.phone && rp.state.company.timezone === rare.company.timezone);

  // ── G4 apply ──
  const t4 = fakeT(prodBlob());
  const o4 = quiet();
  const rc4 = await OP.runRetireGoogleReviewsOp({ t: t4, org: 'org', apply: true, backupDir, log: o4.log, err: o4.err, now: new Date('2026-10-20T18:00:00Z') });
  const backups = fs.readdirSync(tmp).filter((f) => f.startsWith('orgstate-backup-'));
  ok('🔴 G4 --apply: ONE write, a backup first (of the blob as it was), read back clean', rc4 === 0 && t4.writes === 1 && t4.row.version === 646 && backups.length === 1
    && JSON.parse(fs.readFileSync(path.join(tmp, backups[0]), 'utf8')).state.reminderTemplates.some((t) => t.key === 'review_request')
    && canonical(t4.row.state) === canonical(OP.planRetireGoogleReviews(prodBlob()).state), { rc4, writes: t4.writes, tail: o4.lines.slice(-3) });

  // ── G5 idempotent ──
  const o5 = quiet();
  const rc5 = await OP.runRetireGoogleReviewsOp({ t: t4, org: 'org', apply: true, backupDir, log: o5.log, err: o5.err });
  ok('🔴 G5a a second run is a no-op: no write', rc5 === 0 && t4.writes === 1 && o5.lines.some((l) => /No-op/.test(l)), o5.lines.slice(-2));
  const clean = OP.planRetireGoogleReviews({ reminderTemplates: [], permissions: [], users: [], company: {} });
  ok('G5b a blob with none of it is a no-op', clean.changed === false);

  // ── G6 conflict ──
  const t6 = fakeT(prodBlob(), { conflict: true });
  const o6 = quiet();
  const rc6 = await OP.runRetireGoogleReviewsOp({ t: t6, org: 'org', apply: true, backupDir, log: o6.log, err: o6.err });
  ok('G6 a CAS conflict: nothing written, exit 1', rc6 === 1 && t6.row.version === 645 && o6.lines.some((l) => /CAS conflict/.test(l)));

  // ── G7 the tree check + the guard ──
  ok('G7a this tree has removed Google reviews (stillInCode is empty)', typeof OP.stillInCode === 'function' && OP.stillInCode().length === 0, OP.stillInCode?.());
  const t7 = fakeT(prodBlob());
  const o7 = quiet();
  const rc7 = await OP.runRetireGoogleReviewsOp({ t: t7, org: 'org', apply: true, backupDir, log: o7.log, err: o7.err, inCode: () => ['review_request'] });
  ok('🔴 G7b from a tree that still has them, the op refuses before any read or write', rc7 === 1 && t7.writes === 0 && o7.lines.some((l) => /still has Google reviews/.test(l)), o7.lines);
  const src = fs.readFileSync(fileURLToPath(new URL('./dataop-retire-google-reviews.mjs', import.meta.url)), 'utf8');
  ok('G7c the live section runs the shared guard (refuseTarget) and names the target (printTarget) before any read', /refuseTarget\(\{ transport, ref, prod: PROD, confirmProd: process\.env\.CONFIRM_PROD \}\)/.test(src) && src.indexOf('printTarget({') < src.indexOf("await import('pg')"));

  // ── G8 offline ──
  const file = path.join(tmp, 'blob.json');
  fs.writeFileSync(file, JSON.stringify({ version: 645, state: prodBlob() }));
  const ft = OP.fileTransport(file);
  let threw = false;
  try { await ft.casWrite({}); } catch { threw = true; }
  const o8 = quiet();
  const rc8 = await OP.runRetireGoogleReviewsOp({ t: ft, org: 'org', apply: false, backupDir, log: o8.log, err: o8.err });
  ok('G8 the offline file transport reads a saved blob, dry-runs it and never writes', threw && rc8 === 0 && o8.lines.some((l) => /v645/.test(l)) && o8.lines.some((l) => /--dry-run/.test(l)), o8.lines.slice(0, 3));
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`test-dataop-retire-google-reviews: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
