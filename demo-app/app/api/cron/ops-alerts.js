// GET /api/cron/ops-alerts — server-side OPERATIONAL-ALERT engine (#2/#3) plus the
// OVERDUE-INVOICE sweep (CS-288), both running WITHOUT a browser tab. Driven by a Vercel
// Cron (see vercel.json). Mirrors
// /api/reminders/run: read org_state + the relational tables the pure walkers need
// (jobs from public.jobs, punches, QC), compute what is due, then record the
// notification rows + dedup markers into org_state in a CAS-retry loop.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The detection walkers (lib/opsAlerts) also run in the client tick
// (components/OpsAlertScheduler), but that only fires while a staff tab is open —
// a shift missed at 2am produced no alert until someone opened the app. This cron
// is the tab-independent path, so late/missed/checklist/inspection alerts reach the
// supervisor even with nobody logged in (the every-minute push-dispatch cron then
// delivers the row to their phone). The client tick STAYS mounted as the fast path
// when a tab is open; the shared dedup marker (opsAlertEvents) makes the two safe to
// run together and idempotent — an alert raised by either path is a no-op for the other.
//
// The apply logic (dedup + marker retention + routing) and the bell copy are the
// SAME pure modules the reducer uses (lib/opsAlertApply, lib/opsAlertCopy), so the
// client and the cron cannot drift.
//
// ?dryRun=1 returns what WOULD raise without writing — safe against prod.

import {
  getDueShiftAlerts, getDueChecklistReminders, getDueInspectionReminders, getDueSupplyAlerts,
  opsAlertReadWindows, shiftLookbackHours, liveChecklistIdsFrom,
} from '../../src/lib/opsAlerts.js';
import { isActiveBuilding } from '../../src/lib/customerStatus.js';
import { getDueTicketAlerts, ticketAlertLookbackDays } from '../../src/lib/ticketAlerts.js';
import { getDuePreShiftReminders } from '../../src/lib/preShiftReminders.js';
import {
  getDueContractAlerts, CONTRACT_ALERT_KIND, contractAlertLogSummary,
  applyRenewalOpportunities, silencedContractReminders,
} from '../../src/lib/contractReminders.js';
import { CONTRACT_REMINDER_MAX_PER_RUN } from '../../src/lib/contracts.js';
import {
  getDueWarningReminders, HR_WARNING_SIGN_EVENT, HR_WARNING_UNSIGNED_EVENT, HR_WARNING_REMINDER_MAX_PER_RUN,
} from '../../src/lib/hrWarningReminders.js';
import { WARNING_REMINDER_HOURS } from '../../src/lib/hrWarnings.js';
import { dueUnsignedWarnings, markWarningsReminded } from '../_lib/hrWarnings/store.js';
import { runTerminationAccess } from '../_lib/hrTerminations/access.js';
import { dayKey, startOfDayKey, startOfMonthKey } from '../../src/lib/dates.js';
import { requestsForSupplyAlerts } from '../_lib/supplies/store.js';
import {
  dueReminders as dueContractReminders, contractSubjects,
  markRemindersNotified, regenerateReminders,
} from '../_lib/contracts/store.js';
import { opsAlertCopy } from '../../src/lib/opsAlertCopy.js';
// The alert words are MESSAGES (CS-193): the fan-out renders each bell row in its recipient's
// language; the push-only reminder and the activity log are rendered here — the reminder in
// its cleaner's language, the log in English (the log stays English).
import { renderText, userLanguage } from '../_lib/i18n.js';
import { applyOpsAlert } from '../../src/lib/opsAlertApply.js';
import { newlyOverdueInvoices, markInvoicesOverdue } from '../../src/lib/invoiceSweep.js';
import { readOrgState, writeOrgState } from '../_lib/orgState.js';
import { getJobsInWindow } from '../_lib/jobsTable.js';
import { coveredJobIdsInWindow } from '../_lib/time/store.js';
import {
  listChecklistsInWindow, CHECKLIST_WINDOW_COLUMNS, latestInspectionPerClient, listTemplateIds,
  openTicketsForAlerts, firstStaffReplyByProblem,
} from '../_lib/qc/store.js';
import { dispatchDue } from '../_lib/push/dispatch.js';
import { pushConfigured, sendToUser } from '../_lib/push/store.js';
import { logActivities } from '../_lib/activityLog.js';
import { reportError } from '../_lib/monitor.js';
import { refuseUnconfiguredCron } from '../_lib/cronGate.js';
// CS-851 / CS-850: the build's Spanish and Creole are filled here, before the alerts — at most once
// per build (a single read of the build's fill row after that). _lib/translateFill.js.
import { fillTranslations } from '../_lib/translateFill.js';
// Task #468: the quiet-cleaner alert — the walker, the activity reads and a cleaner's cleans.
import {
  inCrewQuietWindow, crewQuietCandidates, couldBeQuiet, dueQuietCrew, crewQuietAlerts,
  CREW_QUIET_DAYS, CREW_QUIET_LOOKBACK_DAYS, CREW_QUIET_BUILDING_DAYS, CREW_QUIET_BELL_KINDS,
} from '../../src/lib/crewQuietAlerts.js';
import { crewScopeFromJobs } from '../../src/lib/crewScope.js';
import { lastSeenByUser, lastPunchByUser } from '../_lib/crewActivity.js';
import { getCrewJobRows } from '../_lib/jobsTable.js';
// Task #507: the special-service reminder — pure on the shared record this run already holds.
import { getDueSpecialServiceAlerts } from '../../src/lib/specialServiceReminders.js';

