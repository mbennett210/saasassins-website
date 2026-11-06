// Notification copy for operational alerts (missed shift, checklist due,
// inspection due). PURE and node-safe so the SAME wording is produced by the
// client tick (components/OpsAlertScheduler) and the go-live server cron
// (app/api/cron/ops-alerts.js). Extracted from OpsAlertScheduler.copyFor.
//
// 🔴 THE WORDS ARE MESSAGES, NOT TEXT (CS-193; Matt's LANG-4: "alerts and notifications in
// each person's language"). `title` and `body` come back as msg(key, params) — catalog keys
// with their values — and the fan-out (lib/notifications) renders them in each RECIPIENT's
// language as it writes their bell row; the cron's push-only reminder renders the same way
// for its one cleaner. Times and dates are params ({start, time}), so they format in the
// recipient's language and the ORG's zone; names (a customer's, a cleaner's, a ticket's
// title) are people's words and travel as written. The activity log renders the same
// messages in English (api/cron/ops-alerts.js), so the log stays English (the brief).
import { msg } from '../i18n/core.js';
import { normalizePriority } from './workOrders.js';

// Every ticket alert lands on the Work Orders queue in the Quality hub.
const TICKETS_URL = '/inspections?tab=workorders';

// A ticket alert's title says "Urgent · " first on an urgent ticket, so a phone banner says
// so before the recipient reads a word: the urgent and the ordinary wording are two keys,
// each named in full below (a key is never built, so the catalog test can find every one).
const isUrgent = (al) => al.priority === 'urgent';

