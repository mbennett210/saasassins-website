// THE CLIENT HUB'S CREW STATUS, PURE — the one time rule behind the Home crew band and Today's
// Visit (the client hub redesign, plan §3.2, 2026-10-08).
//
// `hubVisitStatus` (src/lib/hubVisit.js) is run by the server (api/hub `home` and `visit`), by the
// login-free demo (src/lib/hubDemo.js) and here, so all three answer the same. It decides:
//   · the STATE: on site now · arriving today · visit complete · no visit today;
//   · the arrival, how early (never how late: M1 ★ stays neutral), the crew as first name + last
//     initial, the scheduled start, the check-out, the next visit;
//   · the visit timeline, with the checklist steps only when a checklist is expected — and no
//     live item count: a checklist is done when the cleaner saves it (Daniel, 2026-10-08).
//
// What it holds, case by case (the plan's list):
//   · every state, and two visits in one day (the later unstarted one wins over "done");
//   · a night clean across midnight stays on site, and is "done" the morning after;
//   · a DST day (25 hours and 23 hours) and an org zone that is not the server's zone;
//   · early, on time (|Δ| ≤ HUB_ON_TIME_MINUTES) and late, against the job the punch NAMES;
//   · no expected checklist → no checklist steps;
//   · a voided or no-show punch is never an arrival (hubOnSiteList's rule);
//   · every served object is an allowlist; no full name and no staff id leaves the rule.
//
// REGRESSION (THE LAW II.3): on the pre-change tree src/lib/hubVisit.js does not exist, so every
// check below fails.
//
//   node app/scripts/test-hub-visit-status.mjs

// 🔴 THE SERVER'S ZONE IS NOT THE ORG'S. Set before any date is made: a rule that read the process
// zone (or UTC) anywhere would put these visits on the wrong day. Kiritimati is UTC+14, the
// furthest a server could be from the org's Eastern and Pacific days.
process.env.TZ = 'Pacific/Kiritimati';

const tryImport = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const V = await tryImport('../src/lib/hubVisit.js');
const H = await tryImport('../src/lib/hubHome.js');
const { hubPersonName } = await tryImport('../src/lib/clientHub.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail) — the repo's suites disagree; this one reads a label first.
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};
const sameKeys = (obj, list) => !!obj && Array.isArray(list) && Object.keys(obj).sort().join(',') === [...list].sort().join(',');
const show = (x) => JSON.stringify(x)?.slice(0, 400);

ok('M0 the rule module loads', () => typeof V.hubVisitStatus === 'function', V.__error || 'hubVisitStatus is not exported');
const run = (input) => (typeof V.hubVisitStatus === 'function' ? V.hubVisitStatus(input) : null);
const keys = (s) => (s?.timeline || []).map((x) => x.key).join(',');
const step = (s, key) => (s?.timeline || []).find((x) => x.key === key) || null;

// ── the world: Coral Bay, Thursday 2026-10-08, Eastern (EDT, UTC−4) ──────────
const NY = 'America/New_York';
const at = (hm, day = '2026-10-08', off = '-04:00') => new Date(`${day}T${hm}:00${off}`).toISOString();
const ms = (hm, day, off) => Date.parse(at(hm, day, off));
const job = (id, start, extra = {}) => ({ id, startAt: start, endAt: null, status: 'upcoming', crewIds: [], coverFor: null, ...extra });
const punch = (id, user, name, inAt, outAt = null, extra = {}) => ({
  id, user_id: user, user_name: name, clock_in_at: inAt, clock_out_at: outAt,
  status: outAt ? 'completed' : 'in_progress', geofence_result: 'inside', job_id: null, ...extra,
});
const CHECKLIST_CLIENT = { crewChecklists: { u_carlos: 'it_floorcare' } };

