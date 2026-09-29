import { useEffect, useMemo, useState } from 'react';
import CleaningAreasEditor from './CleaningAreasEditor';
import { useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { useToast } from './Toast';

// Per-account cleaning instructions (the area-by-area breakdown crew see on their
// schedule), edited on the Notes tab. Read-first → "Edit" → editable list →
// Save/Cancel (UI_RULES §101). Saves onto the account's single location via
// UPDATE_SITE. Moved here from the retired site-editor modal.
export default function CleaningInstructionsCard({ location, canEdit }) {
  const dispatch = useDispatch();
  const toast = useToast();
  const initial = useMemo(() => (Array.isArray(location?.cleaningAreas) ? location.cleaningAreas : []), [location]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  useEffect(() => { setDraft(initial); }, [location?.id, location?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!location) return null;

  const save = () => {
    dispatch({ type: ACTIONS.UPDATE_SITE, id: location.id, patch: { cleaningAreas: draft } });
    toast.success('Cleaning instructions updated');
    setEditing(false);
  };
  const cancel = () => { setDraft(initial); setEditing(false); };

  return (
    <div className="card detail-card" style={{ marginBottom: 16 }}>
      <div className="overview-card-head">
        <h3>Cleaning instructions</h3>
        {canEdit && !editing && (
          <button type="button" className="btn btn-outline" onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>
      <p className="text-xs text-muted" style={{ marginTop: -4, marginBottom: 10 }}>
        Break the clean down by area. Crew see these on their schedule for this account.
      </p>
      {!editing ? (
        initial.length > 0
          ? <CleaningAreasEditor value={initial} readOnly />
          : <p className="text-sm text-muted" style={{ margin: 0 }}>No cleaning instructions yet.</p>
      ) : (
        <>
          <CleaningAreasEditor value={draft} onChange={setDraft} />
          <div className="inline-edit-savebar">
            <span className="save-hint">Editing cleaning instructions</span>
            <button type="button" className="btn btn-outline" onClick={cancel}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={save}>Save Changes</button>
          </div>
        </>
      )}
    </div>
  );
}
