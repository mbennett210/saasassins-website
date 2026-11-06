// The Assignments screen's rules — PURE / node-safe (its imports are the equally pure
// checklist, crew and clock-rule modules), so the summary's counters, the worklists that
// fix them and the rail's "needs attention" flags are ONE answer asked three ways.
//
//   WHAT NEEDS ATTENTION  → checklistIssues() returns the four lists the summary counts:
//                           `overdue` · `rules` · `nobody` · `strays`.
//   HOW AN ASSIGNMENT MOVES → assignChecklist / reassignChecklist / removeChecklistHolder.
//
// 🔴 THE OVERDUE WALK ANSWERS THE SAME QUESTION THE NUDGE DOES. It calls the same
// resolver (`checklistFor`, so a cover is judged on the covered cleaner's checklist), the
// same completion rule (`hasCompleteChecklistFor`, matched on `completed_by_user_id`), the
// same nudge timing (`checklistReminderBeforeEndMins`, ALR-10) and the same 18-hour window
// as `lib/opsAlerts.getDueChecklistReminders`. A tile that disagreed with the reminder
// would send the office after a problem the cleaner was never told about, or hide one they
// were.
//
// It differs from the walker in exactly two deliberate ways, because this is a MANAGEMENT
// VIEW and not a notification:
//   · no seed-data skip (CS-030) — the walker suppresses the fictional book so the cron
//     does not burst fake alerts onto a phone; a screen the office opened must show what
//     is actually true of the data in front of them;
//   · no fired-alert dedup and no escalation split — every missing cleaner is one row,
//     whether or not a nudge has gone out.
//
// A checklist belongs to ONE customer and is assigned to named cleaners there (R2), a
// cleaner holds at most one checklist per customer, and "no checklist" is a normal state
// (R1) — so the absence of a checklist is NEVER an issue here. Only the four above are.
import { checklistFor, completeChecklistIndex, hasCompleteChecklistFor, pruneCrewChecklists } from './crewChecklist.js';
import { resolveJobCrewIds } from './crewResolve.js';
import { clockRulesOff } from './clockRules.js';
import { english } from '../i18n/core.js';
import {
  CHECKLIST_MATCH_WINDOW_MS, shiftLookbackHours, checklistReminderBeforeEndMins,
  FALLBACK_SHIFT_MINS,
} from './opsAlerts.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const ms = (iso) => { const t = new Date(iso).getTime(); return Number.isFinite(t) ? t : NaN; };

// The four problems, in the order the summary's tiles read them. The screen maps over this
// list, so a fifth kind is one entry here and one row renderer, never a fifth code path.
export const ISSUE_KINDS = Object.freeze(['overdue', 'rules', 'nobody', 'strays']);

// Each name and hint is a catalog line (CS-193): the screen shows t(ISSUE_LABEL_KEYS[kind]) in
// its reader's language; ISSUE_LABELS / ISSUE_HINTS are the same lines in English.
export const ISSUE_LABEL_KEYS = Object.freeze({
  overdue: 'cka.issue.overdue',
  rules: 'cka.issue.rules',
  nobody: 'cka.issue.nobody',
  strays: 'cka.issue.strays',
});
export const ISSUE_LABELS = Object.freeze(Object.fromEntries(Object.entries(ISSUE_LABEL_KEYS).map(([k, key]) => [k, english(key)])));

// What each tile means, in the one sentence that sits under its worklist.
export const ISSUE_HINT_KEYS = Object.freeze({
  overdue: 'cka.hint.overdue',
  rules: 'cka.hint.rules',
  nobody: 'cka.hint.nobody',
  strays: 'cka.hint.strays',
});
export const ISSUE_HINTS = Object.freeze(Object.fromEntries(Object.entries(ISSUE_HINT_KEYS).map(([k, key]) => [k, english(key)])));

// "Scheduled here" = on one of this customer's PRESENT/FUTURE cleans. The same basis the
// customer page's Service setup uses, so the phrase means one thing everywhere.
export const SCHEDULED_JOB_STATUSES = Object.freeze(['upcoming', 'in_progress']);

// A clean that is finished or void owes nothing. (The reminder walker skips only
// `cancelled`, and so do we: a clean marked done with an unfinished checklist is exactly
// what the office wants to see.)
const VOID_JOB_STATUSES = new Set(['cancelled', 'canceled']);

const EMPTY_SET = new Set();

// customerId -> Set(cleanerId) over upcoming / in-progress cleans only.
export function scheduledCleanersByCustomer(jobs = []) {
  const map = new Map();
  for (const j of jobs || []) {
    if (!j || !j.clientId || !SCHEDULED_JOB_STATUSES.includes(j.status)) continue;
    let set = map.get(j.clientId);
    if (!set) { set = new Set(); map.set(j.clientId, set); }
    for (const uid of resolveJobCrewIds(j)) set.add(uid);
  }
  return map;
}

