// The pure checklist rule module (src/lib/crewChecklist.js) — TWO questions, one place:
//   WHICH checklist a cleaner gets on a clean — `checklistFor({ client, job, userId })`,
//     the single resolver shared by the assign UI, the crew fill, the manager roster and
//     the reminder walker (it replaced `resolveChecklistTemplateId`). It reads the clean's
//     `coverFor` FIRST (R8: a cover gets the covered cleaner's checklist), then the
//     cleaner's OWN pick, then NONE — there is no location-wide default (R3, 2026-09-27),
//     whose retirement is pinned by test-checklist-default-retired.mjs.
//   WHOSE submission counts as theirs — `isChecklistComplete` / `latestChecklistFor` /
//     `hasCompleteChecklistFor`, all matched on `completed_by_user_id` (CS-403: the
//     backend's checklist_results has no name column, so the old name match kept every
//     row and one cleaner's completion read as the other's).
// Run: node app/scripts/test-crew-checklist.mjs
import {
  checklistFor, hasChecklistOnClean, pruneCrewChecklists,
  removeUserFromCrewChecklists, removeTemplateFromClients,
  isChecklistComplete, latestChecklistFor, hasCompleteChecklistFor, completeChecklistIndex,
} from '../src/lib/crewChecklist.js';

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; } else { fail++; console.error(`FAIL ${name}\n  got : ${g}\n  want: ${w}`); }
};

const client = { crewChecklists: { u_andre: 'it_floorcare' } };

// ── checklistFor: the one resolver ────────────────────────────────────────────
eq('the cleaner\'s own pick wins', checklistFor({ client, job: null, userId: 'u_andre' }), 'it_floorcare');
eq('a cleaner with no pick gets NO checklist (R3 — no location default)', checklistFor({ client, job: null, userId: 'u_tomas' }), null);
eq('no user id → null', checklistFor({ client, job: null, userId: null }), null);
eq('empty map → null', checklistFor({ client: { crewChecklists: {} }, job: null, userId: 'u_x' }), null);
eq('nullish client → null', checklistFor({ client: null, job: null, userId: 'u_x' }), null);
eq('called with nothing at all → null (never throws)', checklistFor(), null);
// A clean that carries no cover must resolve exactly as `job: null` does.
eq('a plain clean does not change the answer',
  checklistFor({ client, job: { id: 'j_1', siteId: 's1', crewIds: ['u_andre', 'u_tomas'] }, userId: 'u_andre' }), 'it_floorcare');
eq('a plain clean does not change the empty answer either',
  checklistFor({ client, job: { id: 'j_1', siteId: 's1', crewIds: ['u_tomas'] }, userId: 'u_tomas' }), null);

