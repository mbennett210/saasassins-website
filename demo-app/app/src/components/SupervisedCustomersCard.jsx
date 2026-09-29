import { useMemo, useState } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectClients, selectServices, selectUserById } from '../store/selectors';
import Avatar from './Avatar';

// Bulk editor for the account "single point of contact" (`client.supervisorId`),
// driven from a supervisor's Team profile. It inverts ServiceSetupCard's per-account
// picker: pick the PERSON, then sweep customers to them. Same write (UPDATE_CLIENT_OPS)
// and same eligibility (SUPERVISOR_ROLES) as that card, so the two can't drift.
//
// Left column = the whole pool NOT supervised by this person, with the accounts that
// still have NO manager pinned above a delineation line (so nobody is left uncovered);
// below the line sit accounts already owned by someone else, each showing their manager.
// Right column = this person's accounts. Clicking a row moves it. Rendered only for
// SUPERVISOR_ROLES members (the caller gates on role); editing needs `ops.edit`.
export default function SupervisedCustomersCard({ user, canEdit, currentUser }) {
  const state = useStore();
  const dispatch = useDispatch();
  const clients = selectClients(state);
  const services = selectServices(state);
  const [qLeft, setQLeft] = useState('');
  const [qRight, setQRight] = useState('');

  const firstName = user.name.split(' ')[0];
  const serviceName = (c) => services.find((s) => s.id === c.serviceId)?.name || c.primaryContact || '';
  const byRevenue = (a, b) => (b.revenue || 0) - (a.revenue || 0) || a.name.localeCompare(b.name);
  const matches = (c, q) => c.name.toLowerCase().includes(q.trim().toLowerCase());

  // Filtered, sorted lists for render + the true (unfiltered) totals for the headers.
  const mine = useMemo(() => clients.filter((c) => c.supervisorId === user.id && matches(c, qRight)).sort(byRevenue), [clients, user.id, qRight]);
  const needs = useMemo(() => clients.filter((c) => !c.supervisorId && matches(c, qLeft)).sort(byRevenue), [clients, qLeft]);
  const others = useMemo(() => clients.filter((c) => c.supervisorId && c.supervisorId !== user.id && matches(c, qLeft)).sort(byRevenue), [clients, user.id, qLeft]);
  const needsTotal = useMemo(() => clients.filter((c) => !c.supervisorId).length, [clients]);
  const othersTotal = useMemo(() => clients.filter((c) => c.supervisorId && c.supervisorId !== user.id).length, [clients, user.id]);
  const mineTotal = useMemo(() => clients.filter((c) => c.supervisorId === user.id).length, [clients, user.id]);
  const poolTotal = needsTotal + othersTotal;

  const setSupervisor = (clientId, supervisorId) => {
    if (!canEdit) return;
    dispatch({
      type: ACTIONS.UPDATE_CLIENT_OPS,
      id: clientId,
      patch: { supervisorId },
      actorName: currentUser?.name,
      summary: 'Account supervisor was updated.',
    });
  };

  const Row = (c, kind) => {
    const mgr = kind === 'other' ? selectUserById(state, c.supervisorId) : null;
    const onClick = !canEdit ? undefined
      : kind === 'mine' ? () => setSupervisor(c.id, null)
        : () => setSupervisor(c.id, user.id);
    return (
      <div
        key={c.id}
        className="sup-row"
        role={canEdit ? 'button' : undefined}
        tabIndex={canEdit ? 0 : undefined}
        onClick={onClick}
        onKeyDown={canEdit ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      >
        <div className="sup-nm">
          <b>{c.name}</b>
          {serviceName(c) && <small>{serviceName(c)}</small>}
        </div>
        {kind === 'need' && <span className="sup-nomgr">Needs manager</span>}
        {kind === 'other' && mgr && (
          <span className="sup-mgr"><Avatar initials={mgr.initials} variant={mgr.avatar} size="sm" />{mgr.name.split(' ')[0]}</span>
        )}
        {canEdit && kind !== 'mine' && <span className="sup-move">Assign</span>}
        {canEdit && kind === 'mine' && <span className="sup-remove">Remove</span>}
      </div>
    );
  };

  return (
    <div className="card detail-card">
      <div className="overview-card-head">
        <h3>Customer assignment</h3>
      </div>
      <p className="text-xs text-muted sup-desc">
        Customers {firstName} supervises as the single point of contact. Accounts with no manager stay at the top of <strong>Current customers</strong>, so none are left uncovered.
      </p>

      {needsTotal > 0
        ? <div className="sup-flag">{needsTotal} customer{needsTotal === 1 ? '' : 's'} still need a manager</div>
        : <div className="sup-flag is-clear">Every customer has a manager</div>}

      <div className="sup-cols">
        {/* LEFT — the full pool, unassigned pinned above the delineation line */}
        <div className="sup-col">
          <div className="sup-col-h"><b>Current customers</b><span className="sup-col-cnt">{poolTotal}</span></div>
          <div className="sup-col-search">
            <input className="input" placeholder="Search customers" value={qLeft} onChange={(e) => setQLeft(e.target.value)} aria-label="Search current customers" />
          </div>
          <div className="sup-subhead need"><span className="sup-dot" />Needs a manager <span className="sup-pill">{needsTotal}</span></div>
          <div className="sup-body">
            {needs.length ? needs.map((c) => Row(c, 'need')) : <div className="sup-empty">{qLeft ? 'No matches' : 'Every customer has a manager.'}</div>}
            <div className="sup-divider">Already assigned to a manager <span className="sup-pill">{othersTotal}</span></div>
            {others.length ? others.map((c) => Row(c, 'other')) : <div className="sup-empty">{qLeft ? 'No matches' : 'None'}</div>}
          </div>
        </div>

        {/* RIGHT — this person's accounts */}
        <div className="sup-col is-target">
          <div className="sup-col-h"><b>Supervised by {firstName}</b><span className="sup-col-cnt">{mineTotal}</span></div>
          <div className="sup-col-search">
            <input className="input" placeholder="Search assigned" value={qRight} onChange={(e) => setQRight(e.target.value)} aria-label="Search assigned customers" />
          </div>
          <div className="sup-subhead done"><span className="sup-dot" />Assigned <span className="sup-pill">{mineTotal}</span></div>
          <div className="sup-body">
            {mine.length
              ? mine.map((c) => Row(c, 'mine'))
              : <div className="sup-empty">{qRight ? 'No matches' : `No customers assigned to ${firstName} yet.${canEdit ? ' Click a customer on the left to add them.' : ''}`}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
