// Employee HR record fields — Employee ID, hire date, employment type, PTO allowance.
// Self-contained (its own Save dispatching UPDATE_USER { patch:{hr} }), so it drops in
// on the Settings → Team profile AND inside the HR employee panel with no coupling.
// Gated: visible with hr.view, editable with hr.edit.
import { useState, useCallback } from 'react';
import { useDispatch, useSelector } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectCurrentUser } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useToast } from './Toast';
import FormField from './FormField';

const EMPLOYMENT_TYPES = [
  { value: '', label: '— Select —' },
  { value: 'full_time', label: 'Full-time' },
  { value: 'part_time', label: 'Part-time' },
  { value: 'contractor', label: 'Contractor' },
];

export const EMPLOYMENT_LABEL = {
  full_time: 'Full-time', part_time: 'Part-time', contractor: 'Contractor',
};

export default function EmployeeHrFieldsCard({ user }) {
  const dispatch = useDispatch();
  const toast = useToast();
  const canEdit = usePermission('hr.edit');
  // Your OWN HR record is a Super Admin's (owner/admin by role) — it carries your pay
  // terms, PTO allowance and employment type. The server refuses it for anyone else even
  // with hr.edit (2026-09-23, owner's call), and a refused save drops the whole pending
  // batch (store/sync.js), so the card must not offer it on your own record.
  const currentUser = useSelector(useCallback((s) => selectCurrentUser(s), []));
  const ownRecordLocked = !!currentUser && user.id === currentUser.id && !(currentUser.role === 'owner' || currentUser.role === 'admin');
  const canEditThis = canEdit && !ownRecordLocked;
  const [hr, setHr] = useState(() => ({ ...(user.hr || {}) }));

  const set = (next) => setHr((prev) => ({ ...prev, ...next }));
  const save = () => {
    if (!canEditThis) return;
    dispatch({ type: ACTIONS.UPDATE_USER, id: user.id, patch: { hr: { ...(user.hr || {}), ...hr } } });
    toast.success('HR details saved');
  };

  return (
    <div className="card detail-card">
      <h3 className="dash-card-title">HR details</h3>
      <p className="text-xs text-muted" style={{ marginTop: -4, marginBottom: 12 }}>
        Employee record. {!canEditThis && (ownRecordLocked ? 'Only a Super Admin can change your own HR record.' : 'Read-only — needs HR access to edit.')}
      </p>
      <div className="form-row">
        <FormField label="Employee ID" value={hr.employeeId || ''} disabled={!canEditThis} onChange={(e) => set({ employeeId: e.target.value })} help="Auto-assigned on create; editable to match your payroll system." />
        <FormField label="Hire date" type="date" value={hr.hireDate || ''} disabled={!canEditThis} onChange={(e) => set({ hireDate: e.target.value })} />
      </div>
      <div className="form-row">
        <FormField label="Employment type" as="select" value={hr.employmentType || ''} disabled={!canEditThis} onChange={(e) => set({ employmentType: e.target.value })} options={EMPLOYMENT_TYPES} />
        <FormField label="PTO allowance (days / year)" type="number" min="0" step="1" value={hr.ptoAllowanceDays ?? ''} disabled={!canEditThis} onChange={(e) => set({ ptoAllowanceDays: e.target.value === '' ? undefined : Number(e.target.value) })} />
      </div>
      {canEditThis && (
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={save}>Save HR details</button>
        </div>
      )}
    </div>
  );
}
