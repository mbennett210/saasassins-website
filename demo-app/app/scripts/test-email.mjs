// One-off email deliverability check. SENDS A REAL EMAIL through the shared Resend
// sender, proving the verified-domain From actually delivers. Usage:
//   node scripts/test-email.mjs --send [recipient@example.com]
//
// ⚠️ NAMED `test-*` BUT IT IS NOT A TEST — it has a live side effect. `--send` is
// required because that name puts it in the blast radius of any "run the suite" sweep
// (`for f in scripts/test-*.mjs; do node "$f"; done`), and this script used to default
// to a REAL recipient on argv[2] being absent. On 2026-07-20 an unattended loop ran
// exactly that sweep; this script was invoked and was saved only by an unrelated
// ENOENT on a machine-local file — it would have mailed a live address on any machine
// where that file existed. The guard makes an accidental send unreachable rather than
// unlikely. Do not remove it; pass the flag.
import { readFileSync } from 'node:fs';
import { DOC } from '../src/brand/doc.js';
import { IDENTITY } from '../src/brand/identity.generated.js';

if (!process.argv.includes('--send')) {
  console.log('test-email.mjs sends a REAL email. Re-run with --send to confirm:');
  console.log('  node scripts/test-email.mjs --send [recipient@example.com]');
  process.exit(0); // exit 0 — a sweep that reaches this is behaving correctly
}

// Prefer .env.local, fall back to .env.local.bak, matching the other live scripts.
let envText = null;
for (const f of ['../.env.local', '../.env.local.bak']) {
  try { envText = readFileSync(new URL(f, import.meta.url), 'utf8'); break; } catch { /* try next */ }
}
if (!envText) {
  console.error('No .env.local or .env.local.bak found in app/.');
  process.exit(1);
}
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const { sendEmail, defaultFrom } = await import('../api/_lib/email.js');
const to = process.argv.filter((a) => a !== '--send')[2] || 'sellwithdealmate@gmail.com';
console.log('From:', defaultFrom());
console.log('To:  ', to);
const r = await sendEmail({
  to,
  subject: `${IDENTITY.wordmark} — quote email wiring test`,
  html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px"><div style="background:${DOC.brand};color:${DOC.onBrand};padding:14px 20px;border-radius:10px 10px 0 0;font-weight:700">${IDENTITY.name}</div><div style="border:1px solid ${DOC.divider};border-top:none;border-radius:0 0 10px 10px;padding:22px;color:${DOC.ink}"><h2 style="margin:0 0 10px;font-size:18px">Email is wired ✅</h2><p style="color:${DOC.body};font-size:14px">If you received this, quote sign-request and signed-copy emails will deliver via Resend on the verified domain.</p></div></div>`,
});
console.log('result:', JSON.stringify(r));
process.exit(r.ok ? 0 : 1);
