// Pure application of ONE operational alert onto a store snapshot: dedup, marker
// retention, and recipient routing. The shared write path for RAISE_OPS_ALERT (the
// client reducer) AND the go-live server cron (app/api/cron/ops-alerts.js), so both
// raise, retain, and route identically. Extracted from the reducer, which is
// un-importable under node (same precedent as lib/deleteCascade.js).
import {
  fanOutToUserIds, fanOutAccountAlert, fanOutManagerAlert, resolveAccountSupervisor,
  ticketFanOut,
  resolveSupplyApprover,
} from './notifications.js';
import { shiftLookbackHours, INSPECTION_LOOKBACK_DAYS } from './opsAlerts.js';
import { TICKET_ALERT_KINDS, TICKET_REPEAT_KINDS } from './ticketAlerts.js';
import { preShiftReminderMins } from './preShiftReminders.js';
import { CREW_QUIET_MARKER_KIND } from './crewQuietAlerts.js';
import { SPECIAL_SERVICE_ALERT_KIND, liveSpecialServiceRefs } from './specialServiceReminders.js';
import { hasTeamAccess } from './teamScope.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_MS = 60 * 1000;
const MARKER_BACKSTOP = 5000;
// How long a ticket-alert marker is kept. Three days: long enough that the once-only
// escalations cannot re-fire while anyone is still working the ticket, short enough that a
// week of closed tickets is not sitting in the shared record.
export const TICKET_MARKER_HOURS = 72;
const isInspectionMarker = (e) => !!e && e.kind === 'inspectionDue';
// Ticket alerting (WO-2..7, WO-16) and the pre-shift reminder (ALR-5) both fire REPEATEDLY or
// PER PERSON PER SHIFT, so their markers get their own retention (see the block below).
const TICKET_KINDS = new Set(TICKET_ALERT_KINDS);
const TICKET_REPEATS = new Set(TICKET_REPEAT_KINDS);
const PRESHIFT_KIND = 'shiftReminder';
// Markers that are bounded by their own KEY (newest-per-subject) rather than by the count
// backstop: one per customer for an inspection episode, one per ticket for each repeating
// ticket kind. Evicting one of these by the oldest-first backstop would let the walker
// re-emit an id it has already fired, i.e. a duplicate bell row or push.
const keyedMarkerKey = (e) => {
  if (!e) return null;
  if (isInspectionMarker(e)) return e.clientId ? `inspectionDue|${e.clientId}` : null;
  if (isSupplyMarker(e)) return e.clientId ? `${e.kind}|${e.clientId}` : null; // monthly supply markers: one per building per kind
  if (TICKET_REPEATS.has(e.kind) && e.refId) return `${e.kind}|${e.refId}`;
  if (isCrewQuietMarker(e) && e.refId) return `${e.kind}|${e.refId}`; // one per quiet cleaner
  if (isSpecialServiceMarker(e) && e.refId) return `${e.kind}|${e.refId}`; // one per special service
  return null;
};

// Task #468: the quiet-cleaner MEMORY (lib/crewQuietAlerts). One per cleaner named, and it must
// outlive the 48-hour shift horizon: it is what keeps a cleaner who is STILL quiet from being
// named again, for as long as the stretch lasts (once per quiet stretch, Daniel 2026-11-03). So
// it has no age ceiling; it is bounded by the roster instead — kept while its cleaner is crew
// with team access, dropped once they are disabled or gone (nothing left to remember).
const isCrewQuietMarker = (e) => !!e && e.kind === CREW_QUIET_MARKER_KIND;

// Task #507: the special-service reminder (lib/specialServiceReminders) is told once per DATE, and
// a date can stand for months (an overdue service nobody has marked done), so its marker has no age
// ceiling either: only the newest per service is kept (a new date supersedes the old id), and it is
// dropped once its service is removed or its customer is gone.
const isSpecialServiceMarker = (e) => !!e && e.kind === SPECIAL_SERVICE_ALERT_KIND;

