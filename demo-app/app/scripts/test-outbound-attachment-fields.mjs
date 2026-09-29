// resolveOutboundAttachments must not drop fields — C07 prerequisite.
//
// 🔴 THE BUG. The Storage branch rebuilt each attachment from a fixed field list:
//
//     out.push({ name, mimeType, content });
//
// while the legacy branch two lines above pushes `a` UNTOUCHED. So the two branches
// disagreed about which fields survive, and only the Storage branch lost them —
// specifically `inline` and `contentId`.
//
// Harmless today: signatures are inline base64 and take the legacy branch. But C07
// turns the signature into a Storage reference. Routed through here it would arrive
// with its Content-ID stripped, google.js's `file.inline && file.contentId` test would
// fail, the part would be emitted as an ordinary attachment, and the
// `<img src="cid:cleanspace-signature">` in the HTML body would resolve to nothing —
// A BROKEN IMAGE IN EVERY EMAIL WITH A SIGNATURE, with no error anywhere.
//
// This asserts the field-preservation contract against BOTH branches, so they cannot
// drift apart again.
//
//   node scripts/test-outbound-attachment-fields.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const src = readFileSync(new URL('../api/_lib/marketing/attachments.js', import.meta.url), 'utf8');
const fn = (src.match(/export async function resolveOutboundAttachments[\s\S]*?\n}/) || [])[0] || '';
ok('resolveOutboundAttachments found', fn.length > 0);

// ── 🔴 the Storage branch must preserve, not rebuild ────────────────────
ok('the Storage branch spreads the source object', /\.\.\.rest/.test(fn) || /\.\.\.a\b/.test(fn));
ok('  ...and no longer rebuilds from a fixed 3-field literal',
  !/out\.push\(\{\s*name:[^}]*mimeType:[^}]*content:[^}]*\}\)/.test(fn));
ok('the internal storageKey is not leaked into the MIME part', /storageKey: _k/.test(fn) || /delete .*storageKey/.test(fn));
ok('name still has a fallback', /name: a\.name \|\|/.test(fn));
ok('mimeType still has a fallback', /mimeType: a\.mimeType \|\|/.test(fn));
ok('content is still the base64 of the downloaded blob', /content: buf\.toString\('base64'\)/.test(fn));

// ── both branches must agree on what survives ──────────────────────────
ok('the legacy branch still passes the object through untouched', /if \(a\.content\) \{ out\.push\(a\)/.test(fn));

// ── simulate the contract the MIME builder depends on ──────────────────
// google.js emits an inline part only when BOTH fields are present:
//     if (file.inline && file.contentId) { ... Content-ID: <cid> ... }
// so losing either one silently downgrades a signature to a plain attachment.
{
  const google = readFileSync(new URL('../api/_lib/google.js', import.meta.url), 'utf8');
  ok('google.js gates the inline part on inline && contentId', /file\.inline && file\.contentId/.test(google));
  ok('  ...and filters inline files the same way', /a\.inline && a\.contentId/.test(google));

  // The transform, mirrored: an attachment carrying inline+contentId must keep both.
  const preserve = (a, base64) => {
    const { storageKey: _k, ...rest } = a;
    return { ...rest, name: a.name || 'attachment', mimeType: a.mimeType || 'application/octet-stream', content: base64 };
  };
  const sig = { storageKey: 'sig/u1.png', name: 'signature.png', mimeType: 'image/png', inline: true, contentId: 'cleanspace-signature' };
  const resolved = preserve(sig, 'QUJD');
  ok('a resolved signature keeps inline', resolved.inline === true);
  ok('  ...keeps contentId', resolved.contentId === 'cleanspace-signature');
  ok('  ...gets its bytes', resolved.content === 'QUJD');
  ok('  ...drops the internal storageKey', resolved.storageKey === undefined);
  ok('  ...would still satisfy google.js\'s inline test', Boolean(resolved.inline && resolved.contentId));
  // The pre-fix shape, asserted as the failure it was.
  const oldShape = { name: sig.name, mimeType: sig.mimeType, content: 'QUJD' };
  ok('THE OLD SHAPE would have failed that test', !(oldShape.inline && oldShape.contentId));

  // An ordinary attachment must NOT accidentally become inline.
  const doc = preserve({ storageKey: 'a/b.pdf', name: 'quote.pdf', mimeType: 'application/pdf' }, 'QUJD');
  ok('a plain attachment stays non-inline', !(doc.inline && doc.contentId));
  ok('  ...and keeps its own name/type', doc.name === 'quote.pdf' && doc.mimeType === 'application/pdf');
  // Fallbacks still apply when the source is bare.
  const bare = preserve({ storageKey: 'x' }, 'QUJD');
  ok('a bare attachment gets fallbacks', bare.name === 'attachment' && bare.mimeType === 'application/octet-stream');
}

console.log(`\noutbound attachment fields: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
