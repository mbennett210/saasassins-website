// QuickBooks Online HTTP client — plain fetch against Intuit's documented OAuth2 + Accounting
// API endpoints (no SDK). Every outbound call is bounded by AbortSignal.timeout; failures log
// Intuit's `intuit_tid` response header (never a token, never PII) and throw a typed QboError
// carrying a machine CODE, so the route can answer a code + plain message and never leak
// provider text (DEV_PLAYBOOK 3.4.11/3.4.12).
//
// Vendor facts (developer.intuit.com, verified 2026-09-25):
//   authorize  https://appcenter.intuit.com/connect/oauth2
//   token      https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer   (Basic client:secret, form)
//   revoke     https://developer.api.intuit.com/v2/oauth2/tokens/revoke
//   API base   production https://quickbooks.api.intuit.com · sandbox https://sandbox-quickbooks.api.intuit.com
//   path       /v3/company/{realmId}/...   minorversion=75 (1–74 retired 2025-08-01)
//   scope      com.intuit.quickbooks.accounting

export const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
export const ACCOUNTING_SCOPE = 'com.intuit.quickbooks.accounting';
export const MINOR_VERSION = '75';

const TIMEOUT_MS = 20000;
// The least time worth starting an Intuit call with: past a caller's deadline minus this, the
// call is not made at all (QboError 'timeout') rather than started only to be cut off.
const MIN_CALL_MS = 1500;

// The timeout for one Intuit call: TIMEOUT_MS, or less when the caller has a DEADLINE (an epoch
// ms by which its whole answer must be out — a route's or a cron's own function limit, CS-572).
// Throws 'timeout' when too little time is left to make the call at all.
export function callTimeoutMs(deadline) {
  if (!deadline) return TIMEOUT_MS;
  const left = deadline - Date.now();
  if (left < MIN_CALL_MS) throw new QboError('timeout', 'No time left for a QuickBooks request.');
  return Math.min(TIMEOUT_MS, left);
}

export class QboError extends Error {
  constructor(code, message, { status = null, intuitTid = null } = {}) {
    super(message || code);
    this.name = 'QboError';
    this.code = code;             // a machine code, never provider text
    this.status = status;        // upstream HTTP status, for the route's mapping
    this.intuitTid = intuitTid;  // Intuit's request id, for logs only
  }
}

