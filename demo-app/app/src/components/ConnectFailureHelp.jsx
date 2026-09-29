// Renders a connect failure as an actionable readout rather than a dead end.
// Shows the raw error from Google / the backend, then a "what to do" line keyed
// to the failure shape — so a mis-set, unapproved, or unconfigured Workspace
// tells the user where to fix it instead of just silently failing.
//
// Used by both Google connect modals (Settings → Connected Inboxes and
// Marketing → Inboxes), since both route through the same OAuth backend.

export default function ConnectFailureHelp({ error }) {
  if (!error) return null;
  const e = String(error).toLowerCase();

  let hint;
  if (e.includes('org_internal') || e.includes('different workspace') || e.includes("isn't in") || e.includes('not in the')) {
    hint = 'That Google account isn’t in the selected Workspace. Pick the matching Workspace above, then try again.';
  } else if (e.includes('refresh token')) {
    hint = 'Google didn’t return a refresh token. Usually because the app was already authorized. Remove it at myaccount.google.com → Security → Third-party access, then reconnect.';
  } else if (e.includes('popup') || e.includes('cancel')) {
    hint = 'The Google sign-in window closed before finishing. Allow popups for this site, then try again.';
  } else {
    hint = 'If this keeps happening, the Google Workspace may not be fully set up or approved yet. A Super Admin can verify it under Settings → Integrations → Google Workspaces.';
  }

  return (
    <div className="form-error" style={{ marginTop: 12 }}>
      <div style={{ fontWeight: 600 }}>Couldn’t connect</div>
      <div style={{ marginTop: 2, fontWeight: 400 }}>{error}</div>
      <div style={{ marginTop: 6, fontWeight: 400 }}>{hint}</div>
    </div>
  );
}