const CAS_RETRIES = 5;

// The complete reads can page a busy day's punches plus, when an active account has no
// recent inspection, up to a year of inspection records newest-first — headroom past
// the platform default so a heavy run finishes instead of timing out half-way.
export const config = { maxDuration: 60 };

// Gather what is due. Returns an array of walker alert records, or null when
// coverage cannot be confirmed (time-entry fetch failed) — in which case we bail
// rather than risk false late/missed alerts (same stance as the client tick).
async function computeDue(state, now) {
  const settings = state.opsSettings || {};
  const lookbackH = shiftLookbackHours(settings);

  // Jobs live in public.jobs; state.jobs is written empty by every client save, so
  // inject the near-term window the walkers need (same reason as reminders/run).
  const jobs = await getJobsInWindow({ backDays: Math.ceil(lookbackH / 24) + 1, forwardDays: 1 });
  const firedIds = new Set((state.opsAlertEvents || []).map((e) => e.id));

  // Coverage: a job with any real (non-voided, non-no-show) clock-in is not late/missed.
  // COMPLETE over the window (it used to read the newest 2000 punches — at full volume a
  // busy day's earlier punches fell off and their cleans fired false late/missed alerts).
  // A failed or incomplete read bails rather than fire on partial data.
  const windows = opsAlertReadWindows(settings, now);
  let coveredJobIds;
  try {
    coveredJobIds = new Set(await coveredJobIdsInWindow(windows.coverage));
  } catch {
    return null; // cannot confirm coverage -> do not fire
  }

  const alerts = getDueShiftAlerts({ jobs, coveredJobIds, firedIds, now, settings });

  // #3 reminders need QC records: every checklist in the walker's window, and each
  // active account's latest submitted inspection. The reads fail apart — a failed
  // checklist read must not also silence inspection reminders, or the reverse. A failed
  // read skips only its own reminders this run (a detector run on empty or partial data
  // would treat logged checklists as unlogged, or lapsed accounts as never inspected).
  // The live checklist TEMPLATE ids ride the same fail-apart read: a cleaner bound to a
  // checklist that no longer exists must not be reminded (CS-353), but a template read
  // that FAILED must not silence anyone either — so it is passed only when it resolved.
  // The buildings we clean now (CS-683: Inactive and Archived out — the same rule the walker
  // applies), so the read stops once each of THEM is seen.
  const clientIds = (state.clients || []).filter(isActiveBuilding).map((c) => c.id);
  const [checklists, inspections, templates] = await Promise.allSettled([
    listChecklistsInWindow(windows.checklists, { columns: CHECKLIST_WINDOW_COLUMNS }),
    clientIds.length
      ? latestInspectionPerClient({ clientIds, sinceIso: windows.inspectionsSinceIso, untilIso: new Date(now).toISOString() })
      : [],
    listTemplateIds({ kind: 'checklist' }),   // a COMPLETE, narrow, ids-only read
  ]);
  if (checklists.status === 'fulfilled') {
    const clientsById = new Map((state.clients || []).map((c) => [c.id, c]));
    // null for a failed OR misshaped template read — the walker then skips nobody.
    const liveChecklistIds = liveChecklistIdsFrom(templates.status === 'fulfilled' ? templates.value : null);
    // Only ACTIVE roster members are judged: a deactivated cleaner left on a clean's
    // crewIds can receive nothing, and must not be named in the escalation.
    const activeUserIds = new Set((state.users || []).filter((u) => u && u.status === 'active').map((u) => u.id));
    alerts.push(...getDueChecklistReminders({ jobs, clientsById, checklists: checklists.value || [], firedIds, now, settings, liveChecklistIds, activeUserIds }));
  }
  if (inspections.status === 'fulfilled') {
    alerts.push(...getDueInspectionReminders({ clients: state.clients || [], inspections: inspections.value || [], firedIds, now, settings }));
  }

  // 🔴 ALR-5: the cleaners' PRE-SHIFT reminders. Same jobs read, same covered set (someone who
  // clocked in early needs no reminder), and only ACTIVE roster members. Push-only — the walker
  // marks each alert `pushOnly`, so applyOpsAlert records the marker and writes no bell row.
  const activeUserIds = new Set((state.users || []).filter((u) => u && u.status === 'active').map((u) => u.id));
  alerts.push(...getDuePreShiftReminders({ jobs, firedIds, activeUserIds, coveredJobIds, now, settings }));

  // 🔴 WO-2..7 + WO-16: the TICKET repeats and escalations. Its own fail-apart read pair — a
  // failed problem_reports read must not also silence the shift alerts above, and a failed
  // MESSAGE read must not make every answered ticket look unanswered, which would chase the
  // office every 10 minutes about tickets they had already replied to. So the replies read is
  // REQUIRED: without it the walker does not run at all this tick.
  try {
    const sinceIso = new Date(now - ticketAlertLookbackDays(settings) * 24 * 3600 * 1000).toISOString();
    const tickets = await openTicketsForAlerts({ sinceIso });
    if (tickets.length) {
      const repliedAt = await firstStaffReplyByProblem(tickets.map((t) => t.id));
      alerts.push(...getDueTicketAlerts({
        tickets, repliedAt, firedIds, now, settings, timeZone: state.company?.timezone || null,
        clients: state.clients || [],   // an archived customer's tickets are chased no more (CS-663)
      }));
    }
  } catch { /* ticket alerts skip this run; every other alert above still fires */ }

  // SUP-8 / CS-380 + SUP-7 / SUP-10 — the monthly supply-order reminder and the over-budget
  // alert. NO new cron entry; the monthly marker (lib/opsAlertApply) makes a day-granularity
  // reminder fire once even though this cron runs every five minutes. The walker stays PURE
  // (lib/opsAlerts getDueSupplyAlerts); since SUP-13 its requests come from the supply table
  // rather than org_state — every request CREATED or DELIVERED this calendar month, a complete
  // read (api/_lib/supplies/store requestsForSupplyAlerts). Its own try/catch, like the ticket
  // walker's: a failed read must not also silence the shift alerts above — and it skips the
  // supply alerts rather than walking an EMPTY list, which would chase every building for an
  // order it already placed.
  //
  // The zone is passed EXPLICITLY: calendar months here are the ORG's (II.8) and this process
  // never calls setOrgTimezone, so lib/dates would otherwise answer in its own default.
  try {
    alerts.push(...await supplyAlertsFor(state, now, firedIds));
  } catch { /* supply reminders skip this run; every other alert above still fires */ }

  // 🔴 CON-6..CON-9 / CS-194 — the CONTRACT reminders, a fifth walker on this same run and
  // NO new cron entry. Its read is the cheap early exit by construction: ONE probe of the
  // partial index on `contract_reminders` ("not rung, not done, due on or before today"),
  // which returns no rows on almost every tick because the schedule is materialized at save
  // time rather than walked here. Only when something IS due does it make the second, narrow
  // read for the contracts' names and buildings.
  //
  // Its own try/catch, like the ticket walker's: a contracts table that is not there yet (the
  // migration lands with the orchestrator, after this code) or a failed read must not also
  // silence the shift alerts above.
  try {
    alerts.push(...await contractAlertsFor(state, now, firedIds));
  } catch { /* contract reminders skip this run; every other alert above still fires */ }

  // 🔴 HR-5 (Matt, 2026-10-05) — the UNSIGNED-WARNING reminder, a sixth walker on this same
  // run and NO new cron entry. One probe of the partial index on `hr_warnings` ("awaiting a
  // signature, never reminded, issued a day ago or more"), which returns nothing on almost
  // every tick. Its own try/catch for the same reason as the contract walker: a table that is
  // not there yet (the migration lands with the orchestrator) must not silence the rest.
  try {
    alerts.push(...await hrWarningAlertsFor(state, now, firedIds));
  } catch { /* warning reminders skip this run; every other alert above still fires */ }

  // 🔴 Task #468 — the QUIET-CLEANER alert, a seventh walker on this same run and NO new cron
  // entry. It looks once a morning (the first half hour of office hours), so its reads run a
  // handful of times a day; every other tick it returns before reading anything. Its own
  // try/catch: a failed or short read skips it this tick (the next tick in the window tries
  // again) rather than judge anyone on partial data, and never silences the alerts above.
  try {
    alerts.push(...await crewQuietAlertsFor(state, now));
  } catch { /* the quiet-cleaner alert skips this tick; every other alert above still fires */ }

  // 🔴 Task #507 — the SPECIAL-SERVICE reminder, an eighth walker on this same run and NO new cron
  // entry. It reads nothing: the services live on the customers in the shared record above, so the
  // walk is in memory, gated on office hours, and its ids (building, service, date) make it once
  // per date. Its own try/catch, so a damaged record can't silence the alerts above.
  try {
    alerts.push(...getDueSpecialServiceAlerts({ state, firedIds, now, settings: state.opsSettings || {} }));
  } catch { /* the special-service reminders skip this tick; every other alert above still fires */ }

  return alerts;
}

