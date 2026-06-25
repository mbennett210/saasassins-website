// POST /api/intake  { sessionId, businessName, contactName, supportEmail, ... , logo? }  ->  { ok }
//
// Receives the onboarding intake the customer fills out on the checkout success
// page (and via the receipt link), and emails it to the fulfilment team via
// Resend — with the logo attached. No database: the email IS the handoff, which
// fits the "one full deployment per client, no shared DB" model.
//
// SECURITY MODEL: like the webhook, this does NOT trust the caller. It re-fetches
// the Checkout Session from Stripe by the supplied id and confirms it is actually
// PAID before emailing — so the endpoint can't be used to spam the team; a sender
// would need a real, paid session id. All text fields are length-capped and the
// logo is type/size-checked before it's attached.
//
// Env: STRIPE_SECRET_KEY (validate the session) + RESEND_API_KEY (send), and the
// same ORDER_NOTIFY_TO / ORDER_NOTIFY_FROM used by the order webhook.

const Stripe = require('stripe');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}

const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Coerce to a trimmed, length-capped string (defends the email + Resend payload).
const str = (v, max) => (typeof v === 'string' ? v : '').trim().slice(0, max || 500);

const FONT = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
const BRAND = '#1E8FE8';
const LOGO_MAX_BYTES = 3 * 1024 * 1024;

// Ordered field set rendered in the intake email. `long` fields allow more text.
const FIELD_DEFS = [
  { key: 'businessName', label: 'Business / legal name' },
  { key: 'contactName', label: 'Primary contact' },
  { key: 'supportEmail', label: 'Support email' },
  { key: 'supportPhone', label: 'Support phone' },
  { key: 'address', label: 'Business address', long: true },
  { key: 'hours', label: 'Business hours' },
  { key: 'timezone', label: 'Time zone' },
  { key: 'subdomain', label: 'Desired app subdomain' },
  { key: 'brandColor', label: 'Brand color' },
  { key: 'services', label: 'Services & pricing', long: true },
  { key: 'team', label: 'Team roster', long: true },
  { key: 'notes', label: 'Anything else', long: true },
];

async function sendResendEmail(apiKey, payload) {
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.ok) return { ok: true, status: r.status };
    const errText = await r.text().catch(() => '');
    return { ok: false, status: r.status, errText };
  } catch (err) {
    return { ok: false, status: 0, errText: (err && err.message) || 'network error' };
  }
}

