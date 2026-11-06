// Pure helpers for the manager Approvals wave (spec §8.1–§8.4). No React / store / browser
// globals; `.js` on every import; node-safe (unit-tested by app/scripts/test-time-approvals.mjs).
// Lives beside the other facet/derivation helpers the manager time surfaces read (lib/filters).
import { dayKey, addDaysKey } from '../dates.js';
import { payPeriodRange, payWeekStartDayOf } from '../payroll.js';
import { refusesOwn, TIME_REFUSALS, TIME_REFUSAL_KEYS } from '../timeRules.js';
import { checklistFlagChipMessage } from '../checklistFlag.js';
import { overlapFlagChipMessage } from '../openPunchRule.js';
import { GEOFENCE_REASON_KEYS, offSiteChipMessage } from '../clockRules.js';
import { lateStartAutoCloseOf } from '../autoClose.js';
import { translate, msg, english } from '../../i18n/core.js';

// The cleans a manager may log a MISSED punch against for `cleanerId` on org-day `dk`
// (TimeEntryModal Add mode). That cleaner's assigned, non-cancelled cleans whose ORG day is
// within ±1 of `dk` (±1 covers an overnight clean that starts the evening before or crosses
// midnight into the next), PAST cleans included, sorted by start ascending. When `scope` is a
// Set (a manager), only cleans at a customer they supervise; `null` scope (owner/admin) = all.
//
// This is the CS-050 fix: the old inline list was `jobs.sort(desc).slice(0, 200)` filtered to
// the cleaner — the 200 latest-DATED jobs, which in a live book are all in the FUTURE and
// unscoped, so the clean a missed punch belonged to was never in the list.
export function cleansForCleanerDay({ jobs = [], cleanerId, dayKey: dk, scope = null, tz } = {}) {
  if (!cleanerId || !dk) return [];
  const window = new Set([addDaysKey(dk, -1), dk, addDaysKey(dk, 1)]);
  return (jobs || [])
    .filter((j) => j
      && j.status !== 'cancelled'
      && Array.isArray(j.crewIds) && j.crewIds.includes(cleanerId)
      && j.startAt && window.has(dayKey(j.startAt, tz))
      && (scope === null || (j.clientId != null && scope.has(j.clientId))))
    .slice()
    .sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)) || String(a.id).localeCompare(String(b.id)));
}

// Whether `user` may take a manager action (Approve / Edit / Delete) on a punch row. The only
// bar is the own-time rule: only a Super Admin (owner) acts on their own time (spec §2). Scope
// is already enforced by the server read + the page's customer options, so it is not re-checked
// here. Accepts a snake_case row (user_id) or the neutral shape (userId).
export function canActOnPunch(user, row) {
  return !refusesOwn(user, row?.user_id ?? row?.userId ?? null);
}

// The row actions the NON-queue punch surfaces (the Time Clock detail modal + the Variance drill)
// may offer, and the reason to show when they may not. Those surfaces gated only on the permission
// keys, so they offered Approve / Edit / Delete / Restore on a non-owner's OWN punch — which the
// server refuses (own-entry). The bar is canActOnPunch (→ refusesOwn), the SAME gate the Approvals
// queue uses; scope is already enforced by the read, and each specific action still needs its
// permission key. Returns { canAct, reason }; the reason is the shared own-entry copy. W4-F finding 4.
export function punchActionGate(user, row) {
  const canAct = canActOnPunch(user, row);
  // reasonKey: the same sentence's catalog line, for a screen in its reader's language.
  return { canAct, reason: canAct ? null : TIME_REFUSALS['own-entry'], reasonKey: canAct ? null : TIME_REFUSAL_KEYS['own-entry'] };
}

// The { entryId, version } items a bulk-approve should send for `rows`: every punch the user may
// act on (a non-owner's own punch is skipped), each carrying the row_version the manager saw so
// the server's CAS can leave a since-changed row for the manager to re-check. A version of 0 is
// a real version, so it is preserved (never coerced to null by a falsy test).
export function approvableItems(rows = [], user = null) {
  return (rows || [])
    .filter((r) => canActOnPunch(user, r))
    .map((r) => ({ entryId: r.id, version: Number.isInteger(r.row_version) ? r.row_version : null }));
}

