// ─────────────────────────────────────────────────────────────────────────────
// Google Workspaces adapter — frontend interface for the multi-Workspace OAuth
// registry (Path 2). Mirrors the connectedInboxes / twilio / email adapter
// pattern: when VITE_EMAIL_BACKEND_URL is set, calls hit the deployment
// backend's /workspaces/* routes; when unset, calls fall into a stub that
// simulates the shape of real responses so the admin UI is exercised offline.
//
// The OAuth client_secret is sent ONCE to the backend on register (which stores
// it encrypted at rest) and NEVER round-trips back. The frontend only ever
// holds display metadata: { id, label, domains, clientId, clientSecretLast4,
// status }.
//
// Usage:
//   const { ok, workspace } = await registerWorkspace({ label, domains, clientId, clientSecret });
//   const { ok, status }    = await testWorkspace(workspaceId);
//   await removeWorkspace(workspaceId);
// ─────────────────────────────────────────────────────────────────────────────

import { supabase } from './supabaseClient';
import { markStub } from './demoMode';

const BACKEND = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_EMAIL_BACKEND_URL) || null;

// CS-038: mirror the Twilio adapter — a hosted build with no backend URL would otherwise FAKE
// Workspace registrations. The STATIC MODE/PROD checks come FIRST, so a production build folds
// WORKSPACES_STUB to a compile-time `false` (`(false) && !BACKEND` short-circuits before
// BACKEND) and esbuild/rolldown dead-code-eliminate the stub bodies + the
// 'cs-stub:oauthWorkspaces' sentinel (check-bundle-stubs.mjs asserts it). `MODE === 'demo'`
// keeps the stub in `build:demo`. Dispatch keys on the STATIC WORKSPACES_STUB, never on the
// runtime BACKEND URL (which can't fold). Browser-only, so the plain import.meta.env reads need
// no `typeof import.meta` guard (a guard blocks the fold). See lib/twilio.js, lib/demoMode.js.
const WORKSPACES_STUB =
  (import.meta.env.MODE === 'demo' || !import.meta.env.PROD) && !BACKEND;
if (WORKSPACES_STUB) markStub('cs-stub:oauthWorkspaces');
// WORKSPACES_CONFIGURED is false only in the broken case (a production build with no backend
// URL): the registry UI shows a "not configured" state instead of faking a register (CS-038).
export const WORKSPACES_STUB_ACTIVE = WORKSPACES_STUB;
export const WORKSPACES_CONFIGURED = !!BACKEND || WORKSPACES_STUB;
const NOT_CONFIGURED = 'Google Workspaces are not configured for this deployment.';

const STUB_DELAY_MS = 500;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Attach the signed-in user's Supabase JWT so the Super-Admin-gated workspaces
// endpoints accept the call. No-ops in local-stub mode (no supabase client).
async function authHeaders() {
  if (!supabase) return {};
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

function last4(s) {
  const t = String(s || '');
  return t.length <= 4 ? t : t.slice(-4);
}

// Register a Workspace's OAuth app. Real flow posts the client_id + secret to
// the backend, which stores the secret encrypted and returns display metadata
// (status defaults to 'pending' until the Google-admin Trusted-app approval is
// confirmed). Stub flow synthesizes the same shape.
export async function registerWorkspace({ label, domains, clientId, clientSecret }) {
  if (!label || !clientId || !clientSecret) {
    throw new Error('Workspace name, Client ID, and Client secret are required.');
  }
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/workspaces/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ label, domains, clientId, clientSecret }),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Workspace registration failed (${res.status})`);
    }
    return res.json();
  }
  if (!WORKSPACES_STUB) throw new Error(NOT_CONFIGURED);
  await delay(STUB_DELAY_MS);
  return {
    ok: true,
    workspace: {
      id: `ws_${Math.random().toString(36).slice(2, 12)}`,
      label,
      domains: Array.isArray(domains) ? domains : [],
      clientId,
      clientSecretLast4: last4(clientSecret),
      status: 'pending',
      isPrimary: false,
    },
  };
}

// Test a Workspace connection. Real flow asks the backend to exercise the token
// endpoint with the stored creds (and confirm the Trusted-app approval landed);
// stub returns a healthy result so the UI's success path is exercised.
export async function testWorkspace(workspaceId) {
  if (!workspaceId) throw new Error('Workspace id is required.');
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/workspaces/${encodeURIComponent(workspaceId)}/test`, { method: 'POST', headers: await authHeaders() });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Workspace test failed (${res.status})`);
    }
    return res.json();
  }
  if (!WORKSPACES_STUB) throw new Error(NOT_CONFIGURED);
  await delay(STUB_DELAY_MS);
  return { ok: true, status: 'active' };
}

// Remove a Workspace's OAuth registration. The backend refuses if mailboxes
// still reference it; the UI guards this too.
export async function removeWorkspace(workspaceId) {
  if (!workspaceId) throw new Error('Workspace id is required.');
  if (BACKEND) {
    const res = await fetch(`${BACKEND}/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE', headers: await authHeaders() });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(err || `Workspace removal failed (${res.status})`);
    }
    return res.json();
  }
  if (!WORKSPACES_STUB) throw new Error(NOT_CONFIGURED);
  await delay(STUB_DELAY_MS / 2);
  return { ok: true };
}
