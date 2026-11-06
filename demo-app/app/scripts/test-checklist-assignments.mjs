// The Assignments screen's rules (src/lib/checklistAssignments.js) — PURE, so the summary
// (D) counts the same four problems the worklists fix, and the assignment writes obey the
// one rule the screen is built on.
//
//   WHAT NEEDS ATTENTION      → checklistIssues(): overdue today · a cleaner's rule off ·
//                               a checklist nobody holds · an assignment to someone no
//                               longer scheduled there ("a stray").
//   HOW AN ASSIGNMENT MOVES   → assignChecklist / reassignChecklist / removeChecklistHolder,
//                               all of which keep a cleaner on AT MOST ONE checklist per
//                               customer (R2) because the map is keyed by cleaner.
//
// The overdue walk deliberately answers the SAME question the checklist reminder does
// (lib/opsAlerts.getDueChecklistReminders): the same resolver (covers included), the same
// grace, the same completion rule and the same 18-hour loose-submission window — a tile
// that disagreed with the nudge would send the office looking for a problem the crew was
// never told about, or the reverse.
//
// It also holds the REPLACEMENT (THE LAW II.5, replace means delete), mechanically: the
// pop-up organizer this screen replaces, its CSS and the per-cleaner <Select> grid it
// replaces inside Service setup are all GONE, and the one panel is mounted in both places.
//
// Run: node app/scripts/test-checklist-assignments.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  ISSUE_KINDS, ISSUE_LABELS, SCHEDULED_JOB_STATUSES,
  scheduledCleanersByCustomer, latestChecklistProgress, checklistIssues, issueIndex,
  walkTodaysChecklists, todayByCustomer, resolveRailSelection, cleanerRailIndex,
  holdersOf, assignChecklist, reassignChecklist, removeChecklistHolder,
} from '../src/lib/checklistAssignments.js';
import { OPS_ALERT_DEFAULTS } from '../src/lib/opsAlerts.js';
import { CLOCK_RULE_KEYS } from '../src/lib/clockRules.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`FAIL ${name}\n  got : ${g}\n  want: ${w}`); }
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-09-28T04:00:00.000Z');
// The nudge's LEAD TIME BEFORE THE SCHEDULED END (ALR-10) is the SOURCE constant, never a
// restated 60 — retune the default and this suite retunes with it.
const LEAD_MS = OPS_ALERT_DEFAULTS.checklistReminderBeforeEndMins * MIN;
const iso = (ms) => new Date(ms).toISOString();

// A clean that started long enough ago for its checklist to be overdue, and one that has
// not reached the nudge line yet.
// ALR-10: the nudge line is `endAt - LEAD_MS`, so an OVERDUE clean is one already past it.
const startedAt = NOW - 2 * HOUR;
const endsSoon = NOW + LEAD_MS - 30 * MIN;   // nudge line 30 min in the PAST
const justStarted = NOW - 5 * MIN;
const endsLater = NOW + LEAD_MS + 2 * HOUR;  // nudge line still 2 h AHEAD

const users = [
  { id: 'u_andre', name: 'Andre Baptiste', status: 'active' },
  { id: 'u_tomas', name: 'Tomas Rivera', status: 'active' },
  { id: 'u_keisha', name: 'Keisha Bryant', status: 'active', clockRules: { [CLOCK_RULE_KEYS.checklist]: true } },
  { id: 'u_marisol', name: 'Marisol Vega', status: 'active', clockRules: { [CLOCK_RULE_KEYS.geofence]: true } },
  { id: 'u_gone', name: 'Nadia Petit', status: 'disabled', clockRules: { [CLOCK_RULE_KEYS.checklist]: true } },
];

const clients = [
  { id: 'cl_coral', name: 'Coral Bay HOA', crewChecklists: { u_andre: 'it_floor', u_tomas: 'it_full' } },
  { id: 'cl_lasolas', name: 'Las Olas Medical Group', crewChecklists: { u_keisha: 'it_lobby' } },
];

const templates = [
  { id: 'it_floor', name: 'Floor care', client_id: 'cl_coral', item_count: 5 },
  { id: 'it_full', name: 'Full facility deep clean', client_id: 'cl_coral', item_count: 46 },
  { id: 'it_lobby', name: 'Lobby & reception', client_id: 'cl_lasolas', item_count: 18 },
  { id: 'it_exam', name: 'Exam rooms', client_id: 'cl_lasolas', item_count: 34 },   // nobody holds it
  { id: 'it_starter', name: 'Office · nightly', client_id: null, item_count: 12 },  // a STARTER, never assigned
];

