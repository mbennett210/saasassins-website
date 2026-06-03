import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Avatar from './Avatar';
import Badge, { statusBadgeVariant } from './Badge';
import ContactPicker from './ContactPicker';
import ContactFocusModal from './ContactFocusModal';
import Select from './Select';
import EmptyState from './EmptyState';
import Icon from './Icon';
import TagChip from './TagChip';
import { useToast } from './Toast';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import {
  selectClientById, selectInvoicesForContact, selectJobsForClient,
  selectSynthesizedActivityForContact, selectTagById, selectUserById,
  selectPipelineStages, selectOtherParticipant,
  invoiceTotal, deriveInvoiceStatus,
} from '../store/selectors';
import { ROLE_LABELS } from '../lib/roles';
import { fmtDate, fmtRelative, money } from '../lib/dates';

const LIFECYCLE_VARIANTS = {
  lead: 'amber',
  prospect: 'blue',
  client: 'green',
  vendor: 'slate',
};


// Tab keys are internal — labels are what the user sees.
// "history" = synthesized timeline of events (was "Activities" before).
// "activities" = related records (invoices, jobs) (was "Related" before).
const TABS = [
  { key: 'contact',    label: 'Contact' },
  { key: 'activities', label: 'Activities' },
  { key: 'notes',      label: 'Notes' },
];

// Build the inline-edit form shape from a contact. Kept outside the component so the
// same snapshot logic drives both initial state and dirty-diff comparison.
function buildForm(contact) {
  if (!contact) return null;
  return {
    email: contact.email || '',
    phone: contact.phone || '',
    title: contact.title || '',
    department: contact.customFields?.department || '',
    address: contact.address || contact.customFields?.address || '',
    stage: contact.stage || '',
    dealValue: contact.dealValue ? String(contact.dealValue) : '',
    expectedCloseDate: contact.expectedCloseDate ? contact.expectedCloseDate.slice(0, 10) : '',
  };
}

