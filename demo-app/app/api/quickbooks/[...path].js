// QuickBooks Online integration — connect / disconnect / link properties / list entities /
// force refresh / read per-property profit & loss. Server core (slice 1); no client UI here.
// Requires its /api/quickbooks/:rest* rewrite in app/vercel.json (THE LAW II.6: no route
// without its rewrite). Every branch AUTHENTICATES FIRST; an unknown subpath is 401 before
// 404 (DEV_PLAYBOOK 3.4.3). Error bodies carry a code + plain message — never a token, a
// stack, provider text or an env name.
//
//   GET  status              integrations.view — connection summary (no token material)
//   GET  oauth/start         owner — { url } (Intuit consent); 503 not_configured if env missing
//   GET  oauth/callback      unauthenticated by nature — gated by the signed, single-use,
//                            owner-bound state; rate-limited per IP; exchanges the code ONCE
//   POST disconnect          owner — best-effort revoke, delete the connection + cache (links stay)
//   GET  entities?type=…     owner — list QBO customers/classes/departments (10m cache)
//   GET  links               owner — the client→entity links
//   PUT  links               owner — link a property (clientId must exist; entity type in the enum)
//   DELETE links             owner — unlink a property
//   GET  pnl?range=…         financials.view — per-property P&L, SCOPED (owner: all; others:
//                            only properties whose client.supervisorId is the caller)
//   POST refresh             owner — re-pull every window now (the nightly refresh's routine)
//   GET  needs-matching      integrations.view — QB-12: active QuickBooks customers with activity
//                            in the last 12 months that reach no property, + the linked app
//                            customers' ids (for the reverse view). Names only, never money;
//                            reads QuickBooks, never writes to it.
//
// TIME (CS-572): maxDuration 60, and every Intuit call made for one request runs inside
// ROUTE_BUDGET_MS of its start — a slow QuickBooks answers 503 + retryable, never a 504.
import { requireRole, requirePermission, requireAuthority } from '../_lib/authz.js';
import { signState, verifyState } from '../_lib/crypto.js';
import { randomToken } from '../_lib/tokens.js';
import { allow, clientIp } from '../_lib/rateLimit.js';
import { readOrgState } from '../_lib/orgState.js';
import {
  QBO_KEY_ENV, qboEnvironment, qboCreds, qboRedirectUri, appOrigin, missingConfig, isConfigured,
  redirectUriForOrigin, isRegisteredRedirectUri,
} from '../_lib/qbo/config.js';
import {
  buildAuthorizeUrl, exchangeCode, fetchCompanyInfo, revokeToken, QboError, isValidTokenResponse,
  TRANSIENT_CODES,
} from '../_lib/qbo/client.js';
import {
  getConnection, getConnectionForEnv, saveConnection, deleteConnection, decryptRefreshToken,
  listLinks, putLink, deleteLink, purgeReportCache, createOAuthState, consumeOAuthState,
} from '../_lib/qbo/store.js';
import { attributeToLinked, realmDimension } from '../_lib/qbo/report.js';
import { RANGE_KEYS, MONTH_TO_DATE, rangeKind, resolveRange } from '../_lib/qbo/ranges.js';
import { loadEntities, loadPnl, pnlTtlMs, ENTITY_TTL_MS, NIGHTLY_TTL_MS } from '../_lib/qbo/pnl.js';
import { refreshBook } from '../_lib/qbo/refresh.js';
import { loadCustomerActivity } from '../_lib/qbo/matching.js';
import { needsMatching } from '../../src/lib/qboRules.js';
import { isOpsManagerIn, teamClientIds } from '../../src/lib/teamScope.js';

export const config = { maxDuration: 60 };
// Every Intuit call one request makes must finish inside this (the 60 s limit, less room to answer).
const ROUTE_BUDGET_MS = 45 * 1000;

const ENTITY_TYPES = ['customer', 'class', 'department'];
const ENTITY_LABEL = { customer: 'customer', class: 'class', department: 'location' }; // QBO "Location" = the API's Department
const STATE_TTL_MS = 10 * 60 * 1000;    // OAuth state lifetime

