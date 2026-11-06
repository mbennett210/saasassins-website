// The documents a customer downloads from the hub — ONE component for both places the office keeps
// them (client hub redesign, plan 2026-10-08 §3.6), so the two can never show a document
// differently:
//   · a customer's page → Documents tab (`clientId` = the building): that building's documents,
//     editable, and below them the company's own (the W-9) read-only, managed in Settings;
//   · Settings → Company → "Documents for every customer" (`clientId` null): the company's own.
// Each row: the kind, the title, "Valid through …" with an Expired badge the day after (the org's
// day, judged on the server), the "Visible to the customer" switch, and View / Replace / Edit /
// Delete. Upload / Replace / Edit open CustomerDocumentModal; Delete asks first (ConfirmDialog).
//
// Gated on `hub.documents.manage` (owner, admin, manager by default; never crew): without it the
// card renders nothing, and every call is refused by the server anyway (the boundary).
//
// LANGUAGES: every word is a catalog line (`custDocs.*`); titles and file names show as written.
import { useEffect, useMemo, useState } from 'react';
import { usePermission } from '../hooks/usePermission';
import { usePagedRows } from '../hooks/usePagedRows';
import { useToast } from './Toast';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { fmtDate } from '../lib/dates';
import * as api from '../lib/customerDocumentsApi';
import Badge from './Badge';
import Icon from './Icon';
import Toggle from './Toggle';
import EmptyState from './EmptyState';
import ConfirmDialog from './ConfirmDialog';
import ListPager from './ListPager';
import CustomerDocumentModal, { DOCUMENT_KIND_KEYS } from './CustomerDocumentModal';

// The kind's badge colour (kit Badge variants).
export const DOCUMENT_KIND_BADGES = Object.freeze({ coi: 'blue', w9: 'purple', other: 'slate' });
const dayLabel = (day) => fmtDate(day, { month: 'short', day: 'numeric', year: 'numeric' });

// Open a link in a new tab. The tab is opened FIRST, inside the click, so a pop-up blocker lets
// it through; the link (minted by the server for five minutes) is filled in when it arrives.
export async function openInNewTab(getUrl) {
  const w = typeof window !== 'undefined' ? window.open('', '_blank') : null;
  try {
    const url = await getUrl();
    if (!url) throw new Error('no-url');
    if (w) { w.opener = null; w.location.href = url; } else window.open(url, '_blank', 'noopener');
  } catch (e) {
    if (w) w.close();
    throw e;
  }
}

/**
 * @param clientId the building, or null for the documents every customer sees
 */
