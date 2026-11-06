// Ticket (work-order) alerting — PURE, node-safe walker. The "nobody has answered this
// client yet" engine behind Matt's WO-2 … WO-7 + WO-16 (2026-09-29), CS-195 / CS-385.
//
// ── WHAT HE ASKED FOR ────────────────────────────────────────────────────────
//   WO-6  a new ticket goes to the ACCOUNT'S SUPERVISOR first, the office when there is
//         no supervisor (the creation ping is api/_lib/qc/store.notifyTicketRaised).
//   WO-3  EVERY new ticket repeats — not just the urgent ones ("differs" from our rec).
//   WO-5  every 10 minutes, and after 30 minutes the office/owner is alerted too.
//   WO-2  the repeats stop when someone REPLIES TO THE CLIENT ("I want letter B, but I also
//         want alerts until the ticket is completed. This will prevent someone from replying
//         to the client and forgetting to do the job or complete the ticket.")
//   WO-16 ★a so after the reply the reminders continue HOURLY inside office hours, and
//         escalate to the office when the RESPONSE TIME runs out — since Matt's email
//         (2026-10-09, WO-20 / WO-21) the TYPE's for a client request, the urgency's for an
//         issue. Not restated here: lib/workOrders owns them (deadlineHours / computeDueAt).
//   WO-7  urgent tickets alert at any hour; the rest only inside office hours (lib/officeHours).
//
// ── HOW ONCE-ONLY BECOMES EVERY-TEN-MINUTES ──────────────────────────────────
// Every other operational alert fires ONCE per subject, deduped by a deterministic id in
// `opsAlertEvents`. A repeating alert cannot work that way, and a per-fire id would put a
// marker row in the shared record every 10 minutes per open ticket. So a repeat's id carries
// its TIME SLOT — floor(elapsed / interval) — which makes it:
//   • idempotent inside the slot (the 5-minute cron sees each slot twice, the client tick
//     could see it more), and
//   • self-limiting: only the CURRENT slot is ever emitted, so a cron outage does not
//     replay the slots it missed, and marker RETENTION can keep just the newest per ticket
//     (lib/opsAlertApply), which bounds the record at one row per open ticket per kind.
//
// Recipients and delivery are NOT decided here (same split as lib/opsAlerts): the walker
// says WHICH ticket is due for WHICH kind, lib/opsAlertApply routes it and lib/opsAlertCopy
// words it.
import {
  normalizePriority, normalizeStatus, computeDueAt, isOpenStatus,
} from './workOrders.js';
import { isWithinOfficeHours } from './officeHours.js';
import { isSeedClientId } from './opsAlerts.js';
import { archivedClientIds } from './customerStatus.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Tunable in Settings → Operations → Ticket alerts. Kept here as the single source so the
// walker, the seed and the settings form agree; readers hard-default, so an un-backfilled
// blob behaves (additive + default-safe → NO store-version bump).
export const TICKET_ALERT_DEFAULTS = {
  ticketRepeatMins: 10,       // WO-5: repeat this often until someone replies to the client
  ticketEscalateMins: 30,     // WO-5: after this long with no reply, the office/owner too
  ticketOpenRepeatMins: 60,   // WO-16 ★a: after the reply, remind this often until completed
  ticketAlertLookbackDays: 30, // back-blast guard (see below)
};

// Clamps, applied wherever the settings are read. An interval of 0 would make every tick a
// new slot — one marker and one bell row per open ticket per cron run — so the floor is 1
// minute; the ceiling keeps a typo from parking the reminder a year out.
export const MIN_TICKET_INTERVAL_MINS = 1;
export const MAX_TICKET_INTERVAL_MINS = 7 * 24 * 60;
export const MAX_TICKET_LOOKBACK_DAYS = 90;

