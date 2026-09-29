// Node unit test for the operational-alert walker (lib/opsAlerts.getDueShiftAlerts) —
// the pure late/missed-shift detection shared by the client tick and (at go-live) the
// server cron. Offline, no imports beyond the pure module. Run:
//   node app/scripts/test-ops-alerts.mjs
import {
  getDueShiftAlerts, getDueChecklistReminders, getDueInspectionReminders,
  opsAlertId, OPS_ALERT_DEFAULTS, opsAlertReadWindows,
  INSPECTION_LOOKBACK_DAYS, MAX_SHIFT_LOOKBACK_HOURS, MAX_INSPECTION_REMINDER_DAYS,
  shiftLookbackHours, inspectionReminderDays, isReminderClient,
  SEED_JOB_ID_RE, SEED_CLIENT_ID_RE, isSeedJobId, isSeedClientId,
  liveChecklistIdsFrom,
} from '../src/lib/opsAlerts.js';
// Real (app-minted) and seed id shapes come from the ONE minter each, never a restated
// literal (THE LAW II.3): seedId('j'|'cl', k) is what seed.js writes; newId('j'|'cl')
// is what the app writes for a real record.
import { newId, seedId } from '../src/lib/ids.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.error('  ✗ ' + msg); } };

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const NOW = new Date('2026-09-18T20:00:00.000Z').getTime();
const at = (minsFromNow) => new Date(NOW + minsFromNow * MIN).toISOString();
const iso = (ms) => new Date(ms).toISOString();
// A job scheduled to start `startMinsAgo` before now and run `lenMins`.
const job = (id, startMinsAgo, lenMins = 90, over = {}) => ({
  id, clientId: 'cl1', siteId: 's1', crewIds: ['u_crew'],
  startAt: at(-startMinsAgo), endAt: at(-startMinsAgo + lenMins), status: 'upcoming', ...over,
});
const entry = (jobId, clockedIn = true) => ({ job_id: jobId, clock_in_at: clockedIn ? at(-5) : null });
const kinds = (due) => due.map((d) => d.kind).sort();

// ── LATE: past start + grace, within the shift, nobody clocked in ─────────────
{
  const due = getDueShiftAlerts({ jobs: [job('j_late', 20)], timeEntries: [], now: NOW });
  ok(due.length === 1 && due[0].kind === 'shiftLate', 'A1: a shift 20m past start with no clock-in raises shiftLate');
  ok(due[0].id === opsAlertId('shiftLate', 'j_late'), 'A2: the alert carries the deterministic per-(kind,job) id');
  ok(due[0].jobId === 'j_late' && due[0].clientId === 'cl1', 'A3: the alert carries job + account routing context');
}

// ── NOT late yet: within the grace window ─────────────────────────────────────
{
  const due = getDueShiftAlerts({ jobs: [job('j_grace', 5)], timeEntries: [], now: NOW }); // 5m < 10m default grace
  ok(due.length === 0, 'B1: a shift only 5m past start (inside the 10m grace) does not alert');
}

// ── COVERED: someone clocked in → never late or missed ────────────────────────
{
  const jobs = [job('j_cov', 30)];
  const due = getDueShiftAlerts({ jobs, timeEntries: [entry('j_cov', true)], now: NOW });
  ok(due.length === 0, 'C1: a shift with a clock-in raises nothing, even past the grace');
}

// ── MISSED: past the whole window + grace, no clock-in → missed (not late) ─────
{
  // start 200m ago, 90m long → ended 110m ago, well past the 15m missed grace.
  const due = getDueShiftAlerts({ jobs: [job('j_missed', 200)], timeEntries: [], now: NOW });
  ok(due.length === 1 && due[0].kind === 'shiftMissed', 'D1: a fully-elapsed uncovered shift raises shiftMissed');
  ok(!kinds(due).includes('shiftLate'), 'D2: a missed shift does not also raise shiftLate on the same tick');
}

// ── BACK-BLAST GUARD: a shift older than the lookback window never alerts ──────
{
  // start 30h ago (> 24h default lookback).
  const due = getDueShiftAlerts({ jobs: [job('j_old', 30 * 60)], timeEntries: [], now: NOW });
  ok(due.length === 0, 'E1: a shift older than the lookback window is ignored (no activation back-blast)');
}