const oneOf = (v, allowed) => (typeof v === 'string' && allowed.includes(v) ? v : undefined);

// Strict body: only the allowed keys, nothing else (unknown keys rejected — never spread a body).
function strictBody(body, allowedKeys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'A JSON body is required.' };
  const extra = Object.keys(body).filter((k) => !allowedKeys.includes(k));
  if (extra.length) return { ok: false, error: `Unexpected field(s): ${extra.join(', ')}` };
  return { ok: true, data: body };
}

// A QboError → { status, code, retryable, message }. Never leaks provider text; the message is
// ours. A TRANSIENT condition (QuickBooks slow or briefly unavailable, a token refresh that did
// not go through, a read that came back short) is 503 + `retryable` (429 for throttling) — it
// was a 500/502 before, which reads as broken rather than "try again in a minute" (CS-574).
function mapQboError(e) {
  const code = e instanceof QboError ? e.code : 'server_error';
  const retryable = TRANSIENT_CODES.has(code);
  const status = code === 'throttled' ? 429 : retryable ? 503 : ({
    not_connected: 400, reauth_required: 409, invalid_grant: 409, bad_entity: 400, too_many: 413,
    unauthorized: 502, forbidden: 502, api_error: 502, token_exchange_failed: 502,
  }[code] || 500);
  const message = retryable ? 'QuickBooks is busy right now. Try again in a minute.'
    : (code === 'reauth_required' || code === 'invalid_grant') ? 'QuickBooks needs to be reconnected.'
      : 'QuickBooks request failed.';
  return { status, code, retryable, message };
}

const clientNameOf = (clients, id) => clients.find((c) => c && c.id === id)?.name || null;