function row(label, valueHtml) {
  return (
    `<tr><td style="padding:7px 16px 7px 0;color:#64748b;font:14px/1.5 ${FONT};white-space:nowrap;vertical-align:top">${esc(label)}</td>`
    + `<td style="padding:7px 0;color:#0f172a;font:14px/1.5 ${FONT};white-space:pre-wrap">${valueHtml}</td></tr>`
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Not configured.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Trust anchor: the session must exist and be paid.
  const sessionId = str(body.sessionId, 200);
  if (!sessionId) return res.status(400).json({ error: 'Missing session id.' });
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    return res.status(404).json({ error: 'Order not found.' });
  }
  if (session.payment_status !== 'paid') {
    return res.status(400).json({ error: 'Order is not paid.' });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.error('intake: RESEND_API_KEY is not set; intake not emailed.');
    return res.status(503).json({ error: 'Intake delivery is not configured yet.' });
  }

  // Collect + cap the submitted fields.
  const fields = {};
  for (const def of FIELD_DEFS) fields[def.key] = str(body[def.key], def.long ? 5000 : 500);

  // Validate the logo before attaching (type + decoded size).
  let attachments;
  let logoNote = 'Not provided';
  const logo = body.logo;
  if (logo && typeof logo.dataBase64 === 'string' && logo.dataBase64) {
    const filename = str(logo.filename, 200) || 'logo';
    const contentType = str(logo.contentType, 100);
    const okType = /^image\/(png|jpe?g|svg\+xml|webp|gif)$/i.test(contentType);
    const bytes = Math.floor(logo.dataBase64.length * 0.75);
    if (okType && bytes <= LOGO_MAX_BYTES) {
      attachments = [{ filename, content: logo.dataBase64 }];
      logoNote = `Attached — ${filename}`;
    } else {
      logoNote = 'Provided but rejected (bad type or >3 MB) — ask the customer to resend';
    }
  }

  const md = session.metadata || {};
  const details = session.customer_details || {};
  const customerEmail = details.email || '';
  const headline = fields.businessName || customerEmail || 'New customer';

  const rowsHtml = FIELD_DEFS
    .filter((def) => fields[def.key])
    .map((def) => row(def.label, esc(fields[def.key])))
    .join('');
  // SMS opt-in (A2P/CTIA) consent record from the intake form + the Terms
  // acceptance carried on the Stripe session metadata — both surfaced for the team.
  const sms = (body && typeof body.smsConsent === 'object' && body.smsConsent) || {};
  const smsNote = sms.optIn
    ? `YES — ${str(sms.phone, 60) || 'phone in form'} · v${str(sms.version, 40)} · ${str(sms.at, 40)}`
    : 'No';
  const tosNote = md.tosAccepted ? `${md.tosAccepted} · v${md.tosVersion || ''} · ${md.tosAt || ''}` : '';

  const metaHtml =
    row('SMS opt-in', esc(smsNote))
    + (tosNote ? row('Terms accepted', esc(tosNote)) : '')
    + row('Logo', esc(logoNote))
    + (md.moduleIds ? row('Order (module ids)', esc(md.moduleIds)) : '')
    + (customerEmail ? row('Stripe email', esc(customerEmail)) : '');

  const html =
    `<div style="background:#f1f5f9;padding:24px">`
    + `<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">`
    + `<div style="background:${BRAND};padding:18px 24px">`
    + `<div style="color:#ffffff;font:600 18px/1.3 ${FONT}">📋 New onboarding intake</div>`
    + `<div style="color:#dbeafe;font:14px/1.4 ${FONT};margin-top:2px">${esc(headline)}</div>`
    + `</div>`
    + `<div style="padding:20px 24px">`
    + `<table style="border-collapse:collapse;width:100%">${rowsHtml || row('—', 'No fields submitted')}</table>`
    + `<table style="border-collapse:collapse;width:100%;margin-top:14px;border-top:1px solid #f1f5f9">${metaHtml}</table>`
    + `</div></div></div>`;

  const textLines = [`New onboarding intake — ${headline}`, ''];
  for (const def of FIELD_DEFS) if (fields[def.key]) textLines.push(`${def.label}: ${fields[def.key]}`);
  textLines.push('', `SMS opt-in: ${smsNote}`);
  if (tosNote) textLines.push(`Terms accepted: ${tosNote}`);
  textLines.push(`Logo: ${logoNote}`);
  if (md.moduleIds) textLines.push(`Order (module ids): ${md.moduleIds}`);
  if (customerEmail) textLines.push(`Stripe email: ${customerEmail}`);

  const to = (process.env.ORDER_NOTIFY_TO || 'hello@saasassins.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const from = process.env.ORDER_NOTIFY_FROM || 'PolishPoint Orders <orders@mail.saasassinsdev.com>';

  const payload = {
    from,
    to,
    subject: `New PolishPoint intake — ${headline}`,
    html,
    text: textLines.join('\n'),
  };
  if (customerEmail) payload.reply_to = customerEmail;
  if (attachments) payload.attachments = attachments;

  const result = await sendResendEmail(resendKey, payload);
  if (!result.ok) {
    console.error('intake: Resend send failed', result.status, result.errText);
    // Surface a real error so the form can ask the customer to retry / email us.
    return res.status(502).json({ error: 'Could not deliver your details. Please try again.' });
  }

  return res.status(200).json({ ok: true });
};
