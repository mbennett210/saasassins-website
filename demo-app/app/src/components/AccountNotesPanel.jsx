import Icon from './Icon';

// Account-wide ops notes + reference link, surfaced to crew on every clean at the
// account — notes live at the account level "as long as the cleaners can see them
// on the app when they look at their jobs". Content comes from the account's
// Operations tab (client.opsNotes + client.security.accessLink, stamped
// opsUpdatedAt by UPDATE_CLIENT_OPS). Renders nothing when the account has
// neither. Used by My Day's expanded instructions AND JobDetail's
// Service-instructions card — edit this component, not the two call sites.
export default function AccountNotesPanel({ client }) {
  const notes = typeof client?.opsNotes === 'string' ? client.opsNotes.trim() : '';
  const link = client?.security?.accessLink || null;
  if (!notes && !link) return null;
  // Admins paste links without a scheme ("docs.google.com/…") — a schemeless href
  // would resolve relative to the app, so normalize before rendering.
  const href = link ? (/^https?:\/\//i.test(link) ? link : `https://${link}`) : null;
  const updated = client?.opsUpdatedAt
    ? new Date(client.opsUpdatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;
  return (
    <div className="ops-notes-panel">
      <div className="ops-notes-head"><Icon name="forms" size={13} /> Account notes</div>
      {notes && <div className="ops-notes-body">{notes}</div>}
      {href && (
        <a className="ops-notes-link" href={href} target="_blank" rel="noopener noreferrer">
          Open reference link ↗
        </a>
      )}
      <div className="ops-notes-src">From the account&rsquo;s Operations tab{updated ? ` · updated ${updated}` : ''}</div>
    </div>
  );
}