// SUP-7 / SUP-8: the monthly supply markers. Their ids carry YYYY-MM, so the marker is what
// makes a MONTHLY reminder fire once when the cron runs every five minutes — pruned at the
// shift horizon (48h) it would re-send every run for the rest of the month, exactly the bug
// the inspection reminder hit in 2026-09-22. So they follow the inspection precedent: only
// the NEWEST per building per kind is kept (a new month supersedes the old id), with an age
// ceiling well past a month so a dropped marker's month can never still be the current one.
const SUPPLY_MARKER_KINDS = new Set(['supplyOrderDue', 'supplyOrderOverdue', 'supplyBudgetExceeded']);
export const SUPPLY_MARKER_MAX_DAYS = 40;
const isSupplyMarker = (e) => !!e && SUPPLY_MARKER_KINDS.has(e.kind);
// The missed-shift alert ALSO reaches the owner, not the account SPOC alone (see the
// routing block below). ONE kind since ALR-11 retired the separate "late" alert.
const SHIFT_ALERT_KINDS = new Set(['shiftMissed']);
// The same union carries the checklist ESCALATION (CS-404): the cleaner already had
// their own nudge, so the escalation is the office tier and must reach the one shared
// owner login, not a possibly login-less account supervisor. A `checklistDue` on the
// supervisor scope is only ever the escalation — the crew nudge takes the branch above.
// Inspection reminders keep single-point-of-contact routing (NOTIF-02).
const reachesOwnerToo = (a) => SHIFT_ALERT_KINDS.has(a.kind)
  || (a.kind === 'checklistDue' && a.recipientScope === 'supervisor');

