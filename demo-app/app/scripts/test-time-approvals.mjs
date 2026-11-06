// Pure helpers for the manager Approvals wave (spec §8.1–§8.4). Proves the TimeEntryModal
// clean-picker (cleansForCleanerDay) includes PAST cleans, windows ±1 org day, scopes to a
// manager's customers and sorts by start — the fix for CS-050, where the Add-time list was
// the 200 latest-DATED jobs (all in the FUTURE, unscoped), so a manager could never pick the
// clean a missed punch belonged to. Also proves the selection helper (approvableItems) never
// offers a non-owner their own punch, and the flag helper (punchFlags).
//
//   node app/scripts/test-time-approvals.mjs
import { cleansForCleanerDay, approvableItems, canActOnPunch, punchFlags, punchActionGate } from '../src/lib/filters/timeApprovals.js';
import { TIME_REFUSALS } from '../src/lib/timeRules.js';
// The words the SERVER writes on a flagged punch, and the parser that reads them back —
// asserted against the builders themselves, never a restated sentence (THE LAW II.3).
import { checklistFlagNote, CHECKLIST_UNKNOWN_NOTE, checklistFlagOf, checklistFlagText } from '../src/lib/checklistFlag.js';
import { GEOFENCE_REASON_LABELS } from '../src/lib/clockRules.js';

