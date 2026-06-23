import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useStore } from '../../store';
import { selectCompany } from '../../store/selectors';
import { useCart } from '../cart/CartContext';
import { formatPrice } from '../modules.catalog';
import '../demo.css';
import './checkout-success.css';

// /polishpoint/checkout/success — landing after checkout completes. Clears the
// cart once. Two arrival paths:
//   • Real Stripe redirect → ?session_id=...; we fetch the session from
//     /api/checkout and render a real receipt + pre-fill the intake form.
//   • Local-dev simulated path → router state { demo:true, order }; renders the
//     recap with a "no payment processed" note.
//
// Below the receipt, the buyer completes an ONBOARDING INTAKE (brand, business,
// team, services + logo). It POSTs to /api/intake, which emails the team via
// Resend. The same form is reachable from the receipt email's link. A localStorage
// flag per session means a repeat visit shows a "received" state, not the form.

const LOGO_MAX_BYTES = 2 * 1024 * 1024;

const EMPTY_FORM = {
  businessName: '', contactName: '', supportEmail: '', supportPhone: '',
  address: '', hours: '', timezone: '', subdomain: '', brandColor: '',
  services: '', team: '', notes: '',
};

export default function CheckoutSuccess() {
  const company = selectCompany(useStore());
  const cart = useCart();
  const navigate = useNavigate();
  const { state } = useLocation();
  const [params] = useSearchParams();

  const sessionId = params.get('session_id');
  const simulated = Boolean(state && state.demo);
  const showIntake = Boolean(sessionId || simulated);
  const intakeKey = `pp.demo.intake.${sessionId || 'sim'}`;

  const [order, setOrder] = useState(simulated ? state.order : null);
  const [loading, setLoading] = useState(Boolean(sessionId) && !simulated);

  const [form, setForm] = useState(EMPTY_FORM);
  const [logo, setLogo] = useState(null);
  const [intakeSubmitting, setIntakeSubmitting] = useState(false);
  const [intakeError, setIntakeError] = useState('');
  const [intakeDone, setIntakeDone] = useState(() => {
    try { return window.localStorage.getItem(intakeKey) === '1'; } catch { return false; }
  });

  const supportEmail = 'hello@saasassins.com';

  // Order complete — empty the cart once on mount.
  useEffect(() => {
    cart.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Real Stripe arrival: fetch the session for a real receipt + intake pre-fill.
  useEffect(() => {
    if (!sessionId || simulated) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/checkout?session_id=${encodeURIComponent(sessionId)}`);
        if (!res.ok) throw new Error('lookup failed');
        const data = await res.json();
        if (cancelled) return;
        setOrder({
          items: (data.items || []).map((it) => ({ name: it.name, price: (it.amount || 0) / 100 })),
          total: (data.amountTotal || 0) / 100,
          email: data.email || null,
          brandTheme: data.brandTheme || null,
          paid: data.paymentStatus === 'paid',
        });
        // Pre-fill the intake from what the buyer already gave Stripe (only fill
        // still-empty fields, so we never clobber anything they've started typing).
        setForm((f) => ({
          ...f,
          businessName: f.businessName || data.company || '',
          contactName: f.contactName || data.name || '',
          supportEmail: f.supportEmail || data.email || '',
          supportPhone: f.supportPhone || data.phone || '',
          address: f.address || data.address || '',
        }));
      } catch {
        /* leave the generic confirmation in place */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [sessionId, simulated]);

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const onLogoChange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) { setLogo(null); return; }
    if (file.size > LOGO_MAX_BYTES) {
      setIntakeError('Logo must be under 2 MB.');
      e.target.value = '';
      setLogo(null);
      return;
    }
    setIntakeError('');
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : '';
      setLogo({ filename: file.name, contentType: file.type, dataBase64: base64 });
    };
    reader.readAsDataURL(file);
  };

  const submitIntake = async (e) => {
    e.preventDefault();
    if (intakeSubmitting) return;
    setIntakeSubmitting(true);
    setIntakeError('');

    const markDone = () => {
      try { window.localStorage.setItem(intakeKey, '1'); } catch { /* ignore */ }
      setIntakeDone(true);
    };

    try {
      if (!sessionId) throw new Error('no-session'); // simulated / local-dev path
      const res = await fetch('/api/intake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, ...form, logo: logo || undefined }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error(b.error || `Submission failed (${res.status}).`);
      }
      markDone();
    } catch (err) {
      // Local dev (no /api server) — simulate success so the flow stays testable.
      if (import.meta.env.DEV) { markDone(); return; }
      setIntakeError(
        err.message === 'no-session'
          ? `Couldn't submit here — please email your details to ${supportEmail}.`
          : (err.message || 'Could not submit. Please try again.'),
      );
    } finally {
      setIntakeSubmitting(false);
    }
  };

  return (
    <div className="pp-demo-page">
      <div className="pp-success">
        <div className="pp-success-mark" aria-hidden="true">✅</div>
        <h1>Thank you — your order is confirmed</h1>
        <p>
          We’ve received your order
          {order && order.email ? ` (a confirmation is on its way to ${order.email})` : ''}.
          {showIntake ? ' Complete your setup details below so we can start building your platform.' : ''}
        </p>

        {loading && <p className="pp-checkout-note">Loading your order…</p>}

        {order && (
          <div className="pp-success-recap">
            {(order.items || []).map((it, i) => (
              <div key={i} className="pp-summary-line">
                <span>{it.name}</span>
                <span>{formatPrice(it.price)}</span>
              </div>
            ))}
            <div className="pp-summary-total">
              <span>Total (one-time)</span>
              <strong>{formatPrice(order.total)}</strong>
            </div>
            {order.brandTheme && (
              <div className="pp-summary-line pp-summary-meta">
                <span>Brand theme</span>
                <span>{order.brandTheme}</span>
              </div>
            )}
            {simulated && (
              <p className="pp-success-demo-note">Local dev — no payment was processed.</p>
            )}
          </div>
        )}

        {showIntake && !intakeDone && (
          <form className="pp-intake" onSubmit={submitIntake}>
            <h2 className="pp-intake-title">Complete your setup details</h2>
            <p className="pp-intake-sub">
              The more you share now, the faster we can brand and provision your instance.
              Only your name and email are required — the rest you can send later.
            </p>

            <div className="pp-intake-grid">
              <label className="pp-intake-field">
                <span>Business / legal name<em>*</em></span>
                <input type="text" value={form.businessName} onChange={set('businessName')} required />
              </label>
              <label className="pp-intake-field">
                <span>Primary contact</span>
                <input type="text" value={form.contactName} onChange={set('contactName')} />
              </label>
              <label className="pp-intake-field">
                <span>Support email<em>*</em></span>
                <input type="email" value={form.supportEmail} onChange={set('supportEmail')} required />
              </label>
              <label className="pp-intake-field">
                <span>Support phone</span>
                <input type="tel" value={form.supportPhone} onChange={set('supportPhone')} />
              </label>
              <label className="pp-intake-field">
                <span>Business hours</span>
                <input type="text" value={form.hours} onChange={set('hours')} placeholder="e.g. Mon–Fri 8–5" />
              </label>
              <label className="pp-intake-field">
                <span>Time zone</span>
                <input type="text" value={form.timezone} onChange={set('timezone')} placeholder="e.g. America/Chicago" />
              </label>
              <label className="pp-intake-field">
                <span>Desired app subdomain</span>
                <input type="text" value={form.subdomain} onChange={set('subdomain')} placeholder="e.g. acme" />
              </label>
              <label className="pp-intake-field">
                <span>Brand color</span>
                <input type="text" value={form.brandColor} onChange={set('brandColor')} placeholder="e.g. #1E8FE8" />
              </label>

              <label className="pp-intake-field pp-intake-full">
                <span>Business address</span>
                <textarea rows={2} value={form.address} onChange={set('address')} />
              </label>
              <label className="pp-intake-field pp-intake-full">
                <span>Services &amp; pricing</span>
                <textarea rows={3} value={form.services} onChange={set('services')} placeholder="What you offer and what you charge" />
              </label>
              <label className="pp-intake-field pp-intake-full">
                <span>Team roster</span>
                <textarea rows={3} value={form.team} onChange={set('team')} placeholder="Name, email, role — one per line" />
              </label>
              <label className="pp-intake-field pp-intake-full">
                <span>Anything else</span>
                <textarea rows={2} value={form.notes} onChange={set('notes')} />
              </label>

              <label className="pp-intake-field pp-intake-full">
                <span>Logo</span>
                <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" onChange={onLogoChange} />
                {logo && <span className="pp-intake-hint">Attached: {logo.filename}</span>}
              </label>
            </div>

            {intakeError && <p className="pp-intake-error">{intakeError}</p>}

            <button className="btn btn-primary" type="submit" disabled={intakeSubmitting}>
              {intakeSubmitting ? 'Sending…' : 'Send setup details'}
            </button>
          </form>
        )}

        {showIntake && intakeDone && (
          <div className="pp-intake-done">
            <div className="pp-intake-done-mark" aria-hidden="true">📩</div>
            <h2>Thanks — we’ve got your details</h2>
            <p>
              Our team will be in touch shortly to kick off your build. Need to add something?
              Email <a href={`mailto:${supportEmail}`}>{supportEmail}</a>.
            </p>
          </div>
        )}

        <div className="pp-success-actions">
          <button className="btn btn-primary" onClick={() => navigate('/demo')}>Back to the demo</button>
          <button className="btn btn-outline" onClick={() => navigate('/')}>View modules</button>
        </div>
      </div>
    </div>
  );
}