// Details card with inline-editable fields. Every field edits in place — no breakout.
// A Save bar only appears when a field has actually changed from the stored contact.
// Conversation-scoped actions (Change contact / Unlink) live in an overflow menu in the
// context-panel HEAD — not here — so this card stays focused on the contact record itself.
function ContactLinkCard({ contact, company, onLinkContact, picking, onCancelPicking, nav }) {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const stages = selectPipelineStages(state);

  const canEdit = usePermission('contacts.edit');

  const [form, setForm] = useState(() => buildForm(contact));
  // Note: we don't reset `form` inside an effect — callers mount this component
  // with key={contact.id} so switching threads remounts it with a fresh form.

  if (!contact) {
    return (
      <div className="context-card">
        <div className="context-card-title-row">
          <div className="context-card-title">Contact</div>
        </div>
        <div className="text-xs text-muted" style={{ marginBottom: 8 }}>
          This conversation isn't linked to a contact yet.
        </div>
        <ContactPicker
          value={null}
          onChange={(id) => onLinkContact?.(id || null)}
          placeholder="Link a contact…"
          allowClear={false}
        />
      </div>
    );
  }

  if (picking) {
    // Swap-linked-contact mode. Triggered from the overflow menu in the context head.
    return (
      <div className="context-card">
        <div className="context-card-title-row">
          <div className="context-card-title">Change linked contact</div>
          <button type="button" className="linklike text-xs" onClick={() => onCancelPicking?.()}>
            Cancel
          </button>
        </div>
        <ContactPicker
          value={contact.id}
          onChange={(id) => { onLinkContact?.(id || null); onCancelPicking?.(); }}
          companyId={company?.id || null}
          placeholder="Pick a different contact…"
        />
      </div>
    );
  }

  const original = buildForm(contact);
  const isDirty = Object.keys(form).some((k) => form[k] !== original[k]);

  const up = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }));

  const handleSave = () => {
    const patch = {};
    if (form.email !== original.email) patch.email = form.email.trim();
    if (form.phone !== original.phone) patch.phone = form.phone.trim();
    if (form.title !== original.title) patch.title = form.title.trim();
    if (form.address !== original.address) patch.address = form.address.trim();
    if (form.dealValue !== original.dealValue) {
      patch.dealValue = form.dealValue === '' ? null : Number(form.dealValue) || null;
    }
    if (form.expectedCloseDate !== original.expectedCloseDate) {
      patch.expectedCloseDate = form.expectedCloseDate
        ? new Date(form.expectedCloseDate + 'T12:00:00').toISOString()
        : null;
    }
    if (form.department !== original.department) {
      patch.customFields = { ...(contact.customFields || {}), department: form.department.trim() };
    }

    // Client-side email uniqueness check — the reducer silently drops duplicates, so
    // we surface a clear error instead of letting the save appear to succeed.
    if (patch.email) {
      const lower = patch.email.toLowerCase();
      const dup = (state.contacts || []).find(
        (c) => c.id !== contact.id && (c.email || '').toLowerCase() === lower
      );
      if (dup) {
        toast.error(`${dup.firstName} ${dup.lastName} already uses ${patch.email}`);
        return;
      }
    }

    if (Object.keys(patch).length > 0) {
      dispatch({ type: ACTIONS.UPDATE_CONTACT, id: contact.id, patch });
    }
    if (form.stage !== original.stage) {
      // SET_CONTACT_STAGE also logs activity — only dispatch when stage actually changed.
      dispatch({ type: ACTIONS.SET_CONTACT_STAGE, id: contact.id, stage: form.stage });
    }
    toast.success('Contact updated');
  };

  const handleDiscard = () => setForm(buildForm(contact));

  const showPipelineFields = contact.lifecycle === 'lead' || contact.lifecycle === 'prospect' || Boolean(contact.stage);

  return (
    <div className="context-card">
      <div className="context-card-title-row">
        <div className="context-card-title">Details</div>
      </div>

      <dl className="context-dl context-dl-editable">
        <div>
          <dt>Email</dt>
          <dd>
            <input className="inline-input" type="email" value={form.email} onChange={up('email')} disabled={!canEdit} />
          </dd>
        </div>
        <div>
          <dt>Phone</dt>
          <dd>
            <input className="inline-input" type="tel" value={form.phone} onChange={up('phone')} disabled={!canEdit} placeholder="—" />
          </dd>
        </div>
        <div>
          <dt>Title</dt>
          <dd>
            <input className="inline-input" value={form.title} onChange={up('title')} disabled={!canEdit} placeholder="—" />
          </dd>
        </div>
        <div>
          <dt>Dept.</dt>
          <dd>
            <input className="inline-input" value={form.department} onChange={up('department')} disabled={!canEdit} placeholder="—" />
          </dd>
        </div>
        <div>
          <dt>Company</dt>
          <dd>{company ? <Link to={`/clients/${company.id}`} state={nav}>{company.name}</Link> : <span className="text-muted">—</span>}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>
            <input className="inline-input" value={form.address} onChange={up('address')} disabled={!canEdit} placeholder="—" />
          </dd>
        </div>
        {showPipelineFields && (
          <>
            <div>
              <dt>Stage</dt>
              <dd>
                <Select
                  ariaLabel="Stage"
                  value={form.stage || ''}
                  onChange={(v) => up('stage')({ target: { value: v } })}
                  disabled={!canEdit}
                  options={[{ value: '', label: '—' }, ...stages.map((s) => ({ value: s.key, label: s.label }))]}
                />
              </dd>
            </div>
            <div>
              <dt>Deal value</dt>
              <dd>
                <input
                  className="inline-input" type="number" min="0" step="0.01"
                  value={form.dealValue} onChange={up('dealValue')} disabled={!canEdit}
                  placeholder="—"
                />
              </dd>
            </div>
            <div>
              <dt>Close date</dt>
              <dd>
                <input
                  className="inline-input" type="date"
                  value={form.expectedCloseDate} onChange={up('expectedCloseDate')} disabled={!canEdit}
                />
              </dd>
            </div>
          </>
        )}
        <div><dt>Last activity</dt><dd><span className="text-muted">{fmtRelative(contact.updatedAt || contact.createdAt)}</span></dd></div>
        <div><dt>Created</dt><dd><span className="text-muted">{fmtDate(contact.createdAt)}</span></dd></div>
      </dl>

      {isDirty && (
        <div className="context-card-save-row">
          <button type="button" className="btn btn-outline btn-sm" onClick={handleDiscard}>Discard</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleSave}>Save</button>
        </div>
      )}
    </div>
  );
}

