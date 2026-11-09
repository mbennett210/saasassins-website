// The build page and the thank-you page live on polishpointdev.com, so the browser
// calls /api/checkout and /api/intake from that site. Only that site is allowed.
//
// Underscore-prefixed → Vercel treats this as a shared helper, not an endpoint.

const SITE_ORIGIN = 'https://www.polishpointdev.com';

// Sets the cross-site headers. Returns true when the request was a browser's
// preflight and has been answered, so the handler should stop there.
function cors(req, res, methods) {
  res.setHeader('Vary', 'Origin');
  if (req.headers.origin === SITE_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', SITE_ORIGIN);
    res.setHeader('Access-Control-Allow-Methods', `${methods}, OPTIONS`);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method !== 'OPTIONS') return false;
  res.status(204).end();
  return true;
}

module.exports = { SITE_ORIGIN, cors };