const DAY_MS = 24 * 3600 * 1000;
// One cleaner's cleans read at a time per worker: a morning naming many (a month after a big
// team import) stays inside the run's 60 seconds without a burst of reads.
const CREW_QUIET_READS_AT_ONCE = 5;

// The quiet-cleaner half of the walk, on its own (and its reads injectable) so the offline suite
// drives THIS read + walker through the real orchestration (test-crew-quiet-alerts.mjs).
//   1. who could be due without reading anything (crew with access, not added inside the 30
//      days, not on or just back from time off);
//   2. their heartbeats over the 60 days the table keeps; anyone seen inside 29 days is not
//      due, so only the rest have their clock-ins read;
//   3. the walker's due list (once per quiet stretch, against the `crewQuiet` markers);
//   4. for each cleaner due, the buildings on their cleans from 30 days back to 30 ahead, whose
//      account managers hear about them beside the Admins and Super Admins.
export async function crewQuietAlertsFor(state, now, {
  readLastSeen = lastSeenByUser,
  readLastPunch = lastPunchByUser,
  readCrewJobs = getCrewJobRows,
} = {}) {
  const settings = state.opsSettings || {};
  const tz = state.company?.timezone || null;
  if (!inCrewQuietWindow(now, settings, tz)) return [];
  const timeOff = state.timeOff || [];
  const candidates = crewQuietCandidates(state).filter((u) => couldBeQuiet(u, { timeOff, now, tz }));
  if (!candidates.length) return [];

  const sinceIso = new Date(now - CREW_QUIET_LOOKBACK_DAYS * DAY_MS).toISOString();
  const seen = await readLastSeen(candidates.map((u) => u.id), { sinceIso });
  const surelyActive = now - (CREW_QUIET_DAYS - 1) * DAY_MS;
  const unseen = candidates.filter((u) => !(Date.parse(seen.get(u.id) || '') >= surelyActive)).map((u) => u.id);
  if (!unseen.length) return [];
  const punches = await readLastPunch(unseen, { sinceIso });
  const activity = new Map(candidates.map((u) => [u.id, {
    lastSeenAt: seen.get(u.id) || null,
    lastPunchAt: punches.get(u.id) || null,
  }]));

  const due = dueQuietCrew({ state, activity, now, tz });
  if (!due.length) return [];

  const window = {
    fromIso: new Date(now - CREW_QUIET_BUILDING_DAYS * DAY_MS).toISOString(),
    toIso: new Date(now + CREW_QUIET_BUILDING_DAYS * DAY_MS).toISOString(),
  };
  const buildingsByUser = new Map();
  for (let i = 0; i < due.length; i += CREW_QUIET_READS_AT_ONCE) {
    await Promise.all(due.slice(i, i + CREW_QUIET_READS_AT_ONCE).map(async ({ user }) => {
      const rows = await readCrewJobs(user.id, window);
      const { clientIds } = crewScopeFromJobs({ jobs: (rows || []).map((r) => r.data), sites: state.sites || [], userId: user.id });
      buildingsByUser.set(user.id, [...clientIds]);
    }));
  }
  return crewQuietAlerts({ state, due, buildingsByUser, now, tz });
}