const jobs = [
  { id: 'j_coral', clientId: 'cl_coral', siteId: 's_coral', status: 'in_progress', startAt: iso(startedAt), endAt: iso(endsSoon), crewIds: ['u_andre', 'u_tomas'] },
  { id: 'j_lasolas', clientId: 'cl_lasolas', siteId: 's_lasolas', status: 'upcoming', startAt: iso(justStarted), endAt: iso(endsLater), crewIds: ['u_keisha'] },
];

// ── The vocabulary is the module's, not a restated literal ───────────────────
eq('four issue kinds, in the summary\'s order', ISSUE_KINDS, ['overdue', 'rules', 'nobody', 'strays']);
eq('every kind carries a label', ISSUE_KINDS.every((k) => typeof ISSUE_LABELS[k] === 'string' && ISSUE_LABELS[k].length > 0), true);
eq('"scheduled here" means an upcoming or in-progress clean', SCHEDULED_JOB_STATUSES, ['upcoming', 'in_progress']);

// ── scheduledCleanersByCustomer ──────────────────────────────────────────────
{
  const map = scheduledCleanersByCustomer([
    ...jobs,
    { id: 'j_old', clientId: 'cl_coral', status: 'done', startAt: iso(NOW - 40 * HOUR), crewIds: ['u_marisol'] },
    { id: 'j_void', clientId: 'cl_coral', status: 'cancelled', startAt: iso(NOW + HOUR), crewIds: ['u_marisol'] },
  ]);
  eq('scheduled: the crew of upcoming/in-progress cleans', [...(map.get('cl_coral') || [])].sort(), ['u_andre', 'u_tomas']);
  eq('scheduled: a finished or cancelled clean does not make someone scheduled', (map.get('cl_coral') || new Set()).has('u_marisol'), false);
  eq('scheduled: a customer with no cleans is absent', map.has('cl_none'), false);
}

// ── 1. Overdue today ─────────────────────────────────────────────────────────
{
  // Nobody has submitted anything: both Coral Bay cleaners are past the nudge line.
  const iss = checklistIssues({ clients, users, jobs, templates, results: [], now: NOW });
  eq('overdue: every cleaner on a started clean who owes their own checklist',
    iss.overdue.map((x) => `${x.userId}:${x.templateId}`).sort(), ['u_andre:it_floor', 'u_tomas:it_full']);
  eq('overdue: a clean that has not reached the nudge line is not overdue yet',
    iss.overdue.some((x) => x.jobId === 'j_lasolas'), false);
  eq('overdue: nothing submitted reads as 0 of 0', iss.overdue.find((x) => x.userId === 'u_andre').done, 0);
}
{
  // A COMPLETE submission clears that cleaner only — the other still owes theirs (CS-403).
  const results = [{ job_id: 'j_coral', site_id: 's_coral', template_id: 'it_floor', completed_by_user_id: 'u_andre', completed_count: 5, total_count: 5, performed_at: iso(NOW - 10 * MIN) }];
  const iss = checklistIssues({ clients, users, jobs, templates, results, now: NOW });
  eq('overdue: a complete submission clears its own cleaner', iss.overdue.map((x) => x.userId), ['u_tomas']);
}
{
  // A PARTIAL submission does not clear anyone, and its progress is what the row shows.
  const results = [
    { job_id: 'j_coral', site_id: 's_coral', template_id: 'it_full', completed_by_user_id: 'u_tomas', completed_count: 4, total_count: 46, performed_at: iso(NOW - 30 * MIN) },
    { job_id: 'j_coral', site_id: 's_coral', template_id: 'it_full', completed_by_user_id: 'u_tomas', completed_count: 12, total_count: 46, performed_at: iso(NOW - 10 * MIN) },
  ];
  const iss = checklistIssues({ clients, users, jobs, templates, results, now: NOW });
  const tomas = iss.overdue.find((x) => x.userId === 'u_tomas');
  eq('overdue: a half-done checklist is still overdue', !!tomas, true);
  eq('overdue: the progress is the LATEST partial submission', [tomas.done, tomas.total], [12, 46]);
}
{
  // R8: a COVER is judged on the covered cleaner's checklist, on that clean only.
  const coverJobs = [{ ...jobs[0], crewIds: ['u_tomas'], coverFor: { u_tomas: 'u_andre' } }];
  const iss = checklistIssues({ clients, users, jobs: coverJobs, templates, results: [], now: NOW });
  eq('overdue: a cover owes the COVERED cleaner\'s checklist',
    iss.overdue.map((x) => `${x.userId}:${x.templateId}`), ['u_tomas:it_floor']);
  // …and their own completion of it counts.
  const done = [{ job_id: 'j_coral', site_id: 's_coral', template_id: 'it_floor', completed_by_user_id: 'u_tomas', completed_count: 5, total_count: 5, performed_at: iso(NOW - 5 * MIN) }];
  eq('overdue: the cover finishing the covered checklist clears them',
    checklistIssues({ clients, users, jobs: coverJobs, templates, results: done, now: NOW }).overdue.length, 0);
}
{
  // A submission logged OUTSIDE a clean counts for the same cleaner at the same site
  // inside the reminder's 18-hour window — the same rule the nudge uses.
  const loose = [{ job_id: null, site_id: 's_coral', template_id: 'it_floor', completed_by_user_id: 'u_andre', completed_count: 5, total_count: 5, performed_at: iso(startedAt + 20 * MIN) }];
  const iss = checklistIssues({ clients, users, jobs, templates, results: loose, now: NOW });
  eq('overdue: a same-site submission near the clean counts', iss.overdue.map((x) => x.userId), ['u_tomas']);
}
{
  // An INACTIVE cleaner left on a clean's crew can act on nothing, so they are not judged.
  const jobsWithGone = [{ ...jobs[0], crewIds: ['u_andre', 'u_gone'] }];
  const withGone = [{ ...clients[0], crewChecklists: { ...clients[0].crewChecklists, u_gone: 'it_full' } }, clients[1]];
  const iss = checklistIssues({ clients: withGone, users, jobs: jobsWithGone, templates, results: [], now: NOW });
  eq('overdue: an inactive cleaner on the clean is not judged', iss.overdue.map((x) => x.userId), ['u_andre']);
}
{
  // CS-353: a pick that points at a checklist that no longer exists is skipped, but ONLY
  // when the template list actually answered.
  const iss = checklistIssues({ clients, users, jobs, templates: templates.filter((t) => t.id !== 'it_full'), results: [], now: NOW });
  eq('overdue: a binding to a deleted checklist is skipped', iss.overdue.map((x) => x.userId), ['u_andre']);
  const unknown = checklistIssues({ clients, users, jobs, templates: null, results: [], now: NOW });
  eq('overdue: a template read that never answered skips nobody', unknown.overdue.map((x) => x.userId).sort(), ['u_andre', 'u_tomas']);
}
{
  eq('overdue: with no checklist results read, nothing is claimed overdue',
    checklistIssues({ clients, users, jobs, templates, results: null, now: NOW }).overdue, []);
  eq('overdue: a cancelled clean owes nothing',
    checklistIssues({ clients, users, jobs: [{ ...jobs[0], status: 'cancelled' }], templates, results: [], now: NOW }).overdue, []);
  eq('overdue: a clean older than the look-back is not raised for ever',
    checklistIssues({ clients, users, jobs: [{ ...jobs[0], startAt: iso(NOW - 40 * HOUR) }], templates, results: [], now: NOW }).overdue, []);
}

