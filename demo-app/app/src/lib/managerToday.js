// The manager's TODAY — PURE, node-safe (no React, no store, no browser globals; `.js` on every
// import). ONE answer to "for each of today's visits in this manager's buildings, where does
// it stand?", shared by every screen that asks it: Shift check-in (/check-in), the Schedule's
// Today view, Checklists today (/checklists) and, from Wave B, the manager Home's band and
// tiles (Matt's "Account Manager Hub" design, plan docs/plans/2026-10-09-manager-view-
// redesign.md §3.2). The hook that feeds it is hooks/useManagerToday.js.
//
// BUILT ON THE ATTENDANCE ENGINE, never beside it. lib/attendanceReport's per-cleaner statuses
// are Matt's answered rules (ALR-11: ONE missed-shift mark, opsSettings.missedAfterStartMins);
// this module only folds them into one status per VISIT and adds two display states:
//   • late — past the start, nobody clocked in, still inside the missed mark. A LABEL ONLY: no
//     alert fires on it (ALR-11 stands). It is attendanceReport.noPunchStatus answering
//     "upcoming" while the clock is past the start — the same function the report uses.
//   • the checklist's state, from the day's SAVED checklists. There is no live item count: a
//     checklist counts once the cleaner saves it (Daniel's hub ruling 2026-10-08, plan S9).
//
// ── Inputs ─────────────────────────────────────────────────────────────────────────────────
//   jobs         state.jobs. A visit is a clean whose START falls on the org day of `now`
//                (the attendance report's rule: an 11 PM clean running past midnight belongs
//                to the night it started; last night's clean is not today's visit).
//   timeEntries  EVERY punch around the day (timeApi.entriesAll, lite, read over
//                todayWindow().readFromIso/readToIso — a complete read, never newest-N).
//   checklists   the day's SAVED checklists (qcApi.listChecklists({ fromIso, toIso }), the
//                complete window read). A save counts for a visit only when it is bound to that
//                clean and made by that person — the clock-out gate's own match (its narrow
//                columns carry no template id, so the template is not compared).
//   timeOff      state.timeOff (store/timeOffRules).
//   users, clients, sites   the roster, the customers (supervisorId, crewChecklists), sites.
//   opsSettings  the office's settings; the mark is read through opsAlerts.missedAfterStartMins.
//   managerId    null = every building (ALL_MANAGERS); NO_MANAGER = buildings with no
//                supervisor; an array of ids = any of them (an Operations Manager's team,
//                S131, lib/teamScope); else client.supervisorId === managerId.
//   now          the moment every status is judged against (the screen's "as of").
//   tz           the org zone (lib/dates; omitted, the ambient org zone).
//
// ── Output (the shape Builder B's Home reads — keep it stable) ────────────────────────────
//   { dayKey, asOf, visits: Visit[], counts }
//   Visit = {
//     jobId, clientId, siteId, customerLabel,            customerLabel: customer → site → null
//     startAt, endAt, group: 'day' | 'evening',          day = starts before EVENING_FROM_MINS
//     crew: [{ userId, name, phone }],                    who is due on it, schedule order;
//                                                         crew[0] is the one a Call rings (S3)
//     calledOut: [{ userId, name, offKind }],             booked off (still on it, or taken off
//                                                         it by the booking's scheduledJobIds)
//     offKind: 'callout' | 'planned' | null,              for a called_out visit
//     status: VISIT_STATUS,                               done | in_progress | late |
//                                                         no_check_in | upcoming | called_out
//     arrivedAt: ISO | null,                              the first clock-in on the visit
//     arrivedLateMins: number | null,                     minutes the first clock-in came after
//                                                         the start (0 when on time)
//     minutesPast: number | null,                         for late / no_check_in only
//     checklist: CHECKLIST_STATE,                         complete | not_finished |
//                                                         in_progress | not_started | none
//     completed, total: number | null,                    the STORED counts of the saved rows
//     results: [{ id, userId, jobId, completed, total, performedAt }],  the saved rows counted
//     blocksClockOut: boolean,                            someone owing a checklist here still
//                                                         has the clock-out block on (the
//                                                         office can turn it off per cleaner)
//   }
//   counts = { total, onSite, late, noCheckIn, upcoming, done, calledOut, properties, day,
//              evening, checklists: { complete, notFinished, inProgress, notStarted, none } }
import {
  computeAttendanceReport, noPunchStatus, ATT_NO_PUNCH, ATT_OFF,
} from './attendanceReport.js';
import { missedAfterStartMins } from './opsAlerts.js';
import { checklistFor, isChecklistComplete } from './crewChecklist.js';
import { isCallOut } from '../store/timeOffRules.js';
import { dayKey as orgDayKey, startOfDayKey, addDaysKey, minutesInZone } from './dates.js';