// ── 1. ON SITE ────────────────────────────────────────────────────────────────
{
  const s = run({
    jobs: [job('j1', at('18:00'), { endAt: at('19:30'), crewIds: ['u_carlos', 'u_tomas', 'u_keisha'] })],
    punches: [
      punch('p1', 'u_carlos', 'Carlos Mendez', at('17:58'), null, { job_id: 'j1' }),
      punch('p2', 'u_tomas', 'Tomas Rivera', at('18:05'), null, { job_id: 'j1' }),
      punch('p3', 'u_keisha', 'Keisha Bryant', at('18:10'), null, { geofence_result: 'unavailable' }),
    ],
    checklists: [],
    client: CHECKLIST_CLIENT,
    upcoming: [job('j2', at('18:00', '2026-10-15'))],
    now: ms('18:30'),
    tz: NY,
  });
  ok('S1 an open punch at the building: "on site now"', () => s.state === 'on_site', show(s));
  ok('S2 …arrived at the FIRST clock-in', () => s.arrivedAt === at('17:58'), show(s));
  ok('S3 …two minutes early against the job the punch names', () => s.timeliness?.kind === 'early' && s.timeliness.minutes === 2, show(s?.timeliness));
  ok('S4 …the lead and how many more, first name + last initial ("Carlos M. + 2")',
    () => s.crew?.lead === hubPersonName('Carlos Mendez') && s.crew.others === 2 && s.crew.initials.join() === 'CM,TR,KB', show(s?.crew));
  ok('S5 …the scheduled start, no check-out yet', () => s.scheduledAt === at('18:00') && s.checkedOutAt === null, show(s));
  ok('S6 …the five steps: scheduled and checked in done, the checklist under way, the rest pending',
    () => keys(s) === 'scheduled,checked_in,checklist_progress,checklist_complete,checked_out'
      && step(s, 'scheduled').state === 'done' && step(s, 'checked_in').state === 'done' && step(s, 'checked_in').at === at('17:58')
      && step(s, 'checklist_progress').state === 'current' && step(s, 'checklist_complete').state === 'pending'
      && step(s, 'checked_out').state === 'pending', show(s?.timeline));
  ok('S7 🔴 the status is EXACTLY its allowlist, the crew and each step theirs',
    () => sameKeys(s, V.HUB_VISIT_STATUS_FIELDS) && sameKeys(s.crew, V.HUB_CREW_PEOPLE_FIELDS) && s.timeline.every((x) => sameKeys(x, V.HUB_TIMELINE_FIELDS)), show(s));
  ok('S8 🔴 no full name and no staff id leaves the rule', () => !!s && !/Mendez|Rivera|Bryant|u_carlos|u_tomas|u_keisha|p1|it_floorcare/.test(JSON.stringify(s)), JSON.stringify(s));
  ok('S9 the served crew band is the status less its timeline (HUB_CREW_FIELDS)',
    () => Array.isArray(V.HUB_CREW_FIELDS) && !V.HUB_CREW_FIELDS.includes('timeline') && sameKeys(V.projectHubCrew(s), V.HUB_CREW_FIELDS), show(V.HUB_CREW_FIELDS));
  ok('S10 …and "next" is the next visit, never the one under way', () => s.next?.startAt === at('18:00', '2026-10-15'), show(s?.next));
}

// ── 2. ARRIVING (and M1 ★: still neutral after the start has passed) ─────────
{
  const base = { jobs: [job('j1', at('18:00'), { crewIds: ['u_carlos'] })], punches: [], checklists: [], client: CHECKLIST_CLIENT, upcoming: [], tz: NY };
  const s = run({ ...base, now: ms('12:00') });
  ok('A1 a job today that nobody has punched into: "arriving today"', () => s.state === 'arriving' && s.scheduledAt === at('18:00'), show(s));
  ok('A2 …no arrival, no crew, no timeliness yet', () => s.arrivedAt === null && s.crew === null && s.timeliness === null, show(s));
  ok('A3 …"checked in" is the step under way, the rest pending', () => step(s, 'scheduled').state === 'done' && step(s, 'checked_in').state === 'current'
    && step(s, 'checked_out').state === 'pending', show(s?.timeline));
  const late = run({ ...base, now: ms('18:25') });
  ok('A4 🔴 M1 ★: past the start with nobody there is STILL "arriving" (the card says "Expected at"), never "late" or "missed"',
    () => late.state === 'arriving' && late.scheduledAt === at('18:00') && late.timeliness === null, show(late));
  for (const status of ['cancelled', 'missed']) {
    const s2 = run({ ...base, jobs: [job('j1', at('18:00'), { status })], now: ms('12:00') });
    ok(`A5 a ${status} visit is not a visit: "no visit today"`, () => s2.state === 'none', show(s2));
  }
}

