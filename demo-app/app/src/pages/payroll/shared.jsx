// Shared presentational helpers for the Payroll views. Colours live in CSS classes
// (no raw hex — lint:design). Money is formatted through lib/dates money() so it
// rounds identically to the ledger (cents always shown). See lib/payroll.js for math.
import { money } from '../../lib/dates';
import { minutesToHours } from '../../lib/payroll';

export const fmtMoney = (n) => (n == null ? '—' : money(n));
export const fmtSigned = (n) => {
  if (n == null || n === 0) return n === 0 ? '—' : '—';
  return (n < 0 ? '-' : '+') + money(Math.abs(n));
};
export const fmtHours = (min) => (min == null ? '—' : `${minutesToHours(min).toFixed(1)}h`);

export const PAY_TYPE = {
  hourly: { label: 'Hourly', cls: 'pt-hourly' },
  salary: { label: 'Salary', cls: 'pt-salary' },
  per_visit: { label: 'Per-visit', cls: 'pt-visit' },
  none: { label: 'Not on payroll', cls: 'pt-none' },
};

export function PayTypeBadge({ type }) {
  const t = PAY_TYPE[type] || { label: 'Pay not set', cls: 'pt-unset' };
  return <span className={`pay-type ${t.cls}`}>{t.label}</span>;
}

// A member who is no longer active stays on the run for pay they earned this period
// (usePayrollRun / payRunRoster); the tag says why they're still here.
export function StatusTag({ row }) {
  if (!row || !row.inactive) return null;
  return <span className="pay-status-tag">{row.user.status === 'invited' ? 'Invited' : 'Disabled'}</span>;
}

export const LINE_CATEGORY = {
  bonus: { label: 'Bonus', cls: 'lc-bonus' },
  special: { label: 'Special service', cls: 'lc-special' },
  reimbursement: { label: 'Reimbursement', cls: 'lc-reimb' },
  tip: { label: 'Tip', cls: 'lc-tip' },
  deduction: { label: 'Deduction', cls: 'lc-ded' },
};

// A short one-line description of how a person is paid, for row subtitles.
export function rateSummary(pay) {
  if (!pay || !pay.type) return 'Pay not set';
  if (pay.type === 'hourly') return `${money(pay.hourlyRate || 0)}/hr · OT ×1.5`;
  if (pay.type === 'salary') return `${money(pay.salaryPerPeriod || 0)}/period`;
  if (pay.type === 'per_visit') return `${money(pay.perVisitRate || 0)}/clean`;
  return 'Owner draw — not on payroll';
}
