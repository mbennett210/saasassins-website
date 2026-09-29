// Field-level authorization for per-row writes to public.jobs.
//
// WHY THIS EXISTS — the same structural mistake orgStateGuard.js fixed for the blob,
// repeated on the other table. `POST /api/state/jobs-delta` gated with
// `requireAuthority` ONLY. The server owns `organization_id` and `updated_by`, but the
// job CONTENT — including `crewIds` and `siteId` — was copied verbatim from the body.
// So any authenticated user could POST a job naming themselves at any site and then
// satisfy `requireSiteAssignment(..., { allowJobBased: true })`, or POST
// `{ removed: [...] }` and delete the schedule (the delete was scoped by
// `organization_id`, which on a single-tenant deployment means everything).
//
// Both are also reachable today by writing public.jobs directly under the open RLS
// policy. That is the point: **Increment 1e revokes the TABLE and leaves the ENDPOINT
// open**, so revoking without this guard relocates the holes behind a service-role
// proxy instead of closing them.
//
// ══ WHY THIS SANITIZES INSTEAD OF REJECTING ═══════════════════════════════════
//
// The obvious design — 403 on an unauthorized field — is an OUTAGE, and a permanent
// one. A parallel audit of every jobs write path established three facts that make
// rejection unusable:
//
//  1. CLIENTS RE-POST ROWS THEY NEVER TOUCHED. `diffJobs` compares by OBJECT
//     REFERENCE (jobsMerge.js), and `lastSyncedJobs` is NOT advanced when a realtime
//     patch or cursor-poll row lands. So an inbound row becomes a new reference and is
//     re-emitted in `changed[]` on the tab's next flush — a crew phone routinely POSTs
//     complete job documents carrying a MANAGER's crewIds and siteId.
//  2. CREW TABS RE-EMIT MANAGER DELETES as their own `removed[]`, by the same
//     mechanism. Today that is a harmless idempotent no-op.
//  3. A 403 IS NOT VISIBLE AND NOT RECOVERABLE. `stateApi.js` treats only HTTP 409 as
//     a real server answer; anything else is classified as a transport failure. Today
//     that means a rejection silently falls back to the direct browser write — the
//     guard is BYPASSED and looks like it works. After 1e the fallback throws,
//     `mirrorJobs` returns false, `lastSyncedJobs` never advances, and the identical
//     rejected delta re-sends every 5 seconds forever behind an "offline" badge. The
//     crew member's own clock-in is stuck behind the poisoned delta until a reload.
//
// So a single false positive against an echo = 36 phones wedged. Rejection converts a
// race into a permanent outage; sanitizing converts it into a no-op.
// (Correction, 2026-09-23: since the ping-pong fix, store/sync.js advanceJobsBaseline
// moves the baseline onto every row the server sends, so 1 and 2 are rare now. The
// rule stands: a stale tab or an offline replay still sends rows someone else has
// changed since, and a patch landing mid-flush is re-sent once, which writeJobsDelta's
// equality guard turns into a no-op.)
//
// THE RULE: a write from anyone who may not edit the schedule is always ACCEPTED, with
// anything they may not change REPLACED BY THE STORED VALUE. An echo is byte-identical
// to storage and therefore passes through untouched; a real escalation attempt is
// neutralized and still returns 200. Nothing wedges, and `crewIds` cannot move.
//
// ── WHO MAY EDIT THE SCHEDULE ────────────────────────────────────────────────
// app/src/lib/roles.js draws the line, and the app gates on it:
//   schedule.edit             — 'Create / edit jobs'  (default: owner, admin, manager)
//   schedule.statusTransition — 'Change job status'    (default: every role)
// A write passes WHOLE (create, delete, reschedule, re-crew) for:
//   owner, admin  by role, as always: never tightened, and they read nothing;
//   a manager     holding schedule.edit in the COMMITTED Roles matrix + their per-user
//                 overrides, through the same lib/roles can() the app runs: every
//                 manager by default, not one pared back in Settings → Roles or revoked
//                 per user, and not one whose u_* id didn't resolve (their overrides
//                 couldn't be applied, so they hold nothing).
// Everyone else is sanitized: crew WHATEVER their grant (schedule.edit granted to crew,
// per user or in the matrix, changes nothing here), a caller with no role, any other
// role. The owner's calls, 2026-09-23: follow the matrix for managers (the model S77
// gave Team administration in orgStateGuard), and crew stay sanitized. The app mirrors
// the tiers with useCanEditJobs (hooks/usePermission.js); for owner / admin the UI still
// follows the key, which can only hide a control this would keep. Before, this was
// owner + admin by role alone, which predated the 4th-tier `manager`: a manager's
// creates and deletes were dropped and their crew and time edits put back, answering
// 200 (HANDOFF S77). Writing crewIds is also ACCESS: it grants job-based media access at
// that site (account-media, no time window), so a manager holding schedule.edit can open
// any site's media to whoever they put on a clean, themselves included. That comes with
// scheduling. It also opens the site's door / alarm codes to the CREW on that clean, from
// a day before it to a day after (S81, src/lib/siteAccess.js); a manager's own place on a
// crew opens nothing there, since code reveal takes the job path for crew only.
//   Trust: the role and the u_* id are resolveAuthority's (claim first, never the body;
// a manager has no role claim, so theirs come from the roster, which this route reads
// strictly: a read that FAILS is a 500 the tab retries, never "no role"). The matrix
// and the overrides are the COMMITTED org_state, which a jobs delta cannot touch. This
// comment used to say "never read the matrix: it lives in the browser-writable blob".
// But Increment 1e (20260803150000) revokes the browser's direct write to org_state AND
// public.jobs together: where it is applied, the matrix moves only through
// /api/state/org-state and orgStateGuard; where it is not, the browser writes
// public.jobs directly and no endpoint guard matters. Through the app the matrix moves
// by delegation: an owner, or whoever holds settings.roles.edit (by default owner +
// manager; a manager with it can hand the manager tier, themselves included,
// schedule.edit back after an owner pared it off) or staff.editOverrides (another
// member's row only). ⚠️ org-state.js skips orgStateGuard when a save's fingerprint
// equals the stored one, and that fingerprint is not cryptographic (HANDOFF S78).
// requirePermission authorizes feature routes from these same slices. It is never
// requirePermission HERE: that answers 403, and a 403 on this path wedges tabs (above).
//   Status is kept from anyone, with two exceptions for a caller who is sanitized
// (S81): nothing they send moves a clean out of 'cancelled', and nothing changes the
// status of a visit more than a day before it starts (statusChangeKept in
// src/lib/siteAccess.js; the stored status is put back). Status is an input to crew's
// door-code access, so un-cancelling would restore access the office took back, and a
// visit flipped early would keep its crew through the office's series edits and deletes,
// which touch only upcoming visits. Otherwise crew move a job through its statuses by
// design, the server does not enforce schedule.statusTransition
// (AUTHZ_READ_SAFE_JOB_FIELDS), and a caller can still set the status of a clean they
// aren't on: that grants them nothing, and refusing it would put back the status a
// time.edit.all holder's clock-in on someone else's clean writes.
// ⚠️ A write is judged by its CONTENT, not by the control that made it. So for anyone
// but owner / admin, the job half of an edit gated on ANOTHER key needs schedule.edit
// too: without it, that half is put back while the blob half commits (the owner
// accepted this, 2026-09-23). The three such edits:
//   deleting a customer  deletes its jobs. Put back, they stay in public.jobs pointing at
//                        a deleted account: the app hides them, the ops-alerts cron does
//                        not. (Customers' bulk Delete checks no key at all, HANDOFF S78.)
//   removing a member    takes them off every crew and every series' day crews. Put
//                        back, top-up mints their deleted id onto future cleans.
//                        Unreachable today: the login delete that runs first is owner-only.
//   time off's "take them off these cleans"  edits crews, so TimeOffCard offers it only
//                        to someone who may edit jobs.
//
// ── DENY BY EXCEPTION ──────────────────────────────────────────────────────────
// A job row grows fields as the Swept build lands (clock-in metadata, checklist
// links, photo counts). An allowlist of "fields crew may touch" would break each one
// on arrival. We name only the AUTHORITY-bearing fields and let ordinary data
// through — same conclusion as orgStateGuard, opposite reasoning: on the blob an
// allowlist fails OPEN on every new slice; here it would fail CLOSED on every new
// field.
import { can } from '../../src/lib/roles.js';
import { statusChangeKept } from '../../src/lib/siteAccess.js';
import { matrixForCan, overridesForCan } from './permissionSlices.js';

