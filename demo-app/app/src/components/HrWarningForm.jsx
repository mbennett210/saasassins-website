// The "New warning" form — MATT'S OWN FORM (his HR-1 answer "b", 2026-10-05: "Warning Form"),
// his questions in his order and his words: the employee's name and the date, the
// manager/supervisor's name, the level (HR-2, ours, kept), the previous discipline meeting's
// date if there was one, the reasons (ten, tick any — "Other" with words), the details of
// the actions that warranted it, and the corrective action. The words are catalog lines
// (lib/hrWarnings WARNING_FORM_KEYS / WARNING_REASON_KEYS), so a Spanish reader sees his
// team's Spanish; the rules are lib/hrWarnings `warningDraftRefusal`, which the server runs
// too, so the form can never accept what the server refuses.
//
// 🔴 HR-4: once the employee is picked, the form shows where they stand ("1 warning in the
// current period, since …; resets …") and PRESELECTS the next level (0 → First, 1 → Last,
// 2 → Termination). The supervisor may still change it. The same read prefills the previous
// discipline meeting with their most recent counted warning (`previousMeetingDefault`); the
// supervisor may change or clear it.
//
// The Date is today, the day the warning is issued — shown, not editable: the server stamps
// it. The supervisor is PICKED (defaulting to whoever is signed in, when they are an office
// member): the team shares one login, so the form never infers it.
import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n/react';
import { fmtDate, todayKey } from '../lib/dates';
import { SUPERVISOR_ROLES, compareUsersByName } from '../lib/roles';
import {
  WARNING_LEVELS, WARNING_LEVEL_KEYS, WARNING_REASONS, WARNING_REASON_KEYS, WARNING_FORM_KEYS,
  WARNING_REASON, WARNING_REFUSAL_KEYS, WARNING_TEXT_MAX, warningDraftRefusal, warningStanding,
  previousMeetingDefault, normalizeReasons,
} from '../lib/hrWarnings';
import * as hrWarningsApi from '../lib/hrWarningsApi';
import Modal from './Modal';
import FormField from './FormField';
import FilterSelect from './FilterSelect';
import { warningErrorText } from './HrWarningDetail';

const day = (key) => (key ? fmtDate(`${key}T12:00:00`, { month: 'short', day: 'numeric', year: 'numeric' }) : '');

const blankDraft = (employeeUserId, supervisorUserId) => ({
  employeeUserId: employeeUserId || '',
  supervisorUserId: supervisorUserId || '',
  level: null,                  // null = follow where the employee stands until picked
  previousMeetingDate: null,    // null = follow their last warning until typed or cleared
  reasons: [],
  reasonOther: '',
  whatHappened: '',
  whatMustChange: '',
  signInPerson: false,
});

