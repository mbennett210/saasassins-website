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
  DEFAULT_DRIVE_MAX_GAP_MINS, DEFAULT_DRIVE_FLAG_PCT, DEFAULT_DRIVE_GRACE_MINS,
} from '../../lib/driveTime';
import { OPS_ALERT_DEFAULTS, MAX_SHIFT_LOOKBACK_HOURS, MAX_INSPECTION_REMINDER_DAYS } from '../../lib/opsAlerts';

const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback);
const PAY_CADENCES = ['weekly', 'biweekly', 'semimonthly'];

function SaveBar() {
  return (
    <div className="modal-actions">
      <button type="submit" className="btn btn-primary">Save</button>
    </div>
  );
}

export default function SettingsOperations() {
  const ops = useStore().opsSettings || {};
  const dispatch = useDispatch();
  const toast = useToast();

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
    payDriveTime: o.payDriveTime !== false,
    lateAlertGraceMins: Number.isFinite(o.lateAlertGraceMins) ? o.lateAlertGraceMins : OPS_ALERT_DEFAULTS.lateAlertGraceMins,
    missedShiftGraceMins: Number.isFinite(o.missedShiftGraceMins) ? o.missedShiftGraceMins : OPS_ALERT_DEFAULTS.missedShiftGraceMins,
    shiftAlertLookbackHours: Number.isFinite(o.shiftAlertLookbackHours) ? o.shiftAlertLookbackHours : OPS_ALERT_DEFAULTS.shiftAlertLookbackHours,
    checklistReminderGraceMins: Number.isFinite(o.checklistReminderGraceMins) ? o.checklistReminderGraceMins : OPS_ALERT_DEFAULTS.checklistReminderGraceMins,
    checklistEscalateGraceMins: Number.isFinite(o.checklistEscalateGraceMins) ? o.checklistEscalateGraceMins : OPS_ALERT_DEFAULTS.checklistEscalateGraceMins,
    inspectionReminderDays: Number.isFinite(o.inspectionReminderDays) ? o.inspectionReminderDays : OPS_ALERT_DEFAULTS.inspectionReminderDays,
  });
  const [form, setForm] = useState(() => toForm(ops));
  useEffect(() => { setForm(toForm(ops)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ops.defaultGeofenceRadiusM, ops.autoCloseGraceMins, ops.varianceFlagOverMins, ops.varianceFlagUnderMins, ops.expectedBasis, ops.driveMaxGapMins, ops.driveVarianceFlagPct, ops.driveVarianceGraceMins, ops.otMultiplier, ops.payPeriodCadence, ops.payDriveTime, ops.lateAlertGraceMins, ops.missedShiftGraceMins, ops.shiftAlertLookbackHours, ops.checklistReminderGraceMins, ops.checklistEscalateGraceMins, ops.inspectionReminderDays]);

  // Each card commits ONLY its own fields — a scoped UPDATE_OPS_SETTINGS patch.
  const commit = (patch, label) => { dispatch({ type: ACTIONS.UPDATE_OPS_SETTINGS, patch }); toast.success(label); };

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
    commit({
      otMultiplier: Math.max(1, num(form.otMultiplier, 1.5)),
      payPeriodCadence: PAY_CADENCES.includes(form.payPeriodCadence) ? form.payPeriodCadence : 'biweekly',
      payDriveTime: !!form.payDriveTime,
    }, 'Payroll settings saved');
  };
  const saveAlerts = (e) => {
    e.preventDefault();
    commit({
      lateAlertGraceMins: Math.max(0, num(form.lateAlertGraceMins, OPS_ALERT_DEFAULTS.lateAlertGraceMins)),
      missedShiftGraceMins: Math.max(0, num(form.missedShiftGraceMins, OPS_ALERT_DEFAULTS.missedShiftGraceMins)),
      shiftAlertLookbackHours: Math.min(MAX_SHIFT_LOOKBACK_HOURS, Math.max(1, num(form.shiftAlertLookbackHours, OPS_ALERT_DEFAULTS.shiftAlertLookbackHours))),
    }, 'Shift alerts saved');
  };
  const saveReminders = (e) => {
    e.preventDefault();
    commit({
      checklistReminderGraceMins: Math.max(0, num(form.checklistReminderGraceMins, OPS_ALERT_DEFAULTS.checklistReminderGraceMins)),
      checklistEscalateGraceMins: Math.max(0, num(form.checklistEscalateGraceMins, OPS_ALERT_DEFAULTS.checklistEscalateGraceMins)),
      inspectionReminderDays: Math.min(MAX_INSPECTION_REMINDER_DAYS, Math.max(1, num(form.inspectionReminderDays, OPS_ALERT_DEFAULTS.inspectionReminderDays))),
    }, 'Reminders saved');
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

      <form className="card detail-card" onSubmit={savePayroll}>
        <h3 className="dash-card-title">Payroll</h3>
        <p className="text-muted text-sm" style={{ marginTop: -4 }}>
          How the pay run turns approved hours into money. Overtime is computed weekly at 40 hours and paid at this multiplier.
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
            options={[
              { value: 'semimonthly', label: 'Semi-monthly (1st–15th, 16th–end of month)' },
              { value: 'biweekly', label: 'Biweekly (every 2 weeks)' },
              { value: 'weekly', label: 'Weekly' },
            ]}
            help="Semi-monthly pays the 1st–15th and 16th–end of each month (Feb ends on the 28th/29th). Overtime stays weekly (40h): when a workweek straddles the split, the over-40h hours are paid in the half of the month they were worked."
          />
        </div>
        <label className="pay-check" style={{ marginTop: 4 }}>
          <input type="checkbox" checked={!!form.payDriveTime} onChange={(e) => setForm({ ...form, payDriveTime: e.target.checked })} /> Pay for drive time between jobs (counts toward hours worked)
        </label>
        <SaveBar />
      </form>

      <form className="card detail-card" onSubmit={saveAlerts}>
        <h3 className="dash-card-title">Shift alerts</h3>
        <p className="text-muted text-sm">
          When a scheduled clean has no clock-in, the account&rsquo;s supervisor is alerted: late while the shift is still open, missed once it has ended.
        </p>
        <div className="form-row">
          <FormField
            label="Late after (minutes)" type="number" min="0" step="1"
            value={form.lateAlertGraceMins}
            onChange={(e) => setForm({ ...form, lateAlertGraceMins: e.target.value })}
            help="Minutes past the scheduled start with no clock-in before a late-cleaner alert."
          />
          <FormField
            label="Missed after (minutes past end)" type="number" min="0" step="1"
            value={form.missedShiftGraceMins}
            onChange={(e) => setForm({ ...form, missedShiftGraceMins: e.target.value })}
            help="Minutes past the scheduled end with no clock-in before the shift is flagged missed."
          />
        </div>
        <FormField
          label="Only alert for shifts within (hours)" type="number" min="1" max={MAX_SHIFT_LOOKBACK_HOURS} step="1"
          value={form.shiftAlertLookbackHours}
          onChange={(e) => setForm({ ...form, shiftAlertLookbackHours: e.target.value })}
          help={`A guard so turning alerts on does not fire for every old un-clocked clean at once. Only shifts scheduled this recently can alert (at most ${MAX_SHIFT_LOOKBACK_HOURS} hours, one week).`}
        />
        <SaveBar />
      </form>

      <form className="card detail-card" onSubmit={saveReminders}>
        <h3 className="dash-card-title">Reminders</h3>
        <p className="text-muted text-sm">
          Nudges so nothing slips. A checklist reminder goes to the cleaner first, then the account supervisor. An inspection reminder goes to the supervisor when an account has not been inspected within the cadence below.
        </p>
        <div className="form-row">
          <FormField
            label="Checklist: nudge crew after (minutes)" type="number" min="0" step="5"
            value={form.checklistReminderGraceMins}
            onChange={(e) => setForm({ ...form, checklistReminderGraceMins: e.target.value })}
            help="Minutes into a scheduled clean with no checklist logged before the cleaner is nudged."
          />
          <FormField
            label="Checklist: escalate after end (minutes)" type="number" min="0" step="5"
            value={form.checklistEscalateGraceMins}
            onChange={(e) => setForm({ ...form, checklistEscalateGraceMins: e.target.value })}
            help="Minutes past the scheduled end with still no checklist before the account supervisor is alerted."
          />
        </div>
        <FormField
          label="Inspect each account every (days)" type="number" min="1" max={MAX_INSPECTION_REMINDER_DAYS} step="1"
          value={form.inspectionReminderDays}
          onChange={(e) => setForm({ ...form, inspectionReminderDays: e.target.value })}
          help={`An account not inspected within this many days is flagged to its supervisor as due (at most ${MAX_INSPECTION_REMINDER_DAYS}). One reminder per lapse; a new inspection resets it.`}
        />
        <SaveBar />
      </form>
    </div>
  );
}
