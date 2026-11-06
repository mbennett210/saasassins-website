// The "New termination" form — MATT'S OWN FORM (Super Clippy's idea #513, his email "Clean Corner -
// Termination", 2026-11-05): "similar to the forms for incidents and warnings, but simpler", with
// "the employee name, day of termination and direct manager which can link back to account manager
// existing in clean corner", and his sixteen reasons. His lines in his order: Employee's Name, Day
// of Termination, Reason for Termination (his two columns, tick any, "Other:" with words), Direct
// Account Manager. The words are catalog lines (lib/hrTerminations TERMINATION_FORM_KEYS and
// TERMINATION_REASON_KEYS), and the rules are lib/hrTerminations `terminationDraftRefusal`, which
// the server runs too, so the form can never accept what the server refuses.
//
// The employee picker offers whom the filer may terminate (terminationTargetRefusal: never a Super
// Admin, never themselves, an Admin only for an Admin or Super Admin) and who has no termination
// on file; the manager picker, the active Account Managers (Daniel's pick). The line under the date
// says what happens to the login: off as soon as it's filed when the day is today or earlier, else
// off on that day (Daniel's pick). Once filed it is locked: the form says so at its top.
//
// "Other:" opens its box and puts the cursor in it (the Shift rule).
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/react';
import { errorText } from '../i18n/errors';
import { fmtDate, todayKey } from '../lib/dates';
import { compareUsersByName } from '../lib/roles';
import { hasTeamAccess } from '../lib/teamScope';
import {
  TERMINATION_FORM_KEYS, TERMINATION_REASONS, TERMINATION_REASON_KEYS, TERMINATION_REASON, TERMINATION_TEXT_MAX,
  TERMINATION_REFUSAL_KEYS, terminationDraftRefusal, terminationTargetRefusal, directManagerChoices, normalizeReasons,
} from '../lib/hrTerminations';
import * as hrTerminationsApi from '../lib/hrTerminationsApi';
import { IDENTITY } from '../brand/identity.generated';
import Modal from './Modal';
import FormField from './FormField';
import FilterSelect from './FilterSelect';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

// A refusal from the server or the stub, in the reader's language when it carries a known code.
export function terminationErrorText(t, e) {
  const key = e && e.code && TERMINATION_REFUSAL_KEYS[e.code];
  return key ? t(key) : errorText(t, e, 'hrTerm.loadFailed');
}

const blankDraft = (employeeUserId) => ({
  employeeUserId: employeeUserId || '', terminationDate: todayKey(), managerUserId: '', reasons: [], reasonOther: '',
});