export function apiBaseFor(environment) {
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

// The Intuit authorize URL. PURE (no network). scope is accounting-only.
export function buildAuthorizeUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: ACCOUNTING_SCOPE,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function basicAuth(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}`;
}

async function readJson(res) {
  try { return await res.json(); } catch { return {}; }
}

// ── OAuth token endpoints ───────────────────────────────────────────────────

// A token-endpoint 200 is only usable if it actually carries the fields we persist: a non-empty
// access_token and refresh_token (strings) and a positive numeric expires_in. An empty or odd
// 200 (seen in the wild) would otherwise store the string 'undefined' as the access token and
// mark the connection active — a silent dead connection (CS-066 F2). PURE (no network).
export function isValidTokenResponse(data) {
  if (!data || typeof data !== 'object') return false;
  const expiresIn = Number(data.expires_in);
  return typeof data.access_token === 'string' && data.access_token.length > 0
    && typeof data.refresh_token === 'string' && data.refresh_token.length > 0
    && Number.isFinite(expiresIn) && expiresIn > 0;
}

async function tokenRequest(form, { clientId, clientSecret }, failCode) {
  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(clientId, clientSecret),
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        // Ask Intuit to include the 5-year hard-expiry so we can store it.
        'x-include-refresh-token-hard-expires-in': 'true',
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new QboError('network', `Intuit token request failed: ${e?.name || 'error'}`);
  }
  const tid = res.headers.get('intuit_tid');
  const data = await readJson(res);
  if (!res.ok) {
    // Log Intuit's request id for correlation (F5) — never a token, body or PII. apiGet already
    // logs the tid for the Accounting API; the token endpoints (exchange / refresh) did not.
    const invalidGrant = !!(data && data.error === 'invalid_grant');
    console.error(`[api/quickbooks] Intuit token endpoint ${res.status} ${invalidGrant ? 'invalid_grant' : failCode} tid=${tid || 'none'}`);
    // A dead/rotated refresh token comes back invalid_grant → the caller must reconnect.
    if (invalidGrant) {
      throw new QboError('invalid_grant', 'QuickBooks authorization is no longer valid — reconnect required.', { status: res.status, intuitTid: tid });
    }
    throw new QboError(failCode, 'QuickBooks token request was rejected.', { status: res.status, intuitTid: tid });
  }
  return data;
}

// Exchange an authorization code exactly once (Intuit invalidates on repeat).
export function exchangeCode(code, { clientId, clientSecret, redirectUri }) {
  return tokenRequest(
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
    { clientId, clientSecret }, 'token_exchange_failed',
  );
}

// Refresh — Intuit ROTATES the refresh token; the caller must persist the NEW one.
export function refreshTokens(refreshToken, { clientId, clientSecret }) {
  return tokenRequest(
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    { clientId, clientSecret }, 'token_refresh_failed',
  );
}

// Best-effort revoke on disconnect. Never throws — the row is deleted regardless.
export async function revokeToken(token, { clientId, clientSecret }) {
  try {
    const res = await fetch(REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuth(clientId, clientSecret),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // Log the tid on a failed revoke (F5) — code + tid only, never token material.
    if (!res.ok) console.error(`[api/quickbooks] Intuit token revoke ${res.status} tid=${res.headers.get('intuit_tid') || 'none'}`);
  } catch { /* best effort */ }
}

// ── Accounting API ──────────────────────────────────────────────────────────

async function apiGet(accessToken, { environment, realmId, path, query = {}, deadline = null }) {
  const url = new URL(`${apiBaseFor(environment)}/v3/company/${encodeURIComponent(realmId)}/${path}`);
  url.searchParams.set('minorversion', MINOR_VERSION);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const timeoutMs = callTimeoutMs(deadline);
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // A call cut off by its timeout is 'timeout' (QuickBooks slow: retry later, CS-572); any
    // other failure to reach Intuit is 'network'. Both are transient — the route answers 503.
    if (e?.name === 'TimeoutError') throw new QboError('timeout', 'QuickBooks did not answer in time.');
    throw new QboError('network', `Intuit API request failed: ${e?.name || 'error'}`);
  }
  const tid = res.headers.get('intuit_tid');
  const data = await readJson(res);
  if (!res.ok) {
    // A 5xx is Intuit's own trouble, transient by nature ('unavailable', retried); a 4xx other
    // than these is a request QuickBooks refuses ('api_error', not retried).
    const code = res.status === 401 ? 'unauthorized'
      : res.status === 429 ? 'throttled'
        : res.status === 403 ? 'forbidden'
          : res.status >= 500 ? 'unavailable' : 'api_error';
    // Log the tid for correlation; never the token or any PII.
    console.error(`[api/quickbooks] Intuit ${res.status} ${code} tid=${tid || 'none'}`);
    throw new QboError(code, 'QuickBooks request failed.', { status: res.status, intuitTid: tid });
  }
  return data;
}

// CompanyInfo — the company name for the connection row. (Not CompanyStartDate: it is the day
// the QuickBooks company was created, not the start of its history — see ranges.js.)
export async function fetchCompanyInfo(accessToken, { environment, realmId, deadline = null }) {
  const data = await apiGet(accessToken, { environment, realmId, path: `companyinfo/${encodeURIComponent(realmId)}`, deadline });
  const ci = data?.CompanyInfo || {};
  return { companyName: ci.CompanyName || ci.LegalName || null };
}

// Query one entity type (customer | class | department), active + inactive, each flagged.
// entityType is validated by the caller.
//
// A COMPLETE read, never a capped one (Matt's book: 1,895 customers, QB-12's "needs matching"
// list depends on seeing every one): COUNT FIRST (`select count(*)`), then exactly the pages
// that count needs, ordered by Id so each page's membership is fixed, PAGE_CONCURRENCY at a
// time (Intuit allows 10 concurrent requests per company). Customers are never deleted in
// QuickBooks (they go inactive) and new ones take higher Ids, so churn can only ADD rows past
// the count; a read that comes back SHORT of it throws 'incomplete_read' (transient: retried),
// and a book past MAX_ENTITIES throws 'too_many' rather than silently truncating.
const QBO_ENTITY = Object.freeze({ customer: 'Customer', class: 'Class', department: 'Department' });
const PAGE_SIZE = 1000;        // Intuit's maxresults ceiling
const PAGE_CONCURRENCY = 3;
export const MAX_ENTITIES = 50000;

export async function queryEntities(accessToken, { environment, realmId, entityType, deadline = null }) {
  const entity = QBO_ENTITY[entityType];
  if (!entity) throw new QboError('bad_entity', `Unknown entity type: ${entityType}`);
  const where = 'where Active in (true, false)';
  const pageQuery = (p) => `select * from ${entity} ${where} orderby Id startposition ${p * PAGE_SIZE + 1} maxresults ${PAGE_SIZE}`;
  const rowsOf = (data) => ((data?.QueryResponse && Array.isArray(data.QueryResponse[entity])) ? data.QueryResponse[entity] : []);

  // Count first. The count query was not exercised against the live sandbox (the 2026-09-28
  // probe read lists only), so a QuickBooks that REFUSES it (a 4xx 'api_error') falls back to
  // paging until a short page — still every row, just one page at a time — never to a capped read.
  let total = null;
  try {
    const counted = await apiGet(accessToken, { environment, realmId, path: 'query', query: { query: `select count(*) from ${entity} ${where}` }, deadline });
    const n = Number(counted?.QueryResponse?.totalCount);
    if (Number.isInteger(n) && n >= 0) total = n;
  } catch (e) {
    if (!(e instanceof QboError) || e.code !== 'api_error') throw e;
    console.error(`[api/quickbooks] count_unsupported ${entity}: paging until a short page`);
  }
  if (total != null && total > MAX_ENTITIES) throw new QboError('too_many', 'Too many QuickBooks records to read.');

  let pages;
  if (total != null) {
    const pageCount = Math.ceil(total / PAGE_SIZE);
    pages = new Array(pageCount);
    let next = 0;
    const worker = async () => {
      while (next < pageCount) {
        const p = next; next += 1;
        pages[p] = rowsOf(await apiGet(accessToken, { environment, realmId, path: 'query', query: { query: pageQuery(p) }, deadline }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(PAGE_CONCURRENCY, pageCount) }, worker));
  } else {
    pages = [];
    for (let p = 0; ; p += 1) {
      if (p * PAGE_SIZE >= MAX_ENTITIES) throw new QboError('too_many', 'Too many QuickBooks records to read.');
      const rows = rowsOf(await apiGet(accessToken, { environment, realmId, path: 'query', query: { query: pageQuery(p) }, deadline }));
      pages.push(rows);
      if (rows.length < PAGE_SIZE) break;
    }
  }
  const byId = new Map();
  for (const r of pages.flat()) {
    if (!r || r.Id == null) continue;
    byId.set(String(r.Id), {
      id: String(r.Id),
      name: r.DisplayName || r.FullyQualifiedName || r.Name || `(${entity} ${r.Id})`,
      active: r.Active !== false,
      type: entityType,
      // Sub-customers / sub-classes point at their parent; the P&L filter (report.js
      // reportFilterIds) needs it so a linked parent still covers its subtree.
      parentId: r.ParentRef?.value != null ? String(r.ParentRef.value) : null,
    });
  }
  if (total != null && byId.size < total) throw new QboError('incomplete_read', 'QuickBooks returned fewer records than it counted.');
  return [...byId.values()];
}

// ── the client hub's invoices (read-only; plan 2026-10-08 §3.5) ─────────────────
// One query-language statement against /query, answering QueryResponse[entity] (an empty answer
// has no entity key at all). The caller builds the statement from VALIDATED ids only (digits) and
// day keys — never a string from a request. Errors are the same typed QboErrors as every call.
//
// 🔴 NOT YET CONFIRMED against a live company: the Invoice / Payment shapes are Intuit's
// documented ones (scripts/fixtures/qbo/invoices-query.json, payments-query.json are built to the
// docs, not captured). The orchestrator's read-only sandbox probe settles them.
// `include` adds Intuit's include parameter (the customer-message billing read asks for
// `invoiceLink`, the invoice's own online pay link).
export async function queryRows(accessToken, { environment, realmId, query, entity, include = null, deadline = null }) {
  const data = await apiGet(accessToken, { environment, realmId, path: 'query', query: include ? { query, include } : { query }, deadline });
  const rows = data?.QueryResponse && Array.isArray(data.QueryResponse[entity]) ? data.QueryResponse[entity] : [];
  return rows;
}

// An invoice as Intuit renders it to PDF: GET /v3/company/{realm}/invoice/{id}/pdf with
// Accept: application/pdf. Returns a Buffer. `invoiceId` must already be validated digits.
export async function fetchInvoicePdf(accessToken, { environment, realmId, invoiceId, deadline = null }) {
  const url = new URL(`${apiBaseFor(environment)}/v3/company/${encodeURIComponent(realmId)}/invoice/${encodeURIComponent(invoiceId)}/pdf`);
  url.searchParams.set('minorversion', MINOR_VERSION);
  const timeoutMs = callTimeoutMs(deadline);
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/pdf' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new QboError('timeout', 'QuickBooks did not answer in time.');
    throw new QboError('network', `Intuit API request failed: ${e?.name || 'error'}`);
  }
  const tid = res.headers.get('intuit_tid');
  if (!res.ok) {
    const code = res.status === 401 ? 'unauthorized'
      : res.status === 429 ? 'throttled'
        : res.status === 403 ? 'forbidden'
          : res.status >= 500 ? 'unavailable' : 'api_error';
    console.error(`[api/quickbooks] Intuit invoice pdf ${res.status} ${code} tid=${tid || 'none'}`);
    throw new QboError(code, 'QuickBooks request failed.', { status: res.status, intuitTid: tid });
  }
  return Buffer.from(await res.arrayBuffer());
}

// THE BASIS every P&L is read on (QB-14, Matt 2026-09-30: "Should the bonus numbers use cash or
// accrual? (b) Accrual"). Sent EXPLICITLY as accounting_method on every request: omitted, QuickBooks
// answers on the company's own default basis, which an admin can flip in QuickBooks' settings, and
// the bonus figures would silently change meaning. The report cache key carries it too.
export const QBO_REPORT_BASIS = 'Accrual';

// ProfitAndLoss for a date window, summarized by one column dimension.
// summarizeColumnBy ∈ 'Customers' | 'Classes' | 'Departments' | 'Total'. Always on the ACCRUAL
// basis (QBO_REPORT_BASIS); Header.ReportBasis echoes it and the route reports it.
// `filter` ({ param: 'customer' | 'class' | 'department', ids }) narrows the report to those
// entities' transactions — without it a whole book is summarized, which timed out on a 778-customer
// company (2026-10-01). An empty or missing filter leaves the report unfiltered.
export async function fetchProfitAndLoss(accessToken, { environment, realmId, startDate, endDate, summarizeColumnBy, filter, deadline = null }) {
  const query = {
    start_date: startDate, end_date: endDate, summarize_column_by: summarizeColumnBy, accounting_method: QBO_REPORT_BASIS,
  };
  if (filter && filter.param && Array.isArray(filter.ids) && filter.ids.length) query[filter.param] = filter.ids.join(',');
  return apiGet(accessToken, { environment, realmId, path: 'reports/ProfitAndLoss', query, deadline });
}

// The codes that mean "QuickBooks (or the way to it) is having a moment — try again shortly":
// the route answers them 503 + retryable (429 for throttled), the nightly refresh retries them
// once and leaves the rest to its next scheduled run (CS-574, CS-572).
export const TRANSIENT_CODES = Object.freeze(new Set([
  'network', 'timeout', 'unavailable', 'throttled', 'incomplete_read', 'refresh_busy', 'refresh_failed', 'token_refresh_failed',
]));
export const isTransient = (e) => e instanceof QboError && TRANSIENT_CODES.has(e.code);
