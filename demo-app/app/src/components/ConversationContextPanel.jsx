import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Avatar from './Avatar';
import Badge, { statusBadgeVariant } from './Badge';
import ContactPicker from './ContactPicker';
import EmptyState from './EmptyState';
import TagChip from './TagChip';
import { useToast } from './Toast';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { usePermission } from '../hooks/usePermission';
import { useAuth } from '../hooks/useAuth';
import {
  selectClientById, selectInvoicesForContact, selectJobsForClient,
  selectSynthesizedActivityForContact, selectTagById, selectUserById,
  selectOtherParticipant,
  invoiceTotal, deriveInvoiceStatus,
} from '../store/selectors';
import { roleLabel, compareUsersByName } from '../lib/roles';
import { capOptions, PICKER_MAX_VISIBLE } from '../lib/pickerOptions';
import PickerCapNote from './PickerCapNote';
import { fmtDate, money } from '../lib/dates';
import { useT } from '../i18n/react';
import { timeShort } from '../i18n/relative';

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
  { key: 'contact',    labelKey: 'messages.ctx.tab.contact' },
  { key: 'activities', labelKey: 'messages.ctx.tab.activities' },
  { key: 'notes',      labelKey: 'messages.ctx.tab.notes' },
];
// Record states, in the reader's language; anything unlisted shows as stored.
const LIFECYCLE_KEYS = {
  lead: 'messages.ctx.lifecycle.lead', prospect: 'messages.ctx.lifecycle.prospect',
  client: 'messages.ctx.lifecycle.client', vendor: 'messages.ctx.lifecycle.vendor',
};
const INVOICE_STATUS_KEYS = {
  paid: 'messages.ctx.invoice.paid', overdue: 'messages.ctx.invoice.overdue',
  pending: 'messages.ctx.invoice.pending', draft: 'messages.ctx.invoice.draft',
};
const JOB_STATUS_KEYS = {
  upcoming: 'messages.ctx.job.upcoming', in_progress: 'messages.ctx.job.in_progress',
  done: 'messages.ctx.job.done', cancelled: 'messages.ctx.job.cancelled',
};
const keyed = (t, keys, value, fallback) => (keys[value] ? t(keys[value]) : fallback);

// Build the inline-edit form shape from a contact. Kept outside the component so the
// same snapshot logic drives both initial state and dirty-diff comparison.
function buildForm(contact) {
  if (!contact) return null;
  return {
    email: contact.email || '',
    phone: contact.phone || '',
    title: contact.title || '',
    department: contact.customFields?.department || '',
  };
}

