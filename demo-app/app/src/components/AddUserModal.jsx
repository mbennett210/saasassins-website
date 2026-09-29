import { useEffect, useState } from 'react';
import Modal from './Modal';
import FormField from './FormField';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectUserByEmail,
  selectCompany,
  selectCurrentUser,
  selectEmailDefaultFrom,
  selectEmailDefaultReplyTo,
  selectPermissions,
  selectUserPermissionOverrides,
} from '../store/selectors';
import { useToast } from './Toast';
import { useSession } from '../auth/AuthProvider';
import { ROLE_LABELS } from '../lib/roles';
import { assignableRoles } from '../lib/teamLimits';
import { sendEmail, buildInviteEmail } from '../lib/email';
import { createTeamLogin, bindRosterId } from '../lib/teamApi';
import { newId } from '../lib/ids';
import { IDENTITY } from '../brand/identity.generated.js';

const EMPTY = { name: '', email: '', phone: '', role: 'crew' };

// Next auto Employee ID — max existing EMP-#### + 1, zero-padded to 4. HR can
// overwrite it on the profile (EmployeeHrFieldsCard).
function nextEmployeeId(users) {
  let max = 0;
  for (const u of users || []) {
    const m = /^EMP-(\d+)$/.exec((u.hr && u.hr.employeeId) || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `EMP-${String(max + 1).padStart(4, '0')}`;
}

// `initial` prefills the form — used by the Settings → Team reconciliation banner
// to re-invite an orphan login with its email + claimed role already filled in.
// Only the name is left for the admin, because a Supabase account carries none.
export default function AddUserModal({ open, onClose, initial = null }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const { configured: authConfigured } = useSession();
  const company = selectCompany(state);
  const currentUser = selectCurrentUser(state);
  const emailDefaultFrom = selectEmailDefaultFrom(state);
  const emailDefaultReplyTo = selectEmailDefaultReplyTo(state);

  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [created, setCreated] = useState(null); // { name, email, invited }

  useEffect(() => {
    if (!open) return;
    setForm({ ...EMPTY, ...(initial || {}) });
    setError('');
    setSending(false);
    setCreated(null);
    // `initial` is an object literal at the call site, so depending on it would
    // reset the form on every parent render — including mid-typing. Key off the
    // fields that actually identify a prefill.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.email, initial?.role]);

  // The levels this viewer may give (lib/teamLimits assignableRoles = lib/roles canGiveRole,
  // owner's rule 2026-09-23): a Super Admin any; anyone else only a level whose every
  // permission they hold themselves (with the default matrix an Admin invites Admin or Crew,
  // a Manager Admin, Manager or Crew). TeamDetail's Role field offers the same list, and the
  // server runs the same function on the invite (/api/settings/users) and on the roster
  // save (the org_state guard).
  const roleChoices = assignableRoles(currentUser, selectPermissions(state), selectUserPermissionOverrides(state));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const name = form.name.trim();
    const email = form.email.trim().toLowerCase();
    if (!name) { setError('Name is required.'); return; }
    if (!email) { setError('Email is required.'); return; }
    const dup = selectUserByEmail(state, email);
    if (dup) { setError(`Email already in use by ${dup.name}.`); return; }
    if (!roleChoices.includes(form.role)) {
      setError(form.role === 'owner'
        ? 'Only a Super Admin can create a Super Admin.'
        : `You can't give someone the ${ROLE_LABELS[form.role] || form.role} access level: it includes permissions you don't have.`);
      return;
    }

    const initials = name.split(' ').filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2);
    const userId = newId('u');

    // ── Authed (Supabase) mode: create a REAL login + the team record, then
    //    email the new member a "set your password" link via Resend (the admin
    //    never sees or shares a password). ──────────────────────────────────
    if (authConfigured) {
      setSending(true);
      let result;
      try {
        result = await createTeamLogin(email, form.role, userId);
      } catch (err) {
        setSending(false);
        setError(`Couldn't create login: ${err.message || 'failed.'}`);
        return;
      }
      // The SERVER decides the id. On an adopt it returns the one already stamped
      // into that login's JWT; using the locally-minted id instead would leave the
      // claim — which every server gate reads — pointing at nobody.
      const boundId = bindRosterId(result, userId);
      dispatch({
        type: ACTIONS.ADD_USER,
        user: { id: boundId, name, email, phone: form.phone.trim(), role: form.role, status: 'active', initials, hr: { employeeId: nextEmployeeId(state.users) } },
      });
      setSending(false);
      setCreated({
        name, email, invited: result.invited !== false, role: form.role,
        adopted: result.adopted === true,
      });
      return;
    }

    // ── Local mode: original invite-email flow (no real auth backend). ──────
    const token = `tok_${Math.random().toString(36).slice(2, 14)}`;
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    setSending(true);
    try {
      const { subject, body } = buildInviteEmail({
        inviteeName: name,
        inviterName: currentUser?.name || 'Your team',
        companyName: company.name,
        roleLabel: ROLE_LABELS[form.role],
        token,
        expiresAt,
      });
      await sendEmail({
        to: email,
        from: emailDefaultFrom || company.email || 'no-reply@example.com',
        subject,
        body,
        replyTo: emailDefaultReplyTo || currentUser?.email || company.email,
        tags: ['invitation'],
      });
    } catch (err) {
      setSending(false);
      setError(`Couldn't send invitation: ${err.message || 'Email send failed.'}`);
      return;
    }
    dispatch({
      type: ACTIONS.ADD_USER,
      user: { id: userId, name, email, phone: form.phone.trim(), role: form.role, status: 'invited', initials, hr: { employeeId: nextEmployeeId(state.users) } },
    });
    dispatch({ type: ACTIONS.SEND_INVITATION, userId, email, role: form.role, invitedBy: currentUser?.id });
    toast.success(`Invitation sent to ${email}`);
    setSending(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={created ? 'Member added' : 'Add Team Member'}>
      {created ? (
        <div>
          <p className="text-sm" style={{ marginBottom: 12 }}>
            {created.adopted
              ? <><strong>{created.name}</strong> already had a login here. It’s now reconnected to the team.</>
              : <><strong>{created.name}</strong>’s login was created.</>}
          </p>
          {created.adopted && (
            <div className="callout callout-info text-sm" style={{ marginBottom: 12 }}>
              An earlier invite created their login but never finished adding them to the team, so
              they didn’t appear on this list. Their existing account was kept. Anything already
              recorded under it stays theirs. And their access level is now <strong>{ROLE_LABELS[created.role]}</strong>.
            </div>
          )}
          {created.role === 'crew' && (
            <p className="text-sm" style={{ marginBottom: 12 }}>
              They'll see an account's cleans, keys, and contacts once they're scheduled on a clean there. Put them on a clean from the <strong>Schedule</strong>.
            </p>
          )}
          {created.invited ? (
            <div style={{ padding: '10px 12px', border: '1px solid var(--color-semantic-success-200)', borderRadius: 8, background: 'var(--color-semantic-success-50)', fontSize: 13, color: 'var(--color-semantic-success-700)' }}>
              We emailed <strong>{created.email}</strong> a secure link to set their password and sign in. Nothing to share.
            </div>
          ) : (
            <div style={{ padding: '10px 12px', border: '1px solid var(--color-semantic-warning-200)', borderRadius: 8, background: 'var(--color-semantic-warning-50)', fontSize: 13, color: 'var(--color-semantic-warning-700)' }}>
              The login was created, but the set-password email couldn’t be sent right now. Open <strong>Settings → Team → {created.name}</strong> and use <strong>Email password-reset link</strong> to send it.
            </div>
          )}
          <div className="modal-actions">
            <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div className="form-row">
            <FormField label="Name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jordan Tate" />
            <FormField label="Email" type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="name@company.com" />
          </div>
          {error && <div className="form-error" style={{ marginTop: -8, marginBottom: 10 }}>{error}</div>}
          <div className="form-row">
            <FormField label="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder={`(${IDENTITY.company.areaCode}) 555-0100`} />
            <FormField
              label="Role"
              as="select"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              options={roleChoices.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
              help="Permissions can be customized per-member after adding."
            />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose} disabled={sending}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={sending}>
              {sending ? 'Sending…' : 'Send invite'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
