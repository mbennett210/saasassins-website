// The QUIET-CLEANER alert (task #468 from Clean Corner's queue; the "Pilot prep and feature
// review" call, 2026-11-03). Matt: "if any of the crew has not been active on the app for 30
// days or more the account manager and uh the administrative staff receives an alert … because
// then we can turn them off and then remove them from our payroll system".
//
// Daniel's answers (2026-11-03):
//   1. ACTIVE = using the app: opening it signed in as themselves (a heartbeat,
//      api/state/heartbeat) or a clock-in recorded for them. Someone added who never signs in
//      counts from the day they were added (`users[].createdAt`).
//   2. WHO: the account manager of each building the cleaner is on the schedule for, plus every
//      Admin and Super Admin; a cleaner on no building's schedule, the Admins and Super Admins.
//      Each can turn it off for themselves (the `crewQuiet` switch, Account → Notifications).
//   3. ONCE PER QUIET STRETCH: named again only after they use the app again and go quiet for
//      another 30 days.
//   4. TIME OFF (HR › PTO, Team › Time off) leaves them out while it lasts; the 30 days start
//      over on the day it ends.
//   5. A BIG MORNING: a reader with 3 or fewer cleaners due that morning gets one alert each; a
//      reader with more gets one alert listing them, opening Settings → Team.
//
// It rides the ops-alert cron (api/cron/ops-alerts.js), cron-only: the heartbeats it reads are a
// service-role table no tab can see. It looks once a morning, in the first half hour after
// office hours open on an office day (lib/officeHours), so the reads run a handful of times a
// day and the alert lands at the start of the office's day.
//
// THE ONCE-PER-STRETCH MEMORY is a marker per cleaner named (`crewQuiet`, `refId` = the cleaner,
// no bell row of its own: `markerOnly`), kept newest-per-cleaner for as long as they are crew
// with access (lib/opsAlertApply). A cleaner is due only when no marker of theirs was fired
// after the moment their 30 days count from: coming back starts a stretch that can ring again,
// and a heartbeat reaped at 60 days (cron/reap) cannot make an old stretch ring twice.
//
// PURE + node-safe; `now` comes in. The words are MESSAGES (src/i18n/core.js msg), so each bell
// row is written in its reader's language (CS-193).
import { officeHoursConfig } from './officeHours.js';
import { dayKey, dayOfWeekKey, minutesInZone, diffDaysKey, addDaysKey, startOfDayKey } from './dates.js';
import { msg } from '../i18n/core.js';
import { hasTeamAccess } from './teamScope.js';
import { resolveAccountSupervisor, CREW_QUIET_EVENT } from './notifications.js';

// The notification event is declared ONCE, beside its catalog entry (lib/notifications, the 'hr'
// group), because the catalog is read at load time and this module imports that one.
export { CREW_QUIET_EVENT };
// The marker kinds. `crewQuiet` is the per-cleaner memory (no bell row); the two bell kinds
// are one run's rows, kept on the ordinary 48-hour horizon (their ids carry the day).
export const CREW_QUIET_MARKER_KIND = 'crewQuiet';
export const CREW_QUIET_ONE_KIND = 'crewQuietOne';
export const CREW_QUIET_LIST_KIND = 'crewQuietList';
export const CREW_QUIET_BELL_KINDS = Object.freeze(new Set([CREW_QUIET_ONE_KIND, CREW_QUIET_LIST_KIND]));

export const CREW_QUIET_DAYS = 30;             // Matt's number
export const CREW_QUIET_LIST_AFTER = 3;         // more than this for one reader → one list alert
export const CREW_QUIET_LIST_NAMES = 3;         // names a list alert spells out before "and N more"
export const CREW_QUIET_CHECK_WINDOW_MINS = 30; // the first half hour of office hours
// How far back the activity reads look: the heartbeats' own retention (cron/reap prunes rows
// unseen for 60 days), so a read further back could find nothing more.
export const CREW_QUIET_LOOKBACK_DAYS = 60;
// The cleans that tie a cleaner to a building: from 30 days back to 30 days ahead.
export const CREW_QUIET_BUILDING_DAYS = 30;
// At most this many cleaners named a run, the longest quiet first; the rest the next morning.
// Bounds one run's building reads (one indexed read per cleaner) inside the cron's 60 seconds.
export const CREW_QUIET_MAX_PER_RUN = 400;

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const msOf = (v) => {
  if (v == null || v === '') return NaN;
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
};

// Where each alert takes its reader: the cleaner's page in Team (where Status can be set to
// Disabled), or the Team list for a list alert.
export const crewQuietMemberUrl = (userId) => `/settings/team/${encodeURIComponent(userId)}`;
export const CREW_QUIET_LIST_URL = '/settings/team';

// Deterministic ids, so a repeat tick in the same morning (or a CAS retry) is a no-op.
export const crewQuietIds = {
  marker: (userId, day) => `oa_crewQuiet_${userId}_${day}`,
  one: (userId, day) => `oa_crewQuietOne_${userId}_${day}`,
  list: (recipientId, day) => `oa_crewQuietList_${recipientId}_${day}`,
};