// ── R8: a COVER gets the covered cleaner's pick on that clean ────────────────
// `job.coverFor = { [coverUserId]: coveredUserId }` on a single visit (reducer markOneOff /
// settleCrewMark keep it, lib/jobCover.js owns the shape). The full lifetime, the settle
// and the six ways an earlier one-off design broke are in test-job-cover.mjs.
{
  // The retired `checklistTemplateId` is left on these fixtures ON PURPOSE: it must stay
  // INERT on the cover path too (R3 — no location-wide default), which the `it_closeout`
  // expectations below used to assert and now refute.
  const two = { checklistTemplateId: 'it_closeout', crewChecklists: { u_andre: 'it_floorcare', u_tomas: 'it_fullclean' } };
  const cover = { id: 'j_c', siteId: 's1', crewIds: ['u_andre'], coverFor: { u_andre: 'u_tomas' } };
  eq('cover: Andre covering Tomas fills TOMAS\'s checklist on that clean',
    checklistFor({ client: two, job: cover, userId: 'u_andre' }), 'it_fullclean');
  eq('cover: on any other clean Andre keeps his own',
    checklistFor({ client: two, job: { id: 'j_r', siteId: 's1', crewIds: ['u_andre'] }, userId: 'u_andre' }), 'it_floorcare');
  eq('cover: the covered cleaner themselves is never redirected anywhere',
    checklistFor({ client: two, job: cover, userId: 'u_tomas' }), 'it_fullclean');
  // The cover may hold no checklist of their own at this location and still owe the
  // covered cleaner's — the whole reason R8 exists.
  eq('cover: a cover with NO pick of their own still gets the covered cleaner\'s',
    checklistFor({
      client: { checklistTemplateId: 'it_closeout', crewChecklists: { u_tomas: 'it_fullclean' } },
      job: cover, userId: 'u_andre',
    }), 'it_fullclean');
  eq('cover: a cleaner the map does not name gets their own pick, here none',
    checklistFor({ client: two, job: cover, userId: 'u_keisha' }), null);
  // The covered cleaner may have no pick at this location — then the cover keeps theirs
  // (R1: "no checklist" is a normal state, never inherited from nowhere).
  eq('cover: covered cleaner has no pick here → the cover\'s own pick stands',
    checklistFor({ client: { crewChecklists: { u_andre: 'it_floorcare' } }, job: cover, userId: 'u_andre' }), 'it_floorcare');
  eq('cover: neither has a pick → NO checklist (R3: no default to fall back to)',
    checklistFor({ client: { checklistTemplateId: 'it_closeout' }, job: cover, userId: 'u_andre' }), null);
  eq('cover: a malformed coverFor is ignored, never thrown on',
    checklistFor({ client: two, job: { id: 'j_x', coverFor: 'nope' }, userId: 'u_andre' }), 'it_floorcare');
  eq('cover: a self-cover resolves to the cleaner\'s own pick',
    checklistFor({ client: two, job: { id: 'j_x', coverFor: { u_andre: 'u_andre' } }, userId: 'u_andre' }), 'it_floorcare');
  eq('cover: no userId → the cover map is never consulted, and nothing is inherited',
    checklistFor({ client: two, job: cover, userId: null }), null);
}

// hasChecklistOnClean — does the manager roster inside a clean have anything to say?
// It asks THIS CLEAN's crew, never the location: a card titled "Checklists by cleaner"
// whose every row reads "No checklist" is information-free, and it used to render whenever
// the only holder at the location was not on the clean.
const j = (crewIds) => ({ id: 'j_1', siteId: 's1', crewIds });
eq('onClean: a cleaner on the clean holds one → yes',
  hasChecklistOnClean({ client, job: j(['u_andre', 'u_tomas']), crewIds: ['u_andre', 'u_tomas'] }), true);
eq('onClean: the only holder at the location is NOT on this clean → no',
  hasChecklistOnClean({ client, job: j(['u_tomas']), crewIds: ['u_tomas'] }), false);
eq('onClean: an empty crew → no (never a titled card with an empty list)',
  hasChecklistOnClean({ client, job: j([]), crewIds: [] }), false);
eq('onClean: a location with no assignments at all → no',
  hasChecklistOnClean({ client: { crewChecklists: {} }, job: j(['u_andre']), crewIds: ['u_andre'] }), false);
eq('onClean: falsy crew ids are skipped', hasChecklistOnClean({ client, job: j([null]), crewIds: [null, ''] }), false);
eq('onClean: called with nothing at all → false (never throws)', hasChecklistOnClean(), false);
eq('onClean: a nullish crew list → false', hasChecklistOnClean({ client, job: j(null), crewIds: null }), false);

eq('prune drops empty + keyless entries', pruneCrewChecklists({ u_a: 'it_x', u_b: '', '': 'it_y' }), { u_a: 'it_x' });
eq('prune of nullish → {}', pruneCrewChecklists(null), {});

// ── Completion: matched on the user id the backend stamps (CS-403) ────────────
// Backend-shaped rows: checklist_results has completed_by_user_id and NO name column
// (supabase/migrations/20260614120000_qc_backend.sql), so nothing below carries a name.
eq('complete: every item ticked', isChecklistComplete({ completed_count: 5, total_count: 5 }), true);
eq('complete: more ticked than counted (defensive) still complete', isChecklistComplete({ completed_count: 6, total_count: 5 }), true);
eq('complete: a partial submission is NOT complete', isChecklistComplete({ completed_count: 4, total_count: 5 }), false);
eq('complete: an empty checklist (0/0) is NOT complete', isChecklistComplete({ completed_count: 0, total_count: 0 }), false);
eq('complete: nullish row → false', isChecklistComplete(null), false);

