// Connecting QuickBooks from either of the app's addresses (offline).
//
// The app moved to https://www.cleancorner.app (live since about 2026-09-28); the old
// https://cleanspace-gilt.vercel.app still serves. S111 registered BOTH callback addresses with
// Intuit. But oauth/start sent Intuit the ONE address in QBO_REDIRECT_URI, and the callback page
// posted its result to that address's origin — so an owner connecting from www.cleancorner.app
// came back on the old domain, whose page messaged the old origin: the browser dropped the
// message, the popup closed, and the screen said "Connection was cancelled." while the
// connection had in fact been saved. This pins:
//   1. QBO_REDIRECT_URI may list every registered callback address (comma-separated; the first
//      is the default) — and only those are ever used;
//   2. oauth/start picks the address of the origin the owner is on (`?origin=`, matched against
//      that list, never taken verbatim), and the signed state carries it;
//   3. the callback exchanges the code with THAT address (Intuit requires the same one) and posts
//      its result to THAT origin — never to an address outside the list, even from a state;
//   4. one address configured (production today) still works as before;
//   5. CS-568: an owner whose login has no team-member id can connect (the state is bound to the
//      login itself) instead of looping on "the connection link expired";
//   6. the screen does not call a saved connection "cancelled" when the popup closes unheard.
//
//   node scripts/test-qbo-redirect.mjs
import { readFileSync } from 'node:fs';
import { rig, counter, REDIRECT_GILT, REDIRECT_CORNER, KEY_ENV } from './qbo-harness.mjs';

const { ok, finish } = counter('qbo-redirect');
const r = await rig();
const config = await import('../api/_lib/qbo/config.js');
const CORNER = 'https://www.cleancorner.app';
const GILT = 'https://cleanspace-gilt.vercel.app';
const stateOf = (url) => new URL(url).searchParams.get('state');
const redirectOf = (url) => new URL(url).searchParams.get('redirect_uri');
const tokenCalls = () => r.intuitLog.filter((e) => e.url.origin === 'https://oauth.platform.intuit.com');
const exchangedWith = () => new URLSearchParams(tokenCalls().at(-1)?.body || '').get('redirect_uri');
// The page's `window.opener.postMessage({…json…}, "<origin>")` — the origin is the string after the object.
const postsTo = (html) => (/postMessage\(\{[\s\S]*?\},\s*"([^"]+)"\)/.exec(String(html)) || [])[1] || null;

// ── 1. the configured list ──────────────────────────────────────────────────
process.env.QBO_REDIRECT_URI = `${REDIRECT_CORNER}, ${REDIRECT_GILT}`;
{
  const list = typeof config.qboRedirectUris === 'function' ? config.qboRedirectUris() : [];
  ok('🔴 QBO_REDIRECT_URI may list every registered callback address', list.length === 2 && list[0] === REDIRECT_CORNER && list[1] === REDIRECT_GILT, JSON.stringify(list));
  ok('the first is the default', config.qboRedirectUri() === REDIRECT_CORNER, config.qboRedirectUri());
  const pick = typeof config.redirectUriForOrigin === 'function' ? config.redirectUriForOrigin : () => null;
  ok('🔴 the address for an origin on the list is that origin\'s', pick(GILT) === REDIRECT_GILT && pick(CORNER) === REDIRECT_CORNER);
  ok('🔴 an origin NOT on the list gets the default — never an address made from it', pick('https://evil.example') === REDIRECT_CORNER && pick('not a url') === REDIRECT_CORNER);
  process.env.QBO_REDIRECT_URI = `${REDIRECT_CORNER},  javascript:alert(1) ,${REDIRECT_GILT}`;
  const cleaned = typeof config.qboRedirectUris === 'function' ? config.qboRedirectUris() : [];
  ok('an entry that is not an http(s) address is ignored', cleaned.length === 2 && !cleaned.some((u) => u.startsWith('javascript')), JSON.stringify(cleaned));
}

