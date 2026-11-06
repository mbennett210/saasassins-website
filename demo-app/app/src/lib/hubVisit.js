// THE CLIENT HUB'S CREW STATUS — one pure time rule for the Home crew band and Today's Visit
// (the client hub redesign, Matt's design, plan §3.2, 2026-10-08).
//
// Matt's board: "Same card, same position on Home, both mobile and web — only the color, icon,
// and copy change based on visit status." This module decides which card, and everything on the
// visit page's timeline, from the building's jobs, its punches and its checklist saves. The
// SERVER (api/hub `home` and `visit`), the login-free DEMO (lib/hubDemo.js) and the suite
// (scripts/test-hub-visit-status.mjs) all run it, so the three can never answer differently.
//
//   on_site   any open punch at the building (hubOnSiteList's rule), whatever day the visit began
//             on — a night clean past midnight stays on site.
//   arriving  no open punch, and a job today (not cancelled, missed or already done) nobody has
//             punched into, starting no earlier than the day's last check-out. When two visits
//             share a day, the later unstarted one wins over "done".
//   done      no open punch, a punch at the building closed today, and no later visit today.
//   none      otherwise; `next` is the next upcoming visit (or null).
//
// TIMELINESS (M1 ★, HUB-20: stay neutral). The first clock-in against the start of the job the
// punch NAMES (time_entries.job_id), else that day's nearest job. |Δ| ≤ HUB_ON_TIME_MINUTES is
// "on time", earlier is "N min early", and later carries NO minutes — the card shows the time
// only, and a visit past its start with nobody there is still "arriving" ("Expected at …").
//
// THE CHECKLIST STEPS appear only when a checklist is EXPECTED: someone on the visit's crew (or
// on site) resolves to one through crewChecklist.checklistFor, or a checklist was saved today.
// There is no live item count: a checklist is done when the cleaner saves it (Daniel,
// 2026-10-08 — the board's "5 of 8" was only Claude's example).
//
// 🔴 TIME IS THE ORG'S ZONE. Every "today" is `dayKey(…, tz)` with the company's timezone, never
// the process zone and never "the last 24 hours" (a DST day is 23 or 25 hours long).
//
// 🔴 EVERYTHING SERVED IS AN ALLOWLIST. The inputs carry staff ids, full names, crew lists and
// checklist ids; the output names people only through hubPersonName (first name + last initial)
// and carries no id at all. The suite compares the served keys against the constants below.
// A person's photo (HUB-19) is only ever its version, { v }, from the caller's `photoOf`
// (lib/hubFaces.js), asked by the user id the rule already holds — never the id itself.
//
// PURE and node-safe (explicit .js imports, no browser globals): the server imports it.
import { dayKey, addDaysKey, startOfDayKey, DEFAULT_ORG_TIMEZONE } from './dates.js';
import { hubPersonName } from './clientHub.js';
import { isOnSiteNow, isRealPunch, hubOnSiteList, projectHubPhoto } from './clientHubView.js';
import { projectHubFace, hubInitials } from './hubFaces.js';
import { checklistFor } from './crewChecklist.js';
import { cleanedCountsOf } from './checklistCount.js';
import { JOB_STATUS, isCompletedJobStatus } from './jobStatus.js';

export const HUB_VISIT_STATES = Object.freeze(['on_site', 'arriving', 'done', 'none']);
// "On time" is within this many minutes of the start, either side.
export const HUB_ON_TIME_MINUTES = 1;
// Today's Visit lists this many upcoming visits (the board's three cards).
export const HUB_UPCOMING_MAX = 3;
// The visit's before/after photos signed per read (each a short-lived URL).
export const HUB_VISIT_PHOTO_MAX = 6;
// The visit's photo ROWS read to learn how many there are ("+N").
export const HUB_VISIT_PHOTO_SCAN = 60;

export const HUB_TIMELINE_STEPS = Object.freeze(['scheduled', 'checked_in', 'checklist_progress', 'checklist_complete', 'checked_out']);
export const HUB_TIMELINE_STEP_STATES = Object.freeze(['done', 'current', 'pending']);

