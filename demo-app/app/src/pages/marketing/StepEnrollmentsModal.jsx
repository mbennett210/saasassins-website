// Read-only roster of the contacts at one point in a sequence's flow — a step
// (contacts currently waiting to receive that email), or the 'replied' /
// 'completed' buckets. Opened from the per-step count chips in
// SequenceEditorPanel. Purely a "who's here" view — no mutations.

import { useMemo } from 'react';
import { useStore } from '../../store';
import { selectEnrollmentsInBucket, selectContacts } from '../../store/selectors';
import Modal from '../../components/Modal';
import Avatar from '../../components/Avatar';
import Badge from '../../components/Badge';

function fullName(c) {
  return `${c.firstName || ''} ${c.lastName || ''}`.trim();
}
function initials(c) {
  const a = (c.firstName || '').trim()[0] || '';
  const b = (c.lastName || '').trim()[0] || '';
  return (a + b).toUpperCase() || '?';
}
function avatarVariant(id) {
  return ((id || '').length % 5) + 1;
}

function statusBadge(e) {
  if (e.repliedAt || e.status === 'replied') return <Badge variant="amber">Replied</Badge>;
  if (e.status === 'completed') return <Badge variant="slate">Completed</Badge>;
  return <Badge variant="blue">Waiting</Badge>;
}

export default function StepEnrollmentsModal({ sequenceId, bucket, stepCount, title, onClose }) {
  const state = useStore();
  const contacts = selectContacts(state);
  const contactsById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const enrollments = useMemo(
    () => (sequenceId != null && bucket != null
      ? selectEnrollmentsInBucket(state, sequenceId, bucket, stepCount)
      : []),
    [state, sequenceId, bucket, stepCount]
  );
  const rows = useMemo(
    () => enrollments.map((e) => ({ e, c: contactsById.get(e.contactId) })).filter((r) => r.c),
    [enrollments, contactsById]
  );

  return (
    <Modal open onClose={onClose} title={title || 'Contacts'} size="md">
      <div className="step-enroll-list">
        {rows.length === 0 && (
          <div className="step-enroll-empty">No contacts here right now.</div>
        )}
        {rows.map(({ e, c }) => (
          <div key={e.id} className="step-enroll-row">
            <span className="enroll-cell-contact">
              <Avatar initials={initials(c)} variant={avatarVariant(c.id)} size="sm" />
              <span className="enroll-contact-txt">
                <span className="enroll-contact-name">{fullName(c) || 'Unnamed contact'}</span>
                <span className="enroll-contact-mail">{c.email || 'No email'}</span>
              </span>
            </span>
            {statusBadge(e)}
          </div>
        ))}
      </div>
      <div className="step-enroll-foot">
        <span><strong>{rows.length}</strong> {rows.length === 1 ? 'contact' : 'contacts'}</span>
        <button type="button" className="btn btn-outline" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
