import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import { useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import { selectVisibleSitesFor, selectClientById } from '../store/selectors';
import * as qcApi from '../lib/qcApi';
import { WO_TYPES, WO_TYPE_META, WO_PRIORITIES, WO_PRIORITY_META } from '../lib/workOrders';
import SearchSelect from './SearchSelect';
import MediaGallery from './MediaGallery';

// Log a work order (relational problem_reports — the staff/crew logging surface).
// Staff-logged work orders are origin 'internal'; the client portal sets origin
// 'portal' when a client raises one (later increment). Names resolve server-side in
// real mode; clientName/siteName ride along for the demo stub. Mirrors the old
// ProblemModal, grown with type + priority (priority replaces severity).
export default function WorkOrderModal({ open, onClose, onCreated, presetSiteId = '' }) {
  const state = useStore();
  const { currentUser } = useAuth();
  const toast = useToast();
  // Crew only see sites for clients they're assigned to; managers see all.
  const sites = useMemo(() => selectVisibleSitesFor(state, currentUser), [state, currentUser]);
  const [form, setForm] = useState({ siteId: presetSiteId, title: '', description: '', type: 'issue', priority: 'medium' });
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('form');   // 'form' → fill it out · 'photos' → attach optional photo
  const [created, setCreated] = useState(null);

  useEffect(() => {
    if (open) { setForm({ siteId: presetSiteId, title: '', description: '', type: 'issue', priority: 'medium' }); setPhase('form'); setCreated(null); }
  }, [open, presetSiteId]);

  const save = async () => {
    if (!form.title.trim()) { toast.error('A title is required'); return; }
    setBusy(true);
    try {
      const site = sites.find((s) => s.id === form.siteId);
      const client = site ? selectClientById(state, site.clientId) : null;
      const problem = await qcApi.createProblem({
        siteId: form.siteId || null, clientId: site?.clientId || null,
        title: form.title.trim(), description: form.description,
        type: form.type, priority: form.priority, origin: 'internal',
        reportedByUserId: currentUser?.id || null,
        siteName: site?.name || null, clientName: client?.name || null,
      });
      toast.success('Work order logged');
      // Tied to a site → stay open for an optional photo (media is site-scoped).
      if (problem?.site_id) { setCreated(problem); setPhase('photos'); }
      else { onCreated?.(problem); onClose(); }
    } catch (e) { toast.error(e.message || 'Could not save the work order'); }
    finally { setBusy(false); }
  };

  const finish = () => { onCreated?.(created); onClose(); };

  return (
    <Modal
      open={open}
      onClose={phase === 'photos' ? finish : onClose}
      title={phase === 'photos' ? 'Add a photo' : 'New work order'}
    >
      {phase === 'photos' && created ? (
        <div>
          <p className="text-muted" style={{ marginTop: 0 }}>
            ✓ Work order logged{(created.client_name || created.site_name) ? <> at <strong>{created.client_name || created.site_name}</strong></> : ''}. Add a photo so the team can see the issue. Optional.
          </p>
          <MediaGallery
            siteId={created.site_id}
            clientId={created.client_id}
            scope="problem_report"
            refId={created.id}
            label="Photos & video"
            hint="Attach a photo of the issue. Managers see these on the work order."
          />
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={finish}>Done</button>
          </div>
        </div>
      ) : (
        <div>
          <div className="form-group">
            <label className="form-label">Location</label>
            <SearchSelect
              value={form.siteId}
              onChange={(id) => setForm({ ...form, siteId: id || '' })}
              options={sites.map((s) => { const c = selectClientById(state, s.clientId); return { value: s.id, label: c?.name || s.name, sublabel: s.address || '' }; })}
              placeholder="no specific location"
              searchPlaceholder="Search locations…"
            />
            <div className="text-xs text-muted wo-fieldhelp">Pick a location to attach a photo and route it to the account’s queue.</div>
          </div>
          <FormField label="Title" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Broken soap dispenser, 2nd floor restroom" />
          <FormField label="Details" as="textarea" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What's wrong or requested, where, and any detail the team needs." />
          <div className="form-group">
            <label className="form-label">Type</label>
            <div className="tab-container-line" role="group" aria-label="Type">
              {WO_TYPES.map((t) => (
                <button key={t} type="button" className={`tab-btn ${form.type === t ? 'active' : ''}`} onClick={() => setForm({ ...form, type: t })}>{WO_TYPE_META[t].label}</button>
              ))}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Priority</label>
            <div className="tab-container-line" role="group" aria-label="Priority">
              {WO_PRIORITIES.map((p) => (
                <button key={p} type="button" className={`tab-btn ${form.priority === p ? 'active' : ''}`} onClick={() => setForm({ ...form, priority: p })}>{WO_PRIORITY_META[p].label}</button>
              ))}
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Log work order'}</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
