import { useEffect, useMemo, useState } from 'react';
import CrewPicker from './CrewPicker';
import { useDispatch } from '../store';
import { useToast } from './Toast';
import { ACTIONS } from '../store/reducer';

const hhmm = (mins) => {
  const n = Number(mins);
  if (!n) return '';
  const h = Math.floor(n / 60), m = n % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
};

// Operations tab on an account — the per-account "how to service this account"
// config: expected clean time, standing crew, and ops notes. Saving does a
// read-modify-write of just these fields via UPDATE_CLIENT (no dedicated ops
// action, no crew-notify side effect, no actor/summary stamping). Door/alarm
// access lives elsewhere and is intentionally not surfaced here.
export default function OperationsTab({ client, users = [], canEdit }) {
  const dispatch = useDispatch();
  const toast = useToast();

  const initial = useMemo(() => ({
    expectedCleanMins: typeof client.expectedCleanMins === 'number' ? client.expectedCleanMins : '',
    standingCrewIds: Array.isArray(client.standingCrewIds) ? client.standingCrewIds : [],
    opsNotes: typeof client.opsNotes === 'string' ? client.opsNotes : '',
  }), [client]);

  const [form, setForm] = useState(initial);
  useEffect(() => { setForm(initial); }, [client.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);

  const save = () => {
    const mins = form.expectedCleanMins === ''
      ? null
      : Math.max(0, Math.round(Number(form.expectedCleanMins) || 0));
    dispatch({
      type: ACTIONS.UPDATE_CLIENT,
      id: client.id,
      patch: {
        expectedCleanMins: mins,
        standingCrewIds: form.standingCrewIds,
        opsNotes: form.opsNotes,
      },
    });
    toast.success('Operations updated');
  };
  const cancel = () => setForm(initial);

  return (
    <div className="ops-tab">
      <div className="card detail-card">
        <h3>Service config</h3>
        <div className="inline-edit-grid">
          <label className="inline-edit-label" htmlFor="ops-expected">Expected clean time</label>
          <div className="inline-edit-value ops-expected-row">
            {canEdit ? (
              <>
                <input
                  id="ops-expected" type="number" min="0" step="15"
                  className="input input-ghost ops-mins" placeholder="—"
                  value={form.expectedCleanMins}
                  onChange={(e) => setForm({ ...form, expectedCleanMins: e.target.value })}
                />
                <span className="text-xs text-muted">
                  minutes{hhmm(form.expectedCleanMins) ? ` · ${hhmm(form.expectedCleanMins)}` : ''}
                </span>
              </>
            ) : (
              <span className="text-sm">
                {form.expectedCleanMins === '' || form.expectedCleanMins == null
                  ? <span className="text-muted">—</span>
                  : `${form.expectedCleanMins} minutes${hhmm(form.expectedCleanMins) ? ` · ${hhmm(form.expectedCleanMins)}` : ''}`}
              </span>
            )}
          </div>

          <label className="inline-edit-label">Standing crew</label>
          <div className="inline-edit-value">
            {canEdit ? (
              <CrewPicker
                value={form.standingCrewIds}
                onChange={(ids) => setForm({ ...form, standingCrewIds: ids })}
                pool={users}
                placeholder="Assign standing crew…"
              />
            ) : (
              <span className="text-sm">
                {form.standingCrewIds.length === 0
                  ? <span className="text-muted">No standing crew assigned.</span>
                  : form.standingCrewIds
                      .map((id) => users.find((u) => u.id === id)?.name)
                      .filter(Boolean)
                      .join(', ')}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="card detail-card">
        <h3>Ops notes</h3>
        {canEdit ? (
          <textarea
            className="input input-ghost" rows={4}
            placeholder="General notes for the crew servicing this account."
            value={form.opsNotes}
            onChange={(e) => setForm({ ...form, opsNotes: e.target.value })}
          />
        ) : (
          <p className="text-sm">
            {form.opsNotes
              ? form.opsNotes
              : <span className="text-muted">No ops notes yet.</span>}
          </p>
        )}
      </div>

      {canEdit && dirty && (
        <div className="inline-edit-savebar">
          <span className="save-hint">Unsaved changes</span>
          <button type="button" className="btn btn-outline" onClick={cancel}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={save}>Save Changes</button>
        </div>
      )}
    </div>
  );
}