// ── FUTURE + TERMINAL jobs never alert ────────────────────────────────────────
{
  const future = getDueShiftAlerts({ jobs: [job('j_future', -30)], timeEntries: [], now: NOW }); // starts 30m from now
  ok(future.length === 0, 'F1: a shift that has not started yet does not alert');
  const done = getDueShiftAlerts({ jobs: [job('j_done', 60, 90, { status: 'done' })], timeEntries: [], now: NOW });
  const cancelled = getDueShiftAlerts({ jobs: [job('j_x', 60, 90, { status: 'cancelled' })], timeEntries: [], now: NOW });
  ok(done.length === 0 && cancelled.length === 0, 'F2: done/cancelled shifts never alert');
  const inProgress = getDueShiftAlerts({ jobs: [job('j_ip', 60, 90, { status: 'in_progress' })], timeEntries: [], now: NOW });
  ok(inProgress.length === 0, 'F3: an in_progress shift is covered by status and never alerts (even with no matching entry)');
}

// ── DEDUP: an already-fired id is not returned again ──────────────────────────
{
  const jobs = [job('j_dedup', 20)];
  const fired = new Set([opsAlertId('shiftLate', 'j_dedup')]);
  const due = getDueShiftAlerts({ jobs, timeEntries: [], firedIds: fired, now: NOW });
  ok(due.length === 0, 'G1: a shift whose shiftLate already fired is not re-raised');
}

// ── SETTINGS override: a tuned grace is honored ───────────────────────────────
{
  const jobs = [job('j_tuned', 5)]; // 5m past start
  const strict = getDueShiftAlerts({ jobs, timeEntries: [], now: NOW, settings: { lateAlertGraceMins: 2 } });
  ok(strict.length === 1 && strict[0].kind === 'shiftLate', 'H1: a 2m late grace makes a 5m-late shift alert (operator-tunable)');
  ok(OPS_ALERT_DEFAULTS.lateAlertGraceMins === 10, 'H2: the shipped default late grace is 10 minutes');
}

// ── #3 CHECKLIST reminders — PER CLEANER (CS-404) ─────────────────────────────
// Every cleaner on the clean is judged against THEIR OWN checklist (the shared
// lib/crewChecklist resolver). A cleaner is due when they have no COMPLETE submission of
// their own for that clean. The nudge reaches that cleaner alone; one escalation per
// clean names who is still missing and goes to the supervisor (+ the owner, routed in
// lib/opsAlertApply — test-ops-alert-apply.mjs).
{
  // The clean's one cleaner (job() defaults crewIds to ['u_crew']) holds a checklist at
  // this location. There is no location-wide default any more (R3).
  const boundClient = new Map([['cl1', { id: 'cl1', crewChecklists: { u_crew: 'it_x' } }]]);
  const unboundClient = new Map([['cl1', { id: 'cl1' }]]);
  // clean started 90m ago, ends in a bit — past the 60m crew grace, before escalation.
  const j = job('j_cl', 90, 90);
  const crewDue = getDueChecklistReminders({ jobs: [j], clientsById: boundClient, checklists: [], now: NOW });
  ok(crewDue.length === 1 && crewDue[0].kind === 'checklistDue' && crewDue[0].recipientScope === 'crew', 'I1: a cleaner with a checklist, past grace with nothing logged, is nudged');
  ok(crewDue[0].id === opsAlertId('checklistDue', 'j_cl_u_crew'), 'I1b: the nudge id is per (clean, cleaner), so two cleaners get one each');

  const noBinding = getDueChecklistReminders({ jobs: [j], clientsById: unboundClient, checklists: [], now: NOW });
  ok(noBinding.length === 0, 'I2: a location with no checklist assignments never reminds (no checklist is a normal state, R1)');

  // A COMPLETE submission by that cleaner for that clean suppresses their reminder.
  const doneRow = { job_id: 'j_cl', site_id: 's1', completed_by_user_id: 'u_crew', completed_count: 5, total_count: 5, performed_at: at(-60) };
  const logged = getDueChecklistReminders({ jobs: [j], clientsById: boundClient, checklists: [doneRow], now: NOW });
  ok(logged.length === 0, 'I3: the cleaner\'s own COMPLETE checklist for this clean suppresses their reminder');
  const partial = getDueChecklistReminders({ jobs: [j], clientsById: boundClient, checklists: [{ ...doneRow, completed_count: 4 }], now: NOW });
  ok(partial.length === 1, 'I3b: a HALF-DONE checklist does not count as logged (CS-404)');
  const elsewhere = getDueChecklistReminders({ jobs: [j], clientsById: boundClient, checklists: [{ ...doneRow, job_id: 'j_other' }], now: NOW });
  ok(elsewhere.length === 1, 'I3c: a complete checklist bound to ANOTHER clean does not count');
  const loose = getDueChecklistReminders({ jobs: [j], clientsById: boundClient, checklists: [{ ...doneRow, job_id: null }], now: NOW });
  ok(loose.length === 0, 'I3d: a submission with no job_id counts — same cleaner, same site, inside the match window');
  // 19h before the clean's START (it started 90m ago), so outside the 18h match window.
  const looseOld = getDueChecklistReminders({ jobs: [j], clientsById: boundClient, checklists: [{ ...doneRow, job_id: null, performed_at: at(-(90 + 19 * 60)) }], now: NOW });
  ok(looseOld.length === 1, 'I3e: …but not one performed outside the 18h match window');

  const shiftFired = new Set([opsAlertId('shiftLate', 'j_cl')]);
  const suppressed = getDueChecklistReminders({ jobs: [j], clientsById: boundClient, checklists: [], firedIds: shiftFired, now: NOW });
  ok(suppressed.length === 0, 'I4: a job already flagged late/missed does not also raise a checklist reminder');

  // ended 200m ago (well past end + 60m escalation) with nothing logged → escalate.
  const ended = job('j_cl2', 300, 90);
  const esc = getDueChecklistReminders({ jobs: [ended], clientsById: boundClient, checklists: [], now: NOW });
  ok(esc.length === 1 && esc[0].recipientScope === 'supervisor' && esc[0].id === opsAlertId('checklistDueEsc', 'j_cl2'), 'I5: a bound clean long past its end with no checklist escalates to the supervisor');
  ok(JSON.stringify(esc[0]?.missingUserIds) === JSON.stringify(['u_crew']), 'I5b: the escalation carries the ids of the cleaners who are missing, for the copy to name');
}

