// QuickBooks access-token lifecycle — the single-flight refresh. Intuit ROTATES the refresh
// token and the previous one dies once a new one is issued, so two concurrent callers must
// NEVER both refresh: exactly one takes a lease and calls Intuit, the others wait for the
// winner's token. The lease and the token write are both CAS on `token_version` (store.js),
// which is the only serialization primitive the fake Supabase (and real Postgres) need.
import { encrypt } from '../crypto.js';
import { QBO_KEY_ENV, qboCreds } from './config.js';
import { refreshTokens, QboError, isValidTokenResponse } from './client.js';
import {
  getConnection, casUpdateConnection, decryptAccessToken, decryptRefreshToken,
} from './store.js';

const ACCESS_SKEW_MS = 90 * 1000;   // treat a token with <90 s left as expired
const LEASE_MS = 30 * 1000;         // how long a refresh lease is held
const POLL_MS = 40;                 // a loser re-reads this often…
const POLL_MAX = 100;               // …up to POLL_MAX times (~4 s) before giving up (503)
const PERSIST_ATTEMPTS = 3;         // bounded retries persisting a freshly ROTATED token (F1)
const PERSIST_RETRY_MS = 50;        // wait between persist retries

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The stored access token if it is present and has > ACCESS_SKEW_MS left, else null.
function usableAccessToken(row) {
  if (!row || !row.access_token_enc || !row.access_token_expires_at) return null;
  if (Date.parse(row.access_token_expires_at) - Date.now() <= ACCESS_SKEW_MS) return null;
  return decryptAccessToken(row);
}

// Return a valid access token for the connected realm, refreshing under a single-flight lease
// when needed. Throws QboError('not_connected' | 'reauth_required' | 'refresh_busy' | …).
export async function getValidAccessToken(environment) {
  let row = await getConnection();
  if (!row || row.environment !== environment) throw new QboError('not_connected', 'QuickBooks is not connected.');
  if (row.status === 'reauth_required') throw new QboError('reauth_required', 'QuickBooks needs to be reconnected.');
  const fresh = usableAccessToken(row);
  if (fresh) return fresh;

  for (let i = 0; i < POLL_MAX; i += 1) {
    row = await getConnection();
    if (!row || row.environment !== environment) throw new QboError('not_connected', 'QuickBooks is not connected.');
    if (row.status === 'reauth_required') throw new QboError('reauth_required', 'QuickBooks needs to be reconnected.');
    const ready = usableAccessToken(row);
    if (ready) return ready;

    const leaseFree = !row.refresh_lease_until || Date.parse(row.refresh_lease_until) <= Date.now();
    if (leaseFree) {
      // Acquire the lease AND bump token_version in one CAS: two callers both reading the same
      // version cannot both win, since the first bump makes the second's predicate miss.
      const myVersion = row.token_version + 1;
      const won = await casUpdateConnection(row.token_version, {
        refresh_lease_until: new Date(Date.now() + LEASE_MS).toISOString(),
        token_version: myVersion,
      });
      if (won) return doRefresh(row, myVersion);
      // lost the race — fall through and poll for the winner's token
    }
    await sleep(POLL_MS);
  }
  throw new QboError('refresh_busy', 'A QuickBooks token refresh is in progress — retry shortly.');
}

// The lease holder's refresh. `leaseVersion` is the token_version this caller set when it took
// the lease; every write here CASes on it so a stale caller can never stomp a newer state.
async function doRefresh(prevRow, leaseVersion) {
  let tokens;
  try {
    tokens = await refreshTokens(decryptRefreshToken(prevRow), qboCreds());
  } catch (e) {
    if (e instanceof QboError && e.code === 'invalid_grant') {
      // The refresh token is dead — clear ALL token material (F3: no dead access OR refresh
      // token stays at rest) and require a reconnect.
      await casUpdateConnection(leaseVersion, {
        status: 'reauth_required', last_error: 'invalid_grant',
        access_token_enc: null, refresh_token_enc: null,
        refresh_lease_until: null, token_version: leaseVersion + 1,
      });
      throw new QboError('reauth_required', 'QuickBooks needs to be reconnected.');
    }
    // Transient — release the lease so another caller can retry, surface a retryable error.
    await casUpdateConnection(leaseVersion, {
      status: 'error', last_error: (e instanceof QboError ? e.code : 'refresh_failed'),
      refresh_lease_until: null, token_version: leaseVersion + 1,
    });
    throw e instanceof QboError ? e : new QboError('refresh_failed', 'QuickBooks token refresh failed.');
  }

  // F2: a malformed 200 (empty/odd body) would otherwise persist the string 'undefined' as the
  // access token and mark the connection active. Validate before persisting; on a bad body keep
  // the PREVIOUS tokens (write no token material), release the lease, and surface a retryable
  // failure exactly like a transient refresh error.
  if (!isValidTokenResponse(tokens)) {
    await casUpdateConnection(leaseVersion, {
      status: 'error', last_error: 'refresh_failed',
      refresh_lease_until: null, token_version: leaseVersion + 1,
    });
    throw new QboError('refresh_failed', 'QuickBooks token refresh returned an invalid response.');
  }

  const now = Date.now();
  const accessToken = tokens.access_token;
  const newRefresh = tokens.refresh_token; // validated non-empty above (Intuit rotates on refresh)
  const patch = {
    access_token_enc: encrypt(accessToken, QBO_KEY_ENV),
    access_token_expires_at: new Date(now + Number(tokens.expires_in) * 1000).toISOString(),
    refresh_token_enc: encrypt(newRefresh, QBO_KEY_ENV),
    refresh_token_expires_at: tokens.x_refresh_token_expires_in
      ? new Date(now + Number(tokens.x_refresh_token_expires_in) * 1000).toISOString() : prevRow.refresh_token_expires_at ?? null,
    refresh_token_hard_expires_at: tokens.x_refresh_token_hard_expires_in
      ? new Date(now + Number(tokens.x_refresh_token_hard_expires_in) * 1000).toISOString() : prevRow.refresh_token_hard_expires_at ?? null,
    refresh_lease_until: null,
    status: 'active',
    last_error: null,
    token_version: leaseVersion + 1,
  };

  // F1: persist the freshly ROTATED tokens, CHECKING the result. Intuit already invalidated the
  // previous refresh token by issuing this one, so a lost write means the next refresh hits
  // invalid_grant. A transient write error throws while the row still carries `leaseVersion` (our
  // lease), so retry a bounded number of times; a CAS that returns false means another caller
  // took the lease (token_version moved past us) — stop, since a predicate on a version we no
  // longer hold can never win. If every attempt fails, log loudly (a code, NEVER token material),
  // best-effort record status 'error' so the UI can prompt a reconnect, and STILL return the
  // fresh access token to THIS caller (it is valid ~1h). The inherent rotation window — a rotated
  // refresh token that never reached the store — resolves on the next refresh as reauth_required.
  for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
    try {
      if (await casUpdateConnection(leaseVersion, patch)) return accessToken;
      break; // CAS lost the lease — retrying the same predicate cannot win.
    } catch {
      if (attempt + 1 < PERSIST_ATTEMPTS) await sleep(PERSIST_RETRY_MS);
    }
  }
  console.error('[api/quickbooks] qbo_persist_failed: refreshed tokens could not be persisted after retries; a reconnect may be required on the next refresh');
  try {
    await casUpdateConnection(leaseVersion, {
      status: 'error', last_error: 'qbo_persist_failed', refresh_lease_until: null, token_version: leaseVersion + 1,
    });
  } catch { /* best effort — a write is not possible right now */ }
  return accessToken;
}