// ── 2. Rules off ─────────────────────────────────────────────────────────────
{
  const iss = checklistIssues({ clients, users, jobs, templates, results: [], now: NOW });
  eq('rules: one row per cleaner per rule that is off',
    iss.rules.map((x) => `${x.userId}:${x.rule}`), [`u_keisha:${CLOCK_RULE_KEYS.checklist}`, `u_marisol:${CLOCK_RULE_KEYS.geofence}`]);
  eq('rules: an inactive member\'s rule is not listed', iss.rules.some((x) => x.userId === 'u_gone'), false);
  const both = [{ id: 'u_both', status: 'active', clockRules: { [CLOCK_RULE_KEYS.checklist]: true, [CLOCK_RULE_KEYS.geofence]: true } }];
  eq('rules: a cleaner with both off is two rows (each is fixed on its own)',
    checklistIssues({ clients: [], users: both, jobs: [], templates: [], results: [], now: NOW }).rules.length, 2);
  const truthy = [{ id: 'u_x', status: 'active', clockRules: { [CLOCK_RULE_KEYS.checklist]: 'yes' } }];
  eq('rules: only a literal true counts as off (fail closed)',
    checklistIssues({ clients: [], users: truthy, jobs: [], templates: [], results: [], now: NOW }).rules, []);
}

// ── 3. Checklists nobody holds ───────────────────────────────────────────────
{
  const iss = checklistIssues({ clients, users, jobs, templates, results: [], now: NOW });
  eq('nobody: a customer\'s checklist with no holder', iss.nobody.map((x) => x.templateId), ['it_exam']);
  eq('nobody: it names the customer it belongs to', iss.nobody[0].clientId, 'cl_lasolas');
  eq('nobody: a STARTER (no customer) is never "unheld" — it is never assigned',
    iss.nobody.some((x) => x.templateId === 'it_starter'), false);
  eq('nobody: a template for a customer that no longer exists is not raised',
    checklistIssues({ clients: [], users, jobs: [], templates, results: [], now: NOW }).nobody, []);
  eq('nobody: with no template list read, nothing is claimed unheld',
    checklistIssues({ clients, users, jobs, templates: null, results: [], now: NOW }).nobody, []);
}

