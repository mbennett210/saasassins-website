// POST /api/checkout  { moduleIds: string[], brandTheme?: string }  ->  { url }
// GET  /api/checkout?session_id=cs_...  ->  { paymentStatus, amountTotal, currency, email, brandTheme, items[], company, name, phone, address }
//
// Creates a one-time Stripe Checkout Session from SERVER-SIDE prices (see
// _modules.js) and returns the hosted-checkout URL for the browser to redirect to.
// GET retrieves a completed session so the success page can render a real receipt
// AND pre-fill the onboarding intake form (company/name/phone/address).
// Same-origin call (saasassinsdev.com/polishpoint -> /api/checkout), so no CORS.
//
// Env: STRIPE_SECRET_KEY. Use a TEST-mode key (sk_test_...) to verify end-to-end
// with Stripe's test cards (e.g. 4242 4242 4242 4242), THEN switch to a live key
// (sk_live_...) to take real payments. Without the key the endpoint reports 503
// and the frontend surfaces a "payments unavailable" error (it never fakes a sale).

const Stripe = require('stripe');
const { buildLineItems } = require('./_modules');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}

// Flatten a Stripe address object into one line for pre-filling the intake form.
function formatAddress(addr) {
  if (!addr) return null;
  const parts = [
    addr.line1,
    addr.line2,
    addr.city,
    [addr.state, addr.postal_code].filter(Boolean).join(' '),
    addr.country,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// GET — retrieve a completed Checkout Session for the success page's receipt
// + intake-form pre-fill.
async function handleRetrieve(stripe, req, res) {
  const sessionId = req.query && req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id.' });
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
    const details = session.customer_details || {};
    const companyField = (session.custom_fields || []).find((f) => f.key === 'company');
    return res.status(200).json({
      paymentStatus: session.payment_status, // 'paid' | 'unpaid' | 'no_payment_required'
      amountTotal: session.amount_total,
      currency: session.currency,
      email: details.email || null,
      brandTheme: (session.metadata && session.metadata.brandTheme) || null,
      brandThemeKey: (session.metadata && session.metadata.brandThemeKey) || null,
      items: ((session.line_items && session.line_items.data) || []).map((li) => ({
        name: li.description,
        amount: li.amount_total,
        quantity: li.quantity,
      })),
      // Intake-form pre-fill (what the buyer already gave Stripe).
      company: (companyField && companyField.text && companyField.text.value) || null,
      name: details.name || null,
      phone: details.phone || null,
      address: formatAddress(details.address),
    });
  } catch {
    return res.status(404).json({ error: 'Order not found.' });
  }
}

module.exports = async function handler(req, res) {
  const stripe = getStripe();
  if (!stripe) {
    return res.status(503).json({ error: 'Payments are not configured yet.' });
  }

  if (req.method === 'GET') {
    return handleRetrieve(stripe, req, res);
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Vercel parses JSON bodies automatically; guard for string/empty just in case.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Only add-on ids come from the client; the server always adds the Core base
  // line item and resolves every price itself (a tampered client can't set one).
  const { lineItems, ids } = buildLineItems(body.moduleIds);
  if (lineItems.length === 0) {
    return res.status(400).json({ error: 'No valid modules selected.' });
  }

  // Derive absolute return URLs from the incoming request so this works on any
  // host (saasassinsdev.com, Vercel previews, localhost) without hardcoding.
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = `${proto}://${host}`;

  const brandTheme = typeof body.brandTheme === 'string' ? body.brandTheme.slice(0, 80) : '';
  // The stable theme id (e.g. 'blue') — durable for fulfillment even if the
  // display label ('Cobalt') is later renamed. The browser sends both.
  const brandThemeKey = typeof body.brandThemeKey === 'string' ? body.brandThemeKey.slice(0, 40) : '';

  // Clickwrap Terms acceptance from the checkout page — recorded on the order so
  // the paid session is the durable proof the buyer agreed (at this T&C version).
  const tosAccepted = body.tosAccepted === true || body.tosAccepted === 'true';
  const tosVersion = typeof body.tosVersion === 'string' ? body.tosVersion.slice(0, 40) : '';
  const tosAt = typeof body.tosAt === 'string' ? body.tosAt.slice(0, 40) : '';

  // One metadata blob describing the order's fulfillment selections. Stamped on
  // BOTH the Checkout Session AND the PaymentIntent, so the chosen modules +
  // brand theme show up directly on the payment in the Dashboard — the Payments
  // view reads PaymentIntent metadata, which the session's does NOT propagate to.
  // `origin` rides along so the webhook can build the receipt's intake link for
  // the right environment (prod / preview / localhost) without a hardcoded host.
  const orderMetadata = { moduleIds: ids.join(','), brandTheme, brandThemeKey, origin, tosAccepted: tosAccepted ? 'true' : 'false', tosVersion, tosAt };

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      // B2B service order — capture who's buying so the team can fulfil + invoice.
      customer_creation: 'always',
      billing_address_collection: 'required',
      phone_number_collection: { enabled: true },
      custom_fields: [
        { key: 'company', label: { type: 'custom', custom: 'Company name' }, type: 'text' },
      ],
      success_url: `${origin}/polishpoint/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/polishpoint/checkout`,
      metadata: orderMetadata,
      payment_intent_data: { metadata: orderMetadata },
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || 'Failed to create checkout session.' });
  }
};