// ── HOURS APPROVAL BY PERSON (the manager view redesign, 2026-10-09; plan S4–S6) ────────
// Matt's rule is unchanged: EVERY clock-in and clock-out is approved before payroll (S106). The
// To approve tab only GROUPS the pending punches by the person who worked them, so a manager
// approves a timesheet in one tap; each approval is still the per-punch approveEntries call.

// The most items one POST /api/time/approve takes. The route refuses above THIS constant
// (api/time/[...path].js), so the screen's batches and the server's cap are one number.
export const APPROVE_BATCH_MAX = 200;

// `items` cut into batches the approve route accepts, in order.
export function chunkApproveItems(items = [], size = APPROVE_BATCH_MAX) {
  const list = Array.isArray(items) ? items : [];
  const n = Number.isInteger(size) && size > 0 ? size : APPROVE_BATCH_MAX;
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

const workedOf = (r) => { const n = Number(r?.duration_minutes); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
// The approvals read's own overtime for this punch (the shared otLedger walk, `ot_minutes`).
// Never a 40-hour rule of the screen's: the ledger already walked the week, company-wide.
const otOf = (r) => { const n = Number(r?.ot_minutes); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };

// The pending punches (snake_case rows from timeApi.approvals) as one entry per PERSON:
//   { userId, userName, rows (oldest first), punches, workedMinutes, regMinutes, otMinutes,
//     places: [{ id, name }] (each building once, in first-seen order),
//     flags: the distinct punchFlagMessages across their punches (each once),
//     flaggedPunches, flagged (any punch carries a flag → the row offers Review, plan S5),
//     items: approvableItems(rows, user) (what THIS viewer may approve), actionable }.
// Ordered by name, then id, so the list does not reshuffle as rows are approved.
export function pendingByPerson(rows = [], user = null) {
  const byUser = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const key = String(r.user_id ?? '');
    let p = byUser.get(key);
    if (!p) { p = { userId: r.user_id ?? null, userName: r.user_name || '', rows: [] }; byUser.set(key, p); }
    if (!p.userName && r.user_name) p.userName = r.user_name;
    p.rows.push(r);
  }
  const people = [];
  for (const p of byUser.values()) {
    const list = p.rows.slice().sort((a, b) => String(a.clock_in_at || '').localeCompare(String(b.clock_in_at || '')) || String(a.id).localeCompare(String(b.id)));
    let worked = 0; let ot = 0; let flaggedPunches = 0;
    const places = new Map();
    const flags = new Map(); // english → message
    for (const r of list) {
      worked += workedOf(r);
      ot += otOf(r);
      const placeId = r.client_id || r.site_id || '';
      if (!places.has(placeId)) places.set(placeId, { id: placeId || null, name: r.client_name || r.site_name || '' });
      const msgs = punchFlagMessages(r);
      if (msgs.length) flaggedPunches += 1;
      for (const m of msgs) { const en = english(m); if (!flags.has(en)) flags.set(en, m); }
    }
    const items = approvableItems(list, user);
    people.push({
      userId: p.userId, userName: p.userName, rows: list, punches: list.length,
      workedMinutes: worked, otMinutes: ot, regMinutes: worked - ot,
      places: [...places.values()], flags: [...flags.values()],
      flaggedPunches, flagged: flaggedPunches > 0,
      items, actionable: items.length > 0,
    });
  }
  return people.sort((a, b) => (a.userName || '').localeCompare(b.userName || '') || String(a.userId).localeCompare(String(b.userId)));
}

// "Approve all" (plan S6): every punch of every person with NO flag that this viewer may
// approve — and nothing of a flagged person, not even their clean punches, because their
// timesheet is one thing to look at. `skipped` is how many people need a look (flagged and
// actionable), so the screen can say "Approved 11 · 3 need a look". A person this viewer
// cannot act on at all (a non-owner's own time) is neither sent nor counted.
export function approveAllPlan(people = []) {
  const list = Array.isArray(people) ? people : [];
  const send = list.filter((p) => p && !p.flagged && p.actionable);
  return {
    people: send,
    items: send.flatMap((p) => p.items),
    skipped: list.filter((p) => p && p.flagged && p.actionable).length,
  };
}

// The day the pending hours are due (plan S4: the board's "due Fri" is the PAY PERIOD's last
// day, from the stored pay settings — Matt's PAY-2 semi-monthly answer, so the 15th or the
// month's end). The period is the one holding the OLDEST pending punch: that punch has to be
// approved before its own period is paid, so a backlog from last period reads last period's
// end. With nothing pending, the current period. Reads the settings exactly as the pay run
// does (an unset cadence is biweekly; the workweek starts on Sunday unless set) and asks
// lib/payroll's payPeriodRange for the calendar — never a second one.
export function pendingDueKey({ rows = [], opsSettings = null, now = new Date(), tz } = {}) {
  const o = opsSettings || {};
  const cadence = o.payPeriodCadence === 'weekly' || o.payPeriodCadence === 'semimonthly' ? o.payPeriodCadence : 'biweekly';
  const weekStartDay = payWeekStartDayOf(o);
  let oldest = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    const t = Date.parse(r?.clock_in_at ?? '');
    if (Number.isFinite(t) && (oldest == null || t < oldest)) oldest = t;
  }
  return payPeriodRange(cadence, 0, oldest == null ? now : new Date(oldest), tz, weekStartDay).toKey;
}

