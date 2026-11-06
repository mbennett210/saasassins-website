// THE SIGN-IN PAGE'S "Forgot password?" — the browser's half (CS-122; Daniel, 2026-10-16: "Do it from
// alerts@"). The reset email now leaves from the app's Google system sender through the app's own route
// (POST /api/public/auth/forgot, EP-413; test-forgot-password-route.mjs holds the server), never from
// Supabase's built-in mailer (`supabase.auth.resetPasswordForEmail`, whose setup was never verified
// and which by default delivers only to the Supabase project's own team).
//
//   §1 src/lib/passwordReset.js requestPasswordReset: ONE POST of { email } to the route the server
//      serves (FORGOT_PATH under the app's backend base), no Authorization header (the person can't
//      sign in), and the same { error } shape the sign-in page always read
//   §2 lib/authErrors friendlyResetError: a malformed address, the allowance and the network each read
//      as their own catalog line; the address rule is the server's own (forgotEmail)
//   §3 the screens: nothing in app/src calls resetPasswordForEmail any more; AuthProvider's
//      sendPasswordReset posts to the route (and keeps the no-backend demo answer); the sign-in page's
//      Forgot password has a busy state, so repeat taps send nothing; the success line stays neutral
//
// REGRESSION (THE LAW II.3): on the tree before the fix there is no lib/passwordReset.js and
// AuthProvider calls resetPasswordForEmail, so §1–§3 fail.
//
//   node app/scripts/test-forgot-password-client.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(APP, 'src');
const read = (...p) => { try { return readFileSync(path.join(...p), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

const rules = await soft('../src/lib/passwordReset.js');
const errs = await soft('../src/lib/authErrors.js');
const { english } = await import('../src/i18n/core.js');

// ── §1 the request ──────────────────────────────────────────────────────────────
const calls = [];
const respondWith = (status, body) => async (url, init) => {
  calls.push({ url: String(url), init });
  return new Response(body === undefined ? 'not json' : JSON.stringify(body), { status, headers: { 'Content-Type': body === undefined ? 'text/plain' : 'application/json' } });
};
// Missing before the fix: every check below then fails on its own instead of being skipped.
const request = async (...a) => { try { return await rules.requestPasswordReset(...a); } catch (e) { return { threw: e?.message || String(e) }; } };
ok('§1.0 src/lib/passwordReset.js exports the route path and requestPasswordReset', typeof rules.requestPasswordReset === 'function' && typeof rules.FORGOT_PATH === 'string', rules.__error || '');
{
  calls.length = 0;
  const r = await request('  Pat@Example.test  ', { fetchImpl: respondWith(200, rules.FORGOT_ANSWER) });
  const c = calls[0] || {};
  const headers = Object.fromEntries(Object.entries(c.init?.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  ok('🔴 §1.1 one request, a POST to the route under the app\'s backend base (/api + FORGOT_PATH)',
    calls.length === 1 && c.init?.method === 'POST' && c.url === `/api${rules.FORGOT_PATH}`, JSON.stringify({ n: calls.length, url: c.url, method: c.init?.method }));
  ok('🔴 §1.2 …carrying only the address, trimmed, as JSON', headers['content-type'] === 'application/json' && c.init?.body === JSON.stringify({ email: 'Pat@Example.test' }), String(c.init?.body));
  ok('🔴 §1.3 …with no Authorization header (no session: the person can\'t sign in)', !('authorization' in headers), JSON.stringify(headers));
  ok('🔴 §1.4 the one answer resolves { error: null } (the shape the sign-in page reads)', r && r.error === null, JSON.stringify(r));
  const limited = await request('pat@example.test', { fetchImpl: respondWith(429, { error: 'Too many requests. Please try again shortly.', code: rules.FORGOT_RATE_LIMITED_CODE }) });
  ok('🔴 §1.5 the allowance comes back as { error: { status: 429, code } }', limited?.error?.status === 429 && limited.error.code === rules.FORGOT_RATE_LIMITED_CODE, JSON.stringify(limited));
  const bad = await request('pat', { fetchImpl: respondWith(400, { error: 'Enter a full email address.', code: rules.FORGOT_BAD_EMAIL_CODE }) });
  ok('§1.6 a malformed address comes back with its code', bad?.error?.status === 400 && bad.error.code === rules.FORGOT_BAD_EMAIL_CODE, JSON.stringify(bad));
  const down = await request('pat@example.test', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  ok('§1.7 no signal comes back as { error: { message } }, never a throw', /failed to fetch/i.test(down?.error?.message || ''), JSON.stringify(down));
  const html = await request('pat@example.test', { fetchImpl: respondWith(502) });
  ok('§1.8 a non-JSON failure keeps its status', html?.error?.status === 502, JSON.stringify(html));
}

// ── §2 the words ───────────────────────────────────────────────────────────────
const say = (err) => (typeof errs.friendlyResetError === 'function' ? errs.friendlyResetError(err) : `missing: ${errs.__error || 'friendlyResetError'}`);
ok('§2.0 lib/authErrors exports friendlyResetError', typeof errs.friendlyResetError === 'function', errs.__error || '');
for (const key of ['login.badEmail', 'login.resetTooMany', 'login.sending', 'login.resetSent']) {
  ok(`§2.1 the catalog has ${key} in English`, english(key) !== key && english(key).length > 3, english(key));
}
{
  ok('🔴 §2.2 a malformed address reads login.badEmail', say({ status: 400, code: rules.FORGOT_BAD_EMAIL_CODE }) === english('login.badEmail'));
  ok('🔴 §2.3 the allowance reads login.resetTooMany (it is an hour, not "a minute")',
    say({ status: 429, code: rules.FORGOT_RATE_LIMITED_CODE }) === english('login.resetTooMany') && say({ status: 429 }) === english('login.resetTooMany'));
  ok('§2.4 no signal reads the sign-in page\'s own "couldn\'t reach the server" line', say({ message: 'Failed to fetch' }) === english('login.error.unreachable'));
  ok('§2.5 the no-backend demo answer still reads "not available"', say({ message: 'Auth is not configured.' }) === english('login.error.unavailable'));
}
{
  const f = (x) => (typeof rules.forgotEmail === 'function' ? rules.forgotEmail(x) : 'missing');
  ok('§2.6 the address rule (the server\'s own): trimmed and lower-cased; partial, doubled or multi-line addresses refused',
    f('  Pat@Example.TEST ') === 'pat@example.test' && f("o'brien@example.test") === "o'brien@example.test"
      && ['', 'pat', 'a@b', 'a@b.com, c@d.com', 'a@b.com\nbcc: x@y.z', `${'x'.repeat(250)}@cs.test`].every((x) => f(x) === '') && f(['a@b.com']) === '' && f(null) === '');
}
ok('§2.7 the success line stays neutral: it never says the address has an account',
  /^If that email has an account/.test(english('login.resetSent')), english('login.resetSent'));

// ── §3 the screens ─────────────────────────────────────────────────────────────
{
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (/\.(js|jsx|mjs)$/.test(n)) files.push(p); } };
  walk(SRC);
  const callers = files.filter((f) => /\bresetPasswordForEmail\s*\(/.test(read(f)));
  ok(`🔴 §3.1 nothing in app/src calls Supabase's own reset mailer (resetPasswordForEmail): ${callers.map((f) => path.relative(APP, f)).join(', ') || 'none'}`,
    files.length > 100 && callers.length === 0);
}
const ap = read(SRC, 'auth', 'AuthProvider.jsx');
const sendBlock = /sendPasswordReset:\s*\(email\)\s*=>([\s\S]*?)\n\s{4}updatePassword:/.exec(ap)?.[1] || '';
ok('🔴 §3.2 AuthProvider\'s sendPasswordReset posts to the route (lib/passwordReset requestPasswordReset)',
  /\brequestPasswordReset\(email\)/.test(sendBlock) && /import \{ requestPasswordReset \} from '\.\.\/lib\/passwordReset(\.js)?'/.test(ap), sendBlock.trim().slice(0, 160));
ok('§3.3 …and keeps the no-backend (demo) answer, so the demo makes no request', /supabase\s*\?[\s\S]*Auth is not configured\./.test(sendBlock));
ok('🔴 §3.4 …and builds no redirect of its own any more (the server lands the link on the app\'s /login): appLink is gone from AuthProvider',
  !!ap && !/\bappLink\b/.test(ap));
const login = read(SRC, 'pages', 'Login.jsx');
const onForgot = /async function onForgot\(\) \{([\s\S]*?)\n  \}\n/.exec(login)?.[1] || '';
ok('🔴 §3.5 Forgot password has a busy state: a tap while one is in flight sends nothing',
  /^\s*if \(resetting\) return;/.test(onForgot) && /setResetting\(true\)/.test(onForgot) && /finally \{\s*setResetting\(false\);/.test(onForgot), onForgot.slice(0, 200));
ok('🔴 §3.6 …the button is disabled and says so while it sends (login.sending)',
  /className="linklike login-forgot"[^>]*disabled=\{resetting\}/.test(login) && /resetting \? t\('login\.sending'\) : t\('login\.forgot'\)/.test(login));
ok('🔴 §3.7 …the address is checked with the server\'s own rule first (forgotEmail), and a failure reads friendlyResetError',
  /forgotEmail\(email\)/.test(onForgot) && /t\('login\.badEmail'\)/.test(onForgot) && /friendlyResetError\(/.test(onForgot));
ok('§3.8 …and every success reads the one neutral line (login.resetSent), whatever the address',
  /else setNotice\(t\('login\.resetSent'\)\)/.test(onForgot));

console.log(`\ntest-forgot-password-client: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
