// The pieces the manager's "today" screens share (Shift check-in, the Schedule's Today view,
// Checklists today): the Manager filter kept in the URL, the page head with its "as of" line,
// one gate for the loading / error / offline / no-buildings states, and the status words.
// Every word is a catalog line (UI_RULES §140); the data comes from hooks/useManagerToday.
import { useSearchParams } from 'react-router-dom';
import BackLink from './BackLink';
import EmptyState from './EmptyState';
import FilterSelect from './FilterSelect';
import FormField from './FormField';
import Icon from './Icon';
import { useSelector } from '../store';
import { useAuth } from '../hooks/useAuth';
import { UNSCOPED_ROLES } from '../lib/timeRules';
import { SUPERVISOR_ROLES, compareUsersByName } from '../lib/roles';
import { TEAM, isOpsManager, teamMemberIds } from '../lib/teamScope';
import { teamPickLead } from '../lib/managerFilter';
import { NO_MANAGER, VISIT_STATUS } from '../lib/managerToday';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';

const selUsers = (s) => s.users;

// The Manager filter's value, kept in the URL (`?mgr=`, the Approvals screen's parameter):
// '' = All managers (an Operations Manager's whole team), 'team' = the whole team too, 'none' =
// buildings with no manager, else a manager's id. Written with `replace`, so a filter change does
// not stack history the Back button must walk through.
// `teamPick` (the today pages — S131 Wave 2): the owner or an admin arriving from the Operations
// view's tiles with `?mgr=team&om=<an OM>` reads THAT Operations Manager's team, the figures the tile
// counted (lib/managerFilter teamPickLead — lib/teamScope teamLeadFor's rule): the value is `team`
// and the third item that OM's id, for the today engine's `opsManagerId`. Picking anything else drops
// the `om`. The Home itself reads without it: its own `om` is the Operations view's, not a filter.
export function useMgrParam({ teamPick = false } = {}) {
  const [params, setParams] = useSearchParams();
  const { currentUser } = useAuth();
  const users = useSelector(selUsers);
  const raw = params.get('mgr') || '';
  const lead = teamPick ? teamPickLead({ viewer: currentUser, users, value: raw, omParam: params.get('om') }) : null;
  // `team` (S131) and '' are otherwise the same pick — the whole team for an Operations Manager,
  // every building for the owner — so the filter shows its first row for either.
  const value = lead ? TEAM : (raw === TEAM ? '' : raw);
  const set = (next) => setParams((prev) => {
    const p = new URLSearchParams(prev);
    if (next) p.set('mgr', next); else p.delete('mgr');
    if (teamPick && next !== TEAM) p.delete('om');
    return p;
  }, { replace: true });
  return [value, set, lead ? lead.id : null];
}

// Shown to the owner and admins over every manager, and to an OPERATIONS MANAGER over their team
// (S131: "All my team" and each member — the scope the hook reads for them). An account manager
// always sees their own buildings, so the control would offer them nothing (the hook ignores it).
// `opsManagerId` (useMgrParam's third item): the owner's pick of an Operations Manager's whole team,
// shown as "{name}'s team" so the filter names the figures on screen.
export function ManagerScopeFilter({ value, onChange, opsManagerId = null }) {
  const t = useT();
  const { currentUser } = useAuth();
  const users = useSelector(selUsers);
  const om = isOpsManager(currentUser);
  if (!UNSCOPED_ROLES.includes(currentUser?.role) && !om) return null;
  const byId = new Map((users || []).filter(Boolean).map((u) => [u.id, u]));
  const lead = !om && opsManagerId ? byId.get(opsManagerId) || null : null;
  const managers = om
    ? teamMemberIds(users, currentUser.id).map((id) => byId.get(id)).filter(Boolean)
    : (users || []).filter((u) => u && u.status === 'active' && SUPERVISOR_ROLES.includes(u.role)).slice().sort(compareUsersByName);
  const options = om
    ? [
      { value: '', label: t('mgrTeam.allMyTeam') },
      ...managers.map((m) => ({ value: m.id, label: m.id === currentUser?.id ? t('mgrToday.me', { name: m.name }) : m.name })),
    ]
    : [
      { value: '', label: t('mgrToday.allManagers') },
      ...(lead ? [{ value: TEAM, label: t('mgrTeam.teamOf', { name: lead.name || '—' }) }] : []),
      ...managers.map((m) => ({ value: m.id, label: m.id === currentUser?.id ? t('mgrToday.me', { name: m.name }) : m.name })),
      { value: NO_MANAGER, label: t('mgrToday.noManager') },
    ];
  return (
    <div className="filter-bar mgt-filters">
      <FormField label={t('mgrToday.manager')}>
        <FilterSelect ariaLabel={t('mgrToday.manager')} value={value} onChange={onChange} options={options} />
      </FormField>
    </div>
  );
}