export default function CustomerDocumentsCard({ clientId = null }) {
  const t = useT();
  const toast = useToast();
  const canManage = usePermission('hub.documents.manage');
  const company = clientId == null;
  const [docs, setDocs] = useState(null); // null while loading
  const [loadError, setLoadError] = useState(null);
  const [tick, setTick] = useState(0);
  const [modal, setModal] = useState(null); // { mode, doc }
  const [confirmDoc, setConfirmDoc] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const reload = () => setTick((n) => n + 1);

  useEffect(() => {
    if (!canManage) return undefined;
    let live = true;
    setLoadError(null);
    api.listCustomerDocuments({ clientId })
      .then((r) => { if (live) setDocs(Array.isArray(r?.documents) ? r.documents : []); })
      .catch((e) => { if (live) { setDocs(null); setLoadError(e); } });
    return () => { live = false; };
  }, [clientId, canManage, tick]);

  const own = useMemo(() => (docs || []).filter((d) => (company ? d.clientId == null : d.clientId === clientId)), [docs, company, clientId]);
  const shared = useMemo(() => (company ? [] : (docs || []).filter((d) => d.clientId == null)), [docs, company]);
  const ownPager = usePagedRows(own, { resetKey: clientId || 'company' });
  const sharedPager = usePagedRows(shared, { resetKey: clientId || 'company' });

  if (!canManage) return null;

  const view = async (d) => {
    try { await openInNewTab(() => api.customerDocumentUrl(d.id)); }
    catch (e) { toast.error(errorText(t, e, 'custDocs.error.open')); }
  };
  const setVisible = async (d, on) => {
    setBusyId(d.id);
    try {
      const saved = await api.updateCustomerDocument(d.id, { visibleToClient: on });
      setDocs((list) => (list || []).map((x) => (x.id === d.id ? saved : x)));
      toast.success(t(on ? 'custDocs.toast.shown' : 'custDocs.toast.hidden'));
    } catch (e) {
      toast.error(errorText(t, e, 'custDocs.error.save'));
    } finally { setBusyId(null); }
  };
  const remove = async (d) => {
    setBusyId(d.id);
    try {
      await api.deleteCustomerDocument(d.id);
      setDocs((list) => (list || []).filter((x) => x.id !== d.id));
      toast.success(t('custDocs.toast.deleted'));
    } catch (e) {
      toast.error(errorText(t, e, 'custDocs.error.save'));
    } finally { setBusyId(null); }
  };
  const saved = (doc, mode) => {
    setModal(null);
    toast.success(t(mode === 'replace' ? 'custDocs.toast.replaced' : mode === 'edit' ? 'custDocs.toast.saved' : 'custDocs.toast.uploaded'));
    if (doc) setDocs((list) => [...(list || []).filter((x) => x.id !== doc.id), doc]);
    reload();
  };

  const table = (pager, editable) => (
    <>
      <div className="table-wrap mobile-stack">
        <table>
          <thead>
            <tr>
              <th>{t('custDocs.col.document')}</th>
              <th>{t('custDocs.col.validThrough')}</th>
              <th>{t('custDocs.col.visible')}</th>
              <th><span className="sr-only">{t('custDocs.col.actions')}</span></th>
            </tr>
          </thead>
          <tbody>
            {pager.pageRows.map((d) => (
              <tr key={d.id}>
                <td className="cell-primary">
                  <span className="flex-row" style={{ gap: 'var(--gap-inline)', minWidth: 0 }}>
                    <Badge variant={DOCUMENT_KIND_BADGES[d.kind] || 'slate'}>{t(DOCUMENT_KIND_KEYS[d.kind] || DOCUMENT_KIND_KEYS.other)}</Badge>
                    <span className="truncate" title={d.fileName ? `${d.title} · ${d.fileName}` : d.title}>{d.title}</span>
                  </span>
                </td>
                <td data-label={t('custDocs.col.validThrough')}>
                  {d.validUntil
                    ? (
                      <span className="flex-row" style={{ gap: 'var(--space-1)' }}>
                        <span>{dayLabel(d.validUntil)}</span>
                        {d.expired && <Badge variant="red">{t('custDocs.expired')}</Badge>}
                      </span>
                    )
                    : <span className="text-muted">{t('custDocs.noExpiry')}</span>}
                </td>
                <td data-label={t('custDocs.col.visible')}>
                  {editable ? (
                    <label className="flex-row" style={{ gap: 'var(--gap-inline)' }}>
                      <Toggle on={d.visibleToClient} onChange={(on) => setVisible(d, on)} disabled={busyId === d.id} />
                      <span className="sr-only">{t('custDocs.visibleLabel')}</span>
                      <span className="text-muted text-sm">{t(d.visibleToClient ? 'custDocs.visibleYes' : 'custDocs.visibleNo')}</span>
                    </label>
                  ) : (
                    <span className="text-muted text-sm">{t(d.visibleToClient ? 'custDocs.visibleYes' : 'custDocs.visibleNo')}</span>
                  )}
                </td>
                <td className="cell-actions">
                  <div className="flex-row" style={{ gap: 'var(--space-1)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-sm btn-outline" onClick={() => view(d)}>{t('custDocs.view')}</button>
                    {editable && (
                      <>
                        <button type="button" className="btn btn-sm btn-outline" disabled={busyId === d.id} onClick={() => setModal({ mode: 'replace', doc: d })}>{t('custDocs.replace')}</button>
                        <button type="button" className="btn btn-sm btn-outline" disabled={busyId === d.id} onClick={() => setModal({ mode: 'edit', doc: d })}>{t('custDocs.edit')}</button>
                        <button type="button" className="btn btn-sm btn-outline" disabled={busyId === d.id} onClick={() => setConfirmDoc(d)}>{t('custDocs.delete')}</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ListPager pager={pager} noun={t('pager.noun.documents')} />
    </>
  );

  return (
    <div className="card detail-card">
      <div className="overview-card-head">
        <h3>{t(company ? 'custDocs.companyTitle' : 'custDocs.title')}</h3>
        <button type="button" className="btn btn-primary" disabled={!docs} onClick={() => setModal({ mode: 'upload', doc: null })}>{t('custDocs.upload')}</button>
      </div>
      <p className="text-xs text-muted" style={{ marginTop: 0 }}>{t(company ? 'custDocs.companyHint' : 'custDocs.buildingHint')}</p>

      {loadError ? (
        <EmptyState
          icon={<Icon name="warning" size={28} />}
          title={t('custDocs.loadFailed')}
          message={errorText(t, loadError, 'custDocs.loadFailedHint')}
          action={<button type="button" className="btn btn-primary" onClick={reload}>{t('common.retry')}</button>}
        />
      ) : !docs ? (
        <p className="text-muted text-sm">{t('common.loading')}</p>
      ) : own.length === 0 ? (
        <EmptyState
          icon={<Icon name="invoices" size={28} />}
          title={t('custDocs.emptyTitle')}
          message={t(company ? 'custDocs.emptyCompany' : 'custDocs.emptyBuilding')}
        />
      ) : table(ownPager, true)}

      {!company && docs && shared.length > 0 && (
        <>
          <h4 style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-1)' }}>{t('custDocs.sharedTitle')}</h4>
          <p className="text-xs text-muted" style={{ marginTop: 0 }}>{t('custDocs.sharedHint')}</p>
          {table(sharedPager, false)}
        </>
      )}

      <CustomerDocumentModal
        open={!!modal}
        mode={modal?.mode || 'upload'}
        doc={modal?.doc || null}
        clientId={clientId}
        onClose={() => setModal(null)}
        onSaved={saved}
      />
      <ConfirmDialog
        open={!!confirmDoc}
        title={t('custDocs.confirmDelete.title', { title: confirmDoc?.title || '' })}
        message={t('custDocs.confirmDelete.message')}
        confirmLabel={t('custDocs.delete')}
        variant="danger"
        onConfirm={() => confirmDoc && remove(confirmDoc)}
        onClose={() => setConfirmDoc(null)}
      />
    </div>
  );
}
