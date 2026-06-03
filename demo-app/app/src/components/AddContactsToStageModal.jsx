import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import Avatar from './Avatar';
import AddContactModal from './AddContactModal';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectContacts, selectPipelines } from '../store/selectors';
import { useToast } from './Toast';

export default function AddContactsToStageModal({ open, onClose, pipelineId, stageKey, stageLabel }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const allContacts = selectContacts(state);
  const pipelines = selectPipelines(state);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [addContactOpen, setAddContactOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setSelected(new Set());
    }
  }, [open]);

  const eligible = useMemo(() => {
    return allContacts.filter((c) => {
      if (c.lifecycle === 'vendor' || c.lifecycle === 'client') return false;
      if (c.pipelineId === pipelineId && c.stage === stageKey) return false;
      return true;
    });
  }, [allContacts, pipelineId, stageKey]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter((c) => {
      const name = `${c.firstName} ${c.lastName}`.toLowerCase();
      const email = (c.email || '').toLowerCase();
      const company = (c.customFields?.company || '').toLowerCase();
      return name.includes(q) || email.includes(q) || company.includes(q);
    });
  }, [eligible, query]);

  const toggle = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const currentLocation = (contact) => {
    if (!contact.pipelineId || !contact.stage) return null;
    const pl = pipelines.find((p) => p.id === contact.pipelineId);
    if (!pl) return null;
    const st = (pl.stages || []).find((s) => s.key === contact.stage);
    if (!st) return null;
    return `${pl.label} / ${st.label}`;
  };

  const handleAdd = () => {
    if (selected.size === 0) return;
    selected.forEach((id) => {
      dispatch({ type: ACTIONS.SET_CONTACT_STAGE, id, stage: stageKey, pipelineId });
    });
    toast.success(`${selected.size} contact${selected.size === 1 ? '' : 's'} added to ${stageLabel}`);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={`Add Contacts to ${stageLabel}`}>
      <p className="text-sm text-muted" style={{ marginTop: 0, marginBottom: 12 }}>
        Pick leads or prospects to add. Clients and vendors are excluded. Contacts already in another pipeline will be moved.
      </p>

      <input
        className="input"
        placeholder="Search by name, email, or company…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
        style={{ marginBottom: 10 }}
      />

      <div className="add-contacts-list">
        {filtered.length === 0 && (
          <div className="text-sm text-muted" style={{ padding: 12, textAlign: 'center' }}>
            {eligible.length === 0 ? 'No eligible contacts available.' : 'No matches.'}
          </div>
        )}
        {filtered.map((c) => {
          const isOn = selected.has(c.id);
          const location = currentLocation(c);
          return (
            <label key={c.id} className={`add-contacts-row ${isOn ? 'is-selected' : ''}`}>
              <input type="checkbox" checked={isOn} onChange={() => toggle(c.id)} />
              <Avatar
                initials={`${(c.firstName[0] || '').toUpperCase()}${(c.lastName[0] || '').toUpperCase()}`}
                variant={(c.id.length % 5) + 1}
                size="sm"
              />
              <div className="add-contacts-info">
                <div className="add-contacts-name">{c.firstName} {c.lastName}</div>
                <div className="add-contacts-meta text-xs text-muted">
                  {c.customFields?.company || c.email}
                  {location && <span className="add-contacts-loc"> · Currently in: {location}</span>}
                </div>
              </div>
              <span className={`badge badge-${c.lifecycle === 'lead' ? 'amber' : 'blue'}`}>{c.lifecycle}</span>
            </label>
          );
        })}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-outline" onClick={() => setAddContactOpen(true)}>
          New contact
        </button>
        <button type="button" className="btn btn-primary" disabled={selected.size === 0} onClick={handleAdd}>
          Add {selected.size > 0 ? `${selected.size} ` : ''}to {stageLabel}
        </button>
      </div>

      <AddContactModal open={addContactOpen} onClose={() => setAddContactOpen(false)} />
    </Modal>
  );
}