const num = (v, d) => (Number.isFinite(v) ? v : d);
const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : NaN; };
const clampInterval = (v, d) => Math.min(MAX_TICKET_INTERVAL_MINS, Math.max(MIN_TICKET_INTERVAL_MINS, num(v, d)));

export const ticketRepeatMins = (s = {}) => clampInterval(s?.ticketRepeatMins, TICKET_ALERT_DEFAULTS.ticketRepeatMins);
export const ticketOpenRepeatMins = (s = {}) => clampInterval(s?.ticketOpenRepeatMins, TICKET_ALERT_DEFAULTS.ticketOpenRepeatMins);
// The escalation DELAY may legitimately be 0 ("tell the office at once"), so it clamps at 0,
// not at the interval floor.
export const ticketEscalateMins = (s = {}) => Math.min(MAX_TICKET_INTERVAL_MINS,
  Math.max(0, num(s?.ticketEscalateMins, TICKET_ALERT_DEFAULTS.ticketEscalateMins)));
export const ticketAlertLookbackDays = (s = {}) => Math.min(MAX_TICKET_LOOKBACK_DAYS,
  Math.max(1, num(s?.ticketAlertLookbackDays, TICKET_ALERT_DEFAULTS.ticketAlertLookbackDays)));

// The four kinds this walker emits. `ticketRepeat`/`ticketOpenRepeat` carry a slot in their
// id and repeat; the two escalations are once-only.
export const TICKET_ALERT_KINDS = ['ticketRepeat', 'ticketEscalate', 'ticketOpenRepeat', 'ticketSlaEscalate'];
// The repeating ones — lib/opsAlertApply keeps only the NEWEST marker per ticket for these.
export const TICKET_REPEAT_KINDS = ['ticketRepeat', 'ticketOpenRepeat'];

// The notification event key an alert about a ticket of this priority uses. URGENT tickets
// have their OWN key because that is what makes them break through (WO-7 any hour, NTF-2
// quiet hours, NTF-1 a text): the row's event key has to be able to say "this one is urgent"
// on its own, since the push dispatcher never sees the ticket. One reader, shared with the
// creation ping so the first alert and the repeats can't disagree.
export const TICKET_EVENT_URGENT = 'ticketUrgent';
export const TICKET_EVENT_OPEN = 'ticketUnanswered';
export const isUrgentPriority = (priority) => normalizePriority(priority) === 'urgent';
export const ticketAlertEventKey = (priority) => (isUrgentPriority(priority) ? TICKET_EVENT_URGENT : TICKET_EVENT_OPEN);

// The event for the CREATION ping (api/_lib/qc/store.notifyTicketRaised). A non-urgent new
// ticket keeps the long-standing `problemReported` toggle — it is the same event it always was,
// "a work order has been filed", and re-keying it would silently re-open it for everyone who
// had muted it. An URGENT one uses the loud key from the first moment, because Matt asked for
// urgent tickets to reach people at any hour and as a text, and the very first alert is the one
// that matters most.
export const TICKET_EVENT_RAISED = 'problemReported';
export const ticketRaisedEventKey = (priority) => (isUrgentPriority(priority) ? TICKET_EVENT_URGENT : TICKET_EVENT_RAISED);

// Deterministic id. `slot` is omitted for the once-only kinds.
export function ticketAlertId(kind, ticketId, slot = null) {
  return slot == null ? `oa_${kind}_${ticketId}` : `oa_${kind}_${ticketId}_${slot}`;
}

// Has anyone answered this ticket? Matt's stop condition is "someone replies to the client",
// and the first office/crew reply already advances an OPEN ticket to in_progress
// (api/_lib/qc/store.addWorkOrderMessage). So a ticket counts as answered when a staff reply
// exists OR its status has moved off `open` — a status someone advanced by hand, with no
// message, still means the office has it, and chasing them for a reply they have already
// decided not to send would train them to ignore the alert.
export function ticketAnsweredAt(ticket, repliedAtIso) {
  const replied = ms(repliedAtIso);
  if (Number.isFinite(replied)) return replied;
  if (normalizeStatus(ticket?.status) !== 'open') {
    // No reply row, but the ticket has moved. Anchor the post-reply reminders on the ticket's
    // own creation, the only timestamp we have: deterministic, and never in the future.
    const created = ms(ticket?.created_at ?? ticket?.createdAt);
    return Number.isFinite(created) ? created : null;
  }
  return null;
}

