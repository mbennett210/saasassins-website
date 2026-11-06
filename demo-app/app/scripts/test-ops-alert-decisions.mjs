// Matt's alert decisions of 2026-09-29, over the PURE walkers and the shared apply path, so
// the in-browser tick (components/OpsAlertScheduler) and the server cron (api/cron/ops-alerts)
// are both covered by construction — they run these exact modules.
//
//   ALR-10  the cleaner's checklist reminder goes out a set number of minutes BEFORE the
//           scheduled END ("one hour before their shift ends… or they won't be able to clock
//           out"), replacing "an hour after the start". The escalation after the end stays.
//   ALR-9   an inspection interval PER ACCOUNT, defaulting to the org's 14 days.
//   ALR-11  ONE missed-shift alert, `missedAfterStartMins` after the scheduled START.
//   ALR-12  the person copied on it is the ACCOUNT'S supervisor, so ALR-4's org-wide
//           "operations manager" picker is gone rather than kept beside them.
//   PAY-15  each manager gets a morning digest of their OWN still-unapproved punches.
//
// Timings are asserted against the SOURCE constants, never a restated 60 (THE LAW II.3).
//
//   node app/scripts/test-ops-alert-decisions.mjs
import {
  OPS_ALERT_DEFAULTS, MAX_CHECKLIST_LEAD_MINS, MAX_INSPECTION_REMINDER_DAYS,
  checklistReminderBeforeEndMins, missedAfterStartMins, clientInspectionIntervalDays,
  inspectionReminderDays, getDueChecklistReminders, getDueInspectionReminders,
  getDueShiftAlerts, opsAlertId, FALLBACK_SHIFT_MINS,
} from '../src/lib/opsAlerts.js';
import { applyOpsAlert } from '../src/lib/opsAlertApply.js';
import { pendingByManager, unapprovedDigestBody, UNAPPROVED_DIGEST_TITLE } from '../src/lib/filters/timeApprovals.js';
import { loadStore } from './deletion-core.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-29T04:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
// The lead time is the SOURCE default, so retuning it retunes this suite.
const LEAD = OPS_ALERT_DEFAULTS.checklistReminderBeforeEndMins;
const LEAD_MS = LEAD * MIN;

