import { useState } from 'react';
import PipelineBoard from '../components/PipelineBoard';
import StageManagerModal from '../components/StageManagerModal';
import Modal from '../components/Modal';
import FormField from '../components/FormField';
import Icon from '../components/Icon';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectPipelines } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';

export default function Pipeline() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canEdit = usePermission('pipeline.edit');
  const pipelines = selectPipelines(state);

  const [manageStagesOpen, setManageStagesOpen] = useState(false);
  const [createPipelineOpen, setCreatePipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState('');
  const [stageLabels, setStageLabels] = useState(['']);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [draggingIdx, setDraggingIdx] = useState(null);
  const [dragOverIdx, setDragOverIdx] = useState(null);

  const trimmedName = newPipelineName.trim();
  const namedStages = stageLabels.map((s) => s.trim()).filter(Boolean);
  const nameError = trimmedName.length === 0;
  const stagesError = namedStages.length === 0;
  const showNameError = submitAttempted && nameError;
  const showStagesError = submitAttempted && stagesError;

  const resetCreateForm = () => {
    setNewPipelineName('');
    setStageLabels(['']);
    setSubmitAttempted(false);
    setDraggingIdx(null);
    setDragOverIdx(null);
  };

  const closeCreateModal = () => {
    setCreatePipelineOpen(false);
    resetCreateForm();
  };

  const handleCreatePipeline = (e) => {
    e.preventDefault();
    if (nameError || stagesError) {
      setSubmitAttempted(true);
      return;
    }
    if (pipelines.some((p) => p.label.toLowerCase() === trimmedName.toLowerCase())) {
      toast.error(`A pipeline named "${trimmedName}" already exists.`);
      return;
    }
    dispatch({ type: ACTIONS.ADD_PIPELINE, label: trimmedName, stageLabels: namedStages });
    toast.success(`Pipeline "${trimmedName}" created and saved`);
    resetCreateForm();
    setCreatePipelineOpen(false);
  };

  const updateStageLabel = (idx, value) => {
    setStageLabels((prev) => prev.map((s, i) => (i === idx ? value : s)));
  };

  const addStageRow = () => {
    setStageLabels((prev) => [...prev, '']);
  };

  const removeStageRow = (idx) => {
    setStageLabels((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== idx)));
  };

  const moveStage = (idx, delta) => {
    setStageLabels((prev) => {
      const j = idx + delta;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  };

  const handleStageDragStart = (idx) => setDraggingIdx(idx);
  const handleStageDragOver = (idx) => { if (idx !== dragOverIdx) setDragOverIdx(idx); };
  const handleStageDragEnd = () => { setDraggingIdx(null); setDragOverIdx(null); };
  const handleStageDrop = (targetIdx) => {
    const fromIdx = draggingIdx;
    setDraggingIdx(null);
    setDragOverIdx(null);
    if (fromIdx == null || fromIdx === targetIdx) return;
    setStageLabels((prev) => {
      const next = prev.slice();
      const [moved] = next.splice(fromIdx, 1);
      next.splice(targetIdx, 0, moved);
      return next;
    });
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Pipeline</h1>
          <p className="page-head-subtitle">
            Deals in flight. Drag contacts between stages to advance them.
          </p>
        </div>
        {canEdit && (
          <div className="page-head-actions">
            <button className="btn btn-success" onClick={() => setCreatePipelineOpen(true)}>Add Pipeline</button>
            <button className="btn btn-primary" onClick={() => setManageStagesOpen(true)}>Manage Stages</button>
          </div>
        )}
      </div>
      <PipelineBoard />

      <StageManagerModal open={manageStagesOpen} onClose={() => setManageStagesOpen(false)} />

      <Modal open={createPipelineOpen} onClose={closeCreateModal} title="Create Pipeline">
        <form onSubmit={handleCreatePipeline} noValidate>
          <FormField
            label="Pipeline name"
            value={newPipelineName}
            onChange={(e) => setNewPipelineName(e.target.value)}
            placeholder="e.g. Recruiting, Partnerships"
            autoFocus
            required
            error={showNameError ? 'Pipeline name is required' : undefined}
          />

          <div className={`form-group ${showStagesError ? 'has-error' : ''}`}>
            <label className="form-label">
              Stages <span className="form-required" aria-hidden> *</span>
            </label>
            <div className="stage-list">
              {stageLabels.map((label, i) => (
                <div
                  key={i}
                  className={`stage-row ${draggingIdx === i ? 'is-dragging' : ''} ${dragOverIdx === i && draggingIdx !== i ? 'is-drag-over' : ''}`}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; handleStageDragOver(i); }}
                  onDrop={(e) => { e.preventDefault(); handleStageDrop(i); }}
                >
                  <span
                    className="stage-row-grip"
                    draggable
                    onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); handleStageDragStart(i); }}
                    onDragEnd={handleStageDragEnd}
                    aria-label="Drag to reorder"
                    title="Drag to reorder"
                  >
                    <Icon name="grip" size={16} />
                  </span>
                  <div className="stage-row-order">
                    <button
                      type="button"
                      className="btn-icon-sm"
                      disabled={i === 0}
                      onClick={() => moveStage(i, -1)}
                      aria-label="Move up"
                      title="Move up"
                    >↑</button>
                    <button
                      type="button"
                      className="btn-icon-sm"
                      disabled={i === stageLabels.length - 1}
                      onClick={() => moveStage(i, 1)}
                      aria-label="Move down"
                      title="Move down"
                    >↓</button>
                  </div>
                  <input
                    className="input stage-row-label"
                    type="text"
                    value={label}
                    placeholder={`Stage ${i + 1} name`}
                    onChange={(e) => updateStageLabel(i, e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn-icon-sm stage-row-delete"
                    onClick={() => removeStageRow(i)}
                    disabled={stageLabels.length === 1}
                    aria-label="Remove stage"
                    title={stageLabels.length === 1 ? 'At least one stage is required' : 'Remove stage'}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={addStageRow}
              style={{ marginTop: 8, alignSelf: 'flex-start' }}
            >
              Add stage
            </button>
            {showStagesError && (
              <div className="form-error">Add at least one stage name</div>
            )}
            {!showStagesError && (
              <div className="form-help" style={{ marginTop: 8 }}>
                Won and Lost will be added automatically at the end.
              </div>
            )}
          </div>

          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={closeCreateModal}>Cancel</button>
            <button type="submit" className="btn btn-primary">Create</button>
          </div>
        </form>
      </Modal>
    </>
  );
}
