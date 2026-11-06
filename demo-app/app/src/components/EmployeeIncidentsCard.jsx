// One employee's incident reports (task #258 from Clean Corner's queue; Daniel's pick: a report
// shows on the HR card of each employee involved). A shared card, beside EmployeeWarningsCard:
// it mounts in HR → Employees → the employee's panel AND on Team → member → HR, one card in two
// homes. It lists every report that names this person as involved (voided ones included,
// marked), opens one in the shared read view, and lets an `hr.edit` holder file a new one with
// this person already added as involved.
//
// Shown to `hr.view` holders (both homes already gate on it); it reads the API, never the
// shared record. Words: the catalog (UI_RULES §140).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from '../store';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { fmtDate } from '../lib/dates';
import { INCIDENT_FORM_KEYS, INCIDENT_STATUS_KEYS, INCIDENT_STATUS_VARIANTS, incidentCaseNo, typesText } from '../lib/hrIncidents';
import * as hrIncidentsApi from '../lib/hrIncidentsApi';
import Badge from './Badge';
import Modal from './Modal';
import HrIncidentDetail from './HrIncidentDetail';
import HrIncidentForm from './HrIncidentForm';
import { useToast } from './Toast';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export default function EmployeeIncidentsCard({ user }) {
  const t = useT();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canEdit = usePermission('hr.edit');
  const canVoid = currentUser?.role === 'owner';
  const users = useSelector(useCallback((s) => s.users || [], []));
  const clients = useSelector(useCallback((s) => s.clients || [], []));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    try { setData(await hrIncidentsApi.listIncidents({ employeeId: user.id })); setError(null); }
    catch (e) { setError(e); }
  }, [user.id]);
  useEffect(() => { reload(); }, [reload]);

  const incidents = useMemo(() => (data?.incidents || []).filter((r) => (r.involvedUserIds || []).includes(user.id)), [data, user.id]);

  return (
    <div className="card detail-card">
      <div className="hrw-card-head">
        <h3 className="dash-card-title">{t('hrInc.card.title')}</h3>
        {canEdit && (
          <button type="button" className="btn btn-outline" onClick={() => setCreating(true)}>{t('hrInc.new.button')}</button>
        )}
      </div>
      {error ? (
        <div className="callout callout-warning">{errorText(t, error, 'hrInc.loadFailed')}</div>
      ) : !data ? (
        <p className="text-muted text-sm">{t('common.loading')}</p>
      ) : incidents.length === 0 ? (
        <p className="text-muted text-sm">{t('hrInc.card.none')}</p>
      ) : (
        <div className="hrw-list">
          {incidents.map((r) => (
            <button key={r.id} type="button" className="hrw-item" onClick={() => setOpenId(r.id)}>
              <span className="hrw-item-date">{day(r.incidentDate)}</span>
              <span className="hrw-item-what">
                {typesText(t, r) || '—'}
                <span className="hrw-item-sub">{[incidentCaseNo(r), r.propertyName].filter(Boolean).join(' · ')}</span>
              </span>
              <Badge variant={INCIDENT_STATUS_VARIANTS[r.status] || 'slate'}>{t(INCIDENT_STATUS_KEYS[r.status] || 'hrInc.status.awaiting')}</Badge>
            </button>
          ))}
        </div>
      )}

      <Modal open={!!openId} onClose={() => setOpenId(null)} title={t(INCIDENT_FORM_KEYS.title)} size="lg">
        {openId && (
          <HrIncidentDetail key={openId} incidentId={openId} canEdit={canEdit} canVoid={canVoid}
            users={users} currentUserId={currentUser?.id || null} onChanged={reload} />
        )}
      </Modal>
      <HrIncidentForm
        open={creating}
        onClose={() => setCreating(false)}
        presetEmployeeId={user.status === 'active' ? user.id : null}
        users={users}
        clients={clients}
        currentUserId={currentUser?.id || null}
        onFiled={(incident, { created = true } = {}) => {
          setCreating(false);
          if (created) toast.success(t('hrInc.form.filed'));
          else toast.info(t('hrInc.form.alreadyFiled'), { duration: 8000 });
          reload();
          if (incident) setOpenId(incident.id);
        }}
      />
    </div>
  );
}
