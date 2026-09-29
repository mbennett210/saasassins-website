// The checklist rules — PURE / node-safe (no imports, no browser globals), so the UI,
// the reminder walkers, the clock-out gate and the server answer the same questions the
// same way:
//
//   WHICH checklist does this cleaner get on this clean?  → checklistFor()
//   WHOSE submission counts as theirs?                    → the completion helpers below
//   MAY this cleaner clock out of this clean?             → clockOutGate()
//   MAY this cleaner clock out of this clean?             → clockOutGate()
//
// A clean's checklist is assigned PER CLEANER and ONLY per cleaner
// (client.crewChecklists = { [userId]: templateId }). There is NO location-wide default:
// a cleaner with no pick of their own has no checklist, and that is a normal state, never
// a warning (R3 + R1, Daniel 2026-09-27). The retired field, `client.checklistTemplateId`,
// is converted into explicit picks and deleted by retireLocationDefaultsV57 below.

// The checklist template id that applies to `userId` on this clean: the COVERED cleaner's
// pick when this cleaner is covering someone on it, else their OWN pick, else null. There
// is no location-wide default to fall back to (R3). ONE resolver, so the assign UI
// (ServiceSetupCard, the assignments organizer), the crew fill (CleanChecklist), the
// manager roster and the checklist reminders can never disagree about which checklist a
// cleaner gets — or about who has none.
//
// `job` is the clean being asked about. R8 (Daniel, 2026-09-27): a cleaner covering
// someone's shift gets the covered cleaner's checklist for that clean, recorded as
// `job.coverFor = { [coverUserId]: coveredUserId }` on that single visit (the shape, the
// prune and its lifetime live in `lib/jobCover.js`; read inline here because this module
// takes no imports by design). When the covered cleaner has no pick at this location the
// cover keeps their own — "no checklist" is a normal state (R1), never inherited from
// nowhere. Pass `job: null` where there is no clean (the assignments organizer's display).
export function checklistFor({ client, job = null, userId = null } = {}) {
  const perCleaner = client?.crewChecklists || null;
  const cover = (userId && job?.coverFor && typeof job.coverFor === 'object') ? job.coverFor[userId] : null;
  if (cover && cover !== userId && perCleaner && perCleaner[cover]) return perCleaner[cover];
  if (perCleaner && userId && perCleaner[userId]) return perCleaner[userId];
  return null;
}

// ── Completion: WHOSE submission is this? (CS-403) ───────────────────────────
// `checklist_results` carries exactly ONE actor column, `completed_by_user_id`, stamped
// server-side from the JWT claim (app/api/qc/[...path].js) — there is no name column
// (supabase/migrations/20260614120000_qc_backend.sql). Matching on a name therefore kept
// EVERY row on the real backend, so two cleaners sharing a checklist on one clean each
// read the other's completion. Everything below matches on the id; display names come
// from the roster.

// A submission counts as DONE only when every item is ticked. An empty checklist (0/0)
// is never done — it would otherwise read as complete before it has any items.
export function isChecklistComplete(r) {
  return !!(r && r.total_count > 0 && r.completed_count >= r.total_count);
}

// The cleaner's latest result for a checklist out of an already job-scoped list (the
// caller reads qcApi.listChecklists({ jobId }), newest first), so the first match wins.
// With no `userId` (a manager looking at the location's single checklist) the newest by
// anyone is returned, as before.
export function latestChecklistFor(results, { templateId, userId = null } = {}) {
  if (!templateId) return null;
  const mine = (results || []).filter((r) => r && r.template_id === templateId
    && (!userId || r.completed_by_user_id === userId));
  return mine[0] || null;
}