// ── the allowlists ────────────────────────────────────────────────────────────
// The rule's whole answer. `timeline` is Today's Visit's; the Home band serves the rest
// (HUB_CREW_FIELDS, projectHubCrew).
export const HUB_VISIT_STATUS_FIELDS = Object.freeze(['state', 'arrivedAt', 'timeliness', 'crew', 'scheduledAt', 'checkedOutAt', 'next', 'timeline']);
export const HUB_CREW_FIELDS = Object.freeze(HUB_VISIT_STATUS_FIELDS.filter((f) => f !== 'timeline'));
// `photos` line up with `initials` (each a photo's version, { v }, or null: HUB-19, lib/hubFaces.js).
export const HUB_CREW_PEOPLE_FIELDS = Object.freeze(['lead', 'others', 'initials', 'photos']);
export const HUB_TIMELINESS_FIELDS = Object.freeze(['kind', 'minutes']);
export const HUB_NEXT_FIELDS = Object.freeze(['startAt']);
export const HUB_TIMELINE_FIELDS = Object.freeze(['key', 'state', 'at', 'done', 'total']);
export const HUB_UPCOMING_FIELDS = Object.freeze(['startAt', 'endAt']);
// GET /api/hub/visit, whole.
export const HUB_VISIT_FIELDS = Object.freeze(['crew', 'onSite', 'timeline', 'photos', 'upcoming', 'manager']);
export const HUB_VISIT_PHOTOS_FIELDS = Object.freeze(['before', 'after', 'more']);
// The building's account manager as the visit page names them: "Account Manager · Dana K.", with
// their photo's version, { v }, or null (HUB-19).
export const HUB_MANAGER_FIELDS = Object.freeze(['name', 'phone', 'photo']);

// The visit photos' two areas (the cleaner's guided visit, components/CrewJobVisit.jsx steps 2
// and 4: account_media scope 'clean', ref_id = the job, area_id = 'before' | 'after').
export const HUB_VISIT_PHOTO_SCOPE = 'clean';
export const HUB_VISIT_PHOTO_AREAS = Object.freeze(['before', 'after']);

const SKEW_MS = 5 * 60000;          // a phone's clock a little ahead is still "now"
const NOT_A_VISIT = new Set([JOB_STATUS.CANCELLED, JOB_STATUS.MISSED]);
const ms = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
};
const isoOf = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
const byStart = (a, b) => ms(a.startAt) - ms(b.startAt) || String(a.id).localeCompare(String(b.id));
const byIn = (a, b) => ms(a.clock_in_at) - ms(b.clock_in_at) || String(a.id).localeCompare(String(b.id));

// A job as the rule reads it — from a public.jobs row (the server's declared columns:
// start_at, end_at, crew_ids, cover_for) or a store job (the demo: startAt, endAt, crewIds,
// coverFor). Nothing else of the job is read.
export function hubVisitJob(j) {
  if (!j || typeof j !== 'object') return null;
  const crew = Array.isArray(j.crewIds) ? j.crewIds : (Array.isArray(j.crew_ids) ? j.crew_ids : []);
  const cover = j.coverFor ?? j.cover_for ?? null;
  return {
    id: j.id ?? null,
    startAt: j.startAt ?? j.start_at ?? null,
    endAt: j.endAt ?? j.end_at ?? null,
    status: j.status ?? null,
    crewIds: crew.filter((u) => typeof u === 'string' && u),
    coverFor: cover && typeof cover === 'object' && !Array.isArray(cover) ? cover : null,
  };
}

// The org day's edges as instants, for the reads: punches and checklists from the start of
// YESTERDAY (a night clean that began before midnight), jobs from then to the end of today.
export function hubVisitWindow(now = Date.now(), tz = DEFAULT_ORG_TIMEZONE) {
  const zone = tz || DEFAULT_ORG_TIMEZONE;
  const today = dayKey(now, zone);
  return {
    today,
    dayStartIso: startOfDayKey(today, zone).toISOString(),
    fromIso: startOfDayKey(addDaysKey(today, -1), zone).toISOString(),
    toIso: startOfDayKey(addDaysKey(today, 1), zone).toISOString(),
  };
}

// "Carlos M." → "CM", "Cher" → "C". From the projected name only, so no surname ever reaches it
// (the one rule, lib/hubFaces.js, which the hub's faces draw too).
export const hubCrewInitials = hubInitials;

