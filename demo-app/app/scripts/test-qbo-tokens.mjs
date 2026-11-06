// QBO access-token lifecycle (offline). Drives the REAL tokens.js + store.js against the
// in-process fake Supabase, with Intuit's token endpoint stubbed at the fetch boundary. Proves
// the single-flight refresh: two concurrent callers cause EXACTLY ONE Intuit refresh call.
//
//   node scripts/test-qbo-tokens.mjs
import crypto from 'node:crypto';
import { installFakeSupabase, resetWorld, world } from './fake-supabase.mjs';

const ORG = '00000000-0000-0000-0000-000000000001';
const KEY_ENV = 'QBO_TOKEN_ENCRYPTION_KEY';
const KEY = crypto.randomBytes(32).toString('base64');
process.env.SUPABASE_URL = 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role';
process.env.CLEANSPACE_ORG_ID = ORG;
process.env.FORMS_ORG_ID = ORG;
process.env.QBO_CLIENT_ID = 'qbo-client';
process.env.QBO_CLIENT_SECRET = 'qbo-secret';
process.env.QBO_ENVIRONMENT = 'sandbox';
process.env.QBO_REDIRECT_URI = 'https://cleanspace-gilt.vercel.app/api/quickbooks/oauth/callback';
process.env.QBO_TOKEN_ENCRYPTION_KEY = KEY;

// Stub Intuit's token endpoint; count refresh calls; block everything else.
let tokenCalls = 0;
let responder = () => ({ ok: true, status: 200, body: { access_token: 'AT2', expires_in: 3600, refresh_token: 'RT2', x_refresh_token_expires_in: 8640000, x_refresh_token_hard_expires_in: 15552000 } });
const makeRes = (r) => ({ ok: r.ok, status: r.status, headers: { get: () => 'tid_test' }, json: async () => r.body });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://oauth.platform.intuit.com')) { tokenCalls += 1; return makeRes(responder()); }
  throw new Error(`network is blocked in this suite (${u})`);
};

installFakeSupabase();
const { encrypt, decrypt } = await import('../api/_lib/crypto.js');
const { getValidAccessToken } = await import('../api/_lib/qbo/tokens.js');
const { QboError } = await import('../api/_lib/qbo/client.js');

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };

const iso = (ms) => new Date(Date.now() + ms).toISOString();
function seed({ environment = 'sandbox', accessMsLeft = -10000, status = 'active', version = 5 } = {}) {
  tokenCalls = 0;
  resetWorld({
    tables: {
      qbo_connection: [{
        organization_id: ORG, environment, realm_id: '9130', company_name: 'Sandbox Co',
        access_token_enc: encrypt('AT1', KEY_ENV), access_token_expires_at: iso(accessMsLeft),
        refresh_token_enc: encrypt('RT1', KEY_ENV), refresh_token_expires_at: iso(80 * 86400e3),
        refresh_token_hard_expires_at: null, token_version: version, refresh_lease_until: null,
        status, last_error: null, connected_by: 'u_owner', connected_at: iso(-1000), last_synced_at: null,
      }],
    },
  });
}
const conn = () => world.tables.qbo_connection[0];

// ── 1. a still-valid access token is reused — no Intuit call ─────────────────
seed({ accessMsLeft: 3600e3 });
{
  const t = await getValidAccessToken('sandbox');
  ok('valid token reused (returns the stored access token)', t === 'AT1', `got ${t}`);
  ok('🔴 valid token reuse makes ZERO Intuit refresh calls', tokenCalls === 0, `${tokenCalls} calls`);
}