// The COMPLETE submissions in a set of records, indexed ONCE:
//   onJob — "<jobId>|<userId>" for every complete submission bound to a clean
//   loose — "<userId>|<siteId>" -> [performedMs] for the complete ones that are not
// The reminder walker asks hasCompleteChecklistFor() once per cleaner per clean, and the
// window it reads spans every clean in the org for a day — so it indexes the window once
// per walk instead of re-scanning it for every question (the browser tick runs every 60s).
export function completeChecklistIndex(results) {
  const onJob = new Set();
  const loose = new Map();
  // …and the same two, keyed by template as well. The clock-out gate asks a
  // TEMPLATE-scoped question — finishing a different checklist must not unlock the clock —
  // while the reminder walker reads narrow window columns that carry no template_id at
  // all. Indexing both halves once keeps ONE rule for two questions; a row with no
  // template_id is simply absent from the template-keyed half.
  const onJobTemplate = new Set();
  const looseTemplate = new Map();
  const push = (map, k, t) => { const at = map.get(k); if (at) at.push(t); else map.set(k, [t]); };
  for (const r of results || []) {
    if (!r || !r.completed_by_user_id || !isChecklistComplete(r)) continue;
    if (r.job_id) {
      onJob.add(`${r.job_id}|${r.completed_by_user_id}`);
      if (r.template_id) onJobTemplate.add(`${r.job_id}|${r.completed_by_user_id}|${r.template_id}`);
      continue;
    }
    if (!r.site_id) continue;
    const t = new Date(r.performed_at).getTime();
    if (!Number.isFinite(t)) continue;
    push(loose, `${r.completed_by_user_id}|${r.site_id}`, t);
    if (r.template_id) push(looseTemplate, `${r.completed_by_user_id}|${r.site_id}|${r.template_id}`, t);
  }
  return { __completeChecklistIndex: true, onJob, loose, onJobTemplate, looseTemplate };
}

// Does THIS cleaner have a COMPLETE submission for THIS clean? The reminder walker's and
// the clock-out gate's question.
// `templateId` is OPTIONAL and the two callers differ on purpose:
//   · the REMINDER walker passes none — it reads the narrow window columns the server
//     returns (CHECKLIST_WINDOW_COLUMNS has no template_id), and a cleaner who logged a
//     complete checklist on the clean has logged one;
//   · the CLOCK-OUT gate passes the cleaner's ASSIGNED checklist, because finishing a
//     different one must not unlock the clock (it reads full rows, which carry
//     template_id). A row with no template_id can never satisfy a template-scoped ask.
// A submission with no `job_id` (filled outside a clean) counts for the same cleaner at
// the same site within `windowMs` of the clean's start; the caller owns that window.
// `results` is either the raw records or a prebuilt completeChecklistIndex — ONE rule,
// two shapes, so a hot caller can index once without a second copy of the rule. The
// template-scoped ask reads the index's template-keyed half, so it works on both shapes
// too; a row carrying no template_id is in neither, and so never satisfies one.
export function hasCompleteChecklistFor(results, { userId, jobId = null, siteId = null, startMs = NaN, windowMs = 0, templateId = null } = {}) {
  if (!userId) return false;
  const idx = results && results.__completeChecklistIndex ? results : completeChecklistIndex(results);
  const key = templateId ? `|${templateId}` : '';
  const onJob = templateId ? idx.onJobTemplate : idx.onJob;
  const loose = templateId ? idx.looseTemplate : idx.loose;
  if (jobId && onJob.has(`${jobId}|${userId}${key}`)) return true;
  if (!siteId || !Number.isFinite(startMs)) return false;
  const at = loose.get(`${userId}|${siteId}${key}`);
  return !!at && at.some((t) => Math.abs(t - startMs) <= windowMs);
}

// Does the manager ROSTER inside a clean have anything to say? Only when at least one
// cleaner ON THIS CLEAN resolves a checklist. It asks the same resolver the rows do, so
// the gate and the rows can never disagree (and step 3's cover rule applies to both).
// It replaced a location-wide "does anyone here hold one" check, which rendered a card
// titled "Checklists by cleaner" whose every row read "No checklist" whenever the only
// holder at the location was not on this clean, and a titled card with an EMPTY list when
// the clean had no crew at all.
export function hasChecklistOnClean({ client, job = null, crewIds = [] } = {}) {
  return (crewIds || []).some((userId) => userId && checklistFor({ client, job, userId }));
}

// ── The clock-out gate (R4-R6) ───────────────────────────────────────────────
// R4: a cleaner with a checklist on a clean cannot clock out of it until every item is
// ticked. R5: they have no way around it (notes on the items, or the office closes the
// entry). R6: the office can turn R4 off for one cleaner (`user.clockRules`).
//
// ONE pure verdict, so the crew button (components/ClockControl) and the server refusal
// (api/_lib/time/checklistGate) can never disagree — the client-side block would
// otherwise be theatre on one side and a surprise 409 on the other.
export const GATE = Object.freeze({
  NONE: 'none',       // no checklist is assigned to this cleaner here → normal button
  OFF: 'off',         // the office turned the block off for this cleaner → normal button
  DONE: 'done',       // a COMPLETE submission exists for this clean + checklist → normal
  BLOCKED: 'blocked', // locked; `done`/`total` are the progress to show
  UNKNOWN: 'unknown', // offline with nothing synced, cached or queued to judge by → locked
});

