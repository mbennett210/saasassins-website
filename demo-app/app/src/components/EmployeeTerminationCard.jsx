// One employee's termination (Super Clippy's idea #513 from Clean Corner's queue). A shared card,
// beside EmployeeWarningsCard and EmployeeIncidentsCard: it mounts in HR → Employees → the
// employee's panel AND on Team → member → HR, one card in two homes. It lists every termination
// filed for this person (voided ones included, marked), opens one in the shared read view, and
// lets someone the server will let file one do so with this person already chosen.
//
// "New termination" shows only when the server would take it (UI_RULES §118): `hr.edit` AND
// `settings.team.edit` (Daniel's pick, 2026-11-05: "HR and Team editors"), the person is one the
// filer may terminate (lib/hrTerminations terminationTargetRefusal: never a Super Admin, never
// yourself, an Admin only by an Admin or Super Admin), and none is on file for them yet.
//
// Shown to `hr.view` holders (both homes already gate on it); it reads the API, never the
// shared record. Words: the catalog (UI_RULES §140).
import { useCallback, useEffect, useState } from 'react';
import { useSelector, useDispatch } from '../store';
import { ACTIONS } from '../store/reducer';
import { useAuth } from '../hooks/useAuth';
import { usePermission } from '../hooks/usePermission';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { fmtDate, todayKey } from '../lib/dates';
import {
  TERMINATION_FORM_KEYS, TERMINATION_STATUS, TERMINATION_STANDING_KEYS, TERMINATION_STANDING_VARIANTS,
  terminationStanding, terminationTargetRefusal, reasonsText,
} from '../lib/hrTerminations';
import * as hrTerminationsApi from '../lib/hrTerminationsApi';
import Badge from './Badge';
import Modal from './Modal';
import HrTerminationDetail from './HrTerminationDetail';
import HrTerminationForm from './HrTerminationForm';
import { useToast } from './Toast';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');

// The toast after a filing, by what happened to the login.
export function filedToast(t, toast, termination, { created = true, access } = {}) {
  if (!created) { toast.info(t('hrTerm.form.alreadyFiled'), { duration: 8000 }); return; }
  if (access === 'ended') toast.success(t('hrTerm.done.ended'));
  else if (access === 'already_off') toast.success(t('hrTerm.done.alreadyOff'));
  else if (access === 'scheduled') toast.success(t('hrTerm.done.scheduled', { date: day(termination?.terminationDate) }));
  else toast.success(t('hrTerm.done.pending'));
}

// The DEMO's own store stands in for the server's roster write (lib/hrTerminationsApi's stub has
// no server to Disable the member). Outside the demo it does nothing: the server writes the
// roster, and the browser picks it up from the shared record (store/sync.js).
export function useMemberStatusSetter() {
  const dispatch = useDispatch();
  return useCallback((id, status) => {
    if (!hrTerminationsApi.isHrTerminationsStub()) return;
    dispatch({ type: ACTIONS.UPDATE_USER, id, patch: { status } });
  }, [dispatch]);
}

export default function EmployeeTerminationCard({ user }) {
  const t = useT();
  const toast = useToast();
  const { currentUser } = useAuth();
  const canHr = usePermission('hr.edit');
  const canTeam = usePermission('settings.team.edit');
  const canVoid = currentUser?.role === 'owner';
  const users = useSelector(useCallback((s) => s.users || [], []));
  const setMemberStatus = useMemberStatusSetter();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const today = todayKey();

  const reload = useCallback(async () => {
    try { setData(await hrTerminationsApi.listTerminations({ employeeId: user.id })); setError(null); }
    catch (e) { setError(e); }
  }, [user.id]);
  useEffect(() => { reload(); }, [reload]);

  const rows = (data?.terminations || []).filter((r) => r.employeeUserId === user.id);
  const live = rows.some((r) => r.status === TERMINATION_STATUS.filed);
  const mayFile = canHr && canTeam && !!data && !live
    && !terminationTargetRefusal({ id: currentUser?.id || null, role: currentUser?.role || null }, user);

  return (
    <div className="card detail-card">
      <div className="hrw-card-head">
        <h3 className="dash-card-title">{t('hrTerm.card.title')}</h3>
        {mayFile && (
          <button type="button" className="btn btn-outline" onClick={() => setCreating(true)}>{t('hrTerm.new.button')}</button>
        )}
      </div>
      {error ? (
        <div className="callout callout-warning">{errorText(t, error, 'hrTerm.loadFailed')}</div>
      ) : !data ? (
        <p className="text-muted text-sm">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="text-muted text-sm">{t('hrTerm.card.none')}</p>
      ) : (
        <div className="hrw-list">
          {rows.map((r) => {
            const standing = terminationStanding(r, today);
            return (
              <button key={r.id} type="button" className="hrw-item" onClick={() => setOpenId(r.id)}>
                <span className="hrw-item-date">{day(r.terminationDate)}</span>
                <span className="hrw-item-what">
                  {reasonsText(t, r) || '—'}
                  <span className="hrw-item-sub">{r.managerName || '—'}</span>
                </span>
                <Badge variant={TERMINATION_STANDING_VARIANTS[standing] || 'slate'}>{t(TERMINATION_STANDING_KEYS[standing] || 'hrTerm.status.scheduled')}</Badge>
              </button>
            );
          })}
        </div>
      )}

      <Modal open={!!openId} onClose={() => setOpenId(null)} title={t(TERMINATION_FORM_KEYS.title)} size="lg">
        {openId && (
          <HrTerminationDetail key={openId} terminationId={openId} canVoid={canVoid}
            users={users} currentUserId={currentUser?.id || null} onChanged={reload} setMemberStatus={setMemberStatus} />
        )}
      </Modal>
      <HrTerminationForm
        open={creating}
        onClose={() => setCreating(false)}
        presetEmployeeId={user.id}
        users={users}
        currentUser={currentUser}
        terminatedIds={rows.filter((r) => r.status === TERMINATION_STATUS.filed).map((r) => r.employeeUserId)}
        setMemberStatus={setMemberStatus}
        onFiled={(termination, out) => {
          setCreating(false);
          filedToast(t, toast, termination, out);
          reload();
          if (termination) setOpenId(termination.id);
        }}
      />
    </div>
  );
}
