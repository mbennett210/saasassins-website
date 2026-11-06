import { useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useStore } from '../store';
import { useToast } from './Toast';
import { ACTIONS } from '../store/reducer';
import { selectAssignedCleanersForClient, selectUserById, selectActiveUsers } from '../store/selectors';
import { ROLE_LABELS, SUPERVISOR_ROLES } from '../lib/roles';
import { inspectionReminderDays, MAX_INSPECTION_REMINDER_DAYS } from '../lib/opsAlerts';
import Avatar from './Avatar';
import Select from './Select';
import CustomerChecklistPanel from './checklists/CustomerChecklistPanel';
import { usePermission } from '../hooks/usePermission';
import { msg } from '../i18n/core';
import { useT } from '../i18n/react';

// Account-level service setup, shown on the client Overview. Two quiet groups:
// People (assigned cleaners + account supervisor) and Service & quality (the customer's
// checklists and who holds each, plus a reference link). Read-first — an "Edit" button
// flips to the form, then Save/Cancel commit (UI_RULES §101). Access notes, door codes and
// expected clean time live on the Location card.
//
// 🔴 THE CHECKLISTS ARE NOT PART OF THAT FORM. They are the SAME component the Quality
// hub's Assignments tab renders (components/checklists/CustomerChecklistPanel, UI_RULES
// §134), embedded here so the customer page and the hub can never say different things
// about who holds what. Its actions are ONE step each and commit straight away, which is
// why it sits outside the Edit/Save form: a staged draft of an assignment is exactly what
// the pop-up organizer did, and a mis-click lost it.
//
// A checklist is assigned PER CLEANER and only per cleaner (R3, 2026-09-27): there is no
// customer-wide default, so a cleaner with no pick reads "No checklist" — a normal state,
// never a warning (R1). Supervisor is a single point of contact for the account, chosen
// from Owner / Admin / Manager (SUPERVISOR_ROLES, shared from lib/roles — the same trio
// the notification fan-out resolves against, so the picker and the notify path can't
// drift on who is eligible to supervise an account).

function supervisorLabel(u) {
  return (
    <span className="svc-sup-opt">
      <Avatar user={u} size="sm" />
      {u.name}
      <span className="svc-sup-role">· {ROLE_LABELS[u.role] || u.role}</span>
    </span>
  );
}

