import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Badge, { DERIVED_STATUS_VARIANTS } from '../components/Badge';
import { useTicketFlags } from '../hooks/useTicketFlags';
import { useKeptSupplyBudgets } from '../hooks/useSupplyBudgets';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import FormField from '../components/FormField';
import Avatar from '../components/Avatar';
import TagChip from '../components/TagChip';
import TagPicker from '../components/TagPicker';
import FilterSelect from '../components/FilterSelect';
import AddCompanyModal from '../components/AddCompanyModal';
import CsvImportModal from '../components/CsvImportModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { useDispatch, useStore, useJobsHydrated } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { usePermission, useCanEditJobs } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import {
  selectContactById, selectTags, selectTagById, selectVisibleClientsFor, selectClientBadgeStatus,
} from '../store/selectors';
import { english } from '../i18n/core';
import { useT } from '../i18n/react';
import { isArchivedCustomer } from '../lib/customerStatus';
import { timeShort } from '../i18n/relative';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from '../components/ListPager';
import { customerLabel } from '../lib/customerNumber';
import { useScanLinksDownload } from '../hooks/useScanLinksDownload';

// Derived status (Jobber-style): Lead (no work yet) vs Active (has a job/invoice).
// Color map is shared from Badge (DERIVED_STATUS_VARIANTS) so the hub can't drift from the detail views.
// ARCHIVED (CS-663) is the last: an archived customer is out of the list unless this filter asks.
// ONBOARDING (task 471, UI_RULES §190) is the first: a new customer whose onboarding bar isn't all
// green yet, so the office pulls up the unfinished ones in one click.
const STATUSES = ['onboarding', 'lead', 'active', 'inactive', 'vendor', 'archived'];
const statusLabel = (t, s) => (s === 'archived' ? t('custArchive.badge') : s === 'onboarding' ? t('onboarding.badge') : cap(s));
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const companyInitials = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

