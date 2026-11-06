// HR › Incidents (task #258 from Clean Corner's queue: Matt's "ACCIDENT / INCIDENT REPORT", set
// up like Warnings). Every report filed: its case number, the incident's day, the property, the
// types ticked on his form, the people involved, and whether the office has reviewed it. Filters
// in the URL (Status, Type, Property, Employee — searchable FilterSelects in a .filter-bar),
// twenty rows a page, a row opens the report (`?i=<id>`), and "New incident report" opens his form.
//
// The list reads /api/hr-incidents (its own table, never the shared record) through
// lib/hrIncidentsApi, which runs a localStorage stub on the login-free demo.
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
import { fmtDate } from '../../lib/dates';
import {
  INCIDENT_FORM_KEYS, INCIDENT_STATUSES, INCIDENT_STATUS_KEYS, INCIDENT_STATUS_VARIANTS, INCIDENT_TYPES,
  INCIDENT_TYPE_KEYS, incidentCaseNo, typesText, peopleText,
} from '../../lib/hrIncidents';
import * as hrIncidentsApi from '../../lib/hrIncidentsApi';
import Badge from '../../components/Badge';
import FormField from '../../components/FormField';
import FilterSelect from '../../components/FilterSelect';
import EmptyState from '../../components/EmptyState';
import Icon from '../../components/Icon';
import ListPager from '../../components/ListPager';
import Modal from '../../components/Modal';
import HrIncidentDetail from '../../components/HrIncidentDetail';
import HrIncidentForm from '../../components/HrIncidentForm';
import { useToast } from '../../components/Toast';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export default function IncidentsTab() {
  const t = useT();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canEdit = usePermission('hr.edit');
  const canVoid = currentUser?.role === 'owner';
  const users = useSelector(useCallback((s) => s.users || [], []));
  const clients = useSelector(useCallback((s) => s.clients || [], []));

  const [params, setParams] = useSearchParams();
  const setParam = useCallback((patch) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
    return next;
  }, { replace: true }), [setParams]);
  const statusFilter = INCIDENT_STATUSES.includes(params.get('istatus')) ? params.get('istatus') : '';
  // A report matches a type when that type is one of the ones ticked on it.
  const typeFilter = INCIDENT_TYPES.includes(params.get('itype')) ? params.get('itype') : '';
  const propFilter = params.get('iprop') || '';
  const empFilter = params.get('iemp') || '';
  const openId = params.get('i') || '';

  const [data, setData] = useState({ incidents: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try { setData(await hrIncidentsApi.listIncidents()); setError(null); }
    catch (e) { setError(e); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const incidents = data.incidents || [];
  const rows = useMemo(() => incidents
    .filter((r) => !statusFilter || r.status === statusFilter)
    .filter((r) => !typeFilter || (r.types || []).includes(typeFilter))
    .filter((r) => !propFilter || r.propertyName === propFilter)
    .filter((r) => !empFilter || (r.involvedUserIds || []).includes(empFilter)),
  [incidents, statusFilter, typeFilter, propFilter, empFilter]);
  const pager = usePagedRows(rows, { param: 'ipage', resetKey: `${statusFilter}|${typeFilter}|${propFilter}|${empFilter}` });

  // The pickers offer only what the reports HOLD (a live name first, a departed employee by the
  // name stamped on the report), so a filter can never come up empty by construction.
  const nameOf = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.name])), [users]);
  const propertyOptions = useMemo(() => [...new Set(incidents.map((r) => r.propertyName).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b)).map((p) => ({ value: p, label: p })), [incidents]);
  const employeeOptions = useMemo(() => {
    const seen = new Map();
    for (const r of incidents) {
      for (const p of r.people || []) {
        if (p && p.userId && !seen.has(p.userId)) seen.set(p.userId, nameOf[p.userId] || p.name || '—');
      }
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [incidents, nameOf]);

  return (
    <div className="hr-view">
      <div className="hr-toolbar">
        <p className="text-sm text-muted" style={{ margin: 0 }}>{t('hrInc.list.lead')}</p>
        {canEdit && <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>{t('hrInc.new.button')}</button>}
      </div>

      <div className="filter-bar">
        <FormField label={t('hrInc.col.status')}>
          <FilterSelect ariaLabel={t('hrInc.col.status')} value={statusFilter}
            options={[{ value: '', label: t('hrInc.filter.allStatuses') }, ...INCIDENT_STATUSES.map((s) => ({ value: s, label: t(INCIDENT_STATUS_KEYS[s]) }))]}
            onChange={(v) => setParam({ istatus: v, ipage: null })} />
        </FormField>
        <FormField label={t('hrInc.col.type')}>
          <FilterSelect ariaLabel={t('hrInc.col.type')} value={typeFilter}
            options={[{ value: '', label: t('hrInc.filter.allTypes') }, ...INCIDENT_TYPES.map((x) => ({ value: x, label: t(INCIDENT_TYPE_KEYS[x]) }))]}
            onChange={(v) => setParam({ itype: v, ipage: null })} />
        </FormField>
        <FormField label={t('hrInc.col.property')}>
          <FilterSelect ariaLabel={t('hrInc.col.property')} value={propFilter}
            options={[{ value: '', label: t('hrInc.filter.allProperties') }, ...propertyOptions]}
            onChange={(v) => setParam({ iprop: v, ipage: null })} />
        </FormField>
        <FormField label={t('hrInc.col.employee')}>
          <FilterSelect ariaLabel={t('hrInc.col.employee')} value={empFilter}
            options={[{ value: '', label: t('hrInc.filter.allEmployees') }, ...employeeOptions]}
            onChange={(v) => setParam({ iemp: v, ipage: null })} />
        </FormField>
      </div>

      {loading ? (
        <div className="hrw-loading">{t('hrInc.loading')}</div>
      ) : error ? (
        <div className="callout callout-warning">
          {errorText(t, error, 'hrInc.loadFailed')} <button type="button" className="linklike" onClick={reload}>{t('common.retry')}</button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Icon name="shield" size={28} />}
          title={incidents.length ? t('hrInc.empty.filteredTitle') : t('hrInc.empty.title')}
          message={incidents.length ? t('hrInc.empty.filteredMessage') : t('hrInc.empty.message')}
        />
      ) : (
        <div className="table-wrap mobile-stack">
          <table>
            <thead>
              <tr>
                <th>{t('hrInc.col.caseNo')}</th>
                <th>{t(INCIDENT_FORM_KEYS.incidentDate)}</th>
                <th>{t('hrInc.col.property')}</th>
                <th>{t('hrInc.col.type')}</th>
                <th>{t('hrInc.col.people')}</th>
                <th>{t('hrInc.col.status')}</th>
              </tr>
            </thead>
            <tbody>
              {pager.pageRows.map((r) => {
                const types = typesText(t, r);
                const people = peopleText(t, r, nameOf);
                return (
                  <tr key={r.id} className="hrw-row" onClick={() => setParam({ i: r.id })}>
                    <td className="cell-primary"><span className="hri-case">{incidentCaseNo(r) || '—'}</span></td>
                    <td data-label={t(INCIDENT_FORM_KEYS.incidentDate)}>{day(r.incidentDate)}</td>
                    <td data-label={t('hrInc.col.property')}><span className="truncate hri-clamp" title={r.propertyName || ''}>{r.propertyName || '—'}</span></td>
                    <td data-label={t('hrInc.col.type')}><span className="truncate hri-clamp" title={types}>{types || '—'}</span></td>
                    <td data-label={t('hrInc.col.people')}><span className="truncate hri-clamp" title={people}>{people || '—'}</span></td>
                    <td data-label={t('hrInc.col.status')}><Badge variant={INCIDENT_STATUS_VARIANTS[r.status] || 'slate'}>{t(INCIDENT_STATUS_KEYS[r.status] || 'hrInc.status.awaiting')}</Badge></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <ListPager pager={pager} noun={t('hrInc.pagerNoun')} />
        </div>
      )}

      <Modal open={!!openId} onClose={() => setParam({ i: null })} title={t(INCIDENT_FORM_KEYS.title)} size="lg">
        {openId && (
          <HrIncidentDetail
            key={openId}
            incidentId={openId}
            canEdit={canEdit}
            canVoid={canVoid}
            users={users}
            currentUserId={currentUser?.id || null}
            onChanged={reload}
          />
        )}
      </Modal>

      <HrIncidentForm
        open={creating}
        onClose={() => setCreating(false)}
        users={users}
        clients={clients}
        currentUserId={currentUser?.id || null}
        onFiled={(incident, { created = true } = {}) => {
          setCreating(false);
          if (created) toast.success(t('hrInc.form.filed'));
          else toast.info(t('hrInc.form.alreadyFiled'), { duration: 8000 });
          reload();
          if (incident) setParam({ i: incident.id });
        }}
      />
    </div>
  );
}
