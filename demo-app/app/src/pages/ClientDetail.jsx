import { useState, useMemo, useEffect, useRef } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import { useDispatch, useStore, useJobsHydrated, useClientJobs } from '../store';
import { ACTIONS } from '../store/reducer';
import { newId } from '../lib/ids';
import {
  selectClientById, selectVisibleSitesFor, selectJobsForClient, selectInvoicesForClient,
  selectServiceById, selectFrequencies, selectServices, selectContactsForClient, selectContactById,
  selectActivitiesForClient, selectUserById, selectConversationsForContact, selectContactRoleFlags,
  selectVisibleClientIdsFor, selectTagById,
  selectClientLifetimeRevenue, selectClientBalance, selectClientBadgeStatus,
  selectClientCredit, selectCurrentUser,
  invoiceTotal, invoiceBalance, invoicePaid, deriveInvoiceStatus,
} from '../store/selectors';
import { isOfficeRole } from '../lib/roles';
import { usePermission, useCanEditJobs } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import { useAuth } from '../hooks/useAuth';
import DetailHeader from '../components/DetailHeader';
import { useTicketFlags } from '../hooks/useTicketFlags';
import { useKeptSupplyBudgets } from '../hooks/useSupplyBudgets';
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
import { fmtDate, fmtTimeRange, money } from '../lib/dates';
import { customerLabel, customerNumberProblem, normalizeCustomerNumber } from '../lib/customerNumber';
import { isArchivedCustomer, archiveSchedulePlan } from '../lib/customerStatus';
import { useT } from '../i18n/react';
import { timeShort } from '../i18n/relative';
import { formatBytes } from '../lib/attachments';
import { uploadSiteAttachment, deleteSiteAttachment, attachmentUrl, isAttachmentStored, ATTACHMENT_SCOPE } from '../lib/siteAttachmentsApi';
import { SITE_ATTACHMENT_ALLOWED_MIME, SITE_ATTACHMENT_MAX_BYTES } from '../lib/siteAttachmentRules';
import ClientInspections from '../components/ClientInspections';
import ClientSurveys from '../components/ClientSurveys';
import ClientActivityLog from '../components/ClientActivityLog';
import ClientLoginsCard from '../components/ClientLoginsCard';
import ClientContracts from '../components/ClientContracts';
import ClientDocuments from '../components/ClientDocuments';
import ServiceSetupCard from '../components/ServiceSetupCard';
import SpecialServicesCard from '../components/SpecialServicesCard';
import ClientSupplies from '../components/ClientSupplies';
import { useSupplyList } from '../hooks/useSupplyList';
import { clientSectionKeys } from '../lib/clientSections';
import { isOnboarding } from '../lib/onboarding';
import OnboardingBar, { useOnboardingContracts } from '../components/OnboardingBar';
import CustomerThread from '../components/CustomerThread';
import TextsOffNote from '../components/TextsOffNote';
import { useCustomerTextStatus } from '../hooks/useCustomerTextStatus';
import { startPreviewOf } from '../components/HubPreviewPicker';
import OpsNoteCard from '../components/OpsNoteCard';
import SectionTabs, { sectionElementId } from '../components/SectionTabs';