// A queued (still-on-the-phone) submission, in the shape a synced `checklist_results` row
// has, so ONE completeness rule judges both. `payload` is the exact POST body qcApi
// buffered (lib/checklistQueue): items carry `checked`, and `completedByUserId` is the
// cleaner ChecklistFill stamped. A legacy payload without it is read as this phone's
// cleaner — the queue is per-device and the punch queue already holds a coworker's work
// for its owner. An item the drain marked `failed` is NOT counted: it will never sync, so
// treating it as done would clock someone out against a checklist the server never got.
function queuedAsRows(queued, userId) {
  const out = [];
  for (const it of queued || []) {
    const p = it && it.payload;
    if (!p || it.failed) continue;
    const who = p.completedByUserId || userId || null;
    if (userId && who !== userId) continue;
    const items = Array.isArray(p.items) ? p.items : [];
    out.push({
      job_id: p.jobId ?? null,
      site_id: p.siteId ?? null,
      template_id: p.templateId ?? null,
      completed_by_user_id: who,
      completed_count: items.filter((i) => i && i.checked).length,
      total_count: items.length,
      performed_at: it.createdAt || null,
      queued: true,
    });
  }
  return out;
}

const newestFirst = (a, b) => (Date.parse(b?.performed_at || 0) || 0) - (Date.parse(a?.performed_at || 0) || 0);

// `results` = the clean's submissions (qcApi.listChecklists({ jobId }), or the phone's
//   remembered verdict); NULL means "couldn't read them", which is what makes `unknown`
//   different from "none submitted".
// `queued`  = lib/checklistQueue items still waiting to sync; NULL means not read yet.
// `rules`   = that cleaner's `user.clockRules` (sparse; absent means normal).
export function clockOutGate({ checklistId = null, rules = null, results = null, queued = null, userId = null, jobId = null } = {}) {
  const verdict = (state, done = 0, total = 0) => ({ state, done, total });
  if (!checklistId) return verdict(GATE.NONE);
  if (rules && rules.checklistBlockOff === true) return verdict(GATE.OFF);
  // Without an identity nothing can be attributed, so never pass: the server would
  // refuse anyway, and a silent pass here is the bug this gate exists to prevent.
  if (!userId) return verdict(GATE.UNKNOWN);

  const queuedRows = queuedAsRows(queued, userId);
  const synced = Array.isArray(results) ? results : [];
  const rows = [...synced, ...queuedRows]
    .filter((r) => r && r.job_id === jobId && r.completed_by_user_id === userId && r.template_id === checklistId)
    .sort(newestFirst);

  // DONE wins whatever came after it: a later partial re-submission never undoes a
  // finished checklist (the cleaner may reopen it to add a note).
  const complete = rows.find(isChecklistComplete);
  if (complete) return verdict(GATE.DONE, complete.completed_count, complete.total_count);

  if (!Array.isArray(results) && !queuedRows.length) return verdict(GATE.UNKNOWN);
  const latest = rows[0] || null;
  return verdict(GATE.BLOCKED, latest?.completed_count || 0, latest?.total_count || 0);
}

// Prune a crew-checklist map to falsy-free entries (a cleaner set back to "No checklist"
// is removed, not stored as ''), so an empty map means "nobody here holds a checklist".
export function pruneCrewChecklists(map) {
  const out = {};
  for (const [userId, templateId] of Object.entries(map || {})) {
    if (userId && templateId) out[userId] = templateId;
  }
  return out;
}

// Sweep a DELETED checklist template off every location's bindings: drop any per-cleaner
// entry pointing at it. Anti-orphan counterpart to a hard template delete — a binding to
// a template that no longer exists would make the fill modal fail to load. Completed
// checklist RECORDS keep their own denormalized snapshot, so they are untouched. Since R3
// the per-cleaner map is the only binding there is. Pure / node-safe.
export function removeTemplateFromClients(clients, templateId) {
  if (!templateId) return clients || [];
  return (clients || []).map((c) => {
    const cc = c?.crewChecklists;
    if (!cc || !Object.values(cc).includes(templateId)) return c;
    const next = {};
    for (const [uid, tid] of Object.entries(cc)) if (tid !== templateId) next[uid] = tid;
    return { ...c, crewChecklists: next };
  });
}

