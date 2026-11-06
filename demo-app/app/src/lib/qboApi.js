// QuickBooks Online API adapter (/api/quickbooks/*). Real backend only in a deployed build;
// a localStorage STUB in a DEMO build so the whole UI — connect, link, refresh, disconnect,
// the live dashboard — is exercisable offline with no Intuit and no Supabase.
//
// CS-038: the stub must NEVER engage in production. It gates on the STATIC Vite MODE Vite
// inlines at build time — MODE === 'demo' (the static demo + `--mode demo` dev servers), or a
// dev opt-in VITE_QBO_STUB=1 in a NON-production build. In `npm run build` (MODE ===
// 'production') STUB folds to a compile-time `false`, every `if (!STUB)` takes the real path,
// and the stub bodies + the 'cs-stub:qbo' sentinel dead-code-eliminate (check-bundle-stubs.mjs
// / test-bundle-stubs.mjs assert it; test-prod-stubs.mjs asserts QBO_STUB_ACTIVE folds false).
// Dispatch keys on the STATIC STUB, never on the runtime BACKEND url (which cannot fold).
//
// Connect uses a popup (same shape as connectedInboxes' Gmail connect): the server mints the Intuit
// consent url (authority is checked there — the popup can't carry our Bearer header), the
// popup goes to Intuit, and the callback page postMessages a { type:'connect-qbo' } result to
// OUR origin. The listener verifies event.origin === window.location.origin and the type
// before trusting it (DEV_PLAYBOOK 3.6.11 / decision 1). Owner-only actions (connect,
// disconnect, refresh, link, unlink, entities) are gated server-side by requireRole(['owner']);
// the UI mirrors that by rendering those controls only for an owner.
import { authHeaders } from './authHeader';
import { markStub } from './demoMode';
import { QBO_STUB_KEY } from '../data/stubKeys';
import {
  stubEmptyDb, stubSandboxCompany, stubEntities, stubPnlAccounts, stubCustomerActivity, stubActivityWindow,
} from './qboStubData';
import { realmDimension, needsMatching } from './qboRules';

const STUB =
  import.meta.env.MODE === 'demo' ||
  (!import.meta.env.PROD &&
    (import.meta.env.VITE_QBO_STUB === '1' || import.meta.env.VITE_QBO_STUB === 'true'));
if (STUB) markStub('cs-stub:qbo');

// Exported for the CS-038 prod-stub unit gate (test-prod-stubs.mjs): must be a compile-time
// constant that folds to false in a production build.
export const QBO_STUB_ACTIVE = STUB;
export function isQboStubMode() { return STUB; }

const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    let code = null;
    let retryable = false;
    try {
      const b = await res.json();
      msg = b.error || msg;
      code = typeof b.code === 'string' ? b.code : null;
      retryable = b.retryable === true;
    } catch { /* non-JSON */ }
    const err = new Error(msg);
    err.status = res.status;
    err.code = code;            // the route's machine code (e.g. dimension_mismatch)
    err.retryable = retryable;  // a transient QuickBooks condition: try again shortly
    throw err;
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── demo stub persistence ─────────────────────────────────────────────────────
const loadDb = () => {
  try { return JSON.parse(localStorage.getItem(QBO_STUB_KEY)) || stubEmptyDb(); } catch { return stubEmptyDb(); }
};
const saveDb = (db) => { try { localStorage.setItem(QBO_STUB_KEY, JSON.stringify(db)); } catch { /* quota / private mode */ } };

// Friendly message for a failed OAuth callback code (never provider text).
function connectErrorMessage(code) {
  if (code === 'access_denied') return 'You cancelled the QuickBooks connection.';
  if (code === 'not_configured') return 'QuickBooks is not configured for this deployment.';
  if (code === 'state_used' || code === 'state_invalid') return 'The connection link expired. Please try connecting again.';
  return 'QuickBooks connection failed. Please try again.';
}

