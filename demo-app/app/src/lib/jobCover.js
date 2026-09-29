// The cover model — PURE / node-safe (no imports, no browser globals), so the reducer,
// the JobDetail edit and the offline suites share ONE rule.
//
// R8 (Daniel, 2026-09-27): **a cleaner covering someone's shift gets the covered cleaner's
// checklist for that clean.** The record is
//
//     job.coverFor = { [coverUserId]: coveredUserId }
//
// on a SINGLE visit. It lives inside `public.jobs.data`, so there is NO migration, and it
// is additive + default-safe (every reader defaults to null), so NO store-version bump.
// `lib/crewChecklist.checklistFor` is the only thing that reads it for a decision; this
// module owns the shape, the prune, and the rule that decides who is offered a cover.
//
// 🔴 THE LIFETIME IS THE HARD PART, and it is the one-off crew mark's lifetime.
// `coverFor` is meaningless the moment its crew changes: if the cover is no longer on the
// visit nobody is covering, and if the covered cleaner is back on it there is nothing to
// cover. A stale entry is not cosmetic — it silently sends a cleaner to the wrong
// checklist, and from step 4 gates their clock-out on it. So EVERY write that changes a
// visit's crew re-normalizes the map (reducer.js: markOneOff's UPDATE_JOB path,
// settleCrewMark, the time-off exclusion, a deleted user, and UPDATE_JOB_SERIES' re-crew),
// mints never copy it (stripped wherever `oneOff` is), and a "this & all future" edit
// never writes it.
//
// Bounded by construction: a cover must be ON the visit, so the map can never hold more
// entries than the crew — no retention rule needed.

