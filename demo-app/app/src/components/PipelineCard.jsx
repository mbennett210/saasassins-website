import { useStore } from '../store';
import { selectClientById, selectContactById, selectTagById } from '../store/selectors';
import { money, fmtDate } from '../lib/dates';
import TagChip from './TagChip';
import { useT } from '../i18n/react';
import { isWalkthroughStage } from '../lib/walkthrough';

// Single card on the Kanban board. Each card is an OPPORTUNITY (a company-owned
// deal), rendered COMPANY-FIRST: the company name headlines, and the primary
// contact (the person the deal runs through) is the sub-line. Never a person as
// the card. Draggable via native HTML5 DnD.
// Below them, the deal's walkthrough when it has one (lib/walkthrough: its date and time on the
// org's clock), or that it is missing on a deal sitting in "Walkthrough Scheduled".

export default function PipelineCard({
  opportunity,
  onClick,
  onDragStart,
  onDragEnd,
  onDragOver,
  dragging = false,
  selected = false,
  onToggleSelect,
}) {
  const state = useStore();
  const t = useT();
  const company = opportunity.clientId ? selectClientById(state, opportunity.clientId) : null;
  const companyName = company?.name || 'Unknown company';
  // The person the deal runs through: the opportunity's own primary contact, else
  // the company's primary contact. Shown BELOW the company, never as the headline.
  const person = opportunity.primaryContactId
    ? selectContactById(state, opportunity.primaryContactId)
    : (company?.primaryContactId ? selectContactById(state, company.primaryContactId) : null);
  const personName = person ? `${person.firstName || ''} ${person.lastName || ''}`.trim() : '';
  // Tags are company-level, so the chip reflects the company.
  const firstTag = company?.tagIds?.[0] ? selectTagById(state, company.tagIds[0]) : null;

  const headline = companyName;
  const subline = personName || opportunity.title || ' ';

  const walkthrough = opportunity.walkthroughAt
    ? t('walkthrough.card.when', { at: opportunity.walkthroughAt })
    : (isWalkthroughStage(opportunity.stage) ? t('walkthrough.card.notSet') : '');

  const stop = (e) => e.stopPropagation();

  return (
    <div
      className={`pipeline-card${dragging ? ' is-dragging' : ''}${selected ? ' is-selected' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', opportunity.id);
        onDragStart?.(opportunity);
      }}
      onDragEnd={() => onDragEnd?.()}
      onDragOver={onDragOver}
      onClick={() => onClick?.(opportunity)}
      role="button"
      tabIndex={0}
    >
      <div className="pipeline-card-head">
        {onToggleSelect && (
          <input
            type="checkbox"
            className="pipeline-card-check"
            aria-label={`Select ${companyName}`}
            checked={selected}
            onChange={() => onToggleSelect(opportunity.id)}
            onClick={stop}
            onMouseDown={stop}
          />
        )}
        <span className="pipeline-card-name" title={headline}>{headline}</span>
        <span className="pipeline-card-tag-slot">
          {firstTag ? <TagChip tag={firstTag} size="xs" /> : null}
        </span>
      </div>
      <div className="pipeline-card-sub" title={subline}>{subline}</div>
      {walkthrough && (
        <div className={`pipeline-card-walkthrough${opportunity.walkthroughAt ? '' : ' is-missing'}`} title={walkthrough}>{walkthrough}</div>
      )}
      <div className="pipeline-card-meta">
        {opportunity.value ? (
          <span className="pipeline-card-value">{money(opportunity.value)}</span>
        ) : (
          <span className="pipeline-card-value pipeline-card-value-empty">—</span>
        )}
        <span className="text-xs text-muted">
          {opportunity.expectedCloseDate ? `Close ${fmtDate(opportunity.expectedCloseDate)}` : ' '}
        </span>
      </div>
    </div>
  );
}