// Is this the morning look? The first CREW_QUIET_CHECK_WINDOW_MINS after office hours open,
// on an office day, in the ORG's zone (an overnight window opens on the evening of its day).
export function inCrewQuietWindow(now, settings = {}, tz = null) {
  const { days, startMins } = officeHoursConfig(settings);
  const mins = minutesInZone(now, tz);
  const elapsed = (mins - startMins + 1440) % 1440;
  if (elapsed >= CREW_QUIET_CHECK_WINDOW_MINS) return false;
  const today = dayKey(now, tz);
  const openDay = mins >= startMins ? today : addDaysKey(today, -1);
  return days.includes(dayOfWeekKey(openDay));
}

// The cleaners the alert is about: crew with team access (active or invited; disabled is off).
export function crewQuietCandidates(state) {
  return ((state && state.users) || []).filter((u) => u && u.id && u.role === 'crew' && hasTeamAccess(u));
}

// The moment the time off booked for `userId` last moved their count: a stretch going on today
// is NOW (never due while it lasts); one that has ended counts from the start of its last day.
// A booking that hasn't started yet changes nothing. Day keys are the org's calendar days.
function timeOffFloorMs(timeOff, userId, now, tz) {
  const today = dayKey(now, tz);
  let best = NaN;
  for (const t of Array.isArray(timeOff) ? timeOff : []) {
    if (!t || t.userId !== userId) continue;
    const start = typeof t.startDate === 'string' ? t.startDate : '';
    const end = typeof t.endDate === 'string' ? t.endDate : '';
    if (!DAY_KEY_RE.test(start) || !DAY_KEY_RE.test(end) || start > today) continue;
    const ms = end >= today ? now : startOfDayKey(end, tz).getTime();
    best = Number.isFinite(best) ? Math.max(best, ms) : ms;
  }
  return best;
}

// The moment a cleaner's 30 days count from: the latest of their last app use, their last
// clock-in, the day they were added, and their time off (above). NaN when nothing is known —
// a legacy row with no `createdAt` and no activity is never due rather than a false alarm.
export function quietSinceMs(user, { lastSeenAt = null, lastPunchAt = null, timeOff = [], now, tz = null } = {}) {
  const parts = [msOf(lastSeenAt), msOf(lastPunchAt), msOf(user && user.createdAt), timeOffFloorMs(timeOff, user && user.id, now, tz)]
    .filter(Number.isFinite);
  return parts.length ? Math.max(...parts) : NaN;
}

// The latest moment they used the app (an app open or a clock-in), or NaN.
function lastUsedMs({ lastSeenAt = null, lastPunchAt = null } = {}) {
  const parts = [msOf(lastSeenAt), msOf(lastPunchAt)].filter(Number.isFinite);
  return parts.length ? Math.max(...parts) : NaN;
}

// The cleaners who need NO activity read to know they are not due: added inside the 30 days, or
// on (or just back from) time off. The cron reads activity only for the rest.
export function couldBeQuiet(user, { timeOff = [], now, tz = null } = {}) {
  const floor = quietSinceMs(user, { timeOff, now, tz });
  if (!Number.isFinite(floor)) return true; // no date to rule them out: their activity decides
  return diffDaysKey(dayKey(floor, tz), dayKey(now, tz)) >= CREW_QUIET_DAYS;
}

// The newest `crewQuiet` marker's firing moment per cleaner.
function namedAtByUser(markers) {
  const out = new Map();
  for (const e of Array.isArray(markers) ? markers : []) {
    if (!e || e.kind !== CREW_QUIET_MARKER_KIND || !e.refId) continue;
    const t = msOf(e.firedAt);
    if (!Number.isFinite(t)) continue;
    if (!(out.get(e.refId) >= t)) out.set(e.refId, t);
  }
  return out;
}

// The cleaners due right now, longest quiet first, at most CREW_QUIET_MAX_PER_RUN.
//   activity  Map userId → { lastSeenAt, lastPunchAt } (ISO strings or null), from the cron's
//             reads. A cleaner missing from it is read as no activity on record.
// → [{ user, sinceMs, lastUsedMs }]
export function dueQuietCrew({ state, activity, now, tz = null } = {}) {
  const today = dayKey(now, tz);
  const named = namedAtByUser(state && state.opsAlertEvents);
  const timeOff = (state && state.timeOff) || [];
  const due = [];
  for (const user of crewQuietCandidates(state)) {
    const act = (activity && typeof activity.get === 'function' && activity.get(user.id)) || {};
    const sinceMs = quietSinceMs(user, { ...act, timeOff, now, tz });
    if (!Number.isFinite(sinceMs)) continue;
    if (diffDaysKey(dayKey(sinceMs, tz), today) < CREW_QUIET_DAYS) continue;
    const namedAt = named.get(user.id);
    if (Number.isFinite(namedAt) && namedAt >= sinceMs) continue; // this stretch was named already
    due.push({ user, sinceMs, lastUsedMs: lastUsedMs(act) });
  }
  due.sort((a, b) => a.sinceMs - b.sinceMs || String(a.user.name || '').localeCompare(String(b.user.name || '')));
  return due.slice(0, CREW_QUIET_MAX_PER_RUN);
}