export default function ClientDetail() {
  const t = useT();
  const { clientId } = useParams();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const navigate = useNavigate();
  const nav = useFromHere();
  const canEdit = usePermission('clients.edit');
  const canView = usePermission('clients.view');
  // CS-663: customers are ARCHIVED, never deleted. `clients.delete` is "Archive customers".
  const canArchiveClient = usePermission('clients.delete');
  const canEditJobs = useCanEditJobs();
  // The archive takes the customer's cleans not started yet off the schedule, so it waits until
  // every clean has loaded (the boot paints a window first) — a partial set would miss some.
  const jobsHydrated = useJobsHydrated();
  const canEditSites = usePermission('sites.edit');
  // WO-14: the ticket flag, from the same read the customers list uses. Called here, above the
  // not-found early return, because a hook must run on every render.
  const ticketFlags = useTicketFlags();
  // SUP-7 / SUP-10: the over-budget supply flag, from the same kept read the customers list
  // uses, so the two can never disagree. Called here, above the not-found early return, because
  // a hook must run on every render.
  const supplyBudgets = useKeptSupplyBudgets();
  const canViewSupplies = usePermission('supplies.view');
  const canEditContacts = usePermission('contacts.edit');
  const canEditOps = usePermission('ops.edit');
  const { currentUser } = useAuth();
  // Which of this customer's numbers have texts off (they replied STOP): a read-only note beside
  // each (2026-10-28). Called above the not-found early return: a hook runs on every render.
  const canViewContacts = usePermission('contacts.view');
  const textsOffFor = useCustomerTextStatus(clientId, canViewContacts);

  const rawClient = selectClientById(state, clientId);
  // Crew can only see clients they have a job on; admin/owner see all.
  const visibleClientIds = useMemo(
    () => selectVisibleClientIdsFor(state, currentUser),
    [state, currentUser]
  );
  const client = rawClient && (currentUser?.role !== 'crew' || visibleClientIds.has(rawClient.id))
    ? rawClient
    : null;
  // Round 3 (Daniel, 2026-10-06): the building's own Supplies tab. ONE read of its list (with each
  // item's delivery history) feeds both the tab's count and the tab, so they cannot disagree.
  // Called above the not-found early return, because a hook must run on every render.
  const supplyList = useSupplyList(client ? client.id : null, { enabled: canViewSupplies, history: true });
  // Site cards are crew-scoped: site-standing / job-at-site crew see only THEIR
  // site(s); account standing crew + managers see all (selectVisibleSitesFor).
  // Keys stay account-wide below regardless — deliberate (per-company inventory).
  // Every customer has exactly one location (a `site`); crew see it only when
  // assigned to a job there, managers always. `location` is that single record.
  const sites = client ? selectVisibleSitesFor(state, currentUser).filter((x) => x.clientId === client.id) : [];
  const location = sites[0] || null;
  // The customer's whole history of cleans: the app holds only the jobs window (−45/+100
  // days, CS-676), so opening a customer loads the rest of theirs (by customer, never the table).
  const historyLoad = useClientJobs(client?.id || null);
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
  // The Contract tab only exists for a login that may see contracts (CON: owner/admin/manager,
  // never crew), and the Supplies tab for a `supplies.view` holder, so the tab list is built from
  // the permissions rather than hidden after the fact — an absent tab also clamps a stale
  // `?tab=contract` / `?tab=supplies` back to Overview (lib/clientSections, one rule).
  const canViewContracts = usePermission('contracts.view');
  // The client hub redesign: the building's conversation with its customers (plan §3.4, D5) and
  // its Documents tab (the COI, the W-9, the agreement line; §3.6) — office keys, never crew.
  const canViewMessages = usePermission('hub.messages.view');
  const canManageDocuments = usePermission('hub.documents.manage');
  // "Preview customer hub" (plan §3.7, decision D2): this building's hub exactly as its customers
  // see it, read-only. The key that shows who can sign in to it; the server checks it again.
  const canPreviewHub = usePermission('hub.users.view');
  const sectionKeys = useMemo(
    () => clientSectionKeys({ contracts: canViewContracts, documents: canManageDocuments, supplies: canViewSupplies, messages: canViewMessages }),
    [canViewContracts, canManageDocuments, canViewSupplies, canViewMessages],
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
  // GO-2 / CS-068: what is wrong with the typed customer number, in words (empty = nothing).
  const [numberError, setNumberError] = useState('');
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [noteAttachment, setNoteAttachment] = useState(null);
  const [noteUploading, setNoteUploading] = useState(false);
  const noteFileRef = useRef(null);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [editContact, setEditContact] = useState(null);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [editingNoteText, setEditingNoteText] = useState('');
  const [confirmDeleteNoteId, setConfirmDeleteNoteId] = useState(null);
  const [logPaymentOpen, setLogPaymentOpen] = useState(false);
  // NEW-CUSTOMER ONBOARDING (task 471, UI_RULES §190): the bar above the tabs while a new customer
  // is onboarding (never an archived one), kept drawn all green for the rest of this visit once it
  // finishes here, so nothing jumps under the office. Its contracts read only while it is drawn.
  const [onbStayed, setOnbStayed] = useState(false);
  const onboardingNow = !!client && isOnboarding(client) && !isArchivedCustomer(client);
  const onbShown = onboardingNow || (onbStayed && !!client && !isArchivedCustomer(client));
  const onbContracts = useOnboardingContracts(client?.id || null, onbShown && canViewContracts);
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
  // The Surveys toggle reads /api/qc/surveys (EP-426): qc.view AND an office role — a cleaner holds
  // qc.view for checklists, never a customer's ratings (the server refuses them whatever they hold).
  const canViewSurveys = canViewInspections && isOfficeRole(selectCurrentUser(state)?.role);
  // The Activity log toggle reads /api/activity/list, gated `activity.view` — a role without
  // it gets no toggle rather than a refused read. Crew are refused by the server whatever
  // they hold (LOG-4's role floor), so the toggle is not the boundary.
  const canViewActivity = usePermission('activity.view');

  const activities = useMemo(() => (client ? selectActivitiesForClient(state, client.id) : []), [state, client?.id]);
  const noteActivities = useMemo(() => activities.filter((a) => a.kind === 'note'), [activities]);
  // ARCHIVE (CS-663) needs clients.delete AND the jobs-write tier (useCanEditJobs): the archive
  // takes the customer's cleans not started yet off the schedule, and the server's jobsGuard puts
  // that job half back for anyone without schedule.edit, which would leave an archived building
  // still being cleaned. So an archive the caller can't fully complete is not offered — the rule
  // the customer delete had (owner's call, 2026-09-23), and the Customers bulk bar's. RESTORE puts
  // the status back and touches no clean, so clients.delete alone.
  const canArchive = canArchiveClient && canEditJobs && jobsHydrated;
  const canRestore = canArchiveClient;
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
    const numberChanged = (normalizeCustomerNumber(form.customerNumber) ?? form.customerNumber ?? null) !== (client.customerNumber ?? null);
    return numberChanged || fields.some((f) => (form[f] ?? null) !== (client[f] ?? null));
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
  // Returns false when the edit cannot be saved as typed (the editor stays open, saying why).
  const save = () => {
    // GO-2 / CS-068: a customer number is four digits and nobody else's — refused in words here,
    // and by the same rule in the reducer (lib/customerNumber.js).
    const isVendor = client.type === 'vendor';
    const problem = isVendor ? null : customerNumberProblem(state.clients, form.customerNumber, client.id);
    if (problem) {
      setNumberError(problem.code === 'taken'
        ? t('custNumber.taken', { number: problem.number, customer: problem.holder.name || problem.number })
        : t('custNumber.invalid'));
      return false;
    }
    setNumberError('');
    const candidate = {
      name: form.name,
      serviceId: form.serviceId, frequencyId: form.frequencyId,
      primaryContactId: form.primaryContactId || null,
      ...(isVendor ? {} : { customerNumber: normalizeCustomerNumber(form.customerNumber) }),
    };
    const base = baseline.current || client;
    const patch = {};
    for (const [k, v] of Object.entries(candidate)) {
      if ((v ?? null) !== (base[k] ?? null)) patch[k] = v;
    }
    if (Object.keys(patch).length === 0) {
      toast.success('No changes to save');
      return true;
    }
    dispatch({ type: ACTIONS.UPDATE_CLIENT, id: client.id, patch });
    toast.success('Company updated');
    return true;
  };

  const cancel = () => { setNumberError(''); seedForm(client); };

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

  // CS-663: archive, never delete. The customer stays (its page, number, contacts, invoices and
  // history), leaves every working surface, and can be restored; its upcoming cleans come off.
  const archived = isArchivedCustomer(client);
  const upcomingToEnd = archived ? 0 : archiveSchedulePlan(state.jobs, client.id, Date.now()).removeIds.length;
  const archiveClient = () => {
    dispatch({ type: ACTIONS.ARCHIVE_CLIENT, id: client.id, by: currentUser?.id || null });
    setConfirmArchive(false);
    toast.success(t('custArchive.archived', { customer: client.name }));
  };
  const restoreClient = () => {
    dispatch({ type: ACTIONS.RESTORE_CLIENT, id: client.id });
    setConfirmRestore(false);
    toast.success(t('custArchive.restored', { customer: client.name }));
  };
  const archivedByName = client.archivedBy ? selectUserById(state, client.archivedBy)?.name || null : null;

  // Open a note's attachment through a short-lived signed URL, gated server-side on the
  // customer record's own permissions (clients.view) — the same gate that shows the note.
  const openNoteAttachment = async (att) => {
    if (!isAttachmentStored(att)) {
      toast.error(`"${att.name}" was recorded before files were uploaded, so there’s nothing to open. Re-attach it.`);
      return;
    }
    try {
      const url = await attachmentUrl(att, { scope: ATTACHMENT_SCOPE.CLIENT_NOTE, ownerId: client.id });
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      else toast.error(`Couldn’t open "${att.name}".`);
    } catch (err) {
      toast.error(err.message || `Couldn’t open "${att.name}".`);
    }
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

  // CS-962, CS-963: opened before the app's first read of the ticket counts or the supply spend has
  // answered, the page waits for it (live, 2026-11-02: the counts 0.74 to 0.93 seconds, the spend
  // 0.97 to 1.85), so it draws once, with its flags in place beside the status.
  if (!ticketFlags.ready || !supplyBudgets.ready) return <div className="page-pad" aria-busy="true" />;

  return (
    <div className="page-pad">
      <DetailHeader
        backTo="/contacts"
        backLabel="Customers"
        title={customerLabel(client)}
        badge={(
          <span className="flex-row detail-head-badges">
            <ClientStatusMenu
              value={clientStatus}
              canEdit={canEdit && !archived}
              onChange={(choice) => dispatch({
                type: ACTIONS.UPDATE_CLIENT,
                id: client.id,
                patch: choice === 'vendor' ? { type: 'vendor' } : { type: 'customer', statusOverride: choice },
              })}
            />
            {/* WO-14 (Matt, 2026-09-29): "a flag on the account when it passes a set number of
                tickets in 30 days." Beside the status, because that is where someone opening the
                customer looks first. */}
            {ticketFlags.isFlagged(client.id) && (
              <Badge variant="red" title={`Flagged: ${ticketFlags.countFor(client.id)} work orders in the last ${ticketFlags.days} days (threshold ${ticketFlags.threshold}).`}>
                {ticketFlags.labelFor(client.id)}
              </Badge>
            )}
            {/* SUP-7 (b) / SUP-10 ★a (Matt, 2026-09-29): "the account is flagged as over budget
                for supplies." Beside the ticket flag, for the same reason — it is what someone
                opening the customer needs to know before they approve anything else. */}
            {canViewSupplies && supplyBudgets.isOver(client.id) && (
              <Badge variant="red" title={`Over this building's monthly supply budget: ${supplyBudgets.labelFor(client.id)}.`}>
                Over supply budget
              </Badge>
            )}
          </span>
        )}
        actions={
          <div className="flex-row" style={{ gap: 8 }}>
            {canPreviewHub && client.type !== 'vendor' && !archived && (
              <button type="button" className="btn btn-outline" onClick={() => startPreviewOf(navigate, client)}>
                <Icon name="building" size={16} /> {t('hubPreview.button')}
              </button>
            )}
            {canStartConversation && (
              <MessageContactMenu contacts={contacts} clientId={client.id} disabled={contacts.length === 0} />
            )}
            {!archived && canArchive && (
              <button type="button" className="btn btn-outline" onClick={() => setConfirmArchive(true)}>{t('custArchive.button')}</button>
            )}
            {archived && canRestore && (
              <button type="button" className="btn btn-primary" onClick={() => setConfirmRestore(true)}>{t('custArchive.restore')}</button>
            )}
          </div>
        }
      />

      {/* CS-663: an archived customer says so where anyone opening it looks first. */}
      {archived && (
        <div className="callout callout-warning text-sm mb-14">
          {archivedByName
            ? t('custArchive.banner', { date: fmtDate(client.archivedAt), name: archivedByName })
            : t('custArchive.bannerNoName', { date: fmtDate(client.archivedAt) })}
        </div>
      )}

      {onbShown && (
        <OnboardingBar
          client={client}
          location={location}
          primaryContact={primaryContact}
          jobsReady={historyLoad.ready}
          supply={supplyList}
          contractsRead={onbContracts}
          canEdit={canEdit}
          onEditDetails={() => { setActiveKey('overview'); setEditOverview(true); }}
          onOpenTab={(key, { edit = false } = {}) => {
            // The Supplies tab opens its switches from `?edit=1` (ClientSupplies), the order sheet's way.
            if (edit) navigate({ search: `?tab=${key}&edit=1` }, { replace: true, state: routerLocation.state });
            else setActiveKey(key);
          }}
          onAddContact={() => setAddContactOpen(true)}
          onEditContact={(c) => setEditContact(c)}
          onFinished={() => setOnbStayed(true)}
        />
      )}

      <div className="detail-tabs">
        <SectionTabs
          sections={[
            { key: 'overview', label: 'Overview' },
            { key: 'access', label: 'Access' },
            { key: 'contacts', label: 'Contacts', count: contacts.length },
            ...(canViewContracts ? [{ key: 'contract', label: 'Contract' }] : []),
            ...(canManageDocuments ? [{ key: 'documents', label: t('custDocs.tab') }] : []),
            // The count is the building's list, once it has loaded (an unread list shows no number).
            ...(canViewSupplies ? [{ key: 'supplies', label: t('supplyPage.cust.tab'), count: supplyList.items ? supplyList.items.length : null }] : []),
            ...(canViewMessages ? [{ key: 'messages', label: t('custMsg.customerTab') }] : []),
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
              {client.type !== 'vendor' && (
                <>
                  <label className="inline-edit-label" htmlFor="cli-number">{t('custNumber.label')}</label>
                  <div className="inline-edit-value">
                    <input
                      id="cli-number"
                      className="input"
                      inputMode="numeric"
                      maxLength={4}
                      placeholder="0001"
                      value={form?.customerNumber || ''}
                      onChange={(e) => { setNumberError(''); setForm({ ...form, customerNumber: e.target.value }); }}
                      disabled={!canEdit}
                      aria-invalid={numberError ? 'true' : undefined}
                    />
                    {numberError
                      ? <div className="form-error">{numberError}</div>
                      : <div className="form-help">{t('custNumber.help')}</div>}
                  </div>
                </>
              )}

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
                <div className="inline-edit-readonly muted">{primaryContact?.phone || '—'}<TextsOffNote optedOutAt={textsOffFor(primaryContact?.phone)} /></div>
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
              <button type="button" className="btn btn-primary" onClick={() => { if (save()) setEditOverview(false); }}>Save Changes</button>
            </div>
            </>
          ) : (
            <dl className="detail-dl">
              {client.type !== 'vendor' && <div><dt>{t('custNumber.label')}</dt><dd>{client.customerNumber || '—'}</dd></div>}
              <div><dt>Primary contact</dt><dd>{primaryContact
                ? <>{primaryContact.firstName} {primaryContact.lastName}{primaryContact.title && <span className="text-muted"> · {primaryContact.title}</span>}</>
                : '—'}</dd></div>
              <div><dt>Email</dt><dd>{primaryContact?.email || '—'}</dd></div>
              <div><dt>Phone</dt><dd>{primaryContact?.phone || '—'}<TextsOffNote optedOutAt={textsOffFor(primaryContact?.phone)} /></dd></div>
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
          {/* Task 507 (UI_RULES §192): the building's recurring special services, with their
              reminders; the onboarding bar's Special services step reads the same record. */}
          <SpecialServicesCard client={client} canEdit={canEdit} />
          {/* The building's supply budget and order day moved to its Supplies tab (round 3). */}
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
                            <td data-label="Phone">{c.phone || '—'}<TextsOffNote optedOutAt={textsOffFor(c.phone)} /></td>
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
            <AddContactModal open mode="edit" initialData={editContact} lockCompanyId={client.id} textsOffFor={textsOffFor} onClose={() => setEditContact(null)} />
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
            {canViewSurveys && (
              <button
                type="button"
                role="tab"
                aria-selected={activitySubTab === 'surveys'}
                className={`tab-btn ${activitySubTab === 'surveys' ? 'active' : ''}`}
                onClick={() => setActivitySubTab('surveys')}
              >
                <Icon name="star" size={14} />
                Surveys
              </button>
            )}
            {/* CS-379 — this account's recorded activity. `activity.view` decides whether the
                tab is offered; the SERVER decides what it serves (LOG-4), so a manager who
                does not supervise this customer gets an empty, honest list. */}
            {canViewActivity && (
              <button
                type="button"
                role="tab"
                aria-selected={activitySubTab === 'log'}
                className={`tab-btn ${activitySubTab === 'log' ? 'active' : ''}`}
                onClick={() => setActivitySubTab('log')}
              >
                <Icon name="chart" size={14} />
                Activity log
              </button>
            )}
          </div>

          {activitySubTab === 'service' && !historyLoad.ready && (
            <div className={`callout ${historyLoad.error ? 'callout-warning' : 'callout-info'} text-sm mb-14`} role="status">
              {historyLoad.error ? (
                <>
                  {t('jobsLoad.historyFailed')}{' '}
                  <button type="button" className="btn btn-outline" onClick={historyLoad.retry}>{t('common.retry')}</button>
                </>
              ) : t('jobsLoad.history')}
            </div>
          )}
          {activitySubTab === 'service' && (
            jobs.length === 0 ? (
              // "No service history" only once the history has been asked for: while it loads (or
              // when it could not load) the line above says so, and an empty state would be a lie.
              historyLoad.ready ? <EmptyState icon={<Icon name="schedule" size={28} />} title="No service history" message="Jobs scheduled for this company will appear here." /> : null
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

          {canViewSurveys && activitySubTab === 'surveys' && (
            <ClientSurveys client={client} />
          )}

          {canViewActivity && activitySubTab === 'log' && (
            <ClientActivityLog client={client} />
          )}
        </div>
        </section>

        {/* CON-1..CON-14: the signed agreement for this building — its term, its year
            prices, its extra services, its reminders and the signed PDF. Contracts live in
            their own tables, so this tab fetches; it is MOUNTED only when it is the active
            one, because an unopened tab must not make a request on every customer page. */}
        {canViewContracts && (
          <section id={sectionElementId('contract')} className="detail-section" hidden={activeSection !== 'contract'}>
            {activeSection === 'contract' && <ClientContracts clientId={client.id} clients={state.clients} onChanged={onbContracts.reload} />}
          </section>
        )}

        {/* The client hub redesign (plan 2026-10-08 §3.6): what this building's customer downloads
            from the hub — the agreement line (linking to the Contract tab), the COI and the
            company's W-9. MOUNTED only when it is the active tab, like the Contract tab. */}
        {canManageDocuments && (
          <section id={sectionElementId('documents')} className="detail-section" hidden={activeSection !== 'documents'}>
            {activeSection === 'documents' && (
              <ClientDocuments clientId={client.id} onOpenContract={canViewContracts ? () => setActiveKey('contract') : null} />
            )}
          </section>
        )}

        {/* Round 3 (Daniel, 2026-10-06): the building's own Supplies tab — its list, budget and
            order day, and its requests. MOUNTED only when it is the active tab (its requests are a
            read of their own), like the Contract tab; the list read above feeds the tab's count. */}
        {canViewSupplies && (
          <section id={sectionElementId('supplies')} className="detail-section" hidden={activeSection !== 'supplies'}>
            {activeSection === 'supplies' && <ClientSupplies client={client} budgets={supplyBudgets} list={supplyList} />}
          </section>
        )}

        {/* The client hub redesign (plan §3.4, D5): this building's conversation with its customers
            — the same thread Messaging → Customers opens. Server-read (/api/client-messages), so it
            is MOUNTED only when it is the active tab, like Contract and Supplies. */}
        {canViewMessages && (
          <section id={sectionElementId('messages')} className="detail-section" hidden={activeSection !== 'messages'}>
            {activeSection === 'messages' && <CustomerThread clientId={client.id} layout="card" />}
          </section>
        )}

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
          {/* Who on the CUSTOMER's side can sign in and see this building (the client hub).
              Hidden entirely without hub.users.view, and in demo mode. */}
          <ClientLoginsCard clientId={client.id} />
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
                        // Drop the uploaded object too — an unreferenced file is one
                        // nobody can reach and nobody can clean up later.
                        deleteSiteAttachment(noteAttachment, { scope: ATTACHMENT_SCOPE.CLIENT_NOTE, ownerId: client.id });
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
                accept={SITE_ATTACHMENT_ALLOWED_MIME.join(',')}
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  // The cap the SERVER enforces (siteAttachmentRules), not the separate
                  // invoice/marketing constant that happened to hold the same number.
                  if (f.size > SITE_ATTACHMENT_MAX_BYTES) {
                    toast.error(`File too large (${formatBytes(f.size)}). Max ${formatBytes(SITE_ATTACHMENT_MAX_BYTES)}.`);
                    e.target.value = '';
                    return;
                  }
                  // Upload the BYTES here (CS-043). This used to keep only
                  // { name, size, type }, so the note showed a filename chip with no file
                  // behind it anywhere. Uploaded on pick, so the chip can only appear for
                  // a file that actually landed; the note carries its storagePath.
                  setNoteUploading(true);
                  try {
                    setNoteAttachment(await uploadSiteAttachment(f, { scope: ATTACHMENT_SCOPE.CLIENT_NOTE, ownerId: client.id }));
                  } catch (err) {
                    toast.error(`"${f.name}" didn’t upload. ${err.message || 'Please try again.'}`);
                    e.target.value = '';
                  } finally {
                    setNoteUploading(false);
                  }
                }}
              />
              <div className="modal-actions">
                <button
                  type="button"
                  className="btn btn-success"
                  disabled={noteUploading}
                  onClick={() => noteFileRef.current?.click()}
                >
                  {noteUploading ? 'Uploading…' : 'Add Attachment'}
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
                        {author && <Avatar user={author} size="sm" />}
                        <div>
                          <div className="note-item-author">{author?.name || n.authorName || 'Someone'}</div>
                          <div className="note-item-time text-xs text-muted">
                            {timeShort(t, n.occurredAt)}
                            {n.editedAt && <> · {t('ago.edited', { when: timeShort(t, n.editedAt) })}</>}
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
                            {/* Opens through a short-lived signed URL (CS-043). Inert text
                                before; a note saved back then has no bytes, so it says so
                                instead of offering a dead link. */}
                            <span className="email-attachment-chip">
                              <Icon name="paperclip" size={12} />
                              <button
                                type="button"
                                className="btn btn-link"
                                onClick={() => openNoteAttachment(n.attachment)}
                                title={isAttachmentStored(n.attachment) ? `Open ${n.attachment.name}` : 'This file was never uploaded — re-attach it'}
                              >
                                {n.attachment.name}
                              </button>
                              {!isAttachmentStored(n.attachment) && <span className="text-muted text-xs">(not uploaded)</span>}
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
        open={confirmArchive}
        title={t('custArchive.confirmTitle', { customer: client.name })}
        message={`${t('custArchive.confirmMessage', { customer: client.name })} ${upcomingToEnd ? t('custArchive.confirmCleans', { count: upcomingToEnd }) : ''}`.trim()}
        confirmLabel={t('custArchive.confirm')}
        onConfirm={archiveClient}
        onClose={() => setConfirmArchive(false)}
      />
      <ConfirmDialog
        open={confirmRestore}
        title={t('custArchive.restoreTitle', { customer: client.name })}
        message={t('custArchive.restoreMessage')}
        confirmLabel={t('custArchive.restoreConfirm')}
        onConfirm={restoreClient}
        onClose={() => setConfirmRestore(false)}
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
