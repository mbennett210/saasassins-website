// Measure API round-trip latency, and report WHICH Vercel region actually
// executed each request.
//
// WHY: since Increment 1d every org_state save and every jobs delta goes through
// a Vercel function instead of straight to Supabase. That adds a hop, and the
// size of the hop depends entirely on whether the function is co-located with
// the database. Vercel defaults to `iad1` (Washington DC); this Supabase project
// is `us-west-2` (Oregon) — so by default every save crosses the country twice.
//
// `X-Vercel-Id` reads as `<ingress>::<compute>::<id>`, which is the ground truth
// for where the function ran. Guessing from latency alone is not good enough.
//
//   node scripts/bench-api-latency.mjs
//   node scripts/bench-api-latency.mjs --samples 20 --base https://<the deployment>   (default: the brand's appUrl)
//
// Read-only: every probe is either unauthenticated (expects 401) or an empty
// no-op payload that short-circuits before touching the database.
import { IDENTITY } from '../src/brand/identity.generated.js';
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SAMPLES = Number(arg('samples', 12));
const BASE = arg('base', IDENTITY.appUrl);
const SUPABASE = arg('supabase', 'https://ahvupfuakatchfuehcki.supabase.co');

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    avg: sum / s.length,
    min: s[0],
    med: s[Math.floor(s.length / 2)],
    p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))],
    max: s[s.length - 1],
  };
};
const ms = (n) => `${Math.round(n)}ms`;

async function probe(label, fn) {
  const times = [];
  let region = null;
  let status = null;
  // One warm-up so a cold start doesn't dominate the sample.
  try { await fn(); } catch { /* ignore */ }
  for (let i = 0; i < SAMPLES; i += 1) {
    const t0 = Date.now();
    try {
      const res = await fn();
      times.push(Date.now() - t0);
      status = res.status;
      const vid = res.headers.get('x-vercel-id');
      if (vid && !region) {
        const parts = vid.split('::');
        region = parts.length >= 2 ? `ingress ${parts[0]} -> compute ${parts[1]}` : vid;
      }
    } catch (e) {
      times.push(Date.now() - t0);
      status = `ERR ${e.message.slice(0, 30)}`;
    }
  }
  const s = stats(times);
  console.log(`\n  ${label}`);
  console.log(`    status ${status}${region ? `  ·  ${region}` : ''}`);
  console.log(`    avg ${ms(s.avg)}  med ${ms(s.med)}  min ${ms(s.min)}  p95 ${ms(s.p95)}  max ${ms(s.max)}`);
  return s;
}

console.log(`\nAPI latency — ${SAMPLES} samples/endpoint (after one warm-up), from this machine`);
console.log(`base: ${BASE}`);

// Function path, unauthenticated: measures client -> ingress -> compute -> back.
// Does NOT touch the database (requireAuthority 401s first), so this isolates
// the function hop itself.
const noAuth = await probe('POST /api/state/jobs-delta  (401, no DB work — isolates the function hop)',
  () => fetch(`${BASE}/api/state/jobs-delta`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }));

// A function that DOES reach Supabase, for the full picture.
const health = await probe('GET  /api/email/health  (function + upstream work)',
  () => fetch(`${BASE}/api/email/health`));

// Direct to Supabase, no function in the path — the floor.
const direct = await probe('GET  Supabase REST root  (direct, no function hop)',
  () => fetch(`${SUPABASE}/rest/v1/`, { headers: { apikey: 'probe' } }));

console.log('\n── read-out ──');
console.log(`  function hop costs ~${ms(noAuth.med - direct.med)} over talking to Supabase directly (median).`);
console.log('  If compute region != the Supabase region (us-west-2 / Portland), most of that is');
console.log('  a cross-country round trip paid on EVERY save. Co-locate via "regions" in vercel.json.');
console.log('\n  NOTE: absolute numbers are from THIS machine and are not what Manila sees.');
console.log('  The compute<->database leg, though, is a constant paid regardless of client location —');
console.log('  that is the part this measurement is actually about.\n');
