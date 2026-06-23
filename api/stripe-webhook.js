// POST /api/stripe-webhook — Stripe event receiver.
//
// On `checkout.session.completed`, sends two emails via Resend:
//   1. a TEAM NOTICE to the fulfilment team (customer, company, modules, brand
//      theme, amount + a link to the payment in the Dashboard), and
//   2. a CUSTOMER RECEIPT to the buyer — an itemised order confirmation with a
//      numbered "what happens next" + a link to the onboarding intake form (the
//      checkout success page), fulfilling the success page's promise.
//
// The team notice is the RETRY ANCHOR: it's sent first, and only a successful
// send proceeds to the receipt. So a Stripe retry (which re-delivers the whole
// event) can never double-send the buyer a receipt — the receipt is only ever
// reached after the anchor has already succeeded, after which we always ack 200.
// The receipt itself is best-effort: a failed receipt is logged, never retried
// (which would risk a duplicate), and never blocks the order.
//
// SECURITY MODEL: this endpoint does NOT trust the incoming payload. It reads
// only the session id from the event, then RE-FETCHES the session from Stripe
// with the secret key and confirms it is actually paid before notifying. So a
// forged POST can't fabricate an order — an attacker would need a real, paid
// session id, and the only possible effect is a duplicate notice for a real
// order. (Signature verification is skipped because Vercel pre-parses the
// request body, consuming the raw bytes Stripe's constructEvent() needs; the
// re-fetch is the authoritative trust anchor. To add signature verification
// later, disable body parsing for this route and verify with STRIPE_WEBHOOK_SECRET.)
//
// Env: STRIPE_SECRET_KEY (resolve the order) + RESEND_API_KEY (send the emails).
//   • ORDER_NOTIFY_TO   — team recipient(s), comma-separated. Default hello@saasassins.com.
//   • ORDER_NOTIFY_FROM — sender for both emails. Default 'PolishPoint Orders <orders@saasassins.com>'.
//     The sender DOMAIN must be verified in Resend or the send is rejected.

const Stripe = require('stripe');
const { MODULES } = require('./_modules');

// Fallback site origin for the receipt's intake link when the session metadata
// didn't carry one (older sessions). Per-environment origin is stamped into the
// session metadata at checkout time; this is only the safety net.
const FALLBACK_ORIGIN = 'https://saasassinsdev.com';

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}

const fmtUsd = (cents) =>
  `$${((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

// Escape dynamic values before dropping them into the HTML emails (company name,
// email, names, etc. are buyer-supplied — never inject them raw).
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Map the stored `moduleIds` (csv of ids) to human names via the price catalog.
function moduleNames(csv) {
  return String(csv || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => (MODULES[id] && MODULES[id].name) || id)
    .join(', ');
}

const FONT = '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
const BRAND = '#1E8FE8';

// POST one email to Resend. Returns { ok, status, errText }; status 0 = network
// error (transient). Never throws — callers decide retry vs. ack per email.
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

// ── Team-notice email body ──
function teamRow(label, valueHtml) {
  return (
    `<tr><td style="padding:6px 16px 6px 0;color:#64748b;font:14px/1.5 ${FONT};white-space:nowrap;vertical-align:top">${esc(label)}</td>`
    + `<td style="padding:6px 0;color:#0f172a;font:14px/1.5 ${FONT}">${valueHtml}</td></tr>`
  );
}

function buildTeamEmail({ amountStr, email, companyName, phone, modules, brand, dashUrl }) {
  const rowsHtml = [
    teamRow('Amount', `<strong>${esc(amountStr)}</strong> one-time`),
    teamRow('Customer', esc(email || '—')),
    teamRow('Company', esc(companyName || '—')),
    teamRow('Phone', esc(phone || '—')),
    teamRow('Modules', esc(modules)),
    teamRow('Brand theme', esc(brand)),
  ].join('');

  const html =
    `<div style="background:#f1f5f9;padding:24px">`
    + `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">`
    + `<div style="background:${BRAND};padding:18px 24px">`
    + `<div style="color:#ffffff;font:600 18px/1.3 ${FONT}">🎉 New PolishPoint order</div>`
    + `<div style="color:#dbeafe;font:14px/1.4 ${FONT};margin-top:2px">${esc(amountStr)} · one-time</div>`
    + `</div>`
    + `<div style="padding:20px 24px">`
    + `<table style="border-collapse:collapse;width:100%">${rowsHtml}</table>`
    + (dashUrl
      ? `<div style="margin-top:20px"><a href="${esc(dashUrl)}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font:600 14px/1 ${FONT};padding:11px 18px;border-radius:8px">View payment in Stripe →</a></div>`
      : '')
    + `</div></div></div>`;

  const text = [
    `New PolishPoint order — ${amountStr} one-time`,
    '',
    `Customer: ${email || '—'}`,
    `Company:  ${companyName || '—'}`,
    `Phone:    ${phone || '—'}`,
    `Modules:  ${modules}`,
    `Brand:    ${brand}`,
    ...(dashUrl ? ['', `View payment in Stripe: ${dashUrl}`] : []),
  ].join('\n');

  return { html, text };
}