// ── status ────────────────────────────────────────────────────────────────────
export async function getQboStatus() {
  if (!STUB) return api('/quickbooks/status');
  const db = loadDb();
  const conn = db.connection;
  return {
    connected: !!conn,
    configured: !db.notConfigured, // demo affordance: set db.notConfigured to preview the not-configured state
    environment: 'sandbox',
    companyName: conn?.companyName ?? null,
    status: conn?.status ?? null,
    reauthRequired: conn?.status === 'reauth_required',
    lastError: conn?.lastError ?? null,
    lastSyncedAt: conn?.lastSyncedAt ?? null,
    connectedAt: conn?.connectedAt ?? null,
    connectedByName: conn?.connectedByName ?? null,
  };
}

// ── connect (owner) ─────────────────────────────────────────────────────────────
// Real: popup → Intuit → callback postMessage. Stub: simulate a sandbox connect, no popup.
export async function connectQbo() {
  if (STUB) {
    const db = loadDb();
    const company = stubSandboxCompany();
    db.connection = {
      ...company,
      connectedAt: new Date().toISOString(),
      lastSyncedAt: null,
      lastError: null,
      connectedByName: 'You (demo)',
    };
    saveDb(db);
    return { ok: true };
  }
  // The server picks the registered callback address on THIS origin (the app answers at
  // www.cleancorner.app and the old cleanspace-gilt.vercel.app), so the popup's result comes back
  // to this window; it chooses from its own list and never uses the value as an address.
  const startedAt = Date.now();
  const { url } = await api(`/quickbooks/oauth/start?origin=${encodeURIComponent(window.location.origin)}`);
  return new Promise((resolve, reject) => {
    const popup = window.open(url, 'connect-qbo', 'width=600,height=720,menubar=no,toolbar=no,location=no,status=no');
    if (!popup) { reject(new Error('Popup blocked. Allow popups for this site and try again.')); return; }
    let settled = false;
    const onMessage = (e) => {
      // Trust ONLY a message from our own origin carrying our type (SEC / 3.6.11).
      if (e.origin !== window.location.origin) return;
      if (!e.data || typeof e.data !== 'object' || e.data.type !== 'connect-qbo') return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearInterval(poll);
      try { popup.close(); } catch { /* ignore */ }
      if (e.data.ok) resolve({ ok: true });
      else reject(new Error(connectErrorMessage(e.data.error)));
    };
    window.addEventListener('message', onMessage);
    // The popup closed and said nothing: the person cancelled — OR the result went to another
    // address (a callback on a domain this window is not on posts where this window cannot hear).
    // The status decides: a connection made since this click is a success, not "cancelled".
    const poll = setInterval(() => {
      if (popup.closed && !settled) {
        settled = true;
        clearInterval(poll);
        window.removeEventListener('message', onMessage);
        getQboStatus()
          .then((st) => {
            const fresh = st?.connected && st.connectedAt && Date.parse(st.connectedAt) >= startedAt - 60 * 1000;
            if (fresh) resolve({ ok: true });
            else reject(new Error('Connection was cancelled.'));
          })
          .catch(() => reject(new Error('Connection was cancelled.')));
      }
    }, 500);
  });
}

// ── disconnect / refresh (owner) ────────────────────────────────────────────────
export async function disconnectQbo() {
  if (!STUB) return api('/quickbooks/disconnect', { method: 'POST' });
  const db = loadDb();
  db.connection = null; // links stay — they are realm-scoped (server behavior)
  saveDb(db);
  return { ok: true, connected: false };
}

export async function refreshQbo() {
  if (!STUB) return api('/quickbooks/refresh', { method: 'POST' });
  const db = loadDb();
  if (db.connection) { db.connection.lastSyncedAt = new Date().toISOString(); saveDb(db); }
  return { ok: true };
}

