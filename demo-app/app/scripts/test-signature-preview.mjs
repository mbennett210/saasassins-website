// C07 preview path — a signed URL for the caller's OWN signature, and nothing else.
//
// The signature lives in the PRIVATE `ops-media` bucket, so the Settings preview needs
// a signed URL to render it. The obvious route shape — `?path=` — would be a read
// primitive over that whole bucket (account media, quote PDFs): AUTHORIZATION_AUDIT #5
// for the third time in this feature. So the route takes NO path, only a closed-set
// `ext`, and rebuilds the key from the caller's claim.
//
// Also pins the WYSIWYG contract: SignaturePreview must have no per-shape branch. The
// moment the preview and buildOutboundEmail disagree about which shapes exist, the user
// is looking at something other than what the recipient will get (UI_RULES §48).
//
//   node scripts/test-signature-preview.mjs
import { readFileSync } from 'node:fs';
import { SIGNATURE_EXTS } from '../api/_lib/signatureUpload.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

// ── 🔴 the route takes no path ──────────────────────────────────────────
{
  const src = read('../api/settings/signature-url.js');
  ok('the route is authed', /requireAuthority\(req, res\)/.test(src));
  ok('  ...and refuses a caller with no resolved org user', /if \(!a\.orgUserId\)/.test(src));
  ok('🔴 there is NO path/key parameter of any kind',
    !/req\.query\?\.(path|key|storagePath|object)/.test(src) && !/req\.body/.test(src));
  ok('  ...the only caller input is ext', /req\.query\?\.ext/.test(src));
  ok('🔴 ext is validated against the closed server set', /SIGNATURE_EXTS\.includes\(ext\)/.test(src));
  ok('  ...BEFORE any URL is minted',
    src.indexOf('SIGNATURE_EXTS.includes(ext)') < src.indexOf('signedSignatureUrl('));
  ok('  ...and it is lowercased first', /toLowerCase\(\)/.test(src));
  ok('the key is rebuilt from the claim', /signedSignatureUrl\(a\.orgUserId, ext\)/.test(src));
  ok('a missing object is 200 + null, not an error', /json\(\{ url \}\)/.test(src));
  ok('🔴 the signed URL is never shared-cached', /private, no-store/.test(src));
  ok('non-GET is rejected', /req\.method !== 'GET'/.test(src));
}

// ── the URL minter ──────────────────────────────────────────────────────
{
  const src = read('../api/_lib/signatureUpload.js');
  ok('signedSignatureUrl derives the path, never accepts one', /signaturePathFor\(orgUserId, ext\)/.test(src));
  ok('  ...and is short-lived by default', /expiresSeconds = 600/.test(src));
  ok('  ...returning null (not throwing) when nothing is stored', /return null; \/\/ no signature stored yet/.test(src));
  ok('the bucket constant is shared with the send path', /export const SIGNATURE_BUCKET/.test(src));
  ok('SIGNATURE_EXTS is derived from MIME_EXT, not a second literal list',
    /Object\.values\(MIME_EXT\)/.test(src));
  ok('  ...and is exactly png/jpg/gif', [...SIGNATURE_EXTS].sort().join(',') === 'gif,jpg,png');
}

// ── the hook ────────────────────────────────────────────────────────────
{
  const src = read('../src/hooks/useSignatureImageSrc.js');
  ok('inline shape returns the data URL with no request', /SIGNATURE_SHAPE\.INLINE\) return img\.dataUrl/.test(src));
  ok('storage shape returns the fetched signed URL', /SIGNATURE_SHAPE\.STORAGE\) return signedUrl/.test(src));
  // `\r?\n`, not `\n`: this reads the file off disk, and a Windows checkout has CRLF.
  // JS regex `.` excludes \r (it is a line terminator), so a bare \n here fails on the
  // correct source — a red suite that says nothing about the read path.
  ok('everything else is null', /return null;\r?\n\}/.test(src));
  // The prefs OBJECT must never be a dependency (new identity every keystroke); the
  // resolved path is, plus an explicit reload key for the re-upload case where the
  // path is deterministic and therefore unchanged. See test-signature-writer.
  ok('🔴 the effect depends on the PATH, not the prefs object',
    /\}, \[path, reloadKey\]\);/.test(src) && !/\[prefs\]/.test(src));
  ok('  ...and a stale response cannot win', /let cancelled = false/.test(src) && /if \(cancelled\) return/.test(src));
  ok('  ...with cleanup on unmount', /return \(\) => \{ cancelled = true; \};/.test(src));
  ok('the request sends no path — only ext', /signature-url\?ext=\$\{encodeURIComponent\(ext\)\}/.test(src));
  ok('  ...and is authed', /headers: await authHeaders\(\)/.test(src));
  ok('an unrecognised extension short-circuits before fetching',
    src.indexOf('if (!ext)') < src.indexOf('await fetch('));
  ok('a failure renders nothing rather than a broken image', /setSignedUrl\(null\)/.test(src));
}

// ── 🔴 WYSIWYG: the preview must not branch per shape ───────────────────
{
  const src = read('../src/components/SignaturePreview.jsx');
  ok('the preview asks the hook for a src', /useSignatureImageSrc\(prefs\)/.test(src));
  ok('🔴 ...and has NO per-shape branch of its own',
    !/imageDataUrl/.test(src) && !/imagePath/.test(src) && !/SIGNATURE_SHAPE/.test(src));
  ok('it still returns null when there is nothing to show', /if \(!text && !src\) return null;/.test(src));
  ok('the width still comes from the shared resolver', /signatureImageWidth\(prefs\)/.test(src));
  ok('  ...with height:auto and no height cap (UI_RULES §48)',
    /height: 'auto'/.test(src) && !/maxHeight/.test(src));

  // Every render site must be gated on signatureHasContent, which is false when the
  // signature is disabled — otherwise the preview shows an image the send path omits.
  const panel = read('../src/components/ConversationMessagePanel.jsx');
  const uses = (panel.match(/<SignaturePreview/g) || []).length;
  const gates = (panel.match(/signatureHasContent\(/g) || []).length;
  ok('every panel preview is gated on signatureHasContent', uses > 0 && gates >= uses);
  const account = read('../src/pages/settings/Account.jsx');
  ok('the settings preview forces enabled (it is a draft preview)',
    /<SignaturePreview prefs=\{\{ \.\.\.draft, enabled: true \}\} \/>/.test(account));
}

// ── the three routes agree on the security shape ────────────────────────
// Upload, send and preview all touch the same object. If any one of them accepts a
// caller-supplied path, the other two's claim-derivation buys nothing.
{
  const upload = read('../api/settings/signature-upload.js');
  const url = read('../api/settings/signature-url.js');
  const atts = read('../api/_lib/marketing/attachments.js');
  for (const [name, src] of [['upload', upload], ['signature-url', url], ['send resolver', atts]]) {
    ok(`🔴 ${name} never reads a caller-supplied path`,
      !/(req\.body\?\.(path|storagePath)|req\.query\?\.path|a\.storagePath)/.test(src));
  }
  ok('upload derives its path from the claim', /putSignature\(a\.orgUserId/.test(upload));
  ok('signature-url derives its path from the claim', /signedSignatureUrl\(a\.orgUserId/.test(url));
  ok('the send resolver derives its path from the claim', /signaturePathFor\(orgUserId,/.test(atts));
}

console.log(`\nsignature preview (C07 read path): ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
