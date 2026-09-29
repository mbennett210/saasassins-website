// LIVE probe of the deployed /api/reviews surface. Unauthenticated on purpose:
// it verifies the DENIALS (the security posture), not the happy path —
//   · the rewrite reaches the catch-all in production
//   · cron sync fail-closes without the secret (401, never 200)
//   · status/feed refuse anonymous callers (401)
// Run: node scripts/test-gmb-live.mjs [base-url]   (default: production)
import { IDENTITY } from '../src/brand/identity.generated.js';
const BASE = (process.argv[2] || process.env.APP_PUBLIC_URL || IDENTITY.appUrl).replace(/\/+$/, '');

let pass = 0, fail = 0;
async function probe(name, path, wantStatus) {
  const res = await fetch(`${BASE}${path}`);
  const ok = res.status === wantStatus;
  if (ok) { pass += 1; console.log(`✓ ${name} → ${res.status}`); }
  else { fail += 1; console.error(`✖ ${name} — got ${res.status}, want ${wantStatus} (${await res.text().then((t) => t.slice(0, 120)).catch(() => '')})`); }
}

await probe('GET /api/reviews/sync without secret is refused', '/api/reviews/sync', 401);
await probe('GET /api/reviews/status without auth is refused', '/api/reviews/status', 401);
await probe('GET /api/reviews/feed without auth is refused', '/api/reviews/feed', 401);
await probe('GET /api/reviews/posts without auth is refused', '/api/reviews/posts', 401);
await probe('GET /api/reviews/photos without auth is refused', '/api/reviews/photos', 401);
await probe('GET /api/reviews/keywords without auth is refused', '/api/reviews/keywords', 401);
await probe('GET /api/reviews/trends without auth is refused', '/api/reviews/trends', 401);
await probe('unknown subpath 404s', '/api/reviews/nope', 404);

console.log(`\ntest-gmb-live (${BASE}): ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
