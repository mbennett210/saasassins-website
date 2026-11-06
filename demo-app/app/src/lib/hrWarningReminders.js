// HR-5 — the UNSIGNED-WARNING reminder walker. Matt (2026-10-05): "if the employee hasn't
// signed after 1 day, the supervisor gets a reminder (and the employee a nudge)."
//
// It rides the existing every-5-minute operational-alert cron (api/cron/ops-alerts.js) — NO
// new cron entry — for the reason the contract reminders do: a reminder is a BELL plus a
// push, and that run is the one that already owns an `org_state` CAS write and an immediate
// push flush. Its read is cheap by construction: ONE probe of a partial index on
// `hr_warnings` ("awaiting a signature, never reminded, issued a day ago or more"), which
// returns nothing on almost every run.
//
// ONCE per warning, idempotent twice over:
//   · the ops-alert marker (`warningReminderIds`) makes a CAS retry inside one run a no-op;
//   · the DURABLE once-only is `reminded_at` on the warning row, stamped after the bell rows
//     are written — the marker is pruned after two days, the stamp is for ever.
//
// OFFICE HOURS gate the RAISE (the WO-7 / contract-reminder precedent): nobody needs to hear
// about an unsigned warning at 03:00, and the employee's nudge should not wake them. Outside
// hours it simply stays due and rings in the morning.
//
// PURE + node-safe; `now` comes in. The words are MESSAGES (src/i18n/core.js msg), so the
// fan-out writes each bell row in its recipient's language (CS-193).
import { isWithinOfficeHours } from './officeHours.js';
import { msg } from '../i18n/core.js';
import { WARNING_STATUS, unsignedReminderDue } from './hrWarnings.js';

// The two notification events (lib/notifications NOTIFICATION_GROUPS → the 'hr' group).
// ONE declaration each: the catalog, the issue route's bell, this walker and the phone's icon
// map all read them.
export const HR_WARNING_SIGN_EVENT = 'hrWarningToSign';        // the employee: a warning to review and sign
export const HR_WARNING_UNSIGNED_EVENT = 'hrWarningUnsigned';  // the supervisor: still not signed after a day

// At most this many warnings a run. A supervisor issuing a dozen in an afternoon must not
// become a dozen bells in one tick; the rest ring on the next runs, minutes later.
export const HR_WARNING_REMINDER_MAX_PER_RUN = 25;

// Deterministic per warning, so a CAS retry re-applies to a no-op.
export const warningReminderIds = (warningId) => ({
  supervisor: `oa_hrwarn_sup_${warningId}`,
  employee: `oa_hrwarn_emp_${warningId}`,
});

// Where each bell takes its reader. The employee opens their own warning to sign on My Day;
// the supervisor opens it in HR → Warnings (where "Sign in person" and "Refused" are).
export const warningSignUrl = (warningId) => `/my-day?warning=${encodeURIComponent(warningId)}`;
export const warningOfficeUrl = (warningId) => `/hr?tab=warnings&w=${encodeURIComponent(warningId)}`;

// Who is reminded: the supervisor PICKED on the form (never inferred from the login — the
// team shares one), when they are still an active member; otherwise every active owner, so a
// reminder about a departed supervisor's warning is never silent.
export function supervisorRecipients(state, supervisorUserId) {
  const users = (state && state.users) || [];
  const sup = users.find((u) => u && u.id === supervisorUserId);
  if (sup && sup.status === 'active') return [sup.id];
  return users.filter((u) => u && u.role === 'owner' && u.status === 'active').map((u) => u.id);
}

// The alert records due right now, in the shape applyOpsAlert consumes (`users` scope).
//   warnings  rows from hr_warnings/store.dueUnsignedWarnings (already filtered in SQL; each
//             is re-judged here through unsignedReminderDue so the index and the rule cannot
//             drift)
export function getDueWarningReminders({ warnings, state, firedIds, now, settings }) {
  const tz = (state && state.company && state.company.timezone) || null;
  const opsSettings = settings || (state && state.opsSettings) || {};
  if (!isWithinOfficeHours(now, opsSettings, tz)) return [];
  const out = [];
  let taken = 0;
  for (const w of Array.isArray(warnings) ? warnings : []) {
    if (taken >= HR_WARNING_REMINDER_MAX_PER_RUN) break;
    if (!w || w.status !== WARNING_STATUS.awaiting || !unsignedReminderDue(w, now)) continue;
    const ids = warningReminderIds(w.id);
    const name = w.employeeName || null;
    const base = { warningId: w.id };
    let any = false;
    if (!(firedIds && firedIds.has(ids.supervisor))) {
      out.push({
        ...base,
        id: ids.supervisor,
        kind: HR_WARNING_UNSIGNED_EVENT,
        recipientScope: 'users',
        userIds: supervisorRecipients(state, w.supervisorUserId),
        title: name
          ? msg('alerts.hrWarning.unsignedTitle', { name })
          : msg('alerts.hrWarning.unsignedTitleNoName'),
        body: msg('alerts.hrWarning.unsignedBody', { date: w.issuedAt }),
        url: warningOfficeUrl(w.id),
      });
      any = true;
    }
    if (!(firedIds && firedIds.has(ids.employee))) {
      out.push({
        ...base,
        id: ids.employee,
        kind: HR_WARNING_SIGN_EVENT,
        recipientScope: 'users',
        userIds: w.employeeUserId ? [w.employeeUserId] : [],
        title: msg('alerts.hrWarning.nudgeTitle'),
        body: msg('alerts.hrWarning.nudgeBody'),
        url: warningSignUrl(w.id),
      });
      any = true;
    }
    if (any) taken += 1;
  }
  return out;
}
