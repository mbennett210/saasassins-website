import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Badge from '../components/Badge';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import FormField from '../components/FormField';
import Avatar from '../components/Avatar';
import TagChip from '../components/TagChip';
import TagPicker from '../components/TagPicker';
import FilterSelect from '../components/FilterSelect';
import AddContactModal from '../components/AddContactModal';
import CsvImportModal from '../components/CsvImportModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import {
  selectClientById, selectContactById, selectTags, selectTagById,
  selectVisibleContactsFor, selectVisibleClientsFor,
} from '../store/selectors';
import { fmtRelative } from '../lib/dates';

const LIFECYCLE_VARIANTS = {
  lead: 'amber',
  prospect: 'blue',
  client: 'green',
  vendor: 'slate',
};

const CLIENT_STATUS_VARIANTS = { active: 'green', prospect: 'amber', inactive: 'slate' };

// Two-letter initials for a company avatar.
const companyInitials = (name) =>
  (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');

const LIFECYCLES = ['all', 'lead', 'prospect', 'client', 'vendor'];

// Tags are company-level: a person inherits their company's tags; a company-less
// contact carries its own. Inlined here (a pure read) so the unified hub needs no
// edit to the shared store/selectors.js.
function effectiveTagIds(state, contact) {
  if (!contact) return [];
  if (contact.companyId) return selectClientById(state, contact.companyId)?.tagIds || [];
  return contact.tagIds || [];
}

// One unified Contacts list (GHL-style). People are the list; the company they
// belong to is an attribute — filter by it, and click a company name to open its
// record (sites, jobs, invoices). There is no separate companies browse tab.
export default function Clients() {
  const state = useStore();
  const navigate = useNavigate();
  const nav = useFromHere();
  const dispatch = useDispatch();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canCreateContact = usePermission('contacts.edit');

  const clients = useMemo(
    () => selectVisibleClientsFor(state, currentUser),
    [state, currentUser]
  );
  const visibleContacts = useMemo(
    () => selectVisibleContactsFor(state, currentUser),
    [state, currentUser]
  );
  const allTags = selectTags(state);

  const [searchParams, setSearchParams] = useSearchParams();
  const setParam = (key, value, defaultValue) => {
    const next = new URLSearchParams(searchParams);
    if (value === '' || value == null || value === defaultValue) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  // Filters (URL-backed, so Back restores the exact filtered view).
  const cSearch = searchParams.get('q') || '';
  const cLifecycle = searchParams.get('lifecycle') || '';
  const cTag = searchParams.get('tag') || '';
  const cCompany = searchParams.get('company') || '';
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkTagIds, setBulkTagIds] = useState([]);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [csvImportOpen, setCsvImportOpen] = useState(false);
  const [confirmContactDeleteOpen, setConfirmContactDeleteOpen] = useState(false);

  const filteredContacts = useMemo(() => {
    const q = cSearch.trim().toLowerCase();
    return visibleContacts.filter((c) => {
      if (cLifecycle && c.lifecycle !== cLifecycle) return false;
      if (cTag && !effectiveTagIds(state, c).includes(cTag)) return false;
      if (cCompany) {
        if (cCompany === 'unattached' && c.companyId) return false;
        if (cCompany !== 'unattached' && c.companyId !== cCompany) return false;
      }
      if (q) {
        const hay = [c.firstName, c.lastName, c.email, c.title, c.phone].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [visibleContacts, cSearch, cLifecycle, cTag, cCompany, state]);

  // A company with no contact person of its own would otherwise vanish from this
  // people-first list (it survives only as a filter + in pickers). Surface those
  // account-only companies as their own rows so nothing is hidden. Skipped when a
  // person-only filter (lifecycle / unattached) is active; the tag filter DOES
  // apply to a company (tags are company-level), so it's honored below.
  const contactlessCompanies = useMemo(() => {
    if (cLifecycle || cCompany === 'unattached') return [];
    const withPeople = new Set((visibleContacts || []).map((c) => c.companyId).filter(Boolean));
    const q = cSearch.trim().toLowerCase();
    return (clients || []).filter((cl) => {
      if (withPeople.has(cl.id)) return false;          // represented by its people
      if (cCompany && cCompany !== cl.id) return false; // filtered to a different company
      if (cTag && !(cl.tagIds || []).includes(cTag)) return false; // honor the tag filter on company tags
      if (q && !(cl.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [clients, visibleContacts, cLifecycle, cTag, cCompany, cSearch]);

  // One unified stream: people rows first, then account-only company rows.
  const rows = useMemo(() => ([
    ...filteredContacts.map((c) => ({ kind: 'contact', key: c.id, data: c })),
    ...contactlessCompanies.map((cl) => ({ kind: 'company', key: `cl:${cl.id}`, data: cl })),
  ]), [filteredContacts, contactlessCompanies]);

  // Every selectable row's key — contacts by id, companies as `cl:<id>` — so
  // select-all and bulk actions span both kinds across all pages.
  const selectableKeys = useMemo(() => rows.map((r) => r.key), [rows]);

  // Pagination (URL-backed) — keeps large lists fast and navigable.
  const CONTACTS_PER_PAGE = 25;
  const cTotalPages = Math.max(1, Math.ceil(rows.length / CONTACTS_PER_PAGE));
  const cPage = Math.min(Math.max(1, parseInt(searchParams.get('cpage') || '1', 10) || 1), cTotalPages);
  const pagedRows = rows.slice((cPage - 1) * CONTACTS_PER_PAGE, cPage * CONTACTS_PER_PAGE);

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (selectedIds.size === selectableKeys.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(selectableKeys));
  };
  const clearSelection = () => setSelectedIds(new Set());

  // Tags are company-level: a selected company — or a person who belongs to one —
  // tags the COMPANY; a company-less contact tags itself. Companies are de-duped
  // so selecting several coworkers tags their shared company once. The demo has no
  // TAG_CLIENT action, so company tags go through an UPDATE_CLIENT read-modify-write.
  const bulkApplyTags = () => {
    if (bulkTagIds.length === 0) return;
    const clientIds = new Set();
    const contactIds = new Set();
    selectedIds.forEach((key) => {
      if (key.startsWith('cl:')) { clientIds.add(key.slice(3)); return; }
      const c = selectContactById(state, key);
      if (!c) return;
      if (c.companyId) clientIds.add(c.companyId);
      else contactIds.add(c.id);
    });
    clientIds.forEach((id) => {
      const cl = selectClientById(state, id);
      const merged = [...new Set([...(cl?.tagIds || []), ...bulkTagIds])];
      dispatch({ type: ACTIONS.UPDATE_CLIENT, id, patch: { tagIds: merged } });
    });
    contactIds.forEach((id) => bulkTagIds.forEach((tagId) => dispatch({ type: ACTIONS.TAG_CONTACT, id, tagId })));
    setBulkTagIds([]);
    clearSelection();
    toast.success('Tags applied');
  };
  const bulkDelete = () => {
    const companyKeys = [...selectedIds].filter((k) => k.startsWith('cl:'));
    const contactKeys = [...selectedIds].filter((k) => !k.startsWith('cl:'));
    // Companies first: DELETE_CLIENT cascades and takes its contacts with it, so a
    // separately-selected contact under that company just becomes a harmless no-op.
    companyKeys.forEach((k) => dispatch({ type: ACTIONS.DELETE_CLIENT, id: k.slice(3) }));
    contactKeys.forEach((k) => dispatch({ type: ACTIONS.DELETE_CONTACT, id: k }));
    setConfirmContactDeleteOpen(false);
    clearSelection();
    const parts = [];
    if (companyKeys.length) parts.push(`${companyKeys.length} compan${companyKeys.length === 1 ? 'y' : 'ies'}`);
    if (contactKeys.length) parts.push(`${contactKeys.length} contact${contactKeys.length === 1 ? '' : 's'}`);
    toast.success(`${parts.join(' · ')} deleted`);
  };

  const openContact = (id) => navigate(`/clients/contact/${id}`, { state: nav });

  // Bulk-delete confirm copy — companies carry a cascade warning, since
  // DELETE_CLIENT also removes their contacts, sites, jobs, invoices + activities.
  const selectedCompanyCount = [...selectedIds].filter((k) => k.startsWith('cl:')).length;
  const selectedContactCount = selectedIds.size - selectedCompanyCount;
  const deleteParts = [];
  if (selectedCompanyCount) deleteParts.push(`${selectedCompanyCount} compan${selectedCompanyCount === 1 ? 'y' : 'ies'}`);
  if (selectedContactCount) deleteParts.push(`${selectedContactCount} contact${selectedContactCount === 1 ? '' : 's'}`);
  const deleteTitle = `Delete ${deleteParts.join(' + ') || 'selection'}?`;
  const deleteMessage = selectedCompanyCount > 0
    ? 'Deleting a company also permanently removes ALL of its contacts, sites, jobs, invoices, and activities — this cannot be undone. Conversations are unlinked but preserved.'
    : 'The selected contacts will be permanently removed. Their conversations will be unlinked but preserved.';

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-head-title">Contacts</h1>
          <p className="page-head-subtitle">
            Everyone you work with, in one list. Filter by company, lifecycle, or tag — and open a company to see its sites, jobs, and invoices.
          </p>
        </div>
        <div className="page-head-actions">
          {canCreateContact && (
            <>
              <button className="btn btn-success" onClick={() => setCsvImportOpen(true)}>Import CSV</button>
              <button className="btn btn-primary" onClick={() => setAddContactOpen(true)}>Add Contact</button>
            </>
          )}
        </div>
      </div>

      <div className="filter-bar">
        <FormField label="Search" value={cSearch} onChange={(e) => setParam('q', e.target.value)} placeholder="Name, email, title…" />
        <FormField label="Status">
          <FilterSelect ariaLabel="Status" value={cLifecycle} onChange={(v) => setParam('lifecycle', v, '')}
            options={[{ value: '', label: 'All lifecycles' }, ...LIFECYCLES.filter((v) => v !== 'all').map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))]} />
        </FormField>
        <FormField label="Tag">
          <FilterSelect ariaLabel="Tag" value={cTag} onChange={(v) => setParam('tag', v, '')}
            options={[{ value: '', label: 'All tags' }, ...allTags.map((t) => ({ value: t.id, label: t.label }))]} />
        </FormField>
        <FormField label="Company">
          <FilterSelect ariaLabel="Company" value={cCompany} onChange={(v) => setParam('company', v, '')}
            options={[{ value: '', label: 'All companies' }, { value: 'unattached', label: 'Unattached' }, ...clients.filter((c) => c.status !== 'inactive').map((c) => ({ value: c.id, label: c.name }))]} />
        </FormField>
      </div>

      <div className={`bulk-bar ${selectedIds.size === 0 ? 'is-empty' : ''}`}>
        <span className="text-sm font-semi">
          {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select contacts or companies for bulk actions'}
        </span>
        {selectedIds.size > 0 && (
          <>
            <div style={{ width: 280, flexShrink: 0 }}>
              <TagPicker value={bulkTagIds} onChange={setBulkTagIds} placeholder="Select tag" />
            </div>
            <button className="btn btn-primary btn-sm" disabled={bulkTagIds.length === 0} onClick={bulkApplyTags}>Apply tags</button>
            <button className="btn btn-danger btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setConfirmContactDeleteOpen(true)}>Delete</button>
            <button className="btn btn-outline btn-sm" onClick={clearSelection}>Cancel</button>
          </>
        )}
      </div>

      {rows.length === 0 ? (
        visibleContacts.length === 0 && (clients || []).length === 0 ? (
          <EmptyState
            icon={<Icon name="clients" size={28} />}
            title="No contacts yet"
            message="Add your first contact, or Import CSV to bring in your whole list."
            action={canCreateContact && <button className="btn btn-primary" onClick={() => setAddContactOpen(true)}>Add Contact</button>}
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
                  <th style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      aria-label="Select all"
                      checked={selectedIds.size > 0 && selectedIds.size === selectableKeys.length}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Status</th>
                  <th>Tags</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {pagedRows.map((row) => {
                    if (row.kind === 'company') {
                      const cl = row.data;
                      return (
                        <tr key={row.key} className="clickable" onClick={() => navigate(`/clients/${cl.id}`, { state: nav })}>
                          <td className="cell-chevron" onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              aria-label={`Select ${cl.name}`}
                              checked={selectedIds.has(row.key)}
                              onChange={() => toggleSelected(row.key)}
                            />
                          </td>
                          <td className="cell-primary">
                            <div className="flex-row" style={{ gap: 8 }}>
                              <Avatar initials={companyInitials(cl.name)} variant={(cl.id.length % 5) + 1} size="sm" />
                              <div>
                                <div className="name truncate" title={cl.name}>{cl.name}</div>
                                <div className="text-xs text-muted">Company · no contacts yet</div>
                              </div>
                            </div>
                          </td>
                          <td data-label="Company"><span className="text-muted">—</span></td>
                          <td data-label="Status"><Badge variant={CLIENT_STATUS_VARIANTS[cl.status] || 'slate'}>{cap(cl.status)}</Badge></td>
                          <td data-label="Tags">
                            <div className="flex-row" style={{ gap: 4 }}>
                              {(cl.tagIds || []).slice(0, 3).map((tid) => {
                                const t = selectTagById(state, tid);
                                return t ? <TagChip key={tid} tag={t} size="xs" /> : null;
                              })}
                              {(cl.tagIds || []).length > 3 && <span className="text-xs text-muted">+{(cl.tagIds || []).length - 3}</span>}
                            </div>
                          </td>
                          <td data-label="Updated" className="text-xs text-muted">{fmtRelative(cl.createdAt)}</td>
                          <td className="cell-chevron text-right"><Icon name="chevronRight" size={14} /></td>
                        </tr>
                      );
                    }
                    const c = row.data;
                    const company = c.companyId ? selectClientById(state, c.companyId) : null;
                    const companyLabel = company?.name || c.customFields?.company || '—';
                    const effTagIds = effectiveTagIds(state, c);
                    return (
                      <tr key={c.id} className="clickable">
                        <td className="cell-chevron" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`Select ${c.firstName} ${c.lastName}`}
                            checked={selectedIds.has(c.id)}
                            onChange={() => toggleSelected(c.id)}
                          />
                        </td>
                        <td className="cell-primary" onClick={() => openContact(c.id)}>
                          <div className="flex-row" style={{ gap: 8 }}>
                            <Avatar initials={`${(c.firstName[0] || '').toUpperCase()}${(c.lastName[0] || '').toUpperCase()}`} variant={(c.id.length % 5) + 1} size="sm" />
                            <div>
                              <div className="name truncate" title={`${c.firstName} ${c.lastName}`}>{c.firstName} {c.lastName}</div>
                              <div className="text-xs text-muted truncate" title={c.email}>{c.email}</div>
                            </div>
                          </div>
                        </td>
                        <td data-label="Company" onClick={() => openContact(c.id)}>
                          {company ? (
                            <button
                              type="button"
                              className="link truncate"
                              title={`Open ${companyLabel}`}
                              style={{ background: 'none', border: 0, padding: 0, font: 'inherit', cursor: 'pointer', textAlign: 'left', display: 'block', maxWidth: '100%' }}
                              onClick={(e) => { e.stopPropagation(); navigate(`/clients/${company.id}`, { state: nav }); }}
                            >
                              {companyLabel}
                            </button>
                          ) : (
                            <div className="truncate" title={companyLabel}>{companyLabel}</div>
                          )}
                          <div className="text-xs text-muted truncate" title={c.title || ''}>{c.title || '—'}</div>
                        </td>
                        <td data-label="Status" onClick={() => openContact(c.id)}>
                          <Badge variant={LIFECYCLE_VARIANTS[c.lifecycle] || 'slate'}>
                            {c.lifecycle.charAt(0).toUpperCase() + c.lifecycle.slice(1)}
                          </Badge>
                        </td>
                        <td data-label="Tags" onClick={() => openContact(c.id)}>
                          <div className="flex-row" style={{ gap: 4 }}>
                            {effTagIds.slice(0, 3).map((tid) => {
                              const t = selectTagById(state, tid);
                              return t ? <TagChip key={tid} tag={t} size="xs" /> : null;
                            })}
                            {effTagIds.length > 3 && <span className="text-xs text-muted">+{effTagIds.length - 3}</span>}
                          </div>
                        </td>
                        <td data-label="Updated" onClick={() => openContact(c.id)} className="text-xs text-muted">{fmtRelative(c.updatedAt)}</td>
                        <td className="cell-chevron text-right" onClick={() => openContact(c.id)}><Icon name="chevronRight" size={14} /></td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          <div className="mobile-card-list">
            {pagedRows.map((row) => {
              if (row.kind === 'company') {
                const cl = row.data;
                return (
                  <div key={row.key} className="mobile-card" onClick={() => navigate(`/clients/${cl.id}`, { state: nav })}>
                    <input
                      type="checkbox"
                      className="mc-check"
                      aria-label={`Select ${cl.name}`}
                      checked={selectedIds.has(row.key)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleSelected(row.key)}
                    />
                    <div className="mc-avatar"><Avatar initials={companyInitials(cl.name)} variant={(cl.id.length % 5) + 1} size="sm" /></div>
                    <div className="mc-name">{cl.name}</div>
                    <div className="mc-chev"><Icon name="chevronRight" size={14} /></div>
                    <div className="mc-sub">Company · no contacts yet</div>
                    <div className="mc-meta">
                      <Badge variant={CLIENT_STATUS_VARIANTS[cl.status] || 'slate'}>{cap(cl.status)}</Badge>
                      {(cl.tagIds || []).slice(0, 2).map((tid) => {
                        const t = selectTagById(state, tid);
                        return t ? <TagChip key={tid} tag={t} size="xs" /> : null;
                      })}
                      <span className="mc-ago">{fmtRelative(cl.createdAt)}</span>
                    </div>
                  </div>
                );
              }
              const c = row.data;
              const company = c.companyId ? selectClientById(state, c.companyId) : null;
              const companyLabel = company?.name || c.customFields?.company || null;
              const effTagIds = effectiveTagIds(state, c);
              const tagIds = effTagIds.slice(0, 2);
              const extraTagCount = effTagIds.length - tagIds.length;
              return (
                <div
                  key={c.id}
                  className="mobile-card"
                  onClick={() => openContact(c.id)}
                >
                  <input
                    type="checkbox"
                    className="mc-check"
                    aria-label={`Select ${c.firstName} ${c.lastName}`}
                    checked={selectedIds.has(c.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleSelected(c.id)}
                  />
                  <div className="mc-avatar">
                    <Avatar
                      initials={`${(c.firstName[0] || '').toUpperCase()}${(c.lastName[0] || '').toUpperCase()}`}
                      variant={(c.id.length % 5) + 1}
                      size="sm"
                    />
                  </div>
                  <div className="mc-name">{c.firstName} {c.lastName}</div>
                  <div className="mc-chev"><Icon name="chevronRight" size={14} /></div>
                  <div className="mc-sub">
                    {companyLabel ? `${c.email} · ${companyLabel}` : c.email}
                  </div>
                  <div className="mc-meta">
                    <Badge variant={LIFECYCLE_VARIANTS[c.lifecycle] || 'slate'}>
                      {c.lifecycle.charAt(0).toUpperCase() + c.lifecycle.slice(1)}
                    </Badge>
                    {tagIds.map((tid) => {
                      const t = selectTagById(state, tid);
                      return t ? <TagChip key={tid} tag={t} size="xs" /> : null;
                    })}
                    {extraTagCount > 0 && (
                      <span className="text-xs text-muted">+{extraTagCount}</span>
                    )}
                    <span className="mc-ago">{fmtRelative(c.updatedAt)}</span>
                  </div>
                </div>
              );
            })}
          </div>
          {cTotalPages > 1 && (
            <div className="list-pager">
              <span className="list-pager-info">
                Showing {(cPage - 1) * CONTACTS_PER_PAGE + 1}–{Math.min(cPage * CONTACTS_PER_PAGE, rows.length)} of {rows.length}
              </span>
              <div className="list-pager-controls">
                <button type="button" className="list-pager-btn" disabled={cPage <= 1} onClick={() => setParam('cpage', String(cPage - 1), '1')}>Previous</button>
                <span className="list-pager-page">Page {cPage} of {cTotalPages}</span>
                <button type="button" className="list-pager-btn" disabled={cPage >= cTotalPages} onClick={() => setParam('cpage', String(cPage + 1), '1')}>Next</button>
              </div>
            </div>
          )}
        </>
      )}

      <AddContactModal open={addContactOpen} onClose={() => setAddContactOpen(false)} />
      <CsvImportModal open={csvImportOpen} onClose={() => setCsvImportOpen(false)} />

      <ConfirmDialog
        open={confirmContactDeleteOpen}
        title={deleteTitle}
        message={deleteMessage}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={bulkDelete}
        onClose={() => setConfirmContactDeleteOpen(false)}
      />
    </>
  );
}
