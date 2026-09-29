import { useEffect, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import Icon from './Icon';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectPipelines, selectActivePipeline, selectActivePipelineStages, selectPipelineOpportunities } from '../store/selectors';
import { useToast } from './Toast';

function StageRow({ stage, count, index, total, onRename, onMove, onDelete, onDragStart, onDragOver, onDrop, onDragEnd, isDragging, isDragOver }) {
  const [label, setLabel] = useState(stage.label);

  useEffect(() => { setLabel(stage.label); }, [stage.label]);

  const commit = () => {
    const trimmed = label.trim();
    if (!trimmed || trimmed === stage.label) { setLabel(stage.label); return; }
    onRename(stage.id, trimmed);
  };

  const blockDelete = count > 0;

  return (
    <div
      className={`stage-row ${isDragging ? 'is-dragging' : ''} ${isDragOver ? 'is-drag-over' : ''}`}
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; onDragOver(stage.id); }}
      onDrop={(e) => { e.preventDefault(); onDrop(stage.id); }}
    >
      <span
        className="stage-row-grip"
        draggable
        onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; onDragStart(stage.id); }}
        onDragEnd={onDragEnd}
        aria-label="Drag to reorder"
        title="Drag to reorder"
      >
        <Icon name="grip" size={16} />
      </span>
      <div className="stage-row-order">
        <button
          className="btn-icon"
          disabled={index === 0}
          onClick={() => onMove(stage.id, -1)}
          aria-label="Move up"
          title="Move up"
        >↑</button>
        <button
          className="btn-icon"
          disabled={index === total - 1}
          onClick={() => onMove(stage.id, 1)}
          aria-label="Move down"
          title="Move down"
        >↓</button>
      </div>
      <input
        className="input stage-row-label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setLabel(stage.label); e.currentTarget.blur(); } }}
      />
      <span className="stage-row-count text-xs text-muted">
        {count} deal{count === 1 ? '' : 's'}
      </span>
      <button
        className="btn-icon btn-icon-danger"
        disabled={blockDelete}
        onClick={() => onDelete(stage)}
        aria-label="Delete stage"
        title={blockDelete ? `Move the ${count} deal${count === 1 ? '' : 's'} out of this stage first` : 'Delete stage'}
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
}