// The next upcoming visits: status upcoming, starting after now, soonest first.
export function hubUpcomingVisits(jobs, { now = Date.now(), max = HUB_UPCOMING_MAX, excludeId = null } = {}) {
  return (Array.isArray(jobs) ? jobs : [])
    .map(hubVisitJob)
    .filter((j) => j && j.status === JOB_STATUS.UPCOMING && ms(j.startAt) > now && (!excludeId || j.id !== excludeId))
    .sort(byStart)
    .slice(0, Math.max(0, max))
    .map((j) => ({ startAt: isoOf(ms(j.startAt)), endAt: isoOf(ms(j.endAt)) }));
}

// The crew as served, from [{ name, photo }] in order: the lead, how many more, and up to six
// faces (initials, and each one's photo or null).
const CREW_FACES_MAX = 6;
const crewOf = (people) => (people.length
  ? {
    lead: people[0].name,
    others: people.length - 1,
    initials: people.slice(0, CREW_FACES_MAX).map((p) => hubCrewInitials(p.name)),
    photos: people.slice(0, CREW_FACES_MAX).map((p) => projectHubFace(p.photo)),
  }
  : null);

// ── the rule ──────────────────────────────────────────────────────────────────
// jobs       the building's jobs starting from the start of yesterday to the end of today
//            (hubVisitWindow), any shape hubVisitJob reads
// punches    the building's time entries clocked in since the start of yesterday:
//            { id, user_id, user_name, clock_in_at, clock_out_at, status, job_id }
// checklists the building's checklist saves since the start of yesterday:
//            { id, job_id, completed_by_user_id, completed_count, total_count, items, performed_at }
//            (a task marked "not completed" is not done in the step's count: cleanedCountsOf, D2)
// client     the building's customer row (only `crewChecklists` is read, through checklistFor)
// upcoming   jobs ahead (for `next`); the visit's own job is never its "next"
// photoOf    (userId) => the person's face, { v } or null (HUB-19, lib/hubFaces hubFaceOf over the
//            roster); asked only about the people the crew names
export function hubVisitStatus({
  jobs = [], punches = [], checklists = [], client = null, upcoming = [], now = Date.now(), tz = DEFAULT_ORG_TIMEZONE,
  photoOf = null,
} = {}) {
  const zone = tz || DEFAULT_ORG_TIMEZONE;
  const dayOf = (t) => dayKey(t, zone);
  const today = dayOf(now);

  const live = (Array.isArray(jobs) ? jobs : []).map(hubVisitJob)
    .filter((j) => j && j.id && Number.isFinite(ms(j.startAt)) && !NOT_A_VISIT.has(j.status))
    .sort(byStart);
  const byId = new Map(live.map((j) => [j.id, j]));
  const real = (Array.isArray(punches) ? punches : [])
    .filter((p) => isRealPunch(p) && Number.isFinite(ms(p.clock_in_at)) && ms(p.clock_in_at) <= now + SKEW_MS)
    .sort(byIn);

  // Which visit each punch belongs to: the job it names, else its day's nearest job.
  const jobOf = (p) => {
    if (p.job_id && byId.has(p.job_id)) return byId.get(p.job_id);
    const t = ms(p.clock_in_at);
    const day = dayOf(t);
    let best = null;
    for (const j of live) {
      if (dayOf(ms(j.startAt)) !== day) continue;
      const gap = Math.abs(ms(j.startAt) - t);
      if (!best || gap < best.gap) best = { j, gap };
    }
    return best ? best.j : null;
  };
  const visitOf = new Map(real.map((p) => [p, jobOf(p)]));
  const started = new Set([...visitOf.values()].filter(Boolean).map((j) => j.id));

  const open = real.filter((p) => isOnSiteNow(p, now));
  const closedToday = real.filter((p) => {
    const out = ms(p.clock_out_at);
    return Number.isFinite(out) && out <= now + SKEW_MS && dayOf(out) === today;
  });
  const lastOut = closedToday.reduce((m, p) => Math.max(m, ms(p.clock_out_at)), -Infinity);
  const pending = live.filter((j) => dayOf(ms(j.startAt)) === today && !started.has(j.id)
    && !isCompletedJobStatus(j.status) && ms(j.startAt) >= lastOut);

  let state = 'none';
  let visit = null;
  let visitPunches = [];
  if (open.length) {
    state = 'on_site';
    visit = visitOf.get(open[0]) || null;
    visitPunches = visit ? real.filter((p) => visitOf.get(p) === visit) : [];
    for (const p of open) if (!visitPunches.includes(p)) visitPunches.push(p);
  } else if (pending.length) {
    state = 'arriving';
    visit = pending[0];
  } else if (closedToday.length) {
    state = 'done';
    const last = closedToday.reduce((a, p) => (!a || ms(p.clock_out_at) > ms(a.clock_out_at) ? p : a), null);
    visit = visitOf.get(last) || null;
    visitPunches = visit ? real.filter((p) => visitOf.get(p) === visit) : closedToday;
  }

  const here = state === 'on_site' || state === 'done';
  const arrived = here ? visitPunches.reduce((m, p) => Math.min(m, ms(p.clock_in_at)), Infinity) : NaN;
  const checkedOut = state === 'done' ? visitPunches.reduce((m, p) => Math.max(m, ms(p.clock_out_at)), -Infinity) : NaN;

  // Timeliness: neutral (M1 ★). Late carries no minutes.
  let timeliness = null;
  if (here && visit && Number.isFinite(arrived)) {
    const delta = (arrived - ms(visit.startAt)) / 60000;
    if (Math.abs(delta) <= HUB_ON_TIME_MINUTES) timeliness = { kind: 'on_time', minutes: 0 };
    else if (delta < 0) timeliness = { kind: 'early', minutes: Math.round(-delta) };
    else timeliness = { kind: 'late', minutes: null };
  }

  // The crew, first name + last initial: who is on site now (HUB-5's rule, one row a person,
  // earliest first), or who came on the visit that is done; each with their photo (HUB-19).
  let crew = null;
  if (state === 'on_site') crew = crewOf(hubOnSiteList(open, now, { photoOf }).map((x) => ({ name: x.name, photo: x.photo })));
  else if (state === 'done') {
    const seen = new Set();
    const people = [];
    for (const p of [...visitPunches].sort(byIn)) {
      const k = p.user_id || p.id;
      if (seen.has(k)) continue;
      seen.add(k);
      const photo = typeof photoOf === 'function' && p.user_id ? photoOf(p.user_id) : null;
      people.push({ name: hubPersonName(p.user_name) || 'A cleaner', photo });
    }
    crew = crewOf(people);
  }

  // The checklist: expected, saved during this visit, complete when everyone it was expected of
  // has saved (no live count — a checklist is done when the cleaner saves it).
  const saves = (Array.isArray(checklists) ? checklists : [])
    .filter((c) => c && Number.isFinite(ms(c.performed_at)) && ms(c.performed_at) <= now + SKEW_MS);
  const resolving = new Set();
  const people = new Set([...(visit ? visit.crewIds : []), ...(state === 'on_site' ? open.map((p) => p.user_id).filter(Boolean) : [])]);
  for (const userId of people) if (checklistFor({ client, job: visit, userId })) resolving.add(userId);
  const visitSaves = here ? saves.filter((c) => {
    if (visit && c.job_id && c.job_id === visit.id) return true;
    if (c.job_id && byId.has(c.job_id) && (!visit || c.job_id !== visit.id)) return false; // another visit's
    const t = ms(c.performed_at);
    const until = state === 'done' ? checkedOut + 60 * 60000 : now + SKEW_MS;
    return Number.isFinite(arrived) && t >= arrived - SKEW_MS && t <= until;
  }) : [];
  const savedToday = saves.some((c) => dayOf(ms(c.performed_at)) === today);
  const expected = state !== 'none' && (resolving.size > 0 || visitSaves.length > 0 || savedToday);
  const savers = new Set(visitSaves.map((c, i) => c.completed_by_user_id || `#${i}`));
  const complete = visitSaves.length > 0 && savers.size >= Math.max(1, resolving.size);
  const lastSave = visitSaves.reduce((m, c) => Math.max(m, ms(c.performed_at)), -Infinity);
  const sum = (k) => visitSaves.reduce((s, c) => s + (Number.isFinite(c[k]) ? c[k] : 0), 0);

  const timeline = [];
  const step = (key, st, at = null, done = null, total = null) => timeline.push({ key, state: st, at, done, total });
  if (state !== 'none') {
    if (visit) step('scheduled', 'done', isoOf(ms(visit.startAt)));
    if (state === 'arriving') step('checked_in', 'current');
    else step('checked_in', 'done', isoOf(arrived));
    if (expected) {
      if (complete) {
        step('checklist_progress', 'done');
        step('checklist_complete', 'done', isoOf(lastSave), visitSaves.reduce((s, c) => s + cleanedCountsOf(c).done, 0), sum('total_count'));
      } else {
        step('checklist_progress', state === 'on_site' ? 'current' : (visitSaves.length ? 'done' : 'pending'));
        step('checklist_complete', 'pending');
      }
    }
    step('checked_out', state === 'done' ? 'done' : 'pending', state === 'done' ? isoOf(checkedOut) : null);
  }

  const ahead = hubUpcomingVisits(upcoming, { now, max: 1, excludeId: visit ? visit.id : null });
  return {
    state,
    arrivedAt: here ? isoOf(arrived) : null,
    timeliness,
    crew,
    scheduledAt: visit ? isoOf(ms(visit.startAt)) : null,
    checkedOutAt: state === 'done' ? isoOf(checkedOut) : null,
    next: ahead.length ? { startAt: ahead[0].startAt } : null,
    timeline,
  };
}