const TZ = 'America/New_York';
let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label}\n      ${detail}` : label); };
const idsOf = (list) => list.map((j) => j.id);

// Org-zone instant on `dayKey` at h:m (Eastern), the shape a seeded job carries.
const at = (dk, h, m = 0) => new Date(`${dk}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00-05:00`).toISOString();

// ── the LEGACY behaviour this fix replaces (CS-050): the 200 latest-dated jobs the
// cleaner is on, no day window, no scope — kept here so the test encodes the DEFECT, not
// only the new function's existence. ──
function legacyCleanOptions(jobs, cleanerId) {
  return jobs.slice().sort((a, b) => (b.startAt || '').localeCompare(a.startAt || '')).slice(0, 200)
    .filter((j) => Array.isArray(j.crewIds) && j.crewIds.includes(cleanerId));
}

// ═══ 1. A PAST clean is pickable (the CS-050 fix) ════════════════════════════════
{
  const jobs = [
    { id: 'past', startAt: at('2026-09-25', 18), crewIds: ['u1'], clientId: 'cl_a', status: 'scheduled' },
    { id: 'future', startAt: at('2026-12-01', 18), crewIds: ['u1'], clientId: 'cl_a', status: 'scheduled' },
  ];
  const picked = cleansForCleanerDay({ jobs, cleanerId: 'u1', dayKey: '2026-09-25', scope: null, tz: TZ });
  ok('past clean on the chosen day IS offered', idsOf(picked).includes('past'), JSON.stringify(idsOf(picked)));
  ok('a far-future clean is NOT offered for a past day', !idsOf(picked).includes('future'), JSON.stringify(idsOf(picked)));
  // The defect made concrete: the legacy list is future-heavy and never windows to the day,
  // so it did NOT surface the past clean at the top / at all in a real book of future work.
  const legacy = legacyCleanOptions(jobs, 'u1');
  ok('legacy list leads with the FUTURE clean (the CS-050 defect)', legacy[0]?.id === 'future', JSON.stringify(idsOf(legacy)));
  ok('new picker differs from legacy for this day', JSON.stringify(idsOf(picked)) !== JSON.stringify(idsOf(legacy)), `${JSON.stringify(idsOf(picked))} vs ${JSON.stringify(idsOf(legacy))}`);
}

// ═══ 2. ±1 org day window (overnight cleans) ═════════════════════════════════════
{
  const jobs = [
    { id: 'dayBefore', startAt: at('2026-09-24', 23), crewIds: ['u1'], clientId: 'cl_a', status: 'scheduled' },
    { id: 'onDay',     startAt: at('2026-09-25', 19), crewIds: ['u1'], clientId: 'cl_a', status: 'scheduled' },
    { id: 'dayAfter',  startAt: at('2026-09-26', 1),  crewIds: ['u1'], clientId: 'cl_a', status: 'scheduled' },
    { id: 'twoAfter',  startAt: at('2026-09-27', 19), crewIds: ['u1'], clientId: 'cl_a', status: 'scheduled' },
  ];
  const picked = idsOf(cleansForCleanerDay({ jobs, cleanerId: 'u1', dayKey: '2026-09-25', tz: TZ }));
  ok('±1 day window includes the day before and after', picked.includes('dayBefore') && picked.includes('onDay') && picked.includes('dayAfter'), JSON.stringify(picked));
  ok('±1 day window excludes two days out', !picked.includes('twoAfter'), JSON.stringify(picked));
  ok('offered cleans are sorted by start ascending', JSON.stringify(picked) === JSON.stringify(['dayBefore', 'onDay', 'dayAfter']), JSON.stringify(picked));
}

// ═══ 3. Manager scope + only-this-cleaner + non-cancelled ════════════════════════
{
  const jobs = [
    { id: 'mine',     startAt: at('2026-09-25', 18), crewIds: ['u1'], clientId: 'cl_a', status: 'scheduled' },
    { id: 'notmine',  startAt: at('2026-09-25', 18), crewIds: ['u2'], clientId: 'cl_a', status: 'scheduled' },
    { id: 'other-cl', startAt: at('2026-09-25', 18), crewIds: ['u1'], clientId: 'cl_b', status: 'scheduled' },
    { id: 'cancelled', startAt: at('2026-09-25', 18), crewIds: ['u1'], clientId: 'cl_a', status: 'cancelled' },
  ];
  const scope = new Set(['cl_a']);
  const picked = idsOf(cleansForCleanerDay({ jobs, cleanerId: 'u1', dayKey: '2026-09-25', scope, tz: TZ }));
  ok('scope excludes a customer the manager does not supervise', !picked.includes('other-cl'), JSON.stringify(picked));
  ok("only the chosen cleaner's cleans are offered", !picked.includes('notmine'), JSON.stringify(picked));
  ok('a cancelled clean is never offered', !picked.includes('cancelled'), JSON.stringify(picked));
  ok('an in-scope clean for this cleaner IS offered', picked.includes('mine'), JSON.stringify(picked));
  const all = idsOf(cleansForCleanerDay({ jobs, cleanerId: 'u1', dayKey: '2026-09-25', scope: null, tz: TZ }));
  ok('null scope (owner/admin) includes the other customer', all.includes('other-cl'), JSON.stringify(all));
}

// ═══ 4. Selection helper — never a non-owner's OWN punch ═════════════════════════
{
  const rows = [
    { id: 'e1', user_id: 'crew1', row_version: 3 },
    { id: 'e2', user_id: 'mgr1', row_version: 1 },   // the manager's own punch
    { id: 'e3', user_id: 'crew2', row_version: 0 },
  ];
  const manager = { id: 'mgr1', role: 'manager' };
  const items = approvableItems(rows, manager);
  ok('bulk approve skips the manager\'s own punch', !items.some((i) => i.entryId === 'e2'), JSON.stringify(items));
  ok('bulk approve carries the version the manager saw', items.find((i) => i.entryId === 'e1')?.version === 3, JSON.stringify(items));
  ok('a version of 0 is preserved (not dropped as falsy)', items.find((i) => i.entryId === 'e3')?.version === 0, JSON.stringify(items));
  ok('canActOnPunch is false on the manager\'s own punch', canActOnPunch(manager, rows[1]) === false);
  ok('canActOnPunch is true on a crew punch', canActOnPunch(manager, rows[0]) === true);
  const owner = { id: 'mgr1', role: 'owner' };
  ok('a Super Admin CAN act on their own punch', approvableItems(rows, owner).some((i) => i.entryId === 'e2'));
}

// ═══ 5. Flag helper ══════════════════════════════════════════════════════════════
{
  // PAY-17: the chip names WHICH END and HOW FAR — "off-site" alone cannot be ruled on,
  // and the punch is pending until the approver rules on it.
  ok('off-site clock-in flag', punchFlags({ geofence_result: 'outside' }).includes('Off-site clock-in'),
    JSON.stringify(punchFlags({ geofence_result: 'outside' })));
  ok('…carrying the distance when one was recorded',
    punchFlags({ geofence_result: 'outside', clock_in_distance_m: 1142 }).some((f) => /Off-site clock-in · [\d,]+ ft/.test(f)),
    JSON.stringify(punchFlags({ geofence_result: 'outside', clock_in_distance_m: 1142 })));
  ok('…and the clock-OUT end on its own',
    punchFlags({ geofence_result_out: 'outside' }).includes('Off-site clock-out'));
  ok('a punch with NO location says so, both ends',
    punchFlags({ geofence_result: 'unavailable', geofence_result_out: 'unavailable' })
      .join('|') === 'No location at clock-in|No location at clock-out',
    JSON.stringify(punchFlags({ geofence_result: 'unavailable', geofence_result_out: 'unavailable' })));
  ok('override flag (no reason recorded) falls back to the bare word', punchFlags({ geofence_result: 'override' }).includes('Override'));
  // W5-M F6: a bare "Override" reads as "the cleaner bypassed the ring" for a punch where
  // the office had turned the geofence off. Every other manager surface (the Time Clock
  // detail's GeoBadge, the Variance drill) says WHICH rule skipped it; the queue chip now
  // does too, from the SAME map, and an unlabelled reason (a manager's typed correction)
  // keeps the plain word.
  for (const [reason, label] of Object.entries(GEOFENCE_REASON_LABELS)) {
    ok(`override flag names the reason: ${reason} → "${label}"`,
      punchFlags({ geofence_result: 'override', override_reason: reason }).includes(label),
      JSON.stringify(punchFlags({ geofence_result: 'override', override_reason: reason })));
  }
  ok('override flag: an unlabelled reason keeps the plain word',
    punchFlags({ geofence_result: 'override', override_reason: 'clocked in from the van' }).includes('Override'));
  // A manual entry ALWAYS records override + manual_entry, so the named chip and the
  // Manual chip would be the same fact twice.
  ok('a real manual row says "Manual entry" once, not twice', (() => {
    const f = punchFlags({ source: 'admin_manual', status: 'manual', geofence_result: 'override', override_reason: 'manual_entry' });
    return f.filter((x) => /^Manual/.test(x)).length === 1;
  })(), JSON.stringify(punchFlags({ source: 'admin_manual', status: 'manual', geofence_result: 'override', override_reason: 'manual_entry' })));
  ok('offline flag', punchFlags({ source: 'offline_replay' }).includes('Offline'));
  ok('auto-closed flag', punchFlags({ status: 'auto_closed' }).includes('Auto-closed'));
  ok('manual flag', punchFlags({ source: 'admin_manual' }).includes('Manual'));
  ok('edited flag', punchFlags({ edited: true }).includes('Edited'));
  ok('clean-cancelled flag', punchFlags({ job_cancelled_at: '2026-09-25T00:00:00Z' }).includes('Clean cancelled'));
  ok('OT flag names the hours', punchFlags({ ot_minutes: 90 }).some((f) => /OT/.test(f) && /1\.5/.test(f)), JSON.stringify(punchFlags({ ot_minutes: 90 })));
  ok('no OT flag when zero', !punchFlags({ ot_minutes: 0 }).some((f) => /OT/.test(f)));
}

// ═══ 5b. the CHECKLIST flag reaches the approver (W5-M F4) ═══════════════════════
// A replayed clock-out with the cleaner's checklist unfinished is ACCEPTED and flagged in
// `note` + `edit_history` so that "it shows at approval" (checklists plan R4). /approvals is
// where approval happens, and it showed nothing but "Edited" — the flag was written and
// never read. checklistFlagOf parses back exactly what checklistFlagNote /
// CHECKLIST_UNKNOWN_NOTE write, so the two can never drift.
{
  const noted = (note) => ({ note, edit_history: [] });
  const historied = (reason) => ({ note: null, edit_history: [{ at: '2026-09-27T12:00:00Z', field: 'clock_out_at', reason }] });

  ok('no checklist words → no flag', checklistFlagOf({ note: '[offline] offline clock-out replay', edit_history: [] }) === null);
  ok('nothing at all → no flag', checklistFlagOf(null) === null && checklistFlagOf({}) === null);

  const progress = checklistFlagOf(noted(`[offline] ${checklistFlagNote(3, 12)}`));
  ok('the note\'s progress is read back', progress && progress.done === 3 && progress.total === 12, JSON.stringify(progress));
  const fromHistory = checklistFlagOf(historied(`offline clock-out replay; ${checklistFlagNote(7, 40)}`));
  ok('…and so is the edit_history\'s, when the note was replaced', fromHistory && fromHistory.done === 7 && fromHistory.total === 40, JSON.stringify(fromHistory));
  const unknown = checklistFlagOf(noted(`[offline] ${CHECKLIST_UNKNOWN_NOTE}`));
  ok('the unreadable-gate flag is its own answer, never "0/0"', unknown && unknown.unknown === true && unknown.done === undefined, JSON.stringify(unknown));
  ok('a real progress flag wins over the unknown one', (() => {
    const both = checklistFlagOf({ note: `[offline] ${CHECKLIST_UNKNOWN_NOTE}; ${checklistFlagNote(1, 2)}`, edit_history: [] });
    return both && both.done === 1 && both.total === 2;
  })());

  const row = { source: 'offline_replay', edited: true, note: `[offline] ${checklistFlagNote(3, 12)}`, edit_history: [] };
  const flags = punchFlags(row);
  ok('the queue row carries a Checklist chip with the progress', flags.includes('Checklist 3/12'), JSON.stringify(flags));
  ok('…beside the operational flags, not instead of them', flags.includes('Offline') && flags.includes('Edited'), JSON.stringify(flags));
  ok('an unreadable gate reads "Checklist unknown"', punchFlags({ note: `[offline] ${CHECKLIST_UNKNOWN_NOTE}` }).includes('Checklist unknown'), JSON.stringify(punchFlags({ note: `[offline] ${CHECKLIST_UNKNOWN_NOTE}` })));
  ok('a finished checklist adds no chip', !punchFlags({ source: 'offline_replay', note: '[offline] offline clock-out replay' }).some((f) => f.startsWith('Checklist')));
  ok('the row also hands over the sentence itself, for the line under the chips',
    checklistFlagText(row) === checklistFlagNote(3, 12) && checklistFlagText({ note: `[offline] ${CHECKLIST_UNKNOWN_NOTE}` }) === CHECKLIST_UNKNOWN_NOTE,
    `${checklistFlagText(row)} | ${checklistFlagText({ note: `[offline] ${CHECKLIST_UNKNOWN_NOTE}` })}`);
  ok('…and nothing when there is no flag', checklistFlagText({ note: null, edit_history: [] }) === null);
}

// ═══ 6. punchActionGate — the Time Clock detail + Variance drill row gate (W4-F finding 4) ═══
// Those surfaces gated only on the permission keys, so they offered Approve / Edit / Delete on a
// non-owner's OWN punch, which the server refuses (own-entry). The gate must be canActOnPunch and
// it must state the reason — the same gate + copy the Approvals queue shows.
{
  const manager = { id: 'mgr1', role: 'manager' };
  const ownSnake = { id: 'e1', user_id: 'mgr1' };
  const ownCamel = { id: 'e2', userId: 'mgr1' };   // the Variance drill passes the camelCase shape
  const others = { id: 'e3', user_id: 'crew1' };
  const g1 = punchActionGate(manager, ownSnake);
  ok("punchActionGate: a manager's OWN punch offers no actions", g1.canAct === false, JSON.stringify(g1));
  ok('punchActionGate: the reason is the own-entry sentence', g1.reason === TIME_REFUSALS['own-entry'], JSON.stringify(g1));
  ok('punchActionGate: works on the camelCase (Variance) row shape too', punchActionGate(manager, ownCamel).canAct === false);
  const g2 = punchActionGate(manager, others);
  ok("punchActionGate: another cleaner's punch → actions allowed, no reason", g2.canAct === true && g2.reason === null, JSON.stringify(g2));
  ok('punchActionGate: a Super Admin acts on their own punch', punchActionGate({ id: 'mgr1', role: 'owner' }, ownSnake).canAct === true);
}

// ── report ──────────────────────────────────────────────────────────────────────
if (fails.length) {
  console.error(`\n✖ test-time-approvals: ${fails.length} failed, ${pass} passed\n`);
  for (const f of fails) console.error(`   ✖ ${f}`);
  process.exitCode = 1;
} else {
  console.log(`✓ test-time-approvals: ${pass} passed`);
}
