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
} from '../store/selectors';
import { useToast } from './Toast';
import { ROLES, ROLE_LABELS } from '../lib/roles';
import { sendEmail, buildInviteEmail } from '../lib/email';
import { newId } from '../lib/ids';

const EMPTY = { name: '', email: '', phone: '', role: 'crew' };

export default function AddUserModal({ open, onClose }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const company = selectCompany(state);
  const currentUser = selectCurrentUser(state);
  const emailDefaultFrom = selectEmailDefaultFrom(state);
  const emailDefaultReplyTo = selectEmailDefaultReplyTo(state);

  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setError('');
    setSending(false);
  }, [open]);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const name = form.name.trim();
    const email = form.email.trim().toLowerCase();
    if (!name) { setError('Name is required.'); return; }
    if (!email) { setError('Email is required.'); return; }
    const dup = selectUserByEmail(state, email);
    if (dup) { setError(`Email already in use by ${dup.name}.`); return; }

    const initials = name.split(' ').filter(Boolean).map((p) => p[0]).join('').toUpperCase().slice(0, 2);
    const userId = newId('u');
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
        // Prefer the configured Resend default From; fall back to company
        // email so dev/stub mode still produces sane email metadata before
        // the provider is wired up. The backend re-validates `from` against
        // the verified-domain allowlist when running for real.
        from: emailDefaultFrom || company.email || 'no-reply@example.com',
        subject,
        body,
        // Replies go to the inviter so onboarding questions land with a
        // human, not the system address. The configured Reply-To override
        // wins if set explicitly in Settings → Integrations.
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
      user: { id: userId, name, email, phone: form.phone.trim(), role: form.role, status: 'invited', initials },
    });
    dispatch({
      type: ACTIONS.SEND_INVITATION,
      userId,
      email,
      role: form.role,
      invitedBy: currentUser?.id,
    });
    toast.success(`Invitation sent to ${email}`);
    setSending(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Invite Team Member">
      <form onSubmit={submit}>
        <div className="form-row">
          <FormField
            label="Name"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Jordan Tate"
          />
          <FormField
            label="Email"
            type="email"
            required
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="name@company.com"
          />
        </div>
        {error && <div className="form-error" style={{ marginTop: -8, marginBottom: 10 }}>{error}</div>}
        <div className="form-row">
          <FormField
            label="Phone"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            placeholder="(206) 555-0100"
          />
          <FormField
            label="Role"
            as="select"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
            options={ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
            help="Permissions can be customized per-member after adding."
          />
        </div>
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={sending}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={sending}>
            {sending ? 'Sending…' : 'Send Invite'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