// Customer-first hub (Jobber-style, Client-primary). The list IS your customers:
// each row is a business/account you clean for. People are contacts UNDER a
// customer, reached by opening it (its contacts, sites, jobs, invoices). There are
// no floating people and no "typed company that isn't a record": every person
// belongs to exactly one customer.
export default function Clients() {
  const t = useT();
  const state = useStore();
  const navigate = useNavigate();
  const nav = useFromHere();
  const dispatch = useDispatch();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canEditClients = usePermission('clients.edit');
  // WO-14: one read for the whole list, shared with the customer page through the hook.
  const ticketFlags = useTicketFlags();
  // SUP-7 / SUP-10: the over-budget supply flag, from the same kept read the customer page
  // uses, so the list and the page can never disagree about which accounts are flagged.
  const supplyBudgets = useKeptSupplyBudgets();
  const canViewSupplies = usePermission('supplies.view');
  // Adding customers — one at a time or a spreadsheet of them — is "Create / edit customers",
  // and the server checks the same key (orgStateGuard: "add a customer"). contacts.edit alone
  // used to show both buttons, for a save the server would now refuse (UI_RULES §118).
  const canAddCustomers = canEditClients;
  // Bulk actions are gated exactly like their single-record twins on ClientDetail:
  // Apply tags ← clients.edit (the key the customer TagPicker edits under), Archive ←
  // clients.delete ("Archive customers": customers are ARCHIVED, never deleted — CS-663).
  // Archive additionally requires useCanEditJobs (owner/admin, or a manager holding
  // schedule.edit) and every clean loaded: the archive takes each customer's cleans not
  // started yet off the schedule, and the server's jobsGuard puts that job half BACK for
  // anyone without schedule.edit, which would leave an archived building still being
  // cleaned. So an archive the caller can't fully complete is not offered (the owner's
  // call of 2026-09-23 for the delete it replaces). The selection UI (checkboxes + bulk
  // bar) appears only when at least one bulk action is available — /clients is reachable
  // by URL for anyone with clients.view or contacts.view (crew hold both by default), and
  // the nav hiding it is not a gate.
  const canArchiveClients = usePermission('clients.delete');
  const canEditJobs = useCanEditJobs();
  const jobsHydrated = useJobsHydrated();
  const canBulkTag = canEditClients;
  const canBulkArchive = canArchiveClients && canEditJobs && jobsHydrated;
  const canBulkSelect = canBulkTag || canBulkArchive;
  // QR Wave 1 (2026-10-16): every building's QR code links as one spreadsheet, for the office's
  // own label software (EP-412). One implementation, shared with the QR codes page (UI_RULES §183).
  const qrLinks = useScanLinksDownload();

  const clients = useMemo(() => selectVisibleClientsFor(state, currentUser), [state, currentUser]);
  const allTags = selectTags(state);

  const [searchParams, setSearchParams] = useSearchParams();
  const setParam = (key, value, def) => {
    const next = new URLSearchParams(searchParams);
    if (value === '' || value == null || value === def) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };
  // Filters (URL-backed, so Back restores the exact filtered view).
  const cSearch = searchParams.get('q') || '';
  const cStatus = searchParams.get('status') || '';
  const cTag = searchParams.get('tag') || '';

  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkTagIds, setBulkTagIds] = useState([]);
  const [addOpen, setAddOpen] = useState(false);
  // Global search "Add customer" deep-link: ?new=1 opens the add modal once, then the param
  // is stripped (preserving any co-resident filter params). Gated on the page's own create
  // permission so a perm-less deep-link is a silent no-op.
  useEffect(() => {
    if (searchParams.get('new') && canAddCustomers) {
      setAddOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, canAddCustomers, setSearchParams]);
  const [csvOpen, setCsvOpen] = useState(false);
  const [confirmArchiveOpen, setConfirmArchiveOpen] = useState(false);

  const showingArchived = cStatus === 'archived';
  const filtered = useMemo(() => {
    const q = cSearch.trim().toLowerCase();
    return clients.filter((cl) => {
      // CS-663: an archived customer is history — out of the list unless the filter asks for it.
      if (!showingArchived && isArchivedCustomer(cl)) return false;
      if (cStatus && selectClientBadgeStatus(state, cl) !== cStatus) return false;
      if (cTag && !(cl.tagIds || []).includes(cTag)) return false;
      if (q) {
        // The customer number too (GO-2): "0001", or the whole "0001 Ball Harbor Village".
        const hay = [customerLabel(cl), cl.customerNumber, cl.primaryContact, cl.email, cl.phone].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [clients, cSearch, cStatus, cTag, state, showingArchived]);
  const archivedHidden = useMemo(
    () => (showingArchived ? 0 : clients.filter(isArchivedCustomer).length), [clients, showingArchived],
  );

  // Pagination (URL-backed, 20/page via the shared hook). Select-all + bulk actions
  // span the FULL filtered set, not just the visible page.
  const pager = usePagedRows(filtered, { param: 'cpage', resetKey: `${cSearch}|${cStatus}|${cTag}` });
  const selectableKeys = useMemo(() => filtered.map((cl) => cl.id), [filtered]);

  const toggleSelected = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleSelectAll = () => setSelectedIds((prev) => (prev.size === selectableKeys.length ? new Set() : new Set(selectableKeys)));
  const clearSelection = () => setSelectedIds(new Set());

  const bulkApplyTags = () => {
    if (!canBulkTag || bulkTagIds.length === 0) return;
    selectedIds.forEach((id) => bulkTagIds.forEach((tagId) => dispatch({ type: ACTIONS.TAG_CLIENT, id, tagId })));
    setBulkTagIds([]);
    clearSelection();
    toast.success('Tags applied');
  };
  // Archive every selected customer not archived already (CS-663; the reducer ends each one's
  // upcoming cleans and tells the crew, as the customer page's Archive does).
  const bulkArchive = () => {
    if (!canBulkArchive) return;
    const ids = clients.filter((cl) => selectedIds.has(cl.id) && !isArchivedCustomer(cl)).map((cl) => cl.id);
    ids.forEach((id) => dispatch({ type: ACTIONS.ARCHIVE_CLIENT, id, by: currentUser?.id || null }));
    setConfirmArchiveOpen(false);
    clearSelection();
    toast.success(t('custArchive.bulkDone', { count: ids.length }));
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Customers</h1>
        </div>
        <div className="page-head-actions">
          {qrLinks.show && (
            <button type="button" className="btn btn-secondary" disabled={qrLinks.busy} onClick={qrLinks.download} title={t('qrLinks.buttonHint')}>
              {qrLinks.busy ? t('qrLinks.preparing') : t('qrLinks.button')}
            </button>
          )}
          {canAddCustomers && (
            <>
              <button className="btn btn-gold" onClick={() => setCsvOpen(true)}>Import customers</button>
              <button className="btn btn-primary" onClick={() => setAddOpen(true)}>Add Customer</button>
            </>
          )}
        </div>
      </div>

      <div className="filter-bar">
        <FormField label="Search" value={cSearch} onChange={(e) => setParam('q', e.target.value)} placeholder="Company, contact, email…" />
        <FormField label="Status">
          <FilterSelect ariaLabel="Status" value={cStatus} onChange={(v) => setParam('status', v, '')}
            options={[{ value: '', label: 'All statuses' }, ...STATUSES.map((s) => ({ value: s, label: statusLabel(t, s) }))]} />
        </FormField>
        <FormField label="Tag">
          <FilterSelect ariaLabel="Tag" value={cTag} onChange={(v) => setParam('tag', v, '')}
            options={[{ value: '', label: 'All tags' }, ...allTags.map((t) => ({ value: t.id, label: t.label }))]} />
        </FormField>
      </div>

      {archivedHidden > 0 && (
        <p className="text-sm text-muted mb-14">
          {t('custArchive.hiddenNote', { count: archivedHidden })}{' '}
          <button type="button" className="btn btn-link" onClick={() => setParam('status', 'archived', '')}>{t('custArchive.showArchived')}</button>
        </p>
      )}

      {canBulkSelect && selectedIds.size > 0 && (
        <div className="bulk-bar">
          <span className="text-sm font-semi">{selectedIds.size} selected</span>
          {canBulkTag && (
            <>
              <div style={{ width: 280, flexShrink: 0 }}>
                <TagPicker value={bulkTagIds} onChange={setBulkTagIds} placeholder="Select tag" />
              </div>
              <button className="btn btn-primary" disabled={bulkTagIds.length === 0} onClick={bulkApplyTags}>Apply tags</button>
            </>
          )}
          {canBulkArchive && !showingArchived && (
            <button type="button" className="btn btn-outline" style={{ marginLeft: 'auto' }} onClick={() => setConfirmArchiveOpen(true)}>{t('custArchive.button')}</button>
          )}
          <button className="btn btn-outline" style={canBulkArchive && !showingArchived ? undefined : { marginLeft: 'auto' }} onClick={clearSelection}>Cancel</button>
        </div>
      )}

      {filtered.length === 0 ? (
        clients.length === 0 ? (
          <EmptyState
            icon={<Icon name="clients" size={28} />}
            title="No customers yet"
            message="Add your first customer, or import your buildings from a spreadsheet."
            action={canAddCustomers && <button className="btn btn-primary" onClick={() => setAddOpen(true)}>Add Customer</button>}
          />
        ) : (
          <EmptyState title="No matches" message="Try clearing filters or changing search." />
        )
      ) : !ticketFlags.ready || !supplyBudgets.ready ? (
        // CS-962, CS-963: opened before the app's first read of the ticket counts or the supply
        // spend has answered, the rows wait for it (live, 2026-11-02: the counts 0.74 to 0.93
        // seconds, the spend 0.97 to 1.85), so they draw once, with their flags in place.
        null
      ) : (
        <>
          <div className="table-wrap mobile-stack">
            <table>
              <thead>
                <tr>
                  {canBulkSelect && (
                    <th style={{ width: 36 }}>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={selectedIds.size > 0 && selectedIds.size === selectableKeys.length}
                        onChange={toggleSelectAll}
                      />
                    </th>
                  )}
                  <th>Company</th>
                  <th>Primary contact</th>
                  <th>Status</th>
                  <th>Location</th>
                  <th>Tags</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pager.pageRows.map((cl) => {
                  const primary = cl.primaryContactId ? selectContactById(state, cl.primaryContactId) : null;
                  const primaryName = primary ? `${primary.firstName} ${primary.lastName}` : (cl.primaryContact || '—');
                  const contactCount = (state.contacts || []).filter((c) => c.companyId === cl.id).length;
                  const st = selectClientBadgeStatus(state, cl);
                  return (
                    <tr key={cl.id} className="clickable" onClick={() => navigate(`/clients/${cl.id}`, { state: nav })}>
                      {canBulkSelect && (
                        <td onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${cl.name}`}
                            checked={selectedIds.has(cl.id)}
                            onChange={() => toggleSelected(cl.id)}
                          />
                        </td>
                      )}
                      <td className="cell-primary">
                        <div className="flex-row" style={{ gap: 8 }}>
                          <Avatar initials={companyInitials(cl.name)} variant={(cl.id.length % 5) + 1} size="sm" />
                          <div>
                            {/* GO-2: the office names a customer "0001 Ball Harbor Village". */}
                            <div className="name truncate" title={customerLabel(cl)}>{customerLabel(cl)}</div>
                            <div className="text-xs text-muted truncate">{contactCount} contact{contactCount === 1 ? '' : 's'}</div>
                          </div>
                        </div>
                      </td>
                      <td data-label="Primary contact">
                        <span className={primary ? 'truncate' : 'text-muted truncate'} style={{ maxWidth: '100%', display: 'block' }} title={primaryName}>{primaryName}</span>
                      </td>
                      <td data-label="Status">
                        {/* CS-965: the status and its flags stand one per line, each in its own
                            block, as wide as its words (the kit's .cell-chip-stack). Side by side in a
                            phone's card they were flex items that shrank below their words. */}
                        <div className="cell-chip-stack">
                          <div><Badge variant={DERIVED_STATUS_VARIANTS[st]}>{statusLabel(t, st)}</Badge></div>
                          {/* WO-14: an account past the ticket threshold is flagged here, under
                              its status — no new column. */}
                          {ticketFlags.isFlagged(cl.id) && (
                            <div><Badge variant="red" title={ticketFlags.labelFor(cl.id)}>{ticketFlags.labelFor(cl.id)}</Badge></div>
                          )}
                          {/* SUP-7 (b): "the account is flagged as over budget for supplies" — under
                              its status like the ticket flag. */}
                          {canViewSupplies && supplyBudgets.isOver(cl.id) && (
                            <div><Badge variant="red" title={`Over this building's monthly supply budget: ${supplyBudgets.labelFor(cl.id)}.`}>Over supply budget</Badge></div>
                          )}
                        </div>
                      </td>
                      <td className="text-muted truncate" data-label="Location" title={cl.city || ''}>{cl.city || '—'}</td>
                      <td data-label="Tags">
                        <div className="flex-row" style={{ gap: 4 }}>
                          {(cl.tagIds || []).slice(0, 3).map((tid) => {
                            const t = selectTagById(state, tid);
                            return t ? <TagChip key={tid} tag={t} size="xs" /> : null;
                          })}
                          {(cl.tagIds || []).length > 3 && <span className="text-xs text-muted">+{(cl.tagIds || []).length - 3}</span>}
                        </div>
                      </td>
                      <td className="text-xs text-muted" data-label="Updated">{timeShort(english, cl.createdAt)}</td>
                      <td className="text-right cell-chevron"><Icon name="chevronRight" size={14} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun="customers" />
        </>
      )}

      {/* A new customer opens on its own page, where its onboarding bar walks the office through
          the rest (task 471). */}
      <AddCompanyModal open={addOpen} onClose={() => setAddOpen(false)} onCreated={(id) => navigate(`/clients/${id}`, { state: nav })} />
      <CsvImportModal open={csvOpen} onClose={() => setCsvOpen(false)} />
      <ConfirmDialog
        open={confirmArchiveOpen}
        title={t('custArchive.bulkTitle', { count: selectedIds.size })}
        message={t('custArchive.bulkMessage')}
        confirmLabel={t('custArchive.button')}
        onConfirm={bulkArchive}
        onClose={() => setConfirmArchiveOpen(false)}
      />
    </>
  );
}
