// Quick check that GET /api/settings/google-reviews returns the live Places data.
// Run: GOOGLE_MAPS_API_KEY=<key> node scripts/test-reviews-route.mjs
import { readFileSync } from 'node:fs';
for (const line of readFileSync(new URL('../.env.local.bak', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const handler = (await import('../api/settings/[...path].js')).default;
const req = { query: { path: ['google-reviews'] }, method: 'GET', headers: {}, url: '/api/settings/google-reviews', on: () => {} };
let out = null;
const res = { status: (c) => ({ json: (b) => { out = { code: c, body: b }; return res; } }) };
await handler(req, res);
console.log(JSON.stringify(out, null, 2));
