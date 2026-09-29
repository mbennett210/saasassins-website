import { useMemo, useRef, useState } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectPipelineOpportunities,
  selectActivePipelineStages,
  selectPipelines,
  selectActivePipeline,
  selectOpenOpportunityValue,
} from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { money } from '../lib/dates';
import PipelineCard from './PipelineCard';
import FormField from './FormField';
import AddContactsToStageModal from './AddContactsToStageModal';
import OpportunityDetailModal from './OpportunityDetailModal';

const EDGE_ZONE = 80;
const MAX_SPEED = 18;
const MIN_SPEED = 3;

// The sales board. One pipeline, real stages as columns, and each card is an
// OPPORTUNITY (a company-owned deal) rendered company-first. Drag a card between
// columns to change its stage. No people on this board, ever.
export default function PipelineBoard() {
  const state = useStore();
  const dispatch = useDispatch();
  const canEdit = usePermission('pipeline.edit');

  const pipelines = selectPipelines(state);
  const activePipeline = selectActivePipeline(state);
  const columns = selectActivePipelineStages(state);        // the board's real stages
  const opportunities = selectPipelineOpportunities(state);  // the cards (deals)
  const openValue = selectOpenOpportunityValue(state);

  const [dropTarget, setDropTarget] = useState(null);
  const [draggingId, setDraggingId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [addStage, setAddStage] = useState(null);
  const [detailOpp, setDetailOpp] = useState(null);

  const boardRef = useRef(null);
  const scrollRafRef = useRef(null);
  const scrollVelocityRef = useRef(0);

  const byColumn = useMemo(() => {
    const map = Object.fromEntries(columns.map((col) => [col.key, []]));
    opportunities.forEach((o) => { if (map[o.stage]) map[o.stage].push(o); });
    return map;
  }, [opportunities, columns]);

  const visibleIds = useMemo(() => {
    const out = new Set();
    columns.forEach((col) => (byColumn[col.key] || []).forEach((o) => out.add(o.id)));
    return out;
  }, [byColumn, columns]);

  const effectiveSelected = useMemo(() => {
    const out = new Set();
    selectedIds.forEach((id) => { if (visibleIds.has(id)) out.add(id); });
    return out;
  }, [selectedIds, visibleIds]);

  const toggleSelect = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleSelectColumn = (columnKey) => {
    const cards = byColumn[columnKey] || [];
    const allChecked = cards.length > 0 && cards.every((o) => effectiveSelected.has(o.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allChecked) cards.forEach((o) => next.delete(o.id));
      else cards.forEach((o) => next.add(o.id));
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  const bulkMoveToColumn = (columnKey) => {
    if (!columnKey || !canEdit) return;
    [...effectiveSelected].forEach((id) => {
      dispatch({ type: ACTIONS.SET_OPPORTUNITY_STAGE, id, stage: columnKey, pipelineId: activePipeline?.id });
    });
    clearSelection();
  };

  const bulkDelete = () => {
    if (!canEdit) return;
    effectiveSelected.forEach((id) => dispatch({ type: ACTIONS.DELETE_OPPORTUNITY, id }));
    clearSelection();
  };

  const slotActive = (columnKey, i) =>
    dropTarget && dropTarget.stage === columnKey && dropTarget.index === i;

  // --- Auto-scroll while dragging near the board edges ---
  const updateAutoScroll = (clientX) => {
    const el = boardRef.current;
    if (!el) { scrollVelocityRef.current = 0; return; }
    const rect = el.getBoundingClientRect();
    const leftDist = clientX - rect.left;
    const rightDist = rect.right - clientX;
    if (leftDist < EDGE_ZONE && el.scrollLeft > 0) {
      const ratio = 1 - (leftDist / EDGE_ZONE);
      scrollVelocityRef.current = -(MIN_SPEED + ratio * (MAX_SPEED - MIN_SPEED));
    } else if (rightDist < EDGE_ZONE && el.scrollLeft < el.scrollWidth - el.clientWidth) {
      const ratio = 1 - (rightDist / EDGE_ZONE);
      scrollVelocityRef.current = MIN_SPEED + ratio * (MAX_SPEED - MIN_SPEED);
    } else {
      scrollVelocityRef.current = 0;
    }
  };

  const startScrollLoop = () => {
    if (scrollRafRef.current) return;
    const tick = () => {
      const el = boardRef.current;
      if (el && scrollVelocityRef.current !== 0) el.scrollLeft += scrollVelocityRef.current;
      scrollRafRef.current = requestAnimationFrame(tick);
    };
    scrollRafRef.current = requestAnimationFrame(tick);
  };

  const stopScrollLoop = () => {
    if (scrollRafRef.current) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    scrollVelocityRef.current = 0;
  };

  const clearDrag = () => {
    setDropTarget(null);
    setDraggingId(null);
    stopScrollLoop();
  };

  const onCardDragOver = (e, columnKey, cardIndex) => {
    if (!canEdit) return;
    e.preventDefault();
    e.stopPropagation();
    updateAutoScroll(e.clientX);
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    const index = before ? cardIndex : cardIndex + 1;
    setDropTarget((prev) => (prev && prev.stage === columnKey && prev.index === index ? prev : { stage: columnKey, index }));
  };

  const onColDragOver = (e, columnKey) => {
    if (!canEdit) return;
    e.preventDefault();
    updateAutoScroll(e.clientX);
    const endIndex = (byColumn[columnKey] || []).length;
    setDropTarget((prev) => (prev && prev.stage === columnKey && prev.index === endIndex ? prev : { stage: columnKey, index: endIndex }));
  };

  const onColDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget((prev) => (prev ? null : prev));
  };

  const handleDrop = (e, columnKey) => {
    e.preventDefault();
    const id = e.dataTransfer.getData('text/plain');
    const target = dropTarget;
    clearDrag();
    if (!canEdit || !id) return;
    const current = opportunities.find((o) => o.id === id);
    if (!current) return;
    const stageCards = (byColumn[columnKey] || []).filter((o) => o.id !== id);
    const targetIndex = target && target.stage === columnKey ? target.index : stageCards.length;
    const insertBeforeId = targetIndex < stageCards.length ? stageCards[targetIndex].id : null;
    if (current.stage === columnKey) {
      const originalIdx = (byColumn[columnKey] || []).findIndex((o) => o.id === id);
      if (originalIdx === targetIndex || originalIdx === targetIndex - 1) return;
    }
    dispatch({ type: ACTIONS.SET_OPPORTUNITY_STAGE, id, stage: columnKey, pipelineId: activePipeline?.id, insertBeforeId });
  };

  const selectionCount = effectiveSelected.size;

  return (
    <div className="pipeline-wrap">
      <div className="pipeline-toolbar">
        <FormField
          label="Pipeline"
          as="select"
          value={activePipeline?.id || ''}
          onChange={(e) => dispatch({ type: ACTIONS.SET_ACTIVE_PIPELINE, id: e.target.value })}
          options={pipelines.map((p) => ({ value: p.id, label: p.label }))}
        />
        <div className="pipeline-total" style={{ marginLeft: 'auto', textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 2, alignSelf: 'flex-start' }}>
          <span className="text-xs text-muted" style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Total opportunity value
          </span>
          <span style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
            {money(openValue)}
          </span>
        </div>
      </div>

      {selectionCount > 0 && (
        <div className="bulk-bar">
          <span className="text-sm font-semi">{selectionCount} selected</span>
          {canEdit && (
            <FormField
              label=""
              as="select"
              value=""
              onChange={(e) => bulkMoveToColumn(e.target.value)}
              options={[
                { value: '', label: 'Move to stage…' },
                ...columns.map((col) => ({ value: col.key, label: col.label })),
              ]}
            />
          )}
          {canEdit && <button className="btn btn-danger" onClick={bulkDelete}>Delete</button>}
          <button className="btn btn-outline" onClick={clearSelection}>Cancel</button>
        </div>
      )}

      <AddContactsToStageModal
        open={!!addStage}
        onClose={() => setAddStage(null)}
        pipelineId={addStage?.pipelineId}
        stageKey={addStage?.stage}
        stageLabel={addStage?.label || ''}
      />

      <div
        className="pipeline-board"
        ref={boardRef}
        style={{ '--pipeline-col-count': columns.length || 1 }}
        onDragOver={(e) => { e.preventDefault(); updateAutoScroll(e.clientX); }}
        onDragEnter={() => startScrollLoop()}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) stopScrollLoop(); }}
      >
        {columns.map((column) => {
          const isDropTargetCol = dropTarget?.stage === column.key;
          const cards = byColumn[column.key] || [];
          const sumValue = cards.reduce((acc, o) => acc + (Number(o.value) || 0), 0);
          const colSelectedCount = cards.filter((o) => effectiveSelected.has(o.id)).length;
          const allSelected = cards.length > 0 && colSelectedCount === cards.length;
          const someSelected = colSelectedCount > 0 && !allSelected;
          return (
            <div
              key={column.key}
              className={`pipeline-col ${isDropTargetCol ? 'drag-over' : ''} stage-${column.key}`}
              onDragOver={(e) => onColDragOver(e, column.key)}
              onDragLeave={onColDragLeave}
              onDrop={(e) => handleDrop(e, column.key)}
            >
              <div className="pipeline-col-head">
                <div className="pipeline-col-title">
                  {cards.length > 0 && (
                    <input
                      type="checkbox"
                      className="pipeline-col-check"
                      aria-label={`Select all in ${column.label}`}
                      checked={allSelected}
                      ref={(el) => { if (el) el.indeterminate = someSelected; }}
                      onChange={() => toggleSelectColumn(column.key)}
                    />
                  )}
                  <span className="pipeline-col-label">{column.label}</span>
                </div>
                <div className="pipeline-col-meta">
                  <span className="pipeline-col-count">{cards.length}</span>
                  <span className="pipeline-col-sum">{money(sumValue)}</span>
                </div>
              </div>
              <div className="pipeline-col-body">
                {cards.length === 0 && !slotActive(column.key, 0) && (
                  canEdit ? (
                    <button
                      type="button"
                      className="add-tile"
                      onClick={() => setAddStage({ pipelineId: activePipeline?.id, stage: column.key, label: column.label })}
                    >
                      Add deal
                    </button>
                  ) : (
                    <div className="pipeline-col-empty"><span className="text-xs text-muted">No deals</span></div>
                  )
                )}
                {cards.length === 0 && slotActive(column.key, 0) && (
                  <div className="pipeline-drop-slot" aria-hidden="true" />
                )}
                {cards.map((o, i) => (
                  <div key={o.id} className="pipeline-card-wrap">
                    {slotActive(column.key, i) && <div className="pipeline-drop-slot" aria-hidden="true" />}
                    <PipelineCard
                      opportunity={o}
                      dragging={draggingId === o.id}
                      selected={effectiveSelected.has(o.id)}
                      onToggleSelect={toggleSelect}
                      onClick={(opp) => setDetailOpp(opp)}
                      onDragStart={(opp) => setDraggingId(opp.id)}
                      onDragEnd={clearDrag}
                      onDragOver={(e) => onCardDragOver(e, column.key, i)}
                    />
                    {i === cards.length - 1 && slotActive(column.key, cards.length) && (
                      <div className="pipeline-drop-slot" aria-hidden="true" />
                    )}
                  </div>
                ))}
                {canEdit && cards.length > 0 && (
                  <button
                    type="button"
                    className="add-tile"
                    onClick={() => setAddStage({ pipelineId: activePipeline?.id, stage: column.key, label: column.label })}
                  >
                    Add deal
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <OpportunityDetailModal
        open={!!detailOpp}
        onClose={() => setDetailOpp(null)}
        opportunity={detailOpp}
      />
    </div>
  );
}
