import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { selectClients } from '../../store/selectors';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../components/Toast';
import SectionTabs from '../../components/SectionTabs';
import FilterSelect from '../../components/FilterSelect';
import FormField from '../../components/FormField';
import Modal from '../../components/Modal';
import ConfirmDialog from '../../components/ConfirmDialog';
import EmptyState from '../../components/EmptyState';
import Badge from '../../components/Badge';
import Icon from '../../components/Icon';
import BuildingMultiPicker from '../../components/BuildingMultiPicker';
import ListPager from '../../components/ListPager';
import { SignInLinkModal } from '../../components/SignInLinkPanel';
import { usePagedRows } from '../../hooks/usePagedRows';
import { useT } from '../../i18n/react';
import {
  listClientHub, saveClientUser, setClientUserAssignments, inviteClientUser,
  setClientUserStatus, removeClientUser, saveClientGroup, removeClientGroup,
  isClientHubStub, CLIENT_HUB_STUB_MESSAGE,
} from '../../lib/clientHubApi';
import { CLIENT_GROUP_KINDS, resolveAllowedClientIds } from '../../lib/clientHub';
import { customerLabel } from '../../lib/customerNumber';

// SETTINGS → CUSTOMER LOGINS (HUB-1/3/4/14/17, GO-10).
//
// Who on the customer's side can sign in, which buildings each of them sees, and the groups
// that stand for a management company or a city. The office owns all of it — a customer
// cannot invite anyone, and this page is refused to a client login twice over (the route's
// `hub.users.*` keys, and requireAuthority refusing role 'client' outright).
//
// The data is SERVER-ONLY: client users, groups and assignments live in their own tables so
// they never enter the shared record, so this page fetches rather than reading the store.
// The one thing it does read from the store is the CUSTOMER BOOK — the names of the
// buildings being assigned — which the office already holds.
const STATUS_BADGE = { active: 'green', invited: 'amber', disabled: 'slate' };