export const VISIT_STATUS = Object.freeze({
  DONE: 'done',
  IN_PROGRESS: 'in_progress',
  LATE: 'late',
  NO_CHECK_IN: 'no_check_in',
  UPCOMING: 'upcoming',
  CALLED_OUT: 'called_out',
});

export const CHECKLIST_STATE = Object.freeze({
  COMPLETE: 'complete',
  NOT_FINISHED: 'not_finished',
  IN_PROGRESS: 'in_progress',
  NOT_STARTED: 'not_started',
  NONE: 'none',
});

export const VISIT_GROUP = Object.freeze({ DAY: 'day', EVENING: 'evening' });

// S1 (plan §2.3): the data has no "day porter" or shift type, so the two groups split by the
// start's org wall clock — before 3:00 PM is Day, from 3:00 PM on is Evening.
export const EVENING_FROM_MINS = 15 * 60;

// The manager scope. null reads every building; NO_MANAGER the ones nobody supervises (the
// Approvals screen's "No manager" option uses the same 'none').
export const ALL_MANAGERS = null;
export const NO_MANAGER = 'none';

// The punch / checklist read around the org day: an early clock-in the evening before, and
// a night clean clocked into (or its checklist saved) after midnight. The Attendance report's
// padding, so the two read the same punches for the same day.
export const READ_PAD_BEFORE_MS = 12 * 3600 * 1000;
export const READ_PAD_AFTER_MS = 18 * 3600 * 1000;

const MIN = 60 * 1000;
const CANCELLED = new Set(['cancelled', 'canceled']);
const OFFICE_DONE = new Set(['done', 'completed']);
const ms = (iso) => { const t = new Date(iso).getTime(); return Number.isFinite(t) ? t : NaN; };
const isActive = (u) => !!u && u.status === 'active';

// The org day `now` falls on, its bounds, and the padded window the punch and checklist
// reads cover. toMs is one millisecond before the next day's midnight (a punch carries seconds).
export function todayWindow(now = Date.now(), tz) {
  const key = orgDayKey(new Date(now), tz);
  const fromMs = startOfDayKey(key, tz).getTime();
  const toMs = startOfDayKey(addDaysKey(key, 1), tz).getTime() - 1;
  return {
    dayKey: key,
    fromMs,
    toMs,
    readFromIso: new Date(fromMs - READ_PAD_BEFORE_MS).toISOString(),
    readToIso: new Date(toMs + READ_PAD_AFTER_MS).toISOString(),
  };
}

// Does this building belong to the scope? A list of managers is a TEAM (S131): any of them.
export function inManagerScope(client, managerId) {
  if (managerId === ALL_MANAGERS || managerId === undefined || managerId === '') return true;
  if (managerId === NO_MANAGER) return !client?.supervisorId;
  if (Array.isArray(managerId)) return !!client && !!client.supervisorId && managerId.includes(client.supervisorId);
  return !!client && client.supervisorId === managerId;
}

// The order a visit's checklist state takes from its cleaners: the LEAST finished decides
// (one cleaner done and one still working is a visit still in progress).
const CHECKLIST_RANK = {
  [CHECKLIST_STATE.NOT_STARTED]: 0,
  [CHECKLIST_STATE.IN_PROGRESS]: 1,
  [CHECKLIST_STATE.NOT_FINISHED]: 2,
  [CHECKLIST_STATE.COMPLETE]: 3,
};

const newestFirst = (a, b) => (ms(b.performed_at) || 0) - (ms(a.performed_at) || 0);

