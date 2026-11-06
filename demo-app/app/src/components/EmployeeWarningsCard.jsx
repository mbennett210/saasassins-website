// One employee's warnings — Matt: "Once acknowledged it stays saved under the employee's
// profile: date, reason, supervisor, employee acknowledgment." A shared card (the
// EmployeeDocumentsCard pattern): it mounts in HR → Employees → the employee's panel AND on
// Team → member → HR, one editor in two homes. It shows where they stand on HR-4's
// twelve-month count, every warning on file (voided ones included, marked), opens one in the
// shared detail view, and lets an `hr.edit` holder issue a new one for this person.
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
import { compareUsersByName } from '../lib/roles';
import {
  WARNING_LEVEL_KEYS, WARNING_STATUS_KEYS, WARNING_STATUS_VARIANTS,
  warningStanding,
} from '../lib/hrWarnings';
import * as hrWarningsApi from '../lib/hrWarningsApi';
import Badge from './Badge';
import Modal from './Modal';
import HrWarningDetail, { reasonsText } from './HrWarningDetail';
import HrWarningForm from './HrWarningForm';
import { useToast } from './Toast';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

export default function EmployeeWarningsCard({ user }) {
  const t = useT();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canEdit = usePermission('hr.edit');
  const canVoid = currentUser?.role === 'owner';
  const users = useSelector(useCallback((s) => s.users || [], []));
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [signNow, setSignNow] = useState(false);
  const [creating, setCreating] = useState(false);

  const reload = useCallback(async () => {
    try { setData(await hrWarningsApi.listWarnings({ employeeId: user.id })); setError(null); }
    catch (e) { setError(e); }
  }, [user.id]);
  useEffect(() => { reload(); }, [reload]);

  const warnings = useMemo(() => (data?.warnings || []).filter((w) => w.employeeUserId === user.id), [data, user.id]);
  const standing = data ? warningStanding(warnings, user.id, data.today) : null;
  const activeUsers = useMemo(() => users.filter((u) => u.status === 'active').slice().sort(compareUsersByName), [users]);

  return (
    <div className="card detail-card">
      <div className="hrw-card-head">
        <h3 className="dash-card-title">{t('hrWarn.card.title')}</h3>
        {canEdit && user.status === 'active' && (
          <button type="button" className="btn btn-outline" onClick={() => setCreating(true)}>{t('hrWarn.new.button')}</button>
        )}
      </div>
      {error ? (
        <div className="callout callout-warning">{errorText(t, error, 'hrWarn.loadFailed')}</div>
      ) : !data ? (
        <p className="text-muted text-sm">{t('common.loading')}</p>
      ) : (
        <>
          <p className="text-sm hrw-standing">
            {standing.count === 0
              ? t('hrWarn.standing.none')
              : t('hrWarn.standing.count', { count: standing.count, since: day(standing.since), resets: day(standing.resets) })}
          </p>
          {warnings.length === 0 ? (
            <p className="text-muted text-sm">{t('hrWarn.card.none')}</p>
          ) : (
            <div className="hrw-list">
              {warnings.map((w) => (
                <button key={w.id} type="button" className="hrw-item" onClick={() => { setSignNow(false); setOpenId(w.id); }}>
                  <span className="hrw-item-date">{day(w.issuedOn)}</span>
                  <span className="hrw-item-what">
                    {t(WARNING_LEVEL_KEYS[w.level] || 'hrWarn.level.first')} · {reasonsText(t, w)}
                    <span className="hrw-item-sub">{t('hrWarn.card.by', { name: w.supervisorName || '—' })}</span>
                  </span>
                  <Badge variant={WARNING_STATUS_VARIANTS[w.status] || 'slate'}>{t(WARNING_STATUS_KEYS[w.status] || 'hrWarn.status.awaiting')}</Badge>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      <Modal open={!!openId} onClose={() => setOpenId(null)} title={t('hrWarn.detail.title')} size="lg">
        {openId && (
          <HrWarningDetail key={openId} warningId={openId} mode="office" canEdit={canEdit} canVoid={canVoid}
            users={users} currentUserId={currentUser?.id || null} initialStep={signNow ? 'sign' : null} onChanged={reload} />
        )}
      </Modal>
      <HrWarningForm
        open={creating}
        onClose={() => setCreating(false)}
        presetEmployeeId={user.id}
        users={activeUsers}
        currentUserId={currentUser?.id || null}
        onIssued={(warning, { signInPerson }) => {
          setCreating(false);
          toast.success(t('hrWarn.form.issued'));
          reload();
          if (warning) { setSignNow(!!signInPerson); setOpenId(warning.id); }
        }}
      />
    </div>
  );
}
