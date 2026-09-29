import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useStore } from '../store';
import { useToast } from './Toast';
import { ACTIONS } from '../store/reducer';
import { selectJobsForClient, selectUserById, selectActiveUsers } from '../store/selectors';
import { ROLE_LABELS, SUPERVISOR_ROLES } from '../lib/roles';
import Avatar from './Avatar';
import Select from './Select';
import InspectionTemplateEditor from './InspectionTemplateEditor';
import * as qcApi from '../lib/qcApi';
import { pruneCrewChecklists } from '../lib/crewChecklist';

// Account-level service setup, shown on the client Overview. Two quiet groups:
// People (assigned cleaners + account supervisor) and Service & quality (each cleaner's
// own checklist for this location + a reference link). Read-first — an "Edit" button flips
// to the form, then Save/Cancel commit (UI_RULES §101). Access notes, door codes and
// expected clean time live on the Location card.
// A checklist is assigned PER CLEANER and only per cleaner (R3, 2026-09-27): there is no
// location-wide default, so a cleaner with no pick reads "No checklist" — a normal state,
// never a warning (R1). Each cleaner's dropdown ends in a row that opens the checklist
// builder inline; a published template binds straight back onto that cleaner. Supervisor
// is a single point of contact for the account, chosen from Owner / Admin / Manager (see
// SUPERVISOR_ROLES).
const CREATE_CHECKLIST = '__create_checklist__';
// SUPERVISOR_ROLES (owner/admin/manager) is shared from lib/roles — the same trio
// the notification fan-out resolves against, so the picker and the notify path can't
// drift on who is eligible to supervise an account.

function supervisorLabel(u) {
  return (
    <span className="svc-sup-opt">
      <Avatar initials={u.initials} variant={u.avatar} size="sm" />
      {u.name}
      <span className="svc-sup-role">· {ROLE_LABELS[u.role] || u.role}</span>
    </span>
  );
}

