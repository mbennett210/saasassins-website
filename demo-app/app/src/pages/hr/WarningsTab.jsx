// HR › Warnings (Matt's ask, HR-1..HR-5, on his own form — HR-1 b). Every written warning:
// who, the level, the reasons ticked on his form, the supervisor, when, and whether the
// employee has signed. Filters in the URL (Employee, Supervisor, Status, Level, Reason —
// searchable FilterSelects in a .filter-bar), twenty rows a page, a row opens the warning
// (`?w=<id>`), and "New warning" opens his form.
//
// The list reads /api/hr-warnings (its own table, never the shared record) through
// lib/hrWarningsApi, which runs a localStorage stub on the login-free demo.
//
// Words: the catalog (UI_RULES §140) — this tab is written on it from its first line even
// though the rest of HR is not converted yet.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSelector } from '../../store';
import { useAuth } from '../../hooks/useAuth';
import { usePermission } from '../../hooks/usePermission';
import { usePagedRows } from '../../hooks/usePagedRows';
import { useT } from '../../i18n/react';
import { errorText } from '../../i18n/errors';
import { fmtDate } from '../../lib/dates';
import { compareUsersByName } from '../../lib/roles';
import {
  WARNING_LEVELS, WARNING_LEVEL_KEYS, WARNING_LEVEL_VARIANTS, WARNING_STATUSES, WARNING_STATUS_KEYS,
  WARNING_STATUS_VARIANTS, WARNING_REASONS, WARNING_REASON_KEYS,
} from '../../lib/hrWarnings';
import * as hrWarningsApi from '../../lib/hrWarningsApi';
import Badge from '../../components/Badge';
import FormField from '../../components/FormField';
import FilterSelect from '../../components/FilterSelect';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import ListPager from '../../components/ListPager';
import Modal from '../../components/Modal';
import HrWarningDetail, { reasonsText } from '../../components/HrWarningDetail';
import HrWarningForm from '../../components/HrWarningForm';
import { useToast } from '../../components/Toast';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export default function WarningsTab() {
  const t = useT();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canEdit = usePermission('hr.edit');
  const canVoid = currentUser?.role === 'owner';
  const users = useSelector(useCallback((s) => s.users || [], []));

  const [params, setParams] = useSearchParams();
  const setParam = useCallback((patch) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
    return next;
  }, { replace: true }), [setParams]);
  const empFilter = params.get('wemp') || '';
  const supFilter = params.get('wsup') || '';
  const statusFilter = WARNING_STATUSES.includes(params.get('wstatus')) ? params.get('wstatus') : '';
  const levelFilter = WARNING_LEVELS.includes(params.get('wlevel')) ? params.get('wlevel') : '';
  // A warning matches a reason when that reason is one of the ones ticked on it.
  const reasonFilter = WARNING_REASONS.includes(params.get('wreason')) ? params.get('wreason') : '';
  const openId = params.get('w') || '';

  const [data, setData] = useState({ warnings: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);
  const [signNowId, setSignNowId] = useState(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await hrWarningsApi.listWarnings()); setError(null); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const warnings = data.warnings || [];
  const rows = useMemo(() => warnings
    .filter((w) => !empFilter || w.employeeUserId === empFilter)
    .filter((w) => !supFilter || w.supervisorUserId === supFilter)
    .filter((w) => !statusFilter || w.status === statusFilter)
    .filter((w) => !levelFilter || w.level === levelFilter)
    .filter((w) => !reasonFilter || (w.reasons || []).includes(reasonFilter)),
  [warnings, empFilter, supFilter, statusFilter, levelFilter, reasonFilter]);
  const pager = usePagedRows(rows, { param: 'wpage', resetKey: `${empFilter}|${supFilter}|${statusFilter}|${levelFilter}|${reasonFilter}` });

  // The pickers offer the people who HAVE warnings (live names first, a departed person by
  // the name stamped on their warning), so a filter can never come up empty by construction.
  const nameOf = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);
  const peopleOptions = (idKey, nameKey) => {
    const seen = new Map();
    for (const w of warnings) if (w[idKey] && !seen.has(w[idKey])) seen.set(w[idKey], nameOf[w[idKey]] || w[nameKey] || '—');
    return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  };
  const activeUsers = useMemo(() => users.filter((u) => u.status === 'active').slice().sort(compareUsersByName), [users]);

  return (
    <div className="hr-view">
      <div className="hr-toolbar">
        <p className="text-sm text-muted" style={{ margin: 0 }}>{t('hrWarn.list.lead')}</p>
        {canEdit && <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>{t('hrWarn.new.button')}</button>}
      </div>

      <div className="filter-bar">
        <FormField label={t('hrWarn.field.employee')}>
          <FilterSelect ariaLabel={t('hrWarn.field.employee')} value={empFilter}
            options={[{ value: '', label: t('hrWarn.filter.allEmployees') }, ...peopleOptions('employeeUserId', 'employeeName')]}
            onChange={(v) => setParam({ wemp: v, wpage: null })} />
        </FormField>
        <FormField label={t('hrWarn.field.supervisor')}>
          <FilterSelect ariaLabel={t('hrWarn.field.supervisor')} value={supFilter}
            options={[{ value: '', label: t('hrWarn.filter.allSupervisors') }, ...peopleOptions('supervisorUserId', 'supervisorName')]}
            onChange={(v) => setParam({ wsup: v, wpage: null })} />
        </FormField>
        <FormField label={t('hrWarn.field.status')}>
          <FilterSelect ariaLabel={t('hrWarn.field.status')} value={statusFilter}
            options={[{ value: '', label: t('hrWarn.filter.allStatuses') }, ...WARNING_STATUSES.map((s) => ({ value: s, label: t(WARNING_STATUS_KEYS[s]) }))]}
            onChange={(v) => setParam({ wstatus: v, wpage: null })} />
        </FormField>
        <FormField label={t('hrWarn.field.level')}>
          <FilterSelect ariaLabel={t('hrWarn.field.level')} value={levelFilter}
            options={[{ value: '', label: t('hrWarn.filter.allLevels') }, ...WARNING_LEVELS.map((l) => ({ value: l, label: t(WARNING_LEVEL_KEYS[l]) }))]}
            onChange={(v) => setParam({ wlevel: v, wpage: null })} />
        </FormField>
        <FormField label={t('hrWarn.field.reasons')}>
          <FilterSelect ariaLabel={t('hrWarn.field.reasons')} value={reasonFilter}
            options={[{ value: '', label: t('hrWarn.filter.allReasons') }, ...WARNING_REASONS.map((r) => ({ value: r, label: t(WARNING_REASON_KEYS[r]) }))]}
            onChange={(v) => setParam({ wreason: v, wpage: null })} />
        </FormField>
      </div>

      {loading ? (
        <div className="hrw-loading">{t('hrWarn.loading')}</div>
      ) : error ? (
        <div className="callout callout-warning">
          {errorText(t, error, 'hrWarn.loadFailed')} <button type="button" className="linklike" onClick={reload}>{t('common.retry')}</button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="warning" size={28} />}
          title={warnings.length ? t('hrWarn.empty.filteredTitle') : t('hrWarn.empty.title')}
          message={warnings.length ? t('hrWarn.empty.filteredMessage') : t('hrWarn.empty.message')}
        />
      ) : (
        <div className="table-wrap mobile-stack">
          <table>
            <thead>
              <tr>
                <th>{t('hrWarn.field.employee')}</th>
                <th>{t('hrWarn.field.issued')}</th>
                <th>{t('hrWarn.field.level')}</th>
                <th>{t('hrWarn.field.reasons')}</th>
                <th>{t('hrWarn.field.supervisor')}</th>
                <th>{t('hrWarn.field.status')}</th>
              </tr>
            </thead>
            <tbody>
              {pager.pageRows.map((w) => {
                const who = nameOf[w.employeeUserId] || w.employeeName || '—';
                return (
                  <tr key={w.id} className="hrw-row" onClick={() => setParam({ w: w.id })}>
                    <td className="cell-primary"><span className="truncate" title={who}>{who}</span></td>
                    <td data-label={t('hrWarn.field.issued')}>{day(w.issuedOn)}</td>
                    <td data-label={t('hrWarn.field.level')}><Badge variant={WARNING_LEVEL_VARIANTS[w.level] || 'slate'}>{t(WARNING_LEVEL_KEYS[w.level] || 'hrWarn.level.first')}</Badge></td>
                    <td data-label={t('hrWarn.field.reasons')}><span className="truncate" title={reasonsText(t, w)}>{reasonsText(t, w)}</span></td>
                    <td data-label={t('hrWarn.field.supervisor')}>{nameOf[w.supervisorUserId] || w.supervisorName || '—'}</td>
                    <td data-label={t('hrWarn.field.status')}><Badge variant={WARNING_STATUS_VARIANTS[w.status] || 'slate'}>{t(WARNING_STATUS_KEYS[w.status] || 'hrWarn.status.awaiting')}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ListPager pager={pager} noun={t('hrWarn.pagerNoun')} />
        </div>
      )}

      <Modal open={!!openId} onClose={() => { setParam({ w: null }); setSignNowId(null); }} title={t('hrWarn.detail.title')} size="lg">
        {openId && (
          <HrWarningDetail
            key={openId}
            warningId={openId}
            mode="office"
            canEdit={canEdit}
            canVoid={canVoid}
            users={users}
            currentUserId={currentUser?.id || null}
            initialStep={signNowId === openId ? 'sign' : null}
            onChanged={reload}
          />
        )}
      </Modal>

      <HrWarningForm
        open={creating}
        onClose={() => setCreating(false)}
        users={activeUsers}
        currentUserId={currentUser?.id || null}
        onIssued={(warning, { signInPerson }) => {
          setCreating(false);
          toast.success(t('hrWarn.form.issued'));
          reload();
          if (warning) { if (signInPerson) setSignNowId(warning.id); setParam({ w: warning.id }); }
        }}
      />
    </div>
  );
}
