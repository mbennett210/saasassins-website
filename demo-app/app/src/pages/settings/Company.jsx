import { useState, useEffect } from 'react';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectCompany } from '../../store/selectors';
import { useToast } from '../../components/Toast';
import FormField from '../../components/FormField';

export default function SettingsCompany() {
  const company = selectCompany(useStore());
  const dispatch = useDispatch();
  const toast = useToast();
  const [form, setForm] = useState(company);

  useEffect(() => { setForm(company); }, [company]);

  const save = (e) => {
    e.preventDefault();
    dispatch({
      type: ACTIONS.UPDATE_COMPANY,
      patch: {
        name: form.name,
        owner: form.owner,
        logoInitials: (form.logoInitials || '').toUpperCase().slice(0, 3),
        invoicePrefix: form.invoicePrefix,
        address: form.address,
        phone: form.phone,
        email: form.email,
        businessHours: form.businessHours,
        taxRate: Number(form.taxRate) || 0,
      },
    });
    toast.success('Company saved');
  };

  return (
    <div>
      <div className="page-head-text">
        <h1 className="page-head-title">Company</h1>
        <p className="page-head-subtitle">Your business identity. Shows on invoices, portal, and reminder emails.</p>
      </div>

      <form className="card detail-card" onSubmit={save}>
        <div className="form-row">
          <FormField label="Company name" required value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <FormField label="Owner" value={form.owner || ''} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
        </div>
        <div className="form-row">
          <FormField label="Logo initials" value={form.logoInitials || ''} onChange={(e) => setForm({ ...form, logoInitials: e.target.value })} help="2–3 characters shown as a badge" />
          <FormField label="Invoice prefix" value={form.invoicePrefix || ''} onChange={(e) => setForm({ ...form, invoicePrefix: e.target.value })} help="e.g., INV or ACME" />
          <FormField label="Default tax rate (%)" type="number" step="0.01" min="0" value={form.taxRate ?? 0} onChange={(e) => setForm({ ...form, taxRate: e.target.value })} />
        </div>
        <FormField label="Business address" value={form.address || ''} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        <div className="form-row">
          <FormField label="Phone" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <FormField label="Email" type="email" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <FormField label="Business hours" value={form.businessHours || ''} onChange={(e) => setForm({ ...form, businessHours: e.target.value })} />
        <div className="modal-actions">
          <button type="submit" className="btn btn-primary">Save Company</button>
        </div>
      </form>
    </div>
  );
}