// ═══════════════════ ALR-10 · the nudge is timed off the scheduled END ═══════════════════
{
  eq('the default lead time is a number of minutes', typeof LEAD, 'number');
  ok('…and it is positive', LEAD > 0);
  eq('the old after-the-start setting is GONE from the defaults (II.5)',
    Object.prototype.hasOwnProperty.call(OPS_ALERT_DEFAULTS, 'checklistReminderGraceMins'), false);
  eq('a reader with no settings takes the default', checklistReminderBeforeEndMins({}), LEAD);
  eq('a NEGATIVE lead is clamped to 0 (nudging after the end is the escalation job)',
    checklistReminderBeforeEndMins({ checklistReminderBeforeEndMins: -30 }), 0);
  eq('an absurd lead is clamped to a day',
    checklistReminderBeforeEndMins({ checklistReminderBeforeEndMins: 99999 }), MAX_CHECKLIST_LEAD_MINS);
  eq('a non-numeric lead falls back', checklistReminderBeforeEndMins({ checklistReminderBeforeEndMins: 'soon' }), LEAD);

  const client = { id: 'cl_a', name: 'Coral Bay HOA', crewChecklists: { u_c1: 'it_a' } };
  const clientsById = new Map([[client.id, client]]);
  const job = (over = {}) => ({ id: 'j1', clientId: 'cl_a', siteId: 's1', status: 'in_progress', crewIds: ['u_c1'], ...over });
  const walk = (j, now = NOW) => getDueChecklistReminders({
    jobs: [j], clientsById, checklists: [], firedIds: new Set(), now, settings: {},
  });

  // A LONG clean: started 4 h ago, ends in 2 h. The OLD rule (start + 60) would have nudged
  // three hours ago, long before it could matter; the new one waits for the end.
  const long = job({ startAt: iso(NOW - 4 * HOUR), endAt: iso(NOW + 2 * HOUR) });
  eq('a long clean whose end is still far off does NOT nudge yet', walk(long).length, 0);
  ok('…although the OLD rule (start + lead) is long past', NOW > Date.parse(long.startAt) + LEAD_MS);

  const nearEnd = job({ startAt: iso(NOW - 4 * HOUR), endAt: iso(NOW + LEAD_MS - 10 * MIN) });
  const due = walk(nearEnd);
  eq('a clean inside the lead time DOES nudge', due.length, 1);
  eq('…as the crew nudge, to that cleaner alone', [due[0].recipientScope, due[0].crewIds], ['crew', ['u_c1']]);
  eq('…with the per-cleaner dedup id', due[0].id, opsAlertId('checklistDue', 'j1_u_c1'));

  // A clean SHORTER than the lead time nudges at its start, never before it was scheduled.
  eq('a clean that has not started yet never nudges',
    walk(job({ startAt: iso(NOW + 10 * MIN), endAt: iso(NOW + 40 * MIN) })).length, 0);
  eq('a clean SHORTER than the lead nudges once it has started',
    walk(job({ startAt: iso(NOW - 5 * MIN), endAt: iso(NOW + 25 * MIN) })).length, 1);

  // The ESCALATION after the end is unchanged.
  const escalate = OPS_ALERT_DEFAULTS.checklistEscalateGraceMins;
  const esc = walk(job({ startAt: iso(NOW - 5 * HOUR), endAt: iso(NOW - escalate * MIN - 10 * MIN) }));
  eq('past the end + escalation grace it is the SUPERVISOR escalation',
    [esc.length, esc[0].recipientScope], [1, 'supervisor']);
  eq('…one per clean, not one per cleaner', esc[0].id, opsAlertId('checklistDueEsc', 'j1'));
  eq('…naming who still owes it', esc[0].missingUserIds, ['u_c1']);

  // A clean with NO end time uses the SHARED assumed length, so the reminder and the
  // Assignments screen's overdue tile cannot land minutes apart.
  ok('the assumed shift length is shared, not restated', Number.isFinite(FALLBACK_SHIFT_MINS));
  eq('a clean with no end time nudges off the assumed length',
    walk(job({ startAt: iso(NOW - (FALLBACK_SHIFT_MINS - LEAD + 5) * MIN) })).length, 1);
  eq('…and not before that assumed end is within the lead',
    walk(job({ startAt: iso(NOW - (FALLBACK_SHIFT_MINS - LEAD - 5) * MIN) })).length, 0);
}

