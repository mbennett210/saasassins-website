// Client adapter for the OFFICE's customer Messages (client hub redesign, plan §3.4; D5) —
// /api/client-messages/*: the Customers tab in Messaging and the customer page's Messages tab.
// The customer's own side is lib/clientHubApi.js (/api/hub/*).
//
// Real backend by default. The demo store engages ONLY in a DEMO build, on the STATIC
// `import.meta.env.MODE` Vite inlines at build time — the lib/contractsApi.js / quotesApi.js
// pattern and the CS-010 lesson (a runtime switch once ran production Quotes on a browser stub
// for weeks). In `npm run build` (MODE === 'production') STUB folds to `false`, the dynamic import
// below is dead code, no chunk is emitted for lib/clientMessagesDemo.js, and the
// 'cs-stub:client-messages' sentinel is gone — check-bundle-stubs.mjs asserts it.
//
// `ctx` — { user } — is read by the DEMO only (who is signed in on the demo's user switcher); the
// real route takes the caller's identity from the login's claim, never from a request.
import { authHeaders } from './authHeader';
import { markStub } from './demoMode';

// PLAIN member reads so Vite inlines them and STUB folds to a literal (see the header).
const STUB =
  import.meta.env.MODE === 'demo' ||
  (!import.meta.env.PROD &&
    (import.meta.env.VITE_CLIENT_MESSAGES_STUB === '1' || import.meta.env.VITE_CLIENT_MESSAGES_STUB === 'true'));
if (STUB) markStub('cs-stub:client-messages');
const loadDemo = STUB ? () => import('./clientMessagesDemo.js') : null;
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isClientMessagesStub() { return STUB; }

const qs = (params) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === '') continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
};

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const err = new Error(json?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = json?.code || null;
    throw err;
  }
  return json;
}

// A caller-minted id per line (THE LAW II.7): a retried Send is one message.
export const newMessageId = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : null);

// The thread list: { threads[], total, offset, limit, unreadThreads }. `filter` is 'mine' | 'all'.
export async function listCustomerThreads({ filter = 'all', managerId = null, clientId = null, om = null, offset = 0, limit } = {}, ctx = {}) {
  const q = { filter, managerId, clientId, om, offset, limit };
  if (loadDemo) return (await loadDemo()).officeThreads(q, ctx);
  return api(`/client-messages/threads${qs(q)}`);
}

// EVERY thread waiting for the office's reply (its customer wrote last), the longest wait first, each
// with `waitingSince`: { threads[], total }. Complete. Messaging → Customers' Waiting view, the
// manager Home's Customer messages count and the Messages pill read it (HUB-24 (c): a waiting
// message is its own figure, never a client request).
export async function listWaitingCustomerThreads({ managerId = null, clientId = null, om = null } = {}, ctx = {}) {
  const q = { waiting: 1, managerId, clientId, om };
  if (loadDemo) return (await loadDemo()).officeThreads(q, ctx);
  return api(`/client-messages/threads${qs(q)}`);
}

// One building's thread: { client, manager, messages[] (oldest first), hasMore, readAt, waitingSince,
// textBack } (`waitingSince`: since when it has waited for the office's reply, or null; `textBack`:
// { phone, optedOutAt } when the newest customer line came by text, so the reply is texted there).
export async function fetchCustomerThread(clientId, { before = null, limit } = {}, ctx = {}) {
  if (loadDemo) return (await loadDemo()).officeThread(clientId, { before, limit }, ctx);
  return api(`/client-messages/thread${qs({ clientId, before, limit })}`);
}

// The office's reply: { message }. The author is the signed-in person (the server's claim).
export async function sendCustomerMessage({ clientId, body, id = newMessageId() }, ctx = {}) {
  const payload = { id, clientId, body };
  if (loadDemo) return (await loadDemo()).officeSend(payload, ctx);
  return api('/client-messages/send', { method: 'POST', body: payload });
}

// Which of a customer's numbers have texts off (they replied STOP), and since when:
// { optOuts: [{ phone (E.164), optedOutAt, source }] }. The customer page's read-only note.
export async function fetchCustomerTextStatus(clientId, ctx = {}) {
  if (loadDemo) return (await loadDemo()).textStatus(clientId, ctx);
  return api(`/client-messages/text-status${qs({ clientId })}`);
}

// Mark the thread read for the signed-in person, up to `at` (the newest line they saw).
export async function markCustomerThreadRead(clientId, at = null, ctx = {}) {
  const payload = { clientId, at };
  if (loadDemo) return (await loadDemo()).officeRead(payload, ctx);
  return api('/client-messages/read', { method: 'POST', body: payload });
}
