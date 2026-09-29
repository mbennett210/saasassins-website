import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDismissTap } from '../hooks/useDismissTap';
import { useDispatch, useStore } from '../store';
import { useFromHere } from '../hooks/useFromHere';
import { useIsMobile } from '../hooks/useIsMobile';
import { ACTIONS } from '../store/reducer';
import { newId } from '../lib/ids';
import { selectConversationsForContact, selectContactRoleFlags } from '../store/selectors';
import { isDoNotContact } from '../lib/contactConsent';
import { useToast } from './Toast';
import Avatar from './Avatar';
import Icon from './Icon';
import Badge from './Badge';
import MobileSheet from './MobileSheet';

// The "Message" action on the customer (ClientDetail) header. Instead of silently
// jumping to whoever is the primary contact, it asks WHO to message: a popover that
// drops from the button (down + left, since the button sits top-right) listing THIS
// company's contacts with their role + reachability. Picking one opens their most
// recent SMS/email thread, or starts one on the channel we can reach them on. On
// mobile it's a bottom sheet (THEME_CLEANSPACE R9), matching KeyStatusMenu.
export default function MessageContactMenu({ contacts, clientId, disabled = false }) {
  const state = useStore();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const nav = useFromHere();
  const toast = useToast();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  // Desktop popover dismiss (click-outside / Escape). The mobile sheet handles its
  // own dismissal.
  useDismissTap({ open: open && !isMobile, ref: wrapRef, onDismiss: () => setOpen(false) });

  // Primary contact first — the most-likely target sits at the top of the list.
  const ordered = useMemo(() => {
    const list = (contacts || []).slice();
    list.sort((a, b) => {
      const ra = selectContactRoleFlags(state, a).primary ? 1 : 0;
      const rb = selectContactRoleFlags(state, b).primary ? 1 : 0;
      return rb - ra;
    });
    return list;
  }, [contacts, state]);

  const pick = (contact) => {
    setOpen(false);
    // Reuse the person's most recent SMS/email thread if one exists; otherwise start
    // one on the channel we can reach them on (phone -> text, else email). Dedupes
    // rather than spawning a parallel thread. Mirrors NewConversationModal.handlePick.
    const existing = selectConversationsForContact(state, contact.id)
      .filter((c) => c.channel === 'sms' || c.channel === 'email')
      .slice()
      .sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt))[0];
    if (existing) { navigate(`/messaging/${existing.id}`, { state: nav }); return; }
    const channel = contact.phone ? 'sms' : contact.email ? 'email' : 'sms';
    const id = newId('cv');
    dispatch({
      type: ACTIONS.ADD_CONVERSATION,
      conversation: { id, channel, contactId: contact.id, clientId: contact.companyId || clientId || null, title: null },
    });
    toast.success(`Started a ${channel === 'sms' ? 'text' : 'email'} thread with ${contact.firstName} ${contact.lastName}`);
    navigate(`/messaging/${id}`, { state: nav });
  };

  const rows = ordered.length === 0 ? (
    <div className="msgmenu-empty">No contacts yet. Add one on the Contacts tab.</div>
  ) : ordered.map((c) => {
    const roles = selectContactRoleFlags(state, c);
    const hasPhone = Boolean(c.phone);
    const hasEmail = Boolean(c.email);
    const initials = `${(c.firstName[0] || '').toUpperCase()}${(c.lastName[0] || '').toUpperCase()}`;
    const noRole = !roles.primary && !roles.billing && !roles.site;
    return (
      <button key={c.id} type="button" className="msgmenu-row" onClick={() => pick(c)} role="menuitem">
        <Avatar initials={initials} variant={(c.id.length % 5) + 1} size="sm" />
        <span className="msgmenu-main">
          <span className="msgmenu-name">{c.firstName} {c.lastName}</span>
          <span className="msgmenu-sub">
            {roles.primary && <span className="msgmenu-role">Primary</span>}
            {roles.billing && <span className="msgmenu-role">Billing</span>}
            {roles.site && <span className="msgmenu-role">Location</span>}
            {noRole && c.title && <span className="msgmenu-title">{c.title}</span>}
            {isDoNotContact(c) && <Badge variant="red">DNC</Badge>}
          </span>
        </span>
        <span className="msgmenu-chan">
          <span className={`msgmenu-ic ${hasPhone ? 'on' : 'off'}`} title={hasPhone ? 'Reachable by text' : 'No phone on file'}>
            <Icon name="phone" size={15} />
          </span>
          <span className={`msgmenu-ic ${hasEmail ? 'on' : 'off'}`} title={hasEmail ? 'Reachable by email' : 'No email on file'}>
            <Icon name="mail" size={15} />
          </span>
        </span>
      </button>
    );
  });

  return (
    <div className="msgmenu" ref={wrapRef}>
      <button
        type="button"
        className="btn btn-success"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="messaging" size={14} />
        Message
        <span className="msgmenu-caret" aria-hidden>▾</span>
      </button>
      {isMobile ? (
        <MobileSheet open={open} onClose={() => setOpen(false)} title="Message a contact">
          <div className="msgmenu-list" role="menu">{rows}</div>
        </MobileSheet>
      ) : (open && (
        <div className="msgmenu-popover" role="menu">
          <div className="msgmenu-head">Message a contact</div>
          <div className="msgmenu-list">{rows}</div>
        </div>
      ))}
    </div>
  );
}
