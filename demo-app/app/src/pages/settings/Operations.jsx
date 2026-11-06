// Ops Settings — the org-wide clock/variance/pay tunables that drive live behavior.
// Each cluster is its OWN card with its OWN Save, so changing (say) the geofence does
// not require re-saving payroll: every Save dispatches UPDATE_OPS_SETTINGS with ONLY
// that card's fields. These knobs were dev-data-op-only (opsSettings in the blob, no
// UI); this surface makes them owner/admin-editable. Readers all default hard values,
// so an un-backfilled blob keeps working (CLEANSPACE_SWEPT.md §2.3 / §5.4 / §5.5).
//
// Distances are stored in METERS (the geofence math is metric) but shown/entered in
// FEET (what Clean Space thinks in) — convert only at this render edge (lib/geo.js).
import { useState, useEffect } from 'react';
import { useDispatch, useStore } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { useToast } from '../../components/Toast';
import FormField from '../../components/FormField';
import {
  DEFAULT_GEOFENCE_RADIUS_M, DEFAULT_GEOFENCE_RADIUS_FT,
  metersToFeet, feetToMeters,
} from '../../lib/geo';
import {
  DEFAULT_DRIVE_MAX_GAP_MINS, DEFAULT_DRIVE_FLAG_PCT, DEFAULT_DRIVE_GRACE_MINS, drivePayEnabled,
} from '../../lib/driveTime';
import {
  OPS_ALERT_DEFAULTS, MAX_SHIFT_LOOKBACK_HOURS, MAX_INSPECTION_REMINDER_DAYS,
  MAX_CHECKLIST_LEAD_MINS, MAX_MISSED_AFTER_START_MINS, missedAfterStartMins,
} from '../../lib/opsAlerts';
import { MAX_PRESHIFT_LEAD_MINS, preShiftReminderMins } from '../../lib/preShiftReminders';
import {
  TICKET_ALERT_DEFAULTS, MIN_TICKET_INTERVAL_MINS, MAX_TICKET_INTERVAL_MINS, MAX_TICKET_LOOKBACK_DAYS,
  ticketRepeatMins, ticketEscalateMins, ticketOpenRepeatMins, ticketAlertLookbackDays,
} from '../../lib/ticketAlerts';
import {
  OFFICE_HOURS_DEFAULTS, WEEKDAY_SHORT, officeHoursConfig, fmtHhMm, officeHoursSummary,
} from '../../lib/officeHours';
import { SUPERVISOR_ROLES, ROLE_LABELS } from '../../lib/roles';
import {
  TICKET_FLAG_DAYS, DEFAULT_TICKET_FLAG_COUNT, MAX_TICKET_FLAG_COUNT, ticketFlagThreshold,
  WO_PRIORITIES, WO_PRIORITY_META, slaTargetLabel, TYPE_DEADLINE_HOURS, typeTargetLabel,
} from '../../lib/workOrders';
import {
  DEFAULT_SUPPLY_ORDER_DAY, MAX_SUPPLY_ORDER_DAY, orgSupplyOrderDay,
} from '../../lib/supplies';
import * as payrollApi from '../../lib/payrollApi';
import { PAY_DATE_DEFAULTS, payDateConfigOf } from '../../lib/payroll';