// ── CS-404: a location run on PER-CLEANER checklists only ─────────────────────
// No account default (Matt's model: Checklists A-E, one per cleaner). Before the fix the
// walker skipped any clean whose account had no default, so nothing ever fired here.
{
  const perCleanerOnly = new Map([['cl1', { id: 'cl1', crewChecklists: { u_a: 'it_a', u_b: 'it_b' } }]]);
  const two = (id, startMinsAgo, lenMins = 90) => job(id, startMinsAgo, lenMins, { crewIds: ['u_a', 'u_b'] });
  const j = two('j_pc', 90);
  const complete = (userId, over = {}) => ({ job_id: 'j_pc', site_id: 's1', completed_by_user_id: userId, completed_count: 5, total_count: 5, performed_at: at(-30), ...over });

  const due = getDueChecklistReminders({ jobs: [j], clientsById: perCleanerOnly, checklists: [], now: NOW });
  ok(due.length === 2, 'P1: a location with NO default but per-cleaner checklists reminds — one per cleaner (CS-404)');
  ok(due.every((d) => d.recipientScope === 'crew'), 'P2: both are crew nudges while the clean is still running');
  ok(JSON.stringify(due.map((d) => d.id).sort()) === JSON.stringify([opsAlertId('checklistDue', 'j_pc_u_a'), opsAlertId('checklistDue', 'j_pc_u_b')].sort()),
    'P3: each nudge carries its own (clean, cleaner) id');
  ok(due.every((d) => d.crewIds?.length === 1) && due.some((d) => d.userId === 'u_a' && d.crewIds[0] === 'u_a'),
    'P4: a nudge is addressed to the ONE cleaner who owes it — never the whole crew');

  // A finishes; B has not. A's submission must not silence B.
  const afterA = getDueChecklistReminders({ jobs: [j], clientsById: perCleanerOnly, checklists: [complete('u_a')], now: NOW });
  ok(afterA.length === 1 && afterA[0]?.userId === 'u_b', 'P5: cleaner A\'s complete checklist does NOT silence cleaner B (CS-404)');
  ok(afterA[0]?.id === opsAlertId('checklistDue', 'j_pc_u_b'), 'P5b: …and B\'s nudge still carries B\'s id');

  const bothDone = getDueChecklistReminders({ jobs: [j], clientsById: perCleanerOnly, checklists: [complete('u_a'), complete('u_b')], now: NOW });
  ok(bothDone.length === 0, 'P6: with both cleaners finished the clean raises nothing');

  // A cleaner with NO checklist at this location is never due (R1: no checklist is normal).
  const onlyA = new Map([['cl1', { id: 'cl1', crewChecklists: { u_a: 'it_a' } }]]);
  const oneBound = getDueChecklistReminders({ jobs: [j], clientsById: onlyA, checklists: [], now: NOW });
  ok(oneBound.length === 1 && oneBound[0]?.userId === 'u_a', 'P7: a cleaner with no checklist is never nudged; the one who has it still is');

  // Escalation: ONE per clean, naming everyone still missing.
  const endedJob = two('j_pc2', 300);
  const escBoth = getDueChecklistReminders({ jobs: [endedJob], clientsById: perCleanerOnly, checklists: [], now: NOW });
  ok(escBoth.length === 1 && escBoth[0]?.id === opsAlertId('checklistDueEsc', 'j_pc2'), 'P8: after the end there is ONE escalation for the clean, not one per cleaner');
  ok(JSON.stringify((escBoth[0]?.missingUserIds || []).slice().sort()) === JSON.stringify(['u_a', 'u_b']), 'P9: it names every cleaner still missing');
  const escOne = getDueChecklistReminders({ jobs: [endedJob], clientsById: perCleanerOnly, checklists: [complete('u_a', { job_id: 'j_pc2' })], now: NOW });
  ok(escOne.length === 1 && JSON.stringify(escOne[0]?.missingUserIds) === JSON.stringify(['u_b']), 'P10: a cleaner who finished is not named in the escalation');
  const escNone = getDueChecklistReminders({ jobs: [endedJob], clientsById: perCleanerOnly, checklists: [complete('u_a', { job_id: 'j_pc2' }), complete('u_b', { job_id: 'j_pc2' })], now: NOW });
  ok(escNone.length === 0, 'P11: nobody missing → no escalation at all');
}

