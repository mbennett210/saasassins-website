// QuickBooks Online configuration — reads the server-only env (never VITE_). The dedicated
// token-encryption key (QBO_TOKEN_ENCRYPTION_KEY) is NEVER the inbox key (THE LAW II.9).
// Redirect URI comes from env and fails closed when unset (never the Host header, 3.4.18).
export const QBO_KEY_ENV = 'QBO_TOKEN_ENCRYPTION_KEY';

// The configured environment: 'sandbox' | 'production' | null (unset/invalid → not configured).
export function qboEnvironment() {
  const e = (process.env.QBO_ENVIRONMENT || '').trim().toLowerCase();
  return (e === 'production' || e === 'sandbox') ? e : null;
}

export function qboCreds() {
  return { clientId: process.env.QBO_CLIENT_ID || '', clientSecret: process.env.QBO_CLIENT_SECRET || '' };
}

// The REGISTERED redirect URIs, verbatim, in order — QBO_REDIRECT_URI may list several, comma
// (or space) separated, every one of them registered on the Intuit app: the app answers at
// https://www.cleancorner.app and at the old https://cleanspace-gilt.vercel.app, and a connect
// must come back to the address the owner started on (the popup's result is a postMessage the
// browser delivers only to that origin). The FIRST is the default. An entry that is not an
// absolute http(s) URL is ignored. Never derived from the request Host header (an
// attacker-controllable value on a direct request, SEC-40): a caller may only CHOOSE among these.
export function qboRedirectUris() {
  return String(process.env.QBO_REDIRECT_URI || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => {
      try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
    });
}

// The default redirect URI (the first registered), or null (fail closed) when none is set.
export function qboRedirectUri() {
  return qboRedirectUris()[0] || null;
}

// The registered redirect URI whose ORIGIN is `origin` (the app address the owner is on, sent by
// the screen as ?origin=), else the default. Never a URI built from `origin` itself.
export function redirectUriForOrigin(origin) {
  const list = qboRedirectUris();
  let want = null;
  try { want = new URL(String(origin)).origin; } catch { want = null; }
  return (want && list.find((u) => new URL(u).origin === want)) || list[0] || null;
}

// Is `uri` exactly one of the registered redirect URIs? (A state's address is honoured only then.)
export function isRegisteredRedirectUri(uri) {
  return typeof uri === 'string' && qboRedirectUris().includes(uri);
}

// The app origin the OAuth popup postMessages its result to — derived from the DEFAULT redirect
// URI, NEVER '*' (3.6.11 / SEC-45); the callback uses its own address's origin once the state is
// verified. null when no redirect URI is set.
export function appOrigin() {
  const u = qboRedirectUri();
  if (!u) return null;
  try { return new URL(u).origin; } catch { return null; }
}

// The env var names that are missing — empty means fully configured. Used to answer
// `not_configured` (503) before any Intuit call.
export function missingConfig() {
  const miss = [];
  const { clientId, clientSecret } = qboCreds();
  if (!clientId) miss.push('QBO_CLIENT_ID');
  if (!clientSecret) miss.push('QBO_CLIENT_SECRET');
  if (!qboRedirectUri()) miss.push('QBO_REDIRECT_URI');
  if (!qboEnvironment()) miss.push('QBO_ENVIRONMENT');
  if (!process.env.QBO_TOKEN_ENCRYPTION_KEY) miss.push('QBO_TOKEN_ENCRYPTION_KEY');
  return miss;
}

export function isConfigured() {
  return missingConfig().length === 0;
}
