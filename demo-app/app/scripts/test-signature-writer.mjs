// C07 writer flip — the client stores a PATH, and the legacy base64 is cleared.
//
// This is the commit that makes C07 actually do something: until now the reader, the
// upload route, the send path and the preview all handled `imagePath` while nothing
// ever wrote one. Two things have to be true or the feature is worse than not shipping:
//
//   1. Writing imagePath must CLEAR imageDataUrl. Otherwise the bytes stay in the
//      shared blob forever while the reader silently prefers the Storage copy — all of
//      the cost C07 exists to remove, plus a second copy.
//   2. It must need NO storage-version bump. Nothing transforms existing data and the
//      reader is default-safe on a missing field, so per CLAUDE.md this is an additive
//      slice. A needless bump would force a reseed for every local/demo user.
//
//   node scripts/test-signature-writer.mjs
// seed.js uses Vite's extensionless imports, so it cannot be imported by Node ESM —
// read as source, the same way test-blob-budget.mjs does.
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const account = read('../src/pages/settings/Account.jsx');

// ── the default shape ───────────────────────────────────────────────────
{
  const seed = read('../src/data/seed.js');
  const prefsBlock = (seed.match(/DEFAULT_SIGNATURE_PREFS = \{[\s\S]*?\n\};/) || [])[0] || '';
  ok('DEFAULT_SIGNATURE_PREFS found in seed.js', prefsBlock.length > 0);
  ok('  ...declares imagePath, defaulting to null', /imagePath: null,/.test(prefsBlock));
  ok('  ...keeps the legacy imageDataUrl, still readable', /imageDataUrl: null,/.test(prefsBlock));
  ok('  ...and the width default is unchanged', /imageWidth: 240,/.test(prefsBlock));
}

// ── 🔴 the signature imagePath field needs no migration of its own ──────
// C07 added imagePath as an additive, default-safe slice: nothing transforms
// existing data and the reader falls through safely when it is absent. The store
// has since advanced to v50 for an unrelated reason (the Opportunity entity), so
// we no longer pin an absolute version here. Instead we assert the v50 migration
// leaves signature data untouched, i.e. imagePath stayed additive across the bump.
{
  const seed = read('../src/data/seed.js');
  const persist = read('../src/store/persist.js');
  const version = (seed.match(/\n  version: (\d+),/) || [])[1];
  const key = (persist.match(/STORAGE_KEY = 'pp\.store\.v(\d+)'/) || [])[1];
  ok('seed version and STORAGE_KEY are in lockstep', version === key);
  const v49to50 = (persist.match(/function migrateV49toV50\s*\([\s\S]*?\n\}/) || [])[0] || '';
  ok('  🔴 ...and the v50 migration does not touch signature data (imagePath stays additive)',
    v49to50.length > 0 && !/imagePath|imageDataUrl|signature/i.test(v49to50));
  // The reason no signature migration is needed, asserted rather than asserted-in-a-comment:
  // the reader must fall through safely when imagePath is absent.
  ok('the reader is default-safe on a missing imagePath',
    /typeof prefs\.imagePath === 'string' && prefs\.imagePath/.test(read('../src/lib/signature.js')));
}

// ── 🔴 writing a path clears the legacy base64 ─────────────────────────
{
  ok('🔴 a successful upload sets imagePath AND nulls imageDataUrl',
    /imagePath: r\.path, imageDataUrl: null/.test(account));
  ok('  ...and the save patch carries both fields', /imageDataUrl: draft\.imageDataUrl,\s*imagePath: draft\.imagePath,/.test(account));
  ok('🔴 Remove image clears BOTH shapes',
    /imageDataUrl: null, imagePath: null/.test(account));
  ok('the draft resync reads both shapes', /imagePath: sp\.imagePath \|\| null/.test(account));
  ok('dirty-tracking includes imagePath', /\(draft\.imagePath \|\| null\) !== \(prefs\.imagePath \|\| null\)/.test(account));
  ok('image-dependent chrome keys on either shape', /const hasImage = Boolean\(draft\.imagePath \|\| draft\.imageDataUrl\)/.test(account));
  ok('  ...and the size selector uses it', /\{hasImage && \(/.test(account));
  ok('  ...as does hasContent', /hasContent = Boolean\(\(draft\.text \|\| ''\)\.trim\(\) \|\| hasImage\)/.test(account));
  ok('the old imageDataUrl-only render branches are gone',
    !/\{draft\.imageDataUrl \? \(/.test(account) && !/\{draft\.imageDataUrl && \(/.test(account));
}

// ── upload happens at pick, with feedback and a failure path ────────────
{
  ok('the upload runs on pick, not on save', /const r = await uploadSignatureImage\(dataUrl\)/.test(account));
  ok('  ...and save does not upload', !/save = async/.test(account));
  ok('a failed upload toasts and leaves the draft alone',
    /if \(!r\.ok\) \{ toast\.error\(r\.error\); return; \}/.test(account));
  ok('the button reports progress', /uploading \? 'Uploading…' : 'Add image'/.test(account));
  ok('  ...and is disabled while it runs', /disabled=\{uploading\}/.test(account));
  ok('🔴 the reload key is bumped after a successful upload', /setImageReloadKey\(\(k\) => k \+ 1\)/.test(account));
  ok('  ...and passed to the hook', /useSignatureImageSrc\(\{ \.\.\.draft, enabled: true \}, imageReloadKey\)/.test(account));
}

// ── the hook honours the reload key ─────────────────────────────────────
{
  const hook = read('../src/hooks/useSignatureImageSrc.js');
  ok('the hook accepts a reloadKey', /useSignatureImageSrc\(prefs, reloadKey = 0\)/.test(hook));
  ok('🔴 ...and refetches on it, because the path does not change on re-upload',
    /\}, \[path, reloadKey\]\);/.test(hook));
}

// ── the client sends bytes, never a path ────────────────────────────────
{
  const api = read('../src/lib/signatureApi.js');
  ok('the uploader posts only a dataUrl', /body: JSON\.stringify\(\{ dataUrl \}\)/.test(api));
  // Scoped to the REQUEST, not the whole file — the return shape and the JSDoc both
  // legitimately mention `path`, since the path is what comes BACK.
  {
    const request = (api.match(/await fetch\([\s\S]*?\n    \}\);/) || [])[0] || '';
    ok('the request block was found', request.length > 0);
    ok('🔴 ...and the outgoing request names no path at all', !/path/.test(request));
    ok('  ...it is a POST', /method: 'POST'/.test(request));
  }
  ok('it is authed', /await authHeaders\(\)/.test(api));
  ok('it returns a discriminated result rather than throwing', /\{ ok: false, error/.test(api) && /\{ ok: true, path/.test(api));
  ok('a network failure is handled (local/demo mode has no backend)', /Could not reach the server/.test(api));
}

// ── the size copy must match the enforced constant ──────────────────────
// It said "up to 1 MB" while the cap was 36 KB, so the label contradicted the error
// toast a user got for a 500 KB file.
{
  ok('the help text derives the limit from the constant',
    /up to \{Math\.round\(SIGNATURE_MAX_IMAGE_BYTES \/ 1024\)\} KB/.test(account));
  ok('  ...and the stale "1 MB" copy is gone', !/up to 1 MB/.test(account));
  ok('the constant is still 36 KB', /SIGNATURE_MAX_IMAGE_BYTES = 36 \* 1024/.test(account));
}

console.log(`\nsignature writer (C07 flip): ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