// The warning half of the walk, on its own so the offline suite can drive THIS read + walker
// through the real orchestration (test-hr-warnings-route.mjs).
export async function hrWarningAlertsFor(state, now, firedIds = new Set()) {
  const rows = await dueUnsignedWarnings({ now, hours: WARNING_REMINDER_HOURS, limit: HR_WARNING_REMINDER_MAX_PER_RUN });
  if (!rows.length) return [];
  return getDueWarningReminders({ warnings: rows, state, firedIds, now, settings: state.opsSettings || {} });
}

// The two warning-reminder kinds. Their bell rows are NOT copied into the activity log: the
// log is read by admins, and who was disciplined is HR (the warning row is its own audit).
const HR_WARNING_KINDS = new Set([HR_WARNING_SIGN_EVENT, HR_WARNING_UNSIGNED_EVENT]);

// The supply half of the walk, on its own so the offline suite can drive THIS read + walker
// through the real orchestration (test-supplies-route.mjs).
export async function supplyAlertsFor(state, now, firedIds = new Set()) {
  const tz = state.company?.timezone || null;
  const monthStart = startOfMonthKey(dayKey(now, tz));
  const requests = await requestsForSupplyAlerts({ fromIso: startOfDayKey(monthStart, tz).toISOString() });
  // CS-953: when each marker was raised, so the office's "still not submitted" waits for the day
  // after the supervisor's reminder actually went out, not the day after the order day.
  const firedAt = new Map((state.opsAlertEvents || []).filter((e) => e && e.id).map((e) => [e.id, e.firedAt || null]));
  return getDueSupplyAlerts({
    clients: state.clients || [], requests, firedIds, firedAt, now, settings: state.opsSettings || {}, tz: tz || undefined,
  });
}

