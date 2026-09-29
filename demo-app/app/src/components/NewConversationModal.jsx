import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Modal from './Modal';
import Avatar from './Avatar';
import Icon from './Icon';
import Badge from './Badge';
import { useDispatch, useStore } from '../store';
import { useAuth } from '../hooks/useAuth';
import { ACTIONS } from '../store/reducer';
import {
  selectVisibleContactsFor,
  selectContactById,
  selectConversationsForContact,
} from '../store/selectors';
import { isDoNotContact } from '../lib/contactConsent';
import { usePermission } from '../hooks/usePermission';
import { useToast } from './Toast';
import { newId } from '../lib/ids';

// Page the visible book: 20 on open, +10 per "Load more" (at the bottom of the list).
const INITIAL = 20;
const STEP = 10;

// The "New conversation" picker. A THIN clickthrough: search the whole book (by
// name, company, or email), then click a person to open their thread — no channel
// step here, because the thread composer already switches SMS<->Email in-thread
// (ConversationMessagePanel) and ADD_CONVERSATION defaults a channel. Reachability
// (phone/email on file) is shown per row so the choice is informed; a Do-Not-Contact
// contact is tagged (the thread itself carries the DNC guard). Contacts with no phone
// AND no email still show and remain clickable — the thread is the dead-end, not this.
export default function NewConversationModal({ open, onClose, defaultContactId = null }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const canStart = usePermission('messaging.startConversation');

  // Crew see only contacts of clients they're assigned to; managers see all.
  const contacts = useMemo(() => selectVisibleContactsFor(state, currentUser), [state, currentUser]);
  // company name lookup (contact.companyId -> client.name), built once per client list.
  const clientNameById = useMemo(
    () => new Map((state.clients || []).map((c) => [c.id, c.name])),
    [state.clients],
  );

  const [query, setQuery] = useState('');
  const [shown, setShown] = useState(INITIAL);
  const listRef = useRef(null);

  // Opening from a company page pre-targets its primary contact: seed the search
  // with that person's name so they surface at the top (the user still clicks).
  useEffect(() => {
    if (!open) return;
    const dc = defaultContactId ? selectContactById(state, defaultContactId) : null;
    setQuery(dc ? `${dc.firstName} ${dc.lastName}` : '');
    setShown(INITIAL);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts
      .map((c) => ({ contact: c, companyName: clientNameById.get(c.companyId) || '' }))
      .filter(({ contact, companyName }) => {
        if (!q) return true;
        const name = `${contact.firstName} ${contact.lastName}`.toLowerCase();
        return (
          name.includes(q) ||
          (contact.email || '').toLowerCase().includes(q) ||
          companyName.toLowerCase().includes(q) ||
          (contact.title || '').toLowerCase().includes(q)
        );
      });
  }, [contacts, clientNameById, query]);

  const onSearchChange = (e) => {
    setQuery(e.target.value);
    setShown(INITIAL);
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  const visible = results.slice(0, shown);
  const hasMore = shown < results.length;

  const handlePick = (contact) => {
    if (!canStart) return;
    // Open the contact's most recent SMS/email thread if one exists; otherwise
    // create a new one on the channel we CAN reach them on (phone -> sms, else
    // email). Dedupes rather than spawning a parallel thread per click.
    const existing = selectConversationsForContact(state, contact.id)
      .filter((c) => c.channel === 'sms' || c.channel === 'email')
      .slice()
      .sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt))[0];
    if (existing) {
      onClose();
      navigate(`/messaging/${existing.id}`);
      return;
    }
    const channel = contact.phone ? 'sms' : contact.email ? 'email' : 'sms';
    const conversationId = newId('cv');
    dispatch({
      type: ACTIONS.ADD_CONVERSATION,
      conversation: {
        id: conversationId,
        channel,
        contactId: contact.id,
        clientId: contact.companyId || null,
        title: null,
      },
    });
    toast.success('Conversation started');
    onClose();
    navigate(`/messaging/${conversationId}`);
  };

  return (
    <Modal open={open} onClose={onClose} title="New conversation" size="convo">
      <div className="newconv">
        <label className="form-label">Contact</label>
        <div className="newconv-combo">
          <div className="newconv-search">
            <Icon name="search" size={15} />
            <input
              className="newconv-search-input"
              placeholder="Search by name, company, or email…"
              value={query}
              onChange={onSearchChange}
              autoFocus
            />
          </div>
          <div className="newconv-list" ref={listRef}>
            {results.length === 0 ? (
              <div className="newconv-empty">No contacts match</div>
            ) : (
              <>
                {visible.map(({ contact, companyName }) => {
                  const hasPhone = Boolean(contact.phone);
                  const hasEmail = Boolean(contact.email);
                  const initials = `${(contact.firstName[0] || '').toUpperCase()}${(contact.lastName[0] || '').toUpperCase()}`;
                  return (
                    <button
                      key={contact.id}
                      type="button"
                      className="newconv-row"
                      onClick={() => handlePick(contact)}
                      disabled={!canStart}
                    >
                      <Avatar initials={initials} variant={(contact.id.length % 5) + 1} size="sm" />
                      <span className="newconv-main">
                        <span className="newconv-name">{contact.firstName} {contact.lastName}</span>
                        {contact.title && <span className="newconv-title">{contact.title}</span>}
                      </span>
                      <span className="newconv-chan">
                        <span className={`newconv-ic ${hasPhone ? 'on' : 'off'}`} title={hasPhone ? 'Reachable by SMS' : 'No phone on file'}>
                          <Icon name="phone" size={16} />
                        </span>
                        <span className={`newconv-ic ${hasEmail ? 'on' : 'off'}`} title={hasEmail ? 'Reachable by email' : 'No email on file'}>
                          <Icon name="mail" size={16} />
                        </span>
                      </span>
                      <span className="newconv-co" title={companyName}>
                        {companyName ? (
                          <>
                            <Icon name="building" size={13} />
                            <span>{companyName}</span>
                          </>
                        ) : null}
                      </span>
                      <span className="newconv-dnc">
                        {isDoNotContact(contact) && <Badge variant="red">DNC</Badge>}
                      </span>
                    </button>
                  );
                })}
                <div className="newconv-foot">
                  {hasMore && (
                    <button type="button" className="btn btn-outline" onClick={() => setShown((n) => n + STEP)}>
                      Load more
                    </button>
                  )}
                  <div className="newconv-count">
                    Showing {Math.min(shown, results.length)} of {results.length}{query.trim() ? ' matches' : ' contacts'}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
        {!canStart && (
          <p className="text-xs text-muted" style={{ marginTop: 8 }}>
            You don't have permission to start new conversations.
          </p>
        )}
      </div>
    </Modal>
  );
}
