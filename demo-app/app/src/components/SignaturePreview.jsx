import { signatureImageWidth } from '../lib/signature';
import useSignatureImageSrc from '../hooks/useSignatureImageSrc';

// WYSIWYG source of truth for how a signature renders in an outbound email
// (UI_RULES §48). The text preserves line breaks (pre-wrap) and the image is
// scaled to the resolved display width with height:auto — NO height cap — so
// what the user sees here matches exactly what buildOutboundEmail sends.
// Returns null when there is nothing to show, so callers can gate their chrome.
//
// The image source comes from useSignatureImageSrc, which handles all three C07
// shapes (none / inline data URL / Storage path via a signed URL). This component
// deliberately has no per-shape branch: the moment the preview and the send path
// disagree about which shapes exist, WYSIWYG is broken.
export default function SignaturePreview({ prefs }) {
  const text = (prefs?.text || '').trim();
  const src = useSignatureImageSrc(prefs);
  if (!text && !src) return null;
  return (
    <>
      {text && (
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, color: 'var(--text-body)' }}>{prefs.text}</div>
      )}
      {src && (
        <img
          src={src}
          alt="Signature"
          style={{ maxWidth: signatureImageWidth(prefs), height: 'auto', display: 'block', marginTop: text ? 8 : 0 }}
        />
      )}
    </>
  );
}