// ── 4. Strays: assigned to someone not on an upcoming clean there ────────────
{
  // Keisha holds the Las Olas lobby checklist and IS on its clean → not a stray.
  const iss = checklistIssues({ clients, users, jobs, templates, results: [], now: NOW });
  eq('strays: a holder on an upcoming clean there is not a stray', iss.strays, []);
}
{
  const strayClients = [{ ...clients[0], crewChecklists: { ...clients[0].crewChecklists, u_marisol: 'it_full' } }, clients[1]];
  const iss = checklistIssues({ clients: strayClients, users, jobs, templates, results: [], now: NOW });
  eq('strays: a holder with no upcoming clean there', iss.strays.map((x) => `${x.clientId}:${x.userId}`), ['cl_coral:u_marisol']);
  eq('strays: the row names the checklist so Remove knows what to clear', iss.strays[0].templateId, 'it_full');
  const unknownUser = [{ ...clients[0], crewChecklists: { u_deleted: 'it_full' } }];
  eq('strays: a binding to someone no longer on the roster is not a row (DELETE_USER sweeps it)',
    checklistIssues({ clients: unknownUser, users, jobs, templates, results: [], now: NOW }).strays, []);
}

// ── The rail's "needs attention" flags come off the SAME answer ──────────────
{
  const strayClients = [{ ...clients[0], crewChecklists: { ...clients[0].crewChecklists, u_marisol: 'it_full' } }, clients[1]];
  const iss = checklistIssues({ clients: strayClients, users, jobs, templates, results: [], now: NOW });
  const idx = issueIndex(iss);
  eq('flags: the customers with a problem', [...idx.byClient].sort(), ['cl_coral', 'cl_lasolas']);
  eq('flags: the cleaners with a problem', [...idx.byUser].sort(), ['u_andre', 'u_keisha', 'u_marisol', 'u_tomas']);
}

// ── ONE walk of today's cleans, two readers ─────────────────────────────────
// The overdue tile is the not-yet-finished half of the same walk the customer and cleaner
// views read for their "Done today" / "12/46" badges, so a badge can never say one thing
// while the tile above it says another.
{
  const results = [
    { job_id: 'j_coral', site_id: 's_coral', template_id: 'it_floor', completed_by_user_id: 'u_andre', completed_count: 5, total_count: 5, performed_at: iso(NOW - 10 * MIN) },
    { job_id: 'j_coral', site_id: 's_coral', template_id: 'it_full', completed_by_user_id: 'u_tomas', completed_count: 12, total_count: 46, performed_at: iso(NOW - 10 * MIN) },
  ];
  const walk = walkTodaysChecklists({ clients, jobs, templates, results, now: NOW });
  eq('walk: one entry per cleaner-with-a-checklist on a started clean (Las Olas started 5 min ago)',
    walk.map((x) => `${x.userId}:${x.complete ? 'done' : `${x.done}/${x.total}`}`).sort(),
    ['u_andre:done', 'u_keisha:0/0', 'u_tomas:12/46']);
  eq('walk: a clean that has not reached the nudge line is still WALKED (its badges show)',
    walkTodaysChecklists({ clients, users, jobs, templates, results: [], now: NOW }).some((x) => x.jobId === 'j_lasolas'), true);
  eq('walk: …but it is not overdue yet',
    walkTodaysChecklists({ clients, users, jobs, templates, results: [], now: NOW }).find((x) => x.jobId === 'j_lasolas').overdue, false);
  eq('walk: a clean that has not STARTED is not walked at all',
    walkTodaysChecklists({ clients, jobs: [{ ...jobs[0], startAt: iso(NOW + HOUR) }], templates, results: [], now: NOW }), []);
  eq('walk: the overdue tile is exactly the walk\'s unfinished, past-the-nudge half',
    checklistIssues({ clients, users, jobs, templates, results, now: NOW }).overdue.map((x) => x.userId),
    walk.filter((x) => x.overdue).map((x) => x.userId));

  const by = todayByCustomer({ clients, jobs, templates, results, now: NOW });
  eq('today: indexed by customer, then by cleaner', by.get('cl_coral').get('u_andre').complete, true);
  eq('today: the partial carries its progress', [by.get('cl_coral').get('u_tomas').done, by.get('cl_coral').get('u_tomas').total], [12, 46]);
  eq('today: a customer with no started clean is absent', by.has('cl_none'), false);
  eq('today: nothing read → an empty index, never a wrong badge', todayByCustomer({ clients, jobs, templates, results: null, now: NOW }).size, 0);
}

