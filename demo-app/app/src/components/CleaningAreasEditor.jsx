import { useId, useState } from 'react';
import { newId } from '../lib/ids';
import { standardAreaChoices, addStandardAreas, pendingStandardAreas } from '../lib/standardAreas';
import { useT } from '../i18n/react';
import Icon from './Icon';

// Editor for a site's ordered cleaning areas: each = a label + per-area
// instructions (media attaches later). value = [{ id, label, instructions,
// mediaRefs }]; onChange(next). Controlled. Crew see these read-only on their
// schedule. See CLEANSPACE_SWEPT.md §5.3.
//
// QR-1: `status` is optional and READ-ONLY-mode only — { [areaId]: { lastCleanedAt,
// photo } } from `qcApi.areaStatus`, the same answer the QR code on that area's wall will
// give (Round 2). Absent = the card simply doesn't say, which is what every existing
// caller gets. `fmtWhen` is injected so this component keeps no date dependency of its
// own and the org's zone is applied by the caller that has it.
//
// QR-8 (Matt, 2026-10-16: "tick from a list … and add your own"): the edit mode lists the standard
// areas (lib/standardAreas — ONE list, in his order) as tick boxes under the areas. One the location
// already has is ticked, switched off and says "Added" (matched without case or extra spaces); the
// ticked ones go in with ONE onChange through `addStandardAreas`, each a new area of the shape "Add
// your own" makes, its id minted once. The names stay English as written: the labels print them and
// the public reads them (LANG-8). Every word this editor shows is a catalog line (UI_RULES §140).
//
// `picked` / `onPickedChange`: the ticks can be held by the caller. CleaningInstructionsCard holds them,
// so its Save Changes adds the ticked areas too and the QR codes page asks before a pop-up closes on
// one (UI_RULES §183): ticked, then Save Changes, used to save nothing under an "updated" toast.
export default function CleaningAreasEditor({ value = [], onChange, readOnly = false, status = null, fmtWhen = null, picked: pickedHeld = null, onPickedChange = null }) {
  const t = useT();
  const areas = Array.isArray(value) ? value : [];
  const [pickedOwn, setPickedOwn] = useState(() => new Set());
  const picked = pickedHeld instanceof Set ? pickedHeld : pickedOwn;
  const setPicked = (next) => (onPickedChange ? onPickedChange(next) : setPickedOwn(next));
  const listId = useId();
  const update = (id, patch) => onChange(areas.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  const add = () => onChange([...areas, { id: newId('area'), label: '', instructions: '', mediaRefs: [] }]);
  const remove = (id) => onChange(areas.filter((a) => a.id !== id));
  const move = (idx, dir) => {
    const j = idx + dir;
    if (j < 0 || j >= areas.length) return;
    const next = areas.slice();
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };

  if (readOnly) {
    if (areas.length === 0) return <p className="text-xs text-muted">{t('areaEditor.empty')}</p>;
    return (
      <div className="cleaning-areas">
        {areas.map((area) => {
          const st = status ? status[area.id] : null;
          const photo = st?.photo?.thumbUrl || st?.photo?.url || null;
          return (
            <div key={area.id} className="cleaning-area">
              <div className="cleaning-area-name">{area.label || t('areaEditor.untitled')}</div>
              <div className="cleaning-area-text">{area.instructions || '—'}</div>
              {/* QR-1. Said in words, never only as a colour or an icon: this is the line
                  the QR code on this area's wall will show a client, so the office should
                  be reading the same sentence. "Not recorded yet" is a normal state — an
                  area nobody has linked a checklist section to has no clean to report. */}
              {status && (
                <div className="cleaning-area-meta text-xs text-muted">
                  {st?.lastCleanedAt
                    ? t('areaEditor.lastCleaned', { when: fmtWhen ? fmtWhen(st.lastCleanedAt) : st.lastCleanedAt })
                    : t('areaEditor.notRecorded')}
                  {photo && (
                    <img
                      className="cleaning-area-shot"
                      src={photo}
                      alt={area.label ? t('areaEditor.photoAlt', { area: area.label }) : t('areaEditor.photoAltUnnamed')}
                      loading="lazy"
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // QR-8: the standard list, read against the areas as they stand in this edit (saved or not).
  const choices = standardAreaChoices(areas);
  const allAdded = choices.every((c) => c.added);
  const count = pendingStandardAreas(areas, picked).length;
  const togglePick = (name) => {
    const next = new Set(picked);
    if (next.has(name)) next.delete(name); else next.add(name);
    setPicked(next);
  };
  const addPicked = () => {
    const next = addStandardAreas(areas, [...picked]);
    setPicked(new Set());
    if (next !== areas) onChange(next);
  };

  return (
    <div className="cleaning-areas">
      {areas.length === 0 && (
        <p className="text-xs text-muted">{t('areaEditor.none')}</p>
      )}
      {areas.map((area, idx) => (
        <div key={area.id} className="cleaning-area">
          <div className="cleaning-area-head">
            <input
              className="input input-ghost cleaning-area-label"
              placeholder={t('areaEditor.namePlaceholder')}
              aria-label={t('areaEditor.nameLabel')}
              value={area.label}
              onChange={(e) => update(area.id, { label: e.target.value })}
            />
            <div className="cleaning-area-actions">
              <button type="button" className="btn-icon" aria-label={t('areaEditor.moveUp')} disabled={idx === 0} onClick={() => move(idx, -1)}>↑</button>
              <button type="button" className="btn-icon" aria-label={t('areaEditor.moveDown')} disabled={idx === areas.length - 1} onClick={() => move(idx, 1)}>↓</button>
              <button type="button" className="btn-icon btn-icon-danger" aria-label={t('areaEditor.remove')} onClick={() => remove(area.id)}><Icon name="trash" size={14} /></button>
            </div>
          </div>
          <textarea
            className="input input-ghost cleaning-area-instructions"
            rows={2}
            placeholder={t('areaEditor.instructionsPlaceholder')}
            aria-label={t('areaEditor.instructionsLabel')}
            value={area.instructions}
            onChange={(e) => update(area.id, { instructions: e.target.value })}
          />
        </div>
      ))}
      <div className="cleaning-area-std" role="group" aria-labelledby={listId}>
        <div id={listId} className="form-label">{t('areaEditor.stdLegend')}</div>
        <div className="cleaning-area-std-list">
          {choices.map((c) => (
            <label key={c.name} className="cleaning-area-std-pick">
              <input type="checkbox" checked={c.added || picked.has(c.name)} disabled={c.added} onChange={() => togglePick(c.name)} />
              <span className="cleaning-area-std-text">
                {/* The name as stored and printed: English as written (LANG-8, QR-8). */}
                <span className="cleaning-area-std-name">{c.name}</span>
                {c.added && <span className="cleaning-area-std-state">{t('areaEditor.stdAdded')}</span>}
              </span>
            </label>
          ))}
        </div>
        <p className="text-xs text-muted cleaning-area-std-hint">{allAdded ? t('areaEditor.stdAllAdded') : t('areaEditor.stdHint')}</p>
      </div>
      <div className="cleaning-area-adds">
        <button type="button" className="btn btn-primary" disabled={count === 0} onClick={addPicked}>
          {count ? t('areaEditor.stdAdd', { count }) : t('areaEditor.stdAddNone')}
        </button>
        <button type="button" className="btn btn-success" onClick={add}>{t('areaEditor.addOwn')}</button>
      </div>
    </div>
  );
}
