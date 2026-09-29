import { useState } from 'react';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectServices, selectFrequencies, BILLING_UNITS, billingUnitShort } from '../../store/selectors';
import { useToast } from '../../components/Toast';
import FormField from '../../components/FormField';
import ConfirmDialog from '../../components/ConfirmDialog';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import TableSearch from '../../components/TableSearch';
import { money } from '../../lib/dates';
import { searchRows } from '../../lib/searchRows';
import { usePagedRows } from '../../hooks/usePagedRows';
import { useTableSearch } from '../../hooks/useTableSearch';
import ListPager from '../../components/ListPager';

const BILLING_UNIT_OPTIONS = BILLING_UNITS.map((u) => ({ value: u.value, label: u.label }));

// Catalog rate summary for the read-only cell, e.g. "$350 / per visit" or "—".
function rateLabel(s) {
  const price = Number(s.defaultPrice) || 0;
  if (price <= 0) return '—';
  return `${money(price)} / ${billingUnitShort(s.billingUnit)}`;
}

export default function SettingsServices() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const services = selectServices(state);
  const frequencies = selectFrequencies(state);

  const [newService, setNewService] = useState({ name: '', defaultDurationMins: 60, defaultPrice: '', billingUnit: 'per-visit' });
  const [newFreq, setNewFreq] = useState({ label: '' });
  const [editService, setEditService] = useState(null);
  const [editFreq, setEditFreq] = useState(null);
  const [confirm, setConfirm] = useState(null);
  // Services is a growable catalog: URL-backed search (§72) over name + billing unit.
  const [q, setQ] = useTableSearch('q');
  const filteredServices = searchRows(services, q, (s) => `${s.name} ${billingUnitShort(s.billingUnit)}`);
  const servicePager = usePagedRows(filteredServices, { resetKey: q });
  // Frequencies is a tiny fixed enum: no search, just pagination.
  const freqPager = usePagedRows(frequencies);

  const addService = (e) => {
    e.preventDefault();
    if (!newService.name.trim()) return;
    dispatch({
      type: ACTIONS.ADD_SERVICE,
      service: {
        name: newService.name.trim(),
        defaultDurationMins: Number(newService.defaultDurationMins) || 60,
        defaultPrice: Number(newService.defaultPrice) || 0,
        billingUnit: newService.billingUnit || 'per-visit',
      },
    });
    setNewService({ name: '', defaultDurationMins: 60, defaultPrice: '', billingUnit: 'per-visit' });
    servicePager.goToLast();
    toast.success('Service added');
  };
  const saveService = (s) => {
    dispatch({
      type: ACTIONS.UPDATE_SERVICE,
      id: s.id,
      patch: {
        name: s.name,
        defaultDurationMins: Number(s.defaultDurationMins) || 60,
        defaultPrice: Number(s.defaultPrice) || 0,
        billingUnit: s.billingUnit || 'per-visit',
      },
    });
    setEditService(null);
    toast.success('Service saved');
  };
  const addFreq = (e) => {
    e.preventDefault();
    if (!newFreq.label.trim()) return;
    dispatch({ type: ACTIONS.ADD_FREQUENCY, frequency: { label: newFreq.label.trim() } });
    setNewFreq({ label: '' });
    freqPager.goToLast();
    toast.success('Frequency added');
  };
  const saveFreq = (f) => {
    dispatch({ type: ACTIONS.UPDATE_FREQUENCY, id: f.id, patch: { label: f.label } });
    setEditFreq(null);
    toast.success('Frequency saved');
  };

  return (
    <div>
      <div className="page-head-text">
        <h1 className="page-head-title">Services & Frequencies</h1>
      </div>

      <div className="settings-table-sections">
        <div>
          <div className="table-head">
            <h3 className="table-head-title">Services</h3>
            {services.length > 0 && (
              <div className="table-controls">
                <TableSearch value={q} onChange={setQ} placeholder="Search services" ariaLabel="Search services" />
                {q.trim() && <span className="table-count">{filteredServices.length} of {services.length}</span>}
              </div>
            )}
          </div>
          <form className="form-row" onSubmit={addService} style={{ alignItems: 'flex-end', marginBottom: 12 }}>
            <FormField label="New service" value={newService.name} onChange={(e) => setNewService({ ...newService, name: e.target.value })} placeholder="e.g., Carpet Cleaning" />
            <FormField label="Default duration (min)" type="number" min="15" step="15" value={newService.defaultDurationMins} onChange={(e) => setNewService({ ...newService, defaultDurationMins: e.target.value })} />
            <FormField label="Default price ($)" type="number" min="0" step="0.01" value={newService.defaultPrice} onChange={(e) => setNewService({ ...newService, defaultPrice: e.target.value })} placeholder="0.00" />
            <FormField label="Billing unit" as="select" value={newService.billingUnit} onChange={(e) => setNewService({ ...newService, billingUnit: e.target.value })} options={BILLING_UNIT_OPTIONS} />
            <div className="form-group">
              <button type="submit" className="btn btn-primary" disabled={!newService.name.trim()}>Add</button>
            </div>
          </form>
          <p className="text-muted text-sm" style={{ marginTop: -4, marginBottom: 12 }}>
            Default price + billing unit pre-fill invoice line items so you&rsquo;re not retyping rates. Leave price at 0 to skip.
          </p>
          {services.length === 0 ? (
            <EmptyState title="No services yet" message="Add your first service above." />
          ) : filteredServices.length === 0 ? (
            <EmptyState
              icon={<Icon name="search" size={28} />}
              title="No matching services"
              message={`Nothing matches “${q}”. Try a different name or billing unit.`}
            />
          ) : (
            <>
              <div className="table-wrap mobile-stack">
                <table>
                  <thead><tr><th>Name</th><th>Default duration</th><th>Default rate</th><th style={{ width: 140 }}></th></tr></thead>
                  <tbody>
                    {servicePager.pageRows.map((s) => {
                      const editing = editService?.id === s.id;
                      return (
                        <tr key={s.id}>
                          <td className="cell-primary">{editing ? (
                            <input className="input" value={editService.name} onChange={(e) => setEditService({ ...editService, name: e.target.value })} />
                          ) : <span className="truncate" title={s.name}>{s.name}</span>}</td>
                          <td data-label="Default duration">{editing ? (
                            <input type="number" className="input" style={{ maxWidth: 120 }} value={editService.defaultDurationMins} onChange={(e) => setEditService({ ...editService, defaultDurationMins: e.target.value })} />
                          ) : `${s.defaultDurationMins} min`}</td>
                          <td data-label="Default rate">{editing ? (
                            <div className="flex-row" style={{ gap: 6 }}>
                              <input type="number" min="0" step="0.01" className="input" style={{ maxWidth: 100 }} value={editService.defaultPrice ?? ''} onChange={(e) => setEditService({ ...editService, defaultPrice: e.target.value })} placeholder="0.00" />
                              <select className="input" style={{ maxWidth: 130 }} value={editService.billingUnit || 'per-visit'} onChange={(e) => setEditService({ ...editService, billingUnit: e.target.value })}>
                                {BILLING_UNIT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                          ) : rateLabel(s)}</td>
                          <td className="text-right cell-actions">
                            {editing ? (
                              <>
                                <button className="btn btn-primary btn-sm" onClick={() => saveService(editService)}>Save</button>
                                <button className="btn btn-outline btn-sm" onClick={() => setEditService(null)} style={{ marginLeft: 6 }}>Cancel</button>
                              </>
                            ) : (
                              <>
                                <button className="btn-icon" aria-label="Edit" onClick={() => setEditService(s)}><Icon name="edit" size={14} /></button>
                                <button className="btn-icon btn-icon-danger" aria-label="Delete" onClick={() => setConfirm({ kind: 'service', item: s })}><Icon name="trash" size={14} /></button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ListPager pager={servicePager} noun="services" />
            </>
          )}
        </div>

        <div>
          <div className="table-head">
            <h3 className="table-head-title">Frequencies</h3>
          </div>
          <form className="form-row" onSubmit={addFreq} style={{ alignItems: 'flex-end', marginBottom: 12 }}>
            <FormField label="New frequency" value={newFreq.label} onChange={(e) => setNewFreq({ label: e.target.value })} placeholder="e.g., Semi-Annual" />
            <div className="form-group">
              <button type="submit" className="btn btn-primary" disabled={!newFreq.label.trim()}>Add</button>
            </div>
          </form>
          {frequencies.length === 0 ? (
            <EmptyState title="No frequencies yet" message="Add a cadence for how often you service clients." />
          ) : (
            <>
              <div className="table-wrap mobile-stack">
                <table>
                  <thead><tr><th>Label</th><th style={{ width: 140 }}></th></tr></thead>
                  <tbody>
                    {freqPager.pageRows.map((f) => {
                      const editing = editFreq?.id === f.id;
                      return (
                        <tr key={f.id}>
                          <td className="cell-primary">{editing ? (
                            <input className="input" value={editFreq.label} onChange={(e) => setEditFreq({ ...editFreq, label: e.target.value })} />
                          ) : <span className="truncate" title={f.label}>{f.label}</span>}</td>
                          <td className="text-right cell-actions">
                            {editing ? (
                              <>
                                <button className="btn btn-primary btn-sm" onClick={() => saveFreq(editFreq)}>Save</button>
                                <button className="btn btn-outline btn-sm" onClick={() => setEditFreq(null)} style={{ marginLeft: 6 }}>Cancel</button>
                              </>
                            ) : (
                              <>
                                <button className="btn-icon" aria-label="Edit" onClick={() => setEditFreq(f)}><Icon name="edit" size={14} /></button>
                                <button className="btn-icon btn-icon-danger" aria-label="Delete" onClick={() => setConfirm({ kind: 'frequency', item: f })}><Icon name="trash" size={14} /></button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <ListPager pager={freqPager} noun="frequencies" />
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={!!confirm}
        title={`Delete ${confirm?.item?.name || confirm?.item?.label}?`}
        message={`Existing records that reference this ${confirm?.kind} will fall back to "—".`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.kind === 'service') dispatch({ type: ACTIONS.DELETE_SERVICE, id: confirm.item.id });
          else dispatch({ type: ACTIONS.DELETE_FREQUENCY, id: confirm.item.id });
        }}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
