// THE CLEANER'S SCAN — a fill-in gets the checklist; no checklist, the building's last inspection
// and open tickets (QR Wave 2, 2026-10-17; UI_RULES §176). Matt's answers, Daniel: "go with his note":
//
//   QR-14  "Don't default to the schedule because sometimes we might send cleaners as a filler for
//          someone that was not able to make it to work today. They also have to be able to scan
//          and do the checklist. I would say if their profile says cleaner, they see a checklist."
//   QR-12  "Just open the checklist; they clock in separately … all I see is my checklist for that
//          area (if there is any), or the last inspection done, or any open tickets."
//   QR-13  "No: GPS only." — a scan is not presence: nothing here reads or writes a punch's
//          record of WHERE, an approval or the variance report.
//
// "Profile says cleaner" = the Crew role (users carry no other job title).
//
// PURE and node-safe (explicit `.js` imports): the server's two routes (EP-420 the cleaner's read,
// EP-419 the fill-in, api/scan-codes/[...path].js), the demo's stubs (lib/scanCodesApi) and the
// suite (scripts/test-qr-fill-in.mjs) run these same functions, so the phone, the demo and the
// server cannot disagree about who may cover whom.
//
// THE MODEL IS R8's (lib/jobCover.js): `job.coverFor = { [coverUserId]: coveredUserId }` on ONE
// visit, and an entry is valid only while the cover is ON the visit and the cleaner it names is
// NOT. So a fill-in is a SWAP: the person who didn't come leaves today's clean, the filler joins
// it, and `coverFor` says who covers whom — exactly the office's swap in Job Detail's "This visit"
// edit. A series visit is marked a one-off crew (`oneOff.crew`, as the reducer's markOneOff marks
// the office's single-visit edit), so a later "this & all future" crew change does not undo it.
// The server does not load the series' master, so the day's regulars are UNKNOWABLE here and the
// crew rules alone apply (normalizeCoverFor's documented `null`), as on any phone whose window
// does not hold the master.
import { normalizeCoverFor } from './jobCover.js';
import { isOnTodayList } from './clockInWindow.js';
import { isCompletedJobStatus } from './jobStatus.js';
import { crewCleanAtLocation } from './scanCodes.js';

// What a not-scheduled cleaner's scan finds at the location, today (EP-420's `fillIn.state`).
export const FILL_IN_STATE = Object.freeze({
  OFFER: 'offer',              // "Filling in for someone?" — the scheduled cleaners not clocked in
  EVERYONE_IN: 'everyoneIn',   // every scheduled cleaner on today's clean here has clocked in
  NO_CLEAN: 'noClean',         // no clean here today at all
  DONE: 'done',                // today's cleans here are all done
  ASK_MANAGER: 'askManager',   // the only clean waiting is a series' template visit: the office adds you
});

// Why a fill-in is refused (EP-419). Each is a stable `code` the phone turns into a sentence; the
// route maps each to its status (FILL_IN_REFUSAL_STATUS).
export const FILL_IN_REFUSAL = Object.freeze({
  NOT_FOUND: 'fill-in-not-found',           // no such clean
  WRONG_LOCATION: 'fill-in-wrong-location', // the clean is at another location than the code
  CANCELLED: 'fill-in-cancelled',
  NOT_TODAY: 'fill-in-not-today',
  DONE: 'fill-in-done',
  TEMPLATE: 'fill-in-template',             // the series' template row (its crew is every future visit's)
  SELF: 'fill-in-self',                     // nobody covers themselves
  NOT_ON_CLEAN: 'fill-in-not-on-clean',     // the person named isn't an active cleaner on the clean
  CLOCKED_IN: 'fill-in-clocked-in',         // the person named is already here
});
export const FILL_IN_REFUSAL_STATUS = Object.freeze({
  [FILL_IN_REFUSAL.NOT_FOUND]: 404,
  [FILL_IN_REFUSAL.SELF]: 400,
  [FILL_IN_REFUSAL.WRONG_LOCATION]: 409,
  [FILL_IN_REFUSAL.CANCELLED]: 409,
  [FILL_IN_REFUSAL.NOT_TODAY]: 409,
  [FILL_IN_REFUSAL.DONE]: 409,
  [FILL_IN_REFUSAL.TEMPLATE]: 409,
  [FILL_IN_REFUSAL.NOT_ON_CLEAN]: 409,
  [FILL_IN_REFUSAL.CLOCKED_IN]: 409,
});

// Each route's allowance per login (api/_lib/rateLimit.js). A cleaner scans a wall once or twice
// and fills in once; a loop meets these.
export const SCAN_CREW_AREA_RATE = Object.freeze({ limit: 30, windowMs: 60 * 1000 });
export const SCAN_FILL_IN_RATE = Object.freeze({ limit: 10, windowMs: 60 * 1000 });

// The newest open tickets the cleaner's view lists (it says "the newest N of M" past that).
export const CREW_AREA_TICKETS_MAX = 20;

