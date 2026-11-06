import { useMemo, useState } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectUsers } from '../store/selectors';
import { compareUsersByName } from '../lib/roles';
import { isAccountManager, isActiveOpsManager, hasTeamAccess, opsManagerOf } from '../lib/teamScope';
import { useT } from '../i18n/react';
import Avatar from './Avatar';
import FilterSelect from './FilterSelect';
import FormField from './FormField';

// An Operations Manager's TEAM, built from their Team page (S131, plan 2026-10-14 §0; UI_RULES §169):
// the account managers who report to them (`users[].opsManagerId`). The SupervisedCustomersCard
// pattern (the `.sup-*` two columns, the coverage flag, a click moves one row) over PEOPLE instead
// of buildings, so assigning account managers to an OM reads like assigning buildings to a manager:
//   LEFT  every other active account manager — the ones with NO operations manager pinned above the
//         line (so nobody is left off a team), then the ones already on another OM's team, each with
//         that OM's avatar and first name;
//   RIGHT "Reports to {first}": this OM's account managers.
// One UPDATE_USER per click ({ opsManagerId }), the field the org_state guard holds to owner / admin
// with ops.edit (lib/teamLimits mayAssignTeams, `canEdit` here) and to a valid pointer — the reducer
// ignores an invalid one at the write point. Every word is a catalog line (UI_RULES §140).
export default function AccountManagerAssignmentCard({ om, canEdit }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const users = selectUsers(state);
  const [qLeft, setQLeft] = useState('');
  const [qRight, setQRight] = useState('');
  const first = (om.name || '').split(' ')[0] || om.name || '';
  const matches = (u, q) => (u.name || '').toLowerCase().includes(q.trim().toLowerCase());

  // Every account manager who could be on a team: active, at the account level, not the OM.
  const pool = useMemo(() => (users || []).filter((u) => u && u.id !== om.id && isAccountManager(u) && hasTeamAccess(u)), [users, om.id]);
  // Each account manager's current OM (an active one, else none), read once per roster change.
  const leads = useMemo(() => new Map(pool.map((u) => [u.id, opsManagerOf(users, u.id)])), [pool, users]);
  const leadOf = (u) => leads.get(u.id) || null;
  const mineAll = useMemo(() => pool.filter((u) => leads.get(u.id)?.id === om.id), [pool, leads, om.id]);
  const needsAll = useMemo(() => pool.filter((u) => !leads.get(u.id)), [pool, leads]);
  const othersAll = useMemo(() => pool.filter((u) => { const l = leads.get(u.id); return !!l && l.id !== om.id; }), [pool, leads, om.id]);
  // How many buildings each one supervises (the row's second line).
  const buildingCount = useMemo(() => {
    const m = new Map();
    for (const c of state.clients || []) if (c && c.supervisorId) m.set(c.supervisorId, (m.get(c.supervisorId) || 0) + 1);
    return m;
  }, [state.clients]);
  const sortBy = (list, q) => list.filter((u) => matches(u, q)).slice().sort(compareUsersByName);
  const mine = sortBy(mineAll, qRight);
  const needs = sortBy(needsAll, qLeft);
  const others = sortBy(othersAll, qLeft);

  const setLead = (userId, opsManagerId) => {
    if (!canEdit) return;
    dispatch({ type: ACTIONS.UPDATE_USER, id: userId, patch: { opsManagerId } });
  };

  const Row = (u, kind) => {
    const lead = kind === 'other' ? leadOf(u) : null;
    const onClick = !canEdit ? undefined : kind === 'mine' ? () => setLead(u.id, null) : () => setLead(u.id, om.id);
    return (
      <div
        key={u.id}
        className="sup-row"
        role={canEdit ? 'button' : undefined}
        tabIndex={canEdit ? 0 : undefined}
        onClick={onClick}
        onKeyDown={canEdit ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      >
        <Avatar user={u} size="sm" />
        <div className="sup-nm">
          <b>{u.name}</b>
          <small>{t('mgrTeam.card.buildings', { count: buildingCount.get(u.id) || 0 })}</small>
        </div>
        {kind === 'need' && <span className="sup-nomgr">{t('mgrTeam.card.needsTag')}</span>}
        {kind === 'other' && lead && (
          <span className="sup-mgr"><Avatar user={lead} size="sm" />{(lead.name || '').split(' ')[0]}</span>
        )}
        {canEdit && kind !== 'mine' && <span className="sup-move">{t('mgrTeam.card.assign')}</span>}
        {canEdit && kind === 'mine' && <span className="sup-remove">{t('mgrTeam.card.remove')}</span>}
      </div>
    );
  };

  return (
    <div className="card detail-card">
      <div className="overview-card-head">
        <h3>{t('mgrTeam.card.title')}</h3>
      </div>
      <p className="text-xs text-muted sup-desc">{t('mgrTeam.card.desc', { name: first })}</p>
      {!canEdit && <p className="text-xs text-muted sup-desc">{t('mgrTeam.card.readOnly')}</p>}

      {needsAll.length > 0
        ? <div className="sup-flag">{t('mgrTeam.card.needsFlag', { count: needsAll.length })}</div>
        : <div className="sup-flag is-clear">{t('mgrTeam.card.allCovered')}</div>}

      <div className="sup-cols">
        <div className="sup-col">
          <div className="sup-col-h"><b>{t('mgrTeam.card.pool')}</b><span className="sup-col-cnt">{needsAll.length + othersAll.length}</span></div>
          <div className="sup-col-search">
            <input className="input" placeholder={t('mgrTeam.card.searchPool')} value={qLeft} onChange={(e) => setQLeft(e.target.value)} aria-label={t('mgrTeam.card.searchPool')} />
          </div>
          <div className="sup-subhead need"><span className="sup-dot" />{t('mgrTeam.card.needs')} <span className="sup-pill">{needsAll.length}</span></div>
          <div className="sup-body">
            {needs.length ? needs.map((u) => Row(u, 'need')) : <div className="sup-empty">{qLeft ? t('mgrTeam.card.noMatches') : t('mgrTeam.card.noneNeed')}</div>}
            <div className="sup-divider">{t('mgrTeam.card.others')} <span className="sup-pill">{othersAll.length}</span></div>
            {others.length ? others.map((u) => Row(u, 'other')) : <div className="sup-empty">{qLeft ? t('mgrTeam.card.noMatches') : t('mgrTeam.card.none')}</div>}
          </div>
        </div>

        <div className="sup-col is-target">
          <div className="sup-col-h"><b>{t('mgrTeam.card.mine', { name: first })}</b><span className="sup-col-cnt">{mineAll.length}</span></div>
          <div className="sup-col-search">
            <input className="input" placeholder={t('mgrTeam.card.searchMine')} value={qRight} onChange={(e) => setQRight(e.target.value)} aria-label={t('mgrTeam.card.searchMine')} />
          </div>
          <div className="sup-subhead done"><span className="sup-dot" />{t('mgrTeam.card.assigned')} <span className="sup-pill">{mineAll.length}</span></div>
          <div className="sup-body">
            {mine.length
              ? mine.map((u) => Row(u, 'mine'))
              : <div className="sup-empty">{qRight ? t('mgrTeam.card.noMatches') : (canEdit ? t('mgrTeam.card.emptyMineEdit', { name: first }) : t('mgrTeam.card.emptyMine', { name: first }))}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// An ACCOUNT manager's Team page: who they report to. A picker for whoever may assign teams (owner /
// admin with ops.edit — the guard's rule), the plain line for everyone else. One UPDATE_USER per
// change; the reducer ignores a pick that is not an active Operations Manager.
export function OpsManagerLine({ user, canEdit }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const users = selectUsers(state);
  const lead = opsManagerOf(users, user.id);
  const oms = useMemo(() => (users || []).filter((u) => u && isActiveOpsManager(u) && u.id !== user.id).slice().sort(compareUsersByName), [users, user.id]);
  const options = [{ value: '', label: t('mgrTeam.line.none') }, ...oms.map((u) => ({ value: u.id, label: u.name }))];
  return (
    <div className="card detail-card">
      <h3 className="dash-card-title">{t('mgrTeam.line.title')}</h3>
      {canEdit ? (
        <div className="filter-bar mgrteam-line">
          <FormField label={t('mgrTeam.line.label')}>
            <FilterSelect
              ariaLabel={t('mgrTeam.line.label')}
              value={lead?.id || ''}
              onChange={(v) => dispatch({ type: ACTIONS.UPDATE_USER, id: user.id, patch: { opsManagerId: v || null } })}
              options={options}
            />
          </FormField>
        </div>
      ) : (
        <p className="text-sm">{lead ? t('mgrTeam.line.reportsTo', { name: lead.name }) : t('mgrTeam.line.noneYet')}</p>
      )}
      <p className="text-xs text-muted">{canEdit ? t('mgrTeam.line.hint') : t('mgrTeam.card.readOnly')}</p>
    </div>
  );
}