// Details card. Read-first: an "Edit" button flips the fields into inputs, then
// Save/Cancel commit (the shared convention — UI_RULES §101). Conversation-scoped
// actions (Change contact / Unlink) live in an overflow menu in the context-panel
// HEAD — not here — so this card stays focused on the contact record itself.
function ContactLinkCard({ contact, company, onLinkContact, nav }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();

  const canEdit = usePermission('contacts.edit');

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => buildForm(contact));
  // Note: we don't reset `form` inside an effect — callers mount this component
  // with key={contact.id} so switching threads remounts it with a fresh form.

  if (!contact) {
    return (
      <div className="context-card">
        <div className="context-card-title-row">
          <div className="context-card-title">{t('messages.ctx.contact')}</div>
        </div>
        <div className="text-xs text-muted" style={{ marginBottom: 8 }}>
          {t('messages.ctx.notLinked')}
        </div>
        <ContactPicker
          value={null}
          onChange={(id) => onLinkContact?.(id || null)}
          placeholder={t('messages.ctx.linkContact')}
          allowClear={false}
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
        toast.error(t('messages.ctx.emailTaken', { name: `${dup.firstName} ${dup.lastName}`, email: patch.email }));
        return;
      }
    }

    if (Object.keys(patch).length > 0) {
      dispatch({ type: ACTIONS.UPDATE_CONTACT, id: contact.id, patch });
    }
    toast.success(t('messages.ctx.contactUpdated'));
    setEditing(false);
  };

  const handleDiscard = () => { setForm(buildForm(contact)); setEditing(false); };

  return (
    <div className="context-card">
      <div className="context-card-title-row">
        <div className="context-card-title">{t('messages.ctx.details')}</div>
        {canEdit && !editing && (
          <button type="button" className="btn btn-outline" onClick={() => setEditing(true)}>{t('messages.ctx.edit')}</button>
        )}
      </div>

      <dl className={`context-dl${editing ? ' context-dl-editable' : ''}`}>
        <div>
          <dt>{t('messages.ctx.email')}</dt>
          <dd>{editing
            ? <input className="inline-input" type="email" value={form.email} onChange={up('email')} disabled={!canEdit} />
            : (contact.email || <span className="text-muted">—</span>)}</dd>
        </div>
        <div>
          <dt>{t('messages.ctx.phone')}</dt>
          <dd>{editing
            ? <input className="inline-input" type="tel" value={form.phone} onChange={up('phone')} disabled={!canEdit} placeholder="—" />
            : (contact.phone || <span className="text-muted">—</span>)}</dd>
        </div>
        <div>
          <dt>{t('messages.ctx.title')}</dt>
          <dd>{editing
            ? <input className="inline-input" value={form.title} onChange={up('title')} disabled={!canEdit} placeholder="—" />
            : (contact.title || <span className="text-muted">—</span>)}</dd>
        </div>
        <div>
          <dt>{t('messages.ctx.department')}</dt>
          <dd>{editing
            ? <input className="inline-input" value={form.department} onChange={up('department')} disabled={!canEdit} placeholder="—" />
            : (contact.customFields?.department || <span className="text-muted">—</span>)}</dd>
        </div>
        <div>
          <dt>{t('messages.ctx.company')}</dt>
          <dd>{company ? <Link to={`/clients/${company.id}`} state={nav}>{company.name}</Link> : <span className="text-muted">—</span>}</dd>
        </div>
        <div><dt>{t('messages.ctx.lastActivity')}</dt><dd><span className="text-muted">{timeShort(t, contact.updatedAt || contact.createdAt)}</span></dd></div>
        <div><dt>{t('messages.ctx.created')}</dt><dd><span className="text-muted">{fmtDate(contact.createdAt)}</span></dd></div>
      </dl>

      {editing && (
        <div className="context-card-save-row">
          <button type="button" className="btn btn-outline" onClick={handleDiscard}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!isDirty}>{t('common.save')}</button>
        </div>
      )}
    </div>
  );
}

function DmContextPanel({ conversation }) {
  const t = useT();
  const state = useStore();
  const { currentUser } = useAuth();
  const other = selectOtherParticipant(state, conversation, currentUser?.id);

  return (
    <aside className="context-pane">
      <div className="context-head">
        {other ? (
          <Avatar user={other} size="md" />
        ) : (
          <Avatar initials="?" variant={1} size="md" />
        )}
        <div className="context-head-text">
          <div className="context-head-name">{other ? other.name : t('messages.unknownUser')}</div>
          <div className="text-xs text-muted">
            {other ? roleLabel(t, other.role) : t('messages.ctx.participantMissing')}
          </div>
          <div className="context-head-badges">
            <Badge variant="blue">{t('messages.ctx.directMessage')}</Badge>
            {other?.status === 'disabled' && <Badge variant="slate">{t('messages.ctx.inactive')}</Badge>}
          </div>
        </div>
      </div>
      <div className="context-body">
        <div className="context-card">
          <div className="context-card-title">{t('messages.ctx.participant')}</div>
          {other ? (
            <dl className="context-dl">
              <div><dt>{t('messages.ctx.name')}</dt><dd>{other.name}</dd></div>
              <div><dt>{t('messages.ctx.role')}</dt><dd>{roleLabel(t, other.role)}</dd></div>
              <div><dt>{t('messages.ctx.email')}</dt><dd>{other.email || <span className="text-muted">—</span>}</dd></div>
              <div><dt>{t('messages.ctx.phone')}</dt><dd>{other.phone || <span className="text-muted">—</span>}</dd></div>
              <div><dt>{t('messages.ctx.status')}</dt><dd>{other.status === 'active' ? t('messages.ctx.active') : other.status === 'disabled' ? t('messages.ctx.inactive') : (other.status || '—')}</dd></div>
            </dl>
          ) : (
            <div className="text-xs text-muted">
              {t('messages.ctx.participantGone')}
            </div>
          )}
        </div>
        <div className="context-card">
          <div className="context-card-title">{t('messages.ctx.privacy')}</div>
          <div className="text-xs text-muted">
            {t('messages.ctx.dmPrivacy')}
          </div>
        </div>
      </div>
    </aside>
  );
}