const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback);
const PAY_CADENCES = ['weekly', 'biweekly', 'semimonthly'];
// The ticket alerts' help names each client request type's deadline (WO-20, lib/workOrders
// TYPE_DEADLINE_HOURS); these are the types' words there.
const DEADLINE_TYPE_WORDS = { complaint: 'a complaint', request: 'a request', failed_inspection: 'a failed inspection' };
// PAY-19 (Matt ★a: Sunday). The workweek start decides where a weekly/biweekly PERIOD begins AND
// where the weekly 40-hour overtime line is walked, so it is frozen with the cadence once a run
// exists — past runs have to stay reproducible.
const WEEK_START_DAYS = [
  { value: 0, label: 'Sunday' }, { value: 1, label: 'Monday' }, { value: 2, label: 'Tuesday' },
  { value: 3, label: 'Wednesday' }, { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' },
  { value: 6, label: 'Saturday' },
];
const weekStartOf = (v) => (WEEK_START_DAYS.some((d) => d.value === Number(v)) ? Number(v) : 0);
const PENDING_POLICIES = ['rollForward', 'block'];

function SaveBar() {
  return (
    <div className="modal-actions">
      <button type="submit" className="btn btn-primary">Save</button>
    </div>
  );
}

export default function SettingsOperations() {
  const state = useStore();
  const ops = state.opsSettings || {};
  const dispatch = useDispatch();
  const toast = useToast();

  // SUP-9 ★a: who may be NAMED as the org's single supply approver. Office roles only
  // (SUPERVISOR_ROLES — the same tiers the account-supervisor picker offers), active members
  // only, because the pick is a person expected to act. A STALE pick is kept selectable for
  // display so the setting does not silently read as "nobody"; the fan-out and
  // resolveSupplyApprover already skip a member who is no longer active or eligible.
  const supplyApproverOptions = (state.users || [])
    .filter((u) => u && u.id && (
      (u.status === 'active' && SUPERVISOR_ROLES.includes(u.role)) || u.id === (ops.supplyApproverUserId || null)
    ))
    .map((u) => ({ value: u.id, label: `${u.name || u.id}${u.status === 'active' && SUPERVISOR_ROLES.includes(u.role) ? '' : ' (no longer eligible)'} · ${ROLE_LABELS[u.role] || u.role}` }));

  const toForm = (o) => ({
    radiusFt: metersToFeet(Number.isFinite(o.defaultGeofenceRadiusM) ? o.defaultGeofenceRadiusM : DEFAULT_GEOFENCE_RADIUS_M) ?? DEFAULT_GEOFENCE_RADIUS_FT,
    autoCloseGraceMins: Number.isFinite(o.autoCloseGraceMins) ? o.autoCloseGraceMins : 120,
    varianceFlagOverMins: Number.isFinite(o.varianceFlagOverMins) ? o.varianceFlagOverMins : 15,
    varianceFlagUnderMins: Number.isFinite(o.varianceFlagUnderMins) ? o.varianceFlagUnderMins : 15,
    expectedBasis: o.expectedBasis === 'wallclock' ? 'wallclock' : 'labor',
    driveMaxGapMins: Number.isFinite(o.driveMaxGapMins) ? o.driveMaxGapMins : DEFAULT_DRIVE_MAX_GAP_MINS,
    driveVarianceFlagPct: Number.isFinite(o.driveVarianceFlagPct) ? o.driveVarianceFlagPct : DEFAULT_DRIVE_FLAG_PCT,
    driveVarianceGraceMins: Number.isFinite(o.driveVarianceGraceMins) ? o.driveVarianceGraceMins : DEFAULT_DRIVE_GRACE_MINS,
    otMultiplier: Number.isFinite(o.otMultiplier) ? o.otMultiplier : 1.5,
    payPeriodCadence: PAY_CADENCES.includes(o.payPeriodCadence) ? o.payPeriodCadence : 'biweekly',
    payWeekStartDay: weekStartOf(o.payWeekStartDay),
    // PAY-2 — the payday. Read through lib/payroll's ONE reader, so the form, the run and the
    // exported file cannot disagree about the defaults.
    payDateSemiFirstHalfDay: payDateConfigOf(o).semiFirstHalfDay,
    payDateSemiSecondHalfDay: payDateConfigOf(o).semiSecondHalfDay,
    payDateDaysAfterPeriodEnd: payDateConfigOf(o).daysAfterPeriodEnd,
    payrollPendingPolicy: o.payrollPendingPolicy === 'block' ? 'block' : 'rollForward',
    payDriveTime: drivePayEnabled(o),
    // ALR-11: the ONE shift-alert timing, read through its own clamped reader.
    missedAfterStartMins: missedAfterStartMins(o),
    shiftAlertLookbackHours: Number.isFinite(o.shiftAlertLookbackHours) ? o.shiftAlertLookbackHours : OPS_ALERT_DEFAULTS.shiftAlertLookbackHours,
    checklistReminderBeforeEndMins: Number.isFinite(o.checklistReminderBeforeEndMins) ? o.checklistReminderBeforeEndMins : OPS_ALERT_DEFAULTS.checklistReminderBeforeEndMins,
    checklistEscalateGraceMins: Number.isFinite(o.checklistEscalateGraceMins) ? o.checklistEscalateGraceMins : OPS_ALERT_DEFAULTS.checklistEscalateGraceMins,
    inspectionReminderDays: Number.isFinite(o.inspectionReminderDays) ? o.inspectionReminderDays : OPS_ALERT_DEFAULTS.inspectionReminderDays,
    ticketFlagCount30d: ticketFlagThreshold(o),
    // ALR-5 · WO-5/WO-16 · WO-7 — every reader hard-defaults, so the form shows the value that
    // is actually in force whether or not the blob carries the key.
    preShiftReminderMins: preShiftReminderMins(o),
    ticketRepeatMins: ticketRepeatMins(o),
    ticketEscalateMins: ticketEscalateMins(o),
    ticketOpenRepeatMins: ticketOpenRepeatMins(o),
    ticketAlertLookbackDays: ticketAlertLookbackDays(o),
    officeHoursDays: officeHoursConfig(o).days,
    officeHoursStart: fmtHhMm(officeHoursConfig(o).startMins),
    officeHoursEnd: fmtHhMm(officeHoursConfig(o).endMins),
    // SUP-8 / SUP-9: the org-default supply order day, and the named approver ('' = the
    // building's supervisor, which is the default).
    supplyOrderDayOfMonth: orgSupplyOrderDay(o),
    supplyApproverUserId: typeof o.supplyApproverUserId === 'string' ? o.supplyApproverUserId : '',
  });
  const [form, setForm] = useState(() => toForm(ops));
  useEffect(() => { setForm(toForm(ops)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ops.defaultGeofenceRadiusM, ops.autoCloseGraceMins, ops.varianceFlagOverMins, ops.varianceFlagUnderMins, ops.expectedBasis, ops.driveMaxGapMins, ops.driveVarianceFlagPct, ops.driveVarianceGraceMins, ops.otMultiplier, ops.payPeriodCadence, ops.payrollPendingPolicy, ops.payDriveTime, ops.missedAfterStartMins, ops.shiftAlertLookbackHours, ops.checklistReminderBeforeEndMins, ops.checklistEscalateGraceMins, ops.inspectionReminderDays, ops.ticketFlagCount30d, ops.preShiftReminderMins, ops.ticketRepeatMins, ops.ticketEscalateMins, ops.ticketOpenRepeatMins, ops.ticketAlertLookbackDays, ops.officeHoursStart, ops.officeHoursEnd, JSON.stringify(ops.officeHoursDays), ops.payWeekStartDay, ops.payDateSemiFirstHalfDay, ops.payDateSemiSecondHalfDay, ops.payDateDaysAfterPeriodEnd, ops.supplyOrderDayOfMonth, ops.supplyApproverUserId]);

  // Once a pay period has been CLOSED the pay schedule is frozen (spec §2 / §8.5): the cadence
  // (and pay-week start) can't change, so past runs stay reproducible. Mirror the server's rule
  // by disabling the cadence once any run exists. Read-only; the server (orgStateGuard) enforces.
  // If the runs read FAILS we FAIL CLOSED ('unknown'): a refused org-state save drops the whole
  // pending batch, so a cadence we can't verify is safe to change must stay disabled, not editable
  // (W4-F finding 1 — the old `.catch(() => {})` left it editable and a save 403'd, losing the batch).
  const [scheduleLock, setScheduleLock] = useState(null); // null editable · 'closed' a run exists · 'unknown' couldn't check
  useEffect(() => {
    let alive = true;
    payrollApi.runs()
      .then((r) => { if (alive) setScheduleLock(Array.isArray(r) && r.length > 0 ? 'closed' : null); })
      .catch(() => { if (alive) setScheduleLock('unknown'); });
    return () => { alive = false; };
  }, []);
  const scheduleLocked = scheduleLock !== null;

  // Each card commits ONLY its own fields — a scoped UPDATE_OPS_SETTINGS patch.
  const commit = (patch, label) => { dispatch({ type: ACTIONS.UPDATE_OPS_SETTINGS, patch }); toast.success(label); };

  // 🔴 PAY-21 (Matt, 2026-09-30): with drive time switched OFF, its REPORT is hidden — and
  // so is everything that only means something while it is on. These three tunables (the gap
  // cap, the over-estimate flag and its grace) configure a surface nobody can open, so the
  // whole card goes rather than sitting there inviting a setting with no effect. The TOGGLE
  // that brings it all back lives on the Payroll card above, so this can never strand itself.
  // Read through the ONE shared predicate (lib/driveTime), the same one Variance, Reports ›
  // Hours and the pay run use; nothing per-leg is stored, so flipping it back restores the
  // surfaces with no backfill.
  const driveSurfaces = drivePayEnabled(ops);

  const saveGeofence = (e) => {
    e.preventDefault();
    const radiusFt = Math.max(50, num(form.radiusFt, DEFAULT_GEOFENCE_RADIUS_FT));
    commit({
      defaultGeofenceRadiusM: Math.round(feetToMeters(radiusFt)),
      autoCloseGraceMins: Math.max(0, num(form.autoCloseGraceMins, 120)),
    }, 'Clock-in geofence saved');
  };
  const saveVariance = (e) => {
    e.preventDefault();
    commit({
      varianceFlagOverMins: Math.max(0, num(form.varianceFlagOverMins, 15)),
      varianceFlagUnderMins: Math.max(0, num(form.varianceFlagUnderMins, 15)),
      expectedBasis: form.expectedBasis === 'wallclock' ? 'wallclock' : 'labor',
    }, 'Variance flagging saved');
  };
  const saveDrive = (e) => {
    e.preventDefault();
    commit({
      driveMaxGapMins: Math.max(15, num(form.driveMaxGapMins, DEFAULT_DRIVE_MAX_GAP_MINS)),
      driveVarianceFlagPct: Math.max(0, num(form.driveVarianceFlagPct, DEFAULT_DRIVE_FLAG_PCT)),
      driveVarianceGraceMins: Math.max(0, num(form.driveVarianceGraceMins, DEFAULT_DRIVE_GRACE_MINS)),
    }, 'Drive time saved');
  };
  const savePayroll = (e) => {
    e.preventDefault();
    // The cadence is frozen once a run exists (the server refuses the change) — never send a
    // changed cadence in that case, keep the committed one.
    const cadenceToSave = scheduleLocked ? (PAY_CADENCES.includes(ops.payPeriodCadence) ? ops.payPeriodCadence : 'biweekly')
      : (PAY_CADENCES.includes(form.payPeriodCadence) ? form.payPeriodCadence : 'biweekly');
    // PAY-19: the pay-week START is frozen with the cadence (the server refuses either change
    // once a run exists), so never send a changed one in that case — keep the committed value.
    const weekStartToSave = scheduleLocked ? weekStartOf(ops.payWeekStartDay) : weekStartOf(form.payWeekStartDay);
    commit({
      otMultiplier: Math.max(1, num(form.otMultiplier, 1.5)),
      payPeriodCadence: cadenceToSave,
      payWeekStartDay: weekStartToSave,
      // PAY-2: the payday. NOT frozen by a closed run — each run STORES the date it paid on
      // (computePayRun → file.payDateKey), so changing the schedule never rewrites a past run.
      payDateSemiFirstHalfDay: Math.min(31, Math.max(1, num(form.payDateSemiFirstHalfDay, PAY_DATE_DEFAULTS.semiFirstHalfDay))),
      payDateSemiSecondHalfDay: Math.min(31, Math.max(1, num(form.payDateSemiSecondHalfDay, PAY_DATE_DEFAULTS.semiSecondHalfDay))),
      payDateDaysAfterPeriodEnd: Math.min(60, Math.max(0, num(form.payDateDaysAfterPeriodEnd, PAY_DATE_DEFAULTS.daysAfterPeriodEnd))),
      payrollPendingPolicy: PENDING_POLICIES.includes(form.payrollPendingPolicy) ? form.payrollPendingPolicy : 'rollForward',
      payDriveTime: !!form.payDriveTime,
    }, 'Payroll settings saved');
  };
  const saveAlerts = (e) => {
    e.preventDefault();
    commit({
      // ALR-11: the one mark, clamped exactly as its reader clamps it.
      missedAfterStartMins: Math.min(MAX_MISSED_AFTER_START_MINS, Math.max(0, num(form.missedAfterStartMins, OPS_ALERT_DEFAULTS.missedAfterStartMins))),
      shiftAlertLookbackHours: Math.min(MAX_SHIFT_LOOKBACK_HOURS, Math.max(1, num(form.shiftAlertLookbackHours, OPS_ALERT_DEFAULTS.shiftAlertLookbackHours))),
      // ALR-5: 0 turns the pre-shift reminder off — there is no second toggle to disagree with.
      preShiftReminderMins: Math.min(MAX_PRESHIFT_LEAD_MINS, Math.max(0, num(form.preShiftReminderMins, OPS_ALERT_DEFAULTS.preShiftReminderMins))),
    }, 'Shift alerts saved');
  };
  // WO-17 (unanswered) — the org's working days and hours, which every non-urgent ticket alert
  // waits for (WO-7). Saved as its own card so answering WO-17 is one edit.
  const saveOfficeHours = (e) => {
    e.preventDefault();
    const days = (form.officeHoursDays || []).filter((d) => Number.isInteger(d));
    commit({
      officeHoursDays: days.length ? [...days].sort((a, b) => a - b) : [...OFFICE_HOURS_DEFAULTS.officeHoursDays],
      officeHoursStart: form.officeHoursStart || OFFICE_HOURS_DEFAULTS.officeHoursStart,
      officeHoursEnd: form.officeHoursEnd || OFFICE_HOURS_DEFAULTS.officeHoursEnd,
    }, 'Office hours saved');
  };
  // WO-5 + WO-16 — how often an unanswered ticket is chased, and when it goes up the chain.
  const saveTicketAlerts = (e) => {
    e.preventDefault();
    const interval = (v, d) => Math.min(MAX_TICKET_INTERVAL_MINS, Math.max(MIN_TICKET_INTERVAL_MINS, num(v, d)));
    commit({
      ticketRepeatMins: interval(form.ticketRepeatMins, TICKET_ALERT_DEFAULTS.ticketRepeatMins),
      // The escalation DELAY may be 0 ("tell the office at once"), unlike the intervals.
      ticketEscalateMins: Math.min(MAX_TICKET_INTERVAL_MINS, Math.max(0, num(form.ticketEscalateMins, TICKET_ALERT_DEFAULTS.ticketEscalateMins))),
      ticketOpenRepeatMins: interval(form.ticketOpenRepeatMins, TICKET_ALERT_DEFAULTS.ticketOpenRepeatMins),
      ticketAlertLookbackDays: Math.min(MAX_TICKET_LOOKBACK_DAYS, Math.max(1, num(form.ticketAlertLookbackDays, TICKET_ALERT_DEFAULTS.ticketAlertLookbackDays))),
    }, 'Ticket alerts saved');
  };
  const toggleOfficeDay = (day) => setForm((f) => {
    const have = new Set(f.officeHoursDays || []);
    if (have.has(day)) have.delete(day); else have.add(day);
    return { ...f, officeHoursDays: [...have].sort((a, b) => a - b) };
  });
  const saveReminders = (e) => {
    e.preventDefault();
    commit({
      checklistReminderBeforeEndMins: Math.min(MAX_CHECKLIST_LEAD_MINS, Math.max(0, num(form.checklistReminderBeforeEndMins, OPS_ALERT_DEFAULTS.checklistReminderBeforeEndMins))),
      checklistEscalateGraceMins: Math.max(0, num(form.checklistEscalateGraceMins, OPS_ALERT_DEFAULTS.checklistEscalateGraceMins)),
      inspectionReminderDays: Math.min(MAX_INSPECTION_REMINDER_DAYS, Math.max(1, num(form.inspectionReminderDays, OPS_ALERT_DEFAULTS.inspectionReminderDays))),
      // WO-14: the ticket count that flags an account over the fixed 30-day window.
      ticketFlagCount30d: Math.min(MAX_TICKET_FLAG_COUNT, Math.max(1, num(form.ticketFlagCount30d, DEFAULT_TICKET_FLAG_COUNT))),
    }, 'Reminders saved');
  };

  // SUP-7 / SUP-8 / SUP-9: the supply card commits only its own two fields.
  const saveSupplies = (e) => {
    e.preventDefault();
    commit({
      supplyOrderDayOfMonth: Math.min(MAX_SUPPLY_ORDER_DAY, Math.max(1, num(form.supplyOrderDayOfMonth, DEFAULT_SUPPLY_ORDER_DAY))),
      // Stored as null when nobody is named, so resolveSupplyApprover reads a cleared picker
      // exactly as it reads an absent field: the building's supervisor approves.
      supplyApproverUserId: form.supplyApproverUserId || null,
    }, 'Supplies saved');
  };

  return (
    <div>
      <div className="page-head-text">
        <h1 className="page-head-title">Operations</h1>
        <p className="text-muted text-sm">Org-wide settings for clock-in, variance, drive time, payroll and alerts. Each section saves on its own.</p>
      </div>

      <form className="card detail-card" onSubmit={saveGeofence}>
        <h3 className="dash-card-title">Clock-in geofence</h3>
        <div className="form-row">
          {/* step MUST divide (value − min) or the browser blocks the whole form's
              submit with "the two nearest valid values are…" and Save silently does
              nothing. The radius is stored in METERS and rendered back through
              metersToFeet, so it lands on arbitrary feet (76 m → 249 ft). A step of
              10 made the seeded default unsubmittable, i.e. this page could not be
              saved at all. Keep numeric steps at 1 wherever the value is derived. */}
          <FormField
            label="Default radius (feet)" type="number" min="50" step="1"
            value={form.radiusFt}
            onChange={(e) => setForm({ ...form, radiusFt: e.target.value })}
            help={`How close crew must be to a site to clock in. Applies to every site (per-site radius is not used). ≈ ${Math.round(feetToMeters(num(form.radiusFt, DEFAULT_GEOFENCE_RADIUS_FT)))} m.`}
          />
          <FormField
            label="Auto-close grace (minutes)" type="number" min="0" step="15"
            value={form.autoCloseGraceMins}
            onChange={(e) => setForm({ ...form, autoCloseGraceMins: e.target.value })}
            help="A forgotten clock-out auto-closes this long after the clean's scheduled end (capped at the scheduled end, so labor is never inflated)."
          />
        </div>
        <SaveBar />
      </form>

      <form className="card detail-card" onSubmit={saveVariance}>
        <h3 className="dash-card-title">Variance flagging</h3>
        <div className="form-row">
          <FormField
            label="Flag when OVER by (minutes)" type="number" min="0" step="5"
            value={form.varianceFlagOverMins}
            onChange={(e) => setForm({ ...form, varianceFlagOverMins: e.target.value })}
            help="Actual labor this much above expected flags the clean red (unbudgeted labor)."
          />
          <FormField
            label="Flag when UNDER by (minutes)" type="number" min="0" step="5"
            value={form.varianceFlagUnderMins}
            onChange={(e) => setForm({ ...form, varianceFlagUnderMins: e.target.value })}
            help="Actual labor this much below expected flags the clean amber (left early / quality risk)."
          />
        </div>
        <FormField
          label="Expected-time basis" as="select"
          value={form.expectedBasis}
          onChange={(e) => setForm({ ...form, expectedBasis: e.target.value })}
          options={[
            { value: 'labor', label: 'Labor-minutes (sum of each cleaner’s clocked time)' },
            { value: 'wallclock', label: 'Wall-clock (elapsed time the site was occupied)' },
          ]}
          help="How the expected time is compared to actual. Labor-minutes suits a labor-cost-driven operation (2 cleaners × 2h = 4 labor-hours)."
        />
        <SaveBar />
      </form>

      {driveSurfaces && (
      <form className="card detail-card" onSubmit={saveDrive}>
        <h3 className="dash-card-title">Drive time between jobs</h3>
        <p className="text-muted text-sm" style={{ marginTop: -4 }}>
          Time between clocking out of one clean and into the next is paid drive time. The commute from home to the first clean, and from the last clean home, is never counted.
        </p>
        <div className="form-row">
          <FormField
            label="Count a gap up to (minutes)" type="number" min="15" step="15"
            value={form.driveMaxGapMins}
            onChange={(e) => setForm({ ...form, driveMaxGapMins: e.target.value })}
            help="Longer gaps are treated as a break or the end of the shift, not a drive."
          />
          <FormField
            label="Flag when over estimate by (%)" type="number" min="0" step="1"
            value={form.driveVarianceFlagPct}
            onChange={(e) => setForm({ ...form, driveVarianceFlagPct: e.target.value })}
            help="Actual drive time this far above the mapped estimate flags the leg red for review."
          />
        </div>
        <FormField
          label="Grace on short drives (minutes)" type="number" min="0" step="1"
          value={form.driveVarianceGraceMins}
          onChange={(e) => setForm({ ...form, driveVarianceGraceMins: e.target.value })}
          help={`An absolute cushion added on top of the percentage, so a short hop isn't flagged over a minute or two. A ${num(form.driveVarianceFlagPct, DEFAULT_DRIVE_FLAG_PCT)}% + ${num(form.driveVarianceGraceMins, DEFAULT_DRIVE_GRACE_MINS)} min rule flags a 20-minute estimate at ${Math.round(20 * (1 + num(form.driveVarianceFlagPct, DEFAULT_DRIVE_FLAG_PCT) / 100) + num(form.driveVarianceGraceMins, DEFAULT_DRIVE_GRACE_MINS)) + 1} minutes or more.`}
        />
        <SaveBar />
      </form>
      )}

      <form className="card detail-card" onSubmit={savePayroll}>
        <h3 className="dash-card-title">Payroll</h3>
        <p className="text-muted text-sm" style={{ marginTop: -4 }}>
          Only approved hours are paid. Overtime is computed weekly at 40 hours and paid at this multiplier once a manager approves it.
        </p>
        <div className="form-row">
          <FormField
            label="Overtime multiplier" type="number" min="1" step="any"
            value={form.otMultiplier}
            onChange={(e) => setForm({ ...form, otMultiplier: e.target.value })}
            help="OT pay = overtime hours × rate × this. The US default is 1.5× (time-and-a-half)."
          />
          <FormField
            label="Pay-period cadence" as="select"
            value={form.payPeriodCadence}
            onChange={(e) => setForm({ ...form, payPeriodCadence: e.target.value })}
            disabled={scheduleLocked}
            options={[
              { value: 'semimonthly', label: 'Semi-monthly (1st–15th, 16th–end of month)' },
              { value: 'biweekly', label: 'Biweekly (every 2 weeks)' },
              { value: 'weekly', label: 'Weekly' },
            ]}
            help={scheduleLock === 'closed'
              ? 'Locked once a pay period has been closed — the pay schedule (cadence and pay-week start) is frozen so past runs stay reproducible.'
              : scheduleLock === 'unknown'
                ? "Couldn't check whether payroll has been closed."
                : 'Semi-monthly pays the 1st–15th and 16th–end of each month (Feb ends on the 28th/29th). Overtime stays weekly (40h): when a workweek straddles the split, the over-40h hours are paid in the half of the month they were worked.'}
          />
        </div>
        <div className="form-row">
          {/* PAY-19 (Matt ★a: Sunday). Frozen with the cadence once a run exists — the same lock,
              because both decide where a period begins and the server refuses either change. */}
          <FormField
            label="Workweek starts on" as="select"
            value={String(form.payWeekStartDay)}
            onChange={(e) => setForm({ ...form, payWeekStartDay: weekStartOf(e.target.value) })}
            disabled={scheduleLocked}
            options={WEEK_START_DAYS.map((d) => ({ value: String(d.value), label: d.label }))}
            help={scheduleLock === 'closed'
              ? 'Locked once a pay period has been closed, with the cadence — past runs stay reproducible.'
              : scheduleLock === 'unknown'
                ? "Couldn't check whether payroll has been closed."
                : 'The day the 40-hour overtime week begins. Sunday is the US payroll default, and it sets where weekly and biweekly pay periods begin too.'}
          />
          {/* PAY-2 (Matt: "semi monthly 1 to 15 on the 20th and 16 to 31 on the 5th of the new
              month"). The PAYDAY, not the period. Whichever fields the cadence actually uses. */}
          {form.payPeriodCadence === 'semimonthly' ? (
            <FormField
              label="1st–15th is paid on (day of the same month)" type="number" min="1" max="31" step="1"
              value={form.payDateSemiFirstHalfDay}
              onChange={(e) => setForm({ ...form, payDateSemiFirstHalfDay: e.target.value })}
              help="A day past the end of a short month pays on that month's last day."
            />
          ) : (
            <FormField
              label="Paid this many days after the period ends" type="number" min="0" max="60" step="1"
              value={form.payDateDaysAfterPeriodEnd}
              onChange={(e) => setForm({ ...form, payDateDaysAfterPeriodEnd: e.target.value })}
              help="The payday shown on the pay run, on its close dialog, and in the exported file's name."
            />
          )}
        </div>
        {form.payPeriodCadence === 'semimonthly' && (
          <FormField
            label="16th–end of month is paid on (day of the NEXT month)" type="number" min="1" max="31" step="1"
            value={form.payDateSemiSecondHalfDay}
            onChange={(e) => setForm({ ...form, payDateSemiSecondHalfDay: e.target.value })}
            help="The payday shown on the pay run, on its close dialog, and in the exported file's name. Changing it never rewrites a run that has already closed — each run stores the date it paid on."
          />
        )}
        <FormField
          label="When payroll is closed with hours still waiting" as="select"
          value={form.payrollPendingPolicy}
          onChange={(e) => setForm({ ...form, payrollPendingPolicy: e.target.value })}
          options={[
            { value: 'rollForward', label: 'Pay the approved hours now; the rest are paid next payroll once approved' },
            { value: 'block', label: "Don't allow closing until everything is approved" },
          ]}
          help="Only approved hours are ever paid. This chooses what happens to hours still waiting for a manager when a Super Admin closes the period."
        />
        <label className="pay-check" style={{ marginTop: 4 }}>
          <input type="checkbox" checked={!!form.payDriveTime} onChange={(e) => setForm({ ...form, payDriveTime: e.target.checked })} /> Pay for drive time between jobs (counts toward hours worked)
        </label>
        <SaveBar />
      </form>

      {/* ALR-11 + ALR-12 (Matt, 2026-09-30): "One alert 30 minutes after the start with no
          clock-in: that's a missed shift, and the supervisor gets a notification and a text."
          ONE timing, and the person copied is the account's own supervisor — so the org-wide
          "operations manager" picker that used to sit here is gone with ALR-4. */}
      <form className="card detail-card" onSubmit={saveAlerts}>
        <h3 className="dash-card-title">Shift alerts</h3>
        <p className="text-muted text-sm">
          When nobody has clocked in to a scheduled clean, the account&rsquo;s supervisor gets one alert &mdash; a notification and a text, at any hour.
        </p>
        <div className="form-row">
          <FormField
            label="Missed after (minutes past the start)" type="number" min="0" max={MAX_MISSED_AFTER_START_MINS} step="1"
            value={form.missedAfterStartMins}
            onChange={(e) => setForm({ ...form, missedAfterStartMins: e.target.value })}
            help="Minutes past the scheduled start with no clock-in by anyone on the clean before it counts as a missed shift. The same number decides the dashboard&rsquo;s missed-cleans count and the &ldquo;No punch&rdquo; rows on Reports."
          />
          <FormField
            label="Only alert for shifts within (hours)" type="number" min="1" max={MAX_SHIFT_LOOKBACK_HOURS} step="1"
            value={form.shiftAlertLookbackHours}
            onChange={(e) => setForm({ ...form, shiftAlertLookbackHours: e.target.value })}
            help={`A guard so turning alerts on does not fire for every old un-clocked clean at once. Only shifts scheduled this recently can alert (at most ${MAX_SHIFT_LOOKBACK_HOURS} hours, one week).`}
          />
        </div>
        {/* ALR-5 (Matt, 2026-09-29): "Should cleaners get a reminder before each shift? —
            (a) Yes, 30 minutes before." A phone notification only, once per shift. */}
        <FormField
          label="Remind cleaners before their shift (minutes)" type="number" min="0" max={MAX_PRESHIFT_LEAD_MINS} step="5"
          value={form.preShiftReminderMins}
          onChange={(e) => setForm({ ...form, preShiftReminderMins: e.target.value })}
          help="Each cleaner gets one phone notification this long before each of their cleans. 0 turns it off. It is a notification only — it does not add anything to their bell."
        />
        <SaveBar />
      </form>

      {/* ───────── Office hours (WO-7 / WO-17) ───────── */}
      <form className="card detail-card" onSubmit={saveOfficeHours}>
        <h3 className="dash-card-title">Office hours</h3>
        <p className="text-muted text-sm">
          When the office is open, in {state.company?.timezone || 'the company timezone'}. Urgent tickets alert at any hour; every other ticket alert waits for these hours, so nobody is woken over a restock.
        </p>
        <div className="form-group">
          <span className="form-label">Working days</span>
          <div className="flex-row" style={{ flexWrap: 'wrap', gap: 'var(--space-3)', marginTop: 'var(--space-1)' }}>
            {WEEKDAY_SHORT.map((label, day) => (
              <label key={label} className="pay-check">
                <input
                  type="checkbox"
                  checked={(form.officeHoursDays || []).includes(day)}
                  onChange={() => toggleOfficeDay(day)}
                /> {label}
              </label>
            ))}
          </div>
          {/* An empty list would mean "no day is an office day", i.e. silence for every
              non-urgent ticket alert — the reader falls back to Mon–Fri instead, and the form
              says so rather than letting a save look like it took. */}
          {!(form.officeHoursDays || []).length && (
            <div className="form-help">Pick at least one day — with none picked this falls back to Monday to Friday.</div>
          )}
        </div>
        <div className="form-row">
          <FormField
            label="Opens" type="time" value={form.officeHoursStart}
            onChange={(e) => setForm({ ...form, officeHoursStart: e.target.value })}
          />
          <FormField
            label="Closes" type="time" value={form.officeHoursEnd}
            onChange={(e) => setForm({ ...form, officeHoursEnd: e.target.value })}
            help={`In force now: ${officeHoursSummary(ops)}. A closing time EARLIER than the opening one is read as an overnight shift.`}
          />
        </div>
        <SaveBar />
      </form>

      {/* ───────── Ticket alerts (WO-2, WO-3, WO-5, WO-6, WO-16) ───────── */}
      <form className="card detail-card" onSubmit={saveTicketAlerts}>
        <h3 className="dash-card-title">Ticket alerts</h3>
        <p className="text-muted text-sm">
          A new ticket goes to the account&rsquo;s supervisor. When the account has none, a client&rsquo;s request from the Client Hub goes to the Admins and any other ticket to the office. It keeps repeating until someone replies to the client, and after the reply until the ticket is completed.
        </p>
        <div className="form-row">
          <FormField
            label="Repeat until someone replies (minutes)" type="number" min={MIN_TICKET_INTERVAL_MINS} max={MAX_TICKET_INTERVAL_MINS} step="1"
            value={form.ticketRepeatMins}
            onChange={(e) => setForm({ ...form, ticketRepeatMins: e.target.value })}
            help="How often the supervisor is reminded while a ticket has had no reply to the client."
          />
          <FormField
            label="Alert the office after (minutes)" type="number" min="0" max={MAX_TICKET_INTERVAL_MINS} step="1"
            value={form.ticketEscalateMins}
            onChange={(e) => setForm({ ...form, ticketEscalateMins: e.target.value })}
            help="Still no reply after this long and the whole office is alerted too — on top of the repeats above, not instead of them. 0 alerts them at once."
          />
        </div>
        <div className="form-row">
          <FormField
            label="After the reply, remind every (minutes)" type="number" min={MIN_TICKET_INTERVAL_MINS} max={MAX_TICKET_INTERVAL_MINS} step="1"
            value={form.ticketOpenRepeatMins}
            onChange={(e) => setForm({ ...form, ticketOpenRepeatMins: e.target.value })}
            help={`So a reply is not mistaken for the job being done. It escalates to the office when the response time runs out — by type, ${Object.keys(TYPE_DEADLINE_HOURS).map((ty) => `${DEADLINE_TYPE_WORDS[ty] || ty} ${typeTargetLabel(ty)}`).join(', ')}; an issue by its urgency, ${WO_PRIORITIES.map((p) => `${WO_PRIORITY_META[p].label.toLowerCase()} ${slaTargetLabel(p)}`).join(', ')}.`}
          />
          <FormField
            label="Only chase tickets raised within (days)" type="number" min="1" max={MAX_TICKET_LOOKBACK_DAYS} step="1"
            value={form.ticketAlertLookbackDays}
            onChange={(e) => setForm({ ...form, ticketAlertLookbackDays: e.target.value })}
            help={`A guard so turning these on does not chase every ticket ever left open (at most ${MAX_TICKET_LOOKBACK_DAYS} days). An older one still shows in the queue.`}
          />
        </div>
        <SaveBar />
      </form>

      <form className="card detail-card" onSubmit={saveReminders}>
        <h3 className="dash-card-title">Reminders</h3>
        <p className="text-muted text-sm">
          Nudges so nothing slips. A checklist reminder goes to the cleaner before their clean ends, then to the account supervisor after it. An inspection reminder goes to the supervisor when an account has not been inspected within its interval.
        </p>
        <div className="form-row">
          <FormField
            label="Checklist: nudge crew this long before the end (minutes)" type="number" min="0" max={MAX_CHECKLIST_LEAD_MINS} step="5"
            value={form.checklistReminderBeforeEndMins}
            onChange={(e) => setForm({ ...form, checklistReminderBeforeEndMins: e.target.value })}
            help="Minutes BEFORE a clean's scheduled end that a cleaner with an unfinished checklist is nudged — they cannot clock out until it is done. On a clean shorter than this, the nudge goes out at its start."
          />
          <FormField
            label="Checklist: escalate after end (minutes)" type="number" min="0" step="5"
            value={form.checklistEscalateGraceMins}
            onChange={(e) => setForm({ ...form, checklistEscalateGraceMins: e.target.value })}
            help="Minutes past the scheduled end with still no checklist before the account supervisor is alerted."
          />
        </div>
        <FormField
          label="Inspect each account every (days) — default" type="number" min="1" max={MAX_INSPECTION_REMINDER_DAYS} step="1"
          value={form.inspectionReminderDays}
          onChange={(e) => setForm({ ...form, inspectionReminderDays: e.target.value })}
          help={`The DEFAULT for every account (at most ${MAX_INSPECTION_REMINDER_DAYS} days); a customer can carry its OWN interval on its page. An account not inspected within its interval is flagged to its supervisor as due — one reminder per lapse, reset by a new inspection.`}
        />
        {/* WO-14 (Matt, 2026-09-29): "a flag on the account when it passes a set number of
            tickets in 30 days" — his note said 10. The WINDOW is fixed at 30 days (his question
            said so); only the count is tunable. */}
        <FormField
          label={`Flag an account at (tickets in ${TICKET_FLAG_DAYS} days)`} type="number" min="1" max={MAX_TICKET_FLAG_COUNT} step="1"
          value={form.ticketFlagCount30d}
          onChange={(e) => setForm({ ...form, ticketFlagCount30d: e.target.value })}
          help={`An account with this many work orders in the last ${TICKET_FLAG_DAYS} days is flagged on its own page and in the customers list, so a location that keeps complaining is visible without anyone counting.`}
        />
        <SaveBar />
      </form>

      {/* SUP-1 (b) / SUP-8 / SUP-9 ★a (Matt, 2026-09-29): the approval step's approver and the
          monthly order day. Each BUILDING may carry its own order day and its own budget on the
          customer page; these are the company defaults. */}
      <form className="card detail-card" onSubmit={saveSupplies}>
        <h3 className="dash-card-title">Supplies</h3>
        <p className="text-muted text-sm ops-card-sub">
          A supply order is approved by the building’s account manager before the Supply Manager orders
          it. Each building is reminded to order on its own day of the month; the office hears the day
          after if nothing has come in.
        </p>
        {/* S131: the building's account manager approves FIRST (lib/notifications
            resolveSupplyApprover); the person named here answers only for a building with none. */}
        <FormField
          label="Approver for buildings with no account manager" as="select"
          value={form.supplyApproverUserId}
          onChange={(e) => setForm({ ...form, supplyApproverUserId: e.target.value })}
          options={[
            { value: '', label: '— Nobody: the office decides —' },
            ...supplyApproverOptions,
          ]}
          help="Each building’s own account manager approves its supply orders (or their operations manager, the owner or an admin). A building with no account manager sends its orders to the person picked here — or, with nobody picked, to the office."
        />
        <FormField
          label="Order supplies on day of month — default" type="number" min="1" max={MAX_SUPPLY_ORDER_DAY} step="1"
          value={form.supplyOrderDayOfMonth}
          onChange={(e) => setForm({ ...form, supplyOrderDayOfMonth: e.target.value })}
          help={`The DEFAULT for every building; a customer can carry its own day on its page. On that day, a building with no supply request submitted this month is flagged to its supervisor; the office is told the next day if there is still nothing. Days run to the ${MAX_SUPPLY_ORDER_DAY}th so every month has one.`}
        />
        <SaveBar />
      </form>
    </div>
  );
}
