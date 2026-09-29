// Integrations/webhooks API adapter (real /api/settings/* when deployed; a localStorage
// stub in a DEMO/DEV build so the UI is fully exercisable offline).
//
// CS-038: the stub must NEVER engage in production. It now gates on the STATIC Vite mode
// Vite inlines at build time — MODE === 'demo' (the static demo + the --mode demo dev
// servers), or a dev opt-in VITE_INTEGRATIONS_STUB=1 in a NON-production build. In
// `npm run build` (MODE === 'production') STUB folds to a compile-time `false`, so every
// `if (!STUB)` takes the real path and the stub bodies + the 'cs-stub:integrations'
// sentinel dead-code-eliminate — check-bundle-stubs.mjs asserts it. See lib/demoMode.js.
//
// Dispatch keys on the STATIC `STUB`, never on the runtime BACKEND URL (which cannot fold,
// so `if (BACKEND)` would keep the stub bodies in prod). This module is browser-only, so
// the plain import.meta.env reads need no `typeof import.meta` guard (which blocks folding).
// Replaces the previous `!isAuthConfigured()` fallback (II.5): a hosted build with no
// Supabase configured is a broken deploy that should fail loudly against /api, not
// silently serve a browser stub.
import { authHeaders } from './authHeader';
import { markStub } from './demoMode';

const STUB =
  import.meta.env.MODE === 'demo' ||
  (!import.meta.env.PROD &&
    (import.meta.env.VITE_INTEGRATIONS_STUB === '1' || import.meta.env.VITE_INTEGRATIONS_STUB === 'true'));
if (STUB) markStub('cs-stub:integrations');
const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FORMS_BACKEND_URL) || '/api';

export function isStubMode() { return STUB; }

async function api(path, { method = 'GET', body } = {}) {
  const auth = await authHeaders();
  const res = await fetch(`${BACKEND}${path}`, {
    method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...auth },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { let m = `Request failed (${res.status})`; try { m = (await res.json()).error || m; } catch { /* */ } throw new Error(m); }
  if (res.status === 204) return null;
  return res.json();
}

const KEY = 'cleanspace_integrations_stub_v1';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { endpoints: [], outbound: [], snapshot: null }; } catch { return { endpoints: [], outbound: [], snapshot: null }; } };
const save = (d) => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* */ } };
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;

// ── inbound endpoints ──
export async function listEndpoints() {
  if (!STUB) return (await api('/settings/webhooks')).endpoints;
  return load().endpoints;
}
export async function createEndpoint({ name, purpose, leadConfig }) {
  if (!STUB) return (await api('/settings/webhooks', { method: 'POST', body: { name, purpose, lead_config: leadConfig } })).endpoint;
  const db = load();
  const ep = { id: rid('ep'), name: name || 'Inbound webhook', slug: rid('s').slice(2), signing_secret: `whsec_stub_${rid('x')}`, purpose: purpose || 'generic', is_active: true, created_at: new Date().toISOString() };
  if (purpose === 'lead_intake') { ep.bearer_token = `rlw_stub_${rid('t')}`; ep.lead_config = leadConfig || null; }
  db.endpoints.push(ep); save(db); return ep;
}
export async function updateEndpoint(id, patch) {
  if (!STUB) return api(`/settings/webhooks/${id}`, { method: 'PATCH', body: patch });
  const db = load(); const e = db.endpoints.find((x) => x.id === id); if (e) Object.assign(e, patch); save(db); return { ok: true };
}
// Regenerate a lead webhook's bearer token; returns { bearer_token }.
export async function rotateWebhookToken(id) {
  if (!STUB) return api(`/settings/webhooks/${id}`, { method: 'PATCH', body: { rotate: true } });
  const db = load(); const e = db.endpoints.find((x) => x.id === id); const token = `rlw_stub_${rid('t')}`; if (e) e.bearer_token = token; save(db); return { ok: true, bearer_token: token };
}
export async function deleteEndpoint(id) {
  if (!STUB) return api(`/settings/webhooks/${id}`, { method: 'DELETE' });
  const db = load(); db.endpoints = db.endpoints.filter((x) => x.id !== id); save(db); return { ok: true };
}

// ── outbound webhooks ──
export async function listOutbound() {
  if (!STUB) return (await api('/settings/outbound')).outbound;
  return load().outbound;
}
export async function createOutbound({ url, eventTypes }) {
  if (!STUB) return (await api('/settings/outbound', { method: 'POST', body: { url, eventTypes } })).webhook;
  const db = load();
  const w = { id: rid('ob'), url, secret: `whsec_stub_${rid('x')}`, event_types: eventTypes || [], is_active: true, created_at: new Date().toISOString() };
  db.outbound.push(w); save(db); return w;
}
export async function updateOutbound(id, patch) {
  if (!STUB) return api(`/settings/outbound/${id}`, { method: 'PATCH', body: patch });
  const db = load(); const w = db.outbound.find((x) => x.id === id); if (w) Object.assign(w, patch); save(db); return { ok: true };
}
export async function deleteOutbound(id) {
  if (!STUB) return api(`/settings/outbound/${id}`, { method: 'DELETE' });
  const db = load(); db.outbound = db.outbound.filter((x) => x.id !== id); save(db); return { ok: true };
}

// ── snapshot ──
export async function getSnapshot() {
  if (!STUB) return (await api('/settings/snapshot')).snapshot;
  return load().snapshot;
}
