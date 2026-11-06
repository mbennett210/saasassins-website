// CS-043 regression: an access attachment or an office-note attachment must end up as
// BYTES in Storage with a path on the record — not metadata pointing at nothing.
//
// Before this, LocationCard and ClientDetail stored `{ name, size, type }` and the file was
// never uploaded anywhere. The read view rendered a filename chip with no link, while the
// copy beside it promised crew "site maps, gate codes, walkthrough PDFs". Staff attached
// documents nobody could open.
//
// Offline: no Supabase, no network. Asserts the shared validation rule, the object-key
// construction, and the path-ownership guard — the parts that decide whether a file is
// reachable and whether a caller can reach SOMEONE ELSE'S file.
// Run: node app/scripts/test-site-attachments.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SITE_ATTACHMENT_MAX_BYTES, SITE_ATTACHMENT_ALLOWED_MIME, SITE_ATTACHMENT_EXT,
  ATTACHMENT_SCOPE, ATTACHMENT_SCOPES, isAttachmentScope, validateSiteAttachment,
} from '../src/lib/siteAttachmentRules.js';
import { attachmentPrefix, assertOwnedPath, newObjectPath, DOWNLOAD_URL_TTL_SECONDS } from '../api/_lib/siteAttachments/store.js';
import { CLEANSPACE_ORG_ID } from '../api/_lib/constants.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };
const throws = (fn, msg) => { let t = false; try { fn(); } catch { t = true; } ok(t, msg); };

console.log('CS-043 — access + note attachments actually upload\n');

// ── 1. The validation rule, shared by browser and server ─────────────────────
ok(validateSiteAttachment({ mimeType: 'application/pdf', sizeBytes: 1024 }).ok, 'a small PDF is accepted');
ok(!validateSiteAttachment({ mimeType: 'application/pdf', sizeBytes: SITE_ATTACHMENT_MAX_BYTES + 1 }).ok,
  'a file one byte over SITE_ATTACHMENT_MAX_BYTES is refused');
ok(validateSiteAttachment({ mimeType: 'application/pdf', sizeBytes: SITE_ATTACHMENT_MAX_BYTES }).ok,
  'a file exactly at SITE_ATTACHMENT_MAX_BYTES is accepted (the boundary, from the constant)');
ok(!validateSiteAttachment({ mimeType: 'application/x-msdownload', sizeBytes: 10 }).ok, 'an executable is refused');
ok(!validateSiteAttachment({ mimeType: '', sizeBytes: 10 }).ok, 'a typeless file is refused');
ok(!validateSiteAttachment({}).ok, 'an empty descriptor is refused');
for (const m of SITE_ATTACHMENT_ALLOWED_MIME) {
  ok(validateSiteAttachment({ mimeType: m, sizeBytes: 1 }).ok, `${m} is accepted`);
  ok(typeof SITE_ATTACHMENT_EXT[m] === 'string' && SITE_ATTACHMENT_EXT[m].length > 0,
    `${m} maps to a file extension (the key's extension never comes from the filename)`);
}

// ── 2. The object key is built server-side, under the org + scope + owner ────
const sitePath = newObjectPath({ scope: ATTACHMENT_SCOPE.SITE, ownerId: 'st_loc_cl_1', mimeType: 'application/pdf' });
ok(sitePath.startsWith(`${CLEANSPACE_ORG_ID}/site-attachments/${ATTACHMENT_SCOPE.SITE}/st_loc_cl_1/`),
  'a site attachment lands under <org>/site-attachments/site/<siteId>/');
ok(sitePath.endsWith('.pdf'), 'the extension comes from the MIME map');
ok(newObjectPath({ scope: ATTACHMENT_SCOPE.SITE, ownerId: 'st_loc_cl_1', mimeType: 'application/pdf' }) !== sitePath,
  'each upload gets its own object name (no overwrite of an earlier file)');
const notePath = newObjectPath({ scope: ATTACHMENT_SCOPE.CLIENT_NOTE, ownerId: 'cl_1', mimeType: 'image/png' });
ok(notePath.startsWith(`${CLEANSPACE_ORG_ID}/site-attachments/${ATTACHMENT_SCOPE.CLIENT_NOTE}/cl_1/`),
  'a note attachment lands under its own scope prefix');
ok(notePath.endsWith('.png'), 'a PNG keeps a png extension');
// The two scopes cannot collide, so a note file can never be served as a site file.
ok(attachmentPrefix(ATTACHMENT_SCOPE.SITE, 'x1') !== attachmentPrefix(ATTACHMENT_SCOPE.CLIENT_NOTE, 'x1'),
  'the same owner id in different scopes yields different prefixes');

// ── 3. Traversal: an id is interpolated into a Storage key, so it is validated ─
for (const bad of ['../../_signatures', 'a/b', '..', '', 'x'.repeat(200), 'a.b', 'a\\b', '%2e%2e']) {
  throws(() => attachmentPrefix(ATTACHMENT_SCOPE.SITE, bad), `ownerId ${JSON.stringify(bad)} is refused`);
}
throws(() => attachmentPrefix('../../', 'st_1'), 'an unknown scope is refused, never defaulted');
ok(!isAttachmentScope('anything_else') && ATTACHMENT_SCOPES.every(isAttachmentScope),
  'the scope set is closed');