export default function StageManagerModal({ open, onClose }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const pipelines = selectPipelines(state);
  const pipeline = selectActivePipeline(state);
  const stages = selectActivePipelineStages(state);
  const opps = selectPipelineOpportunities(state);
  const countAt = (key) => opps.filter((o) => o.stage === key).length;
  const pipelineId = pipeline?.id;
  const pipelineLabel = pipeline?.label || '';
  const isMaster = !!pipeline?.isMaster;
  const dealsOnPipeline = opps.length;

  const [nameDraft, setNameDraft] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [draggingId, setDraggingId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => { setNameDraft(pipelineLabel); }, [pipelineLabel, open]);

  useEffect(() => {
    if (!open) {
      setNewLabel('');
      setDraggingId(null);
      setDragOverId(null);
      setHasChanges(false);
    }
  }, [open]);

  // The name is a draft committed by the Save button (unlike stage rows, which
  // live-commit on blur) — typing immediately surfaces the save bar.
  const trimmedName = nameDraft.trim();
  const nameDirty = trimmedName !== pipelineLabel;
  const showSave = hasChanges || nameDirty;

  const rename = (id, label) => {
    dispatch({ type: ACTIONS.UPDATE_PIPELINE_STAGE, pipelineId, id, patch: { label } });
    setHasChanges(true);
  };

  const move = (id, delta) => {
    const i = stages.findIndex((s) => s.id === id);
    if (i < 0) return;
    const j = i + delta;
    if (j < 0 || j >= stages.length) return;
    const next = stages.slice();
    [next[i], next[j]] = [next[j], next[i]];
    dispatch({ type: ACTIONS.REORDER_PIPELINE_STAGES, pipelineId, ids: next.map((s) => s.id) });
    setHasChanges(true);
  };

  const remove = (stage) => {
    const count = countAt(stage.key);
    if (count > 0) {
      toast.error(`"${stage.label}" has ${count} deal${count === 1 ? '' : 's'}. Move them out first.`);
      return;
    }
    dispatch({ type: ACTIONS.DELETE_PIPELINE_STAGE, pipelineId, id: stage.id });
    setHasChanges(true);
  };

  const add = (e) => {
    e.preventDefault();
    const label = newLabel.trim();
    if (!label) return;
    if (stages.some((s) => s.label.toLowerCase() === label.toLowerCase())) {
      toast.error(`A stage named "${label}" already exists.`);
      return;
    }
    dispatch({ type: ACTIONS.ADD_PIPELINE_STAGE, pipelineId, label });
    setNewLabel('');
    setHasChanges(true);
  };

  const handleDragStart = (id) => setDraggingId(id);
  const handleDragOver = (id) => { if (id !== dragOverId) setDragOverId(id); };
  const handleDragEnd = () => { setDraggingId(null); setDragOverId(null); };
  const handleDrop = (targetId) => {
    if (!draggingId || draggingId === targetId) {
      setDraggingId(null);
      setDragOverId(null);
      return;
    }
    const ids = stages.map((s) => s.id);
    const fromIdx = ids.indexOf(draggingId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx < 0 || toIdx < 0) {
      setDraggingId(null);
      setDragOverId(null);
      return;
    }
    const next = ids.slice();
    next.splice(fromIdx, 1);
    next.splice(toIdx, 0, draggingId);
    dispatch({ type: ACTIONS.REORDER_PIPELINE_STAGES, pipelineId, ids: next });
    setHasChanges(true);
    setDraggingId(null);
    setDragOverId(null);
  };

  const deletePipeline = () => {
    if (isMaster) return;
    if (dealsOnPipeline > 0) {
      toast.error(`Move or delete the ${dealsOnPipeline} deal${dealsOnPipeline === 1 ? '' : 's'} on this pipeline first.`);
      return;
    }
    if (!window.confirm(`Delete the "${pipelineLabel}" pipeline? This cannot be undone.`)) return;
    dispatch({ type: ACTIONS.DELETE_PIPELINE, id: pipelineId });
    toast.success(`Pipeline "${pipelineLabel}" deleted`);
    onClose();
  };

  const handleSave = () => {
    if (nameDirty) {
      if (!trimmedName) {
        toast.error('Pipeline name is required.');
        return;
      }
      if (pipelines.some((p) => p.id !== pipelineId && p.label.toLowerCase() === trimmedName.toLowerCase())) {
        toast.error(`A pipeline named "${trimmedName}" already exists.`);
        return;
      }
      dispatch({ type: ACTIONS.UPDATE_PIPELINE, id: pipelineId, patch: { label: trimmedName } });
    }
    toast.success('Pipeline saved');
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={`Edit Pipeline. ${pipelineLabel || 'Pipeline'}`}>
      <p className="text-sm text-muted" style={{ marginTop: 0, marginBottom: 12 }}>
        Rename the pipeline or its stages, reorder, add, or delete stages. Delete is blocked while a stage has contacts in it.
      </p>
      <FormField
        label="Pipeline name"
        value={nameDraft}
        onChange={(e) => setNameDraft(e.target.value)}
        disabled={isMaster}
        help={isMaster ? 'The Master Pipeline is the default board and cannot be renamed or deleted.' : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
          if (e.key === 'Escape') setNameDraft(pipelineLabel);
        }}
      />
      <label className="form-label">Stages</label>
      <div className="stage-list">
        {stages.map((stage, i) => (
          <StageRow
            key={stage.id}
            stage={stage}
            index={i}
            total={stages.length}
            count={countAt(stage.key)}
            onRename={rename}
            onMove={move}
            onDelete={remove}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onDragEnd={handleDragEnd}
            isDragging={draggingId === stage.id}
            isDragOver={dragOverId === stage.id && draggingId !== stage.id}
          />
        ))}
      </div>

      <form onSubmit={add} className="stage-add">
        <FormField
          label=""
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="New stage name (e.g. Negotiating)"
        />
        <button type="submit" className="btn btn-primary" disabled={!newLabel.trim()}>Add Stage</button>
      </form>

      <div className={`stage-save-bar has-split ${showSave || !isMaster ? 'is-visible' : ''}`}>
        {!isMaster ? (
          <button type="button" className="btn btn-danger" onClick={deletePipeline}>
            Delete pipeline
          </button>
        ) : <span />}
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!showSave}>Save changes</button>
      </div>
    </Modal>
  );
}
