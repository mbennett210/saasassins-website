// Resolve a signature image to something an <img src> can render, across all three
// C07 shapes (see src/lib/signature.js):
//
//   NONE     → null
//   INLINE   → the data URL, synchronously (no request, no flicker)
//   STORAGE  → a short-lived signed URL fetched from /api/settings/signature-url
//
// Callers render `src && <img src={src} />` and do not care which shape they have.
// That is the point: SignaturePreview is the WYSIWYG contract for what the recipient
// sees (UI_RULES §48), and it must not sprout a per-shape branch.
//
// The request carries NO path — only the extension. The server rebuilds the object key
// from the caller's own claim, so this cannot read another user's object. See the route.
import { useEffect, useState } from 'react';
import { authHeaders } from '../lib/authHeader';
import { resolveSignatureImage, signatureExtFromPath, SIGNATURE_SHAPE } from '../lib/signature';

// `reloadKey` forces a refetch when the PATH IS UNCHANGED but the object behind it is
// not. That is the normal case on re-upload: signaturePathFor is deterministic
// (`<org>/_signatures/<uid>.png`) and the upload upserts, so replacing a PNG with a
// different PNG yields the identical path. Keying only on the path would leave the old
// image on screen with no indication anything happened. Callers that can overwrite the
// object pass a counter they bump after a successful upload.
export default function useSignatureImageSrc(prefs, reloadKey = 0) {
  const img = resolveSignatureImage(prefs);
  // Depend on the resolved path, not the prefs object: callers pass freshly-spread
  // objects (`{...draft, enabled: true}`) that are a new identity on every keystroke,
  // and re-fetching a signed URL per keystroke would be a request storm.
  const path = img.kind === SIGNATURE_SHAPE.STORAGE ? img.path : null;
  const [signedUrl, setSignedUrl] = useState(null);

  useEffect(() => {
    if (!path) { setSignedUrl(null); return undefined; }
    const ext = signatureExtFromPath(path);
    if (!ext) { setSignedUrl(null); return undefined; }

    // A stale response must never win: the user can swap images faster than a round
    // trip, and applying an out-of-order result would show the previous signature.
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/settings/signature-url?ext=${encodeURIComponent(ext)}`, {
          headers: await authHeaders(),
        });
        if (cancelled) return;
        if (!res.ok) { setSignedUrl(null); return; }
        const json = await res.json();
        if (!cancelled) setSignedUrl(json?.url || null);
      } catch {
        // Offline/local mode, or the object is gone. Render nothing rather than a
        // broken-image icon — the signature TEXT still goes out either way.
        if (!cancelled) setSignedUrl(null);
      }
    })();
    return () => { cancelled = true; };
  }, [path, reloadKey]);

  if (img.kind === SIGNATURE_SHAPE.INLINE) return img.dataUrl;
  if (img.kind === SIGNATURE_SHAPE.STORAGE) return signedUrl;
  return null;
}
