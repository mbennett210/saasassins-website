import { useEffect, useMemo, useState } from 'react';
import CleaningAreasEditor from './CleaningAreasEditor';
import AreaScanCodes from './AreaScanCodes';
import { useDispatch, useSelector } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectCurrentUser } from '../store/selectors';
import { useToast } from './Toast';
import * as qcApi from '../lib/qcApi';
import { fmtDateLong, fmtTime } from '../lib/dates';
import { scanCodesAllowed } from '../lib/scanCodes';
import { addStandardAreas, pendingStandardAreas } from '../lib/standardAreas';
import { useT } from '../i18n/react';

// The viewer's role, as a primitive, so the card re-renders only when it changes.
const selectViewerRole = (s) => selectCurrentUser(s)?.role || null;

// Per-account cleaning instructions (the area-by-area breakdown crew see on their
// schedule), edited on the Notes tab. Read-first → "Edit" → editable list →
// Save/Cancel (UI_RULES §101). Saves onto the account's single location via
// UPDATE_SITE. Moved here from the retired site-editor modal. The QR codes page opens this same
// card in a pop-up (UI_RULES §183): `startEditing` opens it on the editor ("Add areas" there), and
// `onDirtyChange(dirty)` tells it whether areas are added, changed or ticked and not saved, so closing the
// pop-up asks before dropping them. Every word is a catalog line (CS-193).
export default function CleaningInstructionsCard({ location, canEdit, startEditing = false, onDirtyChange }) {
  const t = useT();
  const dispatch = useDispatch();
  const toast = useToast();
  // QR-6: the location's QR codes sit under its areas, for the office only — the key that
  // edits these areas (`canEdit` is sites.edit) and never crew, the same rule the route holds.
  const role = useSelector(selectViewerRole);
  const showCodes = scanCodesAllowed(role, canEdit === true);
  const initial = useMemo(() => (Array.isArray(location?.cleaningAreas) ? location.cleaningAreas : []), [location]);
  const [editing, setEditing] = useState(() => startEditing && canEdit === true);
  const [draft, setDraft] = useState(initial);
  // The standard areas ticked in the editor and not added yet (CleaningAreasEditor's tick boxes), held
  // here so Save Changes adds them with the rest and a tick counts as unsaved (UI_RULES §183).
  const [picked, setPicked] = useState(() => new Set());
  // QR-1: when each area was last finished + its newest photo, read from EP-200. One read
  // per open, best-effort: a failed read leaves `status` null and the card shows exactly
  // what it showed before this landed, never an error over the instructions themselves.
  const [status, setStatus] = useState(null);
  useEffect(() => { setDraft(initial); setPicked(new Set()); }, [location?.id, location?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const siteId = location?.id || null;
  useEffect(() => {
    if (!siteId || !initial.length) { setStatus(null); return undefined; }
    let alive = true;
    qcApi.areaStatus({ siteId, cleaningAreas: initial })
      .then((r) => {
        if (!alive) return;
        const by = {};
        for (const a of r?.areas || []) if (a.areaId) by[a.areaId] = a;
        setStatus(by);
      })
      .catch(() => { if (alive) setStatus(null); });
    return () => { alive = false; };
  }, [siteId, initial]);
  // Unsaved: editing, and the list no longer reads as the saved one (an area added and taken out
  // again is not a change), or a standard area is ticked and not added yet.
  const pending = editing ? pendingStandardAreas(draft, picked).length : 0;
  const dirty = editing && (pending > 0 || JSON.stringify(draft) !== JSON.stringify(initial));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onDirtyChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!location) return null;

  // The ticked areas go in with the rest (one addStandardAreas, as the editor's own Add does): ticked,
  // then Save Changes, saved nothing under an "updated" toast, and no codes came (found 2026-10-30).
  const save = () => {
    const next = addStandardAreas(draft, [...picked]);
    dispatch({ type: ACTIONS.UPDATE_SITE, id: location.id, patch: { cleaningAreas: next } });
    toast.success(t('areaEditor.saved'));
    setPicked(new Set());
    setEditing(false);
  };
  const cancel = () => { setDraft(initial); setPicked(new Set()); setEditing(false); };

  return (
    <div className="card detail-card" style={{ marginBottom: 16 }}>
      <div className="overview-card-head">
        <h3>{t('areaEditor.cardTitle')}</h3>
        {canEdit && !editing && (
          <button type="button" className="btn btn-outline" onClick={() => setEditing(true)}>{t('areaEditor.edit')}</button>
        )}
      </div>
      <p className="text-xs text-muted" style={{ marginTop: -4, marginBottom: 10 }}>
        {showCodes ? t('areaEditor.cardHintCodes') : t('areaEditor.cardHint')}
      </p>
      {!editing ? (
        initial.length > 0
          ? (
            <>
              <CleaningAreasEditor
                value={initial}
                readOnly
                status={status}
                fmtWhen={(iso) => `${fmtDateLong(iso)} · ${fmtTime(iso)}`}
              />
              {showCodes && <AreaScanCodes location={location} />}
            </>
          )
          : (
            // Matt (2026-10-30): "what about the QR codes? How do I create them? I'm not able to find
            // that". A location's codes are made from its areas, so with none yet this card is where
            // they start: it says so and opens the editor (QR codes page, UI_RULES §183).
            <div className="cleaning-areas-empty">
              <p className="text-sm text-muted" style={{ margin: 0 }}>
                {showCodes ? t('areaEditor.emptyCodes') : t('areaEditor.empty')}
              </p>
              {canEdit && (
                <button type="button" className="btn btn-primary" onClick={() => setEditing(true)}>{t('areaEditor.addAreas')}</button>
              )}
            </div>
          )
      ) : (
        <>
          <CleaningAreasEditor value={draft} onChange={setDraft} picked={picked} onPickedChange={setPicked} />
          <div className="inline-edit-savebar">
            <span className="save-hint">{t('areaEditor.editing')}</span>
            <button type="button" className="btn btn-outline" onClick={cancel}>{t('common.cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={save}>{t('areaEditor.save')}</button>
          </div>
        </>
      )}
    </div>
  );
}
