// POST /api/checkout  { moduleIds: string[], brandTheme?, brandThemeKey?, brandThemeHex? }  ->  { url }
// GET  /api/checkout?session_id=cs_...  ->  { paymentStatus, amountTotal, currency, email, brandTheme, brandThemeKey, items[] }
//
// Creates a one-time Stripe Checkout Session from SERVER-SIDE prices (see
// _modules.js) and returns the hosted-checkout URL for the browser to redirect to.
// GET retrieves a completed session so the success page can render a real receipt.
// Same-origin call (saasassinsdev.com/polishpoint -> /api/checkout), so no CORS.
//
// The chosen brand THEME is a $0 configuration choice (no line item) — it rides
// along as metadata so fulfilment knows which styling direction the client wants.
// We stamp it BOTH on the Checkout Session (for the success page) and on the
// PaymentIntent (description + metadata) so it's impossible to miss on the order
// in the Stripe Dashboard, where the team reads payments. We capture the stable
// key (e.g. "blue") + hex alongside the display label so a renamed label can't
// make an order ambiguous.
//
// Env: STRIPE_SECRET_KEY. Use a TEST-mode key (sk_test_...) to verify end-to-end
// with Stripe's test cards (e.g. 4242 4242 4242 4242), THEN switch to a live key
// (sk_live_...) to take real payments. Without the key the endpoint reports 503
// and the frontend surfaces a "payments unavailable" error (it never fakes a sale).

const Stripe = require('stripe');
const { buildLineItems, MODULES } = require('./_modules');

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key) : null;
}

// GET — retrieve a completed Checkout Session for the success page's receipt.
async function handleRetrieve(stripe, req, res) {
  const sessionId = req.query && req.query.session_id;
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id.' });
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
    const md = session.metadata || {};
    return res.status(200).json({
      paymentStatus: session.payment_status, // 'paid' | 'unpaid' | 'no_payment_required'
      amountTotal: session.amount_total,
      currency: session.currency,
      email: (session.customer_details && session.customer_details.email) || null,
      brandTheme: md.brandTheme || null,
      brandThemeKey: md.brandThemeKey || null,
      items: ((session.line_items && session.line_items.data) || []).map((li) => ({
        name: li.description,
        amount: li.amount_total,
        quantity: li.quantity,
      })),
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

  // Brand theme — the $0 styling choice. Display label + stable key + hex, all
  // length-capped (a tampered client can only mislabel its OWN order's metadata).
  const brandTheme = typeof body.brandTheme === 'string' ? body.brandTheme.slice(0, 80) : '';
  const brandThemeKey = typeof body.brandThemeKey === 'string' ? body.brandThemeKey.slice(0, 40) : '';
  const brandThemeHex = typeof body.brandThemeHex === 'string' ? body.brandThemeHex.slice(0, 9) : '';

  // Human-readable order summary for the PaymentIntent description — the line the
  // team sees first on the payment in the Stripe Dashboard. Theme leads.
  const moduleNames = ids.map((id) => (MODULES[id] && MODULES[id].name) || id);
  const themeText = brandTheme
    ? `Theme: ${brandTheme}${brandThemeKey ? ` (${brandThemeKey})` : ''}`
    : 'Theme: default';
  const description = `PolishPoint order · ${themeText} · ${moduleNames.join(', ')}`.slice(0, 480);

  // Metadata shared by the session (success page) and the PaymentIntent (dashboard).
  const orderMetadata = {
    moduleIds: ids.join(','),
    brandTheme,
    brandThemeKey,
    brandThemeHex,
  };

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
      // On the Session (read back by the success page).
      metadata: orderMetadata,
      // On the PaymentIntent — what the team reads in the Dashboard. The theme +
      // modules show in the payment's description line and its metadata section.
      payment_intent_data: {
        description,
        metadata: orderMetadata,
      },
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || 'Failed to create checkout session.' });
  }
};