export function computeManagerToday({
  jobs = [], timeEntries = [], checklists = [], timeOff = [], users = [], clients = [], sites = [],
  opsSettings = {}, managerId = ALL_MANAGERS, now = Date.now(), tz,
} = {}) {
  const win = todayWindow(now, tz);
  const graceMins = missedAfterStartMins(opsSettings || {});
  const usersById = new Map((users || []).filter(Boolean).map((u) => [u.id, u]));
  const clientsById = new Map((clients || []).filter(Boolean).map((c) => [c.id, c]));
  const sitesById = new Map((sites || []).filter(Boolean).map((s) => [s.id, s]));

  // Today's live visits in scope.
  const dayJobs = (jobs || []).filter((j) => {
    if (!j || !j.id || CANCELLED.has(j.status)) return false;
    const t = ms(j.startAt);
    if (!(Number.isFinite(t) && t >= win.fromMs && t <= win.toMs)) return false;
    return inManagerScope(j.clientId ? clientsById.get(j.clientId) : null, managerId);
  });

  // Per (cleaner, clean) attendance, judged by the engine (ALR-11).
  const rows = computeAttendanceReport({
    jobs: dayJobs, timeEntries: timeEntries || [], usersById, clientsById, sitesById,
    fromMs: win.fromMs, toMs: win.toMs, now, graceMins, timeOff: timeOff || [],
  });
  const rowsByJob = new Map();
  for (const r of rows) {
    if (!rowsByJob.has(r.jobId)) rowsByJob.set(r.jobId, []);
    rowsByJob.get(r.jobId).push(r);
  }

  // Bookings that took someone OFF a clean (Team › Time off does by default): the entry
  // records the cleans it covered, so a visit emptied by a call-out still says who.
  const bookedOffByJob = new Map();
  for (const t of timeOff || []) {
    if (!t || !t.userId || !Array.isArray(t.scheduledJobIds)) continue;
    if (!(t.startDate <= win.dayKey && win.dayKey <= t.endDate)) continue;
    for (const id of t.scheduledJobIds) {
      if (!bookedOffByJob.has(id)) bookedOffByJob.set(id, []);
      bookedOffByJob.get(id).push(t);
    }
  }

  // The day's saved checklists, indexed once by clean + person. ONLY a save bound to the clean
  // counts — the clock-out gate's rule (api/_lib/time/checklistGate reads job_id = the clean),
  // so "complete" here means what unlocks that cleaner's clock-out. The reminder walker's
  // looser 18-hour match by building would hand tonight's visit a save from this morning.
  const savedOnJob = new Map();
  for (const r of checklists || []) {
    if (!r || !r.completed_by_user_id || !r.job_id) continue;
    const k = `${r.job_id}|${r.completed_by_user_id}`;
    if (!savedOnJob.has(k)) savedOnJob.set(k, []);
    savedOnJob.get(k).push(r);
  }
  const savedFor = (job, userId) => [...(savedOnJob.get(`${job.id}|${userId}`) || [])].sort(newestFirst);

  const person = (userId) => {
    const u = usersById.get(userId);
    return { userId, name: u?.name || null, phone: u?.phone || null };
  };

  const visits = dayJobs.map((job) => {
    const startMs = ms(job.startAt);
    const client = job.clientId ? clientsById.get(job.clientId) : null;
    const site = job.siteId ? sitesById.get(job.siteId) : null;
    const jobRows = rowsByJob.get(job.id) || [];

    // Who is DUE: not booked off, and still on the roster — unless they punched anyway (a
    // punch is a fact whoever made it).
    const due = jobRows.filter((r) => r.status !== ATT_OFF && (r.clockInAt || isActive(usersById.get(r.userId))));
    const punched = due.filter((r) => r.clockInAt);
    const onCrew = new Set(jobRows.map((r) => r.userId));
    const offRows = jobRows.filter((r) => r.status === ATT_OFF);
    const takenOff = (bookedOffByJob.get(job.id) || []).filter((t) => !onCrew.has(t.userId));
    const calledOut = [
      ...offRows.map((r) => ({ ...person(r.userId), offKind: r.offKind })),
      ...takenOff.map((t) => ({ ...person(t.userId), offKind: isCallOut(t) ? 'callout' : 'planned' })),
    ].filter((p, i, all) => all.findIndex((q) => q.userId === p.userId) === i)
      .map(({ userId, name, offKind }) => ({ userId, name, offKind }));

    let status;
    if (punched.some((r) => !r.clockOutAt)) status = VISIT_STATUS.IN_PROGRESS;
    else if (punched.length) status = VISIT_STATUS.DONE;
    else if (OFFICE_DONE.has(job.status)) status = VISIT_STATUS.DONE;
    else if (!due.length && calledOut.length) status = VISIT_STATUS.CALLED_OUT;
    else if (noPunchStatus(startMs, now, graceMins) === ATT_NO_PUNCH) status = VISIT_STATUS.NO_CHECK_IN;
    else status = now > startMs ? VISIT_STATUS.LATE : VISIT_STATUS.UPCOMING;

    const firstIn = punched.map((r) => r.clockInAt).sort()[0] || null;
    const lateBy = firstIn ? Math.floor((ms(firstIn) - startMs) / MIN) : null;

    // The checklist: owed by each due cleaner the resolver gives one (covers included, R8).
    let checklist = CHECKLIST_STATE.NONE;
    let completed = null;
    let total = null;
    const results = [];
    let blocksClockOut = false;
    const owing = due.filter((r) => checklistFor({ client, job, userId: r.userId }));
    if (owing.length) {
      let rank = Infinity;
      for (const r of owing) {
        const saved = savedFor(job, r.userId);
        const finished = saved.find(isChecklistComplete);
        const shown = finished || saved[0] || null;
        let state;
        if (finished) state = CHECKLIST_STATE.COMPLETE;
        else if (shown) state = CHECKLIST_STATE.NOT_FINISHED;
        else if (r.clockInAt && !r.clockOutAt) state = CHECKLIST_STATE.IN_PROGRESS;
        else if (r.clockInAt) state = CHECKLIST_STATE.NOT_FINISHED;     // left with nothing saved
        else state = CHECKLIST_STATE.NOT_STARTED;
        if (CHECKLIST_RANK[state] < rank) { rank = CHECKLIST_RANK[state]; checklist = state; }
        if (shown) {
          completed = (completed || 0) + (Number(shown.completed_count) || 0);
          total = (total || 0) + (Number(shown.total_count) || 0);
          results.push({
            id: shown.id ?? null, userId: r.userId, jobId: shown.job_id ?? null,
            completed: Number(shown.completed_count) || 0, total: Number(shown.total_count) || 0,
            performedAt: shown.performed_at || null,
          });
        }
        if (usersById.get(r.userId)?.clockRules?.checklistBlockOff !== true) blocksClockOut = true;
      }
    }

    const late = status === VISIT_STATUS.LATE || status === VISIT_STATUS.NO_CHECK_IN;
    return {
      jobId: job.id,
      clientId: job.clientId || null,
      siteId: job.siteId || null,
      customerLabel: client?.name || site?.name || null,
      startAt: job.startAt || null,
      endAt: job.endAt || null,
      group: minutesInZone(new Date(startMs), tz) < EVENING_FROM_MINS ? VISIT_GROUP.DAY : VISIT_GROUP.EVENING,
      crew: due.map((r) => person(r.userId)),
      calledOut,
      offKind: status === VISIT_STATUS.CALLED_OUT
        ? (calledOut.some((p) => p.offKind === 'callout') ? 'callout' : 'planned')
        : null,
      status,
      arrivedAt: firstIn,
      arrivedLateMins: lateBy == null ? null : Math.max(0, lateBy),
      minutesPast: late ? Math.max(0, Math.floor((now - startMs) / MIN)) : null,
      checklist,
      completed,
      total,
      results,
      blocksClockOut,
    };
  });

  visits.sort((a, b) => (ms(a.startAt) - ms(b.startAt))
    || String(a.customerLabel || '').localeCompare(String(b.customerLabel || ''))
    || String(a.jobId).localeCompare(String(b.jobId)));

  return { dayKey: win.dayKey, asOf: new Date(now).toISOString(), visits, counts: countVisits(visits) };
}