export default function HrWarningForm({ open, onClose, onIssued, presetEmployeeId = null, users = [], currentUserId = null }) {
  const t = useT();
  const F = (field) => t(WARNING_FORM_KEYS[field]);
  const people = useMemo(() => users.filter((u) => u.status === 'active').slice().sort(compareUsersByName), [users]);
  const managers = useMemo(() => people.filter((u) => SUPERVISOR_ROLES.includes(u.role)), [people]);
  const defaultSupervisor = managers.some((u) => u.id === currentUserId) ? currentUserId : '';
  const [d, setD] = useState(() => blankDraft(presetEmployeeId, defaultSupervisor));
  // The employee's own warnings, read once they are picked: HR-4's standing and the prefill.
  const [history, setHistory] = useState(null);   // { standing, previous } | null
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const today = todayKey();

  // A fresh form each time it opens (and for whoever it was opened for).
  useEffect(() => {
    if (open) { setD(blankDraft(presetEmployeeId, defaultSupervisor)); setError(null); setHistory(null); }
  }, [open, presetEmployeeId, defaultSupervisor]);

  useEffect(() => {
    let alive = true;
    setHistory(null);
    if (!open || !d.employeeUserId) return undefined;
    hrWarningsApi.listWarnings({ employeeId: d.employeeUserId })
      .then((r) => {
        if (!alive) return;
        const on = r.today || todayKey();
        setHistory({
          standing: warningStanding(r.warnings || [], d.employeeUserId, on),
          previous: previousMeetingDefault(r.warnings || [], d.employeeUserId, on),
        });
      })
      .catch(() => { if (alive) setHistory(null); });
    return () => { alive = false; };
  }, [open, d.employeeUserId]);

  const standing = history ? history.standing : null;
  const level = d.level || (standing ? standing.nextLevel : WARNING_LEVELS[0]);
  const previousMeetingDate = d.previousMeetingDate ?? (history ? history.previous : null) ?? '';
  const prefilled = d.previousMeetingDate === null && !!previousMeetingDate;
  const set = (patch) => setD((prev) => ({ ...prev, ...patch }));
  const toggleReason = (r) => setD((prev) => ({
    ...prev,
    reasons: prev.reasons.includes(r) ? prev.reasons.filter((x) => x !== r) : normalizeReasons([...prev.reasons, r]),
  }));
  const otherTicked = d.reasons.includes(WARNING_REASON.other);

  const submit = async () => {
    const payload = {
      id: hrWarningsApi.newWarningId(),
      employeeUserId: d.employeeUserId,
      supervisorUserId: d.supervisorUserId,
      level,
      reasons: d.reasons,
      reasonOther: otherTicked ? d.reasonOther : '',
      previousMeetingDate: previousMeetingDate || null,
      whatHappened: d.whatHappened,
      whatMustChange: d.whatMustChange,
      // In person: no bell now (the one-day reminder is still the safety net).
      notifyEmployee: !d.signInPerson,
    };
    const code = warningDraftRefusal(payload, today);
    if (code) { setError(t(WARNING_REFUSAL_KEYS[code])); return; }
    setBusy(true);
    setError(null);
    try {
      const { warning } = await hrWarningsApi.createWarning(payload, { users, currentUserId });
      onIssued && onIssued(warning, { signInPerson: d.signInPerson });
    } catch (e) {
      setError(warningErrorText(t, e));
    } finally { setBusy(false); }
  };

  const standingLine = !d.employeeUserId ? null
    : !standing ? t('common.loading')
      : standing.count === 0 ? t('hrWarn.standing.none')
        : t('hrWarn.standing.count', { count: standing.count, since: day(standing.since), resets: day(standing.resets) });

  return (
    <Modal open={open} onClose={onClose} title={F('title')} size="lg">
      <div className="hrw-form">
        <p className="text-sm text-muted">{t('hrWarn.form.lockedNote')}</p>

        <div className="form-row">
          <FormField label={F('employeeName')} required>
            <FilterSelect ariaLabel={F('employeeName')} value={d.employeeUserId}
              options={[{ value: '', label: t('hrWarn.form.pickEmployee') }, ...people.map((u) => ({ value: u.id, label: u.name }))]}
              onChange={(v) => set({ employeeUserId: v, level: null, previousMeetingDate: null })} />
          </FormField>
          <FormField label={F('date')}>
            <input className="input" value={day(today)} readOnly aria-readonly="true" />
          </FormField>
        </div>
        <FormField label={F('supervisorName')} required>
          <FilterSelect ariaLabel={F('supervisorName')} value={d.supervisorUserId}
            options={[{ value: '', label: t('hrWarn.form.pickSupervisor') }, ...managers.map((u) => ({ value: u.id, label: u.name }))]}
            onChange={(v) => set({ supervisorUserId: v })} />
        </FormField>
        {standingLine && <p className="hrw-standing text-sm" role="status">{standingLine}</p>}

        <FormField label={t('hrWarn.field.level')} required help={standing && standing.count > 0 ? t('hrWarn.form.levelHelp') : undefined}>
          <div className="tab-container-line" role="group" aria-label={t('hrWarn.field.level')}>
            {WARNING_LEVELS.map((l) => (
              <button key={l} type="button" className={`tab-btn ${level === l ? 'active' : ''}`} aria-pressed={level === l}
                onClick={() => set({ level: l })}>
                {t(WARNING_LEVEL_KEYS[l])}
              </button>
            ))}
          </div>
        </FormField>

        <FormField label={F('previousMeeting')} type="date" value={previousMeetingDate} max={today}
          help={prefilled ? t('hrWarn.form.previousHelp') : t('hrWarn.form.optional')}
          onChange={(e) => set({ previousMeetingDate: e.target.value })} />

        <fieldset className="hrw-reasons">
          <legend className="form-label">{F('reasonsHeading')}<span className="form-required" aria-hidden> *</span></legend>
          {WARNING_REASONS.map((r) => (
            <label key={r} className="hrw-reason">
              <input type="checkbox" checked={d.reasons.includes(r)} onChange={() => toggleReason(r)} />
              <span>{t(WARNING_REASON_KEYS[r])}</span>
            </label>
          ))}
          {otherTicked && (
            <input className="input hrw-reason-other" value={d.reasonOther} maxLength={WARNING_TEXT_MAX.reasonOther}
              aria-label={t('hrWarn.field.reasonOther')} placeholder={t('hrWarn.field.reasonOther')}
              onChange={(e) => set({ reasonOther: e.target.value })} />
          )}
        </fieldset>

        <FormField label={F('details')} as="textarea" rows={4} required value={d.whatHappened}
          maxLength={WARNING_TEXT_MAX.whatHappened} onChange={(e) => set({ whatHappened: e.target.value })} />
        <FormField label={F('corrective')} as="textarea" rows={4} required value={d.whatMustChange}
          maxLength={WARNING_TEXT_MAX.whatMustChange} onChange={(e) => set({ whatMustChange: e.target.value })} />

        <FormField label={t('hrWarn.form.howSign')}>
          <div className="tab-container-line" role="group" aria-label={t('hrWarn.form.howSign')}>
            <button type="button" className={`tab-btn ${!d.signInPerson ? 'active' : ''}`} aria-pressed={!d.signInPerson} onClick={() => set({ signInPerson: false })}>
              {t('hrWarn.form.signPhone')}
            </button>
            <button type="button" className={`tab-btn ${d.signInPerson ? 'active' : ''}`} aria-pressed={d.signInPerson} onClick={() => set({ signInPerson: true })}>
              {t('hrWarn.form.signInPerson')}
            </button>
          </div>
        </FormField>
        <p className="text-xs text-muted">{d.signInPerson ? t('hrWarn.form.signInPersonHelp') : t('hrWarn.form.signPhoneHelp')}</p>

        {error && <div className="callout callout-warning" role="alert">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn btn-outline" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>{t('hrWarn.form.submit')}</button>
        </div>
      </div>
    </Modal>
  );
}