// ── 2. single-flight: two concurrent callers → exactly ONE refresh ───────────
seed({ accessMsLeft: -10000, version: 5 });
{
  const [a, b] = await Promise.all([getValidAccessToken('sandbox'), getValidAccessToken('sandbox')]);
  ok('🔴 single-flight: EXACTLY ONE Intuit refresh across two concurrent callers', tokenCalls === 1, `${tokenCalls} calls`);
  ok('both callers get the SAME new access token', a === 'AT2' && b === 'AT2', `a=${a} b=${b}`);
  ok('the rotated refresh token is persisted (RT1 → RT2)', decrypt(conn().refresh_token_enc, KEY_ENV) === 'RT2');
  ok('the new access token is persisted encrypted', decrypt(conn().access_token_enc, KEY_ENV) === 'AT2');
  ok('token_version advanced past the base (lease + write are both CAS)', conn().token_version > 5, `v=${conn().token_version}`);
  ok('the lease was released after the refresh', conn().refresh_lease_until == null, `${conn().refresh_lease_until}`);
  ok('status stays active after a clean refresh', conn().status === 'active');
}

// ── 3. a second call after a refresh reuses the new token (no extra refresh) ──
{
  const t = await getValidAccessToken('sandbox');
  ok('post-refresh reuse: still one refresh total', tokenCalls === 1, `${tokenCalls} calls`);
  ok('post-refresh reuse returns the fresh token', t === 'AT2');
}

// ── 4. invalid_grant → reauth_required, tokens cleared ──────────────────────
seed({ accessMsLeft: -10000 });
responder = () => ({ ok: false, status: 400, body: { error: 'invalid_grant' } });
{
  let code = null;
  try { await getValidAccessToken('sandbox'); } catch (e) { code = e instanceof QboError ? e.code : e.message; }
  ok('🔴 invalid_grant surfaces as reauth_required', code === 'reauth_required', `got ${code}`);
  ok('status set to reauth_required', conn().status === 'reauth_required');
  ok('access token cleared on reauth', conn().access_token_enc == null);
  ok('🔴 F3: refresh token material ALSO cleared on invalid_grant (no dead token at rest)', conn().refresh_token_enc == null);
  ok('last_error records the code, not provider text', conn().last_error === 'invalid_grant');
}
responder = () => ({ ok: true, status: 200, body: { access_token: 'AT2', expires_in: 3600, refresh_token: 'RT2', x_refresh_token_expires_in: 8640000 } });

// ── 5. environment mismatch → not connected (never cross sandbox/production) ──
seed({ environment: 'sandbox', accessMsLeft: 3600e3 });
{
  let code = null;
  try { await getValidAccessToken('production'); } catch (e) { code = e instanceof QboError ? e.code : e.message; }
  ok('🔴 a sandbox row is NOT connected for a production request', code === 'not_connected', `got ${code}`);
  ok('environment mismatch makes no Intuit call', tokenCalls === 0);
}

// ── 6. a reauth_required connection refuses without calling Intuit ───────────
seed({ status: 'reauth_required', accessMsLeft: -10000 });
{
  let code = null;
  try { await getValidAccessToken('sandbox'); } catch (e) { code = e instanceof QboError ? e.code : e.message; }
  ok('reauth_required connection refuses up front', code === 'reauth_required', `got ${code}`);
  ok('no Intuit call while reauth is required', tokenCalls === 0);
}

// ── F1/F2/F5 (CS-066 L3-review follow-ups) ───────────────────────────────────
// A valid refresh responder for these cases (rotates RT1 → RT2).
const validResponder = () => ({ ok: true, status: 200, body: { access_token: 'AT2', expires_in: 3600, refresh_token: 'RT2', x_refresh_token_expires_in: 8640000 } });
// Capture console.error for one async fn, restore after.
async function captureErr(fn) {
  const logs = []; const orig = console.error;
  console.error = (...a) => logs.push(a.map(String).join(' '));
  try { await fn(); } finally { console.error = orig; }
  return logs;
}

