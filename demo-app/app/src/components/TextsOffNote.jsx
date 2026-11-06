// "Texts off: replied STOP on Oct 28, 2026" — read-only, under a number that has texts off
// (hooks/useCustomerTextStatus). Nothing for a number that may be texted. The office cannot turn
// texts back on: only the customer can, by texting START.
import { useT } from '../i18n/react';
import { fmtDate } from '../lib/dates';

export default function TextsOffNote({ optedOutAt, className = 'text-xs text-muted' }) {
  const t = useT();
  if (!optedOutAt) return null;
  return (
    <div className={className} title={t('textsOff.hint')}>
      {t('textsOff.note', { date: fmtDate(optedOutAt, { month: 'short', day: 'numeric', year: 'numeric' }) })}
    </div>
  );
}
