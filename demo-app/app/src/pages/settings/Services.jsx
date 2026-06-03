import { useState } from 'react';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectServices, selectFrequencies } from '../../store/selectors';
import { useToast } from '../../components/Toast';
import FormField from '../../components/FormField';
import ConfirmDialog from '../../components/ConfirmDialog';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';

export default function SettingsServices() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const services = selectServices(state);
  const frequencies = selectFrequencies(state);

  const [newService, setNewService] = useState({ name: '', defaultDurationMins: 60 });
  const [newFreq, setNewFreq] = useState({ label: '' });
  const [editService, setEditService] = useState(null);
  const [editFreq, setEditFreq] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const addService = (e) => {
    e.preventDefault();
    if (!newService.name.trim()) return;
    dispatch({ type: ACTIONS.ADD_SERVICE, service: { name: newService.name.trim(), defaultDurationMins: Number(newService.defaultDurationMins) || 60 } });
    setNewService({ name: '', defaultDurationMins: 60 });
    toast.success('Service added');
  };
  const saveService = (s) => {
    dispatch({ type: ACTIONS.UPDATE_SERVICE, id: s.id, patch: { name: s.name, defaultDurationMins: Number(s.defaultDurationMins) || 60 } });
    setEditService(null);
    toast.success('Service saved');
  };
  const addFreq = (e) => {
    e.preventDefault();
    if (!newFreq.label.trim()) return;
    dispatch({ type: ACTIONS.ADD_FREQUENCY, frequency: { label: newFreq.label.trim() } });
    setNewFreq({ label: '' });
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
        <p className="page-head-subtitle">These appear in client, job, and invoice forms.</p>
      </div>

      <div className="card detail-card" style={{ marginBottom: 20 }}>
        <h3 className="dash-card-title">Services</h3>
        <form className="form-row" onSubmit={addService} style={{ alignItems: 'flex-end', marginBottom: 12 }}>
          <FormField label="New service" value={newService.name} onChange={(e) => setNewService({ ...newService, name: e.target.value })} placeholder="e.g., Carpet Cleaning" />
          <FormField label="Default duration (min)" type="number" min="15" step="15" value={newService.defaultDurationMins} onChange={(e) => setNewService({ ...newService, defaultDurationMins: e.target.value })} />
          <div className="form-group">
            <button type="submit" className="btn btn-primary" disabled={!newService.name.trim()}>Add</button>
          </div>
        </form>
        {services.length === 0 ? (
          <EmptyState title="No services yet" message="Add your first service above." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Default duration</th><th style={{ width: 140 }}></th></tr></thead>
              <tbody>
                {services.map((s) => {
                  const editing = editService?.id === s.id;
                  return (
                    <tr key={s.id}>
                      <td>{editing ? (
                        <input className="input" value={editService.name} onChange={(e) => setEditService({ ...editService, name: e.target.value })} />
                      ) : s.name}</td>
                      <td>{editing ? (
                        <input type="number" className="input" style={{ maxWidth: 120 }} value={editService.defaultDurationMins} onChange={(e) => setEditService({ ...editService, defaultDurationMins: e.target.value })} />
                      ) : `${s.defaultDurationMins} min`}</td>
                      <td className="text-right">
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
        )}
      </div>

      <div className="card detail-card">
        <h3 className="dash-card-title">Frequencies</h3>
        <form className="form-row" onSubmit={addFreq} style={{ alignItems: 'flex-end', marginBottom: 12 }}>
          <FormField label="New frequency" value={newFreq.label} onChange={(e) => setNewFreq({ label: e.target.value })} placeholder="e.g., Semi-Annual" />
          <div className="form-group">
            <button type="submit" className="btn btn-primary" disabled={!newFreq.label.trim()}>Add</button>
          </div>
        </form>
        {frequencies.length === 0 ? (
          <EmptyState title="No frequencies yet" message="Add a cadence for how often you service clients." />
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Label</th><th style={{ width: 140 }}></th></tr></thead>
              <tbody>
                {frequencies.map((f) => {
                  const editing = editFreq?.id === f.id;
                  return (
                    <tr key={f.id}>
                      <td>{editing ? (
                        <input className="input" value={editFreq.label} onChange={(e) => setEditFreq({ ...editFreq, label: e.target.value })} />
                      ) : f.label}</td>
                      <td className="text-right">
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
        )}
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
