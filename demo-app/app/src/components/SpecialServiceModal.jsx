// Add or change one of a building's SPECIAL SERVICES (task 507 from Clean Corner's queue; UI_RULES
// §192), from its customer page's Special services card and from the onboarding bar's Special
// services step. Matt's three fields ("clean corner", 2026-11-03): the type of service, its
// frequency and the next scheduled date. A kit `Modal`; changing an existing one also offers
// Remove, which asks first. One store action per save (lib/specialServices, store/reducer).
import { useMemo, useState } from 'react';
import { useDispatch, useStore } from '../store';
import { ACTIONS } from '../store/reducer';
import { selectCurrentUser } from '../store/selectors';
import { newId } from '../lib/ids';
import {
  FREQUENCY_PRESETS, CUSTOM_FREQUENCY, FREQUENCY_LABEL_KEY, SPECIAL_SERVICE_TYPE_MAX,
  SPECIAL_SERVICE_MONTHS_MIN, SPECIAL_SERVICE_MONTHS_MAX, frequencyKeyOf, specialServiceProblems,
  specialServiceRow, knownServiceTypes,
} from '../lib/specialServices';
import { useT } from '../i18n/react';
import Modal from './Modal';
import FormField from './FormField';
import Centred from './Centred';
import { useToast } from './Toast';

// Matt's two examples lead the suggestions until the book has its own.
const EXAMPLE_TYPE_KEYS = ['specialSvc.example.carpet', 'specialSvc.example.stripWax'];

/**
 * @param client   the customer (one building)
 * @param service  the service being changed, or null to add one
 * @param onClose  () => void
 */
export default function SpecialServiceModal({ client, service = null, onClose }) {
  const t = useT();
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const me = selectCurrentUser(state);
  const [form, setForm] = useState(() => ({
    type: service?.type || '',
    frequency: service ? frequencyKeyOf(service.months) : 'quarterly',
    customMonths: service && frequencyKeyOf(service.months) === CUSTOM_FREQUENCY ? String(service.months) : '',
    nextDate: service?.nextDate || '',
  }));
  const [tried, setTried] = useState(false);
  const [removing, setRemoving] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const problems = specialServiceProblems(form);
  const err = (key) => (tried && problems.includes(key) ? t(key) : null);
  const suggestions = useMemo(() => {
    const seen = new Set();
    return [...knownServiceTypes(state.clients), ...EXAMPLE_TYPE_KEYS.map((k) => t(k))]
      .filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  }, [state.clients, t]);
  const frequencyOptions = [
    ...FREQUENCY_PRESETS.map((p) => ({ value: p.key, label: t(FREQUENCY_LABEL_KEY[p.key]) })),
    { value: CUSTOM_FREQUENCY, label: t(FREQUENCY_LABEL_KEY.custom) },
  ];

  const save = (e) => {
    e.preventDefault();
    setTried(true);
    if (problems.length) return;
    const row = specialServiceRow(form, { prev: service, id: newId('ssvc'), at: new Date().toISOString(), by: me?.id || null });
    if (!row) return;
    dispatch({ type: ACTIONS.SAVE_SPECIAL_SERVICE, clientId: client.id, service: row });
    toast.success(t(service ? 'specialSvc.saved' : 'specialSvc.added', { service: row.type }));
    onClose();
  };
  const remove = () => {
    dispatch({ type: ACTIONS.REMOVE_SPECIAL_SERVICE, clientId: client.id, serviceId: service.id });
    toast.success(t('specialSvc.removed', { service: service.type }));
    onClose();
  };

  return (
    <>
      <Modal open={!removing} onClose={onClose} title={t(service ? 'specialSvc.editTitle' : 'specialSvc.addTitle')} centred>
        <form onSubmit={save} noValidate>
          <p className="text-sm text-muted modal-intro">{t('specialSvc.modalLead')}</p>
          <FormField label={t('specialSvc.field.type')} required error={err('specialSvc.err.type')}>
            <input
              className="input" name="specialSvc-type" list="specialSvc-types" autoFocus maxLength={SPECIAL_SERVICE_TYPE_MAX}
              value={form.type} onChange={(e) => set({ type: e.target.value })} placeholder={t('specialSvc.field.typePlaceholder')}
            />
          </FormField>
          <datalist id="specialSvc-types">{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
          <div className={form.frequency === CUSTOM_FREQUENCY ? 'form-row' : undefined}>
            <FormField
              label={t('specialSvc.field.frequency')} name="specialSvc-frequency" as="select" required
              value={form.frequency} options={frequencyOptions} onChange={(e) => set({ frequency: e.target.value })}
              error={err('specialSvc.err.frequency')}
            />
            {form.frequency === CUSTOM_FREQUENCY && (
              <FormField
                label={t('specialSvc.field.months')} name="specialSvc-months" type="number" inputMode="numeric" required
                min={SPECIAL_SERVICE_MONTHS_MIN} max={SPECIAL_SERVICE_MONTHS_MAX} step="1"
                value={form.customMonths} onChange={(e) => set({ customMonths: e.target.value })}
                error={err('specialSvc.err.months')}
              />
            )}
          </div>
          <FormField
            label={t('specialSvc.field.nextDate')} name="specialSvc-date" type="date" required className="input spsvc-date"
            value={form.nextDate} onChange={(e) => set({ nextDate: e.target.value })}
            error={err('specialSvc.err.date')}
          />
          <div className="modal-actions spsvc-modal-actions">
            {service && (
              <button type="button" className="btn btn-outline spsvc-remove" onClick={() => setRemoving(true)}><Centred>{t('specialSvc.remove')}</Centred></button>
            )}
            <button type="button" className="btn btn-outline" onClick={onClose}><Centred>{t('common.cancel')}</Centred></button>
            <button type="submit" className="btn btn-primary"><Centred>{t(service ? 'specialSvc.save' : 'specialSvc.add')}</Centred></button>
          </div>
        </form>
      </Modal>
      {removing && (
        <Modal open onClose={() => setRemoving(false)} title={t('specialSvc.removeTitle', { service: service.type })} centred>
          <p className="text-sm text-muted modal-intro">{t('specialSvc.removeLead')}</p>
          <div className="modal-actions">
            <button type="button" className="btn btn-outline" onClick={() => setRemoving(false)}><Centred>{t('common.cancel')}</Centred></button>
            <button type="button" className="btn btn-danger" onClick={remove}><Centred>{t('specialSvc.removeConfirm')}</Centred></button>
          </div>
        </Modal>
      )}
    </>
  );
}
