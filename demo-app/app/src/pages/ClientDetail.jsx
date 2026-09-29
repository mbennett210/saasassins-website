import { useState, useMemo, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { newId } from '../lib/ids';
import {
  selectClientById, selectVisibleSitesFor, selectJobsForClient, selectInvoicesForClient,
  selectServiceById, selectFrequencies, selectServices, selectContactsForClient, selectContactById,
  selectActivitiesForClient, selectUserById, selectConversationsForContact, selectContactRoleFlags,
  selectVisibleClientIdsFor, selectTagById,
  selectClientLifetimeRevenue, selectClientBalance, selectClientBadgeStatus,
  selectClientCredit,
  invoiceTotal, invoiceBalance, invoicePaid, deriveInvoiceStatus,
} from '../store/selectors';
import { usePermission, useCanEditJobs } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import { useAuth } from '../hooks/useAuth';
import DetailHeader from '../components/DetailHeader';
import Badge, { statusBadgeVariant } from '../components/Badge';
import EmptyState from '../components/EmptyState';
import ConfirmDialog from '../components/ConfirmDialog';
import FormField from '../components/FormField';
import LocationCard from '../components/LocationCard';
import MediaGallery from '../components/MediaGallery';
import CleaningInstructionsCard from '../components/CleaningInstructionsCard';
import BillingCard from '../components/BillingCard';
import AddContactModal from '../components/AddContactModal';
import MessageContactMenu from '../components/MessageContactMenu';
import ClientStatusMenu from '../components/ClientStatusMenu';
import LogPaymentModal from '../components/LogPaymentModal';
import ContactPicker from '../components/ContactPicker';
import Select from '../components/Select';
import Avatar from '../components/Avatar';
import Icon from '../components/Icon';
import TagChip from '../components/TagChip';
import TagPicker from '../components/TagPicker';
import { fmtDate, fmtTimeRange, fmtRelative, money } from '../lib/dates';
import { ATTACHMENT_MAX_BYTES, formatBytes } from '../lib/attachments';
import ClientInspections from '../components/ClientInspections';
import ServiceSetupCard from '../components/ServiceSetupCard';
import OpsNoteCard from '../components/OpsNoteCard';
import SectionTabs, { sectionElementId } from '../components/SectionTabs';


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
  const canEditJobs = useCanEditJobs();
  const canEditSites = usePermission('sites.edit');
  const canEditContacts = usePermission('contacts.edit');
  const canEditOps = usePermission('ops.edit');
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
  // Site cards are crew-scoped: site-standing / job-at-site crew see only THEIR
  // site(s); account standing crew + managers see all (selectVisibleSitesFor).
  // Keys stay account-wide below regardless — deliberate (per-company inventory).
  // Every customer has exactly one location (a `site`); crew see it only when
  // assigned to a job there, managers always. `location` is that single record.
  const sites = client ? selectVisibleSitesFor(state, currentUser).filter((x) => x.clientId === client.id) : [];
  const location = sites[0] || null;
  const jobs = client ? selectJobsForClient(state, client.id) : [];
  const invoices = client ? selectInvoicesForClient(state, client.id) : [];
  const contacts = client ? selectContactsForClient(state, client.id) : [];
  const services = selectServices(state);
  const frequencies = selectFrequencies(state);
  const primaryContact = client?.primaryContactId ? selectContactById(state, client.primaryContactId) : null;

  // Deep-linkable tab (?tab=<key>). Read on mount AND on every navigation to this page
  // (e.g. global search from this customer's Access tab to one of its contacts); in-page
  // tab clicks stay local state as before (they don't navigate, so they're never
  // overridden). An unknown key (e.g. a stale ?tab=operations) clamps to overview.
  const [searchParams] = useSearchParams();
  const routerLocation = useLocation(); // (`location` in this file is the customer's service location)
  const sectionKeys = useMemo(
    () => ['overview', 'access', 'contacts', 'activity', 'notes'],
    [],
  );
  const initialSection = sectionKeys.includes(searchParams.get('tab')) ? searchParams.get('tab') : 'overview';
  const [activeKey, setActiveKey] = useState(initialSection);
  useEffect(() => {
    const t = new URLSearchParams(routerLocation.search).get('tab');
    if (t && sectionKeys.includes(t)) setActiveKey(t);
  }, [routerLocation.key, routerLocation.search, sectionKeys]);
  // Clamp to a real tab so a stale ?tab= deep link never leaves the body blank.
  const activeSection = sectionKeys.includes(activeKey) ? activeKey : (sectionKeys[0] || 'overview');
  const [activitySubTab, setActivitySubTab] = useState('service');
  const [form, setForm] = useState(client);
  const [editOverview, setEditOverview] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteAttachment, setNoteAttachment] = useState(null);
  const noteFileRef = useRef(null);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [editContact, setEditContact] = useState(null);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editingNoteText, setEditingNoteText] = useState('');
  const [confirmDeleteNoteId, setConfirmDeleteNoteId] = useState(null);
  const [logPaymentOpen, setLogPaymentOpen] = useState(false);
  const canRecordPayment = usePermission('invoices.recordPayment');
  // Q24: Admin must not see financials. Revenue / balance / payment surfaces gate on
  // invoices.view (owner+manager), NOT the route's clients.view (owner/admin/manager/crew),
  // so admin and crew reach the customer page but never its financial figures. Mirrors the
  // /invoices route gate; the whole org_state blob is on-device, so this client gate is the
  // display boundary (server route twins re-check at go-live).
  const canViewFinancials = usePermission('invoices.view');
  // The Inspections activity toggle reads /api/qc/inspections/list, gated qc.view — a role
  // with inspections turned off gets no toggle rather than a refused read.
  const canViewInspections = usePermission('qc.view');

  const activities = useMemo(() => (client ? selectActivitiesForClient(state, client.id) : []), [state, client?.id]);
  const noteActivities = useMemo(() => activities.filter((a) => a.kind === 'note'), [activities]);
  // Delete needs clients.delete AND the jobs-write tier (useCanEditJobs): a customer
  // delete cascades to its jobs, and the server's jobsGuard puts that job half back
  // for anyone without schedule.edit, orphaning the cleans (they keep feeding the
  // ops-alerts cron). So a delete the caller can't fully complete is not offered —
  // same rule as the Customers bulk delete (owner's call, 2026-09-23).
  const canDelete = canDeleteClient && canEditJobs;
  const canStartConversation = usePermission('messaging.startConversation');

  // Lifetime revenue is computed from actually-collected payments (replaces the
  // static seeded `client.revenue`); open balance is the client's unpaid total.
  const lifetimeRevenue = useMemo(() => (client ? selectClientLifetimeRevenue(state, client.id) : 0), [state, client?.id]);
  const accountBalance = useMemo(() => (client ? selectClientBalance(state, client.id) : 0), [state, client?.id]);
  const accountCredit = useMemo(() => (client ? selectClientCredit(state, client.id) : 0), [state, client?.id]);

  // Keep `form` in sync when the underlying client changes (e.g. external update,
  // route change, or after a save resets it). This is what makes inline-edit
  // pick up new state without forcing a remount.
  // What the draft was SEEDED from. The save diffs against this, not against the live
  // client, so it can tell "the user edited this" from "this changed underneath me" —
  // see the note on save().
  const baseline = useRef(client || null);
  const seedForm = (c) => { baseline.current = c || null; setForm(c); };

  useEffect(() => {
    if (client) seedForm(client);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client?.id, client?.updatedAt]);

  const dirty = useMemo(() => {
    if (!form || !client) return false;
    // Email + phone are NOT edited here — they mirror the primary contact (edited on
    // the contact). Only the account-owned fields count toward "unsaved changes".
    const fields = ['name', 'primaryContactId', 'serviceId', 'frequencyId'];
    return fields.some((f) => (form[f] ?? null) !== (client[f] ?? null));
  }, [form, client]);

  if (!client) {
    return (
      <div style={{ padding: 32 }}>
        <DetailHeader backTo="/contacts" backLabel="Customers" title="Company not found" />
      </div>
    );
  }

  // ⚠️ EMIT ONLY THE KEYS THAT ACTUALLY CHANGED.
  //
  // This used to send all eight fields unconditionally from `form`, and `form` can be
  // STALE: the resync effect above depends on `client?.updatedAt`, which for clients does
  // not exist — no UPDATE_CLIENT path stamps it — so the effect never re-fires and the
  // draft stays frozen at whatever it was when the page mounted.
  //
  // Meanwhile the SAME PAGE mutates the client behind the draft's back: "Set as primary"
  // on the Contacts tab dispatches UPDATE_CLIENT {primaryContactId}, adding a contact
  // makes the company adopt them as primary, and flipping a contact's lifecycle to
  // 'client' promotes status 'prospect' -> 'active'. Afterwards the user returns to
  // Overview, fixes a typo, saves — and the stale draft wrote the OLD primaryContactId
  // (and the old status) straight back over the new one. UPDATE_CLIENT writes no activity
  // row, so nothing anywhere recorded that the account's primary contact was unset.
  //
  // Diffing is the fix rather than repairing the effect's dependency: making the effect
  // fire on every client change would instead discard whatever the user was typing. A
  // form must not be able to write a field the user never touched — the same coupling
  // that let a dropped `note` erase a payroll audit trail in TimeEntryModal.
  //
  // ⚠️ DIFF AGAINST THE SEED, NOT AGAINST THE LIVE CLIENT. Diffing against `client` looks
  // right and does nothing: when a value changes underneath a stale draft, the draft's
  // old value DIFFERS from the new live one, so it is classified as an edit and written
  // straight back — exactly the bug. Only `baseline` distinguishes "the user changed
  // this" from "this changed under me".
  const save = () => {
    const candidate = {
      name: form.name,
      serviceId: form.serviceId, frequencyId: form.frequencyId,
      primaryContactId: form.primaryContactId || null,
    };
    const base = baseline.current || client;
    const patch = {};
    for (const [k, v] of Object.entries(candidate)) {
      if ((v ?? null) !== (base[k] ?? null)) patch[k] = v;
    }
    if (Object.keys(patch).length === 0) {
      toast.success('No changes to save');
      return;
    }
    dispatch({ type: ACTIONS.UPDATE_CLIENT, id: client.id, patch });
    toast.success('Company updated');
  };

  const cancel = () => seedForm(client);

  // Company tags are the canonical home — every contact at this company inherits
  // them. Diff against the client's own tagIds to grant/revoke.
  const setClientTagIds = (ids) => {
    const prev = new Set(client.tagIds || []);
    const next = new Set(ids);
    ids.forEach((id) => { if (!prev.has(id)) dispatch({ type: ACTIONS.TAG_CLIENT, id: client.id, tagId: id }); });
    (client.tagIds || []).forEach((id) => { if (!next.has(id)) dispatch({ type: ACTIONS.UNTAG_CLIENT, id: client.id, tagId: id }); });
  };

  // The three contact designations shown as toggles in the Contacts tab. One holder
  // per role; toggling the current holder clears it.
  //  • Primary / Billing are company-level FKs on the client (UPDATE_CLIENT).
  //  • Location contact (the `site` role) is the account LOCATION's siteContactId (UPDATE_SITE) — the same
  //    field the Location card, JobDetail and reminders read, so the toggle and the
  //    Location card can never disagree. No location on file → the toggle is disabled.
  // (These repoint an FK; the Overview edit form diffs against its own baseline, so
  // this never clobbers an edit in flight.)
  const toggleRole = (role, contactId) => {
    if (role === 'site') {
      if (!location) { toast.error('Add a location first to set a location contact.'); return; }
      dispatch({ type: ACTIONS.UPDATE_SITE, id: location.id, patch: { siteContactId: location.siteContactId === contactId ? null : contactId } });
      return;
    }
    const field = role === 'billing' ? 'billingContactId' : 'primaryContactId';
    dispatch({ type: ACTIONS.UPDATE_CLIENT, id: client.id, patch: { [field]: client[field] === contactId ? null : contactId } });
  };

  const deleteClient = () => {
    dispatch({ type: ACTIONS.DELETE_CLIENT, id: client.id });
    toast.success('Company deleted');
    navigate('/contacts');
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

  // The single badge shown in the header: Vendor when the company's Type is Vendor,
  // else the derived Lead/Active status (from real work). Nothing is stored.
  const clientStatus = selectClientBadgeStatus(state, client);

  // Click a contact's email -> open Messaging composing a NEW email to them. Reuse
  // their email-channel thread if one exists, else create one (linked to the person
  // + this company), then open it. Routes through the in-app messenger, never a mailto.
  const emailContact = (person) => {
    if (!person?.email) return;
    const existing = selectConversationsForContact(state, person.id)
      .filter((c) => c.channel === 'email')
      .sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt));
    let convId = existing[0]?.id;
    if (!convId) {
      convId = newId('cv');
      dispatch({ type: ACTIONS.ADD_CONVERSATION, conversation: {
        id: convId, channel: 'email', contactId: person.id, clientId: person.companyId || client.id, title: null,
      } });
    }
    navigate(`/messaging/${convId}`, { state: nav });
  };

  return (
    <div className="page-pad">
      <DetailHeader
        backTo="/contacts"
        backLabel="Customers"
        title={client.name}
        subtitle={client.contactNumber ? <span className="detail-head-contactno">#{client.contactNumber}</span> : null}
        badge={<ClientStatusMenu
          value={clientStatus}
          canEdit={canEdit}
          onChange={(choice) => dispatch({
            type: ACTIONS.UPDATE_CLIENT,
            id: client.id,
            patch: choice === 'vendor' ? { type: 'vendor' } : { type: 'customer', statusOverride: choice },
          })}
        />}
        actions={
          <div className="flex-row" style={{ gap: 8 }}>
            {canStartConversation && (
              <MessageContactMenu contacts={contacts} clientId={client.id} disabled={contacts.length === 0} />
            )}
            {canDelete && <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}>Delete</button>}
          </div>
        }
      />

      <div className="detail-tabs">
        <SectionTabs
          sections={[
            { key: 'overview', label: 'Overview' },
            { key: 'access', label: 'Access' },
            { key: 'contacts', label: 'Contacts', count: contacts.length },
            { key: 'activity', label: 'Activity', count: jobs.length + (canViewFinancials ? invoices.length : 0) },
            { key: 'notes', label: 'Notes', count: noteActivities.length },
          ]}
          activeKey={activeSection}
          onSelect={setActiveKey}
        />
        <div className="detail-tabs-body">
        <section id={sectionElementId('overview')} className="detail-section" hidden={activeSection !== 'overview'}>
        <div className="overview-kpis">
          {canViewFinancials && (
            <>
              <div className="detail-card kpi kpi-accent">
                <div className="kpi-label">Lifetime revenue</div>
                <div className="stat-card-value">{money(lifetimeRevenue)}</div>
                <div className="kpi-sub">Collected all-time</div>
              </div>
              <div className="detail-card kpi">
                <div className="kpi-label">Account balance</div>
                <div className={`stat-card-value ${accountBalance > 0 ? 'text-danger' : ''}`}>{money(Math.max(accountBalance, 0))}</div>
                <div className="kpi-sub">
                  {accountCredit > 0
                    ? <Badge variant="green">Credit {money(accountCredit)}</Badge>
                    : accountBalance > 0 ? 'Unpaid across open invoices' : 'Paid up'}
                </div>
              </div>
            </>
          )}
          <div className="detail-card kpi">
            <div className="kpi-label">Last service</div>
            <div className="stat-card-value-sm">{client.lastServiceAt ? fmtDate(client.lastServiceAt) : '—'}</div>
            <div className="kpi-sub">{selectServiceById(state, client.serviceId)?.name || 'No service set'}</div>
          </div>
          <div className="detail-card kpi">
            <div className="kpi-label">Jobs</div>
            <div className="stat-card-value">{jobs.length}</div>
            <div className="kpi-sub">{canViewFinancials ? `${invoices.length} ${invoices.length === 1 ? 'invoice' : 'invoices'}` : 'Service visits'}</div>
          </div>
        </div>

        <div className="detail-grid">
        <div>
        <div className="card detail-card">
          <div className="overview-card-head">
            <h3>Account details</h3>
            {canEdit && !editOverview && (
              <button type="button" className="btn btn-outline" onClick={() => setEditOverview(true)}>Edit</button>
            )}
          </div>
          {editOverview ? (
            <>
            <div className="inline-edit-grid">
              <label className="inline-edit-label" htmlFor="cli-name">Company name</label>
              <div className="inline-edit-value">
                <input
                  id="cli-name"
                  className="input"
                  value={form?.name || ''}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  disabled={!canEdit}
                />
              </div>

              <label className="inline-edit-label">Primary contact</label>
              <div className="inline-edit-value">
                <ContactPicker
                  value={form?.primaryContactId || null}
                  companyId={client.id}
                  onChange={(id) => setForm({ ...form, primaryContactId: id })}
                />
              </div>

              {/* Email + phone belong to the primary contact — read-only mirrors here,
                  edited on the contact itself (Contacts tab), never on the account. */}
              <label className="inline-edit-label">Email</label>
              <div className="inline-edit-value">
                <div className="inline-edit-readonly muted">{primaryContact?.email || '—'}</div>
              </div>

              <label className="inline-edit-label">Phone</label>
              <div className="inline-edit-value">
                <div className="inline-edit-readonly muted">{primaryContact?.phone || '—'}</div>
              </div>

              <label className="inline-edit-label" id="cli-service-label">Service</label>
              <div className="inline-edit-value">
                <Select
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
                  ariaLabel="Frequency"
                  value={form?.frequencyId || ''}
                  onChange={(v) => setForm({ ...form, frequencyId: v })}
                  disabled={!canEdit}
                  options={frequencies.map((f) => ({ value: f.id, label: f.label }))}
                />
              </div>
            </div>
            <p className="text-xs text-muted" style={{ marginTop: 8 }}>
              Email &amp; phone come from the primary contact. Change them on that contact in the <strong>Contacts</strong> tab.
            </p>
            <div className="inline-edit-savebar">
              <span className="save-hint">{dirty ? 'Unsaved changes' : 'No changes yet'}</span>
              <button type="button" className="btn btn-outline" onClick={() => { cancel(); setEditOverview(false); }}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={() => { save(); setEditOverview(false); }}>Save Changes</button>
            </div>
            </>
          ) : (
            <dl className="detail-dl">
              <div><dt>Primary contact</dt><dd>{primaryContact
                ? <>{primaryContact.firstName} {primaryContact.lastName}{primaryContact.title && <span className="text-muted"> · {primaryContact.title}</span>}</>
                : '—'}</dd></div>
              <div><dt>Email</dt><dd>{primaryContact?.email || '—'}</dd></div>
              <div><dt>Phone</dt><dd>{primaryContact?.phone || '—'}</dd></div>
              <div><dt>Service</dt><dd>{selectServiceById(state, client.serviceId)?.name || '—'}</dd></div>
              <div><dt>Frequency</dt><dd>{frequencies.find((f) => f.id === client.frequencyId)?.label || '—'}</dd></div>
            </dl>
          )}
        </div>

        <BillingCard client={client} location={location} canEdit={canEdit} />
        </div>

        <div>
          <div className="card detail-card">
            <h3>Tags</h3>
            {canEdit ? (
              <TagPicker value={client.tagIds || []} onChange={setClientTagIds} />
            ) : (
              <div className="flex-row" style={{ gap: 4 }}>
                {(client.tagIds || []).map((tid) => {
                  const t = selectTagById(state, tid);
                  return t ? <TagChip key={tid} tag={t} /> : null;
                })}
                {(client.tagIds || []).length === 0 && <span className="text-muted text-sm">No tags</span>}
              </div>
            )}
          </div>
          {/* Overview "Notes" card removed 2026-09-13: it dumped the legacy denormalized
              `client.notes` blob (a raw running-log copy of office notes, also seeded with
              access info) — redundant with the Notes tab (account activities) and, for
              access, with the Location's Access notes (site.accessNotes, which flows to the
              crew's clean detail + My Day). Office notes live in the Notes tab; access notes
              live on the Location. `client.notes` is still written by the note reducer
              (denormalized mirror) but no longer read — a one-source-of-truth cleanup is
              tracked as the deferred "consolidate notes" workstream. */}
          <ServiceSetupCard client={client} canEdit={canEditOps} currentUser={currentUser} />
        </div>
        </div>
        </section>

        <section id={sectionElementId('contacts')} className="detail-section" hidden={activeSection !== 'contacts'}>
        <div>
          {canEditContacts && (
            <div className="tab-actionbar">
              <button className="btn btn-primary" onClick={() => setAddContactOpen(true)}>Add Contact</button>
            </div>
          )}
          {contacts.length === 0 ? (
            <EmptyState
              icon={<Icon name="user" size={28} />}
              title="No contacts yet"
              message="Add the people you work with at this company."
              action={canEditContacts && <button className="btn btn-primary" onClick={() => setAddContactOpen(true)}>Add a contact</button>}
            />
          ) : (
            <div className="table-wrap mobile-stack">
              <table>
                <thead><tr><th></th><th>Name</th><th>Title</th><th>Email</th><th>Phone</th><th>Roles</th></tr></thead>
                  <tbody>
                    {contacts
                      .slice()
                      .sort((a, b) => (a.id === client.primaryContactId ? -1 : b.id === client.primaryContactId ? 1 : 0))
                      .map((c) => {
                        const roles = selectContactRoleFlags(state, c);
                        return (
                          <tr key={c.id} className="clickable" onClick={() => setEditContact(c)}>
                            <td className="cell-chevron" onClick={(e) => e.stopPropagation()} style={{ width: 36 }}>
                              <Avatar initials={`${(c.firstName[0] || '').toUpperCase()}${(c.lastName[0] || '').toUpperCase()}`} variant={(c.id.length % 5) + 1} size="sm" />
                            </td>
                            <td className="cell-primary">
                              <span className="name truncate" title={`${c.firstName} ${c.lastName}`}>{c.firstName} {c.lastName}</span>
                            </td>
                            <td data-label="Title"><span className="truncate" title={c.title || ''}>{c.title || '—'}</span></td>
                            <td data-label="Email" onClick={(e) => e.stopPropagation()}>{c.email
                              ? (canStartConversation
                                  ? <button type="button" className="linklike truncate" onClick={() => emailContact(c)} title={c.email}>{c.email}</button>
                                  : <span className="truncate" title={c.email}>{c.email}</span>)
                              : '—'}</td>
                            <td data-label="Phone">{c.phone || '—'}</td>
                            <td className="cell-actions" onClick={(e) => e.stopPropagation()}>
                              {canEdit ? (
                                <div className="role-toggles">
                                  <button type="button" className={`chip chip-sm ${roles.primary ? 'on' : ''}`} aria-pressed={roles.primary} onClick={() => toggleRole('primary', c.id)}>Primary</button>
                                  <button type="button" className={`chip chip-sm ${roles.billing ? 'on' : ''}`} aria-pressed={roles.billing} onClick={() => toggleRole('billing', c.id)}>Billing</button>
                                  <button type="button" className={`chip chip-sm ${roles.site ? 'on' : ''}`} aria-pressed={roles.site} disabled={!location} title={location ? undefined : 'Add a location first to set a location contact'} onClick={() => toggleRole('site', c.id)}>Location contact</button>
                                </div>
                              ) : (
                                <div className="role-toggles">
                                  {roles.primary && <span className="tier-badge">Primary</span>}
                                  {roles.billing && <span className="tier-badge">Billing</span>}
                                  {roles.site && <span className="tier-badge">Location contact</span>}
                                  {!roles.primary && !roles.billing && !roles.site && <span className="text-muted text-xs">—</span>}
                                </div>
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
          {editContact && (
            <AddContactModal open mode="edit" initialData={editContact} lockCompanyId={client.id} onClose={() => setEditContact(null)} />
          )}
        </div>
        </section>


        <section id={sectionElementId('activity')} className="detail-section" hidden={activeSection !== 'activity'}>
        <div>
          <div className="tab-container tab-container-line" role="tablist" aria-label="Activity">
            <button
              type="button"
              role="tab"
              aria-selected={activitySubTab === 'service'}
              className={`tab-btn ${activitySubTab === 'service' ? 'active' : ''}`}
              onClick={() => setActivitySubTab('service')}
            >
              <Icon name="schedule" size={14} />
              Service History
              <span className="control-count">{jobs.length}</span>
            </button>
            {canViewFinancials && (
              <button
                type="button"
                role="tab"
                aria-selected={activitySubTab === 'payment'}
                className={`tab-btn ${activitySubTab === 'payment' ? 'active' : ''}`}
                onClick={() => setActivitySubTab('payment')}
              >
                <Icon name="invoices" size={14} />
                Payment History
                <span className="control-count">{invoices.length}</span>
              </button>
            )}
            {canViewInspections && (
              <button
                type="button"
                role="tab"
                aria-selected={activitySubTab === 'inspections'}
                className={`tab-btn ${activitySubTab === 'inspections' ? 'active' : ''}`}
                onClick={() => setActivitySubTab('inspections')}
              >
                <Icon name="check" size={14} />
                Inspections
              </button>
            )}
          </div>

          {activitySubTab === 'service' && (
            jobs.length === 0 ? (
              <EmptyState icon={<Icon name="schedule" size={28} />} title="No service history" message="Jobs scheduled for this company will appear here." />
            ) : (
              <div className="activity-card-grid">
                {jobs.map((j) => {
                  const serviceName = selectServiceById(state, j.serviceId)?.name || '—';
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

          {canViewFinancials && activitySubTab === 'payment' && (
            <>
              {canRecordPayment && (
                <div className="section-head" style={{ marginBottom: 12 }}>
                  <span className="text-muted text-sm">Manual payment tracking</span>
                  <button type="button" className="btn btn-outline" onClick={() => setLogPaymentOpen(true)}>
                    Record Payment
                  </button>
                </div>
              )}
              {invoices.length === 0 ? (
                <EmptyState
                  icon={<Icon name="invoices" size={28} />}
                  title="No payment history"
                  message="Invoices and payments logged for this company will appear here."
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
                            {/* A void invoice's remainder is not collectible — showing it as a
                                red Balance would contradict the account card above, which counts
                                this invoice's payments as CREDIT (owner decision 2026-07-21). */}
                            {st === 'void'
                              ? (invoicePaid(inv) > 0 && <> · <span className="text-muted">{money(invoicePaid(inv))} paid → credit</span></>)
                              : (balance > 0 && <> · <span className="text-danger">Balance {money(balance)}</span></>)}
                          </div>
                        </div>
                        <Badge variant={st === 'void' ? 'slate' : statusBadgeVariant(st === 'paid' ? 'Paid' : st === 'overdue' ? 'Overdue' : 'Pending')}>
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

          {canViewInspections && activitySubTab === 'inspections' && (
            <ClientInspections client={client} />
          )}
        </div>
        </section>

        <section id={sectionElementId('access')} className="detail-section" hidden={activeSection !== 'access'}>
        <div>
          {location ? (
            <>
              <LocationCard client={client} location={location} canEdit={canEditSites} />
              <div className="card detail-card">
                <MediaGallery siteId={location.id} clientId={client.id} scope="cleaning_instruction" label="Photos & video" hint="Photos and video for this account. Crew can add them from the field. Images up to 10MB, video up to 200MB." />
              </div>
            </>
          ) : (
            <EmptyState icon={<Icon name="building" size={28} />} title="No location yet" message="This account has no service location on file." />
          )}
        </div>
        </section>

        <section id={sectionElementId('notes')} className="detail-section" hidden={activeSection !== 'notes'}>
        <div>
          {canView && <OpsNoteCard client={client} canEdit={canEditOps} currentUser={currentUser} />}
          {canView && location && <CleaningInstructionsCard location={location} canEdit={canEditSites} />}
          {canView && (
            <div className="card" style={{ marginBottom: 16 }}>
              <FormField label="Add office note" as="textarea" className="input note-field" value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Arrival instructions, preferences, follow-ups…" />
              {noteAttachment && (
                <div className="note-attachment-pending">
                  <span className="email-attachment-chip">
                    <Icon name="paperclip" size={12} />
                    <span>{noteAttachment.name}</span>
                    <button
                      type="button"
                      className="chip-remove"
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
          {noteActivities.length === 0 ? (
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
                          <div className="note-item-author">{author?.name || n.authorName || 'Someone'}</div>
                          <div className="note-item-time text-xs text-muted">
                            {fmtRelative(n.occurredAt)}
                            {n.editedAt && <> · edited {fmtRelative(n.editedAt)}</>}
                          </div>
                        </div>
                      </div>
                      {canEdit && !isEditing && (
                        <div className="note-item-actions">
                          <button type="button" className="btn btn-primary" onClick={() => startEditNote(n)}>Edit</button>
                          <button type="button" className="btn btn-danger" onClick={() => setConfirmDeleteNoteId(n.id)}>Delete</button>
                        </div>
                      )}
                    </div>
                    {isEditing ? (
                      <div style={{ marginTop: 8 }}>
                        <FormField label="" as="textarea" value={editingNoteText} onChange={(e) => setEditingNoteText(e.target.value)} />
                        <div className="flex-row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                          <button type="button" className="btn btn-outline" onClick={cancelEditNote}>Cancel</button>
                          <button type="button" className="btn btn-primary" onClick={saveEditNote} disabled={!editingNoteText.trim()}>Save</button>
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
            </div>
          )}
        </div>
        </section>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title={`Delete ${client.name}?`}
        message="This permanently removes the company, its contacts, location, jobs, and invoices. Conversations linked to those contacts will be unlinked but preserved. This cannot be undone."
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
      <LogPaymentModal
        open={logPaymentOpen}
        onClose={() => setLogPaymentOpen(false)}
        presetClientId={client.id}
      />
    </div>
  );
}
