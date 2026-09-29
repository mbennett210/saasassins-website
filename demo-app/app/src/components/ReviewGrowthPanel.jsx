// Review growth kit — the shareable "leave us a review" link (Google's
// writereview deep link), a QR code for print/counter use, and copy-paste ask
// templates. Needs only the public place id (works even while GBP is
// disconnected); new-review bell alerts ride the sync and need the connection.
import { useEffect, useState } from 'react';
import { useToast } from './Toast';
import { IDENTITY } from '../brand/identity.generated.js';

const TEMPLATES = (url) => [
  {
    label: 'Text (after a great clean)',
    text: `Hi {name}. Thanks for letting us take care of your building! If you have 30 seconds, a Google review helps us a ton: ${url}`,
  },
  {
    label: 'Text (short)',
    text: `Thanks for choosing ${IDENTITY.name}! Mind leaving us a quick Google review? ${url}`,
  },
  {
    label: 'Email',
    text: `Subject: Quick favor?\n\nHi {name},\n\nThank you for trusting ${IDENTITY.name} with your facility. If you've been happy with the service, would you take a minute to share a Google review? It genuinely helps our team grow:\n\n${url}\n\nThank you!\nThe ${IDENTITY.name} team`,
  },
];

export default function ReviewGrowthPanel({ writeReviewUrl, connected }) {
  const toast = useToast();
  const [qr, setQr] = useState(null);

  useEffect(() => {
    if (!writeReviewUrl) return;
    let alive = true;
    // Dynamic import keeps the QR encoder out of the main bundle.
    import('qrcode')
      .then((QRCode) => QRCode.toDataURL(writeReviewUrl, { width: 240, margin: 1 }))
      .then((dataUrl) => { if (alive) setQr(dataUrl); })
      .catch(() => {});
    return () => { alive = false; };
  }, [writeReviewUrl]);

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied`);
    } catch {
      toast.error('Copy failed. Select and copy manually.');
    }
  }

  if (!writeReviewUrl) {
    return <div className="card detail-card"><p className="text-sm text-muted">Loading your review link…</p></div>;
  }

  return (
    <>
      <div className="card detail-card" style={{ marginBottom: 16 }}>
        <h3 className="dash-card-title">Your review link</h3>
        <p className="text-sm text-muted" style={{ marginTop: 4 }}>Opens Google's "leave a review" box for your listing. Share it anywhere.</p>
        <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap', marginTop: 10 }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <code className="text-sm" style={{ background: 'var(--color-neutral-50)', padding: '8px 10px', borderRadius: 8, overflowWrap: 'anywhere' }}>{writeReviewUrl}</code>
              <button className="btn btn-primary" onClick={() => copy(writeReviewUrl, 'Link')}>Copy link</button>
            </div>
            {!connected && (
              <p className="text-xs text-muted" style={{ marginTop: 8 }}>Tip: connect Google Business Profile on this page to get a bell alert whenever a new review lands.</p>
            )}
          </div>
          <div style={{ textAlign: 'center' }}>
            {qr
              ? <img src={qr} alt="QR code for the review link" style={{ width: 160, height: 160, borderRadius: 8, border: '1px solid var(--border-light)' }} />
              : <div style={{ width: 160, height: 160, borderRadius: 8, background: 'var(--color-neutral-50)' }} />}
            <div>
              {qr && <a className="linklike text-xs" href={qr} download={`${IDENTITY.slug}-review-qr.png`}>Download QR</a>}
            </div>
          </div>
        </div>
      </div>

      <div className="card detail-card">
        <h3 className="dash-card-title">Ask templates</h3>
        <p className="text-sm text-muted" style={{ marginTop: 4 }}>Swap in the customer's name and send. The best time to ask is right after a walkthrough or a compliment.</p>
        {TEMPLATES(writeReviewUrl).map((t, i) => (
          <div key={t.label} style={{ padding: '12px 0', borderTop: i ? '1px solid var(--border-light)' : 'none', marginTop: i ? 0 : 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <strong className="text-sm">{t.label}</strong>
              <button className="btn btn-outline" onClick={() => copy(t.text, 'Template')}>Copy</button>
            </div>
            <p className="text-sm text-muted" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{t.text}</p>
          </div>
        ))}
      </div>
    </>
  );
}