function InternalContextPanel({ conversation }) {
  const t = useT();
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
  const eligible = useMemo(() => (state.users || [])
    .filter((u) => u.status === 'active' && !participantIds.includes(u.id)), [state.users, conversation.participantUserIds]); // eslint-disable-line react-hooks/exhaustive-deps
  // Who can be added: the team by name, searched, never all of it at once (UI_RULES §127;
  // CS-722 — this listed every login with no search).
  const [addQuery, setAddQuery] = useState('');
  const addMatches = useMemo(() => {
    const q = addQuery.trim().toLowerCase();
    return eligible
      .filter((u) => !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q))
      .sort(compareUsersByName);
  }, [eligible, addQuery]);
  const { shown: addShown, noteMsg } = useMemo(() => capOptions(addMatches, PICKER_MAX_VISIBLE), [addMatches]);

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
        <h3 className="context-title">{conversation.title || t('messages.teamDiscussion')}</h3>
        <div className="text-xs text-muted">{t('messages.ctx.internalOnly')}</div>
      </div>
      <div className="context-body">
        <div className="context-card">
          <div className="context-card-title">{t('messages.ctx.participants')}</div>
          {participants.length === 0 ? (
            <div className="text-xs text-muted">{t('messages.ctx.noParticipants')}</div>
          ) : (
            <ul className="context-participants">
              {participants.map((u) => (
                <li key={u.id} className="context-participant">
                  <Avatar user={u} size="sm" />
                  <span>{u.name}</span>
                </li>
              ))}
            </ul>
          )}

          {adding ? (
            <div className="participant-add-picker">
              {eligible.length === 0 ? (
                <div className="text-xs text-muted">{t('messages.ctx.everyoneIn')}</div>
              ) : (
                <>
                <input
                  className="input"
                  type="search"
                  value={addQuery}
                  onChange={(e) => setAddQuery(e.target.value)}
                  placeholder={t('messages.searchTeammates')}
                  aria-label={t('messages.searchTeammates')}
                  autoFocus
                />
                <PickerCapNote note={noteMsg} />
                {addMatches.length === 0 && <div className="text-xs text-muted">{t('messages.noTeammatesMatch')}</div>}
                <ul className="participant-add-list">
                  {addShown.map((u) => (
                    <li key={u.id}>
                      <button
                        type="button"
                        className="participant-add-row"
                        onClick={() => onAdd(u.id)}
                      >
                        <Avatar user={u} size="sm" />
                        <span className="participant-add-row-name">{u.name}</span>
                        <span className="participant-add-row-role text-xs text-muted">
                          {roleLabel(t, u.role)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                </>
              )}
              <button
                type="button"
                className="btn btn-link participant-add-cancel"
                onClick={() => setAdding(false)}
              >
                {t('common.cancel')}
              </button>
            </div>
          ) : eligible.length > 0 ? (
            <button
              type="button"
              className="btn btn-outline participant-add-trigger"
              onClick={() => { setAddQuery(''); setAdding(true); }}
            >
              {t('messages.ctx.addParticipant')}
            </button>
          ) : (
            <div className="text-xs text-muted participant-add-empty">
              {t('messages.ctx.everyoneIn')}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

export default function ConversationContextPanel({ conversation, contact, onLinkContact }) {
  const t = useT();
  const state = useStore();
  const nav = useFromHere();
  const [tab, setTab] = useState('contact');

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
        <EmptyState message={t('messages.ctx.pickConversation')} />
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
    || (channelLabel ? t('messages.ctx.channelConversation', { channel: channelLabel }) : t('messages.ctx.unlinkedConversation'));

  return (
    <aside className="context-pane">
      <div className="context-head">
        <Avatar initials={initials} variant={avatarVariant} size="md" />
        <div className="context-head-text">
          {contact ? (
            <>
              <span className="context-head-name">
                {contact.firstName} {contact.lastName}
              </span>
              <div className="text-xs text-muted">{contact.title || '—'}</div>
              <div className="context-head-badges">
                <Badge variant={LIFECYCLE_VARIANTS[contact.lifecycle] || 'slate'}>
                  {keyed(t, LIFECYCLE_KEYS, contact.lifecycle || 'lead', (contact.lifecycle || '').charAt(0).toUpperCase() + (contact.lifecycle || '').slice(1))}
                </Badge>
              </div>
            </>
          ) : (
            <>
              <div className="context-head-name">{unlinkedTitle}</div>
              <div className="text-xs text-muted">{t('messages.ctx.noContactLinked')}</div>
              <div className="context-head-badges">
                <Badge variant="slate">{t('messages.unlinked')}</Badge>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="tab-container tab-container-line context-tabs">
        {TABS.map((tb) => (
          <button key={tb.key} className={`tab-btn ${tab === tb.key ? 'active' : ''}`} onClick={() => setTab(tb.key)}>
            {t(tb.labelKey)}
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
              nav={nav}
            />
            {contact && (
              <div className="context-card">
                <div className="context-card-title">{t('messages.ctx.tags')}</div>
                <div className="flex-row" style={{ gap: 4 }}>
                  {(contact.tagIds || []).length === 0 ? (
                    <span className="text-xs text-muted">{t('messages.ctx.noTags')}</span>
                  ) : (contact.tagIds || []).map((tid) => {
                    const tag = selectTagById(state, tid);
                    return tag ? <TagChip key={tid} tag={tag} /> : null;
                  })}
                </div>
              </div>
            )}
          </>
        )}

        {tab === 'history' && (
          <div className="context-card">
            {activity.length === 0 ? (
              <EmptyState message={contact ? t('messages.ctx.noActivity') : t('messages.ctx.linkForActivity')} />
            ) : (
              <ul className="context-activity">
                {activity.map((a) => (
                  <li key={a.id} className={`context-activity-item kind-${a.kind}`}>
                    <div className="context-activity-kind">{a.kind}</div>
                    <div className="context-activity-body">
                      <div>{a.body}</div>
                      <div className="text-xs text-muted">{timeShort(t, a.occurredAt)}</div>
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
              <div className="context-card-title">{t('messages.ctx.invoices', { count: invoices.length })}</div>
              {invoices.length === 0 ? (
                <div className="text-xs text-muted">{contact ? t('messages.ctx.noInvoices') : t('messages.ctx.linkForInvoices')}</div>
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
                            {keyed(t, INVOICE_STATUS_KEYS, st, st.charAt(0).toUpperCase() + st.slice(1))}
                          </Badge>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="context-card">
              <div className="context-card-title">{t('messages.ctx.jobs', { count: jobs.length })}</div>
              {jobs.length === 0 ? (
                <div className="text-xs text-muted">{contact ? t('messages.ctx.noJobs') : t('messages.ctx.linkForJobs')}</div>
              ) : (
                <ul className="context-related">
                  {jobs.slice(0, 5).map((j) => (
                    <li key={j.id}>
                      <Link to={`/schedule/${j.id}`} state={nav} className="context-related-row">
                        <span className="context-related-primary">{fmtDate(j.startAt)}</span>
                        <span className="context-related-sub">{state.services.find((s) => s.id === j.serviceId)?.name || t('messages.ctx.service')}</span>
                        <Badge variant={statusBadgeVariant(j.status === 'done' ? 'Confirmed' : j.status === 'in_progress' ? 'In Progress' : 'Pending')}>
                          {keyed(t, JOB_STATUS_KEYS, j.status, j.status.replace('_', ' '))}
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

    </aside>
  );
}

// Notes tab — compact append-then-scroll layout. Uses the same APPEND_CONTACT_NOTE
// action the full Contact page uses, so notes stay consistent across surfaces.
function NotesCard({ contact }) {
  const t = useT();
  const dispatch = useDispatch();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canEditThis = usePermission('contacts.edit');
  const [draft, setDraft] = useState('');

  if (!contact) {
    return (
      <div className="context-card">
        <div className="context-card-title">{t('messages.ctx.notes')}</div>
        <div className="text-xs text-muted">{t('messages.ctx.linkForNotes')}</div>
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
    toast.success(t('messages.ctx.noteAdded'));
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
        <div className="context-card-title">{t('messages.ctx.notes')}</div>
        {draft.trim() && (
          <span className="text-xs text-muted">{t('messages.ctx.saveShortcut')}</span>
        )}
      </div>

      {canEditThis && (
        <>
          <textarea
            className="input notes-compose"
            rows={3}
            placeholder={t('messages.ctx.notePlaceholder')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="notes-compose-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!draft.trim()}
              onClick={append}
            >
              {t('messages.ctx.appendNote')}
            </button>
          </div>
        </>
      )}

      {contact.notes ? (
        <pre className="notes-history">{contact.notes}</pre>
      ) : (
        <div className="text-xs text-muted" style={{ padding: '8px 0' }}>
          {t('messages.ctx.noNotes')}
        </div>
      )}
    </div>
  );
}