// "Carlos Mendez" → "Carlos M." (Matt's boards). A person's own name, not words: never translated.
export function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

// A visit's status as a Badge variant + its words (a map of literal keys, UI_RULES §140).
const STATUS_BADGE = {
  [VISIT_STATUS.DONE]: ['green', 'mgrToday.status.done'],
  [VISIT_STATUS.IN_PROGRESS]: ['blue', 'mgrToday.status.inProgress'],
  [VISIT_STATUS.LATE]: ['amber', 'mgrToday.status.late'],
  [VISIT_STATUS.NO_CHECK_IN]: ['red', 'mgrToday.status.noCheckIn'],
  [VISIT_STATUS.UPCOMING]: ['slate', 'mgrToday.status.upcoming'],
  [VISIT_STATUS.CALLED_OUT]: ['slate', 'mgrToday.status.calledOut'],
};
export function visitBadge(t, visit) {
  if (visit?.status === VISIT_STATUS.CALLED_OUT && visit.offKind === 'planned') return ['slate', t('mgrToday.status.timeOff')];
  const [variant, key] = STATUS_BADGE[visit?.status] || STATUS_BADGE[VISIT_STATUS.UPCOMING];
  return [variant, t(key)];
}

// A visit's customer, or the plain words for one with none on record.
export const visitLabel = (t, v) => v?.customerLabel || t('mgrToday.noCustomer');

// The crew in one line: "Carlos M." or "Carlos M. and team" (plan S3: nothing marks a lead,
// so the first cleaner on the visit is named).
export function crewLine(t, visit) {
  const people = visit?.crew?.length ? visit.crew : (visit?.calledOut || []);
  if (!people.length) return t('mgrToday.noCrew');
  const first = shortName(people[0].name) || t('mgrToday.noCrew');
  return people.length > 1 ? t('mgrToday.andTeam', { name: first }) : first;
}

// The head every today screen draws: the way back (Matt's boards: "Back to Dashboard"), the
// title, and one quiet line under it.
export function TodayHead({ title, sub, children }) {
  const t = useT();
  return (
    <div className="mgt-head">
      <BackLink to="/" label={t('nav.dashboard')} />
      <div className="page-head mgt-page-head">
        <div className="page-head-text">
          <h1>{title}</h1>
          {sub && <p className="page-sub text-muted">{sub}</p>}
        </div>
        {children && <div className="page-head-actions">{children}</div>}
      </div>
    </div>
  );
}

// The states before there is anything to draw, then the notices over a stale answer (a failed
// refresh, no connection), then the page's own content. `today` is useManagerToday()'s return;
// `children` is a FUNCTION, called only once there are visits to draw (so the page's content
// never reads the counts before they exist).
export function TodayGate({ today, children }) {
  const t = useT();
  if (today.refused) {
    return <EmptyState icon={<Icon name="lock" size={28} />} title={t('noAccess.title')} message={t('noAccess.body')} />;
  }
  if (today.buildings === 0 && !today.loading) {
    return <EmptyState icon={<Icon name="building" size={28} />} title={t('mgrToday.noBuildings')} message={t('mgrToday.noBuildingsHint')} />;
  }
  if (!today.visits) {
    if (today.loading) return <p className="mgt-loading text-muted" role="status">{t('mgrToday.loading')}</p>;
    if (today.offline) {
      return <EmptyState icon={<Icon name="warning" size={28} />} title={t('mgrToday.offlineTitle')} message={t('mgrToday.offline')} />;
    }
    return (
      <EmptyState
        icon={<Icon name="warning" size={28} />}
        title={t('mgrToday.loadFailed')}
        message={today.error ? errorText(t, today.error, 'mgrToday.loadFailed') : null}
        action={<button type="button" className="btn btn-primary" onClick={() => today.retry()}>{t('mgrToday.tryAgain')}</button>}
      />
    );
  }
  return (
    <>
      {today.offline ? (
        <p className="callout callout-warning text-sm mgt-notice" role="status">{t('mgrToday.offlineStale', { time: today.asOf })}</p>
      ) : today.error ? (
        <div className="callout callout-warning text-sm mgt-notice" role="status">
          <span>{t('mgrToday.refreshFailed', { time: today.asOf })}</span>
          <button type="button" className="btn btn-secondary" onClick={() => today.retry()}>{t('mgrToday.tryAgain')}</button>
        </div>
      ) : null}
      {children()}
    </>
  );
}
