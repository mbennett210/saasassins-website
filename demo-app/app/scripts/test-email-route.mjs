// NOTIF-01 verification — exercises /api/email/send + /api/email/health
// in-process (mock req/res), including a REAL Supabase login so requireAuth
// runs against the live auth backend. The Resend leg is mocked (no real email
// leaves this script); the live send is proven post-deploy via the
// Integrations test card.
//
// Usage: node scripts/test-email-route.mjs
// Reads SUPABASE_* from ../.env.local and the login from ../.dev-creds.local.

import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

function loadEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(new URL(path, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* missing file — caller decides */ }
  return out;
}

const env = loadEnv('../.env.local');
process.env.SUPABASE_URL = process.env.SUPABASE_URL || env.SUPABASE_URL;
process.env.SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
delete process.env.RESEND_API_KEY; // ensure no accidental real send

const creds = loadEnv('../.dev-creds.local');

const { resolveFromAndReplyTo, sendTransactional, verifiedDomain, addressOf } =
  await import('../api/_lib/email.js');
const sendHandler = (await import('../api/email/send.js')).default;
const healthHandler = (await import('../api/email/health.js')).default;

function mockRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

let pass = 0;
function ok(label, fn) {
  fn();
  pass += 1;
  console.log(`  ✓ ${label}`);
}

// ── 1. From allowlist ────────────────────────────────────────────────────────
console.log('resolveFromAndReplyTo:');
const DOMAIN = verifiedDomain();
assert.equal(DOMAIN, 'billing.cleanspaceonline.com');

ok('on-domain From passes through untouched', () => {
  const r = resolveFromAndReplyTo({ from: `CleanSpace <quotes@${DOMAIN}>`, replyTo: null });
  assert.equal(r.rewritten, false);
  assert.equal(addressOf(r.from), `quotes@${DOMAIN}`);
  assert.equal(r.replyTo, null);
});
ok('off-domain From rewritten to default, preserved as Reply-To', () => {
  const r = resolveFromAndReplyTo({ from: 'office@cleanspaceonline.com', replyTo: null });
  assert.equal(r.rewritten, true);
  assert.equal(addressOf(r.from), `quotes@${DOMAIN}`);
  assert.equal(r.replyTo, 'office@cleanspaceonline.com');
});
ok('explicit replyTo wins over the rewritten From', () => {
  const r = resolveFromAndReplyTo({ from: 'office@cleanspaceonline.com', replyTo: 'kyle@cleanspaceonline.com' });
  assert.equal(r.replyTo, 'kyle@cleanspaceonline.com');
});
ok('placeholder no-reply@example.com never becomes Reply-To', () => {
  const r = resolveFromAndReplyTo({ from: 'no-reply@example.com', replyTo: null });
  assert.equal(r.rewritten, true);
  assert.equal(r.replyTo, null);
});

// ── 2. sendTransactional payload (mocked Resend) ────────────────────────────
console.log('sendTransactional (mocked fetch):');
const realFetch = globalThis.fetch;
let captured = null;
globalThis.fetch = async (url, opts) => {
  captured = { url, payload: JSON.parse(opts.body) };
  return { ok: true, json: async () => ({ id: 'resend_test_id' }) };
};
process.env.RESEND_API_KEY = 'test_key';

