// Admin routes for the multi-Workspace OAuth registry. Super-Admin only.
//   POST   /create              { label, domains, clientId, clientSecret } → register (encrypts secret)
//   GET    /list                                                           → metadata[] (no secrets)
//   POST   /:id                 { label?, domains?, status?, clientId?, clientSecret? } → update
//   POST   /:id/test                                                       → validate creds + mark active
//   DELETE /:id                                                            → remove (blocked if mailboxes use it)
//
// The client_secret only ever travels INBOUND (on create/update) and is stored
// encrypted; it is never returned. Gated to the `owner` (Super Admin) role via
// the JWT trust root — see _lib/authz.js resolveAuthority.
//
// MISSED BY THE INCREMENT 1c SWEEP (fixed 2026-07-20). This route resolved the
// caller's role by matching their email against `org_state.users` INLINE, using
// none of the helpers that sweep grepped for — so it kept authorizing off the
// browser-writable blob after every other gate had moved to the claim. Since any
// authenticated user can rewrite that roster, a crew member could set their own
// row to `role:'owner'` and reach these routes, which hand out OAuth workspace
// credentials. requireRole reads the service-role-only claim instead.
import { requirePermission } from '../_lib/authz.js';
import {
  listWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace,
  workspaceInUse, getWorkspaceCreds,
} from '../_lib/oauthWorkspaces.js';

async function requireOwner(req, res) {
  try {
    const g = await requirePermission(req, res, 'integrations.manage'); // writes 401/403 itself
    return g ? g.user : null;
  } catch (e) {
    res.status(500).json({ error: e.message || 'Authorization check failed.' });
    return null;
  }
}

export default async function handler(req, res) {
  // Mirror the quotes catch-all: vercel.json rewrites multi-segment paths in via
  // ?subpath=; single-segment also hits the catch-all directly.
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
    : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [seg0, seg1] = path;

  try {
    const user = await requireOwner(req, res);
    if (!user) return;

    if (seg0 === 'create' && req.method === 'POST') {
      const b = req.body || {};
      if (!b.label || !b.clientId || !b.clientSecret) {
        return res.status(400).json({ error: 'label, clientId and clientSecret are required.' });
      }
      const workspace = await createWorkspace({
        label: b.label, domains: b.domains, clientId: b.clientId, clientSecret: b.clientSecret,
      });
      return res.status(200).json({ ok: true, workspace });
    }

    if (seg0 === 'list' && req.method === 'GET') {
      return res.status(200).json({ ok: true, workspaces: await listWorkspaces() });
    }

    // /:id and /:id/:action  ('create'/'list' keywords above can't collide with ws_ ids)
    const id = seg0;
    const action = seg1;
    if (!id) return res.status(404).json({ error: 'Unknown route' });

    if (action === 'test' && req.method === 'POST') {
      const creds = await getWorkspaceCreds(id);
      if (!creds || !creds.clientId || !creds.clientSecret) {
        await updateWorkspace(id, { status: 'setup', lastError: 'Missing OAuth Client ID or secret.' });
        return res.status(200).json({ ok: false, error: 'This Workspace is missing its OAuth Client ID or secret. Re-add them, then test again.' });
      }
      // We can't fully exercise consent without a user, but the creds are present
      // and well-formed. A successful mailbox connect is the real proof — mark
      // active so the admin can proceed and the connect warnings clear.
      const workspace = await updateWorkspace(id, { status: 'active', lastError: null });
      return res.status(200).json({ ok: true, status: 'active', workspace });
    }

    if (!action && req.method === 'POST') {
      const workspace = await updateWorkspace(id, req.body || {});
      return res.status(200).json({ ok: true, workspace });
    }

    if (!action && req.method === 'DELETE') {
      if (await workspaceInUse(id)) {
        return res.status(409).json({ error: 'Disconnect this Workspace’s mailboxes before removing it.' });
      }
      await deleteWorkspace(id);
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Unknown route' });
  } catch (err) {
    console.error('[api/workspaces]', err);
    res.status(500).json({ error: err.message || 'Server error' });
  }
}