// The answers, built KEY BY KEY (a jobs row carries notes and its crew; a ticket row carries the
// customer's words, a visitor's name and contact, internal flags — none of it reaches a cleaner).
export const FILL_IN_CANDIDATE_KEYS = Object.freeze(['jobId', 'userId', 'startAt', 'endAt']);
export const CREW_AREA_INSPECTION_KEYS = Object.freeze(['performedAt', 'result']);
export const CREW_AREA_TICKET_KEYS = Object.freeze(['title', 'type', 'area', 'openedAt']);

const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : []);
const crewOf = (job) => [...new Set(ids(job?.crewIds))];
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const startMs = (j) => { const t = Date.parse(j?.startAt || ''); return Number.isFinite(t) ? t : Infinity; };
const byStart = (a, b) => (startMs(a) - startMs(b)) || String(a.id).localeCompare(String(b.id));

// A clean at the code's location: its own location, or — a clean filed with none — its customer
// (lib/scanCodes crewCleanAtLocation's rule).
export function atLocation(job, siteId = null, clientId = null) {
  if (!job) return false;
  if (siteId && job.siteId === siteId) return true;
  return !job.siteId && !!clientId && job.clientId === clientId;
}

// May a fill-in rewrite this row's crew? Not a series' TEMPLATE row whose crew is still the series'
// default: TOP_UP mints every future visit from that crew (lib/recurrence seriesDefaultCrew), so a
// swap there would move the cleaner off every visit to come. A series written since 2026-09-23
// pins its template crew (`recurrence.crewOverride`, the reducer's pinTemplateDefaults), and its
// template row is then just a visit (applyTimeOffToOccurrence's own reason for skipping it).
export function fillInRowOk(job) {
  if (!job?.recurrence) return true;
  return Array.isArray(job.recurrence.crewOverride);
}

// `punchedByJob`: who has clocked in to each clean (a voided or no-show punch counts for nobody) —
// a Map of jobId → Set|array of user ids, or a plain object of arrays.
function punchedSet(punchedByJob, jobId) {
  const v = punchedByJob instanceof Map ? punchedByJob.get(jobId) : (punchedByJob ? punchedByJob[jobId] : null);
  return v instanceof Set ? v : new Set(ids(Array.isArray(v) ? v : []));
}

// WHAT A CLEANER'S SCAN FINDS AT THE LOCATION, TODAY (EP-420; the demo runs it too).
//   jobs           the cleans at the location (the server reads them by site; the phone's demo has all)
//   siteId/clientId the code's location (lib/scanCodes scanLocationOf)
//   userId         the cleaner whose view this is (the claim's, or the office's preview's subject)
//   punchedByJob   who has clocked in to each clean
//   activeUserIds  the roster's active members (a departed cleaner is never offered); null = all
//   todayKey/nowMs/graceMins/timeZone  "today" by lib/clockInWindow isOnTodayList, in the ORG zone
// → { onClean, state, candidates }:
//   onClean     the cleaner's OWN clean here today (crewCleanAtLocation's pick: in progress, else the
//               first not finished, else the last) — they are scheduled, and nothing else is asked
//   state       FILL_IN_STATE when they are not (null when they are)
//   candidates  [{ jobId, userId, startAt, endAt }] the scheduled cleaners on today's open cleans
//               here who have not clocked in to them, in start order (only for OFFER)
export function fillInPlan({
  jobs = [], siteId = null, clientId = null, userId = null, punchedByJob = null, activeUserIds = null,
  todayKey, nowMs = Date.now(), graceMins, timeZone,
} = {}) {
  const active = activeUserIds ? new Set(activeUserIds) : null;
  const here = (Array.isArray(jobs) ? jobs : [])
    .filter((j) => j && atLocation(j, siteId, clientId) && isOnTodayList(j, todayKey, nowMs, graceMins, timeZone))
    .sort(byStart);
  const mine = userId ? here.filter((j) => crewOf(j).includes(userId)) : [];
  const onClean = mine.length ? crewCleanAtLocation({ cleans: mine, siteId, clientId }) : null;
  if (onClean) return { onClean, state: null, candidates: [] };
  if (!here.length) return { onClean: null, state: FILL_IN_STATE.NO_CLEAN, candidates: [] };
  const open = here.filter((j) => !isCompletedJobStatus(j.status));
  if (!open.length) return { onClean: null, state: FILL_IN_STATE.DONE, candidates: [] };
  const candidates = [];
  let template = false;
  for (const j of open) {
    const punched = punchedSet(punchedByJob, j.id);
    const waiting = crewOf(j).filter((uid) => uid !== userId && (!active || active.has(uid)) && !punched.has(uid));
    if (!waiting.length) continue;
    if (!fillInRowOk(j)) { template = true; continue; }
    for (const uid of waiting) candidates.push({ jobId: j.id, userId: uid, startAt: j.startAt ?? null, endAt: j.endAt ?? null });
  }
  if (candidates.length) return { onClean: null, state: FILL_IN_STATE.OFFER, candidates };
  return { onClean: null, state: template ? FILL_IN_STATE.ASK_MANAGER : FILL_IN_STATE.EVERYONE_IN, candidates: [] };
}

