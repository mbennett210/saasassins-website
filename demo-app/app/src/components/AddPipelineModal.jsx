import { useEffect, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import Icon from './Icon';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectPipelines } from '../store/selectors';
import { useToast } from './Toast';

// "New pipeline": name it and set its opening stages. Each pipeline is its own
// board with its own stages. Won and Lost are added automatically as the two
// terminal stages, so they are not listed here.
const DEFAULT_STAGES = ['New Lead', 'Contacted', 'Proposal Sent', 'Negotiation'];

export default function AddPipelineModal({ open, onClose }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const pipelines = selectPipelines(state);

  const [name, setName] = useState('');
  const [stages, setStages] = useState(DEFAULT_STAGES);

  useEffect(() => {
    if (!open) { setName(''); setStages(DEFAULT_STAGES); }
  }, [open]);

  const setStageAt = (i, value) => setStages((prev) => prev.map((s, idx) => (idx === i ? value : s)));
  const addStage = () => setStages((prev) => [...prev, '']);
  const removeStage = (i) => setStages((prev) => prev.filter((_, idx) => idx !== i));

  const handleCreate = () => {
    const label = name.trim();
    if (!label) { toast.error('Pipeline name is required.'); return; }
    if (pipelines.some((p) => p.label.toLowerCase() === label.toLowerCase())) {
      toast.error(`A pipeline named "${label}" already exists.`);
      return;
    }
    const stageLabels = stages.map((s) => s.trim()).filter(Boolean);
    dispatch({ type: ACTIONS.ADD_PIPELINE, label, stageLabels });
    toast.success(`Pipeline "${label}" created`);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="New pipeline">
      <p className="text-sm text-muted modal-intro">
        Name the pipeline and set its opening stages. Won and Lost are added automatically. You can rename, reorder, add, or delete stages later from Edit stages.
      </p>

      <FormField
        label="Pipeline name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="e.g. Commercial Sales"
        autoFocus
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleCreate(); } }}
      />

      <label className="form-label">Opening stages</label>
      <div className="stage-list">
        {stages.map((stage, i) => (
          <div className="stage-row" key={i}>
            <input
              className="input stage-row-label"
              value={stage}
              onChange={(e) => setStageAt(i, e.target.value)}
              placeholder={`Stage ${i + 1}`}
            />
            <button
              type="button"
              className="btn-icon btn-icon-danger"
              onClick={() => removeStage(i)}
              aria-label="Remove stage"
              title="Remove stage"
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </div>

      <button type="button" className="btn btn-outline stage-add-more" onClick={addStage}>
        Add stage
      </button>

      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={handleCreate} disabled={!name.trim()}>
          Create pipeline
        </button>
      </div>
    </Modal>
  );
}
