import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import Avatar from './Avatar';
import AddCompanyModal from './AddCompanyModal';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectClients, selectOpportunities } from '../store/selectors';
import { useToast } from './Toast';
import { newId } from '../lib/ids';

// "Add a deal to <stage>": pick the COMPANIES you have a deal with; each becomes a
// company-owned Opportunity placed at that stage. Vendors are excluded. Deal value
// and details are filled in afterward on the card.

const companyInitials = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

export default function AddContactsToStageModal({ open, onClose, pipelineId, stageKey, stageLabel }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const clients = selectClients(state);
  const opportunities = selectOpportunities(state);

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [addCompanyOpen, setAddCompanyOpen] = useState(false);

  useEffect(() => {
    if (!open) { setQuery(''); setSelected(new Set()); }
  }, [open]);

  // Any non-vendor company can have a deal (a company may have several).
  const eligible = useMemo(() => clients.filter((c) => c.type !== 'vendor'), [clients]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter((c) => c.name.toLowerCase().includes(q));
  }, [eligible, query]);

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const openCountFor = (clientId) => opportunities.filter((o) => o.clientId === clientId && o.status === 'open').length;

  const handleAdd = () => {
    if (selected.size === 0) return;
    selected.forEach((clientId) => {
      const cl = clients.find((c) => c.id === clientId);
      dispatch({
        type: ACTIONS.ADD_OPPORTUNITY,
        opportunity: {
          id: newId('opp'),
          clientId,
          primaryContactId: cl?.primaryContactId || null,
          pipelineId,
          stage: stageKey,
        },
      });
    });
    toast.success(`${selected.size} deal${selected.size === 1 ? '' : 's'} added to ${stageLabel}`);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={`Add a deal to ${stageLabel}`}>
      <p className="text-sm text-muted" style={{ marginTop: 0, marginBottom: 12 }}>
        Pick the companies you have a deal with. Vendors are excluded. Fill in the deal value and details afterward on the card.
      </p>

      <input
        className="input"
        placeholder="Search companies…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        autoFocus
        style={{ marginBottom: 10 }}
      />

      <div className="add-contacts-list">
        {filtered.length === 0 && (
          <div className="text-sm text-muted" style={{ padding: 12, textAlign: 'center' }}>
            {eligible.length === 0 ? 'No companies available.' : 'No matches.'}
          </div>
        )}
        {filtered.map((c) => {
          const isOn = selected.has(c.id);
          const openCount = openCountFor(c.id);
          return (
            <label key={c.id} className={`add-contacts-row ${isOn ? 'is-selected' : ''}`}>
              <input type="checkbox" checked={isOn} onChange={() => toggle(c.id)} />
              <Avatar initials={companyInitials(c.name)} variant={(c.id.length % 5) + 1} size="sm" />
              <div className="add-contacts-info">
                <div className="add-contacts-name">{c.name}</div>
                <div className="add-contacts-meta text-xs text-muted">
                  {c.contactNumber ? `#${c.contactNumber}` : ''}
                  {openCount > 0 && <span className="add-contacts-loc"> · {openCount} open deal{openCount === 1 ? '' : 's'}</span>}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-outline" onClick={() => setAddCompanyOpen(true)}>New company</button>
        <button type="button" className="btn btn-primary" disabled={selected.size === 0} onClick={handleAdd}>
          {selected.size > 0 ? `Add ${selected.size} deal${selected.size === 1 ? '' : 's'}` : 'Add deals'}
        </button>
      </div>

      <AddCompanyModal open={addCompanyOpen} onClose={() => setAddCompanyOpen(false)} />
    </Modal>
  );
}
