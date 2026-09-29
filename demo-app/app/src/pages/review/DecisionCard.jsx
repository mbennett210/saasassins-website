import { useMemo, useState } from 'react';
import { useDecisionReview } from '../../store/ClientReviewProvider';
import { DECISION_SECTION_BY_ID } from '../../data/buildDecisions';
import { newSitting } from '../../lib/clientReview';
import { useSyncedText } from '../../hooks/useSyncedText';
import ConfirmDialog from '../../components/ConfirmDialog';
import ReviewNotes from './ReviewNotes';
import Badge from '../../components/Badge';
import { fmtDate } from '../../lib/dates';

// One build-decision in the focus flow. A single question is native radios, a multi is
// native checkboxes (choice is an array), a text question is a saved-on-blur textarea. The
// recommended option(s) are tagged and, while unanswered, drawn as a dashed-gold "suggested"
// row; the chosen row gets a gold-soft fill.
//
// ADDITIVE (CS-402, §130): an answer given in an EARLIER sitting is LOCKED — the inputs are
// disabled and the status row offers "Change answer" behind a ConfirmDialog. Confirming
// unlocks the card for THIS sitting (a fresh id created on mount); the first save then carries
// `confirm: true`, and the reducer keeps the prior answer in history. A misclick fix within
// the same visit needs no confirm. Notes are add-only (never an answer).
export default function DecisionCard({ question: q }) {
  // One sitting per card mount (one uninterrupted edit visit for this item).
  const sitting = useMemo(() => newSitting(), []);
  const rev = useDecisionReview(q.id, sitting);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const section = DECISION_SECTION_BY_ID[q.sectionId];
  const isMulti = q.type === 'multi';
  const isText = q.type === 'text';
  const answered = rev.answered;
  const editable = !rev.locked || confirmed;

  // Save the free-text answer through useSyncedText (remote-edit safe, unmount flush); every
  // save carries the current confirm flag so a confirmed change appends history.
  const answerField = useSyncedText(rev.text, (t) => rev.setText(t, { confirm: confirmed }));

  const recIds = isText ? [] : (q.options || []).filter((o) => o.rec).map((o) => o.id);
  const hasRec = recIds.length > 0;

  const selected = isMulti ? (Array.isArray(rev.choice) ? rev.choice : []) : rev.choice;
  const isSel = (id) => (isMulti ? selected.includes(id) : selected === id);
  const toggle = (id) => {
    if (!editable) return;
    if (isMulti) rev.setChoice(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id], { confirm: confirmed });
    else rev.setChoice(id, { confirm: confirmed });
  };

  // Render a stored choice/text (for the history list) as a readable label.
  const labelForChoice = (val) => {
    const ids = Array.isArray(val) ? val : (val != null && val !== '' ? [val] : []);
    if (!ids.length) return 'cleared';
    return ids.map((id) => { const o = (q.options || []).find((x) => x.id === id); return o ? o.label : id; }).join(', ');
  };
  const labelForHistory = (h) => (isText ? (h.text || 'cleared') : labelForChoice(h.choice));

  return (
    <div className="review-card">
      <div className="review-meta">
        <span className="review-meta-id">{q.id} · {section?.title}</span>
        {rev.isNew && <span className="review-badge-new">New</span>}
        {q.key && <Badge variant="purple">Key decision</Badge>}
        {answered
          ? <Badge variant="green">Answered</Badge>
          : q.needs
            ? <Badge variant="amber">Needs your answer</Badge>
            : <Badge variant="slate">Unanswered</Badge>}
      </div>

      <div className="review-q">{q.q}</div>
      {q.why && <p className="review-why">{q.why}</p>}

      {isText ? (
        <textarea
          className="input textarea-md review-answer"
          key={q.id}
          placeholder="Type your answer (saved for everyone)"
          disabled={!editable}
          {...answerField}
        />
      ) : (
        <>
          {isMulti && <p className="review-multi-hint">Pick any that apply.</p>}
          <div className="review-opts" role={isMulti ? 'group' : 'radiogroup'}>
            {q.options.map((o) => {
              const sel = isSel(o.id);
              const suggest = !answered && o.rec;
              return (
                <label key={o.id} className={`review-opt${sel ? ' sel' : ''}${suggest ? ' suggest' : ''}${!editable ? ' is-locked' : ''}`}>
                  <input
                    type={isMulti ? 'checkbox' : 'radio'}
                    name={`decision-${q.id}`}
                    checked={sel}
                    disabled={!editable}
                    onChange={() => toggle(o.id)}
                  />
                  <span className="review-opt-body">
                    <span className="review-opt-head">
                      <span className="review-opt-label">({o.id}) {o.label}</span>
                      {o.rec && <span className="review-opt-rec">★ Recommended</span>}
                      {o.needsNote && <span className="review-opt-note-hint">(add details in a note)</span>}
                    </span>
                    {o.detail && <span className="review-opt-detail">{o.detail}</span>}
                  </span>
                </label>
              );
            })}
          </div>
        </>
      )}

      {/* The unanswered message and the answered message (+ an inline Clear/Change action) are
          BOTH rendered, stacked in one grid cell, the inactive one visibility:hidden. The row
          is then as tall as the taller state AT EVERY WIDTH (no magic min-height), so the
          footer nav never moves when the item flips answered ↔ unanswered and a Next click
          can't miss — even where a message wraps to 3 lines at a narrow window (§130). Within
          the answered state the inline action is "Clear answer" when editable, or "Change
          answer" when locked (answered in an earlier sitting) — same box, same height. */}
      <div className="review-status">
        <span className="review-status-state" data-hidden={answered ? 'true' : undefined} aria-hidden={answered ? 'true' : undefined}>
          {isText
            ? 'This one needs an answer.'
            : hasRec
              ? <>Not answered yet. The dashed option{recIds.length > 1 ? 's are' : ' is'} our recommendation: click {recIds.length > 1 ? 'them' : 'it'} to accept, or pick another.</>
              : 'No default: this one needs an answer.'}
        </span>
        <span className="review-status-state review-status-answered" data-hidden={answered ? undefined : 'true'} aria-hidden={answered ? undefined : 'true'}>
          <span className="review-status-saved">Answered {fmtDate(rev.at)}</span>
          {editable
            ? <button type="button" className="btn btn-link review-status-clear" onClick={() => rev.clear({ confirm: confirmed })}>Clear answer</button>
            : <button type="button" className="btn btn-link review-status-change" onClick={() => setConfirmOpen(true)}>Change answer</button>}
        </span>
      </div>

      {rev.history.length > 0 && (
        <details className="review-history">
          <summary>Earlier answers ({rev.history.length})</summary>
          <ul>
            {rev.history.map((h, i) => (
              <li key={i}><span className="review-history-val">{labelForHistory(h)}</span> <span className="review-history-at">{fmtDate(h.at)}</span></li>
            ))}
          </ul>
        </details>
      )}

      {!isText && <ReviewNotes entry={rev.entry} onAdd={rev.addNote} placeholder={q.noteHint || 'Add a note (saved for everyone)'} />}

      <ConfirmDialog
        open={confirmOpen}
        title="Change this answer?"
        message={`It was answered on ${fmtDate(rev.at)}. The earlier answer stays listed under the question.`}
        confirmLabel="Change answer"
        onConfirm={() => setConfirmed(true)}
        onClose={() => setConfirmOpen(false)}
      />
    </div>
  );
}
