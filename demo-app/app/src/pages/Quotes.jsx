// Quotes list — create a quote from the template, then open it to edit, sign,
// and send for signature. Replaces the old Stripe Pay-Now list.
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Badge from '../components/Badge';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import { fmtDate } from '../lib/dates';
import { listQuotes, getDownloadUrl, deleteQuote } from '../lib/quotesApi';
import CreateQuoteModal from '../components/CreateQuoteModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from '../components/ListPager';

const EMPTY = [];

const STATUS_BADGE = { draft: 'slate', sent: 'blue', signed: 'green', void: 'slate' };

export default function Quotes() {
  const navigate = useNavigate();
  const toast = useToast();
  const canCreate = usePermission('quotes.create');
  const canDelete = usePermission('quotes.delete');
  const [quotes, setQuotes] = useState(null);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();
  // Global search "New quote" deep-link: ?new=1 opens the create-quote modal once, then
  // strips the param. Gated on canCreate.
  useEffect(() => {
    if (searchParams.get('new') && canCreate) {
      setModalOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, canCreate, setSearchParams]);
  const pager = usePagedRows(quotes || EMPTY, { param: 'page' });

  async function load() {
    setError(null); setQuotes(null);
    try { setQuotes(await listQuotes()); } catch (e) { setError(e.message || 'Could not load quotes.'); }
  }
  useEffect(() => {
    let alive = true;
    listQuotes().then((q) => { if (alive) setQuotes(q); }).catch((e) => { if (alive) setError(e.message || 'Could not load quotes.'); });
    return () => { alive = false; };
  }, []);

  const publicUrl = (q) => `${window.location.origin}/quote/${q.public_token}`;
  async function download(q) {
    try { const url = await getDownloadUrl(q.id); if (url) window.open(url, '_blank'); }
    catch (e) { toast.error(e.message || 'No document yet'); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="page-head-text">
          <h1>Quotes</h1>
          <p className="page-sub">Create a quote from your template, sign it, and send it to a contact for signature.</p>
        </div>
        {canCreate && (
          <div className="page-head-actions">
            <button className="btn btn-primary" onClick={() => setModalOpen(true)}>New quote</button>
          </div>
        )}
      </div>

      <div className="table-wrap mobile-stack">
        <table>
          <thead><tr><th>Document</th><th>Contact</th><th>Status</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            {error ? (
              <tr className="stack-plain"><td colSpan={5} style={{ textAlign: 'center', padding: 28, color: 'var(--danger)' }}>{error} <button className="btn btn-link btn-sm" onClick={load}>Retry</button></td></tr>
            ) : quotes === null ? (
              <tr className="stack-plain"><td colSpan={5}>Loading…</td></tr>
            ) : quotes.length === 0 ? (
              <tr className="stack-plain"><td colSpan={5} style={{ textAlign: 'center', padding: 32, color: 'var(--color-neutral-500)' }}>No quotes yet. Click <strong>New quote</strong> to start.</td></tr>
            ) : (
              pager.pageRows.map((q) => (
                <tr key={q.id}>
                  <td className="cell-primary"><button className="btn btn-link" style={{ fontWeight: 600, paddingLeft: 0, maxWidth: 240 }} onClick={() => navigate(`/quotes/${q.id}`)}><span className="truncate" title={q.title || 'Quote'}>{q.title || 'Quote'}</span></button></td>
                  <td data-label="Contact"><span className="truncate" title={q.contact_name || ''}>{q.contact_name || '—'}</span></td>
                  <td data-label="Status"><Badge variant={STATUS_BADGE[q.status] || 'slate'}>{q.status}</Badge></td>
                  <td data-label="Updated">{q.updated_at ? fmtDate(q.updated_at) : '—'}</td>
                  <td className="cell-actions" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn btn-link btn-sm" onClick={() => navigate(`/quotes/${q.id}`)}>Open</button>
                    {q.status !== 'draft' && <button className="btn btn-link btn-sm" onClick={() => { navigator.clipboard?.writeText(publicUrl(q)); toast.success('Link copied'); }}>Copy link</button>}
                    {(q.status === 'signed' || q.admin_signed_at) && <button className="btn btn-link btn-sm" onClick={() => download(q)}>Download</button>}
                    {canDelete && <button className="btn btn-link btn-sm" style={{ color: 'var(--danger)' }} onClick={() => setConfirmDelete(q)}>Delete</button>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        <ListPager pager={pager} noun="quotes" />
      </div>

      <CreateQuoteModal open={modalOpen} onClose={() => setModalOpen(false)} onCreated={(q) => { setModalOpen(false); navigate(`/quotes/${q.id}`); }} />

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete quote?"
        message={confirmDelete?.status === 'signed' ? 'This permanently deletes the signed document and its PDF. This cannot be undone.' : 'This permanently deletes this quote and its files.'}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => { try { await deleteQuote(confirmDelete.id); toast.success('Quote deleted'); load(); } catch (e) { toast.error(e.message || 'Delete failed'); } setConfirmDelete(null); }}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}