// ── entities / links (owner) ─────────────────────────────────────────────────────
export async function listQboEntities(type) {
  if (!STUB) return api(`/quickbooks/entities?type=${encodeURIComponent(type)}`);
  const db = loadDb();
  if (!db.connection) return { connected: false, entities: [] };
  return { connected: true, environment: 'sandbox', type, entities: stubEntities(type) };
}

export async function listQboLinks() {
  if (!STUB) return api('/quickbooks/links');
  const db = loadDb();
  const connected = !!db.connection;
  const realmId = db.connection?.realmId ?? null;
  const dimension = connected ? realmDimension(db.links) : null;
  return {
    connected,
    environment: 'sandbox',
    realmId,
    dimension,
    links: (db.links || []).map((l) => ({
      clientId: l.clientId,
      clientName: null, // the UI resolves the display name from the live client roster
      entityType: l.entityType,
      entityId: l.entityId,
      entityName: l.entityName,
      realmId,
      active: connected,
      counted: connected && l.entityType === dimension,
    })),
  };
}

export async function linkQboProperty({ clientId, entityType, entityId, entityName }) {
  if (!STUB) return api('/quickbooks/links', { method: 'PUT', body: { clientId, entityType, entityId, entityName } });
  const db = loadDb();
  // The server's rules, mirrored (409 there): one QuickBooks entity belongs to ONE property,
  // and a company's properties are linked on ONE dimension (CS-565).
  const label = (t) => (t === 'department' ? 'location' : t);
  if ((db.links || []).some((l) => l.entityType === entityType && l.entityId === entityId && l.clientId !== clientId)) {
    const err = new Error(`That QuickBooks ${label(entityType)} is already linked to another property. Unlink it there first.`);
    err.status = 409;
    throw err;
  }
  const dimension = realmDimension((db.links || []).filter((l) => l.clientId !== clientId));
  if (dimension && dimension !== entityType) {
    const err = new Error(`This company's properties are linked to QuickBooks ${label(dimension)}s. Link this one to a ${label(dimension)} too, or unlink the others first.`);
    err.status = 409;
    err.code = 'dimension_mismatch';
    throw err;
  }
  db.links = [...(db.links || []).filter((l) => l.clientId !== clientId), { clientId, entityType, entityId, entityName }];
  saveDb(db);
  return { ok: true };
}

export async function unlinkQboProperty(clientId) {
  if (!STUB) return api('/quickbooks/links', { method: 'DELETE', body: { clientId } });
  const db = loadDb();
  db.links = (db.links || []).filter((l) => l.clientId !== clientId);
  saveDb(db);
  return { ok: true };
}

// ── the "needs matching" list (QB-12; integrations.view) ──────────────────────────
// QuickBooks customers with activity in the last twelve months that reach no property, plus
// the linked app customers' ids for the reverse view. Names only. The stub runs the server's
// own rule (lib/qboRules needsMatching) over its fixtures.
export async function getQboNeedsMatching() {
  if (!STUB) return api('/quickbooks/needs-matching');
  const db = loadDb();
  if (!db.connection) return { connected: false };
  const links = db.links || [];
  const result = needsMatching({
    entities: stubEntities('customer'),
    linkedIds: links.filter((l) => l.entityType === 'customer').map((l) => l.entityId),
    activeIds: stubCustomerActivity(),
  });
  return {
    connected: true,
    environment: 'sandbox',
    dimension: realmDimension(links),
    window: stubActivityWindow(),
    activityKnown: true,
    counts: result.counts,
    customers: result.customers,
    linkedClientIds: [...new Set(links.map((l) => l.clientId))],
  };
}

// ── per-property P&L (financials.view; server SCOPES a non-owner) ─────────────────
export async function getQboPnl(range) {
  if (!STUB) return api(`/quickbooks/pnl?range=${encodeURIComponent(range)}`);
  const db = loadDb();
  if (!db.connection) return { connected: false };
  return {
    connected: true,
    environment: 'sandbox',
    basis: 'Accrual',
    range,
    asOf: new Date().toISOString(),
    accounts: stubPnlAccounts(db.links, range),
  };
}
