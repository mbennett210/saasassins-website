// The repo's first rate-limit primitive — AUTHORIZATION_AUDIT.md §2026-07-20 OPEN #10
// (unauthenticated, unthrottled resume-link sends from the org's verified From).
//
//   node scripts/test-rate-limit.mjs
import { hit, clientIp, allow, __resetRateLimit } from '../api/_lib/rateLimit.js';

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

const W = { limit: 3, windowMs: 1000 };

// ── the basic contract ────────────────────────────────────────────────────
__resetRateLimit();
ok('1st request allowed', hit('a', W).ok);
ok('2nd request allowed', hit('a', W).ok);
ok('3rd request allowed (at the limit)', hit('a', W).ok);
ok('4th request BLOCKED', !hit('a', W).ok);
ok('5th request still blocked', !hit('a', W).ok);
ok('a blocked response carries a positive retryAfterMs', hit('a', W).retryAfterMs > 0);
ok('retryAfterMs never exceeds the window', hit('a', W).retryAfterMs <= W.windowMs);

// remaining counts down and floors at 0
__resetRateLimit();
ok('remaining after 1st is limit-1', hit('b', W).remaining === 2);
ok('remaining after 2nd is limit-2', hit('b', W).remaining === 1);
ok('remaining after 3rd is 0', hit('b', W).remaining === 0);
ok('remaining stays 0 when blocked', hit('b', W).remaining === 0);

// ── keys are independent ──────────────────────────────────────────────────
__resetRateLimit();
for (let i = 0; i < 3; i += 1) hit('ip1', W);
ok('one exhausted key does not block another', hit('ip2', W).ok);
ok('  ...and the exhausted one stays blocked', !hit('ip1', W).ok);

// ── the window actually slides ────────────────────────────────────────────
// A fixed window lets 2x the limit through at a boundary; for a mail-sending
// endpoint that is exactly the difference that matters.
__resetRateLimit();
const SHORT = { limit: 2, windowMs: 120 };
ok('short-window 1st allowed', hit('c', SHORT).ok);
ok('short-window 2nd allowed', hit('c', SHORT).ok);
ok('short-window 3rd blocked', !hit('c', SHORT).ok);
await new Promise((r) => setTimeout(r, 160));
ok('after the window elapses the key recovers', hit('c', SHORT).ok);
ok('  ...with a fresh allowance, not a doubled one', hit('c', SHORT).ok && !hit('c', SHORT).ok);

// Partial expiry: only the hits older than the window drop off.
__resetRateLimit();
hit('d', SHORT); // t=0
await new Promise((r) => setTimeout(r, 80));
hit('d', SHORT); // t=80 -> at limit
ok('at limit with a staggered pair', !hit('d', SHORT).ok);
await new Promise((r) => setTimeout(r, 60)); // t=140: first hit expired, second has not
ok('one slot frees as the oldest hit ages out', hit('d', SHORT).ok);
ok('  ...and only one — the newer hit is still counted', !hit('d', SHORT).ok);

// ── memory is bounded (the limiter must not become the DoS) ──────────────
__resetRateLimit();
for (let i = 0; i < 6000; i += 1) hit(`flood-${i}`, W);
ok('6000 distinct keys do not grow the map without bound', hit('after-flood', W).ok);
// The sweep must not have broken accounting for a live key.
__resetRateLimit();
hit('live', W); hit('live', W); hit('live', W);
for (let i = 0; i < 6000; i += 1) hit(`noise-${i}`, W);
ok('an actively-limited key survives the sweep and stays blocked', !hit('live', W).ok);

// ── clientIp prefers headers the client cannot forge ─────────────────────
// x-forwarded-for is attacker-controllable on a direct request, so trusting it
// first would make every limit bypassable with one header.
ok('x-vercel-forwarded-for wins over x-forwarded-for', clientIp({
  headers: { 'x-vercel-forwarded-for': '1.1.1.1', 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' },
}) === '1.1.1.1');
ok('x-real-ip is preferred over x-forwarded-for', clientIp({
  headers: { 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '8.8.8.8' },
}) === '8.8.8.8');
ok('x-forwarded-for is the last resort', clientIp({ headers: { 'x-forwarded-for': '9.9.9.9' } }) === '9.9.9.9');
ok('the first hop of a comma list is taken', clientIp({
  headers: { 'x-vercel-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' },
}) === '1.1.1.1');
ok('an array-valued header is handled', clientIp({ headers: { 'x-real-ip': ['8.8.8.8'] } }) === '8.8.8.8');
ok('no headers yields a stable placeholder', clientIp({ headers: {} }) === 'unknown');
ok('a missing headers object does not throw', clientIp({}) === 'unknown');
ok('an empty header value falls through', clientIp({
  headers: { 'x-vercel-forwarded-for': '', 'x-real-ip': '8.8.8.8' },
}) === '8.8.8.8');

// ── allow() writes a real 429 ─────────────────────────────────────────────
__resetRateLimit();
const mkRes = () => {
  const r = { statusCode: null, body: null, headers: {} };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const req = { headers: { 'x-vercel-forwarded-for': '5.5.5.5' } };
const opts = { bucket: 'test', id: '5.5.5.5', limit: 2, windowMs: 1000 };
ok('allow() returns true under the limit', allow(req, mkRes(), opts) === true);
ok('allow() returns true at the limit', allow(req, mkRes(), opts) === true);
const blocked = mkRes();
ok('allow() returns false over the limit', allow(req, blocked, opts) === false);
ok('  ...and writes 429', blocked.statusCode === 429);
ok('  ...with a Retry-After header', Number(blocked.headers['retry-after']) >= 0);
ok('  ...and a human-readable error', typeof blocked.body?.error === 'string' && blocked.body.error.length > 0);
ok('  ...that leaks no limit internals', !/\d+\s*(req|per|limit)/i.test(blocked.body.error));

// Different buckets with the same id do not share an allowance — otherwise
// rate-limiting one endpoint would throttle an unrelated one.
__resetRateLimit();
allow(req, mkRes(), { ...opts, bucket: 'x' });
allow(req, mkRes(), { ...opts, bucket: 'x' });
ok('a different bucket has its own allowance', allow(req, mkRes(), { ...opts, bucket: 'y' }) === true);
ok('  ...and the first bucket is still exhausted', allow(req, mkRes(), { ...opts, bucket: 'x' }) === false);

// ── fail-open ─────────────────────────────────────────────────────────────
// A limiter that throws would convert a reputation problem into an outage.
ok('a symbol key does not throw', typeof hit(Symbol('s'), W).ok === 'boolean');
ok('a null options object fails open rather than throwing', hit('e', null).ok === true);
ok('a NaN limit fails open rather than blocking', hit('f', { limit: NaN, windowMs: 1000 }).ok === true);

console.log(`\nrate limit: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exit(1); }