// The Home band: the status less the visit page's timeline.
export function projectHubCrew(status) {
  const s = status || {};
  const out = {};
  for (const f of HUB_CREW_FIELDS) out[f] = s[f] === undefined ? null : s[f];
  return out;
}

// The building's account manager for the visit page: first name + last initial, their own phone
// and their photo, from the building's projected supervisor (clientHub.projectHubBuilding), or null.
export function projectHubManager(supervisor) {
  if (!supervisor || !supervisor.name) return null;
  return { name: hubPersonName(supervisor.name), phone: supervisor.phone || '', photo: projectHubFace(supervisor.photo) };
}

// WHICH of the visit's before/after photos are shown (and so signed): at most
// HUB_VISIT_PHOTO_MAX, up to half from each side, a side with fewer giving its room to the
// other, oldest first within a side. `rows` carry `area_id` (a table row) or `areaId` (a signed one).
const photoArea = (p) => p.area_id ?? p.areaId ?? null;
export function hubVisitPhotoPick(rows) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  const half = Math.floor(HUB_VISIT_PHOTO_MAX / 2);
  const before = list.filter((p) => photoArea(p) === 'before');
  const after = list.filter((p) => photoArea(p) === 'after');
  const nb = Math.min(before.length, Math.max(half, HUB_VISIT_PHOTO_MAX - Math.min(after.length, half)));
  const na = Math.min(after.length, HUB_VISIT_PHOTO_MAX - nb);
  return [...before.slice(0, nb), ...after.slice(0, na)];
}

