// Create / configure an inbound LEAD webhook (Settings → Integrations).
//
// Collects the webhook's name + ingestion point — the pipeline + stage a new lead's
// deal starts at (defaulting to the Master Pipeline's first stage, New Lead), the
// default lifecycle, and source tags applied to every lead. On create the backend
// mints a slug + bearer token (shown for copy in the parent).
import { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import Select from './Select';
import TagPicker from './TagPicker';
import { useStore } from '../store';
import { useToast } from './Toast';
import { createEndpoint, updateEndpoint } from '../lib/integrationsApi';

const LIFECYCLES = [
  { value: 'lead', label: 'Lead' },
  { value: 'prospect', label: 'Prospect' },
  { value: 'client', label: 'Client' },
  { value: 'vendor', label: 'Vendor' },
];

export default function LeadWebhookModal({ open, endpoint, onClose, onSaved }) {
  const state = useStore();
  const toast = useToast();
  const editing = !!endpoint;

  const pipelines = useMemo(() => state.pipelines || [], [state.pipelines]);
  const masterId = useMemo(() => pipelines.find((p) => p.isMaster)?.id || null, [pipelines]);

  const [name, setName] = useState('');
  const [pipelineId, setPipelineId] = useState('');
  const [stage, setStage] = useState('');
  const [lifecycle, setLifecycle] = useState('lead');
  const [tagIds, setTagIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Seed from the endpoint being edited, else default to the Master Pipeline's first stage.
  useEffect(() => {
    if (!open) return;
    setError(''); setBusy(false);
    const cfg = (endpoint && endpoint.lead_config) || {};
    setName(endpoint ? (endpoint.name || '') : '');
    const pid = cfg.pipelineId || masterId || '';
    setPipelineId(pid);
    const p = pipelines.find((x) => x.id === pid);
    setStage(cfg.stage || (p?.stages?.[0]?.key || ''));
    setLifecycle(cfg.lifecycle || 'lead');
    setTagIds(Array.isArray(cfg.tagIds) ? cfg.tagIds : []);
  }, [open, endpoint, masterId, pipelines]);

  const selectedPipeline = pipelines.find((p) => p.id === pipelineId) || null;
  const stageOptions = selectedPipeline
    ? (selectedPipeline.stages || []).map((s) => ({ value: s.key, label: s.label }))
    : [];

  const onPipelineChange = (pid) => {
    setPipelineId(pid);
    const p = pipelines.find((x) => x.id === pid);
    setStage(p ? (p.stages?.[0]?.key || '') : '');
  };

  const submit = async () => {
    setError('');
    if (!name.trim()) { setError('Give the webhook a name (e.g. “FB Leads”).'); return; }
    if (!pipelineId || !stage) { setError('Choose where leads should land (pipeline + stage).'); return; }
    setBusy(true);
    try {
      const leadConfig = { pipelineId, stage, lifecycle, tagIds, sourceLabel: name.trim() };
      if (editing) {
        await updateEndpoint(endpoint.id, { name: name.trim(), lead_config: leadConfig });
        toast.success('Lead webhook updated');
        onSaved && onSaved(null);
      } else {
        const created = await createEndpoint({ name: name.trim(), purpose: 'lead_intake', leadConfig });
        toast.success('Lead webhook created');
        onSaved && onSaved(created);
      }
      onClose();
    } catch (e) {
      setError(e.message || 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? `Configure “${endpoint.name}”` : 'New lead webhook'} size="md">
      <p className="text-sm text-muted" style={{ marginTop: -4, marginBottom: 14 }}>
        Leads POSTed to this webhook are upserted into Contacts (matched by email → phone, blanks filled,
        never overwritten), with a deal opened for their company at the stage below.
      </p>

      <div className="form-group">
        <label className="form-label">Name</label>
        <input className="input" value={name} placeholder="e.g. FB Leads, Partner referrals" onChange={(e) => setName(e.target.value)} />
        <div className="text-xs text-muted" style={{ marginTop: 4 }}>Shown in the list; also stored as the lead source.</div>
      </div>

      <div className="form-row" style={{ marginTop: 12 }}>
        <div className="form-group">
          <label className="form-label">Land in pipeline</label>
          <Select
            ariaLabel="Pipeline"
            value={pipelineId}
            onChange={onPipelineChange}
            options={pipelines.map((p) => ({ value: p.id, label: p.label }))}
          />
        </div>
        <div className="form-group">
          <label className="form-label">Stage</label>
          <Select
            ariaLabel="Stage"
            value={stage}
            onChange={setStage}
            disabled={!pipelineId}
            options={pipelineId ? stageOptions : [{ value: '', label: '—' }]}
          />
        </div>
      </div>
      <div className="text-xs text-muted" style={{ marginTop: 4 }}>
        Defaults to the Master Pipeline’s New Lead stage. A new lead’s deal starts here; an existing company
        with an open deal is enriched, not moved.
      </div>

      <div className="form-row" style={{ marginTop: 12 }}>
        <div className="form-group">
          <label className="form-label">Default lifecycle</label>
          <Select ariaLabel="Lifecycle" value={lifecycle} onChange={setLifecycle} options={LIFECYCLES} />
        </div>
        <div className="form-group">
          <label className="form-label">Source tags</label>
          <TagPicker value={tagIds} onChange={setTagIds} placeholder="Add a source tag…" />
        </div>
      </div>
      <div className="text-xs text-muted" style={{ marginTop: 4 }}>Tags are added to every lead from this webhook (on top of any its payload sends).</div>

      {error && <div className="form-error" style={{ marginTop: 12 }}>{error}</div>}

      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save' : 'Create webhook'}
        </button>
      </div>
    </Modal>
  );
}