// ── Customer-receipt email body ──
function receiptItemRow(name, amountCents) {
  return (
    `<tr><td style="padding:9px 0;border-bottom:1px solid #f1f5f9;color:#0f172a;font:14px/1.5 ${FONT}">${esc(name)}</td>`
    + `<td style="padding:9px 0;border-bottom:1px solid #f1f5f9;color:#0f172a;font:14px/1.5 ${FONT};text-align:right;white-space:nowrap">${esc(fmtUsd(amountCents))}</td></tr>`
  );
}

function stepRow(num, html) {
  return (
    `<tr><td style="padding:5px 12px 5px 0;vertical-align:top">`
    + `<span style="display:inline-block;width:22px;height:22px;border-radius:50%;background:#dbeafe;color:${BRAND};text-align:center;font:700 13px/22px ${FONT}">${num}</span></td>`
    + `<td style="padding:5px 0;color:#334155;font:14px/1.6 ${FONT}">${html}</td></tr>`
  );
}

function buildReceiptEmail({ greetingName, companyName, lineItems, amountStr, brand, supportEmail, intakeUrl }) {
  const itemRows = lineItems.map((li) => receiptItemRow(li.name, li.amount)).join('');
  const totalRow =
    `<tr><td style="padding:12px 0 0;color:#0f172a;font:700 15px/1.5 ${FONT}">Total (one-time)</td>`
    + `<td style="padding:12px 0 0;color:#0f172a;font:700 15px/1.5 ${FONT};text-align:right">${esc(amountStr)}</td></tr>`;
  const brandRow = brand && brand !== '—'
    ? `<tr><td style="padding:8px 0 0;color:#64748b;font:13px/1.5 ${FONT}">Brand theme</td>`
      + `<td style="padding:8px 0 0;color:#64748b;font:13px/1.5 ${FONT};text-align:right">${esc(brand)}</td></tr>`
    : '';

  const nextSteps =
    `<div style="margin-top:26px">`
    + `<div style="color:#0f172a;font:700 15px/1.4 ${FONT};margin-bottom:12px">What happens next</div>`
    + `<table style="border-collapse:collapse;width:100%">`
    + stepRow('1', `<strong>Complete your setup details</strong> — a quick form (logo, brand, team, services) so we can brand and provision your instance.`)
    + stepRow('2', `<strong>We build your dedicated instance</strong> — your own secure app, database, and domain, all owned by you.`)
    + stepRow('3', `<strong>Go live &amp; training</strong> — we deploy and walk your team through everything. We'll reach out to confirm timing.`)
    + `</table>`
    + (intakeUrl
      ? `<div style="margin-top:18px"><a href="${esc(intakeUrl)}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;font:600 15px/1 ${FONT};padding:12px 22px;border-radius:8px">Complete your setup details →</a></div>`
      : '')
    + `</div>`;

  const html =
    `<div style="background:#f1f5f9;padding:24px">`
    + `<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden">`
    + `<div style="background:${BRAND};padding:22px 28px">`
    + `<div style="color:#ffffff;font:700 20px/1.3 ${FONT}">Order confirmed 🎉</div>`
    + `<div style="color:#dbeafe;font:14px/1.4 ${FONT};margin-top:3px">Thank you for choosing PolishPoint</div>`
    + `</div>`
    + `<div style="padding:24px 28px">`
    + `<p style="margin:0 0 14px;color:#0f172a;font:15px/1.6 ${FONT}">Hi ${greetingName},</p>`
    + `<p style="margin:0 0 20px;color:#334155;font:15px/1.6 ${FONT}">`
    + `Thanks for your order${companyName ? ` for <strong>${esc(companyName)}</strong>` : ''} — payment is confirmed. Here's your summary:`
    + `</p>`
    + `<table style="border-collapse:collapse;width:100%;margin:0 0 4px">${itemRows}${totalRow}${brandRow}</table>`
    + nextSteps
    + `<p style="margin:24px 0 0;color:#334155;font:14px/1.6 ${FONT}">`
    + `Questions? Just reply to this email or reach us at `
    + `<a href="mailto:${esc(supportEmail)}" style="color:${BRAND};text-decoration:none">${esc(supportEmail)}</a>.`
    + `</p>`
    + `</div>`
    + `<div style="padding:16px 28px;border-top:1px solid #f1f5f9;color:#94a3b8;font:12px/1.5 ${FONT}">`
    + `PolishPoint, built by SaaSassins · You own your software.`
    + `</div>`
    + `</div></div>`;

  const text = [
    `Order confirmed — thank you for choosing PolishPoint`,
    '',
    `Hi ${greetingName},`,
    '',
    `Thanks for your order${companyName ? ` for ${companyName}` : ''} — payment is confirmed. Here's your summary:`,
    ...lineItems.map((li) => `  ${li.name} — ${fmtUsd(li.amount)}`),
    `  Total (one-time): ${amountStr}`,
    ...(brand && brand !== '—' ? [`  Brand theme: ${brand}`] : []),
    '',
    'What happens next:',
    `  1. Complete your setup details (logo, brand, team, services)${intakeUrl ? `: ${intakeUrl}` : ''}`,
    '  2. We build your dedicated instance — your own app, database, and domain.',
    "  3. Go live & training — we'll reach out to confirm timing.",
    '',
    `Questions? Reply to this email or reach us at ${supportEmail}.`,
  ].join('\n');

  return { html, text };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const stripe = getStripe();
  if (!stripe) return res.status(503).json({ error: 'Stripe is not configured.' });

  // Parse the event envelope (Vercel pre-parses JSON; guard for string/empty).
  let event = req.body;
  if (typeof event === 'string') { try { event = JSON.parse(event); } catch { event = {}; } }
  event = event || {};

  // Only act on completed checkouts; ack everything else so Stripe stops resending.
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true, ignored: event.type || 'unknown' });
  }
  const sessionId = event.data && event.data.object && event.data.object.id;
  if (!sessionId) return res.status(200).json({ received: true, note: 'no session id' });

  // Re-fetch authoritative order data from Stripe — never trust the payload.
  // Expand line_items so the customer receipt can itemise the order.
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent', 'line_items'],
    });
  } catch {
    return res.status(200).json({ received: true, note: 'session not found' });
  }
  if (session.payment_status !== 'paid') {
    return res.status(200).json({ received: true, note: `not paid (${session.payment_status})` });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.error('stripe-webhook: RESEND_API_KEY is not set; order not emailed.');
    return res.status(200).json({ received: true, note: 'resend not configured' });
  }

  // ── Resolve order facts (shared by both emails) ──
  const md = session.metadata || {};
  const companyField = (session.custom_fields || []).find((f) => f.key === 'company');
  const companyName = (companyField && companyField.text && companyField.text.value) || '';
  const details = session.customer_details || {};
  const customerEmail = details.email || '';
  const piId = (session.payment_intent && session.payment_intent.id) || session.payment_intent || '';
  const dashUrl = piId
    ? `https://dashboard.stripe.com/${session.livemode ? '' : 'test/'}payments/${piId}`
    : null;

  const amountStr = fmtUsd(session.amount_total);
  const modules = moduleNames(md.moduleIds) || '—';
  const brand = md.brandTheme
    ? `${md.brandTheme}${md.brandThemeKey ? ` (${md.brandThemeKey})` : ''}`
    : '—';
  const lineItems = ((session.line_items && session.line_items.data) || []).map((li) => ({
    name: li.description,
    amount: li.amount_total,
    quantity: li.quantity,
  }));

  // Receipt's intake link → the success page (which renders the intake form).
  // Origin was stamped into metadata at checkout for the right environment.
  const origin = /^https?:\/\//.test(md.origin || '') ? md.origin : FALLBACK_ORIGIN;
  const intakeUrl = `${origin}/polishpoint/checkout/success?session_id=${encodeURIComponent(session.id)}`;

  const teamTo = (process.env.ORDER_NOTIFY_TO || 'hello@saasassins.com')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const from = process.env.ORDER_NOTIFY_FROM || 'PolishPoint Orders <orders@saasassins.com>';
  const supportEmail = teamTo[0] || 'hello@saasassins.com';

  // ── 1) Team notice — the RETRY ANCHOR (sent before the receipt) ──
  const team = buildTeamEmail({ amountStr, email: customerEmail, companyName, phone: details.phone, modules, brand, dashUrl });
  const teamPayload = {
    from,
    to: teamTo,
    subject: `New PolishPoint order — ${amountStr}${companyName ? ` · ${companyName}` : ''}`,
    html: team.html,
    text: team.text,
  };
  if (customerEmail) teamPayload.reply_to = customerEmail; // reply reaches the buyer

  const teamResult = await sendResendEmail(resendKey, teamPayload);
  if (!teamResult.ok) {
    console.error('stripe-webhook: team notice failed', teamResult.status, teamResult.errText);
    // 4xx = permanent config error (unverified domain, bad key): ack so Stripe
    // stops retrying — a retry can't fix it, and the receipt would 4xx too.
    if (teamResult.status >= 400 && teamResult.status < 500) {
      return res.status(200).json({ received: true, note: `team notice rejected (${teamResult.status})` });
    }
    // 5xx / network = transient: 500 so Stripe retries. The receipt has NOT been
    // sent yet, so the retry can't duplicate it.
    return res.status(500).json({ error: 'team notice send failed' });
  }

  // ── 2) Customer receipt — best-effort (only reached after the anchor succeeds) ──
  let receiptSent = false;
  if (customerEmail) {
    const greetingName = details.name ? esc(String(details.name).split(' ')[0]) : 'there';
    const receipt = buildReceiptEmail({ greetingName, companyName, lineItems, amountStr, brand, supportEmail, intakeUrl });
    const receiptResult = await sendResendEmail(resendKey, {
      from,
      to: [customerEmail],
      reply_to: supportEmail, // buyer replies reach the team
      subject: `Your PolishPoint order is confirmed — ${amountStr}`,
      html: receipt.html,
      text: receipt.text,
    });
    receiptSent = receiptResult.ok;
    if (!receiptResult.ok) {
      // Never retry the receipt (would risk a duplicate) — log and move on.
      console.error('stripe-webhook: customer receipt failed', receiptResult.status, receiptResult.errText);
    }
  } else {
    console.error('stripe-webhook: no customer email on session; receipt skipped.');
  }

  return res.status(200).json({ received: true, notified: true, receipt: receiptSent });
};