// The contract half of the walk, on its own so the offline suite can drive THIS read + walker
// through the real orchestration without also needing the jobs, punch and QC tables the other
// four walkers read (test-contracts-route.mjs).
export async function contractAlertsFor(state, now, firedIds = new Set()) {
  const today = dayKey(now, state.company?.timezone || null);
  // CS-663: a due reminder of a contract whose every building is archived rings nobody but stays
  // due, so it holds a place at the front of this bounded read. When the read is full and some of
  // it is silenced, read that much further (the store clamps the limit), so a live reminder behind
  // them still rings. Read-only, so a dry run stays a dry run.
  let limit = CONTRACT_REMINDER_MAX_PER_RUN;
  let rows = [];
  let subjects = [];
  for (;;) {
    rows = await dueContractReminders({ today, limit });
    if (!rows.length) return [];
    subjects = await contractSubjects([...new Set(rows.map((r) => r.contractId))]);
    const silenced = silencedContractReminders({ reminders: rows, subjects, state, now }).length;
    if (!silenced || rows.length - silenced >= CONTRACT_REMINDER_MAX_PER_RUN || rows.length < limit) break;
    limit += silenced;
  }
  return getDueContractAlerts({
    reminders: rows, subjects, state, firedIds, now, settings: state.opsSettings || {},
  });
}

// Turn a walker alert record into the { id, kind, recipientScope, ...copy } shape
// applyOpsAlert consumes, resolving the account name for the bell copy.
function toAlert(state, al) {
  // No name → null, and opsAlertCopy says "a customer" in the reader's own language.
  const name = (state.clients || []).find((c) => c.id === al.clientId)?.name || null;
  // The checklist escalation names the cleaners still missing; the record carries ids
  // only (checklist_results has no name column, CS-403), so resolve them off the roster.
  const userName = (id) => (state.users || []).find((u) => u.id === id)?.name || null;
  // A walker that composed its OWN sentence keeps it (lib/contractReminders): opsAlertCopy's
  // vocabulary is the shift / checklist / inspection one, and a contract reminder's line
  // names a DATE, not a clean. Everything else still goes through the shared copy module, so
  // the client tick and this cron cannot drift on the alerts they both raise.
  const { title, body, url } = al.title
    ? { title: al.title, body: al.body || '', url: al.url || '/' }
    : opsAlertCopy(al, name, { userName });
  return {
    id: al.id, kind: al.kind, recipientScope: al.recipientScope,
    clientId: al.clientId || null, jobId: al.jobId || null, crewIds: al.crewIds || [],
    // CON-9: a master contract's reminder names its own recipients (every covered building's
    // supervisor plus the owners), so they ride through to applyOpsAlert's `users` scope.
    ...(al.userIds ? { userIds: al.userIds } : {}),
    // The reminder row this alert came from, so the run can stamp it once the bell is durable
    // — plus what CON-10's Renewals card is built from (the date it is about, the buildings
    // it covers and what to call it), so the card needs no second read of its own.
    ...(al.reminderId ? {
      reminderId: al.reminderId,
      reminderKind: al.reminderKind,
      contractId: al.contractId,
      reminderTargetDate: al.reminderTargetDate,
      clientIds: al.clientIds || [],
      cardTitle: al.cardTitle || null,
    } : {}),
    // A ticket alert's event key comes from the ticket's PRIORITY, not its kind (only the event
    // key reaches the push dispatcher, and only it can say "urgent"); `refId` is the ticket, so
    // marker retention keeps one row per ticket; `pushOnly` sends ALR-5's reminder with no bell
    // row. Each is omitted when the walker did not set it, so an existing alert's shape is
    // byte-identical to before. A ticket alert's `origin` (HUB-21, CS-639) lets applyOpsAlert send a
    // customer's request where its first alert went: with no manager, the Admins.
    ...(al.eventKey ? { eventKey: al.eventKey } : {}),
    ...(al.refId ? { refId: al.refId } : {}),
    ...(al.origin ? { origin: al.origin } : {}),
    ...(al.pushOnly ? { pushOnly: true, userId: al.userId || null } : {}),
    // Task #468: the quiet cleaner's memory — a marker, no bell row and no push.
    ...(al.markerOnly ? { markerOnly: true } : {}),
    // HR-5: the warning a reminder is about, so the run can stamp it once the bell is durable.
    ...(al.warningId ? { warningId: al.warningId } : {}),
    title, body, url,
  };
}