// "<jobId>|<userId>" -> { done, total } from that cleaner's LATEST submission on that
// clean. The overdue row shows it as `n/m` so the office can see how far they got; the
// completeness verdict itself is `hasCompleteChecklistFor`, never this.
export function latestChecklistProgress(results) {
  const by = new Map();
  for (const r of results || []) {
    if (!r || !r.job_id || !r.completed_by_user_id) continue;
    const at = ms(r.performed_at) || 0;
    const key = `${r.job_id}|${r.completed_by_user_id}`;
    const prev = by.get(key);
    if (prev && prev.at > at) continue;
    by.set(key, { done: r.completed_count || 0, total: r.total_count || 0, at });
  }
  // Drop the sort key so a caller reads a plain { done, total }.
  for (const [k, v] of by) by.set(k, { done: v.done, total: v.total });
  return by;
}

// Every cleaner who holds `templateId` at this customer.
export function holdersOf(crewChecklists, templateId) {
  if (!templateId) return [];
  return Object.entries(crewChecklists || {}).filter(([uid, tid]) => uid && tid === templateId).map(([uid]) => uid);
}

// ── ONE walk of today's cleans ───────────────────────────────────────────────
// Every (clean, cleaner, checklist) on a clean that has STARTED inside the alert
// look-back, with how far that cleaner got. TWO readers off one walk, so a badge can never
// say one thing while the tile above it says another:
//   · the summary's `overdue` tile — the entries that are unfinished AND past the
//     reminder's nudge time;
//   · the customer and cleaner views' "Done today" / "12/46" badges — every entry.
// A cleaner with no checklist on the clean is not an entry: "no checklist" is a normal
// state (R1), not a thing to show progress for.
export function walkTodaysChecklists({
  clients = [], users = null, jobs = [], templates = null, results = null,
  now = Date.now(), settings = {},
} = {}) {
  if (!Array.isArray(results)) return [];
  const clientsById = new Map((clients || []).filter((c) => c && c.id).map((c) => [c.id, c]));
  // `users` is OPTIONAL here: the badges are about the clean, and the roster filter is the
  // OVERDUE question (an inactive cleaner can act on nothing, so nobody chases them).
  const activeUserIds = Array.isArray(users)
    ? new Set(users.filter((u) => u && u.id && u.status === 'active').map((u) => u.id))
    : null;
  const liveTemplateIds = Array.isArray(templates) ? new Set(templates.map((t) => t && t.id).filter(Boolean)) : null;
  // ALR-10: "past the nudge" now means past (scheduled end − lead), the walker's own rule.
  const lead = checklistReminderBeforeEndMins(settings);
  const lookbackMs = shiftLookbackHours(settings) * HOUR;
  const logged = completeChecklistIndex(results);
  const progress = latestChecklistProgress(results);

  const out = [];
  for (const job of jobs || []) {
    if (!job || !job.id || VOID_JOB_STATUSES.has(job.status)) continue;
    const startMs = ms(job.startAt);
    if (!Number.isFinite(startMs)) continue;
    if (startMs > now) continue;                 // not started — nothing is owed yet
    if (startMs < now - lookbackMs) continue;    // older than the alert look-back
    const client = clientsById.get(job.clientId);
    if (!client) continue;
    // The nudge point, asked exactly as getDueChecklistReminders asks it: `lead` minutes
    // before the scheduled end, never before the clean started, with the same assumed length
    // when a clean carries no end.
    const endMs = Number.isFinite(ms(job.endAt)) ? ms(job.endAt) : startMs + FALLBACK_SHIFT_MINS * MIN;
    const pastNudge = now > Math.max(startMs, endMs - lead * MIN);
    for (const userId of resolveJobCrewIds(job)) {
      if (activeUserIds && !activeUserIds.has(userId)) continue;
      const templateId = checklistFor({ client, job, userId });
      if (!templateId) continue;                                          // R1
      if (liveTemplateIds && !liveTemplateIds.has(templateId)) continue;  // CS-353
      const complete = hasCompleteChecklistFor(logged, {
        userId, jobId: job.id, siteId: job.siteId || null, startMs, windowMs: CHECKLIST_MATCH_WINDOW_MS,
      });
      const p = progress.get(`${job.id}|${userId}`) || { done: 0, total: 0 };
      out.push({
        clientId: job.clientId || null, jobId: job.id, userId, templateId, startAt: job.startAt,
        done: p.done, total: p.total, complete, overdue: !complete && pastNudge,
      });
    }
  }
  return out;
}