// The response-time deadline for a ticket — DERIVED from its created time, its TYPE and its
// urgency by lib/workOrders' one rule (WO-20: a client request's type sets it; WO-21: an issue
// keeps the urgency clock). Never the stored `due_at`, which a ticket raised before the rule may
// still carry: the escalation moves with the type, on every ticket, the moment the rule ships.
export function ticketDueAtMs(ticket) {
  const created = ticket?.created_at ?? ticket?.createdAt ?? null;
  if (!Number.isFinite(ms(created))) return NaN;
  const t = ms(computeDueAt(created, { type: ticket?.type, priority: ticket?.priority, severity: ticket?.severity }));
  return Number.isFinite(t) ? t : NaN;
}

// ── The walker ────────────────────────────────────────────────────────────────
//   tickets      : problem_reports rows — { id, client_id, type, priority, status, created_at,
//                  due_at, title } (the deadline is derived from type + priority, ticketDueAtMs). RESOLVED rows are ignored (the reminders run "until the
//                  ticket is completed"), and so is `awaiting_client`: the SLA clock is
//                  paused there (lib/workOrders deriveSla) because we are waiting on THEM,
//                  and one rule for the badge and the reminder is one rule.
//   repliedAt    : Map/object ticketId → ISO of the FIRST office/crew reply.
//   firedIds     : Set of ticketAlertId()s already raised (dedup / idempotence).
//   now, settings, timeZone (the org's company.timezone, for office hours).
//   clients      : the customer book (state.clients). An ARCHIVED customer's ticket stays open and
//                  readable but is chased no more (CS-663: it has left every working surface).
// Returns [{ id, kind, eventKey, recipientScope, clientId, refId, origin, priority, ticketTitle,
//            sinceIso, dueAtIso }]. `origin` is the ticket's own ('portal' = a customer's request
//            from the Client Hub), so lib/opsAlertApply routes each repeat as the first alert went
//            (HUB-21, CS-639).
export function getDueTicketAlerts({
  tickets = [], repliedAt = null, firedIds = new Set(), now = Date.now(), settings = {}, timeZone = null, clients = [],
} = {}) {
  const archivedIds = archivedClientIds(clients);
  const repeatMs = ticketRepeatMins(settings) * MIN;
  const escalateMs = ticketEscalateMins(settings) * MIN;
  const openRepeatMs = ticketOpenRepeatMins(settings) * MIN;
  const lookbackMs = ticketAlertLookbackDays(settings) * DAY;
  const replyOf = (id) => (repliedAt instanceof Map ? repliedAt.get(id) : (repliedAt || {})[id]);
  // WO-7: asked ONCE per walk, not per ticket — the answer cannot change mid-loop.
  const inHours = isWithinOfficeHours(now, settings, timeZone);

  const due = [];
  for (const t of tickets) {
    const ticketId = t?.id;
    if (!ticketId) continue;
    if (!isOpenStatus(t.status)) continue;                     // resolved → nothing to chase
    const status = normalizeStatus(t.status);
    if (status === 'awaiting_client') continue;                // the clock is paused on them
    // CS-030 seed skip: production is 100% fictional until the cutover, and seed-backend.mjs
    // seeds 14 work orders on seed CUSTOMERS — several urgent and still open. Alerting on
    // those would repeat every 10 minutes, at any hour, on tickets nobody can close.
    // TODO(remove-by: CS-030 seed cutover): drop this line with the rest of the seed skip
    // (grep: SEED_CLIENT_ID_RE, isSeedClientId).
    if (isSeedClientId(t.client_id ?? t.clientId)) continue;
    if (archivedIds.has(t.client_id ?? t.clientId)) continue;   // archived (CS-663): chased no more
    const createdMs = ms(t.created_at ?? t.createdAt);
    if (!Number.isFinite(createdMs) || createdMs > now) continue;
    // Back-blast guard, the same stance as the shift alerts': turning this on must not chase
    // every ticket that has ever been left open. A ticket older than the look-back is a
    // management problem the queue already flags (WO-14), not an alerting one.
    if (createdMs < now - lookbackMs) continue;

    const priority = normalizePriority(t.priority);
    const eventKey = ticketAlertEventKey(priority);
    const urgent = isUrgentPriority(priority);
    const base = {
      eventKey,
      clientId: t.client_id ?? t.clientId ?? null,
      refId: ticketId,
      origin: t.origin ?? null,
      priority,
      ticketTitle: t.title || '',
    };
    const answeredMs = ticketAnsweredAt(t, replyOf(ticketId));
    // WO-7: everything but an urgent ticket waits for office hours. Gated at the RAISE, not
    // at delivery, so an overnight ticket does not accrue a bell row every 10 minutes until
    // morning — the creation ping (always recorded) is what the office finds waiting, and the
    // repeats resume in the current slot once the office opens.
    const mayRaise = urgent || inHours;

    if (answeredMs == null) {
      // ── Nobody has replied to the client yet ──
      if (mayRaise) {
        const slot = Math.floor((now - createdMs) / repeatMs);
        // Slot 0 is the creation ping's own window (notifyTicketRaised already sent it), so
        // the first repeat is one whole interval later.
        if (slot >= 1) {
          const id = ticketAlertId('ticketRepeat', ticketId, slot);
          if (!firedIds.has(id)) {
            due.push({
              id, kind: 'ticketRepeat', ...base, recipientScope: 'supervisor',
              sinceIso: new Date(createdMs).toISOString(),
            });
          }
        }
        // WO-5: "after 30 minutes you're alerted too" — once, to the office bench, ON TOP of
        // the repeats above (which keep going to the supervisor).
        if (now > createdMs + escalateMs) {
          const id = ticketAlertId('ticketEscalate', ticketId);
          if (!firedIds.has(id)) {
            due.push({
              id, kind: 'ticketEscalate', ...base, recipientScope: 'office',
              sinceIso: new Date(createdMs).toISOString(),
            });
          }
        }
      }
      continue;
    }

    // ── Replied, not completed (WO-2's note + WO-16 ★a) ──
    if (mayRaise) {
      const slot = Math.floor((now - answeredMs) / openRepeatMs);
      if (slot >= 1) {
        const id = ticketAlertId('ticketOpenRepeat', ticketId, slot);
        if (!firedIds.has(id)) {
          due.push({
            id, kind: 'ticketOpenRepeat', ...base, recipientScope: 'supervisor',
            sinceIso: new Date(answeredMs).toISOString(),
          });
        }
      }
    }
    // The response-time escalation is NOT office-hours gated for its own sake: it fires at
    // most once per ticket, and a breached response time is the one thing the office has to
    // know about at the moment it happens. (Its PUSH still obeys office hours and quiet
    // hours for a non-urgent ticket — lib/alertDelivery.)
    const dueAtMs = ticketDueAtMs(t);
    if (Number.isFinite(dueAtMs) && now > dueAtMs) {
      const id = ticketAlertId('ticketSlaEscalate', ticketId);
      if (!firedIds.has(id)) {
        due.push({
          id, kind: 'ticketSlaEscalate', ...base, recipientScope: 'office',
          sinceIso: new Date(answeredMs).toISOString(), dueAtIso: new Date(dueAtMs).toISOString(),
        });
      }
    }
  }
  return due;
}