// ── latestChecklistProgress ──────────────────────────────────────────────────
{
  const p = latestChecklistProgress([
    { job_id: 'j1', completed_by_user_id: 'u1', completed_count: 2, total_count: 9, performed_at: iso(NOW - HOUR) },
    { job_id: 'j1', completed_by_user_id: 'u1', completed_count: 7, total_count: 9, performed_at: iso(NOW - MIN) },
    { job_id: 'j1', completed_by_user_id: 'u2', completed_count: 1, total_count: 3, performed_at: iso(NOW - MIN) },
  ]);
  eq('progress: the newest submission per cleaner per clean', p.get('j1|u1'), { done: 7, total: 9 });
  eq('progress: each cleaner counted apart', p.get('j1|u2'), { done: 1, total: 3 });
  eq('progress: a row with no clean or no cleaner is ignored', latestChecklistProgress([{ completed_count: 1, total_count: 2 }]).size, 0);
  eq('progress: nothing read → empty', latestChecklistProgress(null).size, 0);
}

// ── The write rule: a cleaner holds AT MOST ONE checklist per customer ───────
{
  const map = { u_andre: 'it_floor', u_tomas: 'it_full' };
  eq('holders: who holds a checklist here', holdersOf(map, 'it_floor'), ['u_andre']);
  eq('holders: nobody holds it', holdersOf(map, 'it_exam'), []);
  eq('holders: nothing to read → []', holdersOf(null, 'it_floor'), []);

  eq('assign: a new cleaner is added', assignChecklist(map, { userId: 'u_keisha', templateId: 'it_exam' }),
    { u_andre: 'it_floor', u_tomas: 'it_full', u_keisha: 'it_exam' });
  // THE RULE: giving Andre a second checklist MOVES his pick, it never adds one.
  const moved = assignChecklist(map, { userId: 'u_andre', templateId: 'it_full' });
  eq('assign: a cleaner already holding one is MOVED, not given a second', moved, { u_andre: 'it_full', u_tomas: 'it_full' });
  eq('assign: …so they still hold exactly one', Object.keys(moved).filter((u) => u === 'u_andre').length, 1);
  eq('assign: the input map is not mutated', map, { u_andre: 'it_floor', u_tomas: 'it_full' });
  eq('assign: a falsy checklist is not stored as one', assignChecklist(map, { userId: 'u_keisha', templateId: '' }), map);

  const re = reassignChecklist(map, { templateId: 'it_floor', fromUserId: 'u_andre', toUserId: 'u_keisha' });
  eq('reassign: one step — off the old cleaner, onto the new', re, { u_tomas: 'it_full', u_keisha: 'it_floor' });
  eq('reassign: onto a cleaner who already holds another MOVES theirs too',
    reassignChecklist(map, { templateId: 'it_floor', fromUserId: 'u_andre', toUserId: 'u_tomas' }), { u_tomas: 'it_floor' });
  eq('reassign: onto the SAME cleaner is a no-op, never a removal',
    reassignChecklist(map, { templateId: 'it_floor', fromUserId: 'u_andre', toUserId: 'u_andre' }), map);
  eq('reassign: a "from" who does not hold that checklist keeps their own',
    reassignChecklist(map, { templateId: 'it_exam', fromUserId: 'u_andre', toUserId: 'u_keisha' }),
    { u_andre: 'it_floor', u_tomas: 'it_full', u_keisha: 'it_exam' });

  eq('remove: the holder is cleared', removeChecklistHolder(map, 'u_andre'), { u_tomas: 'it_full' });
  eq('remove: someone who holds nothing changes nothing', removeChecklistHolder(map, 'u_keisha'), map);
  eq('remove: the last holder leaves an EMPTY map, never a null entry', removeChecklistHolder({ u_a: 'it_x' }, 'u_a'), {});
  eq('remove: nothing to read → {}', removeChecklistHolder(null, 'u_a'), {});
}

// ── S4: while the schedule is still loading, the job-derived tiles say nothing ──
// The boot window holds only recent cleans. Judged against it, a holder whose upcoming
// clean has not arrived yet reads as a STRAY — with a one-click Remove beside it — and a
// cleaner on a clean the window has not reached is missed by "overdue". Both are the
// screen telling the office something untrue and offering to act on it.
{
  const iss = checklistIssues({ clients, users, jobs, templates, results: [], now: NOW, jobsHydrated: false });
  eq('overdue is NOT KNOWN, not an empty list', iss.overdue, null);
  eq('strays is NOT KNOWN either', iss.strays, null);
  eq('the two that do not read the schedule are still answered',
    [Array.isArray(iss.rules), Array.isArray(iss.nobody)], [true, true]);
  eq('the rail flags survive a null list without throwing',
    [...issueIndex(iss).byUser].sort(), ['u_keisha', 'u_marisol']);
  eq('hydrated is the default, so every existing caller is unchanged',
    Array.isArray(checklistIssues({ clients, users, jobs, templates, results: [], now: NOW }).strays), true);
}