// The role list that always writes whole: owner + admin, as before the 4th-tier
// manager. Never tightened, and it reads nothing. A manager passes through the matrix
// instead, so a Settings → Roles edit reaches them; adding 'manager' here would undo that.
const MANAGER = ['owner', 'admin'];

// The roles that can hold schedule.edit THROUGH the matrix: a manager. Crew never,
// whatever they are granted (owner's call, 2026-09-23), and a role not listed here holds
// nothing, so a new role starts out sanitized until someone decides otherwise.
const MATRIX_TIER = ['manager'];

// The key the app gates every job create / edit / delete on: Schedule's New Job, drag
// and series top-up, Job Detail's Edit / Delete / reschedule.
const SCHEDULE_EDIT = 'schedule.edit';

// A matrix-tier caller whose u_* id resolved. Without the id their per-user overrides (a
// revoke) can't be applied, so they hold nothing, and the matrix isn't even read.
const matrixCandidate = (role, selfId) => MATRIX_TIER.includes(role) && typeof selfId === 'string' && selfId !== '';

// Fields that confer AUTHORITY rather than describe work.
//
//   crewIds            THE escalation vector — requireSiteAssignment's allowJobBased
//                      branch reads it, so writing it grants yourself site access.
//   siteId / clientId  Move a job to another account and it drags crew access with it.
//   startAt / endAt    Rescheduling IS schedule.edit. endAt additionally bounds the
//                      job-based assignment window, so extending it extends access.
//   seriesId           Re-parenting rewrites what a series operation sweeps.
//   recurrence         The generator for every future occurrence.
//   shiftId            NOT an access vector — an INTEGRITY one, and the reason it is
//                      here is easy to miss. _lib/time/store.js resolves the job's
//                      shift and lets it OVERRIDE the site's and client's
//                      `expectedCleanMins` (the variance/payroll baseline) and
//                      `geofenceRadiusM` (the clock-in geofence). So a crew member who
//                      could write it would pick the most permissive shift configured
//                      at their site, widening their own geofence and moving the
//                      expected-hours baseline — gaming the labor figure the Swept
//                      replacement exists to produce. Bounded (the shift must already
//                      exist on that site) and free to protect: every client path sets
//                      it to `null` at create (reducer.js) and nothing writes it
//                      non-null, so there is no caller to break.
//   oneOff             Marks a series visit's crew / time as changed on its own
//                      (2026-09-23): a later "this & all future" crew change skips a
//                      visit whose crew is marked. So writing it would let crew keep
//                      themselves on visits a manager moves them off, and with them the
//                      job-based site access crewIds grants. Only the office's own
//                      single-visit edits set it (reducer.js markOneOff).
//   coverFor           Who is covering whom on this one visit (R8, 2026-09-27):
//                      { [coverUserId]: coveredUserId }. It decides WHICH checklist a
//                      cleaner must fill on the clean (src/lib/crewChecklist.checklistFor)
//                      and, from step 4 of the checklist build, whether they may clock out
//                      of it at all. Crew-writable, a cleaner could point themselves at a
//                      colleague's easier checklist — or at one who has none — and dodge
//                      their own, so it is an INTEGRITY field of the same family as
//                      shiftId. It also names a cleaner who is NOT on the visit, so unlike
//                      crewIds it must not be inferable from the crew list. Only the
//                      office's single-visit edit sets it (reducer.js settleCoverPatch).
const PROTECTED_JOB_FIELDS = ['crewIds', 'siteId', 'clientId', 'startAt', 'endAt', 'seriesId', 'recurrence', 'shiftId', 'oneOff', 'coverFor'];