// THE FILL-IN ITSELF: the swap on ONE visit (see the header). Pure; never mutates `job`; strips the
// sync layer's `_rv` (never domain data).
export function applyFillIn(job, { userId, coverFor } = {}) {
  const { _rv, ...base } = job || {};
  void _rv;
  const crewIds = crewOf(base).filter((id) => id !== coverFor && id !== userId);
  crewIds.push(userId);
  const prior = base.coverFor && typeof base.coverFor === 'object' && !Array.isArray(base.coverFor) ? base.coverFor : {};
  const next = { ...base, crewIds, coverFor: normalizeCoverFor({ ...prior, [userId]: coverFor }, crewIds, null) };
  if (base.seriesId) next.oneOff = { crew: true, ...(base.oneOff?.time ? { time: true } : {}) };
  return next;
}

// May THIS cleaner fill in for THAT one on THIS clean, now? The server's whole decision (EP-419),
// re-run on every compare-and-swap retry against the row it just read.
//   job        the clean's stored payload (null when it doesn't exist)
//   loc        the code's location ({ siteId, clientId })
//   userId     the cleaner, from the claim
//   coverFor   who they fill in for
//   punched    who has clocked in to this clean (Set|array)
// → { kind: 'refuse', code } | { kind: 'repeat' } (already on it: success, nothing written)
//   | { kind: 'write', job } (applyFillIn's row)
export function fillInDecision({
  job = null, loc = null, userId = null, coverFor = null, punched = null, activeUserIds = null,
  todayKey, nowMs = Date.now(), graceMins, timeZone,
} = {}) {
  const refuse = (code) => ({ kind: 'refuse', code });
  if (!job) return refuse(FILL_IN_REFUSAL.NOT_FOUND);
  if (!atLocation(job, loc?.siteId || null, loc?.clientId || null)) return refuse(FILL_IN_REFUSAL.WRONG_LOCATION);
  if (job.status === 'cancelled') return refuse(FILL_IN_REFUSAL.CANCELLED);
  if (!isOnTodayList(job, todayKey, nowMs, graceMins, timeZone)) return refuse(FILL_IN_REFUSAL.NOT_TODAY);
  const crew = crewOf(job);
  if (userId && crew.includes(userId)) return { kind: 'repeat' };
  if (isCompletedJobStatus(job.status)) return refuse(FILL_IN_REFUSAL.DONE);
  if (!fillInRowOk(job)) return refuse(FILL_IN_REFUSAL.TEMPLATE);
  if (!coverFor || coverFor === userId) return refuse(FILL_IN_REFUSAL.SELF);
  const active = activeUserIds ? new Set(activeUserIds) : null;
  if (!crew.includes(coverFor) || (active && !active.has(coverFor))) return refuse(FILL_IN_REFUSAL.NOT_ON_CLEAN);
  const here = punched instanceof Set ? punched : new Set(ids(Array.isArray(punched) ? punched : []));
  if (here.has(coverFor)) return refuse(FILL_IN_REFUSAL.CLOCKED_IN);
  return { kind: 'write', job: applyFillIn(job, { userId, coverFor }) };
}

// ── the answers, key by key ──────────────────────────────────────────────────────────────────
export function projectFillInCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : []).filter(Boolean).map((c) => ({
    jobId: c.jobId, userId: c.userId, startAt: c.startAt ?? null, endAt: c.endAt ?? null,
  }));
}

// A ticket's area, by the EXPLICIT id the ticket names (`site_area_id`, builder R's column) against
// the location's own cleaning areas — never by matching words. A ticket with none, or naming an area
// no longer there, names none.
function areaLabelOf(site, areaId) {
  if (typeof areaId !== 'string' || !areaId) return null;
  const a = (Array.isArray(site?.cleaningAreas) ? site.cleaningAreas : []).find((x) => x && x.id === areaId);
  return a ? str(a.label) : null;
}

// THE CLEANER'S VIEW OF AN AREA (QR-12's note): the building's last inspection and its open tickets,
// newest first. `inspection` is the newest SUBMITTED inspection row there (performed_at, result);
// `tickets` the open problem_reports rows, newest first (whatever columns the row has — R's
// `site_area_id` is read only if present); `site` the location (for an area's name).
// → { lastInspection: { performedAt, result } | null, tickets: [{ title, type, area, openedAt }],
//     ticketsTotal }. Never a visitor's name or contact, a description, a note or an id.
export function projectCrewAreaInfo({ inspection = null, tickets = [], site = null, ticketsTotal = null } = {}) {
  const list = (Array.isArray(tickets) ? tickets : []).filter(Boolean);
  return {
    lastInspection: inspection ? {
      performedAt: typeof inspection.performed_at === 'string' ? inspection.performed_at : null,
      result: typeof inspection.result === 'string' ? inspection.result : null,
    } : null,
    tickets: list.slice(0, CREW_AREA_TICKETS_MAX).map((t) => ({
      title: str(t.title),
      type: typeof t.type === 'string' ? t.type : null,
      area: areaLabelOf(site, t.site_area_id),
      openedAt: typeof t.created_at === 'string' ? t.created_at : null,
    })),
    ticketsTotal: Number.isFinite(ticketsTotal) ? ticketsTotal : list.length,
  };
}