// ═══════════════════ ALR-9 · an inspection interval per account ═════════════════════════
{
  eq('the org default is still 14 days', inspectionReminderDays({}), 14);
  eq('an account with no interval of its own follows the org', clientInspectionIntervalDays({ id: 'c' }, {}), 14);
  eq('…including one whose field is blank', clientInspectionIntervalDays({ id: 'c', inspectionIntervalDays: '' }, {}), 14);
  eq('…or zero (never a real interval of no days)', clientInspectionIntervalDays({ id: 'c', inspectionIntervalDays: 0 }, {}), 14);
  eq('an account with its OWN interval uses it', clientInspectionIntervalDays({ id: 'c', inspectionIntervalDays: 7 }, {}), 7);
  eq('…over a different org default',
    clientInspectionIntervalDays({ id: 'c', inspectionIntervalDays: 7 }, { inspectionReminderDays: 30 }), 7);
  eq('…clamped at the same ceiling as the org setting',
    clientInspectionIntervalDays({ id: 'c', inspectionIntervalDays: 99999 }, {}), MAX_INSPECTION_REMINDER_DAYS);

  // Three accounts, one inspection each 10 days ago: only the weekly one has lapsed.
  const clients = [
    { id: 'cl_weekly', name: 'Weekly', inspectionIntervalDays: 7 },
    { id: 'cl_monthly', name: 'Monthly', inspectionIntervalDays: 30 },
    { id: 'cl_default', name: 'Default' },
  ];
  const at = (days) => clients.map((c) => ({ client_id: c.id, performed_at: iso(NOW - days * DAY) }));
  const dueAt = (days, settings = {}) => getDueInspectionReminders({
    clients, inspections: at(days), firedIds: new Set(), now: NOW, settings,
  }).map((d) => d.clientId).sort();

  eq('at 10 days only the WEEKLY account is due', dueAt(10), ['cl_weekly']);
  // 20 days is past 7 and past the org's 14, but NOT past 30 — one org number could not say
  // this, which is the whole point of ALR-9.
  eq('at 20 days the weekly and the default are due, the monthly is not', dueAt(20), ['cl_default', 'cl_weekly']);
  eq('at 35 days every interval has lapsed', dueAt(35), ['cl_default', 'cl_monthly', 'cl_weekly']);
  eq('a longer per-account interval genuinely suppresses it',
    getDueInspectionReminders({
      clients: [{ id: 'cl_monthly', inspectionIntervalDays: 30 }],
      inspections: [{ client_id: 'cl_monthly', performed_at: iso(NOW - 20 * DAY) }],
      firedIds: new Set(), now: NOW, settings: {},
    }).length, 0);
  eq('a shorter ORG default does not override an account that set its own longer one',
    getDueInspectionReminders({
      clients: [{ id: 'cl_monthly', inspectionIntervalDays: 30 }],
      inspections: [{ client_id: 'cl_monthly', performed_at: iso(NOW - 20 * DAY) }],
      firedIds: new Set(), now: NOW, settings: { inspectionReminderDays: 7 },
    }).length, 0);
  eq('a never-inspected account is still left to onboarding, not nagged',
    getDueInspectionReminders({ clients, inspections: [], firedIds: new Set(), now: NOW, settings: {} }).length, 0);
}

// ════════════════ ALR-11 / ALR-12 · ONE alert, to the account's supervisor ════════
{
  eq('the one mark defaults to 30 minutes past the start', missedAfterStartMins({}), 30);
  eq('an operator value is honoured', missedAfterStartMins({ missedAfterStartMins: 45 }), 45);
  eq('ALR-12: there is no org-wide operations-manager setting left',
    'operationsManagerUserId' in OPS_ALERT_DEFAULTS, false);

  // Every alert kind is ON for everyone here, so ROUTING is what decides who hears, never a
  // muted preference.
  const user = (id, role, over = {}) => ({
    id, role, status: 'active', name: id,
    notificationPrefs: { shiftMissed: true, checklistDue: true, inspectionDue: true, mobilePushEnabled: true },
    ...over,
  });
  const state = (opsSettings = {}, { supervisorId = 'u_spoc', users = null } = {}) => ({
    users: users || [user('u_owner', 'owner'), user('u_spoc', 'manager'), user('u_ops', 'manager')],
    clients: [{ id: 'cl_a', name: 'Coral Bay HOA', supervisorId }],
    permissions: [], userPermissionOverrides: [], notifications: [], opsAlertEvents: [],
    opsSettings,
  });
  const recipients = (st, alert) => {
    const out = applyOpsAlert(st, alert, { now: NOW });
    return [...new Set((out?.notifications || []).map((n) => n.userId))].sort();
  };
  const alert = (kind, over = {}) => ({
    id: `oa_${kind}_ref`, kind, recipientScope: 'supervisor', clientId: 'cl_a', jobId: 'j1',
    title: 't', body: 'b', url: '/u', ...over,
  });

  eq('a MISSED shift reaches the account supervisor and the one shared owner login',
    recipients(state(), alert('shiftMissed')), ['u_owner', 'u_spoc']);
  // ALR-12: a value still sitting in the blob copies NOBODY — nothing reads it any more.
  eq('a legacy operations-manager value copies nobody extra',
    recipients(state({ operationsManagerUserId: 'u_ops' }), alert('shiftMissed')), ['u_owner', 'u_spoc']);
  eq('the checklist ESCALATION is unchanged',
    recipients(state(), alert('checklistDue')), ['u_owner', 'u_spoc']);
  eq('an INSPECTION reminder keeps SPOC-alone routing (NOTIF-02)',
    recipients(state(), alert('inspectionDue')), ['u_spoc']);
  eq('the crew checklist NUDGE still reaches only the cleaner',
    recipients(state(), alert('checklistDue', { recipientScope: 'crew', crewIds: ['u_spoc'] })), ['u_spoc']);

  // With NO supervisor the alert blankets the office bench rather than going silent — and
  // each recipient is rung exactly once.
  {
    const out = applyOpsAlert(state({}, { supervisorId: null }), alert('shiftMissed'), { now: NOW });
    ok('with no SPOC the bench hears it', (out?.notifications || []).length > 0);
    eq('…and nobody twice',
      (out?.notifications || []).filter((n) => n.userId === 'u_owner').length, 1);
  }

  // The walker that produces the alert fires MID-SHIFT now, not after the clean ended.
  {
    const mark = missedAfterStartMins({});
    const running = { id: 'j1', clientId: 'cl_a', siteId: 's1', status: 'upcoming', crewIds: ['u_c1'], startAt: iso(NOW - (mark + 1) * MIN), endAt: iso(NOW + 3 * HOUR) };
    const dueShift = getDueShiftAlerts({ jobs: [running], coveredJobIds: new Set(), firedIds: new Set(), now: NOW, settings: {} });
    eq('a clean nobody clocked into is MISSED while it is still running', [dueShift.length, dueShift[0]?.kind], [1, 'shiftMissed']);
  }
}