// Job fields that server-side authorization reads but which are deliberately NOT
// protected. Kept explicit so the coverage test (test-jobs-guard.mjs) can tell
// "reviewed and safe" apart from "nobody noticed" — that test is what converts
// deny-by-exception's fail-open into a red build when a new authority field appears.
//
//   id      identity, not authority — the row key itself
//   status  crew may change it BY DESIGN (schedule.statusTransition), except the two
//           changes statusChangeKept refuses (S81, 2026-09-23), because a cancelled
//           clean grants no site access (getJobsAtSite and jobGrantsSiteAccess skip it)
//           and the office's series edits and deletes touch only 'upcoming' visits
//           (reducer UPDATE_JOB_SERIES, DELETE_JOB_SERIES). So a sanitized caller can't
//           un-cancel a clean to win back its media or code access, nor flip a visit more
//           than a day out to in_progress / done to keep themselves on it through a series
//           edit or delete. Residual, recorded: a time-off booking skips done and
//           cancelled visits (APPLY_TIME_OFF_EXCLUSIONS), so a visit within a day that
//           crew marked done keeps them through one; it opens nothing the day they were
//           already on it didn't.
export const AUTHZ_READ_SAFE_JOB_FIELDS = ['id', 'status'];

const norm = (v) => JSON.stringify(v ?? null);