// The OT hours a "incl. Xh OT" / overtime label shows for `minutes`: hours to one decimal,
// trailing ".0" dropped (90 → "1.5", 120 → "2", 52 → "0.9").
export function otHoursLabel(minutes) {
  const h = Math.round(((Number(minutes) || 0) / 60) * 10) / 10;
  return Number.isInteger(h) ? String(h) : String(h);
}

// The badge flags for a pending punch row (snake_case time_entries row + `ot_minutes`). Order is
// most-operational first. MESSAGES (CS-193) so the queue shows them in its reader's language;
// punchFlags below is the same set in English (what tests and anything comparing words read).
export function punchFlags(e) {
  return punchFlagMessages(e).map((m) => english(m));
}
export function punchFlagMessages(e) {
  const flags = [];
  if (!e) return flags;
  // 🔴 PAY-12 + PAY-17: BOTH ENDS of the punch, each with HOW FAR. PAY-12 (Matt, 2026-09-29)
  // made the clock-OUT geofenced server-side too — "all clock-ins and clock-outs need to be
  // recorded at the actual site" — and PAY-17 (2026-09-30) made an off-site punch something
  // the approver has to RULE ON rather than something the cleaner was refused: the punch is
  // pending, the supervisor was alerted at the moment it happened, and this queue is where it
  // is settled. The distance rides the chip because "off-site" alone cannot be judged — forty
  // feet past the ring and half a mile away are not the same fact.
  //
  // The chips' words live beside the fields they read (lib/clockRules `offSiteChip`), so the
  // writer and the reader are one definition; an ON-SITE end and an un-geocoded location say
  // nothing, or every punch in the book would wear a chip (CS-036).
  const geoIn = offSiteChipMessage(e, 'in');
  if (geoIn) flags.push(geoIn);
  const geoOut = offSiteChipMessage(e, 'out');
  if (geoOut) flags.push(geoOut);
  // Whether the clock-IN end was an override by CONFIG, for the "don't say Manual twice" rule
  // below (a manual entry always records geofence_result 'override' + reason 'manual_entry').
  const geoReason = e.geofence_result === 'override'
    ? (GEOFENCE_REASON_KEYS[e.override_reason] || 'punch.flag.override') : null;
  if (e.source === 'offline_replay') flags.push(msg('punch.flag.offline'));
  // 🔴 THE CHECKLIST FLAG (W5-M F4). A replayed clock-out with the cleaner's checklist
  // unfinished is accepted and flagged so that "it shows at approval" (checklists plan R4).
  // This queue IS approval, and it showed nothing but "Edited" — the flag was written on
  // every such replay and read by nobody. Same module as the words the server writes.
  const checklist = checklistFlagChipMessage(e);
  if (checklist) flags.push(checklist);
  // 🔴 PAY-13 / CS-318. A punch opened while the cleaner was still on the clock somewhere
  // else. A LIVE one is refused outright, so this only ever marks the two shapes that are
  // ACCEPTED: an offline replay (never refused — THE LAW II.8) and a manager's override.
  // Both reach payroll, so the approver has to see them. Same read-it-where-it-is-written
  // pattern as the checklist flag.
  const overlap = overlapFlagChipMessage(e);
  if (overlap) flags.push(overlap);
  // PAY-10 (Matt, 2026-09-29): a shift the auto-close cron closed at its SCHEDULED end says
  // so here, because the approver's job on that row is to confirm the cleaner really was on
  // site until then. autoCloseStale writes `status: 'auto_closed'` and an edit_history line.
  // CS-667: a cleaner who clocked in AFTER the scheduled end was closed on their own clock-in
  // (lib/autoClose) — a different question for the approver, so it says so.
  if (e.status === 'auto_closed') flags.push(msg(lateStartAutoCloseOf(e) ? 'punch.flag.autoClosedLate' : 'punch.flag.autoClosed'));
  // A manual entry always records geofence_result 'override' with reason 'manual_entry', so
  // the chip above already says it; don't say it twice.
  if ((e.source === 'admin_manual' || e.status === 'manual') && geoReason !== GEOFENCE_REASON_KEYS.manual_entry) flags.push(msg('punch.flag.manual'));
  if (e.edited) flags.push(msg('punch.flag.edited'));
  if (e.job_cancelled_at) flags.push(msg('punch.flag.cleanCancelled'));
  const ot = Number(e.ot_minutes) || 0;
  if (ot > 0) flags.push(msg('punch.flag.ot', { hours: otHoursLabel(ot) }));
  return flags;
}

