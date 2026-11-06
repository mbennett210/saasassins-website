// THE PAY TYPES a member can be on, and each one's rate field: one list for the member's Pay tab
// (pages/settings/TeamDetail) and Add Team Member (components/AddUserModal, task #470), so the two
// never offer a different type or name a rate differently. `value` is `users[].pay.type` as the
// pay run reads it (lib/payroll); `field` is the key its rate is stored under, in dollars; "Not on
// payroll" has no rate. Pure and node-safe (scripts/test-add-member-setup.mjs reads it).
export const PAY_TYPES = [
  { value: 'hourly', label: 'Hourly', field: 'hourlyRate', rateLabel: 'Hourly rate ($/hr)' },
  { value: 'salary', label: 'Salary (per pay period)', field: 'salaryPerPeriod', rateLabel: 'Salary ($/pay period)' },
  { value: 'per_visit', label: 'Per-visit (flat rate per clean)', field: 'perVisitRate', rateLabel: 'Rate per clean ($)' },
  { value: 'none', label: 'Not on payroll', field: null, rateLabel: null },
];

export const payTypeOf = (value) => PAY_TYPES.find((p) => p.value === value) || null;