// customerId -> Map(cleanerId -> { done, total, complete, jobId }) for today's cleans. The
// badge index the customer and cleaner views read.
export function todayByCustomer(input) {
  const out = new Map();
  for (const x of walkTodaysChecklists(input)) {
    if (!x.clientId) continue;
    let per = out.get(x.clientId);
    if (!per) { per = new Map(); out.set(x.clientId, per); }
    // A cleaner on two of a customer's cleans today: the unfinished one is what needs
    // saying, so a complete entry never overwrites an incomplete one.
    const prev = per.get(x.userId);
    if (prev && !prev.complete && x.complete) continue;
    per.set(x.userId, { done: x.done, total: x.total, complete: x.complete, jobId: x.jobId });
  }
  return out;
}

// ── The four problems ────────────────────────────────────────────────────────
//   clients   : state.clients (id, name, crewChecklists)
//   users     : the roster (id, status, clockRules). Only ACTIVE members are judged for
//               `overdue` and `rules` — a disabled cleaner can act on nothing, and the
//               notification fan-out drops them too.
//   jobs      : the loaded cleans. Their crew decides "scheduled here" and "on a clean now".
//   templates : the checklist summary rows ({ id, name, client_id, … }), or NULL when the
//               read has not answered. NULL is "not known": nothing is claimed unheld and
//               no binding is skipped as deleted — a failed read must never invent or
//               silence a problem.
//   results   : today's checklist submissions, or NULL when that read has not answered —
//               then nothing is claimed overdue, for the same reason.
//   jobsHydrated : false until the jobs window (−45/+100 days, store useJobsHydrated) has
//               loaded. The two JOB-DERIVED lists come back NULL then — "not known", not
//               "none". Judged against no cleans at all, every holder reads as a STRAY (with
//               a one-click Remove beside it) and nobody is "overdue": the screen telling the
//               office something untrue, and offering to act on it. Once it has loaded, "on an
//               upcoming clean" means one in the next 100 days — every regular series is
//               materialised 90 days ahead (lib/recurrence HORIZON_DAYS).
export function checklistIssues({
  clients = [], users = [], jobs = [], templates = null, results = null,
  now = Date.now(), settings = {}, jobsHydrated = true,
} = {}) {
  const out = { overdue: jobsHydrated ? [] : null, rules: [], nobody: [], strays: jobsHydrated ? [] : null };

  const knownUserIds = new Set();
  const activeUserIds = new Set();
  for (const u of users || []) {
    if (!u || !u.id) continue;
    knownUserIds.add(u.id);
    if (u.status === 'active') activeUserIds.add(u.id);
  }
  const clientsById = new Map((clients || []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const scheduled = scheduledCleanersByCustomer(jobs);

  // 2. A rule the office turned off. One row per (cleaner, rule): each is turned back on
  //    by itself, so each is its own fix.
  for (const u of users || []) {
    if (!u || !u.id || u.status !== 'active') continue;
    for (const rule of clockRulesOff(u)) out.rules.push({ kind: 'rules', userId: u.id, rule });
  }

  // 3 + 4. Per customer: a checklist nobody holds, and a holder who is not scheduled here.
  if (Array.isArray(templates)) {
    for (const t of templates) {
      // A template with no customer is a STARTER: it is offered under "Start from…" and is
      // never assigned, so it can never be "held by nobody".
      if (!t || !t.id || !t.client_id) continue;
      if (!clientsById.has(t.client_id)) continue;
      const client = clientsById.get(t.client_id);
      if (holdersOf(client.crewChecklists, t.id).length) continue;
      out.nobody.push({ kind: 'nobody', clientId: t.client_id, templateId: t.id });
    }
  }
  for (const c of (jobsHydrated ? clients || [] : [])) {
    if (!c || !c.id) continue;
    const here = scheduled.get(c.id) || EMPTY_SET;
    for (const [userId, templateId] of Object.entries(c.crewChecklists || {})) {
      if (!userId || !templateId) continue;
      if (!knownUserIds.has(userId)) continue;   // DELETE_USER sweeps these; guard anyway
      if (here.has(userId)) continue;
      out.strays.push({ kind: 'strays', clientId: c.id, userId, templateId });
    }
  }

  // 1. Overdue today — the reminder's own question, asked without its dedup. It is the
  //    unfinished, past-the-nudge half of the SAME walk the "Done today" badges read.
  for (const x of (jobsHydrated ? walkTodaysChecklists({ clients, users, jobs, templates, results, now, settings }) : [])) {
    if (!x.overdue) continue;
    out.overdue.push({
      kind: 'overdue', clientId: x.clientId, jobId: x.jobId, userId: x.userId, templateId: x.templateId,
      done: x.done, total: x.total, startAt: x.startAt,
    });
  }

  return out;
}

// ── The rail's selection rule ────────────────────────────────────────────────
// 🔴 AN EXPLICIT SELECTION IS NEVER SUBSTITUTED. Opening a record — from a worklist row,
// from a holder's name, from the cleaner view's Open — must show THAT record, even when
// the rail's own search or filter hides it. The screen used to fall through to the first
// visible row, so "Open" on a Coral Bay row while the rail was searched for "lakeside"
// quietly opened Lakeside instead (L3 review, S1).
//
// When the selection is outside the current filter it is PINNED to the top of the rail
// and labelled, rather than clearing the filter: the search and the chips are the user's,
// set deliberately and kept in the URL, and wiping them on an Open is the same class of
// surprise as swapping the record. Pinning keeps both truths on screen and leaves the way
// back one click away.
//
// The first visible row stands in ONLY when there is nothing to show instead: no
// selection at all, or an id that names a record that no longer exists (a stale link) —
// reported as `substituted` so the caller can say so.
export function resolveRailSelection({ selectedId = '', exists = false, visibleIds = [], fallbackId = '' } = {}) {
  if (selectedId && exists) {
    return { id: selectedId, pinned: !(visibleIds || []).includes(selectedId), substituted: false };
  }
  return { id: fallbackId || '', pinned: false, substituted: !!selectedId };
}

// ── The Cleaners rail's index ────────────────────────────────────────────────
// How many customers each cleaner works, and who holds a checklist anywhere — built ONCE
// from the data, never per row. The rail used to ask, for every cleaner, whether EVERY
// customer scheduled them or assigned them: 1,470 × 750 = about 1.1M checks on every
// keystroke, measured at ~250 ms per keystroke (L3 review, S3). Memoize this on the
// customers and the schedule, NOT on the search text, and the search is a filter over
// numbers the index already holds.
export function cleanerRailIndex({ clients = [], scheduledByCustomer = new Map() } = {}) {
  const customerCount = new Map();
  const holdsAnywhere = new Set();
  for (const c of clients || []) {
    if (!c || !c.id) continue;
    // One customer counts ONCE for a cleaner, whether they are scheduled there, hold a
    // checklist there, or both.
    const here = new Set(scheduledByCustomer.get(c.id) || []);
    for (const uid of Object.keys(c.crewChecklists || {})) {
      if (!uid || !c.crewChecklists[uid]) continue;
      here.add(uid);
      holdsAnywhere.add(uid);
    }
    for (const uid of here) customerCount.set(uid, (customerCount.get(uid) || 0) + 1);
  }
  return { customerCount, holdsAnywhere };
}

// The rail's "needs attention" dots and its filter chip read the SAME answer the tiles
// count, so a flagged row always has a row in one of the worklists above it.
export function issueIndex(issues) {
  const byClient = new Set();
  const byUser = new Set();
  for (const kind of ISSUE_KINDS) {
    for (const x of (issues && issues[kind]) || []) {
      if (x.clientId) byClient.add(x.clientId);
      if (x.userId) byUser.add(x.userId);
    }
  }
  return { byClient, byUser };
}

// ── The assignment writes ────────────────────────────────────────────────────
// `client.crewChecklists` is keyed by CLEANER, so "a cleaner holds at most one checklist
// per customer" (R2) is the shape itself: assigning replaces, it never adds. These three
// helpers exist so every surface that moves an assignment — the Assignments screen, the
// customer page's Service setup, a worklist's one-click fix — writes the identical map,
// pruned the way `pruneCrewChecklists` prunes it (an empty map means nobody here holds
// one). Each returns a NEW map; the input is never mutated.

export function assignChecklist(crewChecklists, { userId, templateId } = {}) {
  if (!userId || !templateId) return pruneCrewChecklists(crewChecklists);
  return pruneCrewChecklists({ ...(crewChecklists || {}), [userId]: templateId });
}

// Move a checklist from one cleaner to another in ONE step (the screen's "Reassign"). The
// old holder is cleared only if they actually held THIS checklist, so reassigning a
// checklist someone else holds never quietly takes theirs away.
export function reassignChecklist(crewChecklists, { templateId, fromUserId, toUserId } = {}) {
  const next = { ...(crewChecklists || {}) };
  if (fromUserId && fromUserId !== toUserId && next[fromUserId] === templateId) delete next[fromUserId];
  if (toUserId && templateId) next[toUserId] = templateId;
  return pruneCrewChecklists(next);
}

export function removeChecklistHolder(crewChecklists, userId) {
  if (!userId) return pruneCrewChecklists(crewChecklists);
  const next = { ...(crewChecklists || {}) };
  delete next[userId];
  return pruneCrewChecklists(next);
}
