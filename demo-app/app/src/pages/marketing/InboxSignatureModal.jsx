// Edit the per-inbox profile — the sender name shown in the recipient's "From"
// header and the signature block inserted at the {signature} variable. Both
// are scoped to one marketing inbox, so rotated sends always identify as the
// mailbox that actually sent the email.

import { useState } from 'react';
import { useDispatch } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { useToast } from '../../components/Toast';
import Modal from '../../components/Modal';
import FormField from '../../components/FormField';

export default function InboxSignatureModal({ open, inbox, onClose }) {
  const dispatch = useDispatch();
  const toast = useToast();
  // Seeded once on mount. The parent keys this modal by inbox id, so opening
  // it for a different inbox remounts it with a fresh draft — React's "reset
  // state with a key" pattern, no syncing effect needed.
  const [senderName, setSenderName] = useState(() => inbox?.senderName || '');
  const [signatureDraft, setSignatureDraft] = useState(() => inbox?.signature || '');

  function handleSave() {
    if (!inbox) return;
    dispatch({
      type: ACTIONS.UPDATE_MARKETING_INBOX,
      id: inbox.id,
      patch: {
        senderName: senderName.trim(),
        signature: signatureDraft,
      },
    });
    toast.success(`Profile saved for ${inbox.email}`);
    onClose?.();
  }

  return (
    <Modal open={open} onClose={onClose} title="Inbox profile" size="md">
      <p className="marketing-connect-copy">
        Set how this mailbox identifies itself. The sender name appears in the
        recipient&apos;s &quot;From&quot; header (e.g. <em>Jessica Sanders
        &lt;jessica@…&gt;</em>); the signature is inserted wherever a sequence
        step&apos;s body carries the {' '}{'{signature}'}{' '} variable.
      </p>
      <FormField
        label="Sender name"
        name="inbox-sender-name"
        value={senderName}
        onChange={(e) => setSenderName(e.target.value)}
        placeholder="Jessica Sanders"
        help="Shown as the From name on every send from this inbox. Leave empty to send as the bare email address."
      />
      <FormField
        label="Signature"
        name="inbox-signature"
        as="textarea"
        rows={8}
        value={signatureDraft}
        onChange={(e) => setSignatureDraft(e.target.value)}
        placeholder={'—\n{senderName}\n{senderCompany} · {senderPhone}'}
        help="Plain text or HTML. Variables like {senderName}, {senderCompany} and {senderPhone} resolve inside it too. Leave empty for no signature."
      />
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={handleSave}>Save profile</button>
      </div>
    </Modal>
  );
}
