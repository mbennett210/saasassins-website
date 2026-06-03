import { useState, useMemo, useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import {
  selectClientById, selectSitesForClient, selectJobsForClient, selectInvoicesForClient,
  selectServiceById, selectFrequencies, selectServices, selectContactsForClient, selectContactById,
  selectActivitiesForClient, selectUserById, selectConversationsForContact,
  selectVisibleClientIdsFor,
  invoiceTotal, invoiceBalance, deriveInvoiceStatus,
} from '../store/selectors';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import { useAuth } from '../hooks/useAuth';
import DetailHeader from '../components/DetailHeader';
import Badge, { statusBadgeVariant } from '../components/Badge';
import EmptyState from '../components/EmptyState';
import ConfirmDialog from '../components/ConfirmDialog';
import FormField from '../components/FormField';
import AddSiteModal from '../components/AddSiteModal';
import AddContactModal from '../components/AddContactModal';
import NewConversationModal from '../components/NewConversationModal';
import LogPaymentModal from '../components/LogPaymentModal';
import ContactPicker from '../components/ContactPicker';
import Select from '../components/Select';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import { fmtDate, fmtTimeRange, fmtRelative, money } from '../lib/dates';
import { ATTACHMENT_MAX_BYTES, formatBytes } from '../lib/attachments';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'sites',    label: 'Sites' },
  { key: 'activity', label: 'Activity' },
  { key: 'notes',    label: 'Notes' },
];