// ── F2: a malformed 200 must NOT persist 'undefined' / mark the connection active ──
responder = () => ({ ok: true, status: 200, body: {} }); // empty 200 — no access/refresh/expires
seed({ accessMsLeft: -10000, version: 5 });
{
  let code = null;
  try { await getValidAccessToken('sandbox'); } catch (e) { code = e instanceof QboError ? e.code : e.message; }
  ok('🔴 F2: an empty 200 refresh is a transient failure (refresh_failed), never a stored token', code === 'refresh_failed', `got ${code}`);
  ok('🔴 F2: the PREVIOUS access token is kept (never encrypt(undefined) → "undefined")', decrypt(conn().access_token_enc, KEY_ENV) === 'AT1');
  ok('F2: the previous refresh token is kept', decrypt(conn().refresh_token_enc, KEY_ENV) === 'RT1');
  ok('🔴 F2: status is error, never active, after a malformed refresh', conn().status === 'error');
  ok('F2: the lease is released so another caller can retry', conn().refresh_lease_until == null);
}
// A 200 with a non-numeric expires_in is equally invalid.
responder = () => ({ ok: true, status: 200, body: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 'soon' } });
seed({ accessMsLeft: -10000, version: 5 });
{
  let code = null;
  try { await getValidAccessToken('sandbox'); } catch (e) { code = e instanceof QboError ? e.code : e.message; }
  ok('🔴 F2: a non-numeric expires_in is rejected (refresh_failed)', code === 'refresh_failed', `got ${code}`);
  ok('F2: tokens unchanged on the non-numeric expires_in case', decrypt(conn().access_token_enc, KEY_ENV) === 'AT1');
}

// ── F5: a token-endpoint failure logs the intuit_tid (never token material) ──
responder = () => ({ ok: false, status: 500, body: { error: 'server_error' } });
seed({ accessMsLeft: -10000, version: 5 });
{
  const logs = await captureErr(async () => { try { await getValidAccessToken('sandbox'); } catch { /* expected */ } });
  ok('🔴 F5: a token-endpoint failure logs the intuit_tid for correlation', logs.some((l) => /tid=tid_test/.test(l)), logs.join(' | '));
  ok('F5: the tid log carries NO token material', !/AT1|RT1|AT2|RT2/.test(logs.join(' | ')), logs.join(' | '));
}

// ── F1: the final persist is CHECKED — a first failure is retried and persisted ──
responder = validResponder;
seed({ accessMsLeft: -10000, version: 5 }); // base 5 → lease bumps to 6, the final persist CASes on 6
{
  let persistFail = 1; // fail the FIRST persist (token_version === 6) once, then allow it
  world.failWhen = (q) => q.table === 'qbo_connection' && q.op === 'update' && q.eq.token_version === 6 && persistFail-- > 0;
  let t = null; let threw = false;
  try { t = await getValidAccessToken('sandbox'); } catch { threw = true; } // pre-fix: the unchecked persist throws
  world.failWhen = null;
  ok('F1: the caller is served the fresh access token', !threw && t === 'AT2', `threw=${threw} got ${t}`);
  ok('🔴 F1: the rotated refresh token IS persisted after a retry (RT1 → RT2)', decrypt(conn().refresh_token_enc, KEY_ENV) === 'RT2');
  ok('F1: status active once the persist retry succeeds', conn().status === 'active');
  ok('F1: a persist retry makes NO extra Intuit refresh call', tokenCalls === 1, `${tokenCalls} calls`);
}

// ── F1: the final persist ALWAYS fails → logged loudly, caller STILL served ──
seed({ accessMsLeft: -10000, version: 5 });
{
  world.failWhen = (q) => q.table === 'qbo_connection' && q.op === 'update' && q.eq.token_version === 6;
  let t = null; let threw = false;
  const logs = await captureErr(async () => { try { t = await getValidAccessToken('sandbox'); } catch { threw = true; } });
  world.failWhen = null;
  ok('🔴 F1: when the persist always fails, the caller is STILL served the fresh access token', !threw && t === 'AT2', `threw=${threw} t=${t}`);
  ok('F1: a qbo_persist_failed code is logged loudly', logs.some((l) => l.includes('qbo_persist_failed')), logs.join(' | '));
  ok('F1: the persist-failed log carries NO token material', !/AT1|RT1|AT2|RT2/.test(logs.join(' | ')), logs.join(' | '));
}
responder = validResponder;

console.log(`\nqbo-tokens: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exit(1);
}
