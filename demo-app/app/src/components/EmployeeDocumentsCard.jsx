// Per-employee document storage — contracts, certifications, I-9s, etc. Metadata rides
// the employeeDocuments blob slice; the bytes live in the lib/hrFiles demo stub (data
// URLs in a dedicated localStorage key, NEVER the synced blob) → go-live Storage.
// Self-contained; mounts on Settings → Team and in the HR employee panel. hr.edit to
// upload/delete, hr.view to see + download.
import { useCallback, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from '../store';
import { ACTIONS } from '../store/reducer';
import { newId } from '../lib/ids';
import { usePermission } from '../hooks/usePermission';
import { useToast } from './Toast';
import Icon from './Icon';
import ConfirmDialog from './ConfirmDialog';
import { fmtDate } from '../lib/dates';
import { selectEmployeeDocuments } from '../store/selectors';
import { saveHrFile, getHrFile, removeHrFile, formatBytes, HR_FILE_ALLOWED_MIME } from '../lib/hrFiles';

export default function EmployeeDocumentsCard({ user, currentUserId }) {
  const dispatch = useDispatch();
  const toast = useToast();
  const canEdit = usePermission('hr.edit');
  const all = useSelector(useCallback((s) => selectEmployeeDocuments(s), []));
  const docs = useMemo(() => all.filter((d) => d.userId === user.id), [all, user.id]);
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState(null);

  const pick = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.type && !HR_FILE_ALLOWED_MIME.includes(file.type)) { toast.error('Use a PDF, PNG, JPEG or WebP.'); return; }
    setBusy(true);
    try {
      const rec = await saveHrFile(file, { kind: 'document', ownerId: user.id });
      dispatch({ type: ACTIONS.ADD_EMPLOYEE_DOCUMENT, document: { id: newId('edoc'), userId: user.id, fileId: rec.id, name: rec.name, mimeType: rec.mimeType, sizeBytes: rec.sizeBytes, storagePath: rec.storagePath || null, uploadedBy: currentUserId || null } });
      toast.success('Document uploaded');
    } catch (err) {
      toast.error(err?.message || 'Upload failed');
    } finally { setBusy(false); }
  };

  const download = async (doc) => {
    const f = await getHrFile(doc.fileId, { storagePath: doc.storagePath, ownerId: doc.userId, name: doc.name, mimeType: doc.mimeType });
    if (!f) { toast.error('Could not open the document.'); return; }
    const a = document.createElement('a');
    a.href = f.url; a.download = doc.name || 'document';
    a.click();
  };

  const del = async (doc) => {
    dispatch({ type: ACTIONS.DELETE_EMPLOYEE_DOCUMENT, id: doc.id });
    await removeHrFile(doc.fileId, { storagePath: doc.storagePath, ownerId: doc.userId });
    setConfirmId(null);
    toast.success('Document removed');
  };
  const confirmDoc = docs.find((d) => d.id === confirmId);

  return (
    <div className="card detail-card">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <h3 className="dash-card-title">Documents</h3>
        {canEdit && (
          <>
            <input ref={fileRef} type="file" accept=".pdf,image/png,image/jpeg,image/webp" hidden onChange={pick} />
            <button type="button" className="btn btn-outline" disabled={busy} onClick={() => fileRef.current && fileRef.current.click()}>
              <Icon name="upload" size={14} /> {busy ? 'Uploading…' : 'Upload'}
            </button>
          </>
        )}
      </div>
      <p className="text-xs text-muted" style={{ marginTop: -2, marginBottom: 10 }}>PDF or image, up to 10 MB. Stored on this device in demo mode.</p>
      {docs.length === 0 ? (
        <p className="text-muted text-sm">No documents yet.</p>
      ) : (
        <div className="hr-doc-list">
          {docs.map((d) => (
            <div className="hr-doc" key={d.id}>
              <Icon name="invoices" size={16} />
              <button type="button" className="linklike hr-doc-name" onClick={() => download(d)}>{d.name}</button>
              <span className="hr-doc-meta">{formatBytes(d.sizeBytes)} · {fmtDate(d.uploadedAt, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              {canEdit && <button type="button" className="btn-icon btn-icon-danger" onClick={() => setConfirmId(d.id)} aria-label={`Remove ${d.name}`}><Icon name="trash" size={14} /></button>}
            </div>
          ))}
        </div>
      )}
      {confirmDoc && (
        <ConfirmDialog
          open
          title="Remove document?"
          message={`Permanently remove “${confirmDoc.name}”? This can't be undone.`}
          confirmLabel="Remove"
          onConfirm={() => del(confirmDoc)}
          onClose={() => setConfirmId(null)}
        />
      )}
    </div>
  );
}
