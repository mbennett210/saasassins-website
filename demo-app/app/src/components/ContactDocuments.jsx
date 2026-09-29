// Documents tab for a contact: lists the e-signature quotes addressed to them
// (fetched from the quotes API, filtered by contact_id) with download/open.
import { useEffect, useState } from 'react';
import Badge from './Badge';
import Icon from './Icon';
import EmptyState from './EmptyState';
import { useToast } from './Toast';
import { fmtDate } from '../lib/dates';
import { listQuotes, getDownloadUrl } from '../lib/quotesApi';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from './ListPager';

const EMPTY = [];

const STATUS_BADGE = { draft: 'slate', sent: 'blue', signed: 'green', void: 'slate' };

export default function ContactDocuments({ contactId }) {
  const toast = useToast();
  const [docs, setDocs] = useState(null);
  const [error, setError] = useState(null);
  const pager = usePagedRows(docs || EMPTY, { resetKey: contactId });

  useEffect(() => {
    let alive = true;
    listQuotes()
      .then((all) => { if (alive) setDocs((all || []).filter((q) => q.contact_id === contactId)); })
      .catch((e) => { if (alive) setError(e.message || 'Could not load documents.'); });
    return () => { alive = false; };
  }, [contactId]);

  async function download(q) {
    try {
      const url = await getDownloadUrl(q.id);
      if (url) window.open(url, '_blank'); else toast.error('No document available yet');
    } catch (e) { toast.error(e.message || 'No document available yet'); }
  }
  const openPublic = (q) => window.open(`${window.location.origin}/quote/${q.public_token}`, '_blank');

  if (error) return <p style={{ color: 'var(--danger)' }}>{error}</p>;
  if (docs === null) return <p className="text-muted">Loading…</p>;
  if (docs.length === 0) {
    return <EmptyState icon={<Icon name="invoices" size={28} />} title="No documents yet" message="Quotes sent to this contact for signature will appear here." />;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Document</th><th>Status</th><th>Updated</th><th></th></tr></thead>
        <tbody>
          {pager.pageRows.map((q) => (
            <tr key={q.id}>
              <td style={{ fontWeight: 600 }}><span className="truncate" title={q.title || 'Quote'}>{q.title || 'Quote'}</span></td>
              <td><Badge variant={STATUS_BADGE[q.status] || 'slate'}>{q.status}</Badge></td>
              <td>{q.updated_at ? fmtDate(q.updated_at) : '—'}</td>
              <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                {(q.status === 'signed' || q.admin_signed_at) && (
                  <button className="btn btn-link btn-sm" onClick={() => download(q)}>Download</button>
                )}
                <button className="btn btn-link btn-sm" onClick={() => openPublic(q)}>Open</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ListPager pager={pager} noun="documents" />
    </div>
  );
}
