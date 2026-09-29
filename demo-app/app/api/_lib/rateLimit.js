// A small in-process rate limiter. There was no rate-limit primitive in this repo
// at all (AUTHORIZATION_AUDIT.md §2026-07-20 OPEN #10), so this is the first one —
// built to be reused rather than inlined into the one route that needed it.
//
// ⚠️ READ THIS BEFORE RELYING ON IT — WHAT IT DOES AND DOES NOT STOP
//
// State is per serverless INSTANCE. Vercel runs several concurrently and recycles
// them, so the effective limit is (limit × live instances) and it resets on every
// cold start. That makes this a real defence against naive/scripted abuse — a loop
// hammering one endpoint hits a warm instance repeatedly — and NOT a defence against
// a distributed attacker or one who paces requests to land on fresh instances.
//
// A durable limiter needs shared storage (a table, or KV), which needs DDL. That is
// deliberately not done here: see LOOP_REVIEW.md §2. The store below is isolated
// behind `hit()` precisely so swapping in a durable backend is a contained change.
//
// FAIL-OPEN is deliberate. A limiter that throws would take down the endpoint it
// protects, converting a reputation problem into an outage. Every caller treats an
// internal error as "allowed".

// Bounded on purpose: an attacker rotating source IPs would otherwise grow this map
// without limit and exhaust the function's memory — the limiter itself becomes the
// DoS. When the cap is reached the least-recently-touched keys are dropped, which
// costs an attacker nothing but also cannot hurt the process.
const MAX_KEYS = 5000;
const buckets = new Map(); // key -> { hits: number[], expiresAt: number, blocked: boolean }

// EVICTION ORDER IS SECURITY-RELEVANT, not housekeeping.
//
// Evicting purely by age lets an attacker bypass their own limit: flood the map with
// enough fresh distinct keys and the key that is actually being rate-limited — older,
// because it stopped being re-inserted once it was blocked — falls out of the front
// and its allowance resets. Caught by test-rate-limit.mjs.
//
// So: expired entries go first (they enforce nothing), then entries still under their
// limit, and only last the ones at or over it. A flood is thousands of single-hit
// entries, so it evicts itself long before it reaches anything doing real work.
function sweep(now) {
  if (buckets.size <= MAX_KEYS) return;
  const target = Math.floor(MAX_KEYS * 0.9);
  for (const pass of [
    ([, v]) => v.expiresAt <= now,
    ([, v]) => !v.blocked,
    () => true,
  ]) {
    for (const entry of [...buckets.entries()]) {
      if (buckets.size <= target) return;
      if (pass(entry)) buckets.delete(entry[0]);
    }
  }
}

// Record one request against `key` and report whether it is allowed.
// Sliding window (not fixed buckets): a fixed window lets 2× the limit through at a
// boundary, which for a mail-sending endpoint is the difference that matters.
// Returns { ok, remaining, retryAfterMs }.
// NOTE: opts is destructured INSIDE the try, not in the signature. Signature
// destructuring runs before the try block, so a null/undefined opts threw straight
// out of the limiter and 500'd the route it was protecting — the exact fail-CLOSED
// behaviour this is documented not to have. Caught by test-rate-limit.mjs.
export function hit(key, opts) {
  try {
    const { limit, windowMs } = opts || {};
    const now = Date.now();
    const cutoff = now - windowMs;
    const entry = buckets.get(key);
    const hits = entry ? entry.hits.filter((t) => t > cutoff) : [];
    // `blocked` is recorded on the entry so sweep() can protect it without knowing
    // this call's limit — see the eviction-order note above. It must be evaluated
    // AFTER the push: a key that has just reached its limit is the one most worth
    // protecting, and computing it beforehand marked that key unblocked for one more
    // sweep — which was exactly the eviction bypass. Caught by test-rate-limit.mjs.
    const save = () => {
      buckets.delete(key); // re-insert to refresh insertion order
      buckets.set(key, {
        hits,
        expiresAt: (hits[hits.length - 1] || now) + windowMs,
        blocked: hits.length >= limit,
      });
    };
    if (hits.length >= limit) {
      save();
      return { ok: false, remaining: 0, retryAfterMs: Math.max(0, hits[0] + windowMs - now) };
    }
    hits.push(now);
    save();
    sweep(now);
    return { ok: true, remaining: Math.max(0, limit - hits.length), retryAfterMs: 0 };
  } catch {
    return { ok: true, remaining: 0, retryAfterMs: 0 }; // fail open
  }
}

// The caller's IP, preferring headers the PLATFORM sets over ones the client can
// forge. `x-forwarded-for` is attacker-controllable on a direct request, so trusting
// it first would make every limit bypassable with one header. Vercel sets
// `x-vercel-forwarded-for` itself; it is the only one of these that is not
// client-writable.
export function clientIp(req) {
  const h = req.headers || {};
  const first = (v) => String(Array.isArray(v) ? v[0] : v || '').split(',')[0].trim();
  return first(h['x-vercel-forwarded-for']) || first(h['x-real-ip']) || first(h['x-forwarded-for']) || 'unknown';
}

// hit() + a 429 with Retry-After. Returns true when the caller may proceed.
// Caller: `if (!allow(req, res, {...})) return;`
export function allow(req, res, { bucket, id, limit, windowMs }) {
  const r = hit(`${bucket}:${id}`, { limit, windowMs });
  if (r.ok) return true;
  res.setHeader('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
  res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
  return false;
}

// Test-only: the module holds process-wide state, so tests need a reset.
export function __resetRateLimit() {
  buckets.clear();
}