// ── PAY-15: each manager's own still-unapproved punches from the day before ─────
// Matt, 2026-09-29 (PAY-15 note): "would like the unapproved payroll to be flagged so the
// account manager can see it in case they missed approving someone's clock-in and clock-out
// yesterday." A morning digest, one per manager, about THEIR OWN customers — an org-wide
// count tells the person who has to act nothing.
//
// PURE, so the daily cron (api/time watchdog) and any screen that wants the same figure read
// one rule. Inputs: the pending punch rows for the window (snake_case, as
// store.listPendingApprovalsAll returns them) and the customers slice, whose `supervisorId`
// IS the manager of record (the same field timeScopeFor reads).
//
// A punch at a customer with NO supervisor belongs to nobody in particular, so it is returned
// under `unassigned` rather than dropped — otherwise the one case where nobody is watching
// would be the one case nobody is told about.
export function pendingByManager(rows = [], clients = []) {
  const supervisorOf = new Map();
  for (const c of Array.isArray(clients) ? clients : []) {
    if (c && c.id) supervisorOf.set(c.id, (typeof c.supervisorId === 'string' && c.supervisorId) ? c.supervisorId : null);
  }
  const byManager = new Map();   // managerId -> { managerId, count, cleanerIds:Set, clientIds:Set }
  const unassigned = { count: 0, cleanerIds: new Set(), clientIds: new Set() };
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    const clientId = r.client_id ?? r.clientId ?? null;
    const managerId = clientId ? (supervisorOf.get(clientId) || null) : null;
    const bucket = managerId
      ? (byManager.get(managerId) || (byManager.set(managerId, { managerId, count: 0, cleanerIds: new Set(), clientIds: new Set() }), byManager.get(managerId)))
      : unassigned;
    bucket.count += 1;
    const userId = r.user_id ?? r.userId ?? null;
    if (userId) bucket.cleanerIds.add(userId);
    if (clientId) bucket.clientIds.add(clientId);
  }
  return {
    managers: [...byManager.values()].sort((a, b) => b.count - a.count || String(a.managerId).localeCompare(String(b.managerId))),
    unassigned,
  };
}

// The sentence a manager's morning digest carries. Counted in PUNCHES and PEOPLE, because
// "4 punches" and "4 cleaners" are different amounts of work. In the MANAGER's language
// (`lang`, CS-193 — the cron passes theirs; English when omitted), from the catalog.
export function unapprovedDigestBody({ count, cleaners, dayLabel }, lang = 'en') {
  return translate(lang, 'alerts.unapproved.body', {
    punches: msg('alerts.unapproved.punches', { count }),
    people: msg('alerts.unapproved.cleaners', { count: cleaners }),
    day: dayLabel,
  });
}
export const unapprovedDigestTitle = (lang = 'en') => translate(lang, 'alerts.unapproved.title');
export const UNAPPROVED_DIGEST_TITLE = unapprovedDigestTitle('en');