// ── 3. DONE ───────────────────────────────────────────────────────────────────
{
  const s = run({
    jobs: [job('j1', at('18:00'), { crewIds: ['u_carlos', 'u_tomas'], status: 'done' })],
    punches: [
      punch('p1', 'u_carlos', 'Carlos Mendez', at('17:58'), at('20:12'), { job_id: 'j1' }),
      punch('p2', 'u_tomas', 'Tomas Rivera', at('18:05'), at('20:00'), { job_id: 'j1' }),
    ],
    checklists: [{ id: 'c1', job_id: 'j1', completed_by_user_id: 'u_carlos', completed_count: 8, total_count: 8, performed_at: at('20:05') }],
    client: CHECKLIST_CLIENT,
    upcoming: [],
    now: ms('21:00'),
    tz: NY,
  });
  ok('D1 everyone clocked out today and nothing later today: "visit complete"', () => s.state === 'done', show(s));
  ok('D2 …checked out at the LAST clock-out, arrived at the first', () => s.checkedOutAt === at('20:12') && s.arrivedAt === at('17:58'), show(s));
  ok('D3 …the crew who came, first name + last initial', () => s.crew?.lead === 'Carlos M.' && s.crew.others === 1, show(s?.crew));
  ok('D4 …every step done; the checklist complete at its save, with its count ("8 of 8 items")',
    () => (s.timeline || []).every((x) => x.state === 'done') && step(s, 'checklist_complete').at === at('20:05')
      && step(s, 'checklist_complete').done === 8 && step(s, 'checklist_complete').total === 8 && step(s, 'checked_out').at === at('20:12'), show(s?.timeline));
}

// ── 4. NONE ───────────────────────────────────────────────────────────────────
{
  const s = run({ jobs: [], punches: [], checklists: [], client: {}, upcoming: [job('j9', at('18:00', '2026-10-10'))], now: ms('12:00'), tz: NY });
  ok('N1 no visit today: "no visit today", with the next visit', () => s.state === 'none' && s.next?.startAt === at('18:00', '2026-10-10'), show(s));
  ok('N2 …and no timeline at all', () => Array.isArray(s.timeline) && s.timeline.length === 0, show(s?.timeline));
  const empty = run({ jobs: [], punches: [], checklists: [], client: {}, upcoming: [], now: ms('12:00'), tz: NY });
  ok('N3 nothing scheduled ahead: next is null ("No upcoming visits scheduled")', () => empty.state === 'none' && empty.next === null, show(empty));
  const tomorrow = run({ jobs: [job('jt', at('09:00', '2026-10-09'))], punches: [], checklists: [], client: {}, upcoming: [], now: ms('12:00'), tz: NY });
  ok('N4 a job tomorrow is not "arriving today"', () => tomorrow.state === 'none', show(tomorrow));
}

// ── 5. TWO VISITS IN ONE DAY ──────────────────────────────────────────────────
{
  const morning = job('jA', at('08:00'), { status: 'done' });
  const evening = job('jB', at('18:00'));
  const amPunch = punch('pA', 'u_carlos', 'Carlos Mendez', at('07:58'), at('09:30'), { job_id: 'jA' });
  const noon = run({ jobs: [morning, evening], punches: [amPunch], checklists: [], client: {}, upcoming: [], now: ms('12:00'), tz: NY });
  ok('T1 🔴 the morning visit is done and the evening one is ahead: the LATER unstarted one wins ("arriving")',
    () => noon.state === 'arriving' && noon.scheduledAt === at('18:00'), show(noon));
  const pmPunch = punch('pB', 'u_tomas', 'Tomas Rivera', at('17:59'), at('20:12'), { job_id: 'jB' });
  const night = run({ jobs: [morning, { ...evening, status: 'done' }], punches: [amPunch, pmPunch], checklists: [], client: {}, upcoming: [], now: ms('21:00'), tz: NY });
  ok('T2 …and once the evening visit is checked out, "visit complete" is THAT visit',
    () => night.state === 'done' && night.scheduledAt === at('18:00') && night.checkedOutAt === at('20:12') && night.crew?.lead === 'Tomas R.', show(night));
  const skipped = run({ jobs: [job('jA', at('08:00')), evening], punches: [pmPunch], checklists: [], client: {}, upcoming: [], now: ms('21:00'), tz: NY });
  ok('T3 an unstarted visit EARLIER than the day\'s last check-out is not "arriving" at night', () => skipped.state === 'done', show(skipped));
}

