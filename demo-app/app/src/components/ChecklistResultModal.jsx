import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import Badge from './Badge';
import { useStore } from '../store';
import { useFromHere } from '../hooks/useFromHere';
import { selectClientById, selectSiteById, selectUserById } from '../store/selectors';
import { fmtDateLong, fmtTime } from '../lib/dates';
import { ITEM_STATE, RESULT_FILTERS, projectChecklistResult, filterResultItems } from '../lib/checklistResultView';
import { listMedia } from '../lib/accountMediaApi';

// A submitted checklist, item by item (CS-552). Quality → Checklists listed one row per
// submission — "25/26", who, when — and nothing anywhere showed WHICH items those were, so
// a manager could not tell a miss from an item that did not apply, or read the note the
// cleaner left on it. This is the reader: the row's own `items` + the `template_snapshot`
// the submission was frozen against, projected by `lib/checklistResultView` (pure, so the
// rule is tested without a DOM) and rendered in the app's standard pop-up, the same pattern
// as an inspection's report (components/InspectionReportModal).
//
// 🔴 IT WRITES NOTHING, and everything about the CHECKLIST is already on the row.
// `checklists/list` is `select('*')` and the route hands the rows over as they are, so the
// structure, the marks and the counts need no fetch. The list is crew-scoped SERVER-side
// (`applyCrewScope(…, 'completed_by_user_id')`), so a crew login can only open a row it was
// already given — there is no second permission to check here, and adding one would only
// hide a record from someone already holding it.
//
// THE ONE FETCH (CS-547) is the PHOTOS, because they are not on the row: a required photo
// is an `account_media` row filed under the submission's own id. It is best-effort and
// lands after the pop-up has rendered, so a slow or failed media read never delays or
// breaks reading the checklist. Until it lands, `photoKeys` is empty — which is the same
// fail-closed default the counter takes, so a photo-required item reads "not done" rather
// than flickering from done to not-done. The row's own STORED counts stay the headline
// either way, exactly as they already were.

// "Not completed" (Matt, 2026-10-13): the cleaner said it could not be done, and why. It
// unlocked their clock-out (it is part of the stored count) but nothing was cleaned, so it is
// its own state here — in "Needs a look" with the reason, under its own chip, and in the
// summary ("9 of 9 resolved · 2 not completed").
const MARK = { [ITEM_STATE.DONE]: '✓', [ITEM_STATE.NA]: 'N/A', [ITEM_STATE.NOT_COMPLETED]: '!', [ITEM_STATE.NOT_DONE]: '✕' };
const SAYS = { [ITEM_STATE.DONE]: 'Done', [ITEM_STATE.NA]: 'N/A', [ITEM_STATE.NOT_COMPLETED]: 'Not completed', [ITEM_STATE.NOT_DONE]: 'Not done' };
// The chips. Their vocabulary AND their order come from the rule module, so the screen and
// the projection can never offer different filters. The accessible name carries "Show …" so
// a control never announces as a bare "Everything" (CS-549's lesson on this feature's
// sibling), and each visible label is contained in it (WCAG 2.5.3 — a voice user can say
// what they read).
const CHIP_TEXT = {
  all: { label: 'Everything', aria: 'Show everything' },
  [ITEM_STATE.NOT_DONE]: { label: 'Only what wasn’t done', aria: 'Show only what wasn’t done' },
  [ITEM_STATE.NOT_COMPLETED]: { label: 'Not completed', aria: 'Show what was marked not completed' },
  [ITEM_STATE.NA]: { label: 'N/A only', aria: 'Show N/A only' },
};
const CHIPS = RESULT_FILTERS.map((key) => ({ key, ...CHIP_TEXT[key] }));
// What to say when a chip's own set is empty — the good news, not a dead screen.
const NOTHING = {
  [ITEM_STATE.NOT_DONE]: 'Every item on this checklist was done.',
  [ITEM_STATE.NOT_COMPLETED]: 'Nothing on this checklist was marked not completed.',
  [ITEM_STATE.NA]: 'Nothing on this checklist was marked N/A.',
};

