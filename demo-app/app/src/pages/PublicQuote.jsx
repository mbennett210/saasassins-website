// Public, standalone signing page (no auth, no app shell). The contact reviews the
// admin-signed document, accepts the e-signature consent disclosure, then adds
// their signature in the same Modal + SignatureCapture the admin builder uses. On
// submit the server renders the fully-signed PDF, saves it, and marks it signed.
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import SignatureCapture from '../components/SignatureCapture';
import FillableQuoteDoc from '../components/FillableQuoteDoc';
import Modal from '../components/Modal';
import { signOptsFromQuote } from '../lib/quoteTemplate';
import { getPublicQuote, signPublicQuote } from '../lib/quotesApi';
import { IDENTITY } from '../brand/identity.generated.js';
import './public-form.css';

// Standard plain-English ESIGN/UETA-style consent shown before the signature pad.
// NOT legal advice — Clean Space should have counsel review. Inline here as it's used
// only on this page.
function ConsentDisclosure() {
  return (
    <div className="text-sm" style={{ lineHeight: 1.55 }}>
      <p style={{ marginTop: 0 }}>
        By continuing, you consent to use electronic records and electronic signatures for this
        service agreement with {IDENTITY.name}, and you confirm that:
      </p>
      <ul style={{ paddingLeft: 18, margin: '0 0 10px' }}>
        <li>Your electronic signature is the legal equivalent of your handwritten signature and is binding.</li>
        <li>You consent to receive this agreement and related records electronically; a signed PDF copy will be emailed to the address you provide and retained by {IDENTITY.name}.</li>
        <li>You may request a paper copy or withdraw your consent to electronic records at any time by contacting {IDENTITY.name} at {IDENTITY.company.email} or {IDENTITY.company.phone}. Withdrawal does not affect the validity of records provided beforehand.</li>
        <li>To sign, you need a device with a modern web browser and access to the email address you provide.</li>
        <li>The date, time, and IP address of your signature are recorded as part of the signing record.</li>
      </ul>
      <p className="text-muted" style={{ margin: 0 }}>
        Your information is used only to prepare, deliver, and store this agreement, and is not sold.
      </p>
    </div>
  );
}

export default function PublicQuote() {
  const { token } = useParams();
  const [quote, setQuote] = useState(undefined); // undefined = loading, null = not found
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [signing, setSigning] = useState(false); // sign modal open
  const [step, setStep] = useState('consent');    // 'consent' → 'sign'
  const [agree, setAgree] = useState(false);       // e-sign consent checkbox
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const sigRef = useRef(null);

  useEffect(() => {
    let alive = true;
    getPublicQuote(token)
      .then((q) => { if (!alive) return; setQuote(q); if (q?.contact_name) setSignerName(q.contact_name); })
      .catch(() => alive && setQuote(null));
    return () => { alive = false; };
  }, [token]);

  function openSign() { setError(''); setAgree(false); setStep('consent'); setSigning(true); }

  async function onSign() {
    setError('');
    if (!signerName.trim()) { setError('Please type your full name.'); return; }
    if (sigRef.current?.isEmpty()) { setError('Please draw or type your signature.'); return; }
    setBusy(true);
    try {
      await signPublicQuote(token, { signerName: signerName.trim(), signerEmail: signerEmail.trim(), signatureDataUrl: sigRef.current.toDataURL() });
      // Re-fetch so the confirmation view's embedded PDF is the freshly-signed
      // document (both signatures) rather than the stale admin-only preview.
      const fresh = await getPublicQuote(token).catch(() => null);
      if (fresh) setQuote(fresh);
      setSigning(false);
      setDone(true);
    } catch (e) { setError(e.message || 'Could not submit your signature.'); } finally { setBusy(false); }
  }

  const shell = (children) => (
    <div className="public-form-shell"><div className="public-form-card" style={{ maxWidth: 900 }}>{children}</div></div>
  );

  if (quote === undefined) return shell(<p>Loading…</p>);
  if (quote === null) return shell(<><h2>Document not found</h2><p className="text-muted">This signing link is invalid or has expired.</p></>);

  // The admin-signed document rendered live (read-only) — same template the rep
  // filled + the final PDF, so the client reviews exactly what they're signing.
  // Shared helper → the rep's signature + a formatted signing date (not raw ISO).
  const reviewOpts = signOptsFromQuote(quote);

  if (done || quote.status === 'signed') {
    return shell(
      <>
        <h2>{done ? 'Thank you. Your document is signed.' : 'This document has been signed.'}</h2>
        <p className="text-muted">A copy {done ? 'will be' : 'was'} emailed to you for your records.</p>
        {quote.document_url && <iframe title="Signed document" src={quote.document_url} style={{ width: '100%', height: 600, border: '1px solid var(--card-border)', borderRadius: 8, marginTop: 14 }} />}
      </>
    );
  }
  if (quote.status === 'void') return shell(<><h2>This document is no longer available</h2><p className="text-muted">Please contact {IDENTITY.name}.</p></>);
  if (quote.status !== 'sent') return shell(<><h2>Not ready for signature</h2><p className="text-muted">This document isn't ready to sign yet.</p></>);

  return shell(
    <>
      <h2 style={{ marginBottom: 4 }}>Review &amp; sign your agreement</h2>
      <p className="text-muted" style={{ marginBottom: 14 }}>
        From {IDENTITY.name}{quote.admin_signer_name ? ` · signed by ${quote.admin_signer_name}` : ''}. Review the document below, then sign.
      </p>
      <FillableQuoteDoc fields={quote.fields || {}} locked opts={reviewOpts} />

      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
        <button className="btn btn-primary" onClick={openSign}>Review &amp; Sign</button>
      </div>

      <Modal
        open={signing}
        onClose={() => setSigning(false)}
        title={step === 'consent' ? 'Electronic Record & Signature Disclosure' : 'Add your signature'}
      >
        {step === 'consent' ? (
          <>
            <p className="text-muted" style={{ marginTop: 0, fontStyle: 'italic' }}>Please read and accept before signing.</p>
            <ConsentDisclosure />
            <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 14, fontSize: 14 }}>
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 3 }} />
              <span>I agree to use electronic records and electronic signatures, and I have read the disclosure above.</span>
            </label>
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setSigning(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={() => setStep('sign')} disabled={!agree}>Continue</button>
            </div>
          </>
        ) : (
          <>
            <div className="form-row">
              <div className="form-group"><label className="form-label">Your full name</label><input className="input" value={signerName} onChange={(e) => setSignerName(e.target.value)} /></div>
              <div className="form-group"><label className="form-label">Email (for your copy)</label><input className="input" type="email" value={signerEmail} onChange={(e) => setSignerEmail(e.target.value)} placeholder="you@company.com" /></div>
            </div>
            <label className="form-label" style={{ marginTop: 6 }}>Signature</label>
            <div><SignatureCapture ref={sigRef} width={420} /></div>
            {error && <p style={{ color: 'var(--danger)', fontSize: 13, marginTop: 8 }}>{error}</p>}
            <div className="modal-actions">
              <button className="btn btn-outline" onClick={() => setStep('consent')} disabled={busy}>Back</button>
              <button className="btn btn-primary" onClick={onSign} disabled={busy}>{busy ? 'Submitting…' : 'Sign & Submit'}</button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