// Deliver the alerts just recorded RIGHT NOW instead of waiting up to a minute for the
// every-minute /api/push/dispatch cron. Uses the SAME shared reserve-then-send core
// (_lib/push/dispatch.dispatchDue) that both that cron and /api/push/flush use; because
// it CAS-claims each row before sending, the two paths can never double-send. A push
// failure must NOT fail the alert run: the rows are already durable in org_state and the
// minute cron will catch up, so it is logged through the monitor and the outcome is
// returned for the response, never thrown.
async function flushPush({ dispatch, pushReady, report }) {
  if (!pushReady()) return { skipped: 'vapid_unconfigured' };
  try {
    return await dispatch();
  } catch (err) {
    report('ops-alerts.push-flush', err);
    return { error: err && err.message ? err.message : 'push dispatch failed' };
  }
}

// 🔴 ALR-5: deliver the PUSH-ONLY reminders. They have no bell row, so the reserve-then-send
// core above has nothing to find — the marker written in the CAS loop IS the claim, which is
// what makes this idempotent across a re-run. One banner per cleaner per shift, straight to
// their devices; a cleaner with no subscribed device simply gets nothing, and a failure never
// fails the run (the marker is already durable, and re-sending a "your shift starts in 30
// minutes" banner late would be worse than not sending it).
async function sendPushOnly(alerts, { pushToUser, pushReady, report, state }) {
  if (!alerts.length) return { pushOnly: 0 };
  if (!pushReady()) return { pushOnly: 0, skipped: 'vapid_unconfigured' };
  let delivered = 0;
  const tz = state?.company?.timezone || undefined;
  for (const a of alerts) {
    if (!a.userId) continue;
    // The banner's words, in THIS cleaner's language (LANG-4), times in the org's zone.
    const lang = userLanguage((state?.users || []).find((u) => u.id === a.userId));
    try {
      const r = await pushToUser(a.userId, {
        title: renderText(a.title, lang, tz), body: renderText(a.body || '', lang, tz), url: a.url || '/', tag: a.id,
      });
      delivered += r?.delivered || 0;
    } catch (err) {
      report('ops-alerts.pre-shift-push', err);
    }
  }
  return { pushOnly: delivered };
}

// Exported + dependency-injected so the offline suite can drive the raise→dispatch
// orchestration with no Supabase and no VAPID (test-ops-alerts-cron.mjs). Production
// calls run(dryRun) with every default, so behaviour is unchanged but for the instant
// push flush after a raise.
// ── CS-379 / LOG-7: the automatic actions go in the activity log ──────────────
// Matt: "Log automatic actions too, like alerts sent and escalations? — Yes." A CHECKLIST
// reminder that went to the SUPERVISOR is the escalation in this engine (the cleaner was
// reminded first, at crew scope — lib/opsAlerts getDueChecklistReminders); everything else is
// an alert sent. Rows carry no actor (auto = true), so nobody is blamed for a cron.
const autoAlertAction = (al) =>
  (al.kind === 'checklistDue' && al.recipientScope === 'supervisor' ? 'alert.escalated' : 'alert.sent');

function alertActivityRows(alerts, tz) {
  // The log is ENGLISH whoever the alert went to: render the bell's messages in English.
  const en = (x) => renderText(x, 'en', tz || undefined);
  return alerts.map((al) => ({
    action: autoAlertAction(al),
    auto: true,
    entityId: al.id || null,
    clientId: al.clientId || null,
    // A contract reminder says WHICH date it was about; everything else keeps the bell's
    // own words. Neither carries a timestamp — see the activity-log card's landmine.
    summary: al.kind === CONTRACT_ALERT_KIND
      ? contractAlertLogSummary(al)
      : `${en(al.title) || al.kind}${en(al.body) ? ` — ${en(al.body)}` : ''}`,
    after: { kind: al.kind, to: al.recipientScope || null },
  }));
}

// 🔴 CON-10: close out the contract reminders this run actually rang, AFTER the bell rows are
// durably in org_state. Two steps, both best-effort and both reported:
//   1. stamp `notified_at` — the DURABLE dedup, so the reminder never rings again (the
//      opsAlertEvents marker only covers the next 48 hours). Stamping AFTER the write is the
//      right way round: a crash in between re-rings a reminder on the next run, and a
//      duplicate nudge about a renewal is noise where a missed one is the defect.
//   2. re-run the idempotent generator for each contract that fired, anchored on today. That
//      is what tops an auto-renewing contract's chain back up to RENEWAL_HORIZON_YEARS
//      without anyone re-saving it, and it preserves every done / snoozed / noted row.
// 🔴 HR-5: stamp `reminded_at` on the warnings this run reminded about, AFTER the bell rows
// are durable — the once-only for ever (the ops-alert marker is pruned after two days).
// Best-effort and reported; a crash in between re-reminds once, which is the right way round.
async function closeWarningReminders(rows, { stamp, report }) {
  const ids = [...new Set(rows.filter((r) => HR_WARNING_KINDS.has(r.kind) && r.warningId).map((r) => r.warningId))];
  if (!ids.length) return null;
  let stamped = 0;
  try { stamped = await stamp(ids, {}); }
  catch (err) { report('ops-alerts.hr-warning-stamp', err); }
  return { reminded: ids.length, stamped };
}