// ── CS-353: a binding to a checklist that no longer exists ───────────────────
// The caller may pass the ids that still exist. When it does, a cleaner bound to a
// deleted checklist is skipped. When it does NOT — or its read failed — nothing is
// skipped: a failed read must never silence reminders.
{
  const bound = new Map([['cl1', { id: 'cl1', crewChecklists: { u_a: 'it_gone' } }]]);
  const j = job('j_del', 90, 90, { crewIds: ['u_a'] });
  const noSet = getDueChecklistReminders({ jobs: [j], clientsById: bound, checklists: [], now: NOW });
  ok(noSet.length === 1, 'Q1: with no live-checklist set given, the reminder fires (a failed read never silences)');
  const nullSet = getDueChecklistReminders({ jobs: [j], clientsById: bound, checklists: [], now: NOW, liveChecklistIds: null });
  ok(nullSet.length === 1, 'Q2: an explicitly null set is the same as none — still fires');
  const gone = getDueChecklistReminders({ jobs: [j], clientsById: bound, checklists: [], now: NOW, liveChecklistIds: new Set(['it_other']) });
  ok(gone.length === 0, 'Q3: a binding to a checklist the live set does not contain is skipped (CS-353)');
  const alive = getDueChecklistReminders({ jobs: [j], clientsById: bound, checklists: [], now: NOW, liveChecklistIds: new Set(['it_gone', 'it_other']) });
  ok(alive.length === 1, 'Q4: a binding to a checklist that still exists is NOT skipped');
  const emptySet = getDueChecklistReminders({ jobs: [j], clientsById: bound, checklists: [], now: NOW, liveChecklistIds: new Set() });
  ok(emptySet.length === 0, 'Q5: an empty live set means no checklists exist — nothing is due');
  const asArray = getDueChecklistReminders({ jobs: [j], clientsById: bound, checklists: [], now: NOW, liveChecklistIds: ['it_gone'] });
  ok(asArray.length === 1, 'Q6: the set may arrive as a plain array of ids');

  // Q3/Q5/Q6 above judge a single cleaner, so a bug that skipped EVERYONE would pass them.
  // This pair is the discriminating case on the per-cleaner model (R3 retired the
  // location-wide default the earlier variant used): two cleaners on one clean, one bound
  // to a checklist that still exists and one to a deleted one. Only the deleted binding may
  // be skipped, and only once the live set actually says so.
  const mixed = new Map([['cl1', { id: 'cl1', crewChecklists: { u_a: 'it_live', u_b: 'it_gone' } }]]);
  const dj = job('j_defdel', 90, 90, { crewIds: ['u_a', 'u_b'] });
  const firesToday = getDueChecklistReminders({ jobs: [dj], clientsById: mixed, checklists: [], now: NOW });
  ok(firesToday.length === 2, 'Q7: with the live set unknown, BOTH cleaners are due (a failed read never silences)');
  const skipped = getDueChecklistReminders({ jobs: [dj], clientsById: mixed, checklists: [], now: NOW, liveChecklistIds: new Set(['it_live']) });
  ok(skipped.length === 1 && skipped[0].userId === 'u_a',
    'Q8: …and only the cleaner bound to the DELETED checklist is skipped (CS-353)');
}

