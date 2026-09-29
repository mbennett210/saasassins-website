import { useEffect, useMemo, useState } from 'react';
import { useDispatch } from '../store';
import { useToast } from './Toast';
import { ACTIONS } from '../store/reducer';

// The crew-facing account note: shown to cleaners on every clean at this account
// (via AccountNotesPanel on My Day + Job detail). Read-first — an "Edit" button flips
// to the textarea, then Save/Cancel commit (UI_RULES §101). Distinct from the office
// note timeline below, which crew never see.
export default function OpsNoteCard({ client, canEdit, currentUser }) {
  const dispatch = useDispatch();
  const toast = useToast();
  const initial = useMemo(() => (typeof client.opsNotes === 'string' ? client.opsNotes : ''), [client]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  useEffect(() => { setDraft(initial); }, [client.id, client.opsUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = draft !== initial;

  const save = () => {
    dispatch({
      type: ACTIONS.UPDATE_CLIENT_OPS,
      id: client.id,
      patch: { opsNotes: draft },
      actorName: currentUser?.name,
      summary: 'Account notes for the crew were updated.',
    });
    toast.success('Crew note updated. Assigned crew notified');
    setEditing(false);
  };
  const cancel = () => { setDraft(initial); setEditing(false); };

  return (
    <div className="card detail-card" style={{ marginBottom: 16 }}>
      <div className="overview-card-head">
        <h3>Crew note</h3>
        {canEdit && !editing && (
          <button type="button" className="btn btn-outline" onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>
      <p className="text-xs text-muted" style={{ marginTop: -4, marginBottom: 10 }}>
        Shown to the crew on every clean at this account. Use it for standing service notes: dock hours, where to check in, what to avoid.
      </p>
      {!editing ? (
        initial.trim()
          ? <p className="note-item-body" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{initial}</p>
          : <p className="text-sm text-muted" style={{ margin: 0 }}>No crew note yet.</p>
      ) : (
        <>
          <textarea className="input note-field" rows={3} placeholder="General notes for the crew servicing this account." value={draft} onChange={(e) => setDraft(e.target.value)} disabled={!canEdit} />
          {canEdit && (
            <div className="inline-edit-savebar">
              <span className="save-hint">{dirty ? 'Unsaved changes' : 'No changes yet'}</span>
              <button type="button" className="btn btn-outline" onClick={cancel}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={save}>Save Changes</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
