// An order's lines, for the thank-you page and the receipt. Expanding line_items on
// a session stops at the first 10, and a full build has 18, so list them instead.
//
// Underscore-prefixed → Vercel treats this as a shared helper, not an endpoint.

async function orderLines(stripe, sessionId) {
  const { data } = await stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 });
  return data.map((li) => ({
    name: li.description,
    amount: li.amount_total,
    quantity: li.quantity,
  }));
}

module.exports = { orderLines };
