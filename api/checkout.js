// POST /api/checkout  { moduleIds: string[] }  ->  { url }
//
// Creates a one-time Stripe Checkout Session from SERVER-SIDE prices (see
// _modules.js) and returns the hosted-checkout URL for the browser to redirect to.
// Same-origin call (saasassinsdev.com/polishpoint -> /api/checkout), so no CORS.
//
// Env: STRIPE_SECRET_KEY (use a test-mode key until launch). Set it in the Vercel
// project (and .env for local `vercel dev`). Without it the endpoint reports that
// payments aren't configured rather than throwing.

const Stripe = require('stripe');
const { buildLineItems } = require('./_modules');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return res.status(503).json({ error: 'Payments are not configured yet.' });
  }

  // Vercel parses JSON bodies automatically; guard for string/empty just in case.
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  const { lineItems, ids } = buildLineItems(body && body.moduleIds);
  if (lineItems.length === 0) {
    return res.status(400).json({ error: 'No valid modules selected.' });
  }

  // Derive absolute return URLs from the incoming request so this works on any
  // host (saasassinsdev.com, Vercel previews, localhost) without hardcoding.
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = `${proto}://${host}`;

  try {
    const stripe = new Stripe(key);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      success_url: `${origin}/polishpoint/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/polishpoint/checkout`,
      metadata: { moduleIds: ids.join(',') },
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    return res.status(500).json({ error: (err && err.message) || 'Failed to create checkout session.' });
  }
};
