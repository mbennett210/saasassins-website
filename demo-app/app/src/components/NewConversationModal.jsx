import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import FormField from './FormField';
import ContactPicker from './ContactPicker';
import SnippetPicker from './SnippetPicker';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectContactById, selectConversationsForContact } from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import { useToast } from './Toast';
import { newId } from '../lib/ids';
import { nowIso } from '../lib/dates';

// Channel picker is deliberately SMS + Email only — Phase 2a scope.
// Internal-only conversations are seeded but not creatable from this flow.
const CHANNEL_OPTIONS = [
  { value: 'sms',   label: 'SMS' },
  { value: 'email', label: 'Email' },
];

export default function NewConversationModal({ open, onClose, defaultContactId = null, defaultChannel = 'sms' }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const canStart = usePermission('messaging.startConversation');

  const [contactId, setContactId] = useState(defaultContactId);
  const [channel, setChannel] = useState(defaultChannel);
  const [body, setBody] = useState('');
  const [snippetId, setSnippetId] = useState(null);

  useEffect(() => {
    if (open) {
      setContactId(defaultContactId);
      setChannel(defaultChannel);
      setBody('');
      setSnippetId(null);
    }
  }, [open, defaultContactId, defaultChannel]);

  const contact = contactId ? selectContactById(state, contactId) : null;

  // Dedupe: if the picked contact already has a conversation, offer to jump
  // to it instead of letting the user spawn a duplicate thread.
  const existingThread = useMemo(() => {
    if (!contactId) return null;
    const threads = selectConversationsForContact(state, contactId)
      .slice()
      .sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt));
    return threads[0] || null;
  }, [state, contactId]);

  const canSend = canStart && contact && body.trim().length > 0 && !existingThread;

  const handleInsertSnippet = ({ id, body: snippetBody }) => {
    setSnippetId(id);
    setBody((prev) => (prev ? `${prev}\n${snippetBody}` : snippetBody));
  };

  const handleSend = (e) => {
    e.preventDefault();
    if (!canSend) return;
    const conversationId = newId('cv');
    const sentAt = nowIso();
    dispatch({
      type: ACTIONS.ADD_CONVERSATION,
      conversation: {
        id: conversationId,
        channel,
        contactId: contact.id,
        clientId: contact.companyId || null,
        title: null,
        createdAt: sentAt,
        lastMessageAt: sentAt,
      },
    });
    dispatch({
      type: ACTIONS.ADD_MESSAGE,
      message: {
        conversationId,
        direction: 'out',
        text: body.trim(),
        authorUserId: currentUser?.id || null,
        snippetId,
        sentAt,
      },
    });
    toast.success('Conversation started');
    onClose();
    navigate(`/messaging/${conversationId}`);
  };

  return (
    <Modal open={open} onClose={onClose} title="New conversation">
      <form onSubmit={handleSend}>
        <FormField label="Contact" required>
          <ContactPicker value={contactId} onChange={setContactId} placeholder="Pick a contact…" />
        </FormField>

        {existingThread && (
          <div className="callout callout-warning" style={{ margin: '4px 0 12px' }}>
            <div className="text-sm">
              {contact ? `${contact.firstName} ${contact.lastName}` : 'This contact'} already has an active thread.
              Reuse it instead of starting a new one.
            </div>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              style={{ marginTop: 8 }}
              onClick={() => { onClose(); navigate(`/messaging/${existingThread.id}`); }}
            >
              Open existing thread
            </button>
          </div>
        )}

        <FormField label="Channel" required>
          <div className="segmented">
            {CHANNEL_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={`segmented-btn ${channel === opt.value ? 'active' : ''}`}
                onClick={() => setChannel(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </FormField>

        <FormField label="Message" required>
          <textarea
            className="input"
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={channel === 'email' ? 'Email body…' : 'Text message…'}
          />
        </FormField>

        <div className="flex-row" style={{ gap: 8, marginTop: 4 }}>
          <SnippetPicker channel={channel} onInsert={handleInsertSnippet} />
          {snippetId && <span className="text-xs text-muted">Snippet inserted</span>}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!canSend}>Send & open</button>
        </div>

        {!canStart && (
          <p className="text-xs text-muted" style={{ marginTop: 8 }}>
            You don't have permission to start new conversations.
          </p>
        )}
      </form>
    </Modal>
  );
}
