// Notification copy for operational alerts (late/missed shift, checklist due,
// inspection due). PURE and node-safe so the SAME wording is produced by the
// client tick (components/OpsAlertScheduler) and the go-live server cron
// (app/api/cron/ops-alerts.js). Extracted from OpsAlertScheduler.copyFor.
import { fmtTime, fmtDate } from './dates.js';

// The cleaners a checklist escalation is about, named from the ROSTER — the alert record
// carries ids only (checklist_results has no name column, CS-403). An id the roster does
// not know is dropped rather than printed raw.
function namesOf(userIds, userName) {
  const names = (userIds || []).map((id) => (userName ? userName(id) : null)).filter(Boolean);
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// `al` is a due-alert record from the lib/opsAlerts walkers
// ({ kind, scheduledStart, jobId, clientId, recipientScope, lastAt, missingUserIds }).
// `clientName` is the account name, already resolved by the caller; `userName(id)`
// resolves a cleaner's display name from the roster (the client tick and the cron each
// pass their own). Without it the copy still reads as a sentence.
export function opsAlertCopy(al, clientName, { userName = null } = {}) {
  const name = clientName || 'a customer';
  const when = al.scheduledStart ? fmtTime(al.scheduledStart) : '';
  const jobUrl = al.jobId ? `/schedule/${al.jobId}` : '/schedule';
  switch (al.kind) {
    case 'shiftLate':
      return { title: `Cleaner late: ${name}`, body: `Scheduled ${when}, no clock-in yet.`, url: jobUrl };
    case 'shiftMissed':
      return { title: `Missed shift: ${name}`, body: `Scheduled ${when}, no clock-in.`, url: jobUrl };
    case 'checklistDue': {
      // The nudge is addressed to the one cleaner who owes it, so it names nobody.
      if (al.recipientScope === 'crew') {
        return { title: `Checklist not logged: ${name}`, body: `The ${when} clean needs your checklist.`, url: '/inspections' };
      }
      const who = namesOf(al.missingUserIds, userName);
      return {
        title: `Checklist still not logged: ${name}`,
        body: who
          ? `The ${when} clean ended with no checklist from ${who}.`
          : `The ${when} clean ended with no checklist.`,
        url: '/inspections',
      };
    }
    case 'inspectionDue':
      return { title: `Inspection due: ${name}`, body: `Last inspected ${al.lastAt ? fmtDate(al.lastAt) : 'never'}.`, url: '/inspections' };
    default:
      return { title: 'Operational alert', body: '', url: '/' };
  }
}