// The visit's photos as served: the picked ones (already signed) split by area, and how many
// more there are ("+N"). `total` is every before/after photo the visit has.
export function projectHubVisitPhotos(rows, { total = null } = {}) {
  const picked = hubVisitPhotoPick(rows);
  const all = Number.isFinite(total) ? total : picked.length;
  return {
    before: picked.filter((p) => photoArea(p) === 'before').map(projectHubPhoto),
    after: picked.filter((p) => photoArea(p) === 'after').map(projectHubPhoto),
    more: Math.max(0, all - picked.length),
  };
}

// GET /api/hub/visit's answer (and the demo's), built from its declared parts only. `upcoming`
// is hubUpcomingVisits' list; the visit the card is already about (an "arriving" visit later
// today) is not listed again under "Upcoming visits".
export function projectHubVisit({ status, onSite = [], photos = null, upcoming = [], manager = null } = {}) {
  const current = status?.scheduledAt || null;
  return {
    crew: projectHubCrew(status),
    onSite: Array.isArray(onSite) ? onSite : [],
    timeline: Array.isArray(status?.timeline) ? status.timeline : [],
    photos: photos || { before: [], after: [], more: 0 },
    upcoming: (Array.isArray(upcoming) ? upcoming : [])
      .filter((u) => u && u.startAt !== current)
      .slice(0, HUB_UPCOMING_MAX)
      .map((u) => ({ startAt: u.startAt ?? null, endAt: u.endAt ?? null })),
    manager: manager ? { name: manager.name || '', phone: manager.phone || '', photo: projectHubFace(manager.photo) } : null,
  };
}
