// Pure application of ONE operational alert onto a store snapshot: dedup, marker
// retention, and recipient routing. The shared write path for RAISE_OPS_ALERT (the
// client reducer) AND the go-live server cron (app/api/cron/ops-alerts.js), so both
// raise, retain, and route identically. Extracted from the reducer, which is
// un-importable under node (same precedent as lib/deleteCascade.js).
import {
  fanOutToUserIds, fanOutAccountAlert, fanOutManagerAlert, resolveAccountSupervisor,
} from './notifications.js';
import { shiftLookbackHours, INSPECTION_LOOKBACK_DAYS } from './opsAlerts.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MARKER_BACKSTOP = 5000;
const isInspectionMarker = (e) => !!e && e.kind === 'inspectionDue';
// Missed/late-shift alerts ALSO reach the owner, not the account SPOC alone (see the
// routing block below).
const SHIFT_ALERT_KINDS = new Set(['shiftLate', 'shiftMissed']);
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
// `alert`: { id, kind, recipientScope ('supervisor'|'crew'), clientId, jobId,
//            crewIds, title, body, url }. `now` (ms) is injected so the caller owns
//            the clock (reducer/cron pass Date.now(); tests pin it).
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
  const shiftCutoff = now - Math.max(shiftLookbackHours(state.opsSettings || {}) * 2, 48) * HOUR_MS;
  const inspectionCutoff = now - (INSPECTION_LOOKBACK_DAYS + 1) * DAY_MS;
  const all = [
    ...fired,
    { id: a.id, kind: a.kind, clientId: a.clientId || null, jobId: a.jobId || null, firedAt: new Date(now).toISOString() },
  ];
  const newestInspection = new Map(); // clientId -> index of its newest inspection marker
  all.forEach((e, i) => { if (isInspectionMarker(e) && e.clientId) newestInspection.set(e.clientId, i); });
  const kept = all.filter((e, i) => {
    const t = e && e.firedAt ? new Date(e.firedAt).getTime() : NaN;
    if (isInspectionMarker(e)) {
      if (e.clientId && newestInspection.get(e.clientId) !== i) return false; // superseded episode
      return !Number.isFinite(t) || t >= inspectionCutoff;
    }
    return !Number.isFinite(t) || t >= shiftCutoff; // keep undated markers; prune only provably-old ones
  });
  // Absolute backstop against a pathological lookback — over the shift/checklist markers
  // only, oldest first, order kept.
  let over = kept.filter((e) => !isInspectionMarker(e)).length - MARKER_BACKSTOP;
  const opsAlertEvents = over > 0
    ? kept.filter((e) => isInspectionMarker(e) || over-- <= 0)
    : kept;

  // Fan-out reads the post-marker snapshot; the notifications helpers only touch
  // state.notifications/users/clients/permissions, none of which we changed here.
  const withMarker = { ...state, opsAlertEvents };
  let notifications;
  if (a.recipientScope === 'crew') {
    // The checklist nudge goes to the clean's assigned crew (they still owe the log);
    // the escalation tier routes to the supervisor instead.
    notifications = fanOutToUserIds(withMarker, { userIds: a.crewIds || [], eventKey: a.kind, title: a.title, body: a.body, url: a.url });
  } else {
    // Route to the account SUPERVISOR (single point of contact). A shift alert is
    // time-critical, so with no valid SPOC it blankets the manager bench rather than
    // going silent. The scheduler is the system, so there is no actor to skip.
    const spoc = resolveAccountSupervisor(withMarker, a.clientId);
    if (!spoc) {
      // No SPOC — blanket the manager bench (owner/admin/manager), which already
      // includes the owner, so the missed/late alert is never silent.
      notifications = fanOutManagerAlert(withMarker, { eventKey: a.kind, title: a.title, body: a.body, url: a.url });
    } else if (reachesOwnerToo(a)) {
      // Missed/late-shift alerts and the checklist escalation reach the SPOC AND the
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
      notifications = fanOutToUserIds(withMarker, { userIds, eventKey: a.kind, title: a.title, body: a.body, url: a.url });
    } else {
      // The remaining supervisor alert (the inspection reminder) keeps SPOC-alone
      // routing (NOTIF-02).
      notifications = fanOutAccountAlert(withMarker, { clientId: a.clientId, eventKey: a.kind, title: a.title, body: a.body, url: a.url });
    }
  }
  return { opsAlertEvents, notifications };
}