// ── liveChecklistIdsFrom: an empty or misshaped answer is UNKNOWN, never "none" ──
// Both callers shape a template read through this. `qcApi.listTemplates` returns
// `(await api(...)).templates`, so a 200 with a different body shape yields undefined —
// read as an empty set that would skip every binding and silence every reminder.
{
  ok(liveChecklistIdsFrom(undefined) === null, 'R1: undefined (a 200 with no templates key) is UNKNOWN, not an empty set');
  ok(liveChecklistIdsFrom(null) === null, 'R2: null is UNKNOWN');
  ok(liveChecklistIdsFrom({ templates: [] }) === null, 'R3: an object is UNKNOWN — only an array is an answer');
  ok(liveChecklistIdsFrom('it_x') === null, 'R4: a string is UNKNOWN');
  const none = liveChecklistIdsFrom([]);
  ok(none instanceof Set && none.size === 0, 'R5: an EMPTY array really is "no checklists exist" — an empty set');
  const rows = liveChecklistIdsFrom([{ id: 'it_a' }, { id: 'it_b' }, { id: null }, null, {}]);
  ok(rows instanceof Set && rows.size === 2 && rows.has('it_a') && rows.has('it_b'), 'R6: rows give their ids; a row with no id is dropped');
  const strs = liveChecklistIdsFrom(['it_a', '', 'it_b']);
  ok(strs instanceof Set && strs.size === 2 && strs.has('it_b'), 'R7: the narrow ids-only read (plain strings) works too');
  // Fed straight into the walker, an UNKNOWN answer must not skip anyone.
  const bound2 = new Map([['cl1', { id: 'cl1', crewChecklists: { u_a: 'it_gone' } }]]);
  const j2 = job('j_unk', 90, 90, { crewIds: ['u_a'] });
  const unknown = getDueChecklistReminders({ jobs: [j2], clientsById: bound2, checklists: [], now: NOW, liveChecklistIds: liveChecklistIdsFrom(undefined) });
  ok(unknown.length === 1, 'R8: a misshaped template answer leaves the reminder firing');
}

// ── Only ACTIVE cleaners are judged ────────────────────────────────────────────
// A deactivated cleaner can still sit on a past clean's crewIds. The fan-out drops them
// (fanOutToUserIds skips a non-active user) and CleanChecklist's roster never shows them,
// so judging them produced a nudge nobody could receive and named them in the escalation.
{
  const bothBound = new Map([['cl1', { id: 'cl1', crewChecklists: { u_a: 'it_a', u_gone: 'it_b' } }]]);
  const j = job('j_act', 90, 90, { crewIds: ['u_a', 'u_gone'] });
  const active = new Set(['u_a']);

  const filtered = getDueChecklistReminders({ jobs: [j], clientsById: bothBound, checklists: [], now: NOW, activeUserIds: active });
  ok(filtered.length === 1 && filtered[0].userId === 'u_a', 'S1: a cleaner who is no longer active is not nudged');
  const unfiltered = getDueChecklistReminders({ jobs: [j], clientsById: bothBound, checklists: [], now: NOW });
  ok(unfiltered.length === 2, 'S2: with no roster given, everyone on the clean is judged (a missing roster never silences)');

  const ended = job('j_act2', 300, 90, { crewIds: ['u_a', 'u_gone'] });
  const esc = getDueChecklistReminders({ jobs: [ended], clientsById: bothBound, checklists: [], now: NOW, activeUserIds: active });
  ok(esc.length === 1 && JSON.stringify(esc[0].missingUserIds) === JSON.stringify(['u_a']),
    'S3: the escalation names only active cleaners, so it cannot name a removed one');
  const onlyGone = getDueChecklistReminders({ jobs: [job('j_act3', 90, 90, { crewIds: ['u_gone'] })], clientsById: bothBound, checklists: [], now: NOW, activeUserIds: active });
  ok(onlyGone.length === 0, 'S4: a clean whose only bound cleaner is inactive raises nothing at all');
  const asList = getDueChecklistReminders({ jobs: [j], clientsById: bothBound, checklists: [], now: NOW, activeUserIds: ['u_a'] });
  ok(asList.length === 1, 'S5: the roster may arrive as a plain array of ids');
  // The crew source is the ONE resolver (lib/crewResolve.resolveJobCrewIds), so a falsy id
  // on crewIds can never become a recipient.
  const dirty = getDueChecklistReminders({ jobs: [job('j_act4', 90, 90, { crewIds: [null, 'u_a', ''] })], clientsById: bothBound, checklists: [], now: NOW });
  ok(dirty.length === 1 && dirty[0].userId === 'u_a', 'S6: falsy ids on crewIds are dropped by the shared crew resolver');
}

