import { useStore } from '../store';
import { selectClientById, selectTagById } from '../store/selectors';
import { money, fmtDate } from '../lib/dates';
import TagChip from './TagChip';

// Single card in the Kanban board. Draggable via native HTML5 DnD.
// Every row is always rendered (placeholder when empty) so every card has the same footprint.

export default function PipelineCard({
  contact,
  onClick,
  onDragStart,
  onDragEnd,
  onDragOver,
  dragging = false,
  selected = false,
  onToggleSelect,
}) {
  const state = useStore();
  const company = contact.companyId ? selectClientById(state, contact.companyId) : null;
  const companyName = company?.name || contact.customFields?.company || '—';
  const firstTag = contact.tagIds?.[0] ? selectTagById(state, contact.tagIds[0]) : null;

  const stop = (e) => e.stopPropagation();

  return (
    <div
      className={`pipeline-card${dragging ? ' is-dragging' : ''}${selected ? ' is-selected' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', contact.id);
        onDragStart?.(contact);
      }}
      onDragEnd={() => onDragEnd?.()}
      onDragOver={onDragOver}
      onClick={() => onClick?.(contact)}
      role="button"
      tabIndex={0}
    >
      <div className="pipeline-card-head">
        {onToggleSelect && (
          <input
            type="checkbox"
            className="pipeline-card-check"
            aria-label={`Select ${contact.firstName} ${contact.lastName}`}
            checked={selected}
            onChange={() => onToggleSelect(contact.id)}
            onClick={stop}
            onMouseDown={stop}
          />
        )}
        <span className="pipeline-card-name" title={`${contact.firstName} ${contact.lastName}`}>
          {contact.firstName} {contact.lastName}
        </span>
        <span className="pipeline-card-tag-slot">
          {firstTag ? <TagChip tag={firstTag} size="xs" /> : null}
        </span>
      </div>
      <div className="pipeline-card-sub" title={companyName}>{companyName}</div>
      <div className="pipeline-card-meta">
        {contact.dealValue ? (
          <span className="pipeline-card-value">{money(contact.dealValue)}</span>
        ) : (
          <span className="pipeline-card-value pipeline-card-value-empty">—</span>
        )}
        <span className="text-xs text-muted">
          {contact.expectedCloseDate ? `Close ${fmtDate(contact.expectedCloseDate)}` : '\u00A0'}
        </span>
      </div>
    </div>
  );
}
