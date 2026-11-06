// ONE rule for which customers and locations a cleaner WORKS AT (CS-005): the ones a clean names
// them on — `job.crewIds`, the single source of truth for a clean's crew (lib/crewResolve) —
// plus every location of those customers (one location per customer today, so in practice the
// building itself). Pure and node-safe: the server and the screens import the same function,
// so what a cleaner may read or submit and what the app shows them cannot disagree.
//
// Readers:
//   · api/qc/[...path].js `crewScopeFor` — checklist submit, work orders, inspections, the
//     area status, the reports: unioned with the standing-assignment table;
//   · api/_lib/authz.js `crewAssignedScope` — its job half (the CS-002 crew view and merge);
//   · src/store/selectors.js `selectVisibleClientIdsFor` — the customers a cleaner's screens list.
//
// WHY JOBS, NOT THE TABLE. `crew_assignments` is derived from `standingCrewIds`, which the app
// stopped writing on 2026-09-09 (crew became exactly the schedule's); once synced it held
// nothing but its marker, so a scope read from it alone was empty and every cleaner's checklist
// submit at their own building answered 403. Scheduling is the assignment now.
// WHY IT IS SAFE: a browser cannot write public.jobs (Increment 1e) and jobsGuard puts back a
// cleaner's change to a clean's crew, site or time, so a clean naming yourself at a building is
// not something a cleaner can make — the same footing the door-code reveal's job path stands on.
import { isUserJobCrew } from './crewResolve.js';

// → { clientIds: Set, siteIds: Set }. A clean with no clientId counts for its site's customer.
export function crewScopeFromJobs({ jobs = [], sites = [], userId = null } = {}) {
  const clientIds = new Set();
  const siteIds = new Set();
  if (!userId) return { clientIds, siteIds };
  const siteList = Array.isArray(sites) ? sites : [];
  const siteClient = new Map();
  for (const s of siteList) if (s && s.id) siteClient.set(s.id, s.clientId || null);
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!isUserJobCrew(j, userId)) continue;
    const cid = j.clientId || (j.siteId ? siteClient.get(j.siteId) : null);
    if (cid) clientIds.add(cid);
    if (j.siteId) siteIds.add(j.siteId);
  }
  for (const s of siteList) if (s && s.id && s.clientId && clientIds.has(s.clientId)) siteIds.add(s.id);
  return { clientIds, siteIds };
}

// The customers a cleaner cleans TODAY (the delivery step, plan 2026-10-12 §2, S6: "for a building
// they clean today … only buildings the cleaner is scheduled at"): the same rule, narrowed to their
// cleans that START on `todayKey` — the org-zone day of now — and are not cancelled. `dayKeyOf(iso)`
// is the caller's org-zone day key (lib/dates dayKey with the org's zone): this module stays
// zone-free. Readers: api/supplies GET onsite and its demo stub. → a Set of client ids.
export function crewTodayClientIds({ jobs = [], sites = [], userId = null, todayKey = '', dayKeyOf = () => null } = {}) {
  if (!userId || !todayKey) return new Set();
  const today = (Array.isArray(jobs) ? jobs : []).filter((j) => j && j.status !== 'cancelled'
    && j.startAt && dayKeyOf(j.startAt) === todayKey);
  return crewScopeFromJobs({ jobs: today, sites, userId }).clientIds;
}

// The customers a cleaner may ASK FOR SUPPLIES for (the Cleaner Hub, D4, 2026-10-13: "the building
// must be one the cleaner works — their cleans today or upcoming"): the same rule, narrowed to their
// cleans that start on `todayKey` or later — plus one still IN PROGRESS from an earlier day (a night
// clean that crossed midnight) — none cancelled. A building they cleaned only in the past is not
// theirs to order for. Readers: api/supplies GET crew-list and requests/create (a crew caller), and
// the demo stub. → a Set of client ids.
export function crewUpcomingClientIds({ jobs = [], sites = [], userId = null, todayKey = '', dayKeyOf = () => null } = {}) {
  if (!userId || !todayKey) return new Set();
  const live = (Array.isArray(jobs) ? jobs : []).filter((j) => {
    if (!j || j.status === 'cancelled' || !j.startAt) return false;
    if (j.status === 'in_progress') return true;
    const k = dayKeyOf(j.startAt);
    return typeof k === 'string' && k >= todayKey;
  });
  return crewScopeFromJobs({ jobs: live, sites, userId }).clientIds;
}