// ── #3 INSPECTION reminders ───────────────────────────────────────────────────
{
  // cl1 has no status field (a live account, like the seed); cl4 is explicitly inactive.
  const clients = [{ id: 'cl1' }, { id: 'cl2', status: 'active' }, { id: 'cl3' }, { id: 'cl4', status: 'inactive' }];
  const inspections = [
    { client_id: 'cl1', performed_at: iso(NOW - 20 * DAY) }, // overdue (>14d), status absent
    { client_id: 'cl2', performed_at: iso(NOW - 5 * DAY) },  // recent
    { client_id: 'cl4', performed_at: iso(NOW - 30 * DAY) }, // overdue but INACTIVE → skipped
    // cl3: never inspected
  ];
  const due = getDueInspectionReminders({ clients, inspections, now: NOW });
  ok(due.length === 1 && due[0].clientId === 'cl1' && due[0].kind === 'inspectionDue', 'J1: a status-less account overdue past the cadence is due; an inactive one is skipped');
  ok(due[0].recipientScope === 'supervisor', 'J2: an inspection reminder routes to the supervisor');

  const fired = new Set(due.map((d) => d.id));
  const again = getDueInspectionReminders({ clients, inspections, firedIds: fired, now: NOW });
  ok(again.length === 0, 'J3: an already-raised inspection reminder does not repeat for the same episode');

  const tight = getDueInspectionReminders({ clients, inspections, now: NOW, settings: { inspectionReminderDays: 3 } });
  ok(tight.length === 2 && tight.some((d) => d.clientId === 'cl2'), 'J4: a tighter cadence (3d) makes the 5-day-old account due too (operator-tunable)');
}

// ── Complete coverage (Reports fix #1, 2026-09-22) ──────────────────────────────
// The client tick + cron now pass the server's covered-job set (every real clock-in in
// the window) instead of a capped slice of punches, and read the SAME windows.
{
  const jobs = [job('j_cov', 30), job('j_open', 30)];
  const viaSet = getDueShiftAlerts({ jobs, coveredJobIds: new Set(['j_cov']), now: NOW });
  ok(viaSet.length === 1 && viaSet[0].jobId === 'j_open', 'K1: a clean in the covered-job set is not late; one missing from it is');
  const viaSetEmptyEntries = getDueShiftAlerts({ jobs, coveredJobIds: new Set(['j_cov', 'j_open']), timeEntries: [], now: NOW });
  ok(viaSetEmptyEntries.length === 0, 'K2: the covered-job set wins over (empty) timeEntries');
  const viaEntries = getDueShiftAlerts({ jobs, timeEntries: [{ job_id: 'j_cov', clock_in_at: at(-25) }], now: NOW });
  ok(viaEntries.length === 1 && viaEntries[0].jobId === 'j_open', 'K3: without a set, coverage still comes from punches (unchanged)');
}
{
  const w = opsAlertReadWindows({}, NOW);
  const hrs = (from) => (NOW - Date.parse(from)) / (60 * MIN);
  ok(hrs(w.coverage.fromIso) === OPS_ALERT_DEFAULTS.shiftAlertLookbackHours + 2, 'K4: coverage reads the lookback + 2h (a clock-in just before an edge clean still covers it)');
  ok(hrs(w.checklists.fromIso) === OPS_ALERT_DEFAULTS.shiftAlertLookbackHours + 18, 'K5: checklists reach back lookback + the 18h match window');
  // Inspection reminders read each account's LATEST inspection (no window of recent
  // records), bounded below by the look-back.
  ok((NOW - Date.parse(w.inspectionsSinceIso)) / DAY === INSPECTION_LOOKBACK_DAYS && !('inspections' in w), 'K6: the latest-inspection read looks back INSPECTION_LOOKBACK_DAYS — no recent-records window');
  ok(w.coverage.toIso === iso(NOW) && w.checklists.toIso === iso(NOW), 'K7: every window ends now');
  const tuned = opsAlertReadWindows({ shiftAlertLookbackHours: 6, inspectionReminderDays: 30 }, NOW);
  ok(hrs(tuned.coverage.fromIso) === 8 && tuned.inspectionsSinceIso === w.inspectionsSinceIso, 'K8: the windows follow the org\'s tunables (the inspection look-back is fixed)');
}

