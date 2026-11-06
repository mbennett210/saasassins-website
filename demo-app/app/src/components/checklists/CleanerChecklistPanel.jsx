import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import Avatar from '../Avatar';
import Badge from '../Badge';
import EmptyState from '../EmptyState';
import Icon from '../Icon';
import ListPager from '../ListPager';
import { usePagedRows } from '../../hooks/usePagedRows';
import { useStore } from '../../store';
import { selectJobsForClient } from '../../store/selectors';
import { SCHEDULED_JOB_STATUSES } from '../../lib/checklistAssignments';
import { CLOCK_RULE_KEYS, CLOCK_RULE_LABEL_KEYS, isClockRuleOff } from '../../lib/clockRules';
import { useT } from '../../i18n/react';

// ONE cleaner, across every customer they work — the other half of the Assignments rail
// (UI_RULES §134). The customer view answers "who holds what here"; this answers "what
// does this person hold, everywhere", which is the question behind "she says she never
// gets a checklist at the Tuesday building".
//
// The same cleaner can hold a DIFFERENT checklist at each customer (R2), so the row is
// (customer → their checklist there), never a single answer for the person.
//
// The clock rules are shown here because they are the other thing the office changes about
// a cleaner, and a rule that is off is one of the summary's four problems. Turning one
// back on writes through the SAME rule and path as the member's own Time tab
// (pages/settings/TeamDetail.jsx): `nextClockRules` + UPDATE_USER, offered only to an
// OFFICE role holding `time.clockRules`. The server enforces it too (orgStateGuard), and a
// refused save drops the whole pending batch — so a control nobody can save must not exist
// (UI_RULES §118).
export default function CleanerChecklistPanel({
  user,
  canEditClockRules = false,
  today = null,            // Map(customerId -> Map(cleanerId -> { done, total, complete }))
  templateName = null,     // (templateId) => string
  onSelectCustomer = null,
  onTurnRuleOn = null,     // (userId, ruleKey) => void
  referrer = null,         // useFromHere() state for the links out of this panel
}) {
  const t = useT();
  const state = useStore();

  // Every customer this cleaner works: an upcoming / in-progress clean there, OR a
  // checklist still assigned to them there (that second case is a STRAY, and hiding it is
  // exactly what the old per-customer card did).
  const places = useMemo(() => {
    if (!user?.id) return [];
    return (state.clients || []).map((c) => {
      const scheduled = selectJobsForClient(state, c.id)
        .some((j) => SCHEDULED_JOB_STATUSES.includes(j.status) && (j.crewIds || []).includes(user.id));
      const templateId = c.crewChecklists?.[user.id] || null;
      if (!scheduled && !templateId) return null;
      return { client: c, scheduled, templateId };
    }).filter(Boolean).sort((a, b) => (a.client.name || '').localeCompare(b.client.name || ''));
  }, [state, user]);

  const pager = usePagedRows(places, { param: 'cpage', resetKey: user?.id });

  if (!user) return null;

  const badgeFor = (clientId) => {
    const day = today?.get(clientId)?.get(user.id);
    if (!day) return null;
    if (day.complete) return <Badge variant="green">{t('cka.doneToday')}</Badge>;
    return <Badge variant="amber">{day.total > 0 ? t('cka.todayProgress', { done: day.done, total: day.total }) : t('cka.notStartedToday')}</Badge>;
  };

  return (
    <div className="cka-cleaner">
      <div className="cka-dhead">
        <div className="cka-dhead-main cka-dhead-who">
          <Avatar user={user} size="md" />
          <div>
            <span className="cka-label">{t('cka.cleaner')}</span>
            <h3 className="cka-dtitle">{user.name}</h3>
            <p className="text-sm text-muted cka-dsub">
              {t('cka.customerCount', { count: places.length })}
            </p>
          </div>
        </div>
        <div className="cka-dhead-actions">
          <Link className="btn btn-outline" to={`/settings/team/${user.id}?tab=time`} state={referrer || undefined}>{t('cka.openTimeTab')}</Link>
        </div>
      </div>

      <div className="cka-sect">
        <span className="cka-label cka-sect-label">{t('cka.whereTheyWork')}</span>
        <div className="table-wrap mobile-stack">
          <table>
            <thead><tr><th>{t('cka.head.customer')}</th><th>{t('cka.theirChecklist')}</th><th>{t('cka.today')}</th><th></th></tr></thead>
            <tbody>
              {places.length === 0 ? (
                <tr className="stack-plain"><td colSpan={4}><EmptyState icon={<Icon name="clients" size={28} />} title={t('cka.notScheduledAnywhere')} message={t('cka.notScheduledAnywhereHint')} /></td></tr>
              ) : pager.pageRows.map(({ client, scheduled, templateId }) => (
                <tr key={client.id}>
                  <td className="cell-primary"><span className="truncate" title={client.name}>{client.name}</span></td>
                  <td data-label={t('cka.theirChecklist')}>
                    {templateId
                      ? <Badge variant="blue">{templateName ? templateName(templateId) : t('cka.assignedChecklist')}</Badge>
                      : <Badge variant="slate">{t('cka.noChecklist')}</Badge>}
                  </td>
                  <td data-label={t('cka.today')}>
                    {!scheduled && <Badge variant="amber">{t('cka.notOnUpcoming')}</Badge>}
                    {badgeFor(client.id) || (scheduled ? <span className="text-muted text-xs">—</span> : null)}
                  </td>
                  <td className="cell-actions">
                    {onSelectCustomer && (
                      <button type="button" className="btn btn-link" onClick={() => onSelectCustomer(client.id)}>{t('cka.open')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <ListPager pager={pager} noun={t('cka.noun.customers')} />
        </div>
      </div>

      <div className="cka-sect">
        <span className="cka-label cka-sect-label">{t('cka.clockRules')}</span>
        {[CLOCK_RULE_KEYS.checklist, CLOCK_RULE_KEYS.geofence].map((key) => {
          const off = isClockRuleOff(user, key);
          return (
            <div className="cka-row" key={key}>
              <span className="cka-row-grow">
                <span className="cka-row-title">{t(CLOCK_RULE_LABEL_KEYS[key])}</span>
                <span className="text-xs text-muted cka-row-sub">
                  {off ? t('cka.ruleOffNote') : t('cka.ruleOnNote')}
                </span>
              </span>
              {off ? <Badge variant="amber">{t('cka.off')}</Badge> : <Badge variant="green">{t('cka.on')}</Badge>}
              {off && canEditClockRules && onTurnRuleOn && (
                <button type="button" className="btn btn-link" onClick={() => onTurnRuleOn(user.id, key)}>{t('cka.turnBackOn')}</button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