// The tallies every screen's tiles read. Exported so a screen that narrows the list (a
// customer filter) can recount the narrowed set with the same rule.
export function countVisits(visits = []) {
  const c = {
    total: 0, onSite: 0, late: 0, noCheckIn: 0, upcoming: 0, done: 0, calledOut: 0, properties: 0,
    day: 0, evening: 0,
    checklists: { complete: 0, notFinished: 0, inProgress: 0, notStarted: 0, none: 0 },
  };
  const buildings = new Set();
  for (const v of visits || []) {
    c.total += 1;
    if (v.status === VISIT_STATUS.IN_PROGRESS) c.onSite += 1;
    else if (v.status === VISIT_STATUS.LATE) c.late += 1;
    else if (v.status === VISIT_STATUS.NO_CHECK_IN) c.noCheckIn += 1;
    else if (v.status === VISIT_STATUS.UPCOMING) c.upcoming += 1;
    else if (v.status === VISIT_STATUS.DONE) c.done += 1;
    else if (v.status === VISIT_STATUS.CALLED_OUT) c.calledOut += 1;
    if (v.group === VISIT_GROUP.DAY) c.day += 1; else c.evening += 1;
    buildings.add(v.clientId || v.siteId || v.jobId);
    if (v.checklist === CHECKLIST_STATE.COMPLETE) c.checklists.complete += 1;
    else if (v.checklist === CHECKLIST_STATE.NOT_FINISHED) c.checklists.notFinished += 1;
    else if (v.checklist === CHECKLIST_STATE.IN_PROGRESS) c.checklists.inProgress += 1;
    else if (v.checklist === CHECKLIST_STATE.NOT_STARTED) c.checklists.notStarted += 1;
    else c.checklists.none += 1;
  }
  c.properties = buildings.size;
  return c;
}

// "Problems first": no check-in, then late, then in progress, upcoming, done, called out —
// then by start. The Shift check-in screen's order.
const PROBLEM_ORDER = {
  [VISIT_STATUS.NO_CHECK_IN]: 0,
  [VISIT_STATUS.LATE]: 1,
  [VISIT_STATUS.IN_PROGRESS]: 2,
  [VISIT_STATUS.UPCOMING]: 3,
  [VISIT_STATUS.DONE]: 4,
  [VISIT_STATUS.CALLED_OUT]: 5,
};
export function problemsFirst(visits = []) {
  return [...(visits || [])].sort((a, b) => (PROBLEM_ORDER[a.status] - PROBLEM_ORDER[b.status])
    || (ms(a.startAt) - ms(b.startAt))
    || String(a.customerLabel || '').localeCompare(String(b.customerLabel || '')));
}