export default function ClientDetail() {
  const { clientId } = useParams();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const navigate = useNavigate();
  const nav = useFromHere();
  const canEdit = usePermission('clients.edit');
  const canView = usePermission('clients.view');
  const canDeleteClient = usePermission('clients.delete');
  const canEditSites = usePermission('sites.edit');
  const canAttachToSites = usePermission('sites.attachments');
  // Either permission opens the site detail modal — the modal itself decides
  // which fields are editable. This lets crew with attach-only access tap a
  // card to upload photos without giving them full site-edit power.
  const canOpenSite = canEditSites || canAttachToSites;
  const canEditContacts = usePermission('contacts.edit');
  const { currentUser } = useAuth();

  const rawClient = selectClientById(state, clientId);
  // Crew can only see clients they have a job on; admin/owner see all.
  const visibleClientIds = useMemo(
    () => selectVisibleClientIdsFor(state, currentUser),
    [state, currentUser]
  );
  const client = rawClient && (currentUser?.role !== 'crew' || visibleClientIds.has(rawClient.id))
    ? rawClient
    : null;
  const sites = client ? selectSitesForClient(state, client.id) : [];
  const jobs = client ? selectJobsForClient(state, client.id) : [];
  const invoices = client ? selectInvoicesForClient(state, client.id) : [];
  const contacts = client ? selectContactsForClient(state, client.id) : [];
  const services = selectServices(state);
  const frequencies = selectFrequencies(state);
  const primaryContact = client?.primaryContactId ? selectContactById(state, client.primaryContactId) : null;

  const [tab, setTab] = useState('overview');
  const [activitySubTab, setActivitySubTab] = useState('service');
  const [form, setForm] = useState(client);
  const [addSiteOpen, setAddSiteOpen] = useState(false);
  const [editSite, setEditSite] = useState(null);
  const [confirmDeleteSite, setConfirmDeleteSite] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteAttachment, setNoteAttachment] = useState(null);
  const noteFileRef = useRef(null);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editingNoteText, setEditingNoteText] = useState('');
  const [confirmDeleteNoteId, setConfirmDeleteNoteId] = useState(null);
  const [logPaymentOpen, setLogPaymentOpen] = useState(false);
  const canRecordPayment = usePermission('invoices.recordPayment');

  const activities = useMemo(() => (client ? selectActivitiesForClient(state, client.id) : []), [state, client?.id]);
  const noteActivities = useMemo(() => activities.filter((a) => a.kind === 'note'), [activities]);
  const primaryConversations = useMemo(
    () => (primaryContact ? selectConversationsForContact(state, primaryContact.id) : []),
    [state, primaryContact?.id]
  );
  const canDelete = canDeleteClient;
  const canStartConversation = usePermission('messaging.startConversation');

  const outstanding = useMemo(() => invoices.reduce((a, inv) => {
    const s = deriveInvoiceStatus(inv);
    return s === 'pending' || s === 'overdue' ? a + invoiceBalance(inv) : a;
  }, 0), [invoices]);

  // Keep `form` in sync when the underlying client changes (e.g. external update,
  // route change, or after a save resets it). This is what makes inline-edit
  // pick up new state without forcing a remount.
  useEffect(() => {
    if (client) setForm(client);
  }, [client?.id, client?.updatedAt]);

  const dirty = useMemo(() => {
    if (!form || !client) return false;
    const fields = ['name', 'primaryContactId', 'email', 'phone', 'serviceId', 'frequencyId', 'status'];
    return fields.some((f) => (form[f] ?? null) !== (client[f] ?? null));
  }, [form, client]);

  if (!client) {
    return (
      <div style={{ padding: 32 }}>
        <DetailHeader backTo="/clients?tab=clients" backLabel="Clients" title="Client not found" />
      </div>
    );
  }

  const save = () => {
    dispatch({ type: ACTIONS.UPDATE_CLIENT, id: client.id, patch: {
      name: form.name, primaryContact: form.primaryContact, email: form.email, phone: form.phone,
      serviceId: form.serviceId, frequencyId: form.frequencyId, status: form.status,
      primaryContactId: form.primaryContactId || null,
    }});
    toast.success('Client updated');
  };

  const cancel = () => setForm(client);

  const setPrimary = (contactId) => {
    dispatch({ type: ACTIONS.UPDATE_CLIENT, id: client.id, patch: { primaryContactId: contactId } });
  };

  const deleteClient = () => {
    dispatch({ type: ACTIONS.DELETE_CLIENT, id: client.id });
    toast.success('Client deleted');
    navigate('/clients?tab=clients');
  };

  const appendNote = () => {
    if (!noteText.trim() && !noteAttachment) return;
    dispatch({
      type: ACTIONS.APPEND_CLIENT_NOTE,
      id: client.id,
      text: noteText.trim(),
      author: currentUser?.name,
      authorUserId: currentUser?.id,
      attachment: noteAttachment,
    });
    setNoteText('');
    setNoteAttachment(null);
    if (noteFileRef.current) noteFileRef.current.value = '';
    toast.success('Note added');
  };

  const startEditNote = (note) => {
    setEditingNoteId(note.id);
    setEditingNoteText(note.body);
  };
  const cancelEditNote = () => {
    setEditingNoteId(null);
    setEditingNoteText('');
  };
  const saveEditNote = () => {
    if (!editingNoteText.trim()) return;
    dispatch({
      type: ACTIONS.UPDATE_CLIENT_ACTIVITY,
      id: editingNoteId,
      patch: { body: editingNoteText.trim(), editedAt: new Date().toISOString() },
    });
    cancelEditNote();
    toast.success('Note updated');
  };
  const deleteNote = (id) => {
    dispatch({ type: ACTIONS.DELETE_CLIENT_ACTIVITY, id });
    setConfirmDeleteNoteId(null);
    toast.success('Note deleted');
  };

  const handleMessage = () => {
    if (!primaryContact) {
      toast.error('Set a primary contact first to start a conversation.');
      return;
    }
    const existing = primaryConversations
      .slice()
      .sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt));
    if (existing.length > 0) {
      navigate(`/messaging/${existing[0].id}`, { state: nav });
    } else {
      navigate('/messaging', { state: nav });
    }
  };

  return (
    <div className="page-pad">
      <DetailHeader
        backTo="/clients?tab=clients"
        backLabel="Clients"
        title={client.name}
        subtitle={client.primaryContact || ''}
        badge={<Badge variant={statusBadgeVariant(client.status === 'active' ? 'Active' : 'Inactive')}>
          {client.status === 'active' ? 'Active' : 'Inactive'}
        </Badge>}
        actions={
          <div className="flex-row" style={{ gap: 8 }}>
            {canStartConversation && (
              <button className="btn btn-success btn-sm" onClick={handleMessage}>
                <Icon name="messaging" size={14} />
                Message
              </button>
            )}
            {canDelete && <button className="btn btn-danger btn-sm" onClick={() => setConfirmDelete(true)}>Delete</button>}
          </div>
        }
      />

      <div className="tab-container tab-container-line">
        {TABS.map((t) => (
          <button key={t.key} className={`tab-btn ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="detail-grid">
        <div className="card detail-card">
          <div className="inline-edit-grid">
            <label className="inline-edit-label" htmlFor="cli-name">Company name</label>
            <div className="inline-edit-value">
              <input
                id="cli-name"
                className="input input-ghost"
                value={form?.name || ''}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                disabled={!canEdit}
              />
            </div>

            <label className="inline-edit-label">Primary contact</label>
            <div className="inline-edit-value">
              {canEdit ? (
                <ContactPicker
                  value={form?.primaryContactId || null}
                  companyId={client.id}
                  onChange={(id) => setForm({ ...form, primaryContactId: id })}
                />
              ) : (
                <div className="inline-edit-readonly">
                  {primaryContact ? (
                    <Link to={`/clients/contact/${primaryContact.id}`} state={nav}>
                      {primaryContact.firstName} {primaryContact.lastName}
                      {primaryContact.title && <span className="text-muted"> — {primaryContact.title}</span>}
                    </Link>
                  ) : (client.primaryContact || '—')}
                </div>
              )}
            </div>

            <label className="inline-edit-label" htmlFor="cli-email">Email</label>
            <div className="inline-edit-value">
              <input
                id="cli-email"
                type="email"
                className="input input-ghost"
                value={form?.email || ''}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder={primaryContact?.email || '—'}
                disabled={!canEdit}
              />
            </div>

            <label className="inline-edit-label" htmlFor="cli-phone">Phone</label>
            <div className="inline-edit-value">
              <input
                id="cli-phone"
                className="input input-ghost"
                value={form?.phone || ''}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder={primaryContact?.phone || '—'}
                disabled={!canEdit}
              />
            </div>

            <label className="inline-edit-label" id="cli-service-label">Service</label>
            <div className="inline-edit-value">
              <Select
                ghost
                ariaLabel="Service"
                value={form?.serviceId || ''}
                onChange={(v) => setForm({ ...form, serviceId: v })}
                disabled={!canEdit}
                options={services.map((s) => ({ value: s.id, label: s.name }))}
              />
            </div>

            <label className="inline-edit-label" id="cli-frequency-label">Frequency</label>
            <div className="inline-edit-value">
              <Select
                ghost
                ariaLabel="Frequency"
                value={form?.frequencyId || ''}
                onChange={(v) => setForm({ ...form, frequencyId: v })}
                disabled={!canEdit}
                options={frequencies.map((f) => ({ value: f.id, label: f.label }))}
              />
            </div>

            <label className="inline-edit-label" id="cli-status-label">Status</label>
            <div className="inline-edit-value">
              <Select
                ghost
                ariaLabel="Status"
                value={form?.status || 'active'}
                onChange={(v) => setForm({ ...form, status: v })}
                disabled={!canEdit}
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'inactive', label: 'Inactive' },
                ]}
              />
            </div>

          </div>

          {canEdit && dirty && (
            <div className="inline-edit-savebar">
              <span className="save-hint">Unsaved changes</span>
              <button type="button" className="btn btn-outline" onClick={cancel}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={save}>Save Changes</button>
            </div>
          )}
        </div>

        <div>
          <div className="card detail-card">
            <h3>Lifetime revenue</h3>
            <div className="stat-card-value">{money(client.revenue || 0)}</div>
          </div>
          <div className="card detail-card">
            <h3>Outstanding</h3>
            <div className={`stat-card-value ${outstanding > 0 ? 'text-danger' : ''}`}>
              {money(outstanding)}
            </div>
          </div>
          <div className="card detail-card">
            <h3>Last service</h3>
            <div className="stat-card-value-sm">
              {client.lastServiceAt ? fmtDate(client.lastServiceAt) : '—'}
            </div>
          </div>
          <div className="card detail-card">
            <h3>At a glance</h3>
            <dl className="detail-dl">
              <div><dt>Contacts</dt><dd>{contacts.length}</dd></div>
              <div><dt>Sites</dt><dd>{sites.length}</dd></div>
              <div><dt>Jobs</dt><dd>{jobs.length}</dd></div>
              <div><dt>Invoices</dt><dd>{invoices.length}</dd></div>
            </dl>
          </div>
        </div>
        </div>
      )}

      {tab === 'contacts' && (
        <div>
          <div className="section-head">
            <div>
              <h3 className="section-title">Contacts ({contacts.length})</h3>
              <p className="text-muted text-sm">Everyone you work with at {client.name}. Click a name for the full CRM profile.</p>
            </div>
            {canEditContacts && <button className="btn btn-primary btn-sm" onClick={() => setAddContactOpen(true)}>Add Contact</button>}
          </div>
          {contacts.length === 0 ? (
            <EmptyState
              icon={<Icon name="user" size={28} />}
              title="No contacts yet"
              message="Add the people you work with at this client."
              action={canEditContacts && <button className="btn btn-primary" onClick={() => setAddContactOpen(true)}>Add a contact</button>}
            />
          ) : (
            <div className="table-wrap">
              <table>
                <thead><tr><th></th><th>Name</th><th>Title</th><th>Email</th><th>Phone</th><th></th></tr></thead>
                  <tbody>
                    {contacts
                      .slice()
                      .sort((a, b) => (a.id === client.primaryContactId ? -1 : b.id === client.primaryContactId ? 1 : 0))
                      .map((c) => {
                        const isPrimary = c.id === client.primaryContactId;
                        return (
                          <tr key={c.id} className="clickable" onClick={() => navigate(`/clients/contact/${c.id}`, { state: nav })}>
                            <td onClick={(e) => e.stopPropagation()} style={{ width: 36 }}>
                              <Avatar initials={`${(c.firstName[0] || '').toUpperCase()}${(c.lastName[0] || '').toUpperCase()}`} variant={(c.id.length % 5) + 1} size="sm" />
                            </td>
                            <td>
                              <span className="name">{c.firstName} {c.lastName}</span>
                              {isPrimary && <span className="tier-badge" style={{ marginLeft: 8 }}>Primary</span>}
                            </td>
                            <td>{c.title || '—'}</td>
                            <td>{c.email}</td>
                            <td>{c.phone || '—'}</td>
                            <td className="text-right" onClick={(e) => e.stopPropagation()}>
                              {!isPrimary && canEdit && (
                                <button className="btn btn-outline btn-sm" onClick={() => setPrimary(c.id)}>Set as primary</button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                </tbody>
              </table>
            </div>
          )}
          <AddContactModal open={addContactOpen} onClose={() => setAddContactOpen(false)} lockCompanyId={client.id} />
        </div>
      )}

      {tab === 'sites' && (
        <div>
          <div className="section-head">
            <div>
              <h3 className="section-title">Sites ({sites.length})</h3>
              <p className="text-muted text-sm">
                Every location you service for this client.
                {sites.length === 0 && canEditSites && ' Click the dashed card below to add your first site.'}
              </p>
            </div>
          </div>
          {sites.length === 0 && !canEditSites ? (
            <EmptyState
              icon={<Icon name="building" size={28} />}
              title="No sites yet"
              message="Sites for this client will appear here once they're added."
            />
          ) : (
            <div className="site-grid">
              {sites.map((s) => {
                const siteContact = s.siteContactId ? selectContactById(state, s.siteContactId) : null;
                const attachmentCount = (s.attachments || []).length;
                return (
                  <div
                    key={s.id}
                    className={`card site-card ${canOpenSite ? 'clickable' : ''}`}
                    onClick={canOpenSite ? () => setEditSite(s) : undefined}
                  >
                    {canEditSites && (
                      <button
                        type="button"
                        className="site-card-delete"
                        aria-label={`Delete ${s.name}`}
                        title="Delete site"
                        onClick={(e) => { e.stopPropagation(); setConfirmDeleteSite(s); }}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    )}
                    <h4>{s.name}</h4>
                    <p className="text-sm text-body">{s.address}</p>
                    <div className="text-sm" style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icon name="user" size={14} />
                      <span className="text-muted">Contact:</span>
                      {siteContact ? (
                        <Link
                          className="link"
                          to={`/contacts/${siteContact.id}`}
                          state={nav}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {siteContact.firstName} {siteContact.lastName}
                        </Link>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </div>
                    {s.accessNotes && <p className="text-muted text-sm" style={{ marginTop: 6 }}>Access: {s.accessNotes}</p>}
                    {attachmentCount > 0 && (
                      <div className="site-card-attachments text-xs text-muted">
                        <Icon name="paperclip" size={11} />
                        <span>{attachmentCount} attachment{attachmentCount === 1 ? '' : 's'}</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {canEditSites && (
                <button
                  type="button"
                  className="site-card-ghost"
                  onClick={() => setAddSiteOpen(true)}
                  aria-label="Add site"
                >
                  <span className="site-card-ghost-label">Add site</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'activity' && (
        <div>
          <div className="activity-toggle">
            <button
              type="button"
              className={`activity-toggle-btn ${activitySubTab === 'service' ? 'active' : ''}`}
              onClick={() => setActivitySubTab('service')}
            >
              <Icon name="schedule" size={14} />
              Service History
              <span className="activity-toggle-count">{jobs.length}</span>
            </button>
            <button
              type="button"
              className={`activity-toggle-btn ${activitySubTab === 'payment' ? 'active' : ''}`}
              onClick={() => setActivitySubTab('payment')}
            >
              <Icon name="invoices" size={14} />
              Payment History
              <span className="activity-toggle-count">{invoices.length}</span>
            </button>
          </div>

          {activitySubTab === 'service' && (
            jobs.length === 0 ? (
              <EmptyState icon={<Icon name="schedule" size={28} />} title="No service history" message="Jobs scheduled for this client will appear here." />
            ) : (
              <div className="activity-card-grid">
                {jobs.map((j) => {
                  const serviceName = selectServiceById(state, j.serviceId)?.name || '—';
                  const siteName = state.sites.find((s) => s.id === j.siteId)?.name;
                  const statusLabel = j.status === 'in_progress' ? 'In Progress' : j.status === 'done' ? 'Done' : j.status === 'cancelled' ? 'Cancelled' : 'Upcoming';
                  const statusVariant = statusBadgeVariant(j.status === 'in_progress' ? 'In Progress' : j.status === 'done' ? 'Confirmed' : 'Pending');
                  return (
                    <button
                      key={j.id}
                      type="button"
                      className="activity-card activity-card-service"
                      onClick={() => navigate(`/schedule/${j.id}`, { state: nav })}
                    >
                      <div className="activity-card-icon"><Icon name="schedule" size={18} /></div>
                      <div className="activity-card-body">
                        <div className="activity-card-title">{serviceName}</div>
                        <div className="activity-card-meta">
                          {fmtDate(j.startAt)} <span className="text-muted">{fmtTimeRange(j.startAt, j.endAt)}</span>
                          {siteName && <> · {siteName}</>}
                        </div>
                      </div>
                      <Badge variant={statusVariant}>{statusLabel}</Badge>
                      <Icon name="chevronRight" size={14} />
                    </button>
                  );
                })}
              </div>
            )
          )}

          {activitySubTab === 'payment' && (
            <>
              {canRecordPayment && (
                <div className="section-head" style={{ marginBottom: 12 }}>
                  <span className="text-muted text-sm">Manual payment tracking</span>
                  <button type="button" className="btn btn-outline btn-sm" onClick={() => setLogPaymentOpen(true)}>
                    Record Payment
                  </button>
                </div>
              )}
              {invoices.length === 0 ? (
                <EmptyState
                  icon={<Icon name="invoices" size={28} />}
                  title="No payment history"
                  message="Invoices and payments logged for this client will appear here."
                  action={canRecordPayment && <button className="btn btn-primary" onClick={() => setLogPaymentOpen(true)}>Record Payment</button>}
                />
              ) : (
                <div className="activity-card-grid">
                  {invoices.map((inv) => {
                    const st = deriveInvoiceStatus(inv);
                    const balance = invoiceBalance(inv);
                    return (
                      <button
                        key={inv.id}
                        type="button"
                        className="activity-card activity-card-payment"
                        onClick={() => navigate(`/invoices/${inv.id}`, { state: nav })}
                      >
                        <div className="activity-card-icon"><Icon name="invoices" size={18} /></div>
                        <div className="activity-card-body">
                          <div className="activity-card-title">{inv.id}</div>
                          <div className="activity-card-meta">
                            {fmtDate(inv.issueDate)} · {money(invoiceTotal(inv))}
                            {balance > 0 && <> · <span className="text-danger">Balance {money(balance)}</span></>}
                          </div>
                        </div>
                        <Badge variant={statusBadgeVariant(st === 'paid' ? 'Paid' : st === 'overdue' ? 'Overdue' : 'Pending')}>
                          {st.charAt(0).toUpperCase() + st.slice(1)}
                        </Badge>
                        <Icon name="chevronRight" size={14} />
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {tab === 'notes' && (
        <div>
          {canView && (
            <div className="card" style={{ marginBottom: 16 }}>
              <FormField label="Add note" as="textarea" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Arrival instructions, preferences, follow-ups…" />
              {noteAttachment && (
                <div className="note-attachment-pending">
                  <span className="email-attachment-chip">
                    <Icon name="paperclip" size={12} />
                    <span>{noteAttachment.name}</span>
                    <button
                      type="button"
                      className="email-attachment-remove"
                      aria-label="Remove attachment"
                      onClick={() => {
                        setNoteAttachment(null);
                        if (noteFileRef.current) noteFileRef.current.value = '';
                      }}
                    >
                      &times;
                    </button>
                  </span>
                </div>
              )}
              <input
                ref={noteFileRef}
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  if (f.size > ATTACHMENT_MAX_BYTES) {
                    toast.error(`File too large (${formatBytes(f.size)}). Max ${formatBytes(ATTACHMENT_MAX_BYTES)}.`);
                    e.target.value = '';
                    return;
                  }
                  setNoteAttachment({ name: f.name, size: f.size, type: f.type });
                }}
              />
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-success"
                  onClick={() => noteFileRef.current?.click()}
                >
                  Add Attachment
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={appendNote}
                  disabled={!noteText.trim() && !noteAttachment}
                >
                  Save
                </button>
              </div>
            </div>
          )}
          {noteActivities.length === 0 && !client.notes ? (
            <EmptyState icon={<Icon name="edit" size={28} />} title="No notes yet" message="Notes are timestamped and shown newest first." />
          ) : (
            <div className="note-list">
              {noteActivities.map((n) => {
                const author = n.authorUserId ? selectUserById(state, n.authorUserId) : null;
                const isEditing = editingNoteId === n.id;
                return (
                  <div key={n.id} className="note-item">
                    <div className="note-item-head">
                      <div className="flex-row" style={{ gap: 8, alignItems: 'center' }}>
                        {author && <Avatar initials={author.initials} variant={author.avatar} size="sm" />}
                        <div>
                          <div className="note-item-author">{author?.name || 'Someone'}</div>
                          <div className="note-item-time text-xs text-muted">
                            {fmtRelative(n.occurredAt)}
                            {n.editedAt && <> · edited {fmtRelative(n.editedAt)}</>}
                          </div>
                        </div>
                      </div>
                      {canEdit && !isEditing && (
                        <div className="note-item-actions">
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => startEditNote(n)}>Edit</button>
                          <button type="button" className="btn btn-danger btn-sm" onClick={() => setConfirmDeleteNoteId(n.id)}>Delete</button>
                        </div>
                      )}
                    </div>
                    {isEditing ? (
                      <div style={{ marginTop: 8 }}>
                        <FormField label="" as="textarea" value={editingNoteText} onChange={(e) => setEditingNoteText(e.target.value)} />
                        <div className="flex-row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                          <button type="button" className="btn btn-outline btn-sm" onClick={cancelEditNote}>Cancel</button>
                          <button type="button" className="btn btn-primary btn-sm" onClick={saveEditNote} disabled={!editingNoteText.trim()}>Save</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {n.body && <div className="note-item-body">{n.body}</div>}
                        {n.attachment && (
                          <div className="note-item-attachment">
                            <span className="email-attachment-chip">
                              <Icon name="paperclip" size={12} />
                              <span>{n.attachment.name}</span>
                            </span>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
              {noteActivities.length === 0 && client.notes && (
                <div className="note-item">
                  <div className="note-item-head">
                    <div>
                      <div className="note-item-author text-muted">Legacy notes</div>
                      <div className="note-item-time text-xs text-muted">From before per-note editing was added</div>
                    </div>
                  </div>
                  <pre className="note-item-body" style={{ whiteSpace: 'pre-wrap' }}>{client.notes}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <AddSiteModal
        open={addSiteOpen}
        onClose={() => setAddSiteOpen(false)}
        clientId={client.id}
      />
      {editSite && (
        <AddSiteModal
          open
          mode="edit"
          clientId={client.id}
          initialData={editSite}
          onClose={() => setEditSite(null)}
        />
      )}
      <ConfirmDialog
        open={!!confirmDeleteSite}
        title={`Delete ${confirmDeleteSite?.name || 'site'}?`}
        message="Jobs and invoices linked to this site will keep their reference (the site will appear as '—')."
        confirmLabel="Delete Site"
        variant="danger"
        onConfirm={() => {
          dispatch({ type: ACTIONS.DELETE_SITE, id: confirmDeleteSite.id });
        }}
        onClose={() => setConfirmDeleteSite(null)}
      />
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${client.name}?`}
        message="This permanently removes the client, its contacts, sites, jobs, and invoices. Conversations linked to those contacts will be unlinked but preserved. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={deleteClient}
        onClose={() => setConfirmDelete(false)}
      />
      <ConfirmDialog
        open={confirmDeleteNoteId !== null}
        title="Delete this note?"
        message="This permanently removes the note. You can't undo this."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => deleteNote(confirmDeleteNoteId)}
        onClose={() => setConfirmDeleteNoteId(null)}
      />
      {primaryContact && (
        <NewConversationModal
          open={newConvOpen}
          defaultContactId={primaryContact.id}
          onClose={() => setNewConvOpen(false)}
        />
      )}
      <LogPaymentModal
        open={logPaymentOpen}
        onClose={() => setLogPaymentOpen(false)}
        presetClientId={client.id}
      />
    </div>
  );
}