export default function ChecklistResultModal({ open, result, onClose }) {
  const state = useStore();
  const navigate = useNavigate();
  const nav = useFromHere();
  const [filter, setFilter] = useState('all');
  const [collapsed, setCollapsed] = useState({});
  const bodyRef = useRef(null);
  const openerRef = useRef(null);

  // itemKey → [media], for the per-item strip and for the DONE/NOT-DONE state of a
  // photo-required item. Keyed on the submission's own id (account_media.ref_id).
  const [shots, setShots] = useState({});
  const view = useMemo(
    () => (result ? projectChecklistResult(result, { photoKeys: Object.keys(shots) }) : null),
    [result, shots],
  );
  const resultId = result?.id || null;
  const submitId = result?.client_submit_id || null;
  const siteId = result?.site_id || null;

  useEffect(() => {
    setShots({});
    if (!open || !submitId || !siteId) return undefined;
    let alive = true;
    listMedia({ siteId, refId: submitId, scope: 'checklist' })
      .then((rows) => {
        if (!alive) return;
        const by = {};
        for (const m of rows || []) {
          const key = m?.areaId || m?.area_id;
          if (!key) continue;
          (by[key] = by[key] || []).push(m);
        }
        setShots(by);
      })
      .catch(() => { /* best-effort — the checklist reads fine without its photos */ });
    return () => { alive = false; };
  }, [open, submitId, siteId]);

  // A different result reopens clean: every area expanded and the filter back to
  // Everything, so a manager stepping through a week's cleans is never reading one night
  // through the filter they left on the last one.
  useEffect(() => {
    if (!open) return;
    setFilter('all');
    setCollapsed({});
  }, [open, resultId]);
  // 🔴 REMEMBER THE OPENER FIRST, then move focus — the effects run in declaration order,
  // so capturing after the focus effect below captured the dialog's own body and restored
  // nothing (measured: Esc still landed on <body>). Closing gives focus BACK to the row
  // control that opened the pop-up; `Modal` restores nothing, so Esc otherwise dropped a
  // keyboard reader out of a 20-row table. Guarded on the element still being in the
  // document: "Open the clean" navigates away and takes the whole table with it.
  useEffect(() => {
    if (!open) return undefined;
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    };
  }, [open]);
  // Focus moves into the dialog, onto its scrollable body, so the keyboard starts inside
  // the pop-up rather than on the table behind it. `:focus-visible` means the ring shows
  // for a keyboard open and not for a mouse one (measured both ways, 2026-09-28).
  useEffect(() => {
    if (open && bodyRef.current) bodyRef.current.focus();
  }, [open, resultId]);

  if (!view) return null;

  const customer = result.client_name || (result.client_id ? selectClientById(state, result.client_id)?.name : null) || null;
  const site = result.site_name || (result.site_id ? selectSiteById(state, result.site_id)?.name : null) || null;
  const cleaner = (result.completed_by_user_id ? selectUserById(state, result.completed_by_user_id)?.name : null) || null;
  const where = [customer, site && site !== customer ? site : null].filter(Boolean).join(' · ');
  const when = result.performed_at ? `${fmtDateLong(result.performed_at)} · ${fmtTime(result.performed_at)}` : null;

  // The HEADLINE is the row's OWN counts — what the clock-out gate read and what the table
  // shows — never a number re-derived here. The derived tallies fill in what the headline
  // cannot say ("which of the 26 were N/A"), and if the two ever disagree the pop-up says
  // so in words instead of quietly showing two truths.
  const { stored, counts } = view;
  const pct = stored.total > 0 ? Math.min(100, Math.max(0, Math.round((stored.done / stored.total) * 100))) : 0;
  const breakdown = [
    counts.notCompleted ? `${counts.notCompleted} not completed` : null,
    counts.na ? `${counts.na} marked N/A` : null,
    counts.notDone ? `${counts.notDone} not done` : null,
  ].filter(Boolean).join(' · ');
  // A checklist with a task the cleaner could not do was RESOLVED, not done: the headline says
  // so rather than "9 of 9 done" over two tasks nobody did.
  const headWord = counts.notCompleted ? 'resolved' : 'done';

  const shown = filterResultItems(view.items, filter);
  const showing = new Set(shown.map((i) => i.key));
  const openClean = () => { const jobId = result.job_id; onClose?.(); navigate(`/schedule/${jobId}`, { state: nav }); };

  return (
    <Modal open={open} onClose={onClose} title={view.name} size="lg">
      {/* ONE scroll region holding everything but the actions, and it takes focus when the
          pop-up opens: the keyboard then starts at the TOP of the dialog and tabs forward
          through the chips, the areas and the actions in reading order (`Modal` closes on
          Esc but moves no focus of its own). Focusable for that reason, and so the arrow
          keys scroll what focus landed on — the same shape InspectionReportModal uses. */}
      <div className="cr-body" ref={bodyRef} tabIndex={-1}>
        <p className="cr-meta">
          {where && <span>{where}</span>}
          {cleaner && <span>Completed by {cleaner}</span>}
          {when && <span>{when}</span>}
        </p>

        <div className="cr-sum">
          {!view.complete && <Badge variant="red">Not finished</Badge>}
          <strong>{stored.done} of {stored.total} {headWord}</strong>
          {breakdown && <span className="text-muted text-sm">{breakdown}</span>}
          {/* The numbers are already in words beside it, so the bar is decoration. */}
          <span className="cr-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
        </div>

        {view.countsDisagree && (
          <p className="cr-note-disagree text-sm">
            Recorded as {stored.done} of {stored.total} when it was submitted; the items below add up
            to {counts.done} of {counts.total}.
          </p>
        )}

        {!view.hasSchema && (
          <p className="callout callout-info text-sm cr-nosnapshot">
            The checklist’s structure wasn’t recorded with this result, so the items are shown exactly as they
            were submitted.
          </p>
        )}

        {/* The exceptions FIRST: a manager opens this to find what needs a look, not to read
            26 ticks. Not done, marked N/A, or carrying a note — and the block is absent, not
            empty, when there is nothing. */}
        {view.exceptions.length > 0 && (
          <div className="cr-flags">
            <h3 className="cr-flags-head">Needs a look ({view.exceptions.length})</h3>
            <ul className="cr-flags-list">
              {view.exceptions.map((i) => (
                <li key={i.key}>
                  <strong>{SAYS[i.state]}</strong>
                  {i.area ? ` · ${i.area}: ` : ' · '}{i.label}
                  {i.state === ITEM_STATE.NOT_COMPLETED && i.reason && <span className="cr-reason">— {i.reason}</span>}
                  {i.note && <span className="cr-note">“{i.note}”</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="cr-filter" role="group" aria-label="Show which items">
          {CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`chip cr-chip ${filter === c.key ? 'on' : ''}`}
              aria-pressed={filter === c.key}
              aria-label={c.aria}
              onClick={() => setFilter(c.key)}
            >
              {c.label}
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <p className="text-muted text-sm cr-empty">{NOTHING[filter] || 'This checklist has no items.'}</p>
        ) : (
          view.areas.map((a) => {
            const items = a.items.filter((i) => showing.has(i.key));
            if (!items.length) return null;
            const listId = `cr-area-${a.id}`;
            const isClosed = !!collapsed[a.id];
            const count = `${a.done}/${a.total}${a.notCompleted ? ` · ${a.notCompleted} not completed` : ''}${a.na ? ` · ${a.na} N/A` : ''}`;
            return (
              <div className="cr-area" key={a.id}>
                {/* An area with no label is the no-schema fallback's single bucket: there is
                    nothing to name and nothing to collapse it by, so the list stands on its
                    own rather than under an invented heading. */}
                {a.label && (
                  <button
                    type="button"
                    className="cr-area-head"
                    aria-expanded={!isClosed}
                    aria-controls={listId}
                    onClick={() => setCollapsed((p) => ({ ...p, [a.id]: !p[a.id] }))}
                  >
                    <span className="cr-area-name">{a.label}</span>
                    <span className="cr-area-count">{count}</span>
                  </button>
                )}
                <ul className="cr-items" id={listId} hidden={a.label ? isClosed : false}>
                  {items.map((i) => (
                    <li className={`cr-item ${i.state}`} key={i.key}>
                      {/* The mark is decoration — the state is spelled out in words in the
                          row's own `.cr-state`, so nothing here depends on reading a glyph
                          or on telling green from red. */}
                      <span className={`cr-ico ${i.state}`} aria-hidden="true">{MARK[i.state]}</span>
                      <span className="cr-label">
                        {i.label}
                        {i.state === ITEM_STATE.NOT_COMPLETED && i.reason && <span className="cr-reason">Not completed — {i.reason}</span>}
                        {i.note && <span className="cr-note">“{i.note}”</span>}
                        {/* CS-547 — the proof the office asked for, under the item it
                            belongs to. A marked item with nothing attached says so in
                            words beside its "Not done", because "not done" alone sends a
                            manager chasing a clean that may well have happened. */}
                        {i.needsPhoto && (shots[i.key]?.length
                          ? (
                            <span className="cr-shots">
                              {shots[i.key].map((m) => (
                                <a key={m.id} className="cr-shot" href={m.url || undefined} target="_blank" rel="noreferrer">
                                  <img src={m.thumbUrl || m.url} alt={`Photo for ${i.label}`} loading="lazy" />
                                </a>
                              ))}
                            </span>
                          )
                          : <span className="cr-note">Photo required — none attached</span>
                        )}
                      </span>
                      <span className="cr-state">{SAYS[i.state]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </div>

      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>Close</button>
        {/* Only when the submission is bound to a clean — the office flow (Quality hub →
            New checklist) writes no job_id, and every row in production today has none. */}
        {result.job_id && (
          <button type="button" className="btn btn-primary" onClick={openClean}>Open the clean</button>
        )}
      </div>
    </Modal>
  );
}
