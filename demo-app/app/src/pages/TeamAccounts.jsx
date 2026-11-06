// Accounts — every account (customer) with its account manager (S131, plan 2026-10-14 §0; Matt and
// Daniel 2026-10-13/14: an Operations Manager "sees every account their AMs hold, and which AM holds
// which account"; Daniel's answer 3: they move buildings between their AMs). UI_RULES §169.
//
//   · an OPERATIONS MANAGER: their team's accounts (lib/teamScope teamClientIds), the Account manager
//     filter over their team, and per row "Change account manager" limited to their team — the
//     org_state guard holds the same rule on save (an OM holding ops.edit moves a building only
//     between members of their COMMITTED team);
//   · the owner / an admin: every account, by operations manager → account manager → customer, an
//     Operations manager filter, an Account manager filter with "Unassigned", and the full picker
//     (the existing rule: owner / admin with ops.edit, ServiceSetupCard's);
//   · anyone else (an account manager reads their own on Customers; crew): the refusal page.
// One write per change, the existing UPDATE_CLIENT_OPS { supervisorId } (ServiceSetupCard and
// SupervisedCustomersCard write the same). 20 a page (usePagedRows + ListPager, lint:tables), stacked
// cards on a phone (.mobile-stack). Filters live in the URL (?om=&am=&q=&page=). Archived customers
// are not working accounts (CS-663) and are left out. Every word is a catalog line.
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useDispatch, useSelector } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useFromHere } from '../hooks/useFromHere';
import { usePagedRows } from '../hooks/usePagedRows';
import { useToast } from '../components/Toast';
import Avatar from '../components/Avatar';
import Badge from '../components/Badge';
import EmptyState from '../components/EmptyState';
import FilterSelect from '../components/FilterSelect';
import FormField from '../components/FormField';
import Icon from '../components/Icon';
import ListPager from '../components/ListPager';
import { SUPERVISOR_ROLES, compareUsersByName } from '../lib/roles';
import { isArchivedCustomer } from '../lib/customerStatus';
import { customerLabel } from '../lib/customerNumber';
import { isOpsManager, isActiveOpsManager, opsManagerOf, teamMemberIds, teamClientIds, seesTeamPages } from '../lib/teamScope';
import { useT } from '../i18n/react';

const UNASSIGNED = 'unassigned';
const NO_OM = 'none';
const STATUS = {
  lead: ['amber', 'mgrTeam.accounts.status.lead'],
  active: ['green', 'mgrTeam.accounts.status.active'],
  inactive: ['slate', 'mgrTeam.accounts.status.inactive'],
};
// A customer's working status without the derived Lead/Active read (that one walks every job and
// invoice per row): the status menu's choice when there is one, else Active — an account somebody
// manages is one we clean.
const statusOf = (c) => (c?.statusOverride && STATUS[c.statusOverride] ? c.statusOverride : (c?.status === 'inactive' ? 'inactive' : 'active'));

const selUsers = (s) => s.users;
const selClients = (s) => s.clients;
const selSites = (s) => s.sites;