// ── The look-back caps (the complete reads refuse an over-wide window) ──────────
// Every alert read spans the shift look-back, and the server bounds those windows; an
// uncapped setting (5000h) would have every read refused and silently stop all shift
// alerts. The cap applies wherever the setting is read, so the walkers and the reads can
// never disagree about which shifts are in play.
{
  const huge = { shiftAlertLookbackHours: 5000, inspectionReminderDays: 900 };
  const hrs = (from) => (NOW - Date.parse(from)) / (60 * MIN);
  ok(shiftLookbackHours(huge) === MAX_SHIFT_LOOKBACK_HOURS && hrs(opsAlertReadWindows(huge, NOW).coverage.fromIso) === MAX_SHIFT_LOOKBACK_HOURS + 2, 'M1: a 5000h look-back is capped at a week — the coverage read stays inside the server\'s bound');
  ok(shiftLookbackHours({}) === OPS_ALERT_DEFAULTS.shiftAlertLookbackHours && shiftLookbackHours({ shiftAlertLookbackHours: 6 }) === 6, 'M1b: sane settings pass through');
  const old = job('j_old', 10 * 24 * 60); // started 10 days ago, never clocked in
  const recent = job('j_recent', 6 * 24 * 60); // 6 days ago
  const dueHuge = getDueShiftAlerts({ jobs: [old, recent], coveredJobIds: new Set(), now: NOW, settings: huge });
  ok(dueHuge.length === 1 && dueHuge[0].jobId === 'j_recent', 'M2: the walker applies the same cap — a clean 10 days back is past it, one 6 days back is not');
  ok(inspectionReminderDays(huge) === MAX_INSPECTION_REMINDER_DAYS && MAX_INSPECTION_REMINDER_DAYS < INSPECTION_LOOKBACK_DAYS, 'M3: the inspection cadence is capped inside the latest-inspection look-back');
  const lapsed = getDueInspectionReminders({ clients: [{ id: 'cl1' }], inspections: [{ client_id: 'cl1', performed_at: iso(NOW - 365.5 * DAY) }], now: NOW, settings: huge });
  ok(lapsed.length === 1, 'M3b: …so even at the cap an account can still come due (a 900-day cadence could never fire)');
  ok(isReminderClient({ id: 'a' }) && isReminderClient({ id: 'b', status: 'active' }) && !isReminderClient({ id: 'c', status: 'inactive' }) && !isReminderClient(null), 'M4: every account not explicitly inactive is watched');
}

