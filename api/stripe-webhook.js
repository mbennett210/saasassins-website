// POST /api/stripe-webhook — Stripe event receiver.
//
// On `checkout.session.completed`, posts an order summary to Slack (customer,
// company, modules, brand theme, amount + a link to the payment in the
// Dashboard) so the team is notified the moment an order lands — no Dashboard
// digging required for fulfillment.
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
// Env: STRIPE_SECRET_KEY (resolve the order) + SLACK_WEBHOOK_URL (where to post).

const Stripe = require('stripe');
const { MODULES } = require('./_modules');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}

const fmtUsd = (cents) =>
  `$${((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

// Map the stored `moduleIds` (csv of ids) to human names via the price catalog.
function moduleNames(csv) {
  return String(csv || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => (MODULES[id] && MODULES[id].name) || id)
    .join(', ');
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
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['payment_intent'] });
  } catch {
    return res.status(200).json({ received: true, note: 'session not found' });
  }
  if (session.payment_status !== 'paid') {
    return res.status(200).json({ received: true, note: `not paid (${session.payment_status})` });
  }

  const slackUrl = process.env.SLACK_WEBHOOK_URL;
  if (!slackUrl) {
    console.error('stripe-webhook: SLACK_WEBHOOK_URL is not set; order not posted to Slack.');
    return res.status(200).json({ received: true, note: 'slack not configured' });
  }

  const md = session.metadata || {};
  const companyField = (session.custom_fields || []).find((f) => f.key === 'company');
  const companyName = (companyField && companyField.text && companyField.text.value) || '';
  const details = session.customer_details || {};
  const piId = (session.payment_intent && session.payment_intent.id) || session.payment_intent || '';
  const dashUrl = piId
    ? `https://dashboard.stripe.com/${session.livemode ? '' : 'test/'}payments/${piId}`
    : null;

  const meta = [
    `*Customer:* ${details.email || '—'}`
      + (companyName ? `   ·   *Company:* ${companyName}` : '')
      + (details.phone ? `   ·   *Phone:* ${details.phone}` : ''),
    `*Modules:* ${moduleNames(md.moduleIds) || '—'}`,
    `*Brand theme:* ${md.brandTheme || '—'}${md.brandThemeKey ? ` (\`${md.brandThemeKey}\`)` : ''}`,
  ];
  if (dashUrl) meta.push(`<${dashUrl}|View payment in Stripe →>`);

  const headline = `:tada: New PolishPoint order — ${fmtUsd(session.amount_total)}`;
  const payload = {
    text: `${headline}\n${meta.join('\n')}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${headline}*` } },
      { type: 'section', text: { type: 'mrkdwn', text: meta.join('\n') } },
    ],
  };

  try {
    const r = await fetch(slackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('stripe-webhook: Slack post failed', r.status, t);
      // 500 so Stripe retries — transient Slack issues recover on the retry.
      return res.status(500).json({ error: 'Slack post failed' });
    }
  } catch (err) {
    console.error('stripe-webhook: Slack post error', err && err.message);
    return res.status(500).json({ error: 'Slack post error' });
  }

  return res.status(200).json({ received: true, notified: true });
};