// Sweep a departed user's per-cleaner assignment off EVERY client row. Anti-orphan
// (playbook II.5 / BUILD_INTEGRITY §3): DELETE_USER must not leave `crewChecklists`
// pointing at a user that no longer exists — otherwise the entry lingers forever and,
// worse, resurfaces if the id is ever reused. Returns a new clients array (only the
// rows that actually held the id are re-created), or the input untouched when nothing
// referenced it. Pure / node-safe, tested apart from the un-importable reducer.
export function removeUserFromCrewChecklists(clients, userId) {
  if (!userId) return clients || [];
  return (clients || []).map((c) => {
    if (!c?.crewChecklists || !(userId in c.crewChecklists)) return c;
    const next = { ...c.crewChecklists };
    delete next[userId];
    return { ...c, crewChecklists: next };
  });
}

// ── Retiring the location-wide default (R3) ───────────────────────────────────
// The ONE transform that converts a saved `client.checklistTemplateId` into explicit
// per-cleaner picks and then DELETES the field. Shared, like collapseToSingleLocationV53
// before it, by the local store migration (store/persist.js migrateV56toV57) and by the
// live data-op (app/scripts/dataop-checklist-default.mjs), so the demo blob and the
// production blob convert identically and neither can drift.
//
// Rule: every cleaner scheduled on one of that location's PRESENT/FUTURE cleans who has no
// pick of their own inherits the saved default as their own pick. Nobody else does — a
// cleaner who only ever worked a finished or cancelled clean there is not given a
// checklist, because a checklist is now a deliberate per-cleaner assignment.
// A cleaner who already picked is NEVER overwritten.
//
// Two OUTCOMES, counted apart, because the live op's verification depends on it: a TRUTHY
// default is a `converted` row, while a key that is merely PRESENT-but-falsy is a `cleaned`
// row — it gives nobody a checklist and only the dead key goes. A pre-deploy tab's
// UPDATE_CLIENT_OPS can write `checklistTemplateId: null` back after the op committed, and
// counting that as a conversion would make the op's own "re-run, it must report nothing"
// check read as a failed write.
//
// `jobs` is the clean list to read crews from: `state.jobs` in the store migration, the
// rows of `public.jobs` in the data-op (the blob's own `jobs` array is written empty by
// client saves). Pure, node-safe and IDEMPOTENT: after one pass no row carries the field,
// so a re-run returns every row by reference and reports no work.
export const RETIRE_DEFAULT_JOB_STATUSES = ['upcoming', 'in_progress'];

export function retireLocationDefaultsV57({ clients = [], jobs = [] } = {}) {
  // clientId -> Set(userId) over present/future cleans only
  const crewByClient = new Map();
  for (const j of jobs || []) {
    if (!j || !j.clientId || !RETIRE_DEFAULT_JOB_STATUSES.includes(j.status)) continue;
    let crew = crewByClient.get(j.clientId);
    if (!crew) { crew = new Set(); crewByClient.set(j.clientId, crew); }
    for (const uid of (Array.isArray(j.crewIds) ? j.crewIds : [])) if (uid) crew.add(uid);
  }

  let assignmentsAdded = 0;
  const converted = [];    // [{ clientId, templateId, addedUserIds }] — a real default
  const cleaned = [];      // [clientId] — the key was present but falsy: nothing to convert
  const next = (clients || []).map((c) => {
    if (!c || !('checklistTemplateId' in c)) return c;          // nothing to retire
    const templateId = c.checklistTemplateId || null;            // a scrub or a stale tab nulled it
    const picks = { ...(c.crewChecklists || {}) };
    const addedUserIds = [];
    if (templateId) {
      for (const uid of crewByClient.get(c.id) || []) {
        if (picks[uid]) continue;                                 // their own pick wins
        picks[uid] = templateId;
        addedUserIds.push(uid);
      }
      assignmentsAdded += addedUserIds.length;
      converted.push({ clientId: c.id, templateId, addedUserIds });
    } else {
      cleaned.push(c.id);
    }
    const { checklistTemplateId, ...rest } = c;                   // eslint-disable-line no-unused-vars
    return (addedUserIds.length || 'crewChecklists' in c) ? { ...rest, crewChecklists: picks } : rest;
  });

  return { clients: next, converted, cleaned, assignmentsAdded };
}