export default function HrTerminationForm({
  open, onClose, onFiled, presetEmployeeId = null, users = [], currentUser = null, terminatedIds = null, setMemberStatus,
}) {
  const t = useT();
  const F = (field) => t(TERMINATION_FORM_KEYS[field]);
  const busyIds = useMemo(() => new Set(terminatedIds || []), [terminatedIds]);
  const caller = useMemo(() => ({ id: currentUser?.id || null, role: currentUser?.role || null }), [currentUser]);
  const employees = useMemo(() => users
    .filter((u) => u && u.id && !terminationTargetRefusal(caller, u) && !busyIds.has(u.id))
    .slice().sort(compareUsersByName), [users, caller, busyIds]);
  const preset = presetEmployeeId && employees.some((u) => u.id === presetEmployeeId) ? presetEmployeeId : '';
  const [id, setId] = useState(() => hrTerminationsApi.newTerminationId());
  const [d, setD] = useState(() => blankDraft(preset));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reveal, setReveal] = useState(false);
  const otherRef = useRef(null);
  const today = todayKey();

  // A fresh form (and a fresh id) each time it opens, for whoever it was opened for.
  useEffect(() => {
    if (open) {
      setId(hrTerminationsApi.newTerminationId());
      setD(blankDraft(preset));
      setError(null);
      setReveal(false);
    }
  }, [open, preset]);
  useEffect(() => {
    // The box sits at the foot of the pop-up's scroll: bring it into view as it takes the cursor
    // (iOS Safari leaves a box focused from code half under the pop-up's edge).
    if (reveal && otherRef.current) { otherRef.current.focus(); otherRef.current.scrollIntoView?.({ block: 'nearest' }); setReveal(false); }
  }, [reveal, d.reasons]);

  const set = (patch) => setD((prev) => ({ ...prev, ...patch }));
  const employee = d.employeeUserId ? users.find((u) => u.id === d.employeeUserId) || null : null;
  const managers = useMemo(() => directManagerChoices(users, d.employeeUserId || null).slice().sort(compareUsersByName), [users, d.employeeUserId]);
  const managerValue = managers.some((u) => u.id === d.managerUserId) ? d.managerUserId : '';
  const toggle = (code) => {
    if (code === TERMINATION_REASON.other && !d.reasons.includes(code)) setReveal(true);
    setD((prev) => ({
      ...prev,
      reasons: prev.reasons.includes(code) ? prev.reasons.filter((x) => x !== code) : normalizeReasons([...prev.reasons, code]),
    }));
  };

  // What happens to the login, in one line under the date.
  const loginLine = !employee ? null
    : !hasTeamAccess(employee) ? t('hrTerm.form.alreadyOff')
      : d.terminationDate && d.terminationDate > today
        ? t('hrTerm.form.endsOn', { brand: IDENTITY.product.name, date: day(d.terminationDate) })
        : t('hrTerm.form.endsNow', { brand: IDENTITY.product.name });

  const submit = async () => {
    const payload = {
      id,
      employeeUserId: d.employeeUserId,
      terminationDate: d.terminationDate,
      managerUserId: managerValue,
      reasons: d.reasons,
      reasonOther: d.reasons.includes(TERMINATION_REASON.other) ? d.reasonOther : '',
    };
    const code = terminationDraftRefusal(payload, today);
    if (code) { setError(t(TERMINATION_REFUSAL_KEYS[code])); return; }
    setBusy(true);
    setError(null);
    try {
      const out = await hrTerminationsApi.createTermination(payload, {
        users, currentUserId: caller.id, currentUserRole: caller.role, setMemberStatus,
      });
      onFiled && onFiled(out.termination, { created: out.created !== false, access: out.access });
    } catch (e) {
      setError(terminationErrorText(t, e));
    } finally { setBusy(false); }
  };

  const memberLabel = (u) => (hasTeamAccess(u) ? u.name : t('hrTerm.form.disabledMember', { name: u.name }));

  return (
    <Modal open={open} onClose={() => { if (!busy && onClose) onClose(); }} title={F('title')} size="md">
      <div className="hrt-form">
        <p className="text-sm text-muted hrt-lead">{t('hrTerm.form.lead')}</p>

        <div className="hrt-row">
          <FormField label={F('employee')} required>
            <FilterSelect ariaLabel={F('employee')} value={d.employeeUserId}
              options={[{ value: '', label: t('hrTerm.form.pickEmployee') }, ...employees.map((u) => ({ value: u.id, label: memberLabel(u) }))]}
              onChange={(v) => set({ employeeUserId: v || '' })} />
          </FormField>
          <FormField label={F('date')} required type="date" value={d.terminationDate}
            onChange={(e) => set({ terminationDate: e.target.value })} />
        </div>
        {loginLine && <p className="callout callout-info hrt-login">{loginLine}</p>}

        <fieldset className="hrt-reasons">
          <legend className="form-label">{F('reasons')}<span className="form-required" aria-hidden> *</span></legend>
          {TERMINATION_REASONS.map((x) => (
            <label key={x} className="hrt-reason">
              <input type="checkbox" checked={d.reasons.includes(x)} onChange={() => toggle(x)} />
              <span>{t(TERMINATION_REASON_KEYS[x])}</span>
            </label>
          ))}
          {d.reasons.includes(TERMINATION_REASON.other) && (
            <input ref={otherRef} className="input hrt-reason-other" value={d.reasonOther} maxLength={TERMINATION_TEXT_MAX.reasonOther}
              aria-label={t('hrTerm.form.otherLabel')} onChange={(e) => set({ reasonOther: e.target.value })} />
          )}
        </fieldset>

        <FormField label={F('manager')} required>
          <FilterSelect ariaLabel={F('manager')} value={managerValue}
            options={[{ value: '', label: t('hrTerm.form.pickManager') }, ...managers.map((u) => ({ value: u.id, label: u.name }))]}
            onChange={(v) => set({ managerUserId: v || '' })} />
        </FormField>
        {managers.length === 0 && <p className="text-sm text-muted hrt-lead">{t('hrTerm.form.noManagers')}</p>}

        {error && <div className="callout callout-warning" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? t('hrTerm.form.filing') : t('hrTerm.form.submit')}</button>
        </div>
      </div>
    </Modal>
  );
}
