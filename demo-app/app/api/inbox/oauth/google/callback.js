// GET /api/inbox/oauth/google/callback
// Google redirects here after consent. Exchanges the code, stores the
// encrypted tokens, and returns an HTML page that posts the result back to
// the opener window (see openOAuthPopup in src/lib/connectedInboxes.js).

import { verifyState } from '../../../_lib/crypto.js';
import { exchangeCode, gmailGetProfile, buildRedirectUri } from '../../../_lib/google.js';
import { getAccountByEmail, upsertAccount, newInboxId } from '../../../_lib/accounts.js';
import { resolveCredsForWorkspaceId, updateWorkspace } from '../../../_lib/oauthWorkspaces.js';
import { DOC } from '../../../../src/brand/doc.js';

function resultPage(message) {
  const json = JSON.stringify(message).replace(/</g, '\\u003c');
  const note = message.error
    ? 'Connection failed. You can close this window.'
    : 'Connected. You can close this window.';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Connecting…</title></head>
<body style="font-family:system-ui,sans-serif;padding:2rem;color:${DOC.body}">
<p>${note}</p>
<script>
(function () {
  try { if (window.opener) window.opener.postMessage(${json}, '*'); } catch (e) {}
  setTimeout(function () { try { window.close(); } catch (e) {} }, 300);
})();
</script>
</body></html>`;
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  try {
    const { code, state, error } = req.query;
    if (error) {
      res.status(200).send(resultPage({ type: 'connect-inbox', error: `Google returned: ${error}` }));
      return;
    }
    if (!code || !state) {
      res.status(200).send(resultPage({ type: 'connect-inbox', error: 'Missing authorization code.' }));
      return;
    }
    const statePayload = verifyState(state);
    if (!statePayload) {
      res.status(200).send(resultPage({ type: 'connect-inbox', error: 'The sign-in link expired. Please try connecting again.' }));
      return;
    }
    const workspaceId = statePayload.workspaceId || null;

    // Exchange the code with the SAME Workspace credentials the consent URL used.
    const creds = await resolveCredsForWorkspaceId(workspaceId);
    const tokens = await exchangeCode(code, buildRedirectUri(req.headers.host), creds);
    if (!tokens.refresh_token) {
      res.status(200).send(resultPage({
        type: 'connect-inbox',
        error: 'Google did not return a refresh token. Remove the app at myaccount.google.com → Security → Third-party access, then reconnect.',
      }));
      return;
    }

    const profile = await gmailGetProfile(tokens.access_token);
    const email = String(profile.emailAddress || '').toLowerCase();
    if (!email) throw new Error('Could not read the mailbox address from Google.');

    // Reuse the existing row's id when reconnecting the same address.
    const existing = await getAccountByEmail(email);
    const id = existing?.id || newInboxId();
    await upsertAccount({
      id,
      email,
      displayName: email,
      provider: 'google',
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      accessTokenExpiresAt: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString(),
      historyId: profile.historyId || null,
      workspaceId,
    });

    // A successful connect proves this Workspace's OAuth app + Trusted-app
    // approval actually work — flip it to active so the connect warnings clear.
    if (workspaceId) {
      try { await updateWorkspace(workspaceId, { status: 'active', lastError: null }); } catch { /* best effort */ }
    }

    res.status(200).send(resultPage({
      type: 'connect-inbox',
      inbox: {
        id,
        email,
        displayName: email,
        provider: 'google',
        status: 'active',
        inboundCapability: 'gmail_poll',
        workspaceId,
      },
    }));
  } catch (err) {
    res.status(200).send(resultPage({ type: 'connect-inbox', error: err.message || 'Connection failed.' }));
  }
}