function DmContextPanel({ conversation }) {
  const state = useStore();
  const { currentUser } = useAuth();
  const other = selectOtherParticipant(state, conversation, currentUser?.id);

  return (
    <aside className="context-pane">
      <div className="context-head">
        {other ? (
          <Avatar initials={other.initials} variant={other.avatar} size="md" />
        ) : (
          <Avatar initials="?" variant={1} size="md" />
        )}
        <div className="context-head-text">
          <div className="context-head-name">{other ? other.name : 'Unknown user'}</div>
          <div className="text-xs text-muted">
            {other ? (ROLE_LABELS[other.role] || other.role) : 'Participant not found'}
          </div>
          <div className="context-head-badges">
            <Badge variant="blue">Direct Message</Badge>
            {other?.status === 'disabled' && <Badge variant="slate">Inactive</Badge>}
          </div>
        </div>
      </div>
      <div className="context-body">
        <div className="context-card">
          <div className="context-card-title">Participant</div>
          {other ? (
            <dl className="context-dl">
              <div><dt>Name</dt><dd>{other.name}</dd></div>
              <div><dt>Role</dt><dd>{ROLE_LABELS[other.role] || other.role}</dd></div>
              <div><dt>Email</dt><dd>{other.email || <span className="text-muted">—</span>}</dd></div>
              <div><dt>Phone</dt><dd>{other.phone || <span className="text-muted">—</span>}</dd></div>
              <div><dt>Status</dt><dd>{other.status === 'active' ? 'Active' : (other.status || '—')}</dd></div>
            </dl>
          ) : (
            <div className="text-xs text-muted">
              The other participant could not be found. They may have been removed.
            </div>
          )}
        </div>
        <div className="context-card">
          <div className="context-card-title">Privacy</div>
          <div className="text-xs text-muted">
            Direct messages are visible only to the two participants. Owners and admins
            cannot read this thread unless they're a participant.
          </div>
        </div>
      </div>
    </aside>
  );
}

