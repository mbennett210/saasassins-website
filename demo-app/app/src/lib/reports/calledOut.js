// Pure, node-safe. "Called out" for a day = cleaners with a CALL-OUT time-off entry
// covering that day (store/timeOffRules.isCallOut: kind 'callout', or an entry from
// before the call-out/planned type existed), with the cleans they called out of:
//   · the cleans that day they are still on the crew of, PLUS
//   · the cleans that day the booking recorded they were on (entry.scheduledJobIds).
// The second half is the fix: Team › Time off takes the person off cleans already on the
// calendar by default, and the office swaps cover in by hand after either booking screen
// — and this report used to find cleans only through the crew list, so a properly logged
// call-out showed "—, 0 cleans", and vanished entirely once a Manager or Customer filter
// was set. A clean with no crew member who is actually available (everyone left on it is
// booked off that day too) is flagged `uncovered` — it still needs someone. Planned time
// off (a vacation booked ahead) is not a call-out and is not listed.
//
// Days are the ORG's calendar days (lib/dates) — the same days the time-off entries are
// keyed in and the schedule buckets cleans by.
import { dayKey as orgDayKey } from '../dates.js';
import { isCallOut, isUserOffOn } from '../../store/timeOffRules.js';

const TERMINAL_JOB = new Set(['cancelled', 'canceled']);

// Cleaners called out on `dayKey`, one row per cleaner:
//   { userId, userName, reason, cleans: [{ jobId, clientId, supervisorId, clientName,
//     startAt, uncovered }], cleanCount, uncoveredCount, customers }
// managerId / clientId scope by those cleans (a called-out cleaner with no clean under
// the filter is dropped when a filter is set; unfiltered, they are listed anyway).
export function calledOutOn({
  timeOff = [], jobs = [], usersById = new Map(), clientsById = new Map(), sitesById = new Map(),
  dayKey, managerId = null, clientId = null,
} = {}) {
  if (!dayKey) return [];

  // The day's live cleans, indexed by id and by crew member.
  const jobsById = new Map();
  const onCrewByUser = new Map();
  for (const job of jobs) {
    if (!job || !job.id || TERMINAL_JOB.has(job.status)) continue;
    if (orgDayKey(job.startAt) !== dayKey) continue;
    jobsById.set(job.id, job);
    for (const uid of job.crewIds || []) {
      if (!onCrewByUser.has(uid)) onCrewByUser.set(uid, []);
      onCrewByUser.get(uid).push(job);
    }
  }

  // Each cleaner's call-outs covering the day (one row per cleaner, even with two entries).
  const entriesByUser = new Map();
  for (const t of timeOff || []) {
    if (!t || !t.userId || !isCallOut(t)) continue;
    if (!(t.startDate <= dayKey && dayKey <= t.endDate)) continue;
    if (!entriesByUser.has(t.userId)) entriesByUser.set(t.userId, []);
    entriesByUser.get(t.userId).push(t);
  }

  const rows = [];
  for (const [userId, entries] of entriesByUser) {
    const cleanJobs = new Map();
    for (const job of onCrewByUser.get(userId) || []) cleanJobs.set(job.id, job);
    for (const t of entries) {
      for (const id of t.scheduledJobIds || []) {
        const job = jobsById.get(id);          // only cleans on THIS day that still exist
        if (job) cleanJobs.set(job.id, job);
      }
    }
    const cleans = [...cleanJobs.values()]
      .map((job) => {
        const client = job.clientId ? clientsById.get(job.clientId) : null;
        // Covered only if someone on the crew is NOT booked off that day.
        const available = (Array.isArray(job.crewIds) ? job.crewIds : []).filter((uid) => !isUserOffOn(timeOff, uid, job.startAt));
        return {
          jobId: job.id,
          clientId: job.clientId || null,
          supervisorId: client?.supervisorId || null,
          clientName: client?.name || (job.siteId ? sitesById.get(job.siteId)?.name : null) || '—',
          startAt: job.startAt,
          uncovered: available.length === 0,
        };
      })
      .sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
    const filtering = !!(clientId || managerId);
    const shown = filtering
      ? cleans.filter((c) => (!clientId || c.clientId === clientId) && (!managerId || c.supervisorId === managerId))
      : cleans;
    if (filtering && shown.length === 0) continue; // no clean under the filter
    const first = entries[0];
    rows.push({
      userId,
      // A deleted cleaner's call-out is kept and carries their name (DELETE_USER stamps
      // userName), so they don't read as "—".
      userName: usersById.get(userId)?.name || first.userName || '—',
      reason: entries.map((t) => t.reason).filter(Boolean).join('; '),
      cleans: shown,
      cleanCount: shown.length,
      uncoveredCount: shown.filter((c) => c.uncovered).length,
      customers: [...new Set(shown.map((c) => c.clientName))],
    });
  }
  return rows.sort((a, b) => a.userName.localeCompare(b.userName));
}
