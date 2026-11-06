// A deal's walkthrough fields (lib/walkthrough): the date and the time on the ORG's clock, and where
// to meet. One component for the deal editor (OpportunityDetailModal) and the question that opens
// after a deal moves into "Walkthrough Scheduled" (WalkthroughPrompt), so both write the same thing.
// Kit pieces only (FormField, .form-row, .form-help); words from the catalog (UI_RULES §140).
//
//   value     { date: 'YYYY-MM-DD', time: 'HH:MM', where }   (lib/walkthrough walkthroughFields)
//   onChange  (next value) → void
//   errors    { date?, time? } from walkthroughPatch's `error`
//   contactId the person the deal runs through: the notice says whether a confirmation goes to them
import { useStore } from '../store';
import { useT } from '../i18n/react';
import { normalizeHm } from '../lib/dates';
import { WALKTHROUGH_WHERE_MAX } from '../lib/walkthrough';
import { MESSAGE_KEY } from '../lib/customerMessages';
import FormField from './FormField';

export default function WalkthroughFields({ value, onChange, errors = {}, contactId = null, autoFocus = false, disabled = false }) {
  const t = useT();
  const v = value || { date: '', time: '', where: '' };
  const set = (patch) => onChange?.({ ...v, ...patch });
  return (
    <>
      <div className="form-row">
        <FormField label={t('walkthrough.date')} name="walkthrough-date" type="date" value={v.date} disabled={disabled} autoFocus={autoFocus}
          error={errors.date ? t('walkthrough.error.date') : undefined}
          onChange={(e) => set({ date: e.target.value })} />
        {/* A native time field gives "HH:MM"; one that degrades to text is read on blur (normalizeHm),
            and walkthroughPatch refuses what still is not a time. */}
        <FormField label={t('walkthrough.time')} name="walkthrough-time" type="time" step={900} value={v.time} disabled={disabled}
          error={errors.time ? t('walkthrough.error.time') : undefined}
          onChange={(e) => set({ time: e.target.value })}
          onBlur={() => { const n = normalizeHm(v.time); if (n && n !== v.time) set({ time: n }); }} />
      </div>
      <FormField label={t('walkthrough.where')} name="walkthrough-where" value={v.where} disabled={disabled} maxLength={WALKTHROUGH_WHERE_MAX}
        placeholder={t('walkthrough.wherePlaceholder')}
        onChange={(e) => set({ where: e.target.value })} />
      <WalkthroughNotice contactId={contactId} />
    </>
  );
}

// Whether a confirmation will go, and to whom: the message's switch (Settings → Customer Reminders)
// and the contact's address, the same two things the walker asks (lib/reminderScheduler).
export function WalkthroughNotice({ contactId }) {
  const t = useT();
  const state = useStore();
  const on = (state.reminderTemplates || []).some((x) => x?.key === MESSAGE_KEY.walkthroughConfirm && x.enabled === true);
  const person = contactId ? (state.contacts || []).find((c) => c.id === contactId) : null;
  const name = person ? `${person.firstName || ''} ${person.lastName || ''}`.trim() || person.email || '' : '';
  let line;
  if (!on) line = t('walkthrough.notice.off');
  else if (!person) line = t('walkthrough.notice.noContact');
  else if (!String(person.email || '').trim()) line = t('walkthrough.notice.noEmail', { name });
  else line = t('walkthrough.notice.sends', { name });
  return <p className="form-help">{line}</p>;
}
