import Icon from './Icon';
import { fmtDate } from '../lib/dates';
import { useT } from '../i18n/react';

// Account-wide ops notes + reference link, surfaced to crew on every clean at the
// account — notes live at the account level "as long as the cleaners can see them
// on the app when they look at their jobs". Content comes from the office (client.opsNotes
// + client.security.accessLink, stamped opsUpdatedAt by UPDATE_CLIENT_OPS). Renders nothing
// when the account has neither. Used by My Day's expanded instructions AND JobDetail's
// Service-instructions card — edit this component, not the two call sites.
// Its labels are catalog lines in the cleaner's language (CS-193); the NOTES are the
// office's own words and show as written (LANG-7).
export default function AccountNotesPanel({ client }) {
  const t = useT();
  const notes = typeof client?.opsNotes === 'string' ? client.opsNotes.trim() : '';
  const link = client?.security?.accessLink || null;
  if (!notes && !link) return null;
  // Admins paste links without a scheme ("docs.google.com/…") — a schemeless href
  // would resolve relative to the app, so normalize before rendering.
  const href = link ? (/^https?:\/\//i.test(link) ? link : `https://${link}`) : null;
  // The org's calendar day in the reader's language (lib/dates), not the device's zone.
  const updated = client?.opsUpdatedAt ? fmtDate(client.opsUpdatedAt) : null;
  return (
    <div className="ops-notes-panel">
      <div className="ops-notes-head"><Icon name="forms" size={13} /> {t('notes.title')}</div>
      {notes && <div className="ops-notes-body">{notes}</div>}
      {href && (
        <a className="ops-notes-link" href={href} target="_blank" rel="noopener noreferrer">
          {t('notes.openLink')}
        </a>
      )}
      {/* "From the office" — this read "From the account's Operations tab", a tab removed
          2026-09-09; the notes are written on the customer's page now. */}
      <div className="ops-notes-src">{updated ? t('notes.fromOfficeUpdated', { date: updated }) : t('notes.fromOffice')}</div>
    </div>
  );
}