{
  // ONE clean, ONE checklist, TWO cleaners: A submitted, B has not.
  const results = [
    { id: 'cr_a', template_id: 'it_shared', job_id: 'j_1', completed_by_user_id: 'u_a', completed_count: 5, total_count: 5, performed_at: '2026-09-27T12:00:00.000Z' },
  ];
  eq('latest: A sees their own complete submission', latestChecklistFor(results, { templateId: 'it_shared', userId: 'u_a' })?.id, 'cr_a');
  eq('latest: B sees NOTHING — A\'s row is not B\'s (CS-403)', latestChecklistFor(results, { templateId: 'it_shared', userId: 'u_b' }), null);
  eq('latest: no template id → null', latestChecklistFor(results, { templateId: null, userId: 'u_a' }), null);
  eq('latest: another template\'s row never matches', latestChecklistFor(results, { templateId: 'it_other', userId: 'u_a' }), null);
  eq('latest: with no cleaner named (a manager on the account default) the newest by anyone shows',
    latestChecklistFor(results, { templateId: 'it_shared', userId: null })?.id, 'cr_a');
  // The caller hands the list newest-first (performed_at desc), so [0] of the matches wins.
  const two = [
    { id: 'cr_new', template_id: 'it_shared', job_id: 'j_1', completed_by_user_id: 'u_a', completed_count: 5, total_count: 5, performed_at: '2026-09-27T18:00:00.000Z' },
    ...results,
  ];
  eq('latest: the first match in the caller\'s newest-first list wins', latestChecklistFor(two, { templateId: 'it_shared', userId: 'u_a' })?.id, 'cr_new');
  eq('latest: nullish results → null', latestChecklistFor(null, { templateId: 'it_shared', userId: 'u_a' }), null);
}

{
  // hasCompleteChecklistFor — the reminder walker's / the clock-out gate's question:
  // does THIS cleaner have a COMPLETE submission for THIS clean?
  const START = Date.parse('2026-09-27T12:00:00.000Z');
  const WINDOW = 18 * 60 * 60 * 1000;
  const q = (over = {}) => ({ userId: 'u_a', jobId: 'j_1', siteId: 's1', startMs: START, windowMs: WINDOW, ...over });
  const onJob = { job_id: 'j_1', site_id: 's1', completed_by_user_id: 'u_a', completed_count: 5, total_count: 5, performed_at: new Date(START + 30 * 60 * 1000).toISOString() };

  eq('has: the cleaner\'s complete submission on this clean counts', hasCompleteChecklistFor([onJob], q()), true);
  eq('has: it is NOT the other cleaner\'s (CS-404)', hasCompleteChecklistFor([onJob], q({ userId: 'u_b' })), false);
  eq('has: a PARTIAL submission does not count', hasCompleteChecklistFor([{ ...onJob, completed_count: 4 }], q()), false);
  eq('has: a complete submission on ANOTHER clean does not count', hasCompleteChecklistFor([{ ...onJob, job_id: 'j_other' }], q()), false);
  // A submission with no job_id (filled outside a clean) counts for the same cleaner at
  // the same site inside the match window.
  const loose = { ...onJob, job_id: null };
  eq('has: no job_id, same cleaner + site, inside the window → counts', hasCompleteChecklistFor([loose], q()), true);
  eq('has: no job_id at ANOTHER site → does not count', hasCompleteChecklistFor([{ ...loose, site_id: 's2' }], q()), false);
  eq('has: no job_id, outside the match window → does not count',
    hasCompleteChecklistFor([{ ...loose, performed_at: new Date(START + WINDOW + 60 * 1000).toISOString() }], q()), false);
  eq('has: no job_id, a day EARLY but inside the window → counts',
    hasCompleteChecklistFor([{ ...loose, performed_at: new Date(START - WINDOW + 60 * 1000).toISOString() }], q()), true);
  eq('has: an unparseable performed_at never counts', hasCompleteChecklistFor([{ ...loose, performed_at: 'not-a-date' }], q()), false);
  eq('has: no cleaner named → false (never silence a reminder on a blank id)', hasCompleteChecklistFor([onJob], q({ userId: null })), false);
  eq('has: nullish results → false', hasCompleteChecklistFor(null, q()), false);

  // The walker asks this once per cleaner per clean, so it indexes the window ONCE per
  // walk instead of re-scanning it. ONE rule: the index answers exactly as the raw rows
  // do, for every case above and then some.
  const rows = [
    onJob,
    { ...onJob, job_id: 'j_other' },
    { ...onJob, job_id: null },
    { ...onJob, job_id: null, site_id: 's2' },
    { ...onJob, completed_by_user_id: 'u_b' },
    { ...onJob, job_id: null, completed_by_user_id: 'u_b', performed_at: new Date(START + WINDOW + 60 * 1000).toISOString() },
    { ...onJob, completed_count: 4 },
    { ...onJob, job_id: null, performed_at: 'not-a-date' },
    null,
  ];
  const idx = completeChecklistIndex(rows);
  const cases = [
    q(), q({ userId: 'u_b' }), q({ userId: 'u_c' }), q({ jobId: 'j_other' }), q({ jobId: null }),
    q({ siteId: 's2' }), q({ siteId: null }), q({ windowMs: 0 }), q({ startMs: NaN }), q({ userId: null }),
  ];
  const sameAsRows = cases.every((c) => hasCompleteChecklistFor(rows, c) === hasCompleteChecklistFor(idx, c));
  eq('index: answers identically to a raw scan for every case (one rule, two shapes)', sameAsRows, true);
  eq('index: a prebuilt index is recognised, not rebuilt', hasCompleteChecklistFor(idx, q()), true);
  eq('index: of nullish rows → answers false', hasCompleteChecklistFor(completeChecklistIndex(null), q()), false);
  eq('index: an incomplete row never enters it', hasCompleteChecklistFor(completeChecklistIndex([{ ...onJob, completed_count: 4 }]), q()), false);
  eq('index: a row with no completer never enters it', hasCompleteChecklistFor(completeChecklistIndex([{ ...onJob, completed_by_user_id: null }]), q()), false);
}

