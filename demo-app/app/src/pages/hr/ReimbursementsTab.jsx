// HR › Reimbursements — HR/managers create a reimbursement (employee + amount +
// description + receipt image), then Approve → it posts to the pay run as a NON-taxable
// reimbursement line, or Reject. Receipt bytes live in the lib/hrFiles stub (never the
// blob). (v1: crew "attach at clock-out" capture is a deferred fast-follow.)
import { useCallback, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectReimbursements } from '../../store/selectors';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../components/Toast';
import Icon from '../../components/Icon';
import Badge from '../../components/Badge';
import FormField from '../../components/FormField';
import ConfirmDialog from '../../components/ConfirmDialog';
import Modal from '../../components/Modal';
import { usePagedRows } from '../../hooks/usePagedRows';
import ListPager from '../../components/ListPager';
import { newId } from '../../lib/ids';
import { money } from '../../lib/dates';
import { payPeriodRange } from '../../lib/payroll';
import { compareUsersByName } from '../../lib/roles';
import { saveHrFile, getHrFile, removeHrFile, HR_FILE_ALLOWED_MIME } from '../../lib/hrFiles';

const STATUS_VARIANT = { pending: 'amber', approved: 'green', rejected: 'slate' };
const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' };

export default function ReimbursementsTab() {
  const dispatch = useDispatch();
  const toast = useToast();
  const canEdit = usePermission('hr.edit');
  const currentUserId = useSelector(useCallback((s) => s.currentUserId, []));
  const reimbursements = useSelector(useCallback((s) => selectReimbursements(s), []));
  const users = useSelector(useCallback((s) => s.users, []));
  // Approving a reimbursement posts money to the pay run, so approving your OWN is a
  // Super Admin's (owner/admin) call — the server refuses it for anyone else, and a
  // refused save drops the whole pending batch (store/sync.js), so the button must not
  // offer what the server won't take.
  const myRole = useMemo(() => users.find((u) => u.id === currentUserId)?.role, [users, currentUserId]);
  const canApproveOwn = myRole === 'owner' || myRole === 'admin';
  const mayApprove = (r) => canEdit && (r.userId !== currentUserId || canApproveOwn);
  // Follow the ORG's pay cadence so a line's periodKey (= period fromKey) matches the
  // pay run's period; hardcoding biweekly here silently drops lines under semi-monthly.
  const cadence = useSelector(useCallback((s) => {
    const c = s.opsSettings?.payPeriodCadence;
    return c === 'weekly' || c === 'semimonthly' ? c : 'biweekly';
  }, []));

  const periods = useMemo(() => [0, -1, -2, -3].map((o) => payPeriodRange(cadence, o)), [cadence]);
  const nameById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);
  const payableUsers = useMemo(() => users.filter((u) => u.status === 'active' && u.pay && u.pay.type && u.pay.type !== 'none').slice().sort(compareUsersByName), [users]);
  const rows = useMemo(() => reimbursements.slice().sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt)), [reimbursements]);
  const pager = usePagedRows(rows, { param: 'page' });
  const periodLabel = (key) => (periods.find((p) => p.fromKey === key) || {}).label || key;

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ userId: '', description: '', amount: '', periodKey: periods[0].fromKey });
  const [pendingFile, setPendingFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState(null);
  const [viewFile, setViewFile] = useState(null); // { url, mimeType, name }
  const fileRef = useRef(null);

  const pickReceipt = (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.type && !HR_FILE_ALLOWED_MIME.includes(f.type)) { toast.error('Use a PDF, PNG, JPEG or WebP.'); return; }
    setPendingFile(f);
  };

  const add = async () => {
    const amt = Math.abs(parseFloat(form.amount) || 0);
    if (!form.userId) { toast.error('Pick an employee'); return; }
    if (!amt) { toast.error('Enter an amount'); return; }
    setBusy(true);
    try {
      const id = newId('rmb');
      let receiptFileId = null; let receiptName = null; let receiptStoragePath = null; let receiptMimeType = null;
      if (pendingFile) {
        const rec = await saveHrFile(pendingFile, { kind: 'receipt', ownerId: id });
        receiptFileId = rec.id; receiptName = rec.name;
        receiptStoragePath = rec.storagePath || null; receiptMimeType = rec.mimeType || null;
      }
      dispatch({ type: ACTIONS.ADD_REIMBURSEMENT, reimbursement: { id, userId: form.userId, amount: amt, description: form.description.trim() || 'Reimbursement', receiptFileId, receiptName, receiptStoragePath, receiptMimeType, periodKey: form.periodKey, submittedBy: currentUserId } });
      setForm({ userId: '', description: '', amount: '', periodKey: periods[0].fromKey });
      setPendingFile(null); setAdding(false);
      toast.success('Reimbursement added');
    } catch (err) {
      toast.error(err?.message || 'Could not save the receipt');
    } finally { setBusy(false); }
  };

  const approve = (r) => {
    if (r.userId === currentUserId && !canApproveOwn) { toast.error('Only a Super Admin can approve your own reimbursement.'); return; }
    const plId = newId('pl');
    dispatch({ type: ACTIONS.ADD_PAYROLL_LINE, line: { id: plId, userId: r.userId, periodKey: r.periodKey, kind: 'earning', category: 'reimbursement', label: r.description, amount: Math.abs(r.amount), taxable: false, createdBy: currentUserId, note: `reimbursement ${r.id}` } });
    dispatch({ type: ACTIONS.UPDATE_REIMBURSEMENT, id: r.id, patch: { status: 'approved', payrollLineId: plId, decidedBy: currentUserId, decidedAt: new Date().toISOString() } });
    toast.success('Approved — added to payroll');
  };
  const reject = (r) => dispatch({ type: ACTIONS.UPDATE_REIMBURSEMENT, id: r.id, patch: { status: 'rejected', decidedBy: currentUserId, decidedAt: new Date().toISOString() } });
  const del = async (r) => {
    if (r.receiptFileId) await removeHrFile(r.receiptFileId, { storagePath: r.receiptStoragePath, ownerId: r.id });
    // Also removes the reimbursement's pay line (reducer: removeReimbursement).
    dispatch({ type: ACTIONS.DELETE_REIMBURSEMENT, id: r.id });
    setConfirmId(null);
    toast.success('Removed');
  };
  const openReceipt = async (r) => {
    const f = await getHrFile(r.receiptFileId, { storagePath: r.receiptStoragePath, ownerId: r.id, name: r.receiptName, mimeType: r.receiptMimeType });
    if (!f) { toast.error('Could not open the receipt.'); return; }
    setViewFile(f);
  };
  const confirmR = rows.find((r) => r.id === confirmId);

  return (
    <div className="hr-view">
      <div className="hr-toolbar">
        <p className="text-sm text-muted" style={{ margin: 0 }}>Record a reimbursement with its receipt, then approve it onto the pay run as a non-taxable line.</p>
        {canEdit && !adding && <button className="btn btn-primary" onClick={() => setAdding(true)} type="button">Add reimbursement</button>}
      </div>

      {canEdit && adding && (
        <div className="hr-addform card detail-card">
          <div className="form-row">
            <FormField label="Employee" as="select" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} options={[{ value: '', label: '— Select —' }, ...payableUsers.map((u) => ({ value: u.id, label: u.name }))]} />
            <FormField label="Pay period" as="select" value={form.periodKey} onChange={(e) => setForm({ ...form, periodKey: e.target.value })} options={periods.map((p) => ({ value: p.fromKey, label: p.label }))} />
          </div>
          <div className="form-row">
            <FormField label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="e.g. Parking — client site visit" />
            <FormField label="Amount ($)" type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          </div>
          <div className="hr-receipt-pick">
            <input ref={fileRef} type="file" accept=".pdf,image/png,image/jpeg,image/webp" hidden onChange={pickReceipt} />
            <button type="button" className="btn btn-outline" onClick={() => fileRef.current && fileRef.current.click()}><Icon name="upload" size={14} /> {pendingFile ? 'Change receipt' : 'Attach receipt'}</button>
            {pendingFile && <span className="text-xs text-muted">{pendingFile.name}</span>}
          </div>
          <div className="modal-actions">
            <button className="btn btn-outline" onClick={() => { setAdding(false); setPendingFile(null); }} type="button">Cancel</button>
            <button className="btn btn-primary" onClick={add} disabled={busy} type="button">{busy ? 'Saving…' : 'Add reimbursement'}</button>
          </div>
        </div>
      )}

      {rows.length === 0 ? <p className="text-muted">No reimbursements yet.</p> : (
        <>
          <div className="table-wrap mobile-scroll">
            <table className="pay-register">
              <thead><tr><th>Employee</th><th>Description</th><th>Pay period</th><th className="rt">Amount</th><th>Receipt</th><th>Status</th>{canEdit && <th aria-label="actions" />}</tr></thead>
              <tbody>
                {pager.pageRows.map((r) => (
                  <tr key={r.id}>
                    <td className="pay-who-name"><span className="truncate" title={nameById[r.userId] || r.userName || ''}>{nameById[r.userId] || r.userName || '—'}</span></td>
                    <td><span className="truncate" title={r.description}>{r.description}</span></td>
                    <td>{periodLabel(r.periodKey)}</td>
                    <td className="rt mono">{money(r.amount)}</td>
                    <td>{r.receiptFileId ? <button className="linklike" type="button" onClick={() => openReceipt(r)}><Icon name="invoices" size={13} /> View</button> : <span className="pay-muted">—</span>}</td>
                    <td><Badge variant={STATUS_VARIANT[r.status] || 'slate'}>{STATUS_LABEL[r.status] || r.status}</Badge></td>
                    {canEdit && (
                      <td className="rt hr-row-actions">
                        {r.status === 'pending' && <>
                          {mayApprove(r)
                            ? <button className="btn btn-success btn-sm" onClick={() => approve(r)} type="button">Approve</button>
                            : <span className="pay-muted" title="Only a Super Admin can approve your own reimbursement">Super Admin approves</span>}
                          <button className="btn btn-danger btn-sm" onClick={() => reject(r)} type="button">Reject</button>
                        </>}
                        <button className="btn-icon btn-icon-danger" onClick={() => setConfirmId(r.id)} type="button" aria-label="Remove"><Icon name="trash" size={14} /></button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun="reimbursements" />
        </>
      )}

      {viewFile && (
        <Modal open onClose={() => setViewFile(null)} title={viewFile.name || 'Receipt'} size="md">
          {(viewFile.mimeType || '').startsWith('image') ? (
            <img src={viewFile.url} alt={viewFile.name || 'Receipt'} style={{ maxWidth: '100%', borderRadius: 8 }} />
          ) : (
            <p>This receipt is a {viewFile.mimeType || 'file'}. <a href={viewFile.url} download={viewFile.name || 'receipt'}>Download it</a>.</p>
          )}
        </Modal>
      )}
      {confirmR && <ConfirmDialog open title="Remove reimbursement?" message={confirmR.status === 'approved' ? 'This also removes its line from the pay run.' : 'This removes the reimbursement request.'} confirmLabel="Remove" onConfirm={() => del(confirmR)} onClose={() => setConfirmId(null)} />}
    </div>
  );
}