// ── SEED-DATA SKIP (CS-011 / CS-030) — PARTIAL as of 2026-09-26 ──────────────────
// Production is 100% seed data until the CS-030 cutover (owner: "Leave fake data for
// now", 2026-09-25). The walkers — shared by the cron AND the client tick — skip the
// fictional book so the re-enabled cron doesn't burst ~160 fake alerts a week onto the
// owner's phone. EXCEPTION (owner call, 2026-09-26): late/missed-shift alerts now DO
// fire on seed jobs so the client demo can prove missed-clean notifications reach the
// mobile app; only CHECKLIST reminders still skip seed JOBS and INSPECTION reminders
// still skip seed CLIENTS. A REAL job also alerts on a seed client, as before.
{
  // The two seed job formats: seed.js writes j_seed_*; seed-backend.mjs writes
  // j_bkseed_* (both j_bkseed_<site>_<n> and j_bkseed_route_<driver>_<n>_<i>).
  const seedJob = seedId('j', 'late');          // j_seed_late  (seed.js minter)
  const bkseedJob = 'j_bkseed_site_evgrn_5';    // seed-backend.mjs backfill format
  const realJob = newId('j');                   // j_<base36> — a real app-minted job
  const seedClient = seedId('cl', 'evergreen'); // cl_seed_evergreen (seed.js minter)
  const realClient = newId('cl');               // cl_<base36> — a real app-minted client

  // The exported predicates recognise exactly the seed shapes and pass real ids
  // (asserting the walker's own source-of-truth constants, not a re-stated literal).
  ok(isSeedJobId(seedJob) && SEED_JOB_ID_RE.test(seedJob), 'N1: j_seed_* is a seed job id');
  ok(isSeedJobId(bkseedJob) && SEED_JOB_ID_RE.test(bkseedJob), 'N2: j_bkseed_* is a seed job id');
  ok(!isSeedJobId(realJob), 'N3: a real newId(\'j\') job id is NOT a seed job id');
  ok(isSeedClientId(seedClient) && SEED_CLIENT_ID_RE.test(seedClient), 'N4: cl_seed_* is a seed client id');
  ok(!isSeedClientId(realClient), 'N5: a real newId(\'cl\') client id is NOT a seed client id');

  // Shift (late/missed): as of 2026-09-26 a seed job DOES alert (owner call — the client
  // demo must prove missed-clean notifications reach the mobile app). Checklist +
  // inspection reminders still skip the seed book (N10, N12 below).
  {
    const due = getDueShiftAlerts({ jobs: [job(seedJob, 20)], timeEntries: [], now: NOW });
    ok(due.length === 1 && due[0].kind === 'shiftLate',
      'N6: a SEED job (j_seed_*) 20m late now RAISES shiftLate (skip removed 2026-09-26)');
  }
  {
    const due = getDueShiftAlerts({ jobs: [job(bkseedJob, 20)], timeEntries: [], now: NOW });
    ok(due.length === 1 && due[0].kind === 'shiftLate',
      'N7: a SEED job (j_bkseed_*) 20m late now RAISES shiftLate');
  }
  {
    const due = getDueShiftAlerts({ jobs: [job(realJob, 20)], timeEntries: [], now: NOW });
    ok(due.length === 1 && due[0].kind === 'shiftLate', 'N8: a REAL job 20m late still raises shiftLate');
  }
  // A REAL job on a SEED client still alerts — the skip is by JOB id, not client
  // (so a test shift can be run on a fake customer).
  {
    const due = getDueShiftAlerts({ jobs: [job(realJob, 200, 90, { clientId: seedClient })], timeEntries: [], now: NOW });
    ok(due.length === 1 && due[0].kind === 'shiftMissed' && due[0].clientId === seedClient,
      'N9: a REAL job on a SEED client still raises shiftMissed');
  }

  // Checklist: a seed job bound to a checklist account raises no reminder; a real job does.
  {
    const boundById = new Map([['cl1', { id: 'cl1', crewChecklists: { u_crew: 'it_x' } }]]);
    const seedCk = getDueChecklistReminders({ jobs: [job(seedJob, 90, 90)], clientsById: boundById, checklists: [], now: NOW });
    ok(seedCk.length === 0, 'N10: a SEED job never raises a checklist reminder');
    const realCk = getDueChecklistReminders({ jobs: [job(realJob, 90, 90)], clientsById: boundById, checklists: [], now: NOW });
    ok(realCk.length === 1 && realCk[0].kind === 'checklistDue', 'N11: a REAL job on the same account does raise the checklist reminder');
  }

  // Inspection: a seed client overdue past the cadence raises NOTHING; a real client does.
  {
    const clients = [{ id: seedClient }, { id: realClient }];
    const inspections = [
      { client_id: seedClient, performed_at: iso(NOW - 20 * DAY) },
      { client_id: realClient, performed_at: iso(NOW - 20 * DAY) },
    ];
    const due = getDueInspectionReminders({ clients, inspections, now: NOW });
    ok(due.length === 1 && due[0].clientId === realClient && due[0].kind === 'inspectionDue',
      'N12: a SEED client raises no inspection reminder; a REAL client overdue the same amount does');
  }
}

console.log(`\n${pass}/${pass + fail} ops-alert assertions passed`);
if (fail) { console.error(`\n${fail} assertion(s) failed.\n`); process.exit(1); }
console.log('');