function InternalContextPanel({ conversation }) {
  const state = useStore();
  const dispatch = useDispatch();
  const [adding, setAdding] = useState(false);

  // Source of truth is conversation.participantUserIds — deriving from message
  // authors would miss members who haven't posted yet (incl. anyone just added).
  const participantIds = Array.isArray(conversation.participantUserIds)
    ? conversation.participantUserIds
    : [];
  const participants = participantIds
    .map((id) => selectUserById(state, id))
    .filter(Boolean);
  const eligible = (state.users || [])
    .filter((u) => u.status === 'active' && !participantIds.includes(u.id));

  const onAdd = (userId) => {
    dispatch({
      type: ACTIONS.ADD_THREAD_PARTICIPANT,
      conversationId: conversation.id,
      userId,
    });
    setAdding(false);
  };

  return (
    <aside className="context-pane">
      <div className="context-head">
        <h3 className="context-title">{conversation.title || 'Team discussion'}</h3>
        <div className="text-xs text-muted">Internal-only thread — not visible to clients.</div>
      </div>
      <div className="context-body">
        <div className="context-card">
          <div className="context-card-title">Participants</div>
          {participants.length === 0 ? (
            <div className="text-xs text-muted">No participants yet.</div>
          ) : (
            <ul className="context-participants">
              {participants.map((u) => (
                <li key={u.id} className="context-participant">
                  <Avatar initials={u.initials} variant={u.avatar} size="sm" />
                  <span>{u.name}</span>
                </li>
              ))}
            </ul>
          )}

          {adding ? (
            <div className="participant-add-picker">
              {eligible.length === 0 ? (
                <div className="text-xs text-muted">Everyone is already in this thread.</div>
              ) : (
                <ul className="participant-add-list">
                  {eligible.map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        className="participant-add-row"
                        onClick={() => onAdd(u.id)}
                      >
                        <Avatar initials={u.initials} variant={u.avatar} size="sm" />
                        <span className="participant-add-row-name">{u.name}</span>
                        <span className="participant-add-row-role text-xs text-muted">
                          {ROLE_LABELS[u.role]}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <button
                type="button"
                className="btn-link participant-add-cancel"
                onClick={() => setAdding(false)}
              >
                Cancel
              </button>
            </div>
          ) : eligible.length > 0 ? (
            <button
              type="button"
              className="btn btn-outline btn-sm participant-add-trigger"
              onClick={() => setAdding(true)}
            >
              Add participant
            </button>
          ) : (
            <div className="text-xs text-muted participant-add-empty">
              Everyone is already in this thread.
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

export default function ConversationContextPanel({ conversation, contact, onLinkContact }) {
  const state = useStore();
  const nav = useFromHere();
  const [tab, setTab] = useState('contact');
  const [focusOpen, setFocusOpen] = useState(false);
  // Conversation-scoped actions live on the panel HEAD, not inside the details card.
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickingContact, setPickingContact] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onClick = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // Hooks must run on every render — compute activity/invoices/jobs up front,
  // even when we'll fall through to an early return below.
  const contactId = contact?.id || null;
  const companyId = contact?.companyId || null;
  const activity = useMemo(
    () => (contactId ? selectSynthesizedActivityForContact(state, contactId).slice(0, 10) : []),
    [state, contactId]
  );
  const invoices = useMemo(
    () => (contactId ? selectInvoicesForContact(state, contactId) : []),
    [state, contactId]
  );
  const jobs = useMemo(
    () => (companyId ? selectJobsForClient(state, companyId) : []),
    [state, companyId]
  );

  if (!conversation) {
    return (
      <aside className="context-pane context-pane-empty">
        <EmptyState message="Select a conversation to see contact details." />
      </aside>
    );
  }

  // DM threads use a 1:1-participant panel (other user's profile + privacy notice).
  if (conversation.channel === 'dm') {
    return <DmContextPanel conversation={conversation} />;
  }

  // Internal threads use a different panel entirely (participants list, no contact surface).
  if (conversation.channel === 'internal') {
    return <InternalContextPanel conversation={conversation} />;
  }

  const company = contact?.companyId ? selectClientById(state, contact.companyId) : null;

  const initials = contact
    ? (`${(contact.firstName || '')[0] || ''}${(contact.lastName || '')[0] || ''}`.toUpperCase() || 'C')
    : '?';
  const avatarVariant = ((contact?.id?.length || 0) % 5) + 1;

  // When no contact is linked, synthesize a neutral header from the conversation itself.
  const channelLabel = (conversation.channel || '').toUpperCase();
  const unlinkedTitle = conversation.title
    || conversation.handle
    || (channelLabel ? `${channelLabel} conversation` : 'Unlinked conversation');

  return (
    <aside className="context-pane">
      <div className="context-head">
        <Avatar initials={initials} variant={avatarVariant} size="md" />
        <div className="context-head-text">
          {contact ? (
            <>
              <Link to={`/contacts/${contact.id}`} state={nav} className="context-head-name">
                {contact.firstName} {contact.lastName}
              </Link>
              <div className="text-xs text-muted">{contact.title || '—'}</div>
              <div className="context-head-badges">
                <Badge variant={LIFECYCLE_VARIANTS[contact.lifecycle] || 'slate'}>
                  {contact.lifecycle.charAt(0).toUpperCase() + contact.lifecycle.slice(1)}
                </Badge>
              </div>
            </>
          ) : (
            <>
              <div className="context-head-name">{unlinkedTitle}</div>
              <div className="text-xs text-muted">No contact linked</div>
              <div className="context-head-badges">
                <Badge variant="slate">Unlinked</Badge>
              </div>
            </>
          )}
        </div>
        {contact && (
          <div className="context-head-actions">
            <div className="context-head-menu-wrap" ref={menuRef}>
              <button
                type="button"
                className="context-head-icon-btn"
                aria-label="Conversation link options"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                title="Conversation link options"
                onClick={() => setMenuOpen((v) => !v)}
              >
                <Icon name="dots" size={16} />
              </button>
              {menuOpen && (
                <div className="context-head-menu" role="menu">
                  <button
                    type="button"
                    role="menuitem"
                    className="context-head-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      setTab('contact');
                      setPickingContact(true);
                    }}
                  >
                    <Icon name="user" size={14} />
                    <span>Change contact</span>
                  </button>
                </div>
              )}
            </div>
            <button
              type="button"
              className="context-head-icon-btn"
              aria-label="Open contact in focus view"
              title="Open contact in focus view"
              onClick={() => setFocusOpen(true)}
            >
              <Icon name="expand" size={16} />
            </button>
          </div>
        )}
      </div>

      <div className="tab-container tab-container-line context-tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="context-body">
        {tab === 'contact' && (
          <>
            <ContactLinkCard
              key={contact?.id || 'unlinked'}
              contact={contact}
              company={company}
              onLinkContact={onLinkContact}
              picking={pickingContact}
              onCancelPicking={() => setPickingContact(false)}
              nav={nav}
            />
            {contact && (
              <div className="context-card">
                <div className="context-card-title">Tags</div>
                <div className="flex-row" style={{ gap: 4 }}>
                  {(contact.tagIds || []).length === 0 ? (
                    <span className="text-xs text-muted">No tags</span>
                  ) : (contact.tagIds || []).map((tid) => {
                    const t = selectTagById(state, tid);
                    return t ? <TagChip key={tid} tag={t} /> : null;
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'history' && (
          <div className="context-card">
            {activity.length === 0 ? (
              <EmptyState message={contact ? 'No activity yet.' : 'Link a contact to see their activity.'} />
            ) : (
              <ul className="context-activity">
                {activity.map((a) => (
                  <li key={a.id} className={`context-activity-item kind-${a.kind}`}>
                    <div className="context-activity-kind">{a.kind}</div>
                    <div className="context-activity-body">
                      <div>{a.body}</div>
                      <div className="text-xs text-muted">{fmtRelative(a.occurredAt)}</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === 'activities' && (
          <>
            <div className="context-card">
              <div className="context-card-title">Invoices ({invoices.length})</div>
              {invoices.length === 0 ? (
                <div className="text-xs text-muted">{contact ? 'No invoices linked.' : 'Link a contact to see related invoices.'}</div>
              ) : (
                <ul className="context-related">
                  {invoices.slice(0, 5).map((inv) => {
                    const st = deriveInvoiceStatus(inv);
                    return (
                      <li key={inv.id}>
                        <Link to={`/invoices/${inv.id}`} state={nav} className="context-related-row">
                          <span className="context-related-primary">{inv.id}</span>
                          <span className="context-related-sub">{fmtDate(inv.issueDate)} · {money(invoiceTotal(inv))}</span>
                          <Badge variant={statusBadgeVariant(st === 'paid' ? 'Paid' : st === 'overdue' ? 'Overdue' : 'Pending')}>
                            {st.charAt(0).toUpperCase() + st.slice(1)}
                          </Badge>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="context-card">
              <div className="context-card-title">Jobs ({jobs.length})</div>
              {jobs.length === 0 ? (
                <div className="text-xs text-muted">{contact ? "No jobs linked via this contact's client." : 'Link a contact to see related jobs.'}</div>
              ) : (
                <ul className="context-related">
                  {jobs.slice(0, 5).map((j) => (
                    <li key={j.id}>
                      <Link to={`/schedule/${j.id}`} state={nav} className="context-related-row">
                        <span className="context-related-primary">{fmtDate(j.startAt)}</span>
                        <span className="context-related-sub">{state.services.find((s) => s.id === j.serviceId)?.name || 'Service'}</span>
                        <Badge variant={statusBadgeVariant(j.status === 'done' ? 'Confirmed' : j.status === 'in_progress' ? 'In Progress' : 'Pending')}>
                          {j.status.replace('_', ' ')}
                        </Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}

        {tab === 'notes' && (
          <NotesCard key={contact?.id || 'unlinked-notes'} contact={contact} />
        )}
      </div>

      <ContactFocusModal
        open={focusOpen}
        onClose={() => setFocusOpen(false)}
        contactId={contact?.id || null}
      />
    </aside>
  );
}

// Notes tab — compact append-then-scroll layout. Uses the same APPEND_CONTACT_NOTE
// action the full Contact page uses, so notes stay consistent across surfaces.
function NotesCard({ contact }) {
  const dispatch = useDispatch();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canEditThis = usePermission('contacts.edit');
  const [draft, setDraft] = useState('');

  if (!contact) {
    return (
      <div className="context-card">
        <div className="context-card-title">Notes</div>
        <div className="text-xs text-muted">Link a contact to add notes.</div>
      </div>
    );
  }

  const append = () => {
    const text = draft.trim();
    if (!text) return;
    dispatch({
      type: ACTIONS.APPEND_CONTACT_NOTE,
      id: contact.id,
      text,
      authorUserId: currentUser?.id,
    });
    setDraft('');
    toast.success('Note added');
  };

  const onKeyDown = (e) => {
    // Ctrl/Cmd+Enter to append — keeps Enter free for newlines.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      append();
    }
  };

  return (
    <div className="context-card context-notes-card">
      <div className="context-card-title-row">
        <div className="context-card-title">Notes</div>
        {draft.trim() && (
          <span className="text-xs text-muted">⌘↵ to save</span>
        )}
      </div>

      {canEditThis && (
        <>
          <textarea
            className="input notes-compose"
            rows={3}
            placeholder="Call recap, follow-up, decision…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="notes-compose-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!draft.trim()}
              onClick={append}
            >
              Append note
            </button>
          </div>
        </>
      )}

      {contact.notes ? (
        <pre className="notes-history">{contact.notes}</pre>
      ) : (
        <div className="text-xs text-muted" style={{ padding: '8px 0' }}>
          No notes yet. Notes are timestamped and appended in order.
        </div>
      )}
    </div>
  );
}