// Order-insensitive: the UI reorders crewIds freely and a reorder is not an authority
// change. Mirrors crewSet() in orgStateGuard for the same reason.
const idSetKey = (arr) => JSON.stringify([...new Set(Array.isArray(arr) ? arr : [])].sort());

export function fieldChanged(before, after, field) {
  if (field === 'crewIds') return idSetKey(before?.crewIds) !== idSetKey(after?.crewIds);
  return norm(before?.[field]) !== norm(after?.[field]);
}

/**
 * Rewrite a jobs delta into what someone who may NOT edit the schedule may commit.
 * Owner + admin pass through by role; the matrix half of the rule (a manager holding
 * schedule.edit writes whole) is holdsScheduleEdit, and guardJobsDelta puts the two
 * together.
 *
 * PURE — the caller supplies the committed rows, so this is unit-testable and the DB
 * read stays at the call site (and is skipped entirely for owner / admin and for a
 * manager holding schedule.edit).
 *
 * @param prev     Map|object of id -> committed job payload. A MISSING id means the
 *                 row does not exist yet, i.e. the write is a CREATE.
 * @param changed  job payloads the client wants to upsert
 * @param removed  job ids the client wants to delete
 * @param role     resolveAuthority's role (the claim, or the roster row for a login
 *                 without one) — never the body
 * @param now      the server's clock (ms), for the status lead window; a parameter so
 *                 the rule is testable at a fixed instant
 * @returns { changed, removed, adjustments } — adjustments is a de-duplicated list of
 *          what was neutralized, for server-side logging. It is NOT an error: the
 *          write proceeds.
 */
export function sanitizeJobsDelta({ prev, changed = [], removed = [], role, now = Date.now() }) {
  const list = Array.isArray(changed) ? changed : [];
  const dels = Array.isArray(removed) ? removed : [];
  if (MANAGER.includes(role)) return { changed: list, removed: dels, adjustments: [] };

  const get = (id) => (prev instanceof Map ? prev.get(id) : prev?.[id]);
  const adjustments = [];
  const note = (s) => { if (!adjustments.includes(s)) adjustments.push(s); };

  const outChanged = [];
  for (const next of list) {
    if (!next || typeof next.id !== 'string' || !next.id) continue;
    const before = get(next.id);

    // CREATE by someone who may not edit the schedule is dropped, not rejected. With
    // TOP_UP_RECURRING_SERIES gated on schedule.edit client-side, no legitimate create
    // of theirs remains — but a stale or replayed tab can still emit one, and dropping
    // keeps that tab moving instead of wedging it. Inventing a job naming yourself at
    // any site is the whole attack in one step, so it must not commit.
    if (!before) { note('create a job'); continue; }

    // UPDATE: keep the caller's row but restore every protected field from storage.
    // An echo is already byte-identical, so this is a no-op for the overwhelmingly
    // common case and allocates nothing.
    let sanitized = next;
    for (const f of PROTECTED_JOB_FIELDS) {
      if (!fieldChanged(before, next, f)) continue;
      if (sanitized === next) sanitized = { ...next };
      // `undefined` would be dropped by JSON serialization and read as "field absent"
      // rather than "field restored", so an absent stored value is written as null.
      sanitized[f] = before[f] === undefined ? null : before[f];
      note(f === 'crewIds' ? 'change who is assigned to a job' : `change a job's ${f}`);
    }
    // STATUS: kept, except the two changes statusChangeKept refuses (out of 'cancelled';
    // a visit more than a day out), judged on the STORED job's status and start, never
    // on times the caller sent. The stored status goes back, as for a protected field.
    if (fieldChanged(before, next, 'status') && !statusChangeKept(before, next.status, now)) {
      if (sanitized === next) sanitized = { ...next };
      sanitized.status = before.status === undefined ? null : before.status;
      note("change a job's status");
    }
    outChanged.push(sanitized);
  }

  // DELETES are dropped wholesale for anyone who may not edit the schedule, and dropping
  // is exactly right for BOTH cases. An echo targets a row that is already gone, so
  // ignoring it leaves the database in the identical state — the tab gets its 200 and
  // advances. An originating delete is the mass-wipe primitive and must not commit.
  // Deliberately NOT bounded by a row count: a legitimate account delete removes 4,920
  // rows in one gesture and a full wipe is only ~4x larger, so no threshold separates
  // them. Authority (the role list or schedule.edit) is the discriminator; volume is not.
  if (dels.length) note('delete jobs');

  return { changed: outChanged, removed: [], adjustments };
}