// Who hears about one cleaner: each building's account manager (lib/notifications
// resolveAccountSupervisor: set, active, still an eligible tier) plus every active Admin and
// Super Admin, deduped. Each is still gated on their own switch and visibility at the fan-out.
export function crewQuietRecipients(state, clientIds = []) {
  const ids = new Set();
  for (const cid of new Set(clientIds || [])) {
    const sup = resolveAccountSupervisor(state, cid);
    if (sup) ids.add(sup.id);
  }
  for (const u of (state && state.users) || []) {
    if (u && u.status === 'active' && (u.role === 'owner' || u.role === 'admin')) ids.add(u.id);
  }
  return [...ids];
}

// One cleaner's own sentence (title + body), shared by their bell and the activity log.
export function crewQuietCopy({ user, lastUsedMs: usedMs }, now) {
  const name = (user && user.name) || '';
  const title = name
    ? msg('alerts.crewQuiet.title', { name, days: CREW_QUIET_DAYS })
    : msg('alerts.crewQuiet.titleNoName', { days: CREW_QUIET_DAYS });
  const addedMs = msOf(user && user.createdAt);
  let body;
  if (Number.isFinite(usedMs)) body = msg('alerts.crewQuiet.bodyLastUsed', { date: new Date(usedMs).toISOString() });
  else if (Number.isFinite(addedMs) && now - addedMs <= CREW_QUIET_LOOKBACK_DAYS * DAY_MS) {
    body = msg('alerts.crewQuiet.bodyAdded', { date: new Date(addedMs).toISOString() });
  } else body = msg('alerts.crewQuiet.bodyNoRecord', { days: CREW_QUIET_LOOKBACK_DAYS });
  return { title, body };
}

// The alert records for this morning, in the shape applyOpsAlert consumes (`users` scope):
//   · one `crewQuiet` MARKER per cleaner named (markerOnly: no bell row; the activity log's row);
//   · per reader with ≤ CREW_QUIET_LIST_AFTER of them: one bell per cleaner, to every such reader;
//   · per reader with more: one list bell, to them alone.
//   due              dueQuietCrew's answer
//   buildingsByUser  Map userId → customer ids (their cleans; the cron's reads)
export function crewQuietAlerts({ state, due, buildingsByUser, now, tz = null } = {}) {
  const day = dayKey(now, tz);
  const items = (Array.isArray(due) ? due : []).map((d) => ({
    ...d,
    recipients: crewQuietRecipients(state, (buildingsByUser && typeof buildingsByUser.get === 'function' && buildingsByUser.get(d.user.id)) || []),
    copy: crewQuietCopy(d, now),
  }));
  const share = new Map(); // reader → the cleaners due for them
  for (const it of items) for (const r of it.recipients) share.set(r, [...(share.get(r) || []), it]);
  const listed = new Set([...share].filter(([, list]) => list.length > CREW_QUIET_LIST_AFTER).map(([r]) => r));

  const out = [];
  for (const it of items) {
    const userId = it.user.id;
    out.push({
      id: crewQuietIds.marker(userId, day), kind: CREW_QUIET_MARKER_KIND, refId: userId,
      markerOnly: true, recipientScope: 'users', userIds: [],
      title: it.copy.title, body: it.copy.body, url: crewQuietMemberUrl(userId),
    });
    const singles = it.recipients.filter((r) => !listed.has(r));
    if (singles.length) {
      out.push({
        id: crewQuietIds.one(userId, day), kind: CREW_QUIET_ONE_KIND, eventKey: CREW_QUIET_EVENT,
        recipientScope: 'users', userIds: singles,
        title: it.copy.title, body: it.copy.body, url: crewQuietMemberUrl(userId),
      });
    }
  }
  for (const r of listed) {
    const list = [...share.get(r)].sort((a, b) => String(a.user.name || '').localeCompare(String(b.user.name || '')));
    const shown = list.slice(0, CREW_QUIET_LIST_NAMES).map((it) => it.user.name || '');
    const rest = list.length - shown.length;
    out.push({
      id: crewQuietIds.list(r, day), kind: CREW_QUIET_LIST_KIND, eventKey: CREW_QUIET_EVENT,
      recipientScope: 'users', userIds: [r],
      title: msg('alerts.crewQuiet.listTitle', { count: list.length, days: CREW_QUIET_DAYS }),
      body: msg('alerts.crewQuiet.listBody', {
        names: rest > 0 ? [...shown, msg('alerts.crewQuiet.more', { count: rest })] : shown,
      }),
      url: CREW_QUIET_LIST_URL,
    });
  }
  return out;
}
