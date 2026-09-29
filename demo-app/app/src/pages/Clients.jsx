import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Badge, { DERIVED_STATUS_VARIANTS } from '../components/Badge';
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
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { usePermission, useCanEditJobs } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import {
  selectContactById, selectTags, selectTagById, selectVisibleClientsFor, selectClientBadgeStatus,
} from '../store/selectors';
import { fmtRelative } from '../lib/dates';
import { usePagedRows } from '../hooks/usePagedRows';
import ListPager from '../components/ListPager';

// Derived status (Jobber-style): Lead (no work yet) vs Active (has a job/invoice).
// Color map is shared from Badge (DERIVED_STATUS_VARIANTS) so the hub can't drift from the detail views.
const STATUSES = ['lead', 'active', 'inactive', 'vendor'];
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const companyInitials = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

// Customer-first hub (Jobber-style, Client-primary). The list IS your customers:
// each row is a business/account you clean for. People are contacts UNDER a
// customer, reached by opening it (its contacts, sites, jobs, invoices). There are
// no floating people and no "typed company that isn't a record": every person
// belongs to exactly one customer.
export default function Clients() {
  const state = useStore();
  const navigate = useNavigate();
  const nav = useFromHere();
  const dispatch = useDispatch();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canEditClients = usePermission('clients.edit');
  const canEditContacts = usePermission('contacts.edit');
  const canCreate = canEditClients || canEditContacts;
  // Bulk actions are gated exactly like their single-record twins on ClientDetail:
  // Apply tags ← clients.edit (the key the customer TagPicker edits under), Delete ←
  // clients.delete. Delete additionally requires useCanEditJobs (owner/admin, or a
  // manager holding schedule.edit): a customer delete cascades to its jobs, and the
  // server's jobsGuard puts that job half BACK for anyone without schedule.edit,
  // orphaning the cleans (they keep feeding the ops-alerts cron). So a delete the
  // caller can't fully complete is not offered (owner's call, 2026-09-23). The
  // selection UI (checkboxes + bulk bar) appears only when at least one bulk action
  // is available — /clients is reachable by URL for anyone with clients.view or
  // contacts.view (crew hold both by default), and the nav hiding it is not a gate.
  const canDeleteClients = usePermission('clients.delete');
  const canEditJobs = useCanEditJobs();
  const canBulkTag = canEditClients;
  const canBulkDelete = canDeleteClients && canEditJobs;
  const canBulkSelect = canBulkTag || canBulkDelete;

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
    if (searchParams.get('new') && canCreate) {
      setAddOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, canCreate, setSearchParams]);
  const [csvOpen, setCsvOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = cSearch.trim().toLowerCase();
    return clients.filter((cl) => {
      if (cStatus && selectClientBadgeStatus(state, cl) !== cStatus) return false;
      if (cTag && !(cl.tagIds || []).includes(cTag)) return false;
      if (q) {
        const hay = [cl.name, cl.primaryContact, cl.email, cl.phone, cl.contactNumber && `#${cl.contactNumber}`].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [clients, cSearch, cStatus, cTag, state]);

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
  const bulkDelete = () => {
    if (!canBulkDelete) return;
    const n = selectedIds.size;
    selectedIds.forEach((id) => dispatch({ type: ACTIONS.DELETE_CLIENT, id }));
    setConfirmDeleteOpen(false);
    clearSelection();
    toast.success(`${n} customer${n === 1 ? '' : 's'} deleted`);
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Customers</h1>
        </div>
        <div className="page-head-actions">
          {canCreate && (
            <>
              <button className="btn btn-gold" onClick={() => setCsvOpen(true)}>Import CSV</button>
              <button className="btn btn-primary" onClick={() => setAddOpen(true)}>Add Customer</button>
            </>
          )}
        </div>
      </div>

      <div className="filter-bar">
        <FormField label="Search" value={cSearch} onChange={(e) => setParam('q', e.target.value)} placeholder="Company, contact, email…" />
        <FormField label="Status">
          <FilterSelect ariaLabel="Status" value={cStatus} onChange={(v) => setParam('status', v, '')}
            options={[{ value: '', label: 'All statuses' }, ...STATUSES.map((s) => ({ value: s, label: cap(s) }))]} />
        </FormField>
        <FormField label="Tag">
          <FilterSelect ariaLabel="Tag" value={cTag} onChange={(v) => setParam('tag', v, '')}
            options={[{ value: '', label: 'All tags' }, ...allTags.map((t) => ({ value: t.id, label: t.label }))]} />
        </FormField>
      </div>

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
          {canBulkDelete && (
            <button className="btn btn-danger" style={{ marginLeft: 'auto' }} onClick={() => setConfirmDeleteOpen(true)}>Delete</button>
          )}
          <button className="btn btn-outline" style={canBulkDelete ? undefined : { marginLeft: 'auto' }} onClick={clearSelection}>Cancel</button>
        </div>
      )}

      {filtered.length === 0 ? (
        clients.length === 0 ? (
          <EmptyState
            icon={<Icon name="clients" size={28} />}
            title="No customers yet"
            message="Add your first customer, or Import CSV to bring in your whole book."
            action={canCreate && <button className="btn btn-primary" onClick={() => setAddOpen(true)}>Add Customer</button>}
          />
        ) : (
          <EmptyState title="No matches" message="Try clearing filters or changing search." />
        )
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
                            <div className="name truncate" title={cl.name}>{cl.name}</div>
                            <div className="text-xs text-muted truncate">{cl.contactNumber ? `#${cl.contactNumber} · ` : ''}{contactCount} contact{contactCount === 1 ? '' : 's'}</div>
                          </div>
                        </div>
                      </td>
                      <td data-label="Primary contact">
                        <span className={primary ? 'truncate' : 'text-muted truncate'} style={{ maxWidth: '100%', display: 'block' }} title={primaryName}>{primaryName}</span>
                      </td>
                      <td data-label="Status"><Badge variant={DERIVED_STATUS_VARIANTS[st]}>{cap(st)}</Badge></td>
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
                      <td className="text-xs text-muted" data-label="Updated">{fmtRelative(cl.createdAt)}</td>
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

      <AddCompanyModal open={addOpen} onClose={() => setAddOpen(false)} />
      <CsvImportModal open={csvOpen} onClose={() => setCsvOpen(false)} />
      <ConfirmDialog
        open={confirmDeleteOpen}
        title={`Delete ${selectedIds.size} customer${selectedIds.size === 1 ? '' : 's'}?`}
        message="Deleting a customer permanently removes ALL of its people, sites, jobs, invoices, and activities. This cannot be undone. Conversations are unlinked but preserved."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={bulkDelete}
        onClose={() => setConfirmDeleteOpen(false)}
      />
    </>
  );
}