// The popup result page: postMessage to the origin of the registered redirect URI the connect
// used (QBO_REDIRECT_URI's list; the signed state names which), NEVER '*' (3.6.11). When no
// origin can be derived (redirect URI unset) it renders text only.
function resultPage(origin, message) {
  const json = JSON.stringify({ type: 'connect-qbo', ...message }).replace(/</g, '\\u003c');
  const note = message.ok ? 'Connected. You can close this window.' : 'Connection failed. You can close this window.';
  const post = origin ? `try { if (window.opener) window.opener.postMessage(${json}, ${JSON.stringify(origin)}); } catch (e) {}` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>QuickBooks</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem">
<p>${note}</p>
<script>(function(){ ${post} setTimeout(function(){ try { window.close(); } catch (e) {} }, 300); })();</script>
</body></html>`;
}

function statusSummary(conn, environment) {
  return {
    connected: !!conn,
    configured: isConfigured(),
    environment: environment || null,
    companyName: conn?.company_name ?? null,
    status: conn?.status ?? null,
    reauthRequired: conn?.status === 'reauth_required',
    lastError: conn?.last_error ?? null,
    // The last COMPLETE refresh, nightly or the owner's button (CS-569: never written before).
    lastSyncedAt: conn?.last_synced_at ?? null,
    connectedAt: conn?.connected_at ?? null,
    // Who connected it: the team member's id, which Settings names from the roster (CS-569) — no
    // org_state read on this frequent call. An `auth:` id (a login with no roster row) names nobody.
    connectedBy: conn?.connected_by ?? null,
  };
}

export default async function handler(req, res) {
  const started = Date.now(); // every Intuit call this request makes ends by started + ROUTE_BUDGET_MS
  // Same subpath idiom as time / qc: the rewrite delivers multi-segment paths via
  // ?subpath=; a single segment hits the catch-all directly.
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const route = path.join('/');
  const body = req.body || {};

  // Every response carries org data or an auth decision — never cache it (3.4.13 / SEC-52).
  res.setHeader('Cache-Control', 'private, no-store');

  try {
    // ── connection status ──────────────────────────────────────────────────
    if (route === 'status' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'integrations.view');
      if (!g) return;
      const environment = qboEnvironment();
      const conn = environment ? await getConnectionForEnv(environment) : null;
      return res.status(200).json(statusSummary(conn, environment));
    }

    // ── OAuth: mint the Intuit consent URL (authority established HERE) ───────
    if (route === 'oauth/start' && req.method === 'GET') {
      const g = await requireRole(req, res, ['owner']);
      if (!g) return;
      const miss = missingConfig();
      if (miss.length) return res.status(503).json({ error: 'QuickBooks is not configured.', code: 'not_configured' });
      // Who the state is bound to: the team member, else the login itself (CS-568: an owner whose
      // login carries no team-member id signed `by: null`, which the callback could never verify,
      // so they looped on "the connection link expired" for ever).
      const by = g.orgUserId || (g.user?.id ? `auth:${g.user.id}` : null);
      if (!by) return res.status(409).json({ error: 'This login cannot be tied to a person, so QuickBooks cannot be connected from it.', code: 'no_identity' });
      // Which registered callback address (QBO_REDIRECT_URI may list several): the one on the
      // origin the owner is on, so the popup comes back to the window that opened it — chosen from
      // the list, never built from the request. It rides in the SIGNED state for the callback.
      const ru = redirectUriForOrigin(typeof req.query.origin === 'string' ? req.query.origin : '');
      const nonce = randomToken(32);
      const state = signState({ t: 'qbo', ts: Date.now(), nonce, by, ru }, QBO_KEY_ENV);
      await createOAuthState({ nonce, orgUserId: by, expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString() });
      const url = buildAuthorizeUrl({ clientId: qboCreds().clientId, redirectUri: ru, state });
      return res.status(200).json({ url });
    }

    // ── OAuth: Intuit redirects the popup here (unauthenticated; state IS the gate) ──
    if (route === 'oauth/callback' && req.method === 'GET') {
      if (!allow(req, res, { bucket: 'qbo_oauth_cb', id: clientIp(req), limit: 30, windowMs: 60 * 1000 })) return;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // Before the state is verified the default address's origin is all there is; after, the
      // address the connect started on (a state's address counts only when it is registered).
      let origin = appOrigin();
      const { code, state, realmId, error } = req.query;
      const peek = state ? verifyState(String(state), STATE_TTL_MS, QBO_KEY_ENV) : null;
      const redirectUri = peek && isRegisteredRedirectUri(peek.ru) ? peek.ru : qboRedirectUri();
      if (redirectUri) { try { origin = new URL(redirectUri).origin; } catch { /* keep the default */ } }
      if (error) return res.status(200).send(resultPage(origin, { ok: false, error: error === 'access_denied' ? 'access_denied' : 'consent_failed' }));
      if (!code || !state || !realmId) return res.status(200).send(resultPage(origin, { ok: false, error: 'missing_params' }));
      const payload = peek;
      if (!payload || payload.t !== 'qbo' || !payload.nonce || !payload.by) {
        return res.status(200).send(resultPage(origin, { ok: false, error: 'state_invalid' }));
      }
      // Single-use: the nonce is consumed here; a replay finds it already gone. It must be the
      // SAME owner the state was minted for.
      const consumed = await consumeOAuthState(payload.nonce);
      if (!consumed || consumed.org_user_id !== payload.by) {
        return res.status(200).send(resultPage(origin, { ok: false, error: 'state_used' }));
      }
      if (!isConfigured()) return res.status(200).send(resultPage(origin, { ok: false, error: 'not_configured' }));
      const environment = qboEnvironment();
      let tokens;
      try {
        // Exactly once, with the SAME address Intuit was sent at oauth/start (Intuit requires it).
        tokens = await exchangeCode(String(code), { ...qboCreds(), redirectUri });
      } catch (e) {
        return res.status(200).send(resultPage(origin, { ok: false, error: e instanceof QboError ? e.code : 'exchange_failed' }));
      }
      // F2: a malformed 200 (empty/odd body) must NOT be saved — it would store the string
      // 'undefined' as the access token and mark the connection active. Keep the prior state.
      if (!isValidTokenResponse(tokens)) {
        return res.status(200).send(resultPage(origin, { ok: false, error: 'token_exchange_failed' }));
      }
      let company = { companyName: null };
      try { company = await fetchCompanyInfo(tokens.access_token, { environment, realmId: String(realmId) }); } catch { /* keep null; save the connection anyway */ }
      const now = Date.now();
      await saveConnection({
        environment,
        realmId: String(realmId),
        companyName: company.companyName,
        accessToken: tokens.access_token,
        accessTokenExpiresAt: new Date(now + (Number(tokens.expires_in) || 3600) * 1000).toISOString(),
        refreshToken: tokens.refresh_token,
        refreshTokenExpiresAt: tokens.x_refresh_token_expires_in ? new Date(now + Number(tokens.x_refresh_token_expires_in) * 1000).toISOString() : null,
        refreshTokenHardExpiresAt: tokens.x_refresh_token_hard_expires_in ? new Date(now + Number(tokens.x_refresh_token_hard_expires_in) * 1000).toISOString() : null,
        connectedBy: payload.by,
      });
      await purgeReportCache();
      return res.status(200).send(resultPage(origin, { ok: true }));
    }

    // ── disconnect (owner) ───────────────────────────────────────────────────
    if (route === 'disconnect' && req.method === 'POST') {
      const g = await requireRole(req, res, ['owner']);
      if (!g) return;
      const conn = await getConnection();
      if (conn) {
        try { await revokeToken(decryptRefreshToken(conn), qboCreds()); } catch { /* best effort */ }
        await deleteConnection();
        await purgeReportCache();
      }
      return res.status(200).json({ ok: true, connected: false }); // links stay — they are realm-scoped
    }

    // ── refresh NOW (owner): the nightly refresh's routine, every window re-pulled ──
    // (QB-9/QB-10: also what Settings runs right after a connect, so the last twelve months are
    // on the dashboard at once.) Purge first, so nothing older than this press is served; an
    // unfinished pull answers 503 + retryable and the dashboard pulls the rest on demand.
    if (route === 'refresh' && req.method === 'POST') {
      const g = await requireRole(req, res, ['owner']);
      if (!g) return;
      const environment = qboEnvironment();
      const conn = environment ? await getConnectionForEnv(environment) : null;
      await purgeReportCache();
      if (!conn) return res.status(200).json({ ok: true, connected: false });
      const result = await refreshBook({ environment, mode: 'manual', deadline: started + ROUTE_BUDGET_MS, conn });
      if (result.ok) return res.status(200).json({ ok: true, lastSyncedAt: result.lastSyncedAt, warmed: result.warmed, windows: result.windows });
      if (result.code === 'reauth_required') return res.status(409).json({ error: 'QuickBooks needs to be reconnected.', code: 'reauth_required' });
      return res.status(503).json({
        error: 'QuickBooks did not answer for every period. The rest refresh tonight, or try again in a minute.',
        code: 'refresh_incomplete', retryable: true, warmed: result.warmed, windows: result.windows,
      });
    }

    // ── list QBO entities to link (owner) ────────────────────────────────────
    if (route === 'entities' && req.method === 'GET') {
      const g = await requireRole(req, res, ['owner']);
      if (!g) return;
      const type = oneOf(req.query.type, ENTITY_TYPES);
      if (!type) return res.status(400).json({ error: 'type must be customer, class or department', code: 'bad_request' });
      const environment = qboEnvironment();
      const conn = environment ? await getConnectionForEnv(environment) : null;
      if (!conn) return res.status(200).json({ connected: false, entities: [] });
      // The Link dialog's list is kept fresh (a customer added in QuickBooks a minute ago links).
      const { entities, cached } = await loadEntities({
        environment, realmId: conn.realm_id, type, maxAgeMs: ENTITY_TTL_MS, deadline: started + ROUTE_BUDGET_MS,
      });
      return res.status(200).json({ connected: true, environment, type, entities, ...(cached ? { cached: true } : {}) });
    }

    // ── property links (owner) ───────────────────────────────────────────────
    if (route === 'links' && req.method === 'GET') {
      const g = await requireRole(req, res, ['owner']);
      if (!g) return;
      const environment = qboEnvironment();
      const conn = environment ? await getConnectionForEnv(environment) : null;
      const realmId = conn?.realm_id ?? null;
      const { state } = await readOrgState();
      const clients = Array.isArray(state?.clients) ? state.clients : [];
      const links = await listLinks();
      // CS-565: the company's ONE dimension; a link on another (made before the rule) is listed
      // but not counted in any P&L.
      const dimension = realmId ? realmDimension(links.filter((l) => l.realm_id === realmId)) : null;
      return res.status(200).json({
        connected: !!conn,
        environment: environment || null,
        realmId,
        dimension,
        links: links.map((l) => {
          const active = realmId ? l.realm_id === realmId : false; // a link only counts on the connected realm
          return {
            clientId: l.client_id,
            clientName: clientNameOf(clients, l.client_id),
            entityType: l.entity_type,
            entityId: l.entity_id,
            entityName: l.entity_name,
            realmId: l.realm_id,
            active,
            counted: active && l.entity_type === dimension,
          };
        }),
      });
    }
    if (route === 'links' && req.method === 'PUT') {
      const g = await requireRole(req, res, ['owner']);
      if (!g) return;
      const environment = qboEnvironment();
      const conn = environment ? await getConnectionForEnv(environment) : null;
      if (!conn) return res.status(400).json({ error: 'Connect QuickBooks before linking properties.', code: 'not_connected' });
      const parsed = strictBody(body, ['clientId', 'entityType', 'entityId', 'entityName']);
      if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'bad_request' });
      const { clientId, entityType, entityId, entityName } = parsed.data;
      if (!oneOf(entityType, ENTITY_TYPES)) return res.status(400).json({ error: 'entityType must be customer, class or department', code: 'bad_request' });
      if (typeof clientId !== 'string' || !clientId || typeof entityId !== 'string' || !entityId) {
        return res.status(400).json({ error: 'clientId and entityId are required.', code: 'bad_request' });
      }
      const { state } = await readOrgState();
      const clients = Array.isArray(state?.clients) ? state.clients : [];
      if (!clients.some((c) => c && c.id === clientId)) return res.status(400).json({ error: 'Unknown property.', code: 'bad_request' });
      // One QBO entity belongs to ONE property: a second link would show the same money under two
      // properties and double it in the dashboard's book total. (The table's unique key on
      // (org, realm, entity type, entity id) backs this check against a concurrent PUT.)
      const realmLinks = (await listLinks()).filter((l) => l.realm_id === conn.realm_id);
      const holder = realmLinks.find((l) => l.entity_type === entityType && l.entity_id === entityId && l.client_id !== clientId);
      if (holder) {
        return res.status(409).json({
          error: `That QuickBooks ${ENTITY_LABEL[entityType]} is already linked to ${clientNameOf(clients, holder.client_id) || 'another property'}. Unlink it there first.`,
          code: 'entity_already_linked',
        });
      }
      // CS-565: ONE dimension per company. The other properties' links (this one's own is being
      // replaced) set it; a link on another dimension would count the same money twice.
      const dimension = realmDimension(realmLinks.filter((l) => l.client_id !== clientId));
      if (dimension && dimension !== entityType) {
        return res.status(409).json({
          error: `This company's properties are linked to QuickBooks ${ENTITY_LABEL[dimension]}s. Link this one to a ${ENTITY_LABEL[dimension]} too, or unlink the others first.`,
          code: 'dimension_mismatch',
        });
      }
      await putLink({ clientId, realmId: conn.realm_id, entityType, entityId, entityName: typeof entityName === 'string' ? entityName : null, linkedBy: g.orgUserId });
      await purgeReportCache(); // links changed → the P&L view is stale
      return res.status(200).json({ ok: true });
    }
    if (route === 'links' && req.method === 'DELETE') {
      const g = await requireRole(req, res, ['owner']);
      if (!g) return;
      const clientId = (body && typeof body.clientId === 'string' && body.clientId) || (typeof req.query.clientId === 'string' ? req.query.clientId : '');
      if (!clientId) return res.status(400).json({ error: 'clientId is required.', code: 'bad_request' });
      await deleteLink(clientId);
      await purgeReportCache();
      return res.status(200).json({ ok: true });
    }

    // ── per-property P&L (financials.view; SCOPED) ───────────────────────────
    if (route === 'pnl' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'financials.view');
      if (!g) return;
      // A rolling preset, 'mtd', a calendar month (YYYY-MM) or a span of dates (YYYY-MM-DD_YYYY-MM-DD)
      // — the dashboard's period picker (_lib/qbo/ranges.js → src/lib/pnlRange.js). The shape is
      // checked here; the dates themselves (not after today, not before all-time) once the org's
      // zone is known, below.
      const badRange = () => res.status(400).json({
        error: `range must be one of ${RANGE_KEYS.join(', ')}, ${MONTH_TO_DATE}, a month (YYYY-MM) or a span (YYYY-MM-DD_YYYY-MM-DD) that does not start after today`,
        code: 'bad_request',
      });
      const range = rangeKind(req.query.range) ? req.query.range : null;
      if (!range) return badRange();
      const environment = qboEnvironment();
      const conn = environment ? await getConnectionForEnv(environment) : null;
      if (!conn) return res.status(200).json({ connected: false });

      const { state } = await readOrgState();
      const clients = Array.isArray(state?.clients) ? state.clients : [];
      const clientsById = new Map(clients.map((c) => [c && c.id, c]));
      const tz = state?.company?.timezone;

      // Scope: owner sees every linked property on the connected realm; every other holder
      // sees only properties they supervise (client.supervisorId === their id) — an Operations
      // Manager their TEAM's (S131, lib/teamScope: their own and their account managers', from the
      // claim role and the committed roster). Never send another property's numbers to a scoped
      // caller. Only the company's ONE dimension is counted (CS-565): a link on another dimension,
      // made before that rule, would add the same money a second time, so it is left out of every book.
      const allRealmLinks = (await listLinks()).filter((l) => l.realm_id === conn.realm_id);
      const dimension = realmDimension(allRealmLinks);
      const realmLinks = allRealmLinks.filter((l) => l.entity_type === dimension);
      const teamIds = g.role === 'manager' && g.orgUserId && isOpsManagerIn(state?.users, { id: g.orgUserId, role: g.role })
        ? teamClientIds(state?.users, clients, g.orgUserId) : null;
      const scoped = realmLinks
        .filter((l) => {
          if (g.role === 'owner') return true;
          if (!g.orgUserId) return false; // an id-less holder supervises nothing (never null === null)
          if (teamIds) return teamIds.has(l.client_id);
          const c = clientsById.get(l.client_id);
          return !!c && c.supervisorId === g.orgUserId;
        });

      let start;
      let end;
      try { ({ start, end } = resolveRange(range, { tz })); } catch { return badRange(); }

      // ONE P&L call for the company's one dimension (never one per property, so cost stays flat
      // as properties grow), served from the nightly snapshot when there is one (QB-9: a day's
      // worth, `pnlTtlMs`; 'Today' an hour), filtered to the linked ids and their descendants
      // (CS-598; _lib/qbo/pnl.js). Money is attributed over EVERY link of the dimension on this
      // realm, not only the caller's: a sub-customer's amounts go to its own property when it is
      // linked, else to its nearest linked parent (report.js attributeToLinked), so a parent
      // linked on its own covers its subtree and nothing is ever counted twice.
      let attributed = new Map();
      let basis = null;
      let asOf = null;
      if (scoped.length) {
        const deadline = started + ROUTE_BUDGET_MS;
        const linkedIds = realmLinks.map((l) => l.entity_id);
        // The P&L filter accepts the nightly entity list (a sub-customer added today is in
        // tomorrow's), so a dashboard read rarely pays for the 1,895-customer list itself.
        const { entities } = await loadEntities({ environment, realmId: conn.realm_id, type: dimension, maxAgeMs: NIGHTLY_TTL_MS, deadline });
        const got = await loadPnl({
          environment, realmId: conn.realm_id, type: dimension, rangeKey: range, tz, linkedIds, entities,
          freshAfter: Date.now() - pnlTtlMs(range), deadline,
        });
        attributed = attributeToLinked(got.parsed, linkedIds);
        basis = got.parsed.basis;
        asOf = got.fetchedAt;
        ({ start, end } = got);
      }

      const accounts = scoped.map((l) => {
        const ent = attributed.get(l.entity_id) || null;
        return {
          clientId: l.client_id,
          clientName: clientNameOf(clients, l.client_id),
          entityType: l.entity_type,
          entityName: l.entity_name,
          incomeCents: ent?.incomeCents ?? 0,
          cogsCents: ent?.cogsCents ?? 0,
          grossProfitCents: ent?.grossProfitCents ?? 0,
          expensesCents: ent?.expensesCents ?? 0,
          netOperatingIncomeCents: ent?.netOperatingIncomeCents ?? 0,
          netIncomeCents: ent?.netIncomeCents ?? 0,
        };
      });

      return res.status(200).json({
        connected: true, environment, basis, range, start, end,
        asOf: asOf || new Date().toISOString(), accounts,
      });
    }

    // ── the "needs matching" list (QB-12; integrations.view) ─────────────────
    // Matt: "When a QuickBooks customer doesn't match an account in the app? Put it on a 'needs
    // matching' list for your analyst." The SAME read permission as `status`: the list is names
    // (no money — an admin or analyst granted it sees no figures), and linking one stays PUT
    // links, owner-only. COMPLETE: the whole customer list (count first, every page — 1,895 on
    // Matt's book) and the twelve months' activity a chunk at a time; an activity read that
    // could not finish in this request's budget answers activityKnown:false and lists every
    // active customer rather than guess (the next call reads only the missing chunks).
    if (route === 'needs-matching' && req.method === 'GET') {
      const g = await requirePermission(req, res, 'integrations.view');
      if (!g) return;
      const environment = qboEnvironment();
      const conn = environment ? await getConnectionForEnv(environment) : null;
      if (!conn) return res.status(200).json({ connected: false });
      const { state } = await readOrgState();
      const tz = state?.company?.timezone;
      const deadline = started + ROUTE_BUDGET_MS;
      const realmLinks = (await listLinks()).filter((l) => l.realm_id === conn.realm_id);
      const { entities } = await loadEntities({ environment, realmId: conn.realm_id, type: 'customer', maxAgeMs: NIGHTLY_TTL_MS, deadline });
      const activity = await loadCustomerActivity({
        environment, realmId: conn.realm_id, tz, entities, deadline, freshAfter: Date.now() - NIGHTLY_TTL_MS,
      });
      const result = needsMatching({
        entities,
        linkedIds: realmLinks.filter((l) => l.entity_type === 'customer').map((l) => l.entity_id),
        activeIds: activity.complete ? activity.ids : null,
      });
      return res.status(200).json({
        connected: true,
        environment,
        dimension: realmDimension(realmLinks),
        window: activity.window,
        activityKnown: activity.complete,
        counts: result.counts,
        customers: result.customers,
        linkedClientIds: [...new Set(realmLinks.map((l) => l.client_id))],
      });
    }

    // ── unknown subpath: authenticate before 404 (401 for an anonymous caller) ──
    const a = await requireAuthority(req, res);
    if (!a) return;
    return res.status(404).json({ error: 'Unknown route', code: 'not_found' });
  } catch (e) {
    if (e instanceof QboError) {
      const { status, code, retryable, message } = mapQboError(e);
      if (retryable) res.setHeader('Retry-After', '60');
      return res.status(status).json({ error: message, code, ...(retryable ? { retryable: true } : {}) });
    }
    // CS-571: say WHAT failed. Store errors carry a code and the table + Supabase's text; nothing
    // here holds a token, a request body or PII. Never in the response — only the log.
    console.error(`[api/quickbooks] ${e?.code || 'error'}: ${String(e?.message || '').slice(0, 200)}`);
    return res.status(500).json({ error: 'Server error', code: 'server_error' });
  }
}