// removeUserFromCrewChecklists — the DELETE_USER anti-orphan sweep.
const clients = [
  { id: 'c1', crewChecklists: { u_andre: 'it_floorcare', u_tomas: 'it_fullclean' } },
  { id: 'c2', crewChecklists: { u_tomas: 'it_closeout' } },
  { id: 'c3', name: 'No checklists here' }, // no per-cleaner map at all
];
const swept = removeUserFromCrewChecklists(clients, 'u_tomas');
eq('sweep removes the user from every client map', swept.map((c) => c.crewChecklists || null), [{ u_andre: 'it_floorcare' }, {}, null]);
eq('sweep leaves other cleaners intact', swept[0].crewChecklists.u_andre, 'it_floorcare');
eq('sweep keeps untouched client rows by reference (c3)', swept[2] === clients[2], true);
eq('sweep of an unreferenced user touches nothing', removeUserFromCrewChecklists(clients, 'u_ghost')[0] === clients[0], true);
eq('sweep with no userId returns the same clients array', removeUserFromCrewChecklists(clients, null) === clients, true);
eq('sweep of nullish clients → []', removeUserFromCrewChecklists(null, 'u_x').length, 0);

// removeTemplateFromClients — the hard-template-delete scrub (per-cleaner picks; there is
// no location default left to clear, R3).
const tclients = [
  { id: 'c1', crewChecklists: { u_a: 'it_x', u_b: 'it_y' } },
  { id: 'c2', crewChecklists: {} },
  { id: 'c3', name: 'unbound' },
];
const afterDel = removeTemplateFromClients(tclients, 'it_x');
eq('template scrub: drops per-cleaner entries pointing at it, keeps others', afterDel[0].crewChecklists, { u_b: 'it_y' });
eq('template scrub: clients not referencing it are untouched by reference', afterDel[1] === tclients[1] && afterDel[2] === tclients[2], true);
eq('template scrub: no templateId → clients unchanged', removeTemplateFromClients(tclients, null) === tclients, true);
eq('template scrub: nullish clients → []', removeTemplateFromClients(null, 'it_x').length, 0);

console.log(`\ncrew-checklist: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