async function closeContractReminders(rows, { today, stamp, regenerate, report }) {
  const fired = rows.filter((r) => r.kind === CONTRACT_ALERT_KIND && r.reminderId);
  if (!fired.length) return null;
  let stamped = 0;
  try {
    stamped = await stamp(fired.map((r) => r.reminderId), {});
  } catch (err) {
    report('ops-alerts.contract-stamp', err);
  }
  for (const contractId of new Set(fired.map((r) => r.contractId).filter(Boolean))) {
    try { await regenerate(contractId, { today }); }
    catch (err) { report('ops-alerts.contract-regenerate', err); }
  }
  return { rang: fired.length, stamped };
}

export async function run(dryRun, {
  now = Date.now(),
  readState = readOrgState,
  writeState = writeOrgState,
  compute = computeDue,
  dispatch = dispatchDue,
  pushToUser = sendToUser,
  pushReady = pushConfigured,
  report = reportError,
  logAuto = logActivities,
  // CON-10's two close-out calls, injected like every other dependency so the offline suite
  // drives the contract-reminder path with no Supabase.
  stampContractReminders = markRemindersNotified,
  regenerateContractReminders = regenerateReminders,
  // HR-5's close-out, injected the same way.
  stampWarningReminders = markWarningsReminded,
} = {}) {
  const { state } = await readState();
  const due = await compute(state, now);
  if (due === null) return { skipped: 'time_unavailable', raised: 0 };
  // ── OVERDUE-INVOICE SWEEP RIDES THIS CRON (CS-288) ──────────────────────────
  // An invoice going overdue is a time-driven event exactly like a missed shift, and it
  // needed the same three things this run already has: a read of org_state, a CAS write,
  // and an immediate push flush. So it shares them rather than adding a ninth cron entry
  // and a ninth org_state read every five minutes. The detection and the application are
  // the SAME pure module the client reducer uses (lib/invoiceSweep.js), so the tab and the
  // cron cannot drift; the marker each writes makes them idempotent with each other.
  const overdueCount = newlyOverdueInvoices(state.invoices, now).length;
  if (!due.length && !overdueCount) return { raised: 0, overdue: 0 };
  if (dryRun) {
    // dryRun NEVER writes and NEVER dispatches — safe against prod.
    return {
      raised: 0,
      overdue: 0,
      would: due.map((a) => ({ id: a.id, kind: a.kind, clientId: a.clientId, recipientScope: a.recipientScope })),
      wouldOverdue: overdueCount,
    };
  }

  // Record phase: idempotent CAS-retry. applyOpsAlert returns null for an alert
  // whose marker is already present, so a re-applied run (or a concurrent client
  // tick) never double-raises.
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const { state: fresh, version } = await readState();
    let next = fresh;
    let raised = 0;
    // Built PER ATTEMPT: a CAS retry re-applies against a fresh state, and an alert another
    // path raised in between is a no-op whose push must not be sent twice.
    const pushOnlyRaised = [];
    // The alerts this attempt actually raised, in the bell's own words, for the activity log
    // (LOG-7) — logged only after the CAS write lands, so a retried attempt never logs an alert it
    // did not record. The cleaners' push-only pre-shift reminders are not logged: they are routine
    // (about one per cleaner per shift) and would bury the actions LOG-2 asks for.
    const raisedRows = [];
    for (const al of due) {
      const record = toAlert(next, al);
      const applied = applyOpsAlert(next, record, { now });
      if (!applied) continue; // already raised -> idempotent no-op
      next = { ...next, opsAlertEvents: applied.opsAlertEvents, notifications: applied.notifications };
      if (record.pushOnly) pushOnlyRaised.push(record);
      else raisedRows.push({ ...record, recipientScope: al.recipientScope, kind: al.kind });
      raised += 1;
    }
    // 🔴 CON-10 (CS-194): "renewals also land on the Renewals board." A RENEWAL or END-DATE
    // reminder that just rang puts ONE opportunity card on the board that owns the
    // `renewal-due` stage — HERE, inside the same `next`, so it rides the SAME CAS write as
    // the bell rows below and a conflict retries both together. Re-derived per attempt
    // against the FRESH state, and the card's caller-minted id (contract + the date it is
    // about) makes the retry, a second reminder in the same cycle, and the next run alike
    // no-ops; a card the office already moved or closed is matched by that id and left alone.
    // Bounded by the alert list, which the walker already caps per run.
    let renewalCards = null;
    const placed = applyRenewalOpportunities(next, raisedRows, { now });
    if (placed.opportunities) next = { ...next, opportunities: placed.opportunities };
    if (placed.placed || placed.skipped) renewalCards = { placed: placed.placed, skipped: placed.skipped };

    // Re-derived against the FRESH state on every attempt, never against the snapshot read
    // above: an invoice a client tick stamped in between is no longer due, and the CAS
    // retry must not re-raise it.
    let overdue = 0;
    const swept = markInvoicesOverdue(next, { now });
    if (swept) {
      next = { ...next, invoices: swept.invoices, notifications: swept.notifications };
      overdue = swept.marked;
    }
    if (raised === 0 && overdue === 0) return { raised: 0, overdue: 0 }; // nothing new -> no write, no dispatch
    const ok = await writeState(next, version);
    if (ok) {
      // LOG-7: what the cron did, with nobody watching. Best-effort — the alerts are already
      // durable in org_state, and a failed audit write must never re-run the raise.
      let logged = 0;
      // Task #468: a quiet cleaner is logged ONCE, by their marker's row (its bell words, in
      // English); the per-reader bells about them are left out, or a list morning would log the
      // same cleaners once per Admin.
      const loggable = raisedRows.filter((r) => !HR_WARNING_KINDS.has(r.kind) && !CREW_QUIET_BELL_KINDS.has(r.kind));
      if (loggable.length) logged = (await logAuto(alertActivityRows(loggable, next.company?.timezone))).length;
      // ≥1 new bell row recorded -> flush push NOW (idempotent with the every-minute cron).
      // Bell rows first (that flush also sends NTF-1's texts), then the push-only reminders,
      // which have no row for the shared core to find.
      const push = await flushPush({ dispatch, pushReady, report });
      const preShift = await sendPushOnly(pushOnlyRaised, { pushToUser, pushReady, report, state: next });
      // CON-10: stamp + top up the contract reminders this attempt rang, now that their bell
      // rows are durable. Best-effort, after the write, never before it.
      const contracts = await closeContractReminders(raisedRows, {
        today: dayKey(now, next.company?.timezone || null),
        stamp: stampContractReminders,
        regenerate: regenerateContractReminders,
        report,
      });
      const warnings = await closeWarningReminders(raisedRows, { stamp: stampWarningReminders, report });
      return {
        raised, overdue, push, logged,
        ...(pushOnlyRaised.length ? { preShift } : {}),
        ...(contracts ? { contracts, renewalCards: renewalCards || { placed: 0, skipped: 0 } } : {}),
        ...(warnings ? { warnings } : {}),
      };
    }
    // version moved under us — re-read + re-apply (markers keep it idempotent)
  }
  throw new Error('org_state write kept conflicting while raising ops alerts');
}