export default function ServiceSetupCard({ client, canEdit, currentUser }) {
  const dispatch = useDispatch();
  const state = useStore();
  const toast = useToast();
  const t = useT();
  // `canEdit` is this card's ops.edit. Managing a checklist takes the key the server
  // requires for it, which a viewer may hold without the other (L3 S2).
  const canEditTemplates = usePermission('qc.templates.edit');
  const [editing, setEditing] = useState(false);

  // Cleaners assigned to any PRESENT/FUTURE clean for this account (upcoming or in
  // progress — past/cancelled excluded). Derived from the jobs' crew, deduped. Then the cleaners
  // who work here (lib/worksAt, the Team import's Account column) and aren't on one of those
  // cleans yet: a link the office keeps, never access (what they see comes from their cleans).
  // One selector, shared with the onboarding bar's Cleaners step (task 471).
  const assignedCleaners = useMemo(() => selectAssignedCleanersForClient(state, client.id), [state, client.id]);

  // Active Owner / Admin / Manager — the tiers eligible to supervise an account.
  const eligibleSupervisors = useMemo(
    () => selectActiveUsers(state).filter((u) => SUPERVISOR_ROLES.includes(u.role)),
    [state],
  );

  const initial = useMemo(() => ({
    supervisorId: client.supervisorId || '',
    accessLink: client.security?.accessLink || '',
    // ALR-9 (Matt, 2026-09-29): this account's OWN inspection interval. '' = follow the org
    // default, which is the normal case, so the field is never pre-filled with a number
    // nobody chose.
    inspectionIntervalDays: Number.isFinite(client.inspectionIntervalDays) ? String(client.inspectionIntervalDays) : '',
  }), [client]);
  const [form, setForm] = useState(initial);
  const baseline = useRef(initial);
  useEffect(() => { baseline.current = initial; setForm(initial); }, [client.id, client.opsUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);

  const savedLink = client.security?.accessLink || '';
  // The company default this account falls back to when it carries no interval of its own.
  const orgIntervalDays = inspectionReminderDays(state.opsSettings || {});
  const supervisor = client.supervisorId ? selectUserById(state, client.supervisorId) : null;
  // Assigning the account's manager (client.supervisorId) is a Super Admin or Admin call —
  // it decides scope() for time approval (MTA §2), and the server (orgStateGuard) refuses it
  // for everyone else whatever keys they hold, so the picker offers only what the server takes.
  // Role is claims-first (currentUser from useAuth → selectCurrentUser). The rest of the card
  // keeps its own `canEdit` (ops.edit) gate.
  const canAssignManager = currentUser?.role === 'owner' || currentUser?.role === 'admin';

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

  // ALR-9: an empty / zero / non-numeric entry means "use the org default" — null, never 0,
  // or the reader would take it as a real interval of zero days. Clamped to the same ceiling
  // the org setting takes, past which an account reads as never inspected and is never
  // reminded (lib/opsAlerts MAX_INSPECTION_REMINDER_DAYS).
  const intervalDays = (() => {
    const n = Number(form.inspectionIntervalDays);
    if (!Number.isFinite(n) || n < 1) return null;
    return Math.min(MAX_INSPECTION_REMINDER_DAYS, Math.floor(n));
  })();

  const save = () => {
    dispatch({
      type: ACTIONS.UPDATE_CLIENT_OPS,
      id: client.id,
      patch: {
        supervisorId: form.supervisorId || null,
        inspectionIntervalDays: intervalDays,
        security: { ...(client.security || {}), accessLink: form.accessLink || null },
      },
      actorName: currentUser?.name,
      // A message: the crew's bell row is written in each cleaner's language (CS-193).
      summary: msg('alerts.ops.serviceSetup'),
    });
    toast.success('Service setup updated');
    setEditing(false);
  };
  const cancel = () => { baseline.current = initial; setForm(initial); setEditing(false); };

  const cleanersView = assignedCleaners.length
    ? (
      <span className="svc-cleaners">{assignedCleaners.map(({ user: u, onClean }) => (
        <span key={u.id} className="svc-cleaner">
          <Avatar user={u} size="sm" /><span>{u.name}</span>
          {!onClean && <span className="text-xs text-muted">{t('worksAt.notOnClean')}</span>}
        </span>
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
        <div className="svc-group">
          <div className="svc-group-label">People</div>
          <dl className="detail-dl">
            <div><dt>Cleaners</dt><dd>{cleanersView}</dd></div>
            <div><dt>Supervisor</dt><dd>{supervisor
              ? supervisorLabel(supervisor)
              : <span className="text-muted">Not set</span>}</dd></div>
            <div><dt>Inspect every</dt><dd>{Number.isFinite(client.inspectionIntervalDays)
              ? `${client.inspectionIntervalDays} days`
              : <span className="text-muted">{orgIntervalDays} days (company default)</span>}</dd></div>
            <div><dt>Reference link</dt><dd>{savedLink
              ? <a className="linklike" href={savedLink} target="_blank" rel="noreferrer">{savedLink}</a>
              : '—'}</dd></div>
          </dl>
        </div>
      ) : (
        <div className="svc-group">
          <div className="svc-group-label">People</div>
          <div className="inline-edit-grid">
            <div className="inline-edit-label">Cleaners</div>
            <div className="inline-edit-value">
              {cleanersView}
              <div className="text-xs text-muted svc-ro-note">{t('worksAt.svcNote')}</div>
            </div>

            {/* Main's canAssignManager gate (S106) on my restructured grid. */}
            <label className="inline-edit-label" htmlFor="svc-supervisor">Supervisor</label>
            <div className="inline-edit-value">
              <Select id="svc-supervisor" ariaLabel="Account supervisor" value={form.supervisorId} onChange={(v) => setForm({ ...form, supervisorId: v })} options={supervisorOptions} placeholder="Not set" disabled={!canEdit || !canAssignManager} />
              <div className="text-xs text-muted svc-ro-note">{canAssignManager
                ? <>Single point of contact for this customer. Owner, Admin &amp; Manager are eligible.</>
                : 'Only a Super Admin or Admin assigns a location’s manager.'}</div>
            </div>

            {/* ALR-9: per-account inspection cadence, blank = the company default. */}
            <label className="inline-edit-label" htmlFor="svc-inspect-days">Inspect every (days)</label>
            <div className="inline-edit-value">
              <input
                id="svc-inspect-days" className="input" type="number" min="1" max={MAX_INSPECTION_REMINDER_DAYS} step="1"
                placeholder={`${orgIntervalDays} (company default)`}
                value={form.inspectionIntervalDays}
                onChange={(e) => setForm({ ...form, inspectionIntervalDays: e.target.value })}
                disabled={!canEdit}
              />
              <div className="text-xs text-muted svc-ro-note">Leave blank to follow the company default ({orgIntervalDays} days). The supervisor is reminded when this account has not been inspected within its own interval.</div>
            </div>

            <label className="inline-edit-label" htmlFor="svc-link">Reference link</label>
            <div className="inline-edit-value">
              <input id="svc-link" className="input" placeholder="Google Doc / photo link (optional)" value={form.accessLink} onChange={(e) => setForm({ ...form, accessLink: e.target.value })} disabled={!canEdit} />
            </div>
          </div>
          {canEdit && (
            <div className="inline-edit-savebar">
              <span className="save-hint">{dirty ? 'Unsaved changes' : 'No changes yet'}</span>
              <button type="button" className="btn btn-outline" onClick={cancel}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={save}>Save Changes</button>
            </div>
          )}
        </div>
      )}

      {/* The same customer view the Quality hub's Assignments tab shows. Live in both
          modes: every action on it is one step and commits on its own. */}
      <div className="svc-group">
        <div className="svc-group-label">Service &amp; quality</div>
        <CustomerChecklistPanel client={client} canEdit={canEdit} canEditTemplates={canEditTemplates} embedded />
      </div>

      <p className="text-xs text-muted svc-footnote">
        Entry instructions, door codes &amp; expected clean time are set on the <strong>Location</strong> card.
      </p>
    </div>
  );
}
