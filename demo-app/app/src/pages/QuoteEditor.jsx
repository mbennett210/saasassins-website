// Admin quote editor: fill the proposal's marked fields inline (the rest of the
// document is locked but reflows), sign inline as the Clean Space rep, then send it to
// the contact for signature. The document is the SAME template used for the public
// view + the final PDF, so what you fill is exactly what everyone sees.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useToast } from '../components/Toast';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import FormField from '../components/FormField';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import SignatureCapture from '../components/SignatureCapture';
import FillableQuoteDoc from '../components/FillableQuoteDoc';
import { signOptsFromQuote } from '../lib/quoteTemplate';
import { getQuote, saveQuote, adminSignQuote, sendQuote, getDownloadUrl, deleteQuote, voidQuote } from '../lib/quotesApi';
import { useStore } from '../store';
import { selectContactById, selectContactByEmail } from '../store/selectors';
import { isDoNotContact } from '../lib/contactConsent';
import { IDENTITY } from '../brand/identity.generated.js';

const STATUS_BADGE = { draft: 'slate', sent: 'blue', signed: 'green', void: 'slate' };

export default function QuoteEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const canSend = usePermission('quotes.send');
  const { currentUser } = useAuth();
  const state = useStore();

  const [quote, setQuote] = useState(null);
  const [fields, setFields] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [signing, setSigning] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [signerName, setSignerName] = useState('');
  const sigRef = useRef(null);
  const saveTimer = useRef(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const q = await getQuote(id);
        if (!alive) return;
        if (!q) { setError('Quote not found.'); return; }
        setQuote(q);
        setFields(q.fields || {});
        setSignerName(q.admin_signer_name || currentUser?.name || '');
      } catch (e) { if (alive) setError(e.message || 'Could not load quote.'); }
    })();
    return () => { alive = false; };
  }, [id, currentUser?.name]);

  // Editable through the whole draft stage (incl. after signing, so the rep can
  // still tweak details + re-sign before sending). Locks once sent.
  const editable = quote && quote.status === 'draft';

  function onFieldChange(key, val) {
    setFields((f) => ({ ...f, [key]: val }));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // A refused autosave must be LOUD: the freeze law (server 409) means the
    // edit on screen was NOT recorded — swallowing that leaves the admin
    // believing the sent document contains a change the customer never saw.
    saveTimer.current = setTimeout(() => {
      saveQuote(id, { [key]: val }).catch((e) => toast.error(e.message || 'Change not saved. Check your connection.'));
    }, 600);
  }

  async function onAdminSign() {
    if (sigRef.current?.isEmpty()) { toast.error('Please add your signature.'); return; }
    if (!signerName.trim()) { toast.error('Enter your name.'); return; }
    setBusy(true);
    try {
      await saveQuote(id, fields);
      const q = await adminSignQuote(id, { signerName: signerName.trim(), signatureDataUrl: sigRef.current.toDataURL() });
      setQuote(q);
      setSigning(false);
      toast.success('Signed. Review the document, then send.');
    } catch (e) { toast.error(e.message || 'Sign failed.'); } finally { setBusy(false); }
  }

  // Resolve the quote's recipient contact for the DNC gate — quotes denormalize
  // contact_id + contact_email, so match by id first, email as fallback.
  const quoteContact = quote
    ? (selectContactById(state, quote.contact_id) || selectContactByEmail(state, quote.contact_email))
    : null;
  const contactIsDnc = isDoNotContact(quoteContact);

  async function onSend() {
    if (contactIsDnc) {
      toast.error('This contact is marked Do Not Contact. Quote not sent.');
      return;
    }
    setBusy(true);
    try {
      // Flush any pending debounced edit BEFORE the send: an edit typed <600ms
      // before clicking Send would otherwise race markSent as a concurrent
      // request — the server's freeze CAS refuses the loser, so land the last
      // keystrokes first and only then flip the status. Saving the whole local
      // `fields` object also makes the flush idempotent with prior autosaves.
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      await saveQuote(id, fields);
      const q = await sendQuote(id);
      setQuote(q);
      toast.success(`Sent to ${q.contact_name || 'the contact'} for signature`);
    } catch (e) { toast.error(e.message || 'Send failed.'); } finally { setBusy(false); }
  }

  async function onVoid() {
    setBusy(true);
    try {
      const q = await voidQuote(id);
      setQuote(q);
      setVoiding(false);
      toast.success('Quote voided. Create a new quote to change terms.');
    } catch (e) { toast.error(e.message || 'Void failed.'); } finally { setBusy(false); }
  }

  async function onViewPdf() {
    try {
      const url = await getDownloadUrl(id);
      if (url) window.open(url, '_blank', 'noopener');
      else toast.error('No document to view yet.');
    } catch (e) { toast.error(e.message || 'Could not open the document.'); }
  }

  if (error) return <div className="page"><Link to="/quotes" className="detail-back">← Quotes</Link><p style={{ color: 'var(--danger)', marginTop: 12 }}>{error}</p></div>;
  if (!quote) return <div className="page"><p>Loading…</p></div>;

  const publicLink = `${window.location.origin}/quote/${quote.public_token}`;

  return (
    <div className="page">
      <div className="page-head">
        <button type="button" className="detail-back" onClick={() => { if (quote.status === 'draft') setLeaving(true); else navigate('/quotes'); }}>← Quotes</button>
        <h1 style={{ marginTop: 4 }}>{quote.title || 'Quote'}</h1>
        <p className="page-sub">For {quote.contact_name || '—'} &nbsp;·&nbsp; <Badge variant={STATUS_BADGE[quote.status] || 'slate'}>{quote.status}</Badge></p>
      </div>

      <div className="card quote-action-card">
        {editable
          ? <span className="text-sm text-muted">Fill the highlighted fields below. Everything else is locked. {canSend ? 'Then sign and send.' : ''}</span>
          : <span className="text-sm text-muted">{quote.status === 'signed' ? 'Signed by the client read-only.' : quote.admin_signed_at ? 'Sent for signature read-only.' : 'Read-only.'}</span>}
        <div className="quote-action-btns">
          {contactIsDnc && <Badge variant="red">Do Not Contact</Badge>}
          {quote.admin_signed_at && <button className="btn btn-outline" onClick={onViewPdf}>View PDF</button>}
          {editable && canSend && <button className="btn btn-outline" onClick={() => setSigning(true)} disabled={busy}>{quote.admin_signed_at ? 'Re-sign' : `Sign as ${IDENTITY.name} rep`}</button>}
          {editable && quote.admin_signed_at && canSend && <button className="btn btn-primary" onClick={onSend} disabled={busy}>{busy ? 'Sending…' : `Send to ${quote.contact_name || 'contact'}`}</button>}
          {quote.status !== 'draft' && <button className="btn btn-link" onClick={() => { navigator.clipboard?.writeText(publicLink); toast.success('Client link copied'); }}>Copy client link</button>}
          {/* The freeze's prescribed remedy needs an affordance: a sent quote's
              fields are locked, so "change the terms" = void + new quote. Without
              this button the only control on a frozen quote was hard Delete,
              which destroys the record. Signed agreements are executed contracts
. Voiding those stays a deliberate act outside the editor. */}
          {quote.status === 'sent' && canSend && (
            <button className="btn btn-outline" onClick={() => setVoiding(true)} disabled={busy}>Void quote</button>
          )}
        </div>
      </div>

      {/* Remount only on lock/sign transitions (status + signed timestamps) so the
          signature + date reflow in. NOT on field edits, so typing is never wiped
          (the doc is memoized against re-renders; the key drives the rare rebuild). */}
      <FillableQuoteDoc
        key={`${quote.id}:${quote.status}:${quote.admin_signed_at || ''}:${quote.client_signed_at || ''}`}
        fields={fields}
        locked={!editable}
        opts={signOptsFromQuote(quote)}
        onFieldChange={onFieldChange}
      />

      <Modal open={voiding} onClose={() => setVoiding(false)} title="Void this quote?">
        <p className="text-sm">
          The customer's signing link will stop working and the quote can no longer be
          edited or signed. Create a new quote to send revised terms. This cannot be undone.
        </p>
        <div className="modal-actions" style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-outline" onClick={() => setVoiding(false)} disabled={busy}>Keep it</button>
          <button className="btn btn-danger" onClick={onVoid} disabled={busy}>{busy ? 'Voiding…' : 'Void quote'}</button>
        </div>
      </Modal>

      <Modal open={signing} onClose={() => setSigning(false)} title={`Sign as ${IDENTITY.name} representative`}>
        <FormField label="Your name" value={signerName} onChange={(e) => setSignerName(e.target.value)} />
        <div style={{ marginTop: 8 }}><SignatureCapture ref={sigRef} /></div>
        <div className="modal-actions">
          <button className="btn btn-outline" onClick={() => setSigning(false)} disabled={busy}>Cancel</button>
          <button className="btn btn-primary" onClick={onAdminSign} disabled={busy}>{busy ? 'Signing…' : 'Sign document'}</button>
        </div>
      </Modal>

      <Modal open={leaving} onClose={() => setLeaving(false)} title="Leave this quote?">
        <p className="text-sm" style={{ marginBottom: 14 }}>Save your progress and come back to it later, or delete this draft?</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-outline" onClick={() => setLeaving(false)}>Cancel</button>
          <button className="btn btn-danger" onClick={async () => { try { await deleteQuote(id); toast.success('Draft deleted'); } catch { /* */ } navigate('/quotes'); }}>Delete</button>
          <button className="btn btn-primary" onClick={async () => { try { await saveQuote(id, fields); } catch { /* */ } navigate('/quotes'); }}>Save &amp; exit</button>
        </div>
      </Modal>
    </div>
  );
}
