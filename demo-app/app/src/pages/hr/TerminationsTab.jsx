// HR › Terminations (Super Clippy's idea #513 from Clean Corner's queue: Matt's termination form,
// set up like Warnings and Incidents). Every termination filed: the employee, the Day of
// Termination, the Direct Account Manager, the reasons ticked on his form, and where the login
// stands (Scheduled, Turning off, Login off, Voided). Filters in the URL (Login, Employee —
// searchable FilterSelects in a .filter-bar), twenty rows a page, a row opens the termination
// (`?t=<id>`), and "New termination" opens his form for someone the server will let file one
// (`hr.edit` AND `settings.team.edit`, Daniel's pick 2026-11-05).
//
// The list reads /api/hr-terminations (its own table, never the shared record) through
// lib/hrTerminationsApi, which runs a localStorage stub on the login-free demo.
//
// Words: the catalog (UI_RULES §140).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSelector } from '../../store';
import { useAuth } from '../../hooks/useAuth';
import { usePermission } from '../../hooks/usePermission';
import { usePagedRows } from '../../hooks/usePagedRows';
import { useT } from '../../i18n/react';
import { errorText } from '../../i18n/errors';
import { fmtDate, todayKey } from '../../lib/dates';
import {
  TERMINATION_FORM_KEYS, TERMINATION_STATUS, TERMINATION_STANDINGS, TERMINATION_STANDING_KEYS, TERMINATION_STANDING_VARIANTS,
  terminationStanding, reasonsText,
} from '../../lib/hrTerminations';
import * as hrTerminationsApi from '../../lib/hrTerminationsApi';
import { IDENTITY } from '../../brand/identity.generated';
import Badge from '../../components/Badge';
import FormField from '../../components/FormField';
import FilterSelect from '../../components/FilterSelect';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import ListPager from '../../components/ListPager';
import Modal from '../../components/Modal';
import HrTerminationDetail from '../../components/HrTerminationDetail';
import HrTerminationForm from '../../components/HrTerminationForm';
import { filedToast, useMemberStatusSetter } from '../../components/EmployeeTerminationCard';
import { useToast } from '../../components/Toast';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export default function TerminationsTab() {
  const t = useT();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canHr = usePermission('hr.edit');
  const canTeam = usePermission('settings.team.edit');
  const canFile = canHr && canTeam;
  const canVoid = currentUser?.role === 'owner';
  const users = useSelector(useCallback((s) => s.users || [], []));
  const setMemberStatus = useMemberStatusSetter();
  const today = todayKey();

  const [params, setParams] = useSearchParams();
  const setParam = useCallback((patch) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
    return next;
  }, { replace: true }), [setParams]);
  const standingFilter = TERMINATION_STANDINGS.includes(params.get('tstatus')) ? params.get('tstatus') : '';
  const empFilter = params.get('temp') || '';
  const openId = params.get('t') || '';

  const [data, setData] = useState({ terminations: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await hrTerminationsApi.listTerminations()); setError(null); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const terminations = data.terminations || [];
  const rows = useMemo(() => terminations
    .filter((r) => !standingFilter || terminationStanding(r, today) === standingFilter)
    .filter((r) => !empFilter || r.employeeUserId === empFilter),
  [terminations, standingFilter, empFilter, today]);
  const pager = usePagedRows(rows, { param: 'tpage', resetKey: `${standingFilter}|${empFilter}` });

  // The employee picker offers only who the terminations HOLD (a live name first, a departed
  // employee by the name stamped on the form), so the filter can never come up empty by construction.
  const nameOf = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);
  const employeeOptions = useMemo(() => {
    const seen = new Map();
    for (const r of terminations) {
      if (r.employeeUserId && !seen.has(r.employeeUserId)) seen.set(r.employeeUserId, nameOf[r.employeeUserId] || r.employeeName || '—');
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [terminations, nameOf]);
  const terminatedIds = useMemo(() => terminations.filter((r) => r.status === TERMINATION_STATUS.filed).map((r) => r.employeeUserId), [terminations]);

  return (
    <div className="hr-view">
      <div className="hr-toolbar">
        <p className="text-sm text-muted" style={{ margin: 0 }}>{t('hrTerm.list.lead', { brand: IDENTITY.product.name })}</p>
        {canFile && <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>{t('hrTerm.new.button')}</button>}
      </div>

      <div className="filter-bar">
        <FormField label={t('hrTerm.col.login')}>
          <FilterSelect ariaLabel={t('hrTerm.col.login')} value={standingFilter}
            options={[{ value: '', label: t('hrTerm.filter.allStatuses') }, ...TERMINATION_STANDINGS.map((s) => ({ value: s, label: t(TERMINATION_STANDING_KEYS[s]) }))]}
            onChange={(v) => setParam({ tstatus: v, tpage: null })} />
        </FormField>
        <FormField label={t('hrTerm.col.employee')}>
          <FilterSelect ariaLabel={t('hrTerm.col.employee')} value={empFilter}
            options={[{ value: '', label: t('hrTerm.filter.allEmployees') }, ...employeeOptions]}
            onChange={(v) => setParam({ temp: v, tpage: null })} />
        </FormField>
      </div>

      {loading ? (
        <div className="hrw-loading">{t('hrTerm.loading')}</div>
      ) : error ? (
        <div className="callout callout-warning">
          {errorText(t, error, 'hrTerm.loadFailed')} <button type="button" className="linklike" onClick={reload}>{t('common.retry')}</button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="user" size={28} />}
          title={terminations.length ? t('hrTerm.empty.filteredTitle') : t('hrTerm.empty.title')}
          message={terminations.length ? t('hrTerm.empty.filteredMessage') : t('hrTerm.empty.message')}
        />
      ) : (
        <div className="table-wrap mobile-stack">
          <table>
            <thead>
              <tr>
                <th>{t('hrTerm.col.employee')}</th>
                <th>{t(TERMINATION_FORM_KEYS.date)}</th>
                <th>{t(TERMINATION_FORM_KEYS.manager)}</th>
                <th>{t('hrTerm.col.reasons')}</th>
                <th>{t('hrTerm.col.login')}</th>
              </tr>
            </thead>
            <tbody>
              {pager.pageRows.map((r) => {
                const reasons = reasonsText(t, r);
                const standing = terminationStanding(r, today);
                return (
                  <tr key={r.id} className="hrw-row" onClick={() => setParam({ t: r.id })}>
                    <td className="cell-primary">{nameOf[r.employeeUserId] || r.employeeName || '—'}</td>
                    <td data-label={t(TERMINATION_FORM_KEYS.date)}>{day(r.terminationDate)}</td>
                    <td data-label={t(TERMINATION_FORM_KEYS.manager)}>{r.managerName || '—'}</td>
                    <td data-label={t('hrTerm.col.reasons')}><span className="truncate hri-clamp" title={reasons}>{reasons || '—'}</span></td>
                    <td data-label={t('hrTerm.col.login')}><Badge variant={TERMINATION_STANDING_VARIANTS[standing] || 'slate'}>{t(TERMINATION_STANDING_KEYS[standing] || 'hrTerm.status.scheduled')}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ListPager pager={pager} noun={t('hrTerm.pagerNoun')} />
        </div>
      )}

      <Modal open={!!openId} onClose={() => setParam({ t: null })} title={t(TERMINATION_FORM_KEYS.title)} size="lg">
        {openId && (
          <HrTerminationDetail
            key={openId}
            terminationId={openId}
            canVoid={canVoid}
            users={users}
            currentUserId={currentUser?.id || null}
            onChanged={reload}
            setMemberStatus={setMemberStatus}
          />
        )}
      </Modal>

      <HrTerminationForm
        open={creating}
        onClose={() => setCreating(false)}
        users={users}
        currentUser={currentUser}
        terminatedIds={terminatedIds}
        setMemberStatus={setMemberStatus}
        onFiled={(termination, out) => {
          setCreating(false);
          filedToast(t, toast, termination, out);
          reload();
          if (termination) setParam({ t: termination.id });
        }}
      />
    </div>
  );
}