// Returns { opsAlertEvents, notifications } to merge onto `state`, or null when the
// alert is a no-op: missing id/kind, or already raised (its deterministic marker is
// present). The no-op is what makes the client tick and the server cron safe to run
// together and idempotent across reloads/CAS retries.
//
// `alert`: { id, kind, recipientScope ('supervisor'|'office'|'crew'), clientId, jobId,
//            refId, origin, eventKey, pushOnly, crewIds, title, body, url }. `now` (ms) is injected
//            so the caller owns the clock (reducer/cron pass Date.now(); tests pin it).
//   • `eventKey` overrides `kind` as the notification event (lib/ticketAlerts mints
//     `ticketUrgent` / `ticketUnanswered` from the ticket's priority, because the push
//     dispatcher only ever sees the row's event key).
//   • `refId` is the subject a repeating alert is about (a ticket id) — recorded on the
//     marker so retention can keep the newest per subject.
//   • `pushOnly: true` records the dedup marker and creates NO bell row (ALR-5's pre-shift
//     reminder: one row per cleaner per shift does not belong in the shared record). The
//     caller sends the push itself; `notifications` comes back unchanged.
//   • `markerOnly: true` records the marker and nothing else: no bell row and no push (task
//     #468's per-cleaner memory, whose bells are the run's other records).
export function applyOpsAlert(state, alert, { now = Date.now() } = {}) {
  const a = alert || {};
  if (!a.id || !a.kind) return null;
  const fired = state.opsAlertEvents || [];
  if (fired.some((e) => e.id === a.id)) return null; // already raised (idempotent)

  // Marker retention is TIME-based, not a fixed count. The walker only fires for a
  // shift whose start is within shiftAlertLookbackHours of now, and a marker's firedAt
  // is always at or after its shift's start, so keeping every marker fired within the
  // lookback window guarantees we never evict one whose shift is still eligible (which
  // would let the walker re-emit it and fan out a duplicate bell or push). We keep 2x
  // the lookback (min 48h) as margin, plus a high absolute backstop so a misconfigured
  // lookback cannot grow the log unbounded.
  //
  // An inspection reminder is different: one per overdue EPISODE (its id carries the
  // account's last-inspection day), and an episode can run for months. Pruned at the
  // shift horizon, the walker re-emitted the same id and the supervisor got the same
  // reminder every two days (review finding, 2026-09-22). So an inspection marker is kept
  // for the walker's whole look-back (past it the account reads as never inspected and
  // can't re-emit the id), and only the newest per account — a later episode supersedes
  // the older id — which bounds them at one per customer, outside the backstop.
  //
  // 🔴 A TICKET ALERT REPEATS (WO-5: every 10 minutes) and a PRE-SHIFT REMINDER is one per
  // cleaner per shift (ALR-5), so both are exactly the shape that must not accumulate in the
  // shared record. Their retention is at THIS write point:
  //   • a repeating ticket kind's id carries its time slot, so only the NEWEST marker per
  //     ticket is kept (keyedMarkerKey) — one row per open ticket per kind, and the walker
  //     only ever emits the current slot, so an older one can never be re-emitted;
  //   • every ticket marker (the two escalations included) is pruned at TICKET_MARKER_HOURS,
  //     which bounds them by the tickets of the last three days rather than for ever. A
  //     ticket still unanswered past that re-escalates ONCE, which is a reminder, not a bug;
  //   • a pre-shift marker is pruned on twice the lead time, since the walker can only fire
  //     inside [start − lead, start): once that window has passed the marker is dead weight.
  const shiftCutoff = now - Math.max(shiftLookbackHours(state.opsSettings || {}) * 2, 48) * HOUR_MS;
  const inspectionCutoff = now - (INSPECTION_LOOKBACK_DAYS + 1) * DAY_MS;
  const ticketCutoff = now - TICKET_MARKER_HOURS * HOUR_MS;
  const preShiftCutoff = now - Math.max(preShiftReminderMins(state.opsSettings || {}) * 2, 120) * MIN_MS;
  const supplyCutoff = now - SUPPLY_MARKER_MAX_DAYS * DAY_MS;
  const cutoffFor = (e) => {
    if (isCrewQuietMarker(e)) return -Infinity; // bounded by the roster below, never by age
    if (isSpecialServiceMarker(e)) return -Infinity; // bounded by the services below, never by age
    if (isInspectionMarker(e)) return inspectionCutoff;
    if (isSupplyMarker(e)) return supplyCutoff;
    if (TICKET_KINDS.has(e?.kind)) return ticketCutoff;
    if (e?.kind === PRESHIFT_KIND) return preShiftCutoff;
    return shiftCutoff;
  };
  const marker = { id: a.id, kind: a.kind, clientId: a.clientId || null, jobId: a.jobId || null, firedAt: new Date(now).toISOString() };
  if (a.refId) marker.refId = a.refId;   // the ticket a repeating alert is about
  const all = [...fired, marker];
  const newestKeyed = new Map(); // keyed subject -> index of its newest marker
  all.forEach((e, i) => { const k = keyedMarkerKey(e); if (k) newestKeyed.set(k, i); });
  const quietCrewIds = new Set((state.users || []).filter((u) => u && u.role === 'crew' && hasTeamAccess(u)).map((u) => u.id));
  const serviceRefs = liveSpecialServiceRefs(state);
  const kept = all.filter((e, i) => {
    const t = e && e.firedAt ? new Date(e.firedAt).getTime() : NaN;
    const key = keyedMarkerKey(e);
    if (key && newestKeyed.get(key) !== i) return false; // superseded episode / slot
    if (isCrewQuietMarker(e) && !quietCrewIds.has(e.refId)) return false; // cleaner disabled or gone
    if (isSpecialServiceMarker(e) && !serviceRefs.has(e.refId)) return false; // service removed
    return !Number.isFinite(t) || t >= cutoffFor(e); // keep undated markers; prune only provably-old ones
  });
  // Absolute backstop against a pathological lookback — over the markers that are NOT already
  // bounded one-per-subject (shift, checklist, ticket escalation, pre-shift; the monthly supply
  // markers, the quiet cleaners and the special services are keyed), oldest first,
  // order kept.
  let over = kept.filter((e) => !keyedMarkerKey(e)).length - MARKER_BACKSTOP;
  const opsAlertEvents = over > 0
    ? kept.filter((e) => keyedMarkerKey(e) || over-- <= 0)
    : kept;

  // Fan-out reads the post-marker snapshot; the notifications helpers only touch
  // state.notifications/users/clients/permissions, none of which we changed here.
  const withMarker = { ...state, opsAlertEvents };
  // 🔴 ALR-12 (Matt, 2026-09-30): "the person copied on every missed alert is the account
  // manager/supervisor of the account." That is `client.supervisorId`, the SPOC this routes
  // to already — so ALR-4's org-wide `operationsManagerUserId` picker is GONE rather than
  // kept beside it (a second setting naming the same person could only ever be wrong).
  // The notification event this row carries. Almost always the kind itself; a ticket alert
  // overrides it so the row can say "this one is urgent" to the push dispatcher, which never
  // sees the ticket (lib/ticketAlerts ticketAlertEventKey).
  const eventKey = a.eventKey || a.kind;
  let notifications;
  if (a.pushOnly || a.markerOnly) {
    // 🔴 ALR-5: the marker is the whole point of coming through here — the caller delivers the
    // push itself. NO bell row: one per cleaner per shift is exactly what must not accumulate
    // in the shared record.
    notifications = withMarker.notifications || [];
  } else if (a.recipientScope === 'crew') {
    // The checklist nudge goes to the clean's assigned crew (they still owe the log);
    // the escalation tier routes to the supervisor instead.
    notifications = fanOutToUserIds(withMarker, { userIds: a.crewIds || [], eventKey, title: a.title, body: a.body, url: a.url });
  } else if (a.recipientScope === 'users') {
    // 🔴 CON-9 (CS-194): recipients the WALKER resolved, because the rule spans more than one
    // account — a master contract covers several buildings, so its renewal reminder reaches
    // every one of their supervisors AND the active owner(s), deduped (lib/contractReminders
    // contractAlertRecipients). Each id is still gated on its own pref + visibility inside
    // fanOutToUserIds, so a muted or ineligible recipient simply gets nothing; a walker that
    // can resolve NOBODY falls back to the office scope below rather than going silent.
    notifications = fanOutToUserIds(withMarker, { userIds: a.userIds || [], eventKey, title: a.title, body: a.body, url: a.url });
  } else if (a.recipientScope === 'office') {
    // 🔴 WO-5 / WO-16: the ticket ESCALATIONS ("after 30 minutes you're alerted too", and the
    // one when the priority's response time runs out) go to the OFFICE bench — owner, admin
    // and manager, each gated on their own pref + visibility. The bench already contains the
    // account's supervisor and the owner, so the escalation reaches them in the SAME fan-out
    // and nobody is rung twice (fanOutManagerAlert dedupes by iterating the roster once).
    // SUP-8: the supply order the office hears about "the day after if still nothing" uses this same bench (supplyOrderOverdue gates on supplies.manage).
    notifications = fanOutManagerAlert(withMarker, { eventKey, title: a.title, body: a.body, url: a.url });
  } else if (a.recipientScope === 'approver') {
    // SUP-10 ★a: the over-budget alert goes to whoever APPROVES this building's requests —
    // the building's supervisor by default, or the one person named in Settings → Operations
    // (resolveSupplyApprover, the same resolution the submit notification and the queue use).
    // No valid approver reaches nobody; the flag on the account is the standing surface.
    const approver = resolveSupplyApprover(withMarker, a.clientId);
    notifications = approver
      ? fanOutToUserIds(withMarker, { userIds: [approver.id], eventKey: a.kind, title: a.title, body: a.body, url: a.url })
      : withMarker.notifications || [];
  } else if (TICKET_KINDS.has(a.kind)) {
    // 🔴 WO-6: "the account's supervisor; the office if there's no supervisor or no reply." A
    // ticket REPEAT is the supervisor's to answer, so it goes to them alone — and, when the
    // account has no valid supervisor, to the office bench, or to the Admins for a customer's
    // request from the Client Hub (HUB-21, Matt, 2026-10-08: "the same as messages"). Never
    // nowhere. (The "or no reply" half is the 30-minute escalation above, not a widening of this
    // fan-out.) The walker copies the ticket's `origin` onto the alert and ticketFanOut is the one
    // chooser, shared with the creation ping in api/_lib/qc/store.js, so the first alert and every
    // repeat agree (CS-639).
    notifications = ticketFanOut(a.origin)(withMarker, {
      clientId: a.clientId, eventKey, title: a.title, body: a.body, url: a.url,
    });
  } else {
    // Route to the account SUPERVISOR (single point of contact). A shift alert is
    // time-critical, so with no valid SPOC it blankets the manager bench rather than
    // going silent. The scheduler is the system, so there is no actor to skip.
    const spoc = resolveAccountSupervisor(withMarker, a.clientId);
    if (!spoc) {
      // No SPOC — blanket the manager bench (owner/admin/manager), which already
      // includes the owner, so the missed-shift alert is never silent.
      notifications = fanOutManagerAlert(withMarker, { eventKey, title: a.title, body: a.body, url: a.url });
    } else if (reachesOwnerToo(a)) {
      // The missed-shift alert and the checklist escalation reach the SPOC AND the
      // owner — never the SPOC alone.
      // Clean Space runs on a single shared owner login (per-user logins collapse to one
      // identity), so an account supervised by another — often login-less — manager would
      // otherwise send this time-critical alert to a device that does not exist. Union
      // with the SPOC so an owner-SPOC is not double-notified; each recipient is still
      // gated on their own pref + visibility inside fanOutToUserIds.
      const ownerIds = (withMarker.users || [])
        .filter((u) => u && u.role === 'owner' && u.status === 'active')
        .map((u) => u.id);
      const userIds = [...new Set([spoc.id, ...ownerIds])];
      notifications = fanOutToUserIds(withMarker, { userIds, eventKey, title: a.title, body: a.body, url: a.url });
    } else {
      // The remaining supervisor alert (the inspection reminder) keeps SPOC-alone
      // routing (NOTIF-02).
      notifications = fanOutAccountAlert(withMarker, { clientId: a.clientId, eventKey, title: a.title, body: a.body, url: a.url });
    }
  }
  return { opsAlertEvents, notifications };
}
