// The store round trip — the hop every other signature test skipped.
//
// ══ WHY THIS FILE EXISTS ══════════════════════════════════════════════════════
// C07 shipped `imagePath` through the reader, the upload route, the send path and the
// preview. Every one of those has a test. All of them PASSED. The feature was still
// 100% non-functional, because selectSignaturePrefs hand-builds its return object and
// the field was not in the list — so `imagePath` was `undefined` for every consumer.
//
// Every existing signature test builds a prefs object BY HAND and calls
// resolveSignatureImage / buildOutboundEmail directly, or regex-greps Account.jsx. Not
// one of them read prefs THROUGH THE SELECTOR. The single hop between the store and
// every consumer was the one thing nobody covered, and it was where the bug was.
//
// Worse than a read returning undefined: settings/Account.jsx reads this selector into a
// local draft and dispatches that draft back, so an unrelated text edit wrote
// `imagePath: null` over a real reference — A READ BUG THAT CAUSED DATA LOSS.
//
// So this asserts the selector against the SEED DEFAULTS, which makes the coverage
// self-maintaining: a new signaturePrefs field cannot be added without failing here
// until the selector carries it.
//
//   node scripts/test-signature-store-roundtrip.mjs
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const selectorsSrc = read('../src/store/selectors.js');
const seedSrc = read('../src/data/seed.js');

// ── 🔴 the selector must carry EVERY field the entity declares ──────────
{
  const prefsBlock = (seedSrc.match(/DEFAULT_SIGNATURE_PREFS = \{[\s\S]*?\n\};/) || [])[0] || '';
  ok('DEFAULT_SIGNATURE_PREFS found', prefsBlock.length > 0);
  const seedFields = [...prefsBlock.matchAll(/^\s{2}(\w+)\s*:/gm)].map((m) => m[1]);
  ok(`seed declares the expected fields (${seedFields.join(', ')})`, seedFields.length >= 5);

  const selBlock = (selectorsSrc.match(/export const selectSignaturePrefs = [\s\S]*?\n\};/) || [])[0] || '';
  ok('selectSignaturePrefs found', selBlock.length > 0);
  const returned = [...selBlock.matchAll(/^\s{4}(\w+)\s*:/gm)].map((m) => m[1]);

  const missing = seedFields.filter((f) => !returned.includes(f));
  ok(`🔴 the selector returns every seed field (returns: ${returned.join(', ')}; MISSING: ${missing.join(', ') || 'none'})`,
    missing.length === 0);
  // Named explicitly too, so the intent survives a refactor of the extraction above.
  for (const f of ['enabled', 'text', 'imageDataUrl', 'imagePath', 'imageWidth']) {
    ok(`  ...carries ${f}`, returned.includes(f));
  }
}

// ── simulate the round trip that caused the data loss ───────────────────
// Account.jsx: draftFrom(prefs) -> user edits text -> dispatch(patch from draft).
// If the selector drops a field, the draft has undefined for it, and the dispatch
// writes that over a real stored value.
{
  // Mirror of the selector, derived from its source so it cannot drift from the real one.
  const selBlock = (selectorsSrc.match(/export const selectSignaturePrefs = [\s\S]*?\n\};/) || [])[0] || '';
  const returned = [...selBlock.matchAll(/^\s{4}(\w+)\s*:/gm)].map((m) => m[1]);
  const select = (sp) => {
    const out = {};
    for (const f of returned) {
      if (f === 'enabled') out.enabled = sp?.enabled ?? true;
      else if (f === 'text') out.text = sp?.text ?? '';
      else if (f === 'imageWidth') out.imageWidth = sp?.imageWidth ?? 240;
      else out[f] = sp?.[f] ?? null;
    }
    return out;
  };

  const stored = { enabled: true, text: 'Kyle', imageDataUrl: null, imagePath: 'org/_signatures/u_kyle.png', imageWidth: 240 };

  // 1. read
  const prefs = select(stored);
  ok('🔴 a stored imagePath survives the selector', prefs.imagePath === 'org/_signatures/u_kyle.png');

  // 2. Account.jsx draftFrom
  const draft = {
    text: prefs.text || '',
    imageDataUrl: prefs.imageDataUrl || null,
    imagePath: prefs.imagePath || null,
    imageWidth: prefs.imageWidth ?? 240,
  };
  ok('  ...and reaches the settings draft', draft.imagePath === stored.imagePath);

  // 3. user edits only the TEXT, then Saves — the patch carries every field
  const edited = { ...draft, text: 'Kyle Boyden' };
  const patch = {
    text: edited.text,
    imageDataUrl: edited.imageDataUrl,
    imagePath: edited.imagePath,
    imageWidth: edited.imageWidth,
  };
  // 4. reducer merge (reducer.js: { ...(u.signaturePrefs || {}), ...patch })
  const after = { ...stored, ...patch };
  ok('🔴 an unrelated text edit does NOT wipe the stored path', after.imagePath === stored.imagePath);
  ok('  ...and the edit itself applied', after.text === 'Kyle Boyden');

  // The dirty check must also settle after a save, or the "unsaved changes" bar sticks.
  const reread = select(after);
  const dirty = (draft.imagePath || null) !== (reread.imagePath || null);
  ok('🔴 the dirty check settles after a save (no stuck "unsaved changes" bar)', dirty === false);
}

// ── the consumers that read through the selector ────────────────────────
{
  const panel = read('../src/components/ConversationMessagePanel.jsx');
  ok('the send path sources prefs from the selector, not from a hand-built object',
    /selectSignaturePrefs\(/.test(panel));
  const account = read('../src/pages/settings/Account.jsx');
  ok('settings reads the same selector', /selectSignaturePrefs\(/.test(account));
  ok('  ...and round-trips it back into a dispatch (which is why a dropped field deletes data)',
    /imagePath: draft\.imagePath/.test(account));
}

// ── the same rebuild pattern in the migration chain ─────────────────────
{
  const persist = read('../src/store/persist.js');
  const mig = (persist.match(/function migrateV45toV46[\s\S]*?\n\}/) || [])[0] || '';
  ok('migrateV45toV46 found', mig.length > 0);
  ok('🔴 it SPREADS existing prefs rather than rebuilding from a fixed list',
    /\.\.\.\(u\.signaturePrefs \|\| \{\}\)/.test(mig));
}

console.log(`\nsignature store round trip: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