export default function ClientLogins() {
  const state = useStore();
  const toast = useToast();
  const t = useT();
  const canManage = usePermission('hub.users.manage');
  const clients = selectClients(state);

  const [tab, setTab] = useState('people');
  const [data, setData] = useState(null);     // null = loading
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [customerFilter, setCustomerFilter] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [accessFor, setAccessFor] = useState(null);   // a client user row
  const [groupEdit, setGroupEdit] = useState(null);   // a group row, or {} for a new one
  const [confirm, setConfirm] = useState(null);       // { kind: 'user' | 'group' | 'reinvite', row }
  // An invite nothing was emailed for: { user, link, why, replaces } — the one-time link to hand
  // over (GO-10). Component state only, never stored.
  const [inviteResult, setInviteResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const stub = isClientHubStub();

  const reload = async () => {
    setError('');
    try { setData(await listClientHub()); } catch (e) { setError(e?.message || 'Could not load customer logins.'); setData({ users: [], groups: [], groupMembers: [], assignments: [] }); }
  };
  useEffect(() => { reload(); }, []);

  // The building options, from the customer book the office already has.
  const buildingOptions = useMemo(
    () => clients.map((c) => ({ value: c.id, label: customerLabel(c) })).sort((a, b) => a.label.localeCompare(b.label)),
    [clients],
  );
  const clientName = useMemo(() => new Map(clients.map((c) => [c.id, c.name])), [clients]);
  const liveClientIds = useMemo(() => clients.map((c) => c.id), [clients]);

  const users = data?.users || [];
  const groups = data?.groups || [];
  const groupMembers = data?.groupMembers || [];
  const assignments = data?.assignments || [];

  // Each person's RESOLVED scope — the same pure rule the server's gate runs, so this page
  // shows exactly what the hub will serve rather than a second interpretation of the rows.
  const scopeFor = useMemo(() => {
    const map = new Map();
    for (const u of users) {
      map.set(u.id, resolveAllowedClientIds({
        status: u.status,
        assignments: assignments.filter((a) => a.clientUserId === u.id),
        groupMembers,
        clientIds: liveClientIds,
      }));
    }
    return map;
  }, [users, assignments, groupMembers, liveClientIds]);

  const rows = useMemo(() => users.filter((u) => {
    if (statusFilter && u.status !== statusFilter) return false;
    if (customerFilter && !(scopeFor.get(u.id) || []).includes(customerFilter)) return false;
    return true;
  }), [users, statusFilter, customerFilter, scopeFor]);

  // Both tables are paged (UI_RULES §50): a pilot is a few accounts, but a management
  // company's whole contact list and a group per city are not, and an unpaged table is
  // only ever discovered once the book is real. Filters reset the page, or filtering a
  // 5-page list while sitting on page 4 reads as "no results".
  const userPager = usePagedRows(rows, { param: 'page', resetKey: `${statusFilter}|${customerFilter}` });
  const groupPager = usePagedRows(groups, { param: 'gpage' });

  const run = async (fn, okMsg) => {
    setBusy(true);
    try {
      const out = await fn();
      await reload();
      if (okMsg) toast.success(okMsg);
      return out;
    } catch (e) {
      // A save from a set that is no longer the stored one (CS-662): nothing was changed. Close
      // the editor and reload, so it reopens on what is there now.
      if (e?.code === 'stale' || e?.code === 'reload') {
        setAccessFor(null);
        setGroupEdit(null);
        await reload();
        toast.error(t('clientLogins.stale'));
        return null;
      }
      toast.error(e?.message || 'That did not work.');
      return null;
    } finally {
      setBusy(false);
    }
  };

  // Invite: emailed when a mailbox can send it; otherwise the link to hand over (GO-10), which a
  // re-invite makes anew — voiding the one sent before (the confirm said so first).
  const invite = async (u) => {
    const out = await run(() => inviteClientUser(u.id));
    if (!out) return;
    if (out.invited) toast.success(t('clientLogins.inviteEmailed', { email: u.email }));
    else if (out.link) setInviteResult({ user: u, link: out.link, why: out.why, replaces: !!u.hasLogin });
    else toast.error(t('clientLogins.noLink'));
  };

  // Disable / Enable say what happened to the LOGIN too: banned, left alone because it isn't this
  // contact's (CS-660), or a ban that didn't land (the row's status still holds every gate).
  const setAccess = async (u) => {
    const enabling = u.status === 'disabled';
    const out = await run(() => setClientUserStatus(u.id, enabling ? 'active' : 'disabled'));
    if (!out) return;
    if (out.loginBanned === 'failed') toast.error(t(enabling ? 'clientLogins.unbanFailed' : 'clientLogins.banFailed'));
    else if (!enabling && out.loginKept) toast.info(t('clientLogins.disabledKept'));
    else toast.success(t(enabling ? 'clientLogins.enabled' : 'clientLogins.disabled'));
  };

  if (stub) {
    return (
      <div>
        <div className="page-head-text"><h1 className="page-head-title">Customer logins</h1></div>
        <EmptyState icon={<Icon name="lock" size={28} />} title="Not available in demo mode" message={CLIENT_HUB_STUB_MESSAGE} />
      </div>
    );
  }

  return (
    <div>
      <div className="page-head-text"><h1 className="page-head-title">Customer logins</h1></div>
      <p className="text-sm text-muted clh-intro">
        Give a customer contact their own sign-in to see the buildings they look after. A group
        stands for a management company or a city — assign the group and they see every building
        in it, including ones you add later.
      </p>

      <SectionTabs
        sections={[
          { key: 'people', label: 'People', count: users.length },
          { key: 'groups', label: 'Groups', count: groups.length },
        ]}
        activeKey={tab}
        onSelect={setTab}
      />

      {error && <p className="text-sm login-msg-error">{error}</p>}
      {data === null && <p className="text-muted">Loading…</p>}

      {data !== null && tab === 'people' && (
        <>
          <div className="filter-bar">
            <FilterSelect
              ariaLabel="Status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={[
                { value: '', label: 'All statuses' },
                { value: 'active', label: 'Active' },
                { value: 'invited', label: 'Invited' },
                { value: 'disabled', label: 'Disabled' },
              ]}
            />
            <FilterSelect
              ariaLabel="Customer"
              value={customerFilter}
              onChange={setCustomerFilter}
              options={[{ value: '', label: 'All customers' }, ...buildingOptions]}
            />
            <div className="spacer" />
            {canManage && <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>Add contact</button>}
          </div>

          {rows.length === 0 ? (
            <EmptyState
              icon={<Icon name="user" size={28} />}
              title={users.length ? 'No one matches those filters' : 'No customer logins yet'}
              message={users.length ? 'Clear a filter to see the rest.' : 'Add a customer contact, choose their buildings, then send the invite.'}
            />
          ) : (
            <div className="table-wrap mobile-stack">
              <table>
                <thead>
                  <tr><th>Name</th><th>Email</th><th>Buildings</th><th>Status</th><th /></tr>
                </thead>
                <tbody>
                  {userPager.pageRows.map((u) => {
                    const scope = scopeFor.get(u.id) || [];
                    return (
                      <tr key={u.id}>
                        <td className="cell-primary">
                          <span className="name truncate" title={u.name}>{u.name}</span>
                          {u.phone && <div className="text-xs text-muted">{u.phone}</div>}
                        </td>
                        <td data-label="Email"><span className="truncate" title={u.email}>{u.email}</span></td>
                        <td data-label="Buildings">
                          {scope.length === 0
                            ? <span className="text-xs text-muted">None yet</span>
                            : <span className="text-sm" title={scope.map((id) => clientName.get(id) || id).join(', ')}>
                              {scope.length === 1 ? (clientName.get(scope[0]) || scope[0]) : `${scope.length} buildings`}
                            </span>}
                        </td>
                        <td data-label="Status">
                          <Badge variant={STATUS_BADGE[u.status] || 'slate'}>
                            {u.status.charAt(0).toUpperCase() + u.status.slice(1)}
                          </Badge>
                          {!u.hasLogin && <div className="text-xs text-muted">No login yet</div>}
                        </td>
                        <td className="text-right cell-actions">
                          {canManage && (
                            <div className="appr-actions">
                              <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => setAccessFor(u)}>Access</button>
                              <button
                                type="button" className="btn btn-outline btn-sm" disabled={busy || u.status === 'disabled'}
                                onClick={() => (u.hasLogin ? setConfirm({ kind: 'reinvite', row: u }) : invite(u))}
                              >
                                {u.hasLogin ? 'Re-invite' : 'Invite'}
                              </button>
                              <button
                                type="button" className="btn btn-outline btn-sm" disabled={busy}
                                onClick={() => setAccess(u)}
                              >
                                {u.status === 'disabled' ? 'Enable' : 'Disable'}
                              </button>
                              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => setConfirm({ kind: 'user', row: u })}>Remove</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <ListPager pager={userPager} noun="contacts" />
            </div>
          )}
        </>
      )}

      {data !== null && tab === 'groups' && (
        <>
          <div className="filter-bar">
            <div className="spacer" />
            {canManage && <button type="button" className="btn btn-primary" onClick={() => setGroupEdit({})}>Add group</button>}
          </div>
          {groups.length === 0 ? (
            <EmptyState
              icon={<Icon name="building" size={28} />}
              title="No groups yet"
              message="A group is a management company's portfolio, or every building in one city. Assign the group to a person and they see all of it."
            />
          ) : (
            <div className="table-wrap mobile-stack">
              <table>
                <thead><tr><th>Name</th><th>Kind</th><th>Buildings</th><th /></tr></thead>
                <tbody>
                  {groupPager.pageRows.map((g) => {
                    const members = groupMembers.filter((m) => m.groupId === g.id);
                    return (
                      <tr key={g.id}>
                        <td className="cell-primary"><span className="name truncate" title={g.name}>{g.name}</span></td>
                        <td data-label="Kind">{CLIENT_GROUP_KINDS.find((k) => k.id === g.kind)?.label || g.kind}</td>
                        <td data-label="Buildings">{members.length}</td>
                        <td className="text-right cell-actions">
                          {canManage && (
                            <div className="appr-actions">
                              <button type="button" className="btn btn-outline btn-sm" disabled={busy} onClick={() => setGroupEdit({ ...g, clientIds: members.map((m) => m.clientId) })}>Edit</button>
                              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => setConfirm({ kind: 'group', row: g })}>Delete</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <ListPager pager={groupPager} noun="groups" />
            </div>
          )}
        </>
      )}

      <AddContactDialog
        open={addOpen}
        busy={busy}
        onClose={() => setAddOpen(false)}
        onSave={async (form) => {
          const out = await run(() => saveClientUser(form), 'Contact added. Choose their buildings, then invite them.');
          if (out) { setAddOpen(false); setAccessFor(out.user); }
        }}
      />

      <AccessDialog
        user={accessFor}
        busy={busy}
        groups={groups}
        buildingOptions={buildingOptions}
        assignments={assignments}
        onClose={() => setAccessFor(null)}
        onSave={async (clientIds, groupIds, base) => {
          // `base`: the grants the dialog LOADED — replaced only while they are still the stored ones.
          const out = await run(() => setClientUserAssignments({ id: accessFor.id, clientIds, groupIds, base }), 'Access saved.');
          if (out) setAccessFor(null);
        }}
      />

      <GroupDialog
        group={groupEdit}
        busy={busy}
        buildingOptions={buildingOptions}
        onClose={() => setGroupEdit(null)}
        onSave={async (form) => {
          const out = await run(() => saveClientGroup(form), 'Group saved.');
          if (out) setGroupEdit(null);
        }}
      />

      {/* GO-10: while no system sender is connected the office sends the link itself, so the
          invite's answer shows it here to copy. One-time and short-lived — never stored. */}
      <SignInLinkModal
        open={!!inviteResult}
        onClose={() => setInviteResult(null)}
        name={inviteResult?.user?.name}
        link={inviteResult?.link}
        why={inviteResult?.why}
        replaces={!!inviteResult?.replaces}
      />

      {/* A re-invite makes a NEW link, which voids the one sent before (one per login): said first. */}
      <ConfirmDialog
        open={confirm?.kind === 'reinvite'}
        title={t('clientLogins.reinvite.title', { name: confirm?.row?.name || '' })}
        message={t('clientLogins.reinvite.message')}
        confirmLabel={t('clientLogins.reinvite.confirm')}
        onClose={() => setConfirm(null)}
        onConfirm={() => invite(confirm.row)}
      />

      <ConfirmDialog
        open={!!confirm && confirm.kind !== 'reinvite'}
        title={confirm?.kind === 'group' ? 'Delete this group?' : 'Remove this customer login?'}
        message={confirm?.kind === 'group'
          ? `"${confirm?.row?.name}" and its building list are deleted. Anyone who could see those buildings only through this group loses them.`
          : `${confirm?.row?.name} will be signed out and their login deleted. This cannot be undone — invite them again to restore access.`}
        confirmLabel={confirm?.kind === 'group' ? 'Delete group' : 'Remove'}
        variant="danger"
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          const c = confirm;
          if (c.kind === 'group') { await run(() => removeClientGroup(c.row.id), 'Group deleted.'); return; }
          // Their own login goes with them; a login that only shares the address is left alone
          // and the answer says so (CS-660).
          const out = await run(() => removeClientUser(c.row.id));
          if (out?.loginKept) toast.info(t('clientLogins.removedKept', { name: c.row.name }));
          else if (out) toast.success(t('clientLogins.removed'));
        }}
      />
    </div>
  );
}

// ── add a contact ────────────────────────────────────────────────────────────
// The EMAIL is the sign-in identity and is set once: changing it later would leave the
// Supabase account on the old address, i.e. a login nobody can see on this page. The server
// refuses an email change for the same reason.
function AddContactDialog({ open, busy, onClose, onSave }) {
  const [form, setForm] = useState({ name: '', email: '', phone: '' });
  useEffect(() => { if (open) setForm({ name: '', email: '', phone: '' }); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title="Add a customer contact">
      <FormField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Their full name" />
      <FormField label="Email (their sign-in)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="their work email" />
      <FormField label="Phone (optional)" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Mobile number" />
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
        <button
          type="button" className="btn btn-primary"
          disabled={busy || !form.name.trim() || !form.email.trim()}
          onClick={() => onSave(form)}
        >
          Add contact
        </button>
      </div>
    </Modal>
  );
}

// ── who sees what ────────────────────────────────────────────────────────────
function AccessDialog({ user, busy, groups, buildingOptions, assignments, onClose, onSave }) {
  const [clientIds, setClientIds] = useState([]);
  const [groupIds, setGroupIds] = useState([]);
  // What the dialog LOADED, sent with the save: the server replaces this person's grants only while
  // these are still the stored ones (CS-662), so a stale or partial screen can delete nothing.
  const [base, setBase] = useState({ clientIds: [], groupIds: [] });
  useEffect(() => {
    if (!user) return;
    const mine = assignments.filter((a) => a.clientUserId === user.id);
    const loaded = {
      clientIds: mine.filter((a) => a.clientId).map((a) => a.clientId),
      groupIds: mine.filter((a) => a.groupId).map((a) => a.groupId),
    };
    setBase(loaded);
    setClientIds(loaded.clientIds);
    setGroupIds(loaded.groupIds);
  }, [user, assignments]);
  const toggleGroup = (id) => setGroupIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  return (
    <Modal open={!!user} onClose={onClose} title={user ? `What ${user.name} can see` : ''} size="lg">
      {user && (
        <>
          {groups.length > 0 && (
            <div className="bmp">
              <div className="bmp-head"><span className="form-label">Groups</span><span className="text-xs text-muted">{groupIds.length} selected</span></div>
              <div className="bmp-list">
                {groups.map((g) => (
                  <label key={g.id} className="bmp-row">
                    <input type="checkbox" checked={groupIds.includes(g.id)} onChange={() => toggleGroup(g.id)} />
                    <span className="truncate" title={g.name}>{g.name}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted">A group grants every building in it — including ones you add to the group later.</p>
            </div>
          )}
          <BuildingMultiPicker
            label="Buildings, one by one"
            options={buildingOptions}
            value={clientIds}
            onChange={setClientIds}
          />
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onSave(clientIds, groupIds, base)}>Save access</button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ── a group ──────────────────────────────────────────────────────────────────
function GroupDialog({ group, busy, buildingOptions, onClose, onSave }) {
  const [form, setForm] = useState({ name: '', kind: 'other', clientIds: [] });
  useEffect(() => {
    if (!group) return;
    setForm({ name: group.name || '', kind: group.kind || 'other', clientIds: group.clientIds || [] });
  }, [group]);
  return (
    <Modal open={!!group} onClose={onClose} title={group?.id ? 'Edit group' : 'Add a group'} size="lg">
      {group && (
        <>
          <FormField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="A management company, or a city" />
          <FormField
            label="Kind" as="select" value={form.kind}
            options={CLIENT_GROUP_KINDS.map((k) => ({ value: k.id, label: k.label }))}
            onChange={(e) => setForm({ ...form, kind: e.target.value })}
          />
          <BuildingMultiPicker
            options={buildingOptions}
            value={form.clientIds}
            onChange={(clientIds) => setForm({ ...form, clientIds })}
          />
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            {/* An existing group's save names the buildings the editor LOADED (CS-662). */}
            <button type="button" className="btn btn-primary" disabled={busy || !form.name.trim()} onClick={() => onSave({ id: group.id, ...form, baseClientIds: group.clientIds || [] })}>Save group</button>
          </div>
        </>
      )}
    </Modal>
  );
}
