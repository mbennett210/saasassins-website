import { useEffect, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectServices, selectFrequencies } from '../store/selectors';
import { useToast } from './Toast';

const EMPTY = {
  name: '', primaryContact: '', email: '', phone: '', serviceId: '', frequencyId: '', status: 'active',
};

export default function AddClientModal({ open, onClose, mode = 'create', initialData = null }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const services = selectServices(state);
  const frequencies = selectFrequencies(state);

  const [form, setForm] = useState(EMPTY);

  useEffect(() => {
    if (!open) return;
    if (mode === 'edit' && initialData) {
      setForm({
        name: initialData.name || '',
        primaryContact: initialData.primaryContact || '',
        email: initialData.email || '',
        phone: initialData.phone || '',
        serviceId: initialData.serviceId || services[0]?.id || '',
        frequencyId: initialData.frequencyId || frequencies[0]?.id || '',
        status: initialData.status || 'active',
      });
    } else {
      setForm({ ...EMPTY, serviceId: services[0]?.id || '', frequencyId: frequencies[0]?.id || '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialData, mode]);

  const submit = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return;
    const payload = {
      name: form.name.trim(),
      primaryContact: form.primaryContact.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      serviceId: form.serviceId,
      frequencyId: form.frequencyId,
      status: form.status,
    };
    if (mode === 'edit' && initialData) {
      dispatch({ type: ACTIONS.UPDATE_CLIENT, id: initialData.id, patch: payload });
      toast.success('Client updated');
    } else {
      dispatch({ type: ACTIONS.ADD_CLIENT, client: payload });
      toast.success('Client added');
    }
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={mode === 'edit' ? 'Edit Client' : 'Add Client'}>
      <form onSubmit={submit}>
        <FormField label="Company name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Acme Corp" />
        <FormField label="Primary contact" value={form.primaryContact} onChange={(e) => setForm({ ...form, primaryContact: e.target.value })} placeholder="Full name" />
        <div className="form-row">
          <FormField label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <FormField label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div className="form-row">
          <FormField
            label="Service" as="select" required value={form.serviceId}
            onChange={(e) => setForm({ ...form, serviceId: e.target.value })}
            options={services.map((s) => ({ value: s.id, label: s.name }))}
          />
          <FormField
            label="Frequency" as="select" required value={form.frequencyId}
            onChange={(e) => setForm({ ...form, frequencyId: e.target.value })}
            options={frequencies.map((f) => ({ value: f.id, label: f.label }))}
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">{mode === 'edit' ? 'Save Changes' : 'Add Client'}</button>
        </div>
      </form>
    </Modal>
  );
}