// ── 6. A NIGHT CLEAN ACROSS MIDNIGHT ─────────────────────────────────────────
{
  const night = job('jN', at('22:00', '2026-10-07'), { crewIds: ['u_carlos'] });
  const open = punch('pN', 'u_carlos', 'Carlos Mendez', at('21:58', '2026-10-07'), null, { job_id: 'jN' });
  const s = run({ jobs: [night], punches: [open], checklists: [], client: {}, upcoming: [], now: ms('01:00'), tz: NY });
  ok('X1 🔴 a visit that began yesterday and is still going at 1 AM is "on site now"', () => s.state === 'on_site', show(s));
  ok('X2 …arrived yesterday, two minutes early against YESTERDAY\'s job it names', () => s.arrivedAt === at('21:58', '2026-10-07')
    && s.timeliness?.kind === 'early' && s.timeliness.minutes === 2 && s.scheduledAt === at('22:00', '2026-10-07'), show(s));
  const closed = { ...open, clock_out_at: at('02:30'), status: 'completed' };
  const after = run({ jobs: [{ ...night, status: 'done' }], punches: [closed], checklists: [], client: {}, upcoming: [], now: ms('03:00'), tz: NY });
  ok('X3 …and checked out at 2:30 AM, it is "visit complete" this morning', () => after.state === 'done' && after.checkedOutAt === at('02:30'), show(after));
}

// ── 7. DST: a 25-hour day and a 23-hour day (org zone) ───────────────────────
{
  // 2026-11-01 New York falls back at 2:00 EDT → 1:00 EST: the day is 25 hours long. A visit at
  // 00:10 EDT, checked out at 00:30 EDT, is 24h20m before 23:50 EST — outside a naive "last 24
  // hours", inside the org's day.
  const s = run({
    jobs: [job('jD', at('00:10', '2026-11-01'), { status: 'done' })],
    punches: [punch('pD', 'u_carlos', 'Carlos Mendez', at('00:05', '2026-11-01'), at('00:30', '2026-11-01'), { job_id: 'jD' })],
    checklists: [], client: {}, upcoming: [],
    now: ms('23:50', '2026-11-01', '-05:00'), tz: NY,
  });
  ok('Z1 🔴 on the 25-hour day a visit checked out at 00:30 is still TODAY\'s visit complete at 23:50', () => s.state === 'done' && s.checkedOutAt === at('00:30', '2026-11-01'), show(s));
  // 2027-03-14 springs forward: a 23-hour day. A visit at 00:30 the NEXT day is not today's.
  const spring = run({
    jobs: [job('jS', at('00:30', '2027-03-15'))], punches: [], checklists: [], client: {}, upcoming: [],
    now: ms('23:00', '2027-03-14'), tz: NY,
  });
  ok('Z2 🔴 on the 23-hour day a visit at 00:30 tomorrow is not "arriving today"', () => spring.state === 'none', show(spring));
  const springToday = run({
    jobs: [job('jS2', at('23:30', '2027-03-14'))], punches: [], checklists: [], client: {}, upcoming: [],
    now: ms('23:00', '2027-03-14'), tz: NY,
  });
  ok('Z3 …and one at 23:30 the same day is', () => springToday.state === 'arriving', show(springToday));
}

// ── 8. THE ORG ZONE, NOT THE SERVER'S (process TZ = UTC+14) ──────────────────
{
  const LA = 'America/Los_Angeles';
  const now = Date.parse('2026-10-08T20:00:00-07:00'); // Oct 9 in UTC and in Kiritimati
  const tonight = run({ jobs: [job('jL', '2026-10-08T21:00:00-07:00')], punches: [], checklists: [], client: {}, upcoming: [], now, tz: LA });
  ok('Z4 🔴 a 9 PM visit in Los Angeles is "arriving today" though it is already tomorrow in UTC and on the server', () => tonight.state === 'arriving', show(tonight));
  const tomorrowLA = run({ jobs: [job('jL2', '2026-10-09T09:00:00-07:00')], punches: [], checklists: [], client: {}, upcoming: [], now, tz: LA });
  ok('Z5 🔴 …and a 9 AM visit tomorrow in Los Angeles is not, though UTC calls it the same day', () => tomorrowLA.state === 'none', show(tomorrowLA));
}

