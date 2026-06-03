import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFromHere } from '../hooks/useFromHere';
import Badge, { statusBadgeVariant } from '../components/Badge';
import EmptyState from '../components/EmptyState';
import Icon from '../components/Icon';
import FormField from '../components/FormField';
import Avatar from '../components/Avatar';
import TagChip from '../components/TagChip';
import TagPicker from '../components/TagPicker';
import AddClientModal from '../components/AddClientModal';
import AddContactModal from '../components/AddContactModal';
import CsvImportModal from '../components/CsvImportModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useToast } from '../components/Toast';
import {
  selectClientById, selectServiceById, selectFrequencies, selectServices,
  selectContacts, selectTags, selectTagById,
  selectVisibleContactsFor, selectVisibleClientsFor,
} from '../store/selectors';
import { fmtDate, fmtRelative, money } from '../lib/dates';

const LIFECYCLE_VARIANTS = {
  lead: 'amber',
  prospect: 'blue',
  client: 'green',
  vendor: 'slate',
};

const LIFECYCLES = ['all', 'lead', 'prospect', 'client', 'vendor'];

export default function Clients() {
  const state = useStore();
  const navigate = useNavigate();
  const nav = useFromHere();
  const dispatch = useDispatch();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canCreateClient = usePermission('clients.edit');
  const canCreateContact = usePermission('contacts.edit');
  const canViewContacts = usePermission('contacts.view');


  const services = selectServices(state);
  const frequencies = selectFrequencies(state);
  const allContacts = selectContacts(state);
  const allTags = selectTags(state);

  const visibleContacts = useMemo(
    () => selectVisibleContactsFor(state, currentUser),
    [state, currentUser]
  );
  const clients = useMemo(
    () => selectVisibleClientsFor(state, currentUser),
    [state, currentUser]
  );

  const [searchParams, setSearchParams] = useSearchParams();
  const setParam = (key, value, defaultValue) => {
    const next = new URLSearchParams(searchParams);
    if (value === '' || value == null || value === defaultValue) next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: true });
  };

  const defaultTab = canViewContacts ? 'contacts' : 'clients';
  // Accept legacy ?tab=accounts deep-links by normalizing to 'clients'.
  const rawTab = searchParams.get('tab');
  const tab = rawTab === 'accounts' ? 'clients' : (rawTab || defaultTab);
  const setTab = (v) => setParam('tab', v, defaultTab);

  // Contacts filters (URL-backed)
  const cSearch = searchParams.get('q') || '';
  const cLifecycle = searchParams.get('lifecycle') || 'all';
  const cTag = searchParams.get('tag') || 'all';
  const cCompany = searchParams.get('company') || 'all';
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkTagIds, setBulkTagIds] = useState([]);
  const [addContactOpen, setAddContactOpen] = useState(false);
  const [csvImportOpen, setCsvImportOpen] = useState(false);
  const [confirmContactDeleteOpen, setConfirmContactDeleteOpen] = useState(false);
  const [confirmClientDeleteOpen, setConfirmClientDeleteOpen] = useState(false);

  // Clients filters (URL-backed, prefixed to avoid collision)
  const aSearch = searchParams.get('aq') || '';
  const aStatus = searchParams.get('astatus') || 'active';
  const aService = searchParams.get('aservice') || 'all';
  const aFreq = searchParams.get('afreq') || 'all';
  const [addClientOpen, setAddClientOpen] = useState(false);
  const [selectedClientIds, setSelectedClientIds] = useState(() => new Set());

  const filteredContacts = useMemo(() => {
    const q = cSearch.trim().toLowerCase();
    return visibleContacts.filter((c) => {
      if (cLifecycle !== 'all' && c.lifecycle !== cLifecycle) return false;
      if (cTag !== 'all' && !(c.tagIds || []).includes(cTag)) return false;
      if (cCompany !== 'all') {
        if (cCompany === 'unattached' && c.companyId) return false;
        if (cCompany !== 'unattached' && c.companyId !== cCompany) return false;
      }
      if (q) {
        const hay = [c.firstName, c.lastName, c.email, c.title, c.phone].filter(Boolean).join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [visibleContacts, cSearch, cLifecycle, cTag, cCompany]);

  const filteredClients = useMemo(() => {
    const q = aSearch.trim().toLowerCase();
    return clients.filter((c) => {
      if (aStatus !== 'all' && c.status !== aStatus) return false;
      if (aService !== 'all' && c.serviceId !== aService) return false;
      if (aFreq !== 'all' && c.frequencyId !== aFreq) return false;
      if (q && !(c.name?.toLowerCase().includes(q) || c.primaryContact?.toLowerCase().includes(q) || c.email?.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [clients, aSearch, aStatus, aService, aFreq]);

  const toggleSelected = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () => {
    if (selectedIds.size === filteredContacts.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(filteredContacts.map((c) => c.id)));
  };
  const clearSelection = () => setSelectedIds(new Set());

  const bulkApplyTags = () => {
    if (bulkTagIds.length === 0) return;
    selectedIds.forEach((id) => {
      bulkTagIds.forEach((tagId) => dispatch({ type: ACTIONS.TAG_CONTACT, id, tagId }));
    });
    setBulkTagIds([]);
    clearSelection();
    toast.success('Tags applied');
  };
  const bulkDelete = () => {
    selectedIds.forEach((id) => dispatch({ type: ACTIONS.DELETE_CONTACT, id }));
    setConfirmContactDeleteOpen(false);
    clearSelection();
    toast.success(`${selectedIds.size} contact${selectedIds.size === 1 ? '' : 's'} deleted`);
  };

  // Client selection — mirrors the Contacts pattern.
  const toggleClientSelected = (id) => {
    setSelectedClientIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAllClients = () => {
    if (selectedClientIds.size === filteredClients.length) setSelectedClientIds(new Set());
    else setSelectedClientIds(new Set(filteredClients.map((c) => c.id)));
  };
  const clearClientSelection = () => setSelectedClientIds(new Set());
  const bulkDeleteClients = () => {
    selectedClientIds.forEach((id) => dispatch({ type: ACTIONS.DELETE_CLIENT, id }));
    setConfirmClientDeleteOpen(false);
    clearClientSelection();
    toast.success(`${selectedClientIds.size} client${selectedClientIds.size === 1 ? '' : 's'} deleted`);
  };

  return (
    <>
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-head-title">{tab === 'clients' ? 'Clients' : 'Contacts'}</h1>
          <p className="page-head-subtitle">
            {tab === 'clients'
              ? 'Companies and the contacts attached to them. Switch tabs for the Contacts view.'
              : 'People and the companies they belong to. Switch tabs for the Clients view.'}
          </p>
        </div>
        <div className="page-head-actions">
          {tab === 'contacts' && canCreateContact && (
            <>
              <button className="btn btn-success" onClick={() => setCsvImportOpen(true)}>Import CSV</button>
              <button className="btn btn-primary" onClick={() => setAddContactOpen(true)}>Add Contact</button>
            </>
          )}
          {tab === 'clients' && canCreateClient && (
            <button className="btn btn-primary" onClick={() => setAddClientOpen(true)}>Add Client</button>
          )}
        </div>
      </div>

      <div className="tab-container tab-container-line" style={{ marginBottom: 16 }}>
        {canViewContacts && <button className={`tab-btn ${tab === 'contacts' ? 'active' : ''}`} onClick={() => setTab('contacts')} type="button">Contacts</button>}
        <button className={`tab-btn ${tab === 'clients' ? 'active' : ''}`} onClick={() => setTab('clients')} type="button">Clients</button>
      </div>

      {tab === 'contacts' && (
        <>
          <div className="filter-bar">
            <FormField label="Search" value={cSearch} onChange={(e) => setParam('q', e.target.value)} placeholder="Name, email, title…" />
            <FormField label="Status" as="select" value={cLifecycle} onChange={(e) => setParam('lifecycle', e.target.value, 'all')}
              options={LIFECYCLES.map((v) => ({ value: v, label: v === 'all' ? 'All lifecycles' : v.charAt(0).toUpperCase() + v.slice(1) }))} />
            <FormField label="Tag" as="select" value={cTag} onChange={(e) => setParam('tag', e.target.value, 'all')}
              options={[{ value: 'all', label: 'All tags' }, ...allTags.map((t) => ({ value: t.id, label: t.label }))]} />
            <FormField label="Company" as="select" value={cCompany} onChange={(e) => setParam('company', e.target.value, 'all')}
              options={[{ value: 'all', label: 'All companies' }, { value: 'unattached', label: 'Unattached' }, ...clients.filter((c) => c.status !== 'inactive').map((c) => ({ value: c.id, label: c.name }))]} />
          </div>

          <div className={`bulk-bar ${selectedIds.size === 0 ? 'is-empty' : ''}`}>
            <span className="text-sm font-semi">
              {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select contacts for bulk actions'}
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

          {filteredContacts.length === 0 ? (
            allContacts.length === 0 ? (
              <EmptyState
                icon={<Icon name="clients" size={28} />}
                title="No contacts yet"
                message="Add your first contact to start building your CRM."
                action={canCreateContact && <button className="btn btn-primary" onClick={() => setAddContactOpen(true)}>Add Contact</button>}
              />
            ) : (
              <EmptyState title="No matches" message="Try clearing filters or changing search." />
            )
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          aria-label="Select all"
                          checked={selectedIds.size > 0 && selectedIds.size === filteredContacts.length}
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
                    {filteredContacts.map((c) => {
                        const company = c.companyId ? selectClientById(state, c.companyId) : null;
                        const companyLabel = company?.name || c.customFields?.company || '—';
                        return (
                          <tr key={c.id} className="clickable">
                            <td onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                aria-label={`Select ${c.firstName} ${c.lastName}`}
                                checked={selectedIds.has(c.id)}
                                onChange={() => toggleSelected(c.id)}
                              />
                            </td>
                            <td onClick={() => navigate(`/clients/contact/${c.id}`, { state: nav })}>
                              <div className="flex-row" style={{ gap: 8 }}>
                                <Avatar initials={`${(c.firstName[0] || '').toUpperCase()}${(c.lastName[0] || '').toUpperCase()}`} variant={(c.id.length % 5) + 1} size="sm" />
                                <div>
                                  <div className="name">{c.firstName} {c.lastName}</div>
                                  <div className="text-xs text-muted">{c.email}</div>
                                </div>
                              </div>
                            </td>
                            <td onClick={() => navigate(`/clients/contact/${c.id}`, { state: nav })}>
                              <div>{companyLabel}</div>
                              <div className="text-xs text-muted">{c.title || '—'}</div>
                            </td>
                            <td onClick={() => navigate(`/clients/contact/${c.id}`, { state: nav })}>
                              <Badge variant={LIFECYCLE_VARIANTS[c.lifecycle] || 'slate'}>
                                {c.lifecycle.charAt(0).toUpperCase() + c.lifecycle.slice(1)}
                              </Badge>
                            </td>
                            <td onClick={() => navigate(`/clients/contact/${c.id}`, { state: nav })}>
                              <div className="flex-row" style={{ gap: 4 }}>
                                {(c.tagIds || []).slice(0, 3).map((tid) => {
                                  const t = selectTagById(state, tid);
                                  return t ? <TagChip key={tid} tag={t} size="xs" /> : null;
                                })}
                                {(c.tagIds || []).length > 3 && <span className="text-xs text-muted">+{(c.tagIds || []).length - 3}</span>}
                              </div>
                            </td>
                            <td onClick={() => navigate(`/clients/contact/${c.id}`, { state: nav })} className="text-xs text-muted">{fmtRelative(c.updatedAt)}</td>
                            <td className="text-right" onClick={() => navigate(`/clients/contact/${c.id}`, { state: nav })}><Icon name="chevronRight" size={14} /></td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>

              <div className="mobile-card-list">
                {filteredContacts.map((c) => {
                  const company = c.companyId ? selectClientById(state, c.companyId) : null;
                  const companyLabel = company?.name || c.customFields?.company || null;
                  const tagIds = (c.tagIds || []).slice(0, 2);
                  const extraTagCount = (c.tagIds || []).length - tagIds.length;
                  return (
                    <div
                      key={c.id}
                      className="mobile-card"
                      onClick={() => navigate(`/clients/contact/${c.id}`, { state: nav })}
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
            </>
          )}

          <AddContactModal open={addContactOpen} onClose={() => setAddContactOpen(false)} />
          <CsvImportModal open={csvImportOpen} onClose={() => setCsvImportOpen(false)} />
        </>
      )}

      {tab === 'clients' && (
        <>
          <div className="filter-bar">
            <FormField label="Search" value={aSearch} onChange={(e) => setParam('aq', e.target.value)} placeholder="Name, contact, email…" />
            <FormField label="Status" as="select" value={aStatus} onChange={(e) => setParam('astatus', e.target.value, 'active')}
              options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
            <FormField label="Service" as="select" value={aService} onChange={(e) => setParam('aservice', e.target.value, 'all')}
              options={[{ value: 'all', label: 'All services' }, ...services.map((s) => ({ value: s.id, label: s.name }))]} />
            <FormField label="Frequency" as="select" value={aFreq} onChange={(e) => setParam('afreq', e.target.value, 'all')}
              options={[{ value: 'all', label: 'All frequencies' }, ...frequencies.map((f) => ({ value: f.id, label: f.label }))]} />
          </div>

          <div className={`bulk-bar ${selectedClientIds.size === 0 ? 'is-empty' : ''}`}>
            <span className="text-sm font-semi">
              {selectedClientIds.size > 0 ? `${selectedClientIds.size} selected` : 'Select clients for bulk actions'}
            </span>
            {selectedClientIds.size > 0 && (
              <>
                <button className="btn btn-danger btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setConfirmClientDeleteOpen(true)}>Delete</button>
                <button className="btn btn-outline btn-sm" onClick={clearClientSelection}>Cancel</button>
              </>
            )}
          </div>

          {filteredClients.length === 0 ? (
            clients.length === 0 ? (
              <EmptyState
                icon={<Icon name="clients" size={28} />}
                title="No clients yet"
                message="Add your first client to get started."
                action={canCreateClient && <button className="btn btn-primary" onClick={() => setAddClientOpen(true)}>Add Client</button>}
              />
            ) : (
              <EmptyState title="No matches" message="Try clearing filters or changing search." />
            )
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          aria-label="Select all clients"
                          checked={selectedClientIds.size > 0 && selectedClientIds.size === filteredClients.length}
                          onChange={toggleSelectAllClients}
                        />
                      </th>
                      <th>Client</th>
                      <th>Primary contact</th>
                      <th>Service</th>
                      <th>Frequency</th>
                      <th>Last Service</th>
                      <th>Revenue</th>
                      <th>Status</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredClients.map((c) => {
                        const primary = c.primaryContactId ? allContacts.find((ct) => ct.id === c.primaryContactId) : null;
                        const primaryLabel = primary ? `${primary.firstName} ${primary.lastName}` : (c.primaryContact || '—');
                        return (
                          <tr key={c.id} className="clickable" onClick={() => navigate(`/clients/${c.id}`, { state: nav })}>
                            <td onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                aria-label={`Select ${c.name}`}
                                checked={selectedClientIds.has(c.id)}
                                onChange={() => toggleClientSelected(c.id)}
                              />
                            </td>
                            <td className="name">{c.name}</td>
                            <td>{primaryLabel}</td>
                            <td>{selectServiceById(state, c.serviceId)?.name || '—'}</td>
                            <td>{frequencies.find((f) => f.id === c.frequencyId)?.label || '—'}</td>
                            <td>{c.lastServiceAt ? fmtDate(c.lastServiceAt) : '—'}</td>
                            <td className="money">{money(c.revenue || 0)}</td>
                            <td><Badge variant={statusBadgeVariant(c.status === 'active' ? 'Active' : 'Inactive')}>
                              {c.status === 'active' ? 'Active' : 'Inactive'}
                            </Badge></td>
                            <td className="text-right"><Icon name="chevronRight" size={14} /></td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>

              <div className="mobile-card-list">
                {filteredClients.map((c) => {
                  const primary = c.primaryContactId ? allContacts.find((ct) => ct.id === c.primaryContactId) : null;
                  const primaryLabel = primary ? `${primary.firstName} ${primary.lastName}` : (c.primaryContact || '—');
                  const serviceName = selectServiceById(state, c.serviceId)?.name;
                  const freqLabel = frequencies.find((f) => f.id === c.frequencyId)?.label;
                  const initials = c.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
                  return (
                    <div
                      key={c.id}
                      className="mobile-card"
                      onClick={() => navigate(`/clients/${c.id}`, { state: nav })}
                    >
                      <input
                        type="checkbox"
                        className="mc-check"
                        aria-label={`Select ${c.name}`}
                        checked={selectedClientIds.has(c.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleClientSelected(c.id)}
                      />
                      <div className="mc-avatar" style={{ gridColumn: 1, gridRow: '1 / span 2' }}>
                        <Avatar initials={initials} variant={(c.id.length % 5) + 1} size="sm" />
                      </div>
                      <div className="mc-name" style={{ gridColumn: '2 / span 2' }}>{c.name}</div>
                      <div className="mc-chev"><Icon name="chevronRight" size={14} /></div>
                      <div className="mc-sub" style={{ gridColumn: '2 / span 2' }}>
                        {primaryLabel}{serviceName ? ` · ${serviceName}` : ''}
                      </div>
                      <div className="mc-meta">
                        <Badge variant={statusBadgeVariant(c.status === 'active' ? 'Active' : 'Inactive')}>
                          {c.status === 'active' ? 'Active' : 'Inactive'}
                        </Badge>
                        {freqLabel && <span className="text-xs text-muted">{freqLabel}</span>}
                        <span className="mc-ago">{money(c.revenue || 0)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          <AddClientModal open={addClientOpen} onClose={() => setAddClientOpen(false)} />
        </>
      )}

      <ConfirmDialog
        open={confirmContactDeleteOpen}
        title={`Delete ${selectedIds.size} contact${selectedIds.size === 1 ? '' : 's'}?`}
        message="The selected contacts will be permanently removed. Their conversations will be unlinked but preserved."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={bulkDelete}
        onClose={() => setConfirmContactDeleteOpen(false)}
      />

      <ConfirmDialog
        open={confirmClientDeleteOpen}
        title={`Delete ${selectedClientIds.size} client${selectedClientIds.size === 1 ? '' : 's'}?`}
        message="The selected clients will be permanently removed along with their contacts, sites, jobs, and invoices. This cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={bulkDeleteClients}
        onClose={() => setConfirmClientDeleteOpen(false)}
      />
    </>
  );
}
