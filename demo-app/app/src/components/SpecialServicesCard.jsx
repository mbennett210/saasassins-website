// A building's SPECIAL SERVICES card (task 507 from Clean Corner's queue; UI_RULES §192), on its
// customer page's Overview under Service setup. Matt ("clean corner", 2026-11-03): "a section to
// track recurring special services at each location", each with its type, frequency and next
// scheduled date, "not added to the regular cleaning schedule", with reminders. The list reads
// soonest first; a date that has passed reads Overdue (red) and one inside the reminder's lead days
// Due soon (amber). Mark done moves the date on by its frequency (Daniel's pick, 2026-11-04), after
// asking. With none entered the office can mark the building as having none (the onboarding bar's
// Special services step reads that as done), and undo it. Writes take `clients.edit`, the same key
// as the customer's other details; every word is a catalog line (`specialSvc.*`, UI_RULES §140).
import { useState } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectCurrentUser, selectUserById } from '../store/selectors';
import { fmtDate, todayKey } from '../lib/dates';
import {
  specialServicesOf, hasNoSpecialServices, frequencyLabel, dueState, nextDateAfterDone,
  DUE, DUE_LABEL_KEY, SPECIAL_SERVICE_LEAD_DAYS,
} from '../lib/specialServices';
import { useT } from '../i18n/react';
import Badge from './Badge';
import Centred from './Centred';
import Modal from './Modal';
import SpecialServiceModal from './SpecialServiceModal';
import { useToast } from './Toast';

const DUE_VARIANT = { overdue: 'red', soon: 'amber' };
// A service's dates read with their year: an annual or two-yearly one is a year or more out.
export const serviceDay = (key) => (key ? fmtDate(key, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

export default function SpecialServicesCard({ client, canEdit }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const me = selectCurrentUser(state);
  const services = specialServicesOf(client);
  const none = hasNoSpecialServices(client);
  const today = todayKey();
  const [editing, setEditing] = useState(null); // null | 'new' | a service
  const [doneFor, setDoneFor] = useState(null);

  const setNone = (value) => {
    dispatch({ type: ACTIONS.SET_NO_SPECIAL_SERVICES, clientId: client.id, none: value, at: new Date().toISOString(), by: me?.id || null });
    toast.success(t(value ? 'specialSvc.noneSet' : 'specialSvc.noneCleared'));
  };

  return (
    <div className="card detail-card spsvc">
      <div className="overview-card-head">
        <h3>{t('specialSvc.title')}</h3>
        {canEdit && (
          <button type="button" className="btn btn-outline" onClick={() => setEditing('new')}><Centred>{t('specialSvc.addButton')}</Centred></button>
        )}
      </div>
      <p className="text-sm text-muted spsvc-lead">{t('specialSvc.lead', { days: SPECIAL_SERVICE_LEAD_DAYS })}</p>

      {services.length > 0 && (
        <ul className="spsvc-list">
          {services.map((s) => {
            const due = dueState(s, today);
            const freq = frequencyLabel(s.months);
            const doneBy = s.lastDoneBy ? selectUserById(state, s.lastDoneBy) : null;
            return (
              <li key={s.id} className="spsvc-row">
                <div className="spsvc-main">
                  <div className="spsvc-type">{s.type}</div>
                  <div className="spsvc-meta text-sm text-muted">
                    <span>{t(freq.key, freq.params)}</span>
                    <span>{t('specialSvc.next', { date: serviceDay(s.nextDate) })}</span>
                    {due !== DUE.later && <Badge variant={DUE_VARIANT[due]}>{t(DUE_LABEL_KEY[due])}</Badge>}
                  </div>
                  {s.lastDoneOn && (
                    <div className="text-xs text-muted">
                      {doneBy
                        ? t('specialSvc.lastDoneBy', { date: serviceDay(s.lastDoneOn), name: doneBy.name })
                        : t('specialSvc.lastDone', { date: serviceDay(s.lastDoneOn) })}
                    </div>
                  )}
                </div>
                {canEdit && (
                  <div className="spsvc-actions">
                    <button type="button" className="btn btn-outline" onClick={() => setDoneFor(s)}><Centred>{t('specialSvc.markDone')}</Centred></button>
                    <button type="button" className="btn btn-outline" onClick={() => setEditing(s)}><Centred>{t('specialSvc.edit')}</Centred></button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {services.length === 0 && (
        <div className="spsvc-empty">
          <p className="text-sm">{t(none ? 'specialSvc.none' : 'specialSvc.empty')}</p>
          {canEdit && (none
            ? <button type="button" className="btn btn-outline" onClick={() => setNone(false)}><Centred>{t('specialSvc.noneUndo')}</Centred></button>
            : <button type="button" className="btn btn-outline" onClick={() => setNone(true)}><Centred>{t('specialSvc.noneButton')}</Centred></button>)}
        </div>
      )}

      {editing && (
        <SpecialServiceModal client={client} service={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      )}
      {doneFor && (
        <MarkDoneModal client={client} service={doneFor} today={today} by={me?.id || null} onClose={() => setDoneFor(null)} />
      )}
    </div>
  );
}

// Mark done, after saying where the date moves to. It moves only while the service is still at the
// date shown here (the store's rule), so a second press or a teammate's changes nothing twice.
function MarkDoneModal({ client, service, today, by, onClose }) {
  const t = useT();
  const dispatch = useDispatch();
  const toast = useToast();
  const next = nextDateAfterDone(service, today);
  const confirm = () => {
    dispatch({ type: ACTIONS.MARK_SPECIAL_SERVICE_DONE, clientId: client.id, serviceId: service.id, fromDate: service.nextDate, doneOn: today, by });
    toast.success(t('specialSvc.doneToast', { service: service.type, date: serviceDay(next) }));
    onClose();
  };
  return (
    <Modal open onClose={onClose} title={t('specialSvc.doneTitle', { service: service.type })} centred>
      <p className="text-sm text-muted modal-intro">{t('specialSvc.doneLead', { date: serviceDay(next) })}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-outline" onClick={onClose}><Centred>{t('common.cancel')}</Centred></button>
        <button type="button" className="btn btn-primary" onClick={confirm} disabled={!next}><Centred>{t('specialSvc.markDone')}</Centred></button>
      </div>
    </Modal>
  );
}
