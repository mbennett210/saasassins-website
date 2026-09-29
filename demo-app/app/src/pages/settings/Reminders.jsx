// Settings → Customer Reminders — the operator on/off surface for automated
// customer-facing reminder emails. These are sent by a server-side cron
// (api/reminders/run), tab-independently, and are EMAIL-ONLY in this version:
// there is no server SMS path, so the two SMS templates are shown but locked
// off with that stated plainly in the copy.
//
// Every template ships OFF. Turning one on here is a live change that starts
// real customer email going out on the next cron tick — the copy says so.
// Styling mirrors the Marketing → Settings tab (card detail-card + pref-row +
// Toggle), the nearest sibling operator-settings surface.

import { useStore, useDispatch } from '../../store';
import { ACTIONS } from '../../store/reducer';
import { selectReminderTemplates } from '../../store/selectors';
import { usePermission } from '../../hooks/usePermission';
import { useToast } from '../../components/Toast';
import Toggle from '../../components/Toggle';
import Badge from '../../components/Badge';

// Per-template presentation: a plain-language label, when it fires, and whether
// this version can actually deliver it. `deliverable:false` (the SMS templates)
// renders a locked-off row; `trigger:false` (welcome_email) has no automatic
// fire point, so it's shown informationally, not as an on/off you can arm.
const TEMPLATE_META = {
  booking_confirmation: {
    label: 'Booking confirmation',
    when: 'Emailed right after a job is booked, to the account’s email contact.',
    deliverable: true,
    trigger: true,
  },
  post_service: {
    label: 'Post-service check-in',
    when: 'Emailed after a completed visit, asking how it went.',
    deliverable: true,
    trigger: true,
  },
  reminder_24h: {
    label: '24-hour reminder',
    when: 'Would text the customer the day before a visit.',
    deliverable: false,
    trigger: true,
  },
  day_of_eta: {
    label: 'Day-of reminder',
    when: 'Would text the customer the morning of a visit.',
    deliverable: false,
    trigger: true,
  },
  welcome_email: {
    label: 'Welcome email',
    when: 'Has no automatic send trigger. Kept as a template only.',
    deliverable: true,
    trigger: false,
  },
};

// Stable display order — the two live email reminders first, then the info-only
// welcome template, then the not-yet-available SMS pair.
const ORDER = ['booking_confirmation', 'post_service', 'welcome_email', 'reminder_24h', 'day_of_eta'];

export default function SettingsReminders() {
  const state = useStore();
  const dispatch = useDispatch();
  const toast = useToast();
  const canEdit = usePermission('reminders.edit');

  const templates = selectReminderTemplates(state) || [];
  const byKey = new Map(templates.map((t) => [t.key, t]));
  const ordered = ORDER.map((k) => byKey.get(k)).filter(Boolean);

  function setEnabled(tpl, on) {
    if (!canEdit) return; // view-only — toggle is inert
    dispatch({ type: ACTIONS.UPDATE_REMINDER_TEMPLATE, id: tpl.id, patch: { enabled: on } });
    const meta = TEMPLATE_META[tpl.key] || { label: tpl.key };
    toast.success(on ? `${meta.label} reminders turned on` : `${meta.label} reminders turned off`);
  }

  return (
    <div className="marketing-settings">
      <div className="card detail-card">
        <div className="section-head">
          <h3>Customer reminders</h3>
        </div>
        <p className="marketing-tab-intro">
          Automated emails to your customers around each visit. They run on the
          server on a schedule, so they send whether or not anyone has the app
          open. Every reminder starts <strong>off</strong>. Turn one on below
          and it begins emailing customers who have an email address on file.
        </p>
        <div className="callout callout-info">
          Reminders are <strong>email only</strong> in this version. They send
          from your company email through the app’s email service. Text-message
          (SMS) reminders aren’t available yet; those templates are shown below
          but stay locked off.
        </div>
        {!canEdit && (
          <p className="form-help">
            You have view-only access to reminders. Ask a Super Admin to change
            these settings.
          </p>
        )}
      </div>

      <div className="card detail-card">
        <div className="section-head">
          <h3>Reminder templates</h3>
        </div>
        {ordered.map((tpl) => {
          const meta = TEMPLATE_META[tpl.key] || { label: tpl.key, when: '', deliverable: true, trigger: true };
          // A row is "live" (gets a real on/off toggle) only when this version can
          // actually deliver it (email) AND it has an automatic fire trigger.
          // Locked rows (SMS, or the trigger-less welcome template) show a status
          // badge instead of a toggle, so there's no dead switch to click.
          const live = meta.deliverable && meta.trigger;
          return (
            <div className="pref-row" key={tpl.id}>
              <div className="pref-row-text">
                <div className="pref-row-label">
                  {meta.label}
                  {!meta.deliverable && (
                    <Badge variant="slate" style={{ marginLeft: 8 }}>SMS. Not available yet</Badge>
                  )}
                  {meta.deliverable && !meta.trigger && (
                    <Badge variant="slate" style={{ marginLeft: 8 }}>No auto-send</Badge>
                  )}
                </div>
                <div className="pref-row-desc">{meta.when}</div>
              </div>
              {live
                ? <Toggle on={tpl.enabled === true} onChange={(v) => setEnabled(tpl, v)} />
                : <Badge variant={tpl.enabled ? 'green' : 'slate'}>{tpl.enabled ? 'On' : 'Off'}</Badge>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