// ── S1: an EXPLICIT selection is never substituted ──────────────────────────
// Opening a record from a worklist row, a holder's name or the cleaner view must show
// THAT record, even when the rail's own search or filter hides it. The screen used to
// fall through to the first visible row, so "Open" on a Coral Bay row while the rail was
// searched for "lakeside" opened Lakeside — silently, with no sign anything had happened.
{
  const rows = ['c1', 'c2', 'c3'];
  eq('a selection that is visible is simply shown',
    resolveRailSelection({ selectedId: 'c2', exists: true, visibleIds: rows, fallbackId: 'c1' }),
    { id: 'c2', pinned: false, substituted: false });
  eq('a selection the filter HIDES is still shown — and pinned, so the rail says where you are',
    resolveRailSelection({ selectedId: 'c9', exists: true, visibleIds: rows, fallbackId: 'c1' }),
    { id: 'c9', pinned: true, substituted: false });
  eq('nothing selected falls to the first visible row',
    resolveRailSelection({ selectedId: '', exists: false, visibleIds: rows, fallbackId: 'c1' }),
    { id: 'c1', pinned: false, substituted: false });
  eq('an id that names no record left (a stale link) falls back AND says it was substituted',
    resolveRailSelection({ selectedId: 'c_deleted', exists: false, visibleIds: rows, fallbackId: 'c1' }),
    { id: 'c1', pinned: false, substituted: true });
  eq('an empty rail with nothing selected selects nothing, never throws',
    resolveRailSelection({ selectedId: '', exists: false, visibleIds: [], fallbackId: '' }),
    { id: '', pinned: false, substituted: false });
  eq('a hidden selection on an EMPTY rail is still shown',
    resolveRailSelection({ selectedId: 'c9', exists: true, visibleIds: [], fallbackId: '' }),
    { id: 'c9', pinned: true, substituted: false });
  eq('called with nothing at all', resolveRailSelection(), { id: '', pinned: false, substituted: false });
}

// ── S3: the Cleaners rail is indexed ONCE, not re-walked per row ────────────
{
  const idx = cleanerRailIndex({
    clients: [
      { id: 'c1', crewChecklists: { u_a: 'k1' } },
      { id: 'c2', crewChecklists: {} },
      { id: 'c3', crewChecklists: { u_b: 'k2' } },
    ],
    scheduledByCustomer: new Map([['c1', new Set(['u_a', 'u_b'])], ['c2', new Set(['u_b'])]]),
  });
  eq('a cleaner is counted once per customer, scheduled there OR holding a checklist there',
    [idx.customerCount.get('u_a'), idx.customerCount.get('u_b')], [1, 3]);
  eq('a cleaner nobody schedules or assigns is absent', idx.customerCount.get('u_z'), undefined);
  eq('who holds a checklist ANYWHERE, for the "With checklists" chip',
    [...idx.holdsAnywhere].sort(), ['u_a', 'u_b']);
  eq('nothing to read → empty, never a throw',
    [cleanerRailIndex().customerCount.size, cleanerRailIndex().holdsAnywhere.size], [0, 0]);
}
{
  // The SHAPE, measured: at the plan's scale the indexed rail must not be within a stone's
  // throw of the O(users x customers) walk it replaced. Both halves run in this process,
  // so the assertion is a RATIO and does not depend on the machine.
  const CUSTOMERS = 750, USERS = 1470;
  const clients = Array.from({ length: CUSTOMERS }, (_, i) => ({
    id: `c${i}`,
    crewChecklists: i % 3 === 0 ? { [`u${i % USERS}`]: 'k1' } : {},
  }));
  const users = Array.from({ length: USERS }, (_, i) => ({ id: `u${i}`, name: `Cleaner ${i}`, status: 'active' }));
  const scheduledByCustomer = new Map(clients.map((c, i) => [c.id, new Set([`u${i % USERS}`, `u${(i + 7) % USERS}`])]));

  const naive = () => users.map((u) => clients.filter((c) => scheduledByCustomer.get(c.id)?.has(u.id) || c.crewChecklists?.[u.id]).length);
  const t0 = performance.now(); const a = naive(); const naiveMs = performance.now() - t0;

  const t1 = performance.now();
  const idx = cleanerRailIndex({ clients, scheduledByCustomer });
  const b = users.map((u) => idx.customerCount.get(u.id) || 0);
  const indexedMs = performance.now() - t1;

  eq('the indexed rail answers exactly what the walk did', JSON.stringify(a) === JSON.stringify(b), true);
  eq(`the index is far cheaper than the per-row walk (naive ${naiveMs.toFixed(0)}ms vs indexed ${indexedMs.toFixed(0)}ms)`,
    indexedMs * 5 < naiveMs, true);
}