// Canonical, pruned map or null. `crewIds` is the visit's crew AFTER the change, and
// `regularCrewIds` the day's REGULAR crew after it (the series pattern for that weekday).
//
//   • the cover must be on the visit          (they left → nobody is covering)
//   • the covered cleaner must NOT be on it   (they are back → nothing to cover)
//   • nobody covers themselves
//   • the cover must NOT be one of the day's regulars, and the cleaner they name MUST be
//     (a regular works their own shift; you can only cover someone who was due to work it)
//   • one regular is covered by at most ONE cleaner per visit — the first by canonical
//     cover id, so a replay resolves the same way every time (owner's ruling, C6)
//
// 🔴 The REGULARS half is not optional bookkeeping. Crew membership alone let a
// "this & all future" re-crew that PROMOTED the cover clear the one-off mark and leave the
// cover live, so the promoted cleaner filled someone else's checklist on that visit for
// ever — and from step 4 clocked out against it (reviewer finding C1).
//
// `regularCrewIds` null/absent means UNKNOWABLE — a one-off clean, which has no weekday
// pattern, or a series whose master sits outside the windowed boot. The crew rules alone
// then apply: a live cover is never dropped on a guess, and the office's own edit supplies
// the regulars it does know (JobDetail's coverRegulars).
//
// Regulars are the RAW pattern crew, NOT the pattern after booked time off. Applying time
// off first would delete the headline case: the regular is booked off, is therefore not on
// the visit, and is exactly who the cover is covering for.
//
// Keys are sorted so equal covers always serialize alike: `api/_lib/jobsGuard.js` compares
// a protected field with JSON.stringify (fieldChanged → norm), and a bare key reorder must
// not read as an authority change. Idempotent — a replayed action re-normalizes to the
// same map — and never mutates its input.
export function normalizeCoverFor(coverFor, crewIds, regularCrewIds = null) {
  if (!coverFor || typeof coverFor !== 'object' || Array.isArray(coverFor)) return null;
  const on = new Set(Array.isArray(crewIds) ? crewIds : []);
  const regulars = Array.isArray(regularCrewIds) ? new Set(regularCrewIds) : null;
  const kept = [];
  for (const [coverId, coveredId] of Object.entries(coverFor)) {
    if (!coverId || typeof coveredId !== 'string' || !coveredId) continue;
    if (coverId === coveredId) continue;
    if (!on.has(coverId) || on.has(coveredId)) continue;
    if (regulars && (regulars.has(coverId) || !regulars.has(coveredId))) continue;
    kept.push([coverId, coveredId]);
  }
  if (!kept.length) return null;
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const claimed = new Set();
  const out = {};
  for (const [k, v] of kept) {
    if (claimed.has(v)) continue;     // C6: one cover per regular
    claimed.add(v);
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// Settle a visit's cover against its own (already updated) crew and the day's regulars.
// Returns the SAME object when nothing changes — including when the row simply has no
// cover — so a re-crew that touches no cover adds no `coverFor` key and produces no
// spurious jobs-delta churn.
export function settleCoverFor(visit, regularCrewIds = null) {
  if (!visit) return visit;
  const next = normalizeCoverFor(visit.coverFor, visit.crewIds, regularCrewIds);
  const before = visit.coverFor ?? null;
  if (JSON.stringify(next) === JSON.stringify(before)) return visit;
  return { ...visit, coverFor: next };
}

// Does this map name `userId` on either side?
export function coverForNamesUser(coverFor, userId) {
  if (!coverFor || typeof coverFor !== 'object' || !userId) return false;
  for (const [coverId, coveredId] of Object.entries(coverFor)) {
    if (coverId === userId || coveredId === userId) return true;
  }
  return false;
}

// Sweep a departed user off a cover map — anti-orphan (playbook II.5 / BUILD_INTEGRITY §3),
// the `coverFor` twin of crewChecklist.removeUserFromCrewChecklists. Both sides matter, and
// the COVERED side is the one a crew-membership scrub cannot see: the covered cleaner is by
// definition NOT on the visit, so `crewIds.includes(id)` never fires for them, and an
// unswept entry would point a cover at a deleted cleaner's checklist forever.
export function removeUserFromCoverFor(coverFor, userId) {
  if (!coverFor || typeof coverFor !== 'object' || !userId) return coverFor ?? null;
  const out = {};
  for (const [coverId, coveredId] of Object.entries(coverFor)) {
    if (coverId === userId || coveredId === userId) continue;
    out[coverId] = coveredId;
  }
  return Object.keys(out).length ? out : null;
}

// Whose checklist does `userId` owe on this clean? The cover's own when nobody is being
// covered. `checklistFor` inlines the same read (it takes no imports, by design).
export function coveredCleanerId(job, userId) {
  if (!userId) return null;
  const map = job?.coverFor;
  if (!map || typeof map !== 'object') return null;
  const covered = map[userId];
  return (typeof covered === 'string' && covered && covered !== userId) ? covered : null;
}

// The UI rule (JobDetail's single-visit edit): who gets a "Covering for" choice, and among
// whom. A **cover** is anyone on the visit who is not one of the day's regulars — which is
// exactly the person a swap added, and also the person the office adds after a regular was
// taken off by booked time off (the regular is still a regular; they are just not on the
// visit). `left` is the regulars who are not on it — the pool, and the render gate.
//   • `prefill[coverId]` pre-fills an unambiguous 1-for-1 swap (one regular left, one
//     cleaner joined), and otherwise stays blank — never guessed;
//   • a cover already saved on the visit pre-fills ITSELF, so re-opening the edit shows
//     what was chosen and lets it be changed or cleared. It keeps doing so even after that
//     cleaner is DEACTIVATED (C3): the entry is live on the visit, so the row has to be
//     able to clear it. It is only dropped once that person is back ON the visit.
//   • `options[coverId]` is what that row may offer: `left`, minus any regular ANOTHER row
//     already holds (C6: one cover per regular), plus this row's own saved pick even when
//     that cleaner is no longer on the team.
// `activeIds`, when given, drops cleaners who have left the team from the POOL, so a
// departed regular is never offered to someone new.
export function coverCandidates({ regularCrewIds = [], crewIds = [], coverFor = null, activeIds = null } = {}) {
  const active = activeIds ? new Set(activeIds) : null;
  const live = (id) => !!id && (!active || active.has(id));
  const regulars = new Set((regularCrewIds || []).filter(live));
  const on = (crewIds || []).filter(live);
  const onSet = new Set(on);
  const covers = on.filter((id) => !regulars.has(id));
  const left = [...regulars].filter((id) => !onSet.has(id));
  // Only an unambiguous 1-for-1 swap is filled in for the office.
  const auto = (covers.length === 1 && left.length === 1) ? left[0] : '';
  const prefill = {};
  for (const id of covers) {
    const saved = coverFor?.[id];
    const savedOk = !!saved && typeof saved === 'string' && saved !== id && !onSet.has(saved);
    prefill[id] = savedOk ? saved : auto;
  }
  const claimed = new Map();                                   // coveredId -> the row holding them
  for (const id of covers) if (prefill[id] && !claimed.has(prefill[id])) claimed.set(prefill[id], id);
  const options = {};
  for (const id of covers) {
    const mine = prefill[id];
    const list = left.filter((x) => !claimed.has(x) || claimed.get(x) === id);
    if (mine && !list.includes(mine)) list.push(mine);          // a departed cleaner this row holds
    options[id] = list;
  }
  return { covers, left, prefill, options };
}
