// Quotes API adapter — e-signature document flow. Real backend by default
// (Vercel serves /api/quotes/* + /api/public/pay/*). The localStorage stub (which can't
// render the real server-side PDF — it just tracks status so the UI flow is exercisable)
// engages ONLY in a DEMO/DEV build, never in production.
//
// CS-010: production once ran on this stub for weeks (the Vercel build was `build:demo`,
// which inlined VITE_QUOTES_STUB=1), so every staff quote saved to that one browser and
// no customer e-sign link resolved. The stub now gates on the STATIC Vite mode Vite
// inlines at build time: MODE === 'demo' (the static demo + the --mode demo dev servers),
// or a dev opt-in VITE_QUOTES_STUB=1 in a NON-production build. In `npm run build`
// (MODE === 'production') STUB folds to a compile-time `false`, so every `if (!STUB)`
// takes the real path and the stub bodies + the 'cs-stub:quotes' sentinel are dead code
// esbuild removes — check-bundle-stubs.mjs asserts it. See lib/demoMode.js.
//
// The dispatch keys on the STATIC `STUB`, never on the runtime BACKEND URL: `if (BACKEND)`
// cannot fold (the URL is resolved at runtime), so the stub bodies would survive in prod.
import { authHeaders } from './authHeader';
import { markStub } from './demoMode';

// import.meta.env.MODE / .PROD / .VITE_QUOTES_STUB are PLAIN member reads so Vite inlines
// them → STUB folds to a literal → the stub dead-code-eliminates from a production build.
// (This module is browser-only — never imported by a bare-Node script — so it needs no
// `typeof import.meta` guard, and that guard is exactly what blocks esbuild from folding.)
// `!PROD && flag` is ordered so production's `false && …` drops the flag branch entirely.
const STUB =
  import.meta.env.MODE === 'demo' ||
  (!import.meta.env.PROD &&
    (import.meta.env.VITE_QUOTES_STUB === '1' || import.meta.env.VITE_QUOTES_STUB === 'true'));
if (STUB) markStub('cs-stub:quotes');
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isStubMode() { return STUB; }

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try { msg = (await res.json()).error || msg; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

// ── admin ───────────────────────────────────────────────────────────────────
export async function listQuotes() {
  if (!STUB) return (await api('/quotes/list')).quotes;
  return [...loadStub().quotes].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}
export async function createQuote({ contact, templateKey }) {
  if (!STUB) return (await api('/quotes/create', { method: 'POST', body: { contact, templateKey } })).quote;
  return stubCreate({ contact, templateKey });
}
export async function getQuote(id) {
  if (!STUB) return (await api(`/quotes/${id}`)).quote;
  return loadStub().quotes.find((q) => q.id === id) || null;
}
export async function saveQuote(id, fields) {
  if (!STUB) return (await api(`/quotes/${id}/save`, { method: 'POST', body: { fields } })).quote;
  return stubUpdate(id, (q) => ({ ...q, fields: { ...q.fields, ...fields } }));
}
export async function adminSignQuote(id, { signerName, signatureDataUrl }) {
  if (!STUB) return (await api(`/quotes/${id}/admin-sign`, { method: 'POST', body: { signerName, signatureDataUrl } })).quote;
  return stubUpdate(id, (q) => ({ ...q, admin_signed_at: nowIso(), admin_signer_name: signerName }));
}
export async function sendQuote(id) {
  if (!STUB) return (await api(`/quotes/${id}/send`, { method: 'POST' })).quote;
  return stubUpdate(id, (q) => ({ ...q, status: 'sent', sent_at: nowIso() }));
}
export async function voidQuote(id) {
  if (!STUB) return (await api(`/quotes/${id}/void`, { method: 'POST' })).quote;
  return stubUpdate(id, (q) => ({ ...q, status: 'void' }));
}
export async function deleteQuote(id) {
  if (!STUB) return api(`/quotes/${id}/delete`, { method: 'POST' });
  const db = loadStub(); db.quotes = db.quotes.filter((q) => q.id !== id); saveStub(db); return { ok: true };
}
export async function getDownloadUrl(id) {
  if (!STUB) return (await api(`/quotes/${id}/download`)).url;
  return null;
}

// ── public ─────────────────────────────────────────────────────────────────
export async function getPublicQuote(token) {
  if (!STUB) return (await api(`/public/pay/${token}`)).quote;
  const q = loadStub().quotes.find((x) => x.public_token === token);
  return q ? { token: q.public_token, status: q.status, fields: q.fields, contact_name: q.contact_name, admin_signer_name: q.admin_signer_name, admin_signed: !!q.admin_signed_at } : null;
}
export async function signPublicQuote(token, { signerName, signerEmail, signatureDataUrl }) {
  if (!STUB) return api(`/public/pay/${token}/sign`, { method: 'POST', body: { signerName, signerEmail, signatureDataUrl } });
  const db = loadStub();
  const q = db.quotes.find((x) => x.public_token === token);
  if (q) { q.status = 'signed'; q.client_signed_at = nowIso(); q.client_signer_name = signerName; saveStub(db); }
  return { ok: true, status: 'signed' };
}

// ── stub store (demo/dev only; dead-code-eliminated from a production build) ───
const STUB_KEY = 'cleanspace_quotes_stub_v2';
const nowIso = () => new Date().toISOString();
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;
const loadStub = () => { try { return JSON.parse(localStorage.getItem(STUB_KEY)) || { quotes: [] }; } catch { return { quotes: [] }; } };
const saveStub = (db) => { try { localStorage.setItem(STUB_KEY, JSON.stringify(db)); } catch { /* quota */ } };
function stubCreate({ contact, templateKey }) {
  const db = loadStub();
  const q = {
    id: rid('quote'), public_token: rid('tok').slice(4), template_key: templateKey || 'cleanspace_quote_v1',
    contact_id: contact?.id ?? null, contact_name: contact?.name ?? null, contact_email: contact?.email ?? null,
    title: `Quote for ${contact?.company || contact?.name || 'Quote'}`,
    fields: { clientName: contact?.name || '', companyName: contact?.company || contact?.companyName || '', fee: '$1160/month- weekly cleaning services', frequency: '', restrooms: '', area: '' },
    status: 'draft', created_at: nowIso(), updated_at: nowIso(),
  };
  db.quotes.push(q); saveStub(db); return q;
}
function stubUpdate(id, fn) {
  const db = loadStub();
  const i = db.quotes.findIndex((q) => q.id === id);
  if (i >= 0) { db.quotes[i] = { ...fn(db.quotes[i]), updated_at: nowIso() }; saveStub(db); return db.quotes[i]; }
  return null;
}