// The ids a sanitize pass must read before it can compare. Owner / admin and a manager
// holding schedule.edit skip the read entirely, so this cost lands on crew writes (and a
// pared-back manager's) — a handful of rows fetched by primary key in ONE batched query
// (a per-row SELECT would be 250 round-trips on a series chunk, against a 12s client
// abort).
export function idsNeedingPrev(changed = []) {
  return [...new Set(
    (Array.isArray(changed) ? changed : [])
      .map((j) => j?.id)
      .filter((id) => typeof id === 'string' && id)
  )];
}

/**
 * Whether the caller may write jobs WHOLE (create, delete, reschedule, re-crew): owner
 * or admin by role, or a manager holding schedule.edit in the COMMITTED matrix + their
 * per-user overrides, by the same can() the app gates on. Crew never, whatever their
 * grant; nor a caller with no role or another role, nor a manager whose u_* id didn't
 * resolve. PURE, and it never throws: a malformed committed row reads as a missing one
 * (permissionSlices.js), so one bad row can't 500 every jobs save.
 *
 * @param role        resolveAuthority's role — never the body
 * @param selfId      resolveAuthority's u_* id; keys the per-user overrides
 * @param permissions the committed `permissions` slice, as stored
 * @param overrides   the committed `userPermissionOverrides` slice, as stored
 */
export function holdsScheduleEdit({ role, selfId, permissions, overrides }) {
  if (MANAGER.includes(role)) return true;
  if (!matrixCandidate(role, selfId)) return false;
  return can({ id: selfId, role }, SCHEDULE_EDIT, matrixForCan(permissions), overridesForCan(overrides));
}

/**
 * Decide what a jobs delta commits, reading only what the decision needs: the delta
 * WHOLE for someone holdsScheduleEdit passes, sanitizeJobsDelta's rewrite for anyone else.
 *   owner / admin         whole, and nothing is read (as before)
 *   a manager (u_* id     the matrix, a small projection. A holder's write is whole with
 *   resolved)             no row read; a pared-back or revoked one is sanitized after it
 *   anyone else (crew,    the row read only, exactly as before. The matrix is never read:
 *   no role, other role)  it can't change their answer
 * A read that fails THROWS, so the handler answers 500 and the tab retries: never a
 * silent pass-through, and never a silent put-back of a holder's edit.
 *
 * @param readAuthz  () => { permissions, overrides } from the COMMITTED org_state
 *                   (authz.readAuthzSlices)
 * @param readRows   (ids) => Map of id -> committed job (jobsTable.getJobsByIds)
 * @param now        the server's clock (ms), passed to sanitizeJobsDelta
 * @returns { changed, removed, adjustments }, as sanitizeJobsDelta
 */
export async function guardJobsDelta({ role, selfId, changed = [], removed = [], readAuthz, readRows, now = Date.now() }) {
  const list = Array.isArray(changed) ? changed : [];
  const dels = Array.isArray(removed) ? removed : [];
  if (MANAGER.includes(role)) return { changed: list, removed: dels, adjustments: [] };
  if (matrixCandidate(role, selfId)) {
    const slices = await readAuthz();
    if (holdsScheduleEdit({ role, selfId, permissions: slices?.permissions, overrides: slices?.overrides })) {
      return { changed: list, removed: dels, adjustments: [] };
    }
  }
  return sanitizeJobsDelta({ prev: await readRows(idsNeedingPrev(list)), changed: list, removed: dels, role, now });
}

export {
  PROTECTED_JOB_FIELDS, MANAGER as JOB_MANAGER_ROLES, MATRIX_TIER as JOB_MATRIX_ROLES, SCHEDULE_EDIT as JOB_EDIT_KEY,
};
