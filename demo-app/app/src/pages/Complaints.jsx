// Complaints log — staff log customer complaints and track them open → ongoing →
// resolved. The dashboard's "Open Complaints" reads the open count from here.
import { useState } from 'react';
import { useStore, useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectComplaints } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import { fmtDate } from '../lib/dates';
import Icon from '../components/Icon';
import Badge from '../components/Badge';
import Modal from '../components/Modal';
import FormField from '../components/FormField';
import ConfirmDialog from '../components/ConfirmDialog';

const STATUS = {
  open: { label: 'Open', variant: 'red' },
  ongoing: { label: 'Ongoing', variant: 'amber' },
  resolved: { label: 'Resolved', variant: 'green' },
};
const NEXT = { open: 'ongoing', ongoing: 'resolved', resolved: 'open' };

export default function Complaints() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canManage = usePermission('complaints.manage');
  const complaints = selectComplaints(state);

  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ subject: '', clientName: '', detail: '' });
  const [confirmDelete, setConfirmDelete] = useState(null);

  const openCount = complaints.filter((c) => c.status !== 'resolved').length;
  const resolvedCount = complaints.length - openCount;
  const userName = (id) => (state.users || []).find((u) => u.id === id)?.name || '—';

  function submit() {
    if (!form.subject.trim()) { toast.error('Enter a subject.'); return; }
    dispatch({ type: ACTIONS.ADD_COMPLAINT, complaint: { subject: form.subject.trim(), clientName: form.clientName.trim(), detail: form.detail.trim() } });
    setForm({ subject: '', clientName: '', detail: '' });
    setModalOpen(false);
    toast.success('Complaint logged');
  }

  return (
    <div className="page">
      <div className="page-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h1>Complaints</h1>
          <p className="page-sub">Log customer complaints and track them to resolution. <strong>{openCount}</strong> open · {resolvedCount} resolved.</p>
        </div>
        {canManage && (
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}><Icon name="plus" size={16} /> Log complaint</button>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead><tr><th>Subject</th><th>Client</th><th>Status</th><th>Logged by</th><th>Date</th><th></th></tr></thead>
          <tbody>
            {complaints.length === 0 ? (
              <tr><td colSpan={6} style={{ textAlign: 'center', padding: 32, color: 'var(--text-muted)' }}>No complaints logged. Click <strong>Log complaint</strong> to add one.</td></tr>
            ) : complaints.map((c) => (
              <tr key={c.id}>
                <td style={{ fontWeight: 600 }}>{c.subject}{c.detail ? <div className="text-xs text-muted" style={{ fontWeight: 400, marginTop: 2 }}>{c.detail}</div> : null}</td>
                <td>{c.clientName || '—'}</td>
                <td><Badge variant={STATUS[c.status]?.variant || 'slate'}>{STATUS[c.status]?.label || c.status}</Badge></td>
                <td>{userName(c.createdBy)}</td>
                <td>{c.createdAt ? fmtDate(c.createdAt) : '—'}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {canManage && <button className="btn btn-link btn-sm" onClick={() => dispatch({ type: ACTIONS.UPDATE_COMPLAINT, id: c.id, patch: { status: NEXT[c.status] || 'open' } })}>Mark {STATUS[NEXT[c.status]]?.label}</button>}
                  {canManage && <button className="btn btn-link btn-sm" style={{ color: '#b91c1c' }} onClick={() => setConfirmDelete(c)}>Delete</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Log a complaint">
        <FormField label="Subject" value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} />
        <FormField label="Client (optional)" value={form.clientName} onChange={(e) => setForm((f) => ({ ...f, clientName: e.target.value }))} />
        <FormField label="Details (optional)" value={form.detail} onChange={(e) => setForm((f) => ({ ...f, detail: e.target.value }))} />
        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => setModalOpen(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={submit}>Log complaint</button>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete complaint?"
        message="This removes the complaint from the log."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => { dispatch({ type: ACTIONS.DELETE_COMPLAINT, id: confirmDelete.id }); setConfirmDelete(null); }}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}