// ═══════════════════ PAY-15 · the morning unapproved digest ═════════════════════════════
{
  const clients = [
    { id: 'cl_a', name: 'A', supervisorId: 'u_mgr1' },
    { id: 'cl_b', name: 'B', supervisorId: 'u_mgr1' },
    { id: 'cl_c', name: 'C', supervisorId: 'u_mgr2' },
    { id: 'cl_d', name: 'D' },                            // nobody supervises it
  ];
  const punch = (clientId, userId) => ({ id: `e_${clientId}_${userId}`, client_id: clientId, user_id: userId });
  const rows = [
    punch('cl_a', 'u_c1'), punch('cl_a', 'u_c2'), punch('cl_b', 'u_c1'),
    punch('cl_c', 'u_c3'),
    punch('cl_d', 'u_c4'),
    { id: 'e_nocust', client_id: null, user_id: 'u_c5' },
  ];
  const { managers, unassigned } = pendingByManager(rows, clients);
  eq('one bucket per manager, busiest first', managers.map((m) => [m.managerId, m.count]), [['u_mgr1', 3], ['u_mgr2', 1]]);
  eq('a digest counts PEOPLE as well as punches', managers[0].cleanerIds.size, 2);
  eq('…and which of their customers are involved', [...managers[0].clientIds].sort(), ['cl_a', 'cl_b']);
  eq('punches at an UNSUPERVISED customer are kept as unassigned, never dropped', unassigned.count, 2);
  eq('no rows → no digests', pendingByManager([], clients).managers.length, 0);
  eq('no customers → everything is unassigned', pendingByManager(rows, []).unassigned.count, rows.length);
  eq('a junk row is ignored', pendingByManager([null, undefined], clients).managers.length, 0);

  const body = unapprovedDigestBody({ count: 3, cleaners: 2, dayLabel: '2026-09-28' });
  ok('the digest counts punches', body.includes('3 punches'), body);
  ok('…and cleaners', body.includes('2 cleaners'), body);
  ok('…and names the day', body.includes('2026-09-28'), body);
  ok('…and says why it matters', /not paid/.test(body), body);
  eq('one punch from one cleaner reads in the singular',
    unapprovedDigestBody({ count: 1, cleaners: 1, dayLabel: 'x' }).startsWith('1 punch from 1 cleaner '), true);
  ok('the title says whose job it is', /your approval/i.test(UNAPPROVED_DIGEST_TITLE), UNAPPROVED_DIGEST_TITLE);
}

console.log(`${fails.length === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.error('  ✗ ' + f);
process.exitCode = fails.length === 0 ? 0 : 1;