// ── 2/3. a connect from www.cleancorner.app ─────────────────────────────────
process.env.QBO_REDIRECT_URI = `${REDIRECT_GILT},${REDIRECT_CORNER}`; // the OLD domain first
r.build({ connected: false });
{
  const start = await r.call({ path: 'oauth/start', token: 'tok-owner', query: { origin: CORNER } });
  ok('oauth/start → 200 { url }', start.status === 200 && typeof start.body.url === 'string', r.show(start));
  const url = start.body.url || 'https://x.invalid/?';
  ok('🔴 Intuit is sent the callback address of the origin the owner is on', redirectOf(url) === REDIRECT_CORNER, redirectOf(url));
  const verified = (await import('../api/_lib/crypto.js')).verifyState(stateOf(url), 10 * 60 * 1000, KEY_ENV);
  ok('🔴 the signed state carries that address', verified && verified.ru === REDIRECT_CORNER, JSON.stringify(verified));
  const cb = await r.call({ path: 'oauth/callback', query: { code: 'the_code', state: stateOf(url), realmId: 'realm_1' } });
  ok('the callback connects', typeof cb.body === 'string' && cb.body.includes('"ok":true'), String(cb.body).slice(0, 160));
  ok('🔴 the code is exchanged with the SAME address Intuit was sent (Intuit requires it)', exchangedWith() === REDIRECT_CORNER, exchangedWith());
  ok('🔴 the result is posted to www.cleancorner.app — the window that opened the popup', postsTo(cb.body) === CORNER, postsTo(cb.body));
}
r.build({ connected: false });
{
  const start = await r.call({ path: 'oauth/start', token: 'tok-owner', query: { origin: GILT } });
  ok('from the old address it is the old address, both ways', redirectOf(start.body.url) === REDIRECT_GILT, redirectOf(start.body.url));
  const cb = await r.call({ path: 'oauth/callback', query: { code: 'c2', state: stateOf(start.body.url), realmId: 'realm_1' } });
  ok('… exchanged and posted on the old address', exchangedWith() === REDIRECT_GILT && postsTo(cb.body) === GILT, `${exchangedWith()} · ${postsTo(cb.body)}`);
}
r.build({ connected: false });
{
  const start = await r.call({ path: 'oauth/start', token: 'tok-owner', query: { origin: 'https://evil.example' } });
  ok('🔴 an origin outside the list never reaches Intuit — the default address is used', redirectOf(start.body.url) === REDIRECT_GILT, redirectOf(start.body.url));
  const { signState } = await import('../api/_lib/crypto.js');
  // Even a state carrying an address (signed with the real key — not something a stranger can
  // make) is used only when that address is on the list.
  r.world.tables.qbo_oauth_states.push({ organization_id: r.world.tables.org_state[0].organization_id, state_hash: (await import('../api/_lib/qbo/store.js')).hashNonce('n-evil'), org_user_id: 'u_owner', expires_at: new Date(Date.now() + 60e3).toISOString() });
  const forged = signState({ t: 'qbo', ts: Date.now(), nonce: 'n-evil', by: 'u_owner', ru: 'https://evil.example/api/quickbooks/oauth/callback' }, KEY_ENV);
  const cb = await r.call({ path: 'oauth/callback', query: { code: 'c3', state: forged, realmId: 'realm_1' } });
  ok('🔴 an address in a state that is not on the list is never used, to exchange or to post', exchangedWith() !== 'https://evil.example/api/quickbooks/oauth/callback' && postsTo(cb.body) !== 'https://evil.example', `${exchangedWith()} · ${postsTo(cb.body)}`);
}

// ── 4. one address configured (production today) ────────────────────────────
process.env.QBO_REDIRECT_URI = REDIRECT_GILT;
r.build({ connected: false });
{
  const start = await r.call({ path: 'oauth/start', token: 'tok-owner', query: { origin: CORNER } });
  ok('one address configured: it is used from any origin, as before', start.status === 200 && redirectOf(start.body.url) === REDIRECT_GILT, r.show(start));
  const noOrigin = await r.call({ path: 'oauth/start', token: 'tok-owner' });
  ok('no origin sent (an older screen): the default address', noOrigin.status === 200 && redirectOf(noOrigin.body.url) === REDIRECT_GILT, r.show(noOrigin));
}

// ── 5. CS-568: an owner with no team-member id ──────────────────────────────
process.env.QBO_REDIRECT_URI = `${REDIRECT_CORNER},${REDIRECT_GILT}`;
r.build({ connected: false });
{
  r.world.logins.set('tok-ghost-owner', { id: 'auth-ghost', email: 'ghost@nowhere.test', app_metadata: { role: 'owner', org_id: r.world.tables.org_state[0].organization_id } });
  const start = await r.call({ path: 'oauth/start', token: 'tok-ghost-owner', query: { origin: CORNER } });
  ok('CS-568: an id-less owner may start a connect', start.status === 200 && typeof start.body.url === 'string', r.show(start));
  const cb = start.status === 200 ? await r.call({ path: 'oauth/callback', query: { code: 'c4', state: stateOf(start.body.url), realmId: 'realm_1' } }) : { body: '' };
  ok('🔴 CS-568: … and finish it (no endless "the connection link expired")', typeof cb.body === 'string' && cb.body.includes('"ok":true'), String(cb.body).slice(0, 200));
  const conn = r.world.tables.qbo_connection[0];
  ok('… the connection records the login that made it', conn && typeof conn.connected_by === 'string' && conn.connected_by.includes('auth-ghost'), JSON.stringify(conn?.connected_by));
}

// ── 6. the screen ───────────────────────────────────────────────────────────
{
  const api = readFileSync(new URL('../src/lib/qboApi.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  ok('🔴 the screen tells the server which address the owner is on', /oauth\/start\?origin=\$\{encodeURIComponent\(window\.location\.origin\)\}/.test(api));
  ok('🔴 a popup that closes unheard is checked against the status before "cancelled" is said', /popup\.closed[\s\S]{0,600}getQboStatus\(/.test(api));
}

finish();