export default function TeamAccounts() {
  const t = useT();
  const { currentUser } = useAuth();
  const dispatch = useDispatch();
  const toast = useToast();
  const nav = useFromHere();
  const canEditOps = usePermission('ops.edit');
  const users = useSelector(selUsers);
  const clients = useSelector(selClients);
  const sites = useSelector(selSites);
  const [params, setParams] = useSearchParams();
  const setParam = (patch) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') p.delete(k); else p.set(k, String(v)); }
    p.delete('page');
    return p;
  }, { replace: true });

  const om = isOpsManager(currentUser);
  const office = currentUser?.role === 'owner' || currentUser?.role === 'admin';
  const allowed = seesTeamPages(currentUser);
  const byId = useMemo(() => new Map((users || []).filter(Boolean).map((u) => [u.id, u])), [users]);
  const siteCount = useMemo(() => {
    const m = new Map();
    for (const s of sites || []) if (s && s.clientId) m.set(s.clientId, (m.get(s.clientId) || 0) + 1);
    return m;
  }, [sites]);

  // Whose accounts: an OM's team, or every account for the office.
  const team = useMemo(() => (om ? teamMemberIds(users, currentUser.id) : null), [om, users, currentUser]);
  const teamBuildings = useMemo(() => (om ? teamClientIds(users, clients, currentUser.id) : null), [om, users, clients, currentUser]);
  const accounts = useMemo(() => (clients || []).filter((c) => c && c.id && c.type !== 'vendor' && !isArchivedCustomer(c)
    && (!teamBuildings || teamBuildings.has(c.id))), [clients, teamBuildings]);

  // The filters (the URL): an operations manager (office only), an account manager, a search.
  const omFilter = office ? (params.get('om') || '') : '';
  const amFilter = params.get('am') || '';
  const q = (params.get('q') || '').trim().toLowerCase();
  const oms = useMemo(() => (users || []).filter(isActiveOpsManager).slice().sort(compareUsersByName), [users]);
  const leadOf = (supervisorId) => {
    const sup = supervisorId ? byId.get(supervisorId) : null;
    if (!sup) return null;
    return isOpsManager(sup) ? sup : opsManagerOf(users, sup.id);
  };
  // The account managers the filter and the picker offer: an OM's team; the office's every manager
  // who may supervise a building (SUPERVISOR_ROLES), active.
  const managers = useMemo(() => (om
    ? team.map((id) => byId.get(id)).filter(Boolean)
    : (users || []).filter((u) => u && u.status === 'active' && SUPERVISOR_ROLES.includes(u.role)).slice().sort(compareUsersByName)
  ), [om, team, users, byId]);

  const rows = useMemo(() => {
    const out = accounts.filter((c) => {
      if (amFilter === UNASSIGNED ? !!c.supervisorId : (amFilter && c.supervisorId !== amFilter)) return false;
      if (omFilter) {
        const lead = leadOf(c.supervisorId);
        if (omFilter === NO_OM ? !!lead : lead?.id !== omFilter) return false;
      }
      if (q && !customerLabel(c).toLowerCase().includes(q) && !(byId.get(c.supervisorId)?.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
    // Grouped: the office's by operations manager → account manager → customer; an OM's by account
    // manager → customer (their own buildings first).
    const name = (u) => (u?.name || '').toLowerCase();
    const sortKey = (c) => {
      const sup = c.supervisorId ? byId.get(c.supervisorId) : null;
      const lead = leadOf(c.supervisorId);
      return [office ? (lead ? `0${name(lead)}` : '1') : '', sup ? (om && sup.id === currentUser.id ? '0' : `1${name(sup)}`) : '2', customerLabel(c).toLowerCase()];
    };
    return out.map((c) => ({ c, k: sortKey(c) }))
      .sort((a, b) => a.k[0].localeCompare(b.k[0]) || a.k[1].localeCompare(b.k[1]) || a.k[2].localeCompare(b.k[2], undefined, { numeric: true }))
      .map((x) => x.c);
  }, [accounts, amFilter, omFilter, q, byId, users, office, om, currentUser]); // eslint-disable-line react-hooks/exhaustive-deps
  const pager = usePagedRows(rows, { param: 'page', resetKey: `${omFilter}|${amFilter}|${q}` });

  if (!allowed) {
    return <EmptyState icon={<Icon name="lock" size={28} />} title={t('noAccess.title')} message={t('noAccess.body')} />;
  }

  // Change a building's account manager — one UPDATE_CLIENT_OPS, as every other supervisor picker.
  const canChange = canEditOps && (office || om);
  const change = (c, supervisorId) => {
    if (!canChange || (supervisorId || null) === (c.supervisorId || null)) return;
    dispatch({
      type: ACTIONS.UPDATE_CLIENT_OPS, id: c.id, patch: { supervisorId: supervisorId || null },
      actorName: currentUser?.name, summary: 'Account supervisor was updated.',
    });
    const to = supervisorId ? byId.get(supervisorId) : null;
    toast.success(to ? t('mgrTeam.accounts.moved', { customer: customerLabel(c), name: to.name }) : t('mgrTeam.accounts.unassignedNow', { customer: customerLabel(c) }));
  };
  const pickerOptions = [
    ...(office ? [{ value: '', label: t('mgrTeam.accounts.noAm') }] : []),
    ...managers.map((m) => ({ value: m.id, label: m.id === currentUser?.id ? t('mgrToday.me', { name: m.name }) : m.name })),
  ];
  const amOptions = [
    { value: '', label: t('mgrTeam.accounts.allAms') },
    ...(office ? [{ value: UNASSIGNED, label: t('mgrTeam.accounts.unassigned') }] : []),
    ...managers.map((m) => ({ value: m.id, label: m.id === currentUser?.id ? t('mgrToday.me', { name: m.name }) : m.name })),
  ];
  const omOptions = [
    { value: '', label: t('mgrTeam.accounts.allOms') },
    ...oms.map((m) => ({ value: m.id, label: m.name })),
    { value: NO_OM, label: t('mgrTeam.accounts.noOm') },
  ];
  const person = (u) => (u ? <span className="mgrteam-person"><Avatar user={u} size="sm" /><span className="truncate" title={u.name}>{u.name}</span></span>
    : <span className="text-muted">—</span>);

  return (
    <div className="page mgrteam-accounts">
      <div className="page-head">
        <div className="page-head-text">
          <h1 className="page-head-title">{t('mgrTeam.accounts.title')}</h1>
          <p className="page-sub">{om ? t('mgrTeam.accounts.subTeam', { count: accounts.length }) : t('mgrTeam.accounts.subAll', { count: accounts.length })}</p>
        </div>
      </div>

      <div className="filter-bar mgrteam-filters">
        {office && (
          <FormField label={t('mgrTeam.accounts.filter.om')}>
            <FilterSelect ariaLabel={t('mgrTeam.accounts.filter.om')} value={omFilter} onChange={(v) => setParam({ om: v })} options={omOptions} />
          </FormField>
        )}
        <FormField label={t('mgrTeam.accounts.filter.am')}>
          <FilterSelect ariaLabel={t('mgrTeam.accounts.filter.am')} value={amFilter} onChange={(v) => setParam({ am: v })} options={amOptions} />
        </FormField>
        <FormField label={t('mgrTeam.accounts.search')}>
          <input
            className="input" type="search" value={params.get('q') || ''} placeholder={t('mgrTeam.accounts.search')}
            aria-label={t('mgrTeam.accounts.search')} onChange={(e) => setParam({ q: e.target.value })}
          />
        </FormField>
      </div>
      {!canChange && <p className="text-xs text-muted mgrteam-note">{t('mgrTeam.accounts.readOnly')}</p>}

      {rows.length === 0 ? (
        accounts.length === 0
          ? <EmptyState icon={<Icon name="building" size={28} />} title={t('mgrTeam.accounts.empty')} message={t('mgrTeam.accounts.emptyTeam')} />
          : <EmptyState icon={<Icon name="search" size={28} />} title={t('mgrTeam.accounts.noMatch')} message={t('mgrTeam.accounts.noMatchHint')} />
      ) : (
        <>
          <div className="table-wrap mobile-stack">
            <table className="mgrteam-table">
              <thead>
                <tr>
                  <th>{t('mgrTeam.accounts.col.customer')}</th>
                  {office && <th>{t('mgrTeam.accounts.col.om')}</th>}
                  <th>{t('mgrTeam.accounts.col.am')}</th>
                  <th>{t('mgrTeam.accounts.col.buildings')}</th>
                  <th>{t('mgrTeam.accounts.col.status')}</th>
                  <th className="col-review">{t('mgrTeam.accounts.change')}</th>
                </tr>
              </thead>
              <tbody>
                {pager.pageRows.map((c) => {
                  const sup = c.supervisorId ? byId.get(c.supervisorId) : null;
                  const [variant, key] = STATUS[statusOf(c)];
                  return (
                    <tr key={c.id}>
                      <td className="cell-primary">
                        <Link to={`/clients/${c.id}`} state={nav} className="table-name-link"><span className="truncate" title={customerLabel(c)}>{customerLabel(c)}</span></Link>
                      </td>
                      {office && <td data-label={t('mgrTeam.accounts.col.om')}>{person(leadOf(c.supervisorId))}</td>}
                      <td data-label={t('mgrTeam.accounts.col.am')}>{person(sup)}</td>
                      <td data-label={t('mgrTeam.accounts.col.buildings')}>{siteCount.get(c.id) || 0}</td>
                      <td data-label={t('mgrTeam.accounts.col.status')}><Badge variant={variant}>{t(key)}</Badge></td>
                      <td data-label={t('mgrTeam.accounts.change')} className="mgrteam-change">
                        {canChange ? (
                          <FilterSelect
                            float
                            ariaLabel={t('mgrTeam.accounts.change')}
                            value={c.supervisorId || ''}
                            onChange={(v) => change(c, v)}
                            options={pickerOptions.some((o) => o.value === (c.supervisorId || '')) ? pickerOptions
                              : [{ value: c.supervisorId || '', label: sup?.name || t('mgrTeam.accounts.noAm') }, ...pickerOptions]}
                          />
                        ) : <span className="text-muted">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ListPager pager={pager} noun={t('mgrTeam.accounts.noun')} />
        </>
      )}
    </div>
  );
}