{
  const r = await sendTransactional({
    to: 'pat@client.com',
    from: `CleanSpace <quotes@${DOMAIN}>`,
    subject: 'Line1\r\nInjected: x',
    body: 'Hi Pat,\n\nYour cleaning is booked.',
    replyTo: 'office@cleanspaceonline.com',
    headers: { 'X-Test': 'a\r\nInjected: b' },
    tags: ['settings test!'],
  });
  ok('plain-text body sent as text (newlines preserved)', () => {
    assert.equal(captured.payload.text, 'Hi Pat,\n\nYour cleaning is booked.');
    assert.equal(captured.payload.html, undefined);
  });
  ok('subject + header values CRLF-stripped', () => {
    assert.ok(!captured.payload.subject.includes('\n'));
    assert.ok(!captured.payload.headers['X-Test'].includes('\n'));
  });
  ok('tags sanitized to Resend shape', () => {
    assert.deepEqual(captured.payload.tags, [{ name: 'settings_test_', value: '1' }]);
  });
  ok('reply_to + id round-trip', () => {
    assert.equal(captured.payload.reply_to, 'office@cleanspaceonline.com');
    assert.equal(r.ok, true);
    assert.equal(r.id, 'resend_test_id');
  });
}
{
  await sendTransactional({ to: 'pat@client.com', from: 'a@b.co', subject: 's', body: '<p>Hello</p>' });
  ok('HTML body auto-detected and sent as html', () => {
    assert.equal(captured.payload.html, '<p>Hello</p>');
    assert.equal(captured.payload.text, undefined);
  });
}
{
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({ message: 'Domain not verified' }) });
  const r = await sendTransactional({ to: 'pat@client.com', from: 'a@b.co', subject: 's', body: 'b' });
  ok('Resend rejection surfaces structured error', () => {
    assert.equal(r.ok, false);
    assert.equal(r.status, 403);
    assert.equal(r.error, 'Domain not verified');
  });
}
globalThis.fetch = realFetch;
delete process.env.RESEND_API_KEY;

// ── 3. Route handlers, unauthenticated ──────────────────────────────────────
console.log('routes (unauthenticated):');
{
  const res = mockRes();
  await sendHandler({ method: 'GET', headers: {} }, res);
  ok('send: 405 on GET', () => assert.equal(res.statusCode, 405));
}
{
  const res = mockRes();
  await sendHandler({ method: 'POST', headers: {}, body: { to: 'a@b.co', subject: 's', body: 'x' } }, res);
  ok('send: 401 without bearer', () => assert.equal(res.statusCode, 401));
}
{
  const res = mockRes();
  await healthHandler({ method: 'GET', headers: {} }, res);
  ok('health: 401 without bearer', () => assert.equal(res.statusCode, 401));
}

// ── 4. Route handlers, REAL auth (live Supabase login) ─────────────────────
console.log('routes (authenticated via live Supabase):');
if (!process.env.SUPABASE_URL || !creds.KYLE_EMAIL) {
  console.log('  ~ skipped (no Supabase env / dev creds)');
} else {
  const { createClient } = await import('@supabase/supabase-js');
  const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supa.auth.signInWithPassword({
    email: creds.KYLE_EMAIL,
    password: creds.KYLE_PASSWORD,
  });
  assert.ok(!error && data?.session?.access_token, `login failed: ${error?.message}`);
  const authed = { authorization: `Bearer ${data.session.access_token}` };

  {
    const res = mockRes();
    await sendHandler({ method: 'POST', headers: authed, body: { to: 'not-an-email', subject: 's', body: 'x' } }, res);
    ok('send: 400 on invalid recipient', () => assert.equal(res.statusCode, 400));
  }
  {
    const res = mockRes();
    await sendHandler({ method: 'POST', headers: authed, body: { to: 'a@b.co', from: 'x@y.co', subject: 's', body: '' } }, res);
    ok('send: 400 on empty body', () => assert.equal(res.statusCode, 400));
  }
  {
    // No RESEND_API_KEY in local env — full authed path must end in a clean 503.
    const res = mockRes();
    await sendHandler({ method: 'POST', headers: authed, body: { to: 'a@b.co', from: 'x@y.co', subject: 's', body: 'hello' } }, res);
    ok('send: authed path reaches provider gate (503 skipped, no key locally)', () => {
      assert.equal(res.statusCode, 503);
      assert.match(res.body.error, /not configured/);
    });
  }
  {
    const res = mockRes();
    await healthHandler({ method: 'GET', headers: authed }, res);
    ok('health: live DNS probe verifies the Resend domain', () => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.verifiedDomain, DOMAIN);
      assert.equal(res.body.status, 'verified');
      assert.equal(res.body.spfStatus, 'verified');
      assert.equal(res.body.dmarcStatus, 'verified');
      assert.equal(res.body.source, 'dns');
      assert.ok(res.body.dkimRecords[0]?.value?.includes('p='));
    });
  }
  await supa.auth.signOut();
}

console.log(`\nAll ${pass} assertions passed.`);