// ── 4. A supplied storagePath must fall under the owner's own prefix ─────────
// It arrives from org_state, which the browser can write. Unchecked it would be a read AND
// delete primitive over this whole private bucket — including every account photo.
const mine = `${attachmentPrefix(ATTACHMENT_SCOPE.SITE, 'st_a')}abc123.pdf`;
ok(assertOwnedPath(ATTACHMENT_SCOPE.SITE, 'st_a', mine) === mine, "a path under the owner's prefix is accepted");
throws(() => assertOwnedPath(ATTACHMENT_SCOPE.SITE, 'st_b', mine), "another SITE's object is refused");
throws(() => assertOwnedPath(ATTACHMENT_SCOPE.CLIENT_NOTE, 'st_a', mine), "the same id in another SCOPE is refused");
throws(() => assertOwnedPath(ATTACHMENT_SCOPE.SITE, 'st_a', `${attachmentPrefix(ATTACHMENT_SCOPE.SITE, 'st_a')}../st_b/x.pdf`),
  'a traversal below the prefix is refused');
throws(() => assertOwnedPath(ATTACHMENT_SCOPE.SITE, 'st_a', `${attachmentPrefix(ATTACHMENT_SCOPE.SITE, 'st_a')}deeper/x.pdf`),
  'a deeper path than this app ever mints is refused');
throws(() => assertOwnedPath(ATTACHMENT_SCOPE.SITE, 'st_a', attachmentPrefix(ATTACHMENT_SCOPE.SITE, 'st_a')),
  'the bare prefix (no object) is refused');
throws(() => assertOwnedPath(ATTACHMENT_SCOPE.SITE, 'st_a', `${CLEANSPACE_ORG_ID}/st_a/x.pdf`),
  'a path outside the site-attachments root is refused');
throws(() => assertOwnedPath(ATTACHMENT_SCOPE.SITE, 'st_a', null), 'a null path is refused');
// Every object this app mints passes its own guard — the write and read sides agree.
ok(assertOwnedPath(ATTACHMENT_SCOPE.SITE, 'st_c', newObjectPath({ scope: ATTACHMENT_SCOPE.SITE, ownerId: 'st_c', mimeType: 'image/webp' })),
  'a freshly minted key passes the ownership guard it will be read back through');

ok(Number.isFinite(DOWNLOAD_URL_TTL_SECONDS) && DOWNLOAD_URL_TTL_SECONDS > 0 && DOWNLOAD_URL_TTL_SECONDS <= 3600,
  'a download URL is short-lived (an hour at most)');

// ── 5. The wiring: every surface that takes a file must upload it ────────────
// This is the CS-043 rule as a rule, not as one fixed screen: a component that pushes a
// bare {name,size,type} into state is the exact defect, so no surface may do it again.
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
for (const [file, scope] of [
  ['src/components/LocationCard.jsx', 'ATTACHMENT_SCOPE.SITE'],
  ['src/pages/ClientDetail.jsx', 'ATTACHMENT_SCOPE.CLIENT_NOTE'],
]) {
  const text = src(file);
  ok(text.includes('uploadSiteAttachment('), `${file} uploads the bytes`);
  ok(text.includes(scope), `${file} uploads under ${scope}`);
  ok(text.includes('attachmentUrl('), `${file} opens the file by signed URL`);
  ok(text.includes('deleteSiteAttachment('), `${file} removes the bytes when the row goes`);
  ok(!/\{\s*name:\s*f\.name,\s*size:\s*f\.size,\s*type:\s*f\.type\s*\}/.test(text),
    `${file} no longer stores bare {name,size,type} metadata with no file behind it`);
  // ONE cap. Both surfaces used to size-check against lib/attachments'
  // ATTACHMENT_MAX_BYTES — a different constant from the one the server enforces, which
  // merely happened to hold the same number. Two caps for one upload is how the browser
  // starts accepting a file the server will refuse.
  // Matched on the IMPORT, not the bare word — each file names the old constant in a
  // comment explaining what it used to read.
  ok(/import\s*\{[^}]*\bSITE_ATTACHMENT_MAX_BYTES\b[^}]*\}\s*from\s*'[^']*siteAttachmentRules'/.test(text),
    `${file} imports SITE_ATTACHMENT_MAX_BYTES, the cap the server enforces`);
  ok(!/import\s*\{[^}]*(^|[^_])\bATTACHMENT_MAX_BYTES\b[^}]*\}\s*from\s*'[^']*attachments'/m.test(text),
    `${file} no longer imports lib/attachments' separate ATTACHMENT_MAX_BYTES for these files`);
}

// The new api domain is multi-segment, so it needs its vercel.json rewrite or every call
// 404s in production while working locally.
const vercel = JSON.parse(src('vercel.json'));
ok(vercel.rewrites.some((r) => r.source === '/api/site-attachments/:rest*'),
  'app/vercel.json rewrites /api/site-attachments/* to the catch-all');

// Authorization must be per scope and must never be `requireAuth` alone.
const route = src('api/site-attachments/[...path].js');
ok(route.includes('requireSiteAssignment'), 'the site scope is gated on site assignment');
ok(route.includes("'sites.attachments'"), 'a site WRITE additionally requires sites.attachments');
ok(route.includes("'clients.edit'") && route.includes("'clients.view'"),
  'the note scope mirrors the customer record’s own view/edit permissions');
ok(!/requireAuth\s*\(/.test(route), 'the route never authorizes with requireAuth alone');

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