export default function ServiceSetupCard({ client, canEdit, currentUser }) {
  const dispatch = useDispatch();
  const state = useStore();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  // Inline checklist builder target: null = closed, or the userId of the cleaner whose
  // select opened it. onChecklistCreated binds the published result back onto that cleaner.
  const [createTarget, setCreateTarget] = useState(null);

  // Cleaners assigned to any PRESENT/FUTURE clean for this account (upcoming or in
  // progress — past/cancelled excluded). Derived from the jobs' crew, deduped.
  const assignedCleaners = useMemo(() => {
    const active = selectJobsForClient(state, client.id).filter((j) => j.status === 'upcoming' || j.status === 'in_progress');
    const ids = [...new Set(active.flatMap((j) => j.crewIds || []))];
    return ids.map((id) => selectUserById(state, id)).filter(Boolean);
  }, [state, client.id]);

  // Active Owner / Admin / Manager — the tiers eligible to supervise an account.
  const eligibleSupervisors = useMemo(
    () => selectActiveUsers(state).filter((u) => SUPERVISOR_ROLES.includes(u.role)),
    [state],
  );

  const initial = useMemo(() => ({
    crewChecklists: client.crewChecklists || {},
    supervisorId: client.supervisorId || '',
    accessLink: client.security?.accessLink || '',
  }), [client]);
  const [form, setForm] = useState(initial);
  const baseline = useRef(initial);
  useEffect(() => { baseline.current = initial; setForm(initial); }, [client.id, client.opsUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);

  const [checklistTemplates, setChecklistTemplates] = useState([]);
  const loadChecklistTemplates = useCallback(() => {
    qcApi.listTemplates({ kind: 'checklist' })
      .then((t) => setChecklistTemplates((t || []).filter((x) => x.is_published)))
      .catch(() => setChecklistTemplates([]));
  }, []);
  useEffect(() => { loadChecklistTemplates(); }, [loadChecklistTemplates]);

  const savedLink = client.security?.accessLink || '';
  const supervisor = client.supervisorId ? selectUserById(state, client.supervisorId) : null;

  // Per-cleaner checklist picks. '' = no checklist (dropped from the map, so an empty map
  // means nobody here holds one — there is no default to fall back to).
  const setCleanerChecklist = (uid, val) => setForm((f) => {
    const next = { ...(f.crewChecklists || {}) };
    if (val) next[uid] = val; else delete next[uid];
    return { ...f, crewChecklists: next };
  });
  const onCleanerChecklistChange = (uid, val) => {
    if (val === CREATE_CHECKLIST) { setCreateTarget(uid); return; }
    setCleanerChecklist(uid, val);
  };

  // A freshly created + published checklist binds straight into the staged form onto the
  // cleaner whose "＋ Create" opened it; the user still confirms with Save Changes
  // (matches the card's read-first commit).
  const onChecklistCreated = (newId) => {
    const target = createTarget;
    setCreateTarget(null);
    loadChecklistTemplates();
    if (!newId || !target) return;
    setCleanerChecklist(target, newId);
  };

  const cleanerChecklistOptions = (uid) => {
    const opts = [{ value: '', label: 'No checklist' }];
    for (const t of checklistTemplates) opts.push({ value: t.id, label: t.name });
    const cur = form.crewChecklists?.[uid];
    if (cur && !checklistTemplates.some((t) => t.id === cur)) opts.push({ value: cur, label: 'Currently assigned checklist' });
    opts.push({ value: CREATE_CHECKLIST, label: <span className="svc-create-option">＋ Create new checklist</span> });
    return opts;
  };
  const templateNameById = (id) => checklistTemplates.find((t) => t.id === id)?.name || (id ? 'Assigned checklist' : null);
  // Read-mode summary: EVERY scheduled cleaner, with their checklist or "No checklist" —
  // the absence is a fact worth showing, not something to hide (R1/R3).
  const perCleanerRead = assignedCleaners
    .map((u) => ({ u, tid: client.crewChecklists?.[u.id] || '' }));

  // Supervisor options = Not set + eligible staff. If the bound supervisor is no
  // longer eligible (role change / deactivated) keep them listed so the value shows.
  const supervisorOptions = useMemo(() => {
    const opts = [{ value: '', label: <span className="text-muted">Not set</span> }];
    for (const u of eligibleSupervisors) opts.push({ value: u.id, label: supervisorLabel(u) });
    if (form.supervisorId && !eligibleSupervisors.some((u) => u.id === form.supervisorId)) {
      const u = selectUserById(state, form.supervisorId);
      if (u) opts.push({ value: u.id, label: supervisorLabel(u) });
    }
    return opts;
  }, [eligibleSupervisors, form.supervisorId, state]);

  const save = () => {
    dispatch({
      type: ACTIONS.UPDATE_CLIENT_OPS,
      id: client.id,
      patch: {
        crewChecklists: pruneCrewChecklists(form.crewChecklists),
        supervisorId: form.supervisorId || null,
        security: { ...(client.security || {}), accessLink: form.accessLink || null },
      },
      actorName: currentUser?.name,
      summary: 'Account service setup was updated.',
    });
    toast.success('Service setup updated');
    setEditing(false);
  };
  const cancel = () => { baseline.current = initial; setForm(initial); setEditing(false); };

  const cleanersView = assignedCleaners.length
    ? (
      <span className="svc-cleaners">{assignedCleaners.map((u) => (
        <span key={u.id} className="svc-cleaner"><Avatar initials={u.initials} variant={u.avatar} size="sm" /><span>{u.name}</span></span>
      ))}</span>
    )
    : <span className="text-muted">None on upcoming cleans</span>;

  return (
    <div className="card detail-card">
      <div className="overview-card-head">
        <h3>Service setup</h3>
        {canEdit && !editing && (
          <button type="button" className="btn btn-outline" onClick={() => setEditing(true)}>Edit</button>
        )}
      </div>

      {!editing ? (
        <>
          <div className="svc-group">
            <div className="svc-group-label">People</div>
            <dl className="detail-dl">
              <div><dt>Cleaners</dt><dd>{cleanersView}</dd></div>
              <div><dt>Supervisor</dt><dd>{supervisor
                ? supervisorLabel(supervisor)
                : <span className="text-muted">Not set</span>}</dd></div>
            </dl>
          </div>
          <div className="svc-group">
            <div className="svc-group-label">Service &amp; quality</div>
            <dl className="detail-dl">
              <div><dt>Checklists</dt><dd>
                {perCleanerRead.length === 0 ? (
                  <span className="text-muted">No cleaners on upcoming cleans</span>
                ) : (
                  <ul className="svc-cleaner-checklists">
                    {perCleanerRead.map(({ u, tid }) => (
                      <li key={u.id}>
                        <span className="svc-cc-who">{u.name}</span> — {tid
                          ? templateNameById(tid)
                          : <span className="text-muted">No checklist</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </dd></div>
              <div><dt>Reference link</dt><dd>{savedLink
                ? <a className="linklike" href={savedLink} target="_blank" rel="noreferrer">{savedLink}</a>
                : '—'}</dd></div>
            </dl>
          </div>
          <p className="text-xs text-muted svc-footnote">
            Entry instructions, door codes &amp; expected clean time are set on the <strong>Location</strong> card.
          </p>
        </>
      ) : (
        <>
          <div className="svc-group">
            <div className="svc-group-label">People</div>
            <div className="inline-edit-grid">
              <div className="inline-edit-label">Cleaners</div>
              <div className="inline-edit-value">
                {cleanersView}
                <div className="text-xs text-muted svc-ro-note">From upcoming cleans — not editable here.</div>
              </div>

              <label className="inline-edit-label" htmlFor="svc-supervisor">Supervisor</label>
              <div className="inline-edit-value">
                <Select id="svc-supervisor" ariaLabel="Account supervisor" value={form.supervisorId} onChange={(v) => setForm({ ...form, supervisorId: v })} options={supervisorOptions} placeholder="Not set" disabled={!canEdit} />
                <div className="text-xs text-muted svc-ro-note">Single point of contact for this customer. Owner, Admin &amp; Manager are eligible.</div>
              </div>
            </div>
          </div>

          <div className="svc-group">
            <div className="svc-group-label">Service &amp; quality</div>
            <div className="inline-edit-grid">
              <label className="inline-edit-label" htmlFor="svc-link">Reference link</label>
              <div className="inline-edit-value">
                <input id="svc-link" className="input" placeholder="Google Doc / photo link (optional)" value={form.accessLink} onChange={(e) => setForm({ ...form, accessLink: e.target.value })} disabled={!canEdit} />
              </div>
            </div>

            <div className="svc-cc-edit">
              <div className="svc-cc-head">Checklist per cleaner</div>
              {assignedCleaners.length === 0 ? (
                <div className="text-xs text-muted">Assign cleaners to this account’s cleans (on the schedule) to give each their own checklist.</div>
              ) : (
                <>
                  <div className="text-xs text-muted svc-cc-note">
                    A checklist belongs to one cleaner at this location. Leave a cleaner on “No checklist” if they don’t need one. Cleaners come from this account’s upcoming cleans.
                  </div>
                  <div className="inline-edit-grid">
                    {assignedCleaners.map((u) => (
                      <Fragment key={u.id}>
                        <label className="inline-edit-label" htmlFor={`svc-cc-${u.id}`}>
                          <span className="svc-cc-label"><Avatar initials={u.initials} variant={u.avatar} size="sm" />{u.name}</span>
                        </label>
                        <div className="inline-edit-value">
                          <Select id={`svc-cc-${u.id}`} ariaLabel={`Checklist for ${u.name}`} value={form.crewChecklists?.[u.id] || ''} onChange={(v) => onCleanerChecklistChange(u.id, v)} options={cleanerChecklistOptions(u.id)} placeholder="No checklist" disabled={!canEdit} />
                        </div>
                      </Fragment>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <p className="text-xs text-muted svc-footnote">
            Entry instructions, door codes &amp; expected clean time are set on the <strong>Location</strong> card.
          </p>
          {canEdit && (
            <div className="inline-edit-savebar">
              <span className="save-hint">{dirty ? 'Unsaved changes' : 'No changes yet'}</span>
              <button type="button" className="btn btn-outline" onClick={cancel}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={save}>Save Changes</button>
            </div>
          )}
        </>
      )}

      <InspectionTemplateEditor
        open={createTarget !== null}
        templateId={null}
        presetKind="checklist"
        onClose={() => setCreateTarget(null)}
        onSaved={onChecklistCreated}
      />
    </div>
  );
}