// ── 9. EARLY, ON TIME, LATE ───────────────────────────────────────────────────
{
  const at18 = job('j1', at('18:00'));
  const t = (inAt, extra = {}) => run({ jobs: [at18], punches: [punch('p', 'u_carlos', 'Carlos Mendez', inAt, null, { job_id: 'j1', ...extra })], checklists: [], client: {}, upcoming: [], now: ms('18:45'), tz: NY })?.timeliness;
  ok('E1 five minutes before the start is "5 min early"', () => t(at('17:55'))?.kind === 'early' && t(at('17:55')).minutes === 5, show(t(at('17:55'))));
  ok(`E2 within ${V.HUB_ON_TIME_MINUTES} minute either side is "on time"`, () => V.HUB_ON_TIME_MINUTES === 1
    && t('2026-10-08T21:59:10.000Z')?.kind === 'on_time' && t(at('18:01'))?.kind === 'on_time', show([t('2026-10-08T21:59:10.000Z'), t(at('18:01'))]));
  const late = t(at('18:02'));
  ok('E3 🔴 later than that is "late" with NO minutes (M1 ★: lateness is never shown, only the time)', () => late?.kind === 'late' && late.minutes === null, show(late));
  // The job the punch NAMES, not the nearest: 18:25 against the 18:00 job is late, though the 18:30
  // job is five minutes away.
  const two = [job('jX', at('18:00')), job('jY', at('18:30'))];
  const named = run({ jobs: two, punches: [punch('p', 'u_carlos', 'Carlos Mendez', at('18:25'), null, { job_id: 'jX' })], checklists: [], client: {}, upcoming: [], now: ms('18:45'), tz: NY });
  ok('E4 timeliness reads the job the punch NAMES (time_entries.job_id)', () => named.timeliness?.kind === 'late' && named.scheduledAt === at('18:00'), show(named));
  const nearest = run({ jobs: two, punches: [punch('p', 'u_carlos', 'Carlos Mendez', at('18:27'), null, { job_id: null })], checklists: [], client: {}, upcoming: [], now: ms('18:45'), tz: NY });
  ok('E5 …else today\'s NEAREST job', () => nearest.timeliness?.kind === 'early' && nearest.timeliness.minutes === 3 && nearest.scheduledAt === at('18:30'), show(nearest));
  const unscheduled = run({ jobs: [], punches: [punch('p', 'u_carlos', 'Carlos Mendez', at('18:27'))], checklists: [], client: {}, upcoming: [], now: ms('18:45'), tz: NY });
  ok('E6 an unscheduled visit is on site with no timeliness and no "scheduled" step',
    () => unscheduled.state === 'on_site' && unscheduled.timeliness === null && unscheduled.scheduledAt === null && !keys(unscheduled).includes('scheduled'), show(unscheduled));
}

// ── 10. THE CHECKLIST STEPS: only when one is expected; no live count ────────
{
  const base = { jobs: [job('j1', at('18:00'), { crewIds: ['u_tomas'] })], punches: [punch('p', 'u_tomas', 'Tomas Rivera', at('17:58'), null, { job_id: 'j1' })], upcoming: [], now: ms('18:30'), tz: NY };
  const none = run({ ...base, checklists: [], client: {} });
  ok('C1 🔴 nobody on the crew resolves to a checklist and none was saved: NO checklist steps', () => keys(none) === 'scheduled,checked_in,checked_out', show(none?.timeline));
  const own = run({ ...base, checklists: [], client: { crewChecklists: { u_tomas: 'it_fullclean' } } });
  ok('C2 a cleaner on the crew holds one (checklistFor): the two checklist steps appear', () => keys(own).includes('checklist_progress') && keys(own).includes('checklist_complete'), show(own?.timeline));
  const cover = run({ ...base, jobs: [job('j1', at('18:00'), { crewIds: ['u_tomas'], coverFor: { u_tomas: 'u_andre' } })], checklists: [], client: { crewChecklists: { u_andre: 'it_floorcare' } } });
  ok('C3 a cover cleaner takes the covered cleaner\'s checklist (checklistFor), so it is expected', () => keys(cover).includes('checklist_complete'), show(cover?.timeline));
  const saved = run({ ...base, checklists: [{ id: 'c1', job_id: null, completed_by_user_id: 'u_tomas', completed_count: 10, total_count: 12, performed_at: at('18:20') }], client: {} });
  ok('C4 a checklist saved during the visit puts the steps up even with no rule, and completes them', () => step(saved, 'checklist_complete')?.state === 'done'
    && step(saved, 'checklist_complete').done === 10 && step(saved, 'checklist_complete').total === 12 && step(saved, 'checklist_progress').state === 'done', show(saved?.timeline));
  const before = run({ ...base, checklists: [{ id: 'c0', job_id: null, completed_by_user_id: 'u_x', completed_count: 5, total_count: 5, performed_at: at('09:00') }], client: { crewChecklists: { u_tomas: 'it_fullclean' } } });
  ok('C5 a checklist saved BEFORE this visit began is not this visit\'s', () => step(before, 'checklist_complete')?.state === 'pending' && step(before, 'checklist_progress').state === 'current', show(before?.timeline));
  ok('C6 🔴 no step carries a live item count while the checklist is under way', () => step(own, 'checklist_progress').done === null && step(own, 'checklist_progress').total === null, show(step(own, 'checklist_progress')));
}