// ── Called with nothing at all, it never throws ──────────────────────────────
eq('checklistIssues() with no arguments answers four empty lists',
  ISSUE_KINDS.map((k) => checklistIssues()[k].length), [0, 0, 0, 0]);

// ── Replace means delete (THE LAW II.5), checked mechanically ────────────────
// Every one of these is a grep over the tree, not a judgment: the pop-up organizer, its
// CSS and Service setup's own per-cleaner grid are the code this screen REPLACES, and a
// replacement that leaves the old surface reachable is two surfaces that disagree.
{
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const APP = path.resolve(HERE, '..');
  const SRC = path.join(APP, 'src');
  const read = (p) => readFileSync(p, 'utf8');
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (
    d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]
  ));
  const srcFiles = walk(SRC).filter((p) => /\.(jsx?|css)$/.test(p));
  const hits = (re) => srcFiles.filter((p) => re.test(read(p))).map((p) => path.relative(APP, p).split(path.sep).join('/'));

  eq('the pop-up organizer file is deleted', existsSync(path.join(SRC, 'components/ChecklistAssignmentsModal.jsx')), false);
  eq('nothing imports or mounts it', hits(/ChecklistAssignmentsModal/).filter((p) => !p.includes('checklists/ChecklistAssignments.jsx')), []);
  eq('its CSS is swept with it', hits(/\.cla-[a-z-]+\s*\{/), []);
  eq('the "Checklist assignments" button is gone from the Quality hub',
    /Checklist assignments/.test(read(path.join(SRC, 'pages/Inspections.jsx'))), false);
  eq('the Quality hub mounts the Assignments tab instead',
    /components\/checklists\/ChecklistAssignments/.test(read(path.join(SRC, 'pages/Inspections.jsx'))), true);

  // Service setup no longer owns a checklist UI of its own: it embeds the same panel.
  const svc = read(path.join(SRC, 'components/ServiceSetupCard.jsx'));
  eq('Service setup embeds the shared panel', /CustomerChecklistPanel/.test(svc), true);
  eq('Service setup no longer renders its own per-cleaner checklist grid',
    /svc-cc-|CREATE_CHECKLIST|cleanerChecklistOptions/.test(svc), false);
  eq('…and its per-cleaner CSS went with it', hits(/\.svc-cc[a-z-]*\s*\{/), []);
  eq('Service setup writes no crewChecklists of its own (the panel owns that)',
    /crewChecklists/.test(svc), false);

  // ONE panel, TWO mounts — the whole point of the replacement.
  const mounts = hits(/<CustomerChecklistPanel/);
  eq('the customer view is mounted in exactly two places', mounts.sort(),
    ['src/components/ServiceSetupCard.jsx', 'src/components/checklists/ChecklistAssignments.jsx']);

  const screenSrcForGates = read(path.join(SRC, 'components/checklists/ChecklistAssignments.jsx'));

  // ── S2: the panel's TWO capabilities ──────────────────────────────────────
  // Managing a checklist (add, start-from, copy, edit, delete) is `qc.templates.edit`,
  // which is what the SERVER requires; assigning one is `ops.edit`. They were both offered
  // on `ops.edit`, so a viewer who could assign but not manage templates was handed five
  // controls the server would refuse. Both mounts pass both.
  const panelSrc = read(path.join(SRC, 'components/checklists/CustomerChecklistPanel.jsx'));
  eq('the panel takes a separate template capability', /canEditTemplates/.test(panelSrc), true);
  for (const [what, marker] of [
    ['Add checklist / Start from', 'addPicker'],
    ['Edit', 'setEditorFor(t.id)'],
    ['Delete', 'setDeleteTpl(t)'],
  ]) {
    const near = panelSrc.split('\n').filter((l) => l.includes(marker)).join('\n');
    eq(`${what} is behind canEditTemplates`, /canEditTemplates/.test(near) || /canEditTemplates &&[\s\S]{0,200}/.test(panelSrc), true);
  }
  eq('assigning stays on canEdit (ops.edit), not the template key',
    /canEdit && \(\s*\n?\s*<span className="cka-picker">/.test(panelSrc) || /\{canEdit && \(/.test(panelSrc), true);
  for (const [file, src] of [
    ['ChecklistAssignments.jsx', screenSrcForGates],
    ['ServiceSetupCard.jsx', read(path.join(SRC, 'components/ServiceSetupCard.jsx'))],
  ]) {
    eq(`${file} passes the template capability down`, /canEditTemplates=\{/.test(src), true);
    eq(`${file} reads it from the permission, not from ops.edit`, /usePermission\('qc\.templates\.edit'\)/.test(src), true);
  }

  // ── S8: the item count comes off the customer's OWN rows ─────────────────
  // It used to come from the org-wide summary, which the embedded panel then had to read
  // on every customer-page open just for a number, which a read-only viewer never got (the
  // summary read is gated), and which a freshly added checklist missed until a reload.
  // `item_count` is a real column on the template row since step 5 (F4), and the scoped
  // list already carries it.
  // (The row variable is `tpl` since CS-193: `t` is the panel's translator now.)
  eq('the panel reads the count off the template row', /\btpl\.item_count/.test(panelSrc), true);
  eq('…not from a map built over the org-wide summary', /new Map\(\(sources \|\| \[\]\)\.map/.test(panelSrc), false);
  eq('the org-wide read is only for "Start from…", so it stays behind the template key',
    /templatesSummary\(\)/.test(panelSrc) && /canEditTemplates/.test(panelSrc.slice(0, panelSrc.indexOf('templatesSummary()'))), true);

  // ── S1 wiring: ONE atomic URL update, and the selection rule is the shared one ──
  const screen = read(path.join(SRC, 'components/checklists/ChecklistAssignments.jsx'));
  const navLines = screen.split('\n').filter((l) => /const (openCustomer|openCleaner|switchView) =/.test(l));
  eq('all three navigations are there', navLines.length, 3);
  eq('none of them queues a second URL update behind setParams (the bug: q survived)',
    navLines.every((l) => !/setQ\(/.test(l)), true);
  eq('the screen never falls back to the first row for an explicit selection',
    /railRows\.some\(\(r\) => r\.id === sel/.test(screen), false);
  eq('…it asks the shared rule instead', /resolveRailSelection\(/.test(screen), true);
  eq('a hidden selection is PINNED rather than swapped', /pinnedRow/.test(screen), true);
  eq('…and the way back to the whole list is offered', /clearRailFilter/.test(screen), true);
  // S3: the Cleaners rail reads an index, not a walk per row.
  eq('the rail does not walk every customer per cleaner',
    /\(clients \|\| \[\]\)\.(some|filter)\(\(c\) => [^)]*crewChecklists\?\.\[u\.id\]/.test(screen), false);
  eq('…it reads the index', /cleanerRailIndex\(/.test(screen) && /cleanerIndex\.customerCount/.test(screen), true);
  eq('the index is memoized on the DATA, never on the search text',
    /useMemo\(\(\) => cleanerRailIndex\([^)]*\), \[clients, scheduledByCustomer\]\)/.test(screen), true);

  // ── A COPIED URL REOPENS THE TAB ──────────────────────────────────────────
  // The Quality hub's `?tab=` was born (6840f04, 2026-09-19) as a ONE-SHOT deep link so
  // the Dashboard's Open Complaints tile could land on Work Orders — "consumed once,
  // stripped", modelled on `?fill=1` / `?checklist=1`, which genuinely must be consumed
  // because they open a modal. A tab is not a modal: stripping it meant the hub's own
  // state never survived a copy, and once the Assignments tab kept real state in the URL
  // (?view / ?q / ?f / ?customer / ?cleaner) a shared link restored that state onto the
  // WRONG tab. The tab is now URL state; the one-shot params are unchanged.
  const hub = read(path.join(SRC, 'pages/Inspections.jsx'));
  // `?tab=` is no longer CONSUMED. The only time it leaves the URL is when it would carry
  // the default tab, which is the useTableSearch contract (drop a param that says nothing).
  const tabDeletes = hub.split('\n').filter((l) => /delete\('tab'\)/.test(l));
  eq('the only ?tab= dropped is the default one, never a consumed deep link',
    tabDeletes.length > 0 && tabDeletes.every((l) => /defaultTab/.test(l)), true);
  eq('the tab is DERIVED from the URL, not held in component state',
    /const\s*\[\s*tab\s*,\s*setTab\s*\]\s*=\s*useState/.test(hub), false);
  eq('…it reads searchParams for it', /searchParams\.get\('tab'\)/.test(hub), true);
  eq('a tab change is written with replace:true (no history entry per tab click)',
    /setSearchParams\([\s\S]{0,400}?\{\s*replace:\s*true\s*\}\)/.test(hub), true);
  eq('every tab is still reachable by name', ['records', 'checklists', 'assignments', 'workorders', 'templates']
    .every((t) => new RegExp(`'${t}'`).test(hub)), true);
  // The one-shot params must STILL be consumed — they open a form, and a reload must not
  // reopen it.
  for (const p of ['fill', 'siteId', 'checklist']) {
    eq(`the one-shot ?${p} is still consumed and stripped`, new RegExp(`delete\\('${p}'\\)`).test(hub), true);
  }
}

console.log(`\nchecklist-assignments: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