// How long a ticket has been waiting, from the anchor the walker recorded — as a message, in
// whole units only: an alert that says "waiting 41m" is read at a glance; "waiting 41m 12s"
// is not.
function sinceMessage(iso) {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return msg('alerts.since.aWhile');
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return msg('alerts.since.minutes', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return msg('alerts.since.hours', { count: hrs });
  return msg('alerts.since.days', { count: Math.floor(hrs / 24) });
}

// The ticket's own title first (it is what the recipient recognizes), then the reason —
// one message with the title as a param, or just the reason when the ticket has no title.
const withTicket = (ticketTitle, reason) => {
  const title = String(ticketTitle || '').trim();
  return title ? msg('alerts.ticket.titleThenReason', { ticket: title, reason }) : reason;
};

// The cleaners a checklist escalation is about, named from the ROSTER — the alert record
// carries ids only (checklist_results has no name column, CS-403). An id the roster does
// not know is dropped rather than printed raw. A list, so it joins in the reader's language.
function namesOf(userIds, userName) {
  return (userIds || []).map((id) => (userName ? userName(id) : null)).filter(Boolean);
}

// `al` is a due-alert record from the lib/opsAlerts walkers
// ({ kind, scheduledStart, jobId, clientId, recipientScope, lastAt, missingUserIds }).
// `clientName` is the account name, already resolved by the caller; `userName(id)`
// resolves a cleaner's display name from the roster (the client tick and the cron each
// pass their own). Without it the copy still reads as a sentence.
export function opsAlertCopy(al, clientName, { userName = null } = {}) {
  const name = clientName || msg('alerts.aCustomer');
  const start = al.scheduledStart || null;
  const jobUrl = al.jobId ? `/schedule/${al.jobId}` : '/schedule';
  switch (al.kind) {
    // 🔴 ALR-11: ONE shift alert, raised while the clean is usually still running — so the
    // body says nobody has arrived YET, which is what the supervisor can still act on,
    // rather than reporting a finished non-event.
    case 'shiftMissed':
      return {
        title: msg('alerts.shiftMissed.title', { customer: name }),
        body: start ? msg('alerts.shiftMissed.body', { start }) : msg('alerts.shiftMissed.bodyNoTime'),
        url: jobUrl,
      };
    case 'checklistDue': {
      // The nudge is addressed to the one cleaner who owes it, so it names nobody.
      if (al.recipientScope === 'crew') {
        return {
          title: msg('alerts.checklistDue.title', { customer: name }),
          body: start ? msg('alerts.checklistDue.body', { start }) : msg('alerts.checklistDue.bodyNoTime'),
          url: '/inspections',
        };
      }
      const who = namesOf(al.missingUserIds, userName);
      return {
        title: msg('alerts.checklistEscalation.title', { customer: name }),
        body: who.length
          ? msg('alerts.checklistEscalation.bodyWho', { start, who })
          : msg('alerts.checklistEscalation.body', { start }),
        url: '/inspections',
      };
    }
    case 'inspectionDue':
      return {
        title: msg('alerts.inspectionDue.title', { customer: name }),
        body: al.lastAt ? msg('alerts.inspectionDue.body', { date: al.lastAt }) : msg('alerts.inspectionDue.never'),
        url: '/inspections',
      };

    // 🔴 TICKET ALERTS (WO-2..7, WO-16). The subject line names the customer, because that is
    // what the recipient acts on; the body says how long it has been waiting and what the
    // ticket is, because the whole point of the repeat is that nobody has looked yet. Every
    // one deep-links to the Work Orders queue.
    case 'ticketRepeat':
      return {
        title: msg(isUrgent(al) ? 'alerts.ticketRepeat.titleUrgent' : 'alerts.ticketRepeat.title', { customer: name }),
        body: withTicket(al.ticketTitle, msg('alerts.ticketRepeat.reason', { since: sinceMessage(al.sinceIso) })),
        url: TICKETS_URL,
      };
    case 'ticketEscalate':
      return {
        title: msg(isUrgent(al) ? 'alerts.ticketEscalate.titleUrgent' : 'alerts.ticketEscalate.title', { customer: name }),
        body: withTicket(al.ticketTitle, msg('alerts.ticketEscalate.reason', { since: sinceMessage(al.sinceIso) })),
        url: TICKETS_URL,
      };
    case 'ticketOpenRepeat':
      return {
        title: msg(isUrgent(al) ? 'alerts.ticketOpenRepeat.titleUrgent' : 'alerts.ticketOpenRepeat.title', { customer: name }),
        body: withTicket(al.ticketTitle, msg('alerts.ticketOpenRepeat.reason')),
        url: TICKETS_URL,
      };
    case 'ticketSlaEscalate':
      return {
        title: msg(isUrgent(al) ? 'alerts.ticketSla.titleUrgent' : 'alerts.ticketSla.title', { customer: name }),
        body: withTicket(al.ticketTitle, al.dueAtIso
          ? msg('alerts.ticketSla.reason', { priority: msg(priorityKey(al.priority)), due: al.dueAtIso })
          : msg('alerts.ticketSla.reasonNoTime', { priority: msg(priorityKey(al.priority)) })),
        url: TICKETS_URL,
      };

    // 🔴 ALR-5: the cleaner's pre-shift reminder. PUSH ONLY (no bell row) — see
    // lib/preShiftReminders — so this copy is the phone banner's whole text.
    case 'shiftReminder':
      return {
        title: start ? msg('alerts.shiftReminder.title', { start }) : msg('alerts.shiftReminder.titleSoon'),
        body: clientName ? msg('alerts.shiftReminder.body', { customer: clientName }) : msg('alerts.shiftReminder.bodyNoCustomer'),
        url: jobUrl,
      };
    // SUP-8 / CS-380 — the monthly supply order. The supervisor is asked on the day; the
    // office hears the day after if nothing has come in. Both land on the Supplies queue,
    // filtered to that building, so the reminder is one click from doing something about it.
    case 'supplyOrderDue':
      return {
        title: msg('alerts.supplyOrderDue.title', { customer: name }),
        body: msg('alerts.supplyOrderDue.body', { orderDay: Number(al.orderDay) || null }),
        url: al.clientId ? `/supplies?cust=${al.clientId}&new=1` : '/supplies',
      };
    case 'supplyOrderOverdue':
      return {
        title: msg('alerts.supplyOrderOverdue.title', { customer: name }),
        body: msg('alerts.supplyOrderOverdue.body', { orderDay: Number(al.orderDay) || null }),
        url: al.clientId ? `/supplies?cust=${al.clientId}` : '/supplies',
      };
    // SUP-7 / SUP-10 — the building is over its monthly supply budget. One alert per month.
    // Money is a number in the app's one currency format, in the reader's locale.
    case 'supplyBudgetExceeded':
      return {
        title: msg('alerts.supplyBudget.title', { customer: name }),
        body: msg('alerts.supplyBudget.body', { amount: Number(al.spend) || 0, budget: Number(al.budget) || 0 }),
        url: al.clientId ? `/supplies?tab=usage&cust=${al.clientId}` : '/supplies?tab=usage',
      };
    default:
      return { title: msg('alerts.generic'), body: '', url: '/' };
  }
}

// The priority's name as a catalog key (lib/workOrders owns the vocabulary; a retired `high`
// reads as urgent through the module's own normalizer).
const PRIORITY_KEYS = { low: 'alerts.priority.low', medium: 'alerts.priority.medium', urgent: 'alerts.priority.urgent' };
function priorityKey(priority) {
  return PRIORITY_KEYS[normalizePriority(priority)] || PRIORITY_KEYS.medium;
}