// ── 11. A VOIDED OR NO-SHOW PUNCH IS NEVER AN ARRIVAL (hubOnSiteList's rule) ──
{
  const base = { jobs: [job('j1', at('18:00'))], checklists: [], client: {}, upcoming: [], now: ms('18:30'), tz: NY };
  const voided = run({ ...base, punches: [punch('p', 'u_carlos', 'Carlos Mendez', at('17:58'), null, { job_id: 'j1', status: 'voided' })] });
  ok('V1 🔴 an open but VOIDED punch is nobody on site, and the visit is still ahead', () => voided.state === 'arriving' && voided.crew === null, show(voided));
  const noShow = run({ ...base, punches: [punch('p', 'u_carlos', 'Carlos Mendez', at('17:58'), at('18:10'), { job_id: 'j1', status: 'no_show' })] });
  ok('V2 🔴 a closed NO-SHOW punch is not a visit complete', () => noShow.state === 'arriving', show(noShow));
  const forgotten = run({ ...base, jobs: [], punches: [punch('p', 'u_carlos', 'Carlos Mendez', at('09:00', '2026-10-07'))] });
  ok('V3 an open punch older than the on-site window is a forgotten clock-out, not someone on site', () => forgotten.state === 'none', show(forgotten));
}

// ── 12. UPCOMING VISITS, and the Home tiles' small rules ──────────────────────
{
  const now = ms('12:00');
  const list = typeof V.hubUpcomingVisits === 'function' ? V.hubUpcomingVisits([
    job('a', at('18:00', '2026-10-20')), job('b', at('11:00')), job('c', at('18:00', '2026-10-13')),
    job('d', at('18:00', '2026-10-16')), job('e', at('18:00', '2026-10-14'), { status: 'cancelled' }), job('f', at('18:00', '2026-10-30')),
  ], { now }) : null;
  ok(`U1 the next ${V.HUB_UPCOMING_MAX} upcoming visits, soonest first, never a past or cancelled one`,
    () => V.HUB_UPCOMING_MAX === 3 && list.map((x) => x.startAt).join() === [at('18:00', '2026-10-13'), at('18:00', '2026-10-16'), at('18:00', '2026-10-20')].join()
      && list.every((x) => sameKeys(x, V.HUB_UPCOMING_FIELDS)), show(list));
  const tile = typeof H.hubChecklistTile === 'function' ? H.hubChecklistTile([
    { id: 'k1', completed_count: 4, total_count: 4, performed_at: at('09:00') },
    { id: 'k2', completed_count: 3, total_count: 4, performed_at: at('11:00') },
    { id: 'k0', completed_count: 8, total_count: 8, performed_at: at('22:00', '2026-10-07') },
  ], { now, tz: NY }) : null;
  ok('U2 the Checklists tile sums TODAY\'s saves in the org zone ("7 of 8 done today")', () => tile?.today?.done === 7 && tile.today.total === 8 && tile.today.count === 2 && tile.today.onlyId === null, show(tile));
  const one = typeof H.hubChecklistTile === 'function' ? H.hubChecklistTile([{ id: 'k1', completed_count: 4, total_count: 4, performed_at: at('09:00') }], { now, tz: NY }) : null;
  ok('U3 …with exactly one today, "View today" opens it', () => one?.today?.onlyId === 'k1', show(one));
  const yday = typeof H.hubChecklistTile === 'function' ? H.hubChecklistTile([{ id: 'k0', completed_count: 8, total_count: 8, performed_at: at('22:00', '2026-10-07') }], { now, tz: NY }) : null;
  ok('U4 …none today: the last one ("Last: 8 of 8 · Oct 7")', () => yday?.today?.count === 0 && yday.last?.done === 8 && yday.last.performedAt === at('22:00', '2026-10-07'), show(yday));
}

console.log(`\nhub visit status: ${pass}/${pass + fails.length} passed`);
if (fails.length) { for (const f of fails) console.error(`  FAIL: ${f}`); process.exitCode = 1; }