export default async function handler(req, res) {
  // Cron-only. Fail CLOSED (like reminders/run + push/dispatch): with no secret
  // configured, refuse rather than accept an unauthenticated call that could churn
  // org_state or force alerts.
  // An unset secret is a 500 with a body that names nothing, the gap logged (`_lib/cronGate.js`);
  // a wrong or missing bearer is a 401.
  const secret = process.env.CRON_SECRET;
  if (!secret) { refuseUnconfiguredCron(res, 'cron/ops-alerts'); return; }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.status(401).json({ ok: false, error: 'Unauthorized' });
    return;
  }
  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  // The translations first, so the alerts below render in their readers' languages. Never on a
  // dry run (it writes); never able to stop the alerts (every failure is reported, not thrown).
  let translations = null;
  if (!dryRun) {
    try { translations = await fillTranslations(); } catch (err) { reportError('i18n.fill', new Error(err?.code || 'fill-failed')); }
  }
  // HR terminations (Super Clippy's idea #513): a login whose termination date has come turns off,
  // and a voided one this termination had turned off comes back on (_lib/hrTerminations/access.js).
  // Its own step, before the alerts and apart from their write, so neither can stop the other; every
  // failure is reported there and retried on the next run. On a dry run it only lists what would run.
  let terminations = null;
  try { terminations = await runTerminationAccess({ dryRun }); }
  catch (err) { reportError('hr_terminations.run', err); terminations = { failed: true }; }
  try {
    const out = await run(dryRun);
    res.status(200).json({ ok: true, dryRun, ...out, terminations, ...(translations ? { translations } : {}) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || 'ops-alert run failed', terminations });
  }
}
