// THE single source of truth for a job's crew.
//
// Crew is exactly what the schedule names: job.crewIds. Every clean is created
// and edited with at least one named cleaner (enforced at save in NewJobModal /
// JobDetail and at the write point in the reducer), so there is no default,
// "standing" or "regular" crew to fall back to. Assignment, My Day visibility,
// door/alarm-code access and notification routing all flow from job.crewIds.
//
// Consolidates the rule that had drifted across selectors.js
// (isJobAssignedToUser / selectEffectiveCrewForJob / selectJobsForUser /
// effectiveCrewIdSet), the recipient union in notifications.js, and the draft
// check in timeOffRules.js. Keeping them as separate copies is what let it rot.

// The resolved crew of a job, as a Set of user ids.
export function resolveJobCrewIds(job) {
  return new Set(Array.isArray(job?.crewIds) ? job.crewIds.filter(Boolean) : []);
}

// Is `userId` on the job's crew? Allocation-light hot path (selectJobsForUser
// runs it over the whole jobs array on the crew's My Day).
export function isUserJobCrew(job, userId) {
  if (!job || !userId) return false;
  return Array.isArray(job.crewIds) && job.crewIds.includes(userId);
}
