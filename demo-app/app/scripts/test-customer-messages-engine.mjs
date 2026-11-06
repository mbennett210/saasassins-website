// THE CUSTOMER-MESSAGE WALKERS, message by message (Matt's approved messages, 2026-10-19).
//
// src/lib/reminderScheduler.js getDueMessages decides what is due now; this suite drives it with
// every template ON and pins, for EACH message:
//   · it fires on its own event, once (one key per occurrence — the sent log's dedupe identity);
//   · 🔴 NO BACK-BLAST: the same event older than its bound produces nothing, so switching the
//     template on never sends about the past;
//   · the send window on the ORG's clock (09:00–19:00), except the receipts marked immediate;
//   · consent (Do Not Contact, the reminders opt-out, the marketing suppression for nudges), a
//     customer we no longer serve, no address on file.
// It also pins the stamps the change notices fire on (lib/visitChanges through the reducer).
// It carries over test-reminder-cron.mjs's cases (the flood guard, the freshness bound, the
// org-zone hour, DNC / opt-out / suppression on the resolved recipient), which it replaces.
//
// Bounds and hours are read from lib/customerMessages.js, never restated (THE LAW II.3).
// REGRESSION: on 811e54eb there is no getDueMessages (and no visit summary, missed-visit,
// reschedule or cancellation walker, no stamps) — every check fails.
//   node app/scripts/test-customer-messages-engine.mjs
import { JOB_STATUS } from '../src/lib/jobStatus.js';
import { loadStore } from './deletion-core.mjs';

const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };
const RS = await soft('../src/lib/reminderScheduler.js');
const CM = await soft('../src/lib/customerMessages.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };
const due = typeof RS.getDueMessages === 'function' ? RS.getDueMessages : () => [];
ok('getDueMessages exists', typeof RS.getDueMessages === 'function', RS.__error || CM.__error);
const mk = (...a) => (typeof RS.messageKey === 'function' ? RS.messageKey(...a) : '?');
const fmtT = (...a) => (typeof RS.fmtCustomerTime === 'function' ? RS.fmtCustomerTime(...a) : '?');
const fmtD = (...a) => (typeof RS.fmtCustomerDate === 'function' ? RS.fmtCustomerDate(...a) : '?');
const K = CM.MESSAGE_KEY || {};
const HOUR = 3600e3;
const MAX_AGE = (CM.EVENT_MAX_AGE_HOURS || 48) * HOUR;

// 12:00 in Los Angeles (19:00 UTC) — inside the window; 03:00 LA is outside it.
const TZ = 'America/Los_Angeles';
const NOW = new Date('2026-11-04T20:00:00.000Z');        // Wed 12:00 PST
const NIGHT = new Date('2026-11-04T11:00:00.000Z');      // Wed 03:00 PST
const iso = (ms) => new Date(ms).toISOString();
const ago = (h, now = NOW) => iso(now.getTime() - h * HOUR);
const ahead = (h, now = NOW) => iso(now.getTime() + h * HOUR);

const allOn = () => (CM.DEFAULT_REMINDER_TEMPLATES || []).map((t) => ({ ...t, enabled: true }));
function book(overrides = {}) {
  return {
    company: { name: 'Clean Co', email: 'office@clean.test', phone: '555-0100', timezone: TZ },
    reminderTemplates: allOn(),
    clients: [{ id: 'cl1', name: 'Acme Tower', email: 'acme@corp.test', phone: '+15555550001', primaryContactId: 'ct1', supervisorId: 'u1' }],
    contacts: [{ id: 'ct1', firstName: 'Ann', lastName: 'Lee', email: 'ann@corp.test', phone: '+15555550002', companyId: 'cl1' }],
    sites: [{ id: 's1', clientId: 'cl1', name: 'Acme Tower, Lobby' }],
    services: [{ id: 'sv1', name: 'Janitorial' }],
    users: [{ id: 'u1', name: 'Renata Cruz', role: 'manager', status: 'active' }],
    marketingSuppressions: [],
    ...overrides,
  };
}
const job = (o) => ({ id: 'j1', clientId: 'cl1', siteId: 's1', serviceId: 'sv1', crewIds: ['u9'], seriesId: null, recurrence: null, ...o });
const run = (jobs, { state = book(), now = NOW } = {}) => due({ state, jobs }, now);
const keys = (items) => items.map((d) => d.templateKey);
const one = (items, key) => items.filter((d) => d.templateKey === key);

// ── the booking confirmation ─────────────────────────────────────────────────
{
  const fresh = job({ status: JOB_STATUS.UPCOMING, startAt: ahead(30), endAt: ahead(32), createdAt: ago(1) });
  const b = one(run([fresh]), K.bookingConfirmation);
  ok('BC1 a clean booked an hour ago gets ONE booking confirmation, to the main contact', b.length === 1 && b[0].recipient === 'ann@corp.test', b);
  ok('BC2 its key is the booking (stable: the same clean, the same id)', b[0]?.id === mk(K.bookingConfirmation, 'j1') && one(run([fresh]), K.bookingConfirmation)[0]?.id === b[0]?.id);
  ok('🔴 BC3 no back-blast: a clean booked longer ago than EVENT_MAX_AGE_HOURS gets none', one(run([{ ...fresh, createdAt: iso(NOW.getTime() - MAX_AGE - HOUR) }]), K.bookingConfirmation).length === 0);
  ok('BC4 a clean with no booking time is treated as old (none)', one(run([{ ...fresh, createdAt: undefined }]), K.bookingConfirmation).length === 0);
  ok('BC5 a receipt is immediate: it goes at 3 a.m. too', one(run([{ ...fresh, createdAt: ago(1, NIGHT) }], { now: NIGHT }), K.bookingConfirmation).length === 1);
  const series = Array.from({ length: 6 }, (_, i) => job({ id: `js${i}`, seriesId: 'ser1', recurrence: i === 0 ? { frequency: 'weekly', daysOfWeek: [3] } : null, status: JOB_STATUS.UPCOMING, startAt: ahead(30 + i * 168), endAt: ahead(32 + i * 168), createdAt: ago(1) }));
  const bs = one(run(series, { state: book({ reminderTemplates: allOn().filter((t) => t.key !== K.serviceSetup) }) }), K.bookingConfirmation);
  ok('BC6 a recurring schedule of six visits is ONE booking, keyed by the series', bs.length === 1 && bs[0].id === mk(K.bookingConfirmation, 'ser1'), bs.map((d) => d.id));
  const withSetup = one(run(series), K.bookingConfirmation);
  ok('BC7 with the service-setup email on, a schedule\'s booking asks the cron "is this their first schedule?" (then setup goes instead)', withSetup[0]?.check?.kind === 'firstSeries' && withSetup[0]?.check?.when === 'notFirst');
  ok('BC8 a clean already cancelled or done is not a booking', one(run([{ ...fresh, status: JOB_STATUS.CANCELLED }]), K.bookingConfirmation).length === 0);
}

// ── the 24-hour and day-of texts ─────────────────────────────────────────────
{
  const tomorrow = job({ status: JOB_STATUS.UPCOMING, startAt: '2026-11-05T22:00:00.000Z', endAt: '2026-11-05T23:00:00.000Z', createdAt: ago(200) }); // Thu 14:00 PST
  const r = run([tomorrow]);
  ok('TX1 the day before, in the window: the 24-hour text, to the contact\'s phone', one(r, K.reminder24h).length === 1 && one(r, K.reminder24h)[0].recipient === '+15555550002' && one(r, K.reminder24h)[0].channel === 'sms', keys(r));
  ok('TX2 …and not the day-of text', one(r, K.dayOfEta).length === 0);
  ok('TX3 not at 3 a.m. (texts keep the window too)', one(run([tomorrow], { now: NIGHT }), K.reminder24h).length === 0);
  const today = job({ id: 'j2', status: JOB_STATUS.UPCOMING, startAt: '2026-11-05T02:00:00.000Z', endAt: '2026-11-05T03:00:00.000Z', createdAt: ago(200) }); // Wed 18:00 PST
  ok('TX4 the clean\'s own day, within 12 hours: the day-of text', one(run([today]), K.dayOfEta).length === 1);
  const early = job({ id: 'j3', status: JOB_STATUS.UPCOMING, startAt: '2026-11-05T13:00:00.000Z', endAt: '2026-11-05T14:00:00.000Z', createdAt: ago(200) }); // Thu 05:00 PST
  ok('TX5 a clean at 5 a.m. tomorrow gets the day-before text only (no in-window moment on its own day)', one(run([early]), K.reminder24h).length === 1 && one(run([early]), K.dayOfEta).length === 0);
  const later = job({ id: 'j4', status: JOB_STATUS.UPCOMING, startAt: ahead(24 * 5), endAt: ahead(24 * 5 + 1), createdAt: ago(200) });
  ok('TX6 a clean five days out gets neither text yet', one(run([later]), K.reminder24h).length + one(run([later]), K.dayOfEta).length === 0);
  const started = job({ id: 'j5', status: JOB_STATUS.UPCOMING, startAt: ago(1), endAt: ahead(1), createdAt: ago(200) });
  ok('🔴 TX7 no back-blast: a clean that has already started gets neither text', one(run([started]), K.reminder24h).length + one(run([started]), K.dayOfEta).length === 0);
}

// ── the finished clean: check-in and summary ─────────────────────────────────
{
  const done = job({ status: JOB_STATUS.DONE, startAt: ago(4), endAt: ago(2), createdAt: ago(300) });
  const r = run([done]);
  const ps = one(r, K.postService);
  const vs = one(r, K.visitSummary);
  ok('FC1 a clean finished two hours ago: the first-clean check-in, keyed once per CUSTOMER', ps.length === 1 && ps[0].id === mk(K.postService, 'cl1'), ps);
  ok('FC2 …which asks the cron to confirm it is their first finished clean', ps[0]?.check?.kind === 'firstClean' && ps[0]?.check?.when === 'first');
  ok('FC3 the visit summary, one per clean — asked to go only when this is NOT the first (one email after a first visit)', vs.length === 1 && vs[0].id === mk(K.visitSummary, 'j1') && vs[0].check?.when === 'notFirst');
  const noCheckIn = one(run([done], { state: book({ reminderTemplates: allOn().filter((t) => t.key !== K.postService) }) }), K.visitSummary);
  ok('FC4 with the check-in off, the summary goes on every clean, no check', noCheckIn.length === 1 && !noCheckIn[0].check);
  ok('🔴 FC5 no back-blast: a clean finished longer ago than EVENT_MAX_AGE_HOURS gets neither', run([{ ...done, startAt: iso(NOW.getTime() - MAX_AGE - 3 * HOUR), endAt: iso(NOW.getTime() - MAX_AGE - HOUR) }]).length === 0);
  ok('FC6 a "finished" clean ending in the future is a mis-set status: nothing', run([{ ...done, endAt: ahead(2) }]).length === 0);
  const overnight = job({ status: JOB_STATUS.DONE, startAt: ago(4, NIGHT), endAt: ago(1, NIGHT) });
  ok('FC7 an overnight clean: nothing at 3 a.m. …', run([overnight], { now: NIGHT }).length === 0);
  ok('FC8 …and its summary at 9 a.m.', one(run([overnight], { now: new Date('2026-11-04T17:00:00.000Z') }), K.visitSummary).length === 1);
  ok('FC9 the summary\'s words are the template\'s, filled (site, first name)', /Acme Tower, Lobby/.test(vs[0]?.body || '') && /^Hi Ann,/.test(vs[0]?.body || ''), vs[0]?.body);
  ok('FC10 the check-in is a nudge: it carries the opt-out line', /To stop these emails/.test(ps[0]?.body || ''), ps[0]?.body);
  ok('FC11 the summary is a receipt: no opt-out line', !/To stop these emails/.test(vs[0]?.body || ''));
}

// ── the missed visit ─────────────────────────────────────────────────────────
{
  const graceMs = (RS.DEFAULT_CLOCK_IN_GRACE_MINS || 120) * 60e3;
  const missed = job({ status: JOB_STATUS.UPCOMING, startAt: iso(NOW.getTime() - graceMs - 3 * HOUR), endAt: iso(NOW.getTime() - graceMs - HOUR) });
  const r = one(run([missed]), K.missedVisit);
  ok('MV1 a clean whose end and clock-in window have passed, never started: the apology, asking "did nobody clock in?"', r.length === 1 && r[0].check?.kind === 'noPunch' && r[0].check.jobId === 'j1', r);
  ok('MV2 not while the clock-in window is still open (a cover may still arrive)', one(run([{ ...missed, endAt: iso(NOW.getTime() - graceMs + HOUR) }]), K.missedVisit).length === 0);
  ok('MV3 the office\'s own grace is honoured (opsSettings.autoCloseGraceMins)', one(run([missed], { state: book({ opsSettings: { autoCloseGraceMins: 600 } }) }), K.missedVisit).length === 0);
  ok('🔴 MV4 no back-blast: a clean missed days ago gets nothing', one(run([{ ...missed, startAt: iso(NOW.getTime() - MAX_AGE - graceMs - 5 * HOUR), endAt: iso(NOW.getTime() - MAX_AGE - graceMs - 2 * HOUR) }]), K.missedVisit).length === 0);
  ok('MV5 a clean in progress or done is not missed', one(run([{ ...missed, status: JOB_STATUS.IN_PROGRESS }]), K.missedVisit).length + one(run([{ ...missed, status: JOB_STATUS.DONE }]), K.missedVisit).length === 0);
  ok('MV6 a clean the office marked missed counts', one(run([{ ...missed, status: JOB_STATUS.MISSED }]), K.missedVisit).length === 1);
}

// ── the reschedule and cancellation notices ──────────────────────────────────
{
  const moved = job({ status: JOB_STATUS.UPCOMING, startAt: ahead(50), endAt: ahead(52), rescheduledAt: ago(1), rescheduledFrom: ahead(26) });
  const r = one(run([moved]), K.reschedule);
  ok('RS1 a future clean moved an hour ago: one reschedule notice, with the NEW date and time', r.length === 1 && r[0].tokens.time === fmtT(moved.startAt, TZ) && r[0].body.includes(fmtD(moved.startAt, TZ)), r[0]?.body);
  ok('RS2 its key carries the change, so a later move is a new notice', r[0]?.id === mk(K.reschedule, 'j1', Date.parse(moved.rescheduledAt)));
  ok('🔴 RS3 no back-blast: a move stamped longer ago than EVENT_MAX_AGE_HOURS is not news', one(run([{ ...moved, rescheduledAt: iso(NOW.getTime() - MAX_AGE - HOUR) }]), K.reschedule).length === 0);
  ok('RS4 a move the server put back (start = where it moved from) is no change', one(run([{ ...moved, rescheduledFrom: moved.startAt }]), K.reschedule).length === 0);
  ok('RS5 a clean that has already happened is not rescheduled news', one(run([{ ...moved, startAt: ago(1), endAt: ahead(1) }]), K.reschedule).length === 0);
  const twelve = Array.from({ length: 12 }, (_, i) => job({ id: `jm${i}`, seriesId: 'ser1', status: JOB_STATUS.UPCOMING, startAt: ahead(50 + (11 - i) * 168), endAt: ahead(52 + (11 - i) * 168), rescheduledAt: ago(1), rescheduledFrom: ahead(30 + (11 - i) * 168) }));
  const r12 = one(run(twelve), K.reschedule);
  ok('RS6 a series edit that moved twelve visits: ONE notice, about the NEXT visit', r12.length === 1 && r12[0].refs.jobId === 'jm11', r12.map((d) => d.refs.jobId));
  ok('RS7 …and it settles the other eleven, so none goes later', (r12[0]?.settles || []).length === 11 && r12[0].settles.every((s) => s.templateKey === K.reschedule));
  const cancelled = job({ status: JOB_STATUS.CANCELLED, startAt: ahead(50), endAt: ahead(52), cancelledAt: ago(2) });
  ok('CX1 a future clean cancelled two hours ago: the cancellation notice', one(run([cancelled]), K.cancellation).length === 1);
  ok('🔴 CX2 no back-blast: cancelled longer ago than EVENT_MAX_AGE_HOURS: nothing', one(run([{ ...cancelled, cancelledAt: iso(NOW.getTime() - MAX_AGE - HOUR) }]), K.cancellation).length === 0);
  ok('CX3 a cancellation with no stamp (cancelled before this build) is never news', one(run([{ ...cancelled, cancelledAt: undefined }]), K.cancellation).length === 0);
  ok('CX4 a past clean cancelled after the fact is not news to the customer', one(run([{ ...cancelled, startAt: ago(3), endAt: ago(2) }]), K.cancellation).length === 0);
}

// ── a clean the office is entering (task 477, "Quiet on entry day") ──────────
// REGRESSION (THE LAW II.3): on ba2d6fc7 EN1, EN2, EN4, EN5, EN7, EN9, EN11, EN13 and EN14 fail — the
// apology, the 24-hour and day-of texts, the summary and check-in, the reschedule and cancellation
// notices and the upsell all went about a clean the office had only just entered.
{
  // The 2026-11-03 incident, at its own times: a weekday schedule entered at 1:49:02 PM Eastern
  // (Wylden at Citrus Park), its first visit 9:00–10:30 that morning, its next 9:00 the next day;
  // the run at 1:50:50 PM sent the apology for the first and the 24-hour text for the next.
  const NY = book({ company: { ...book().company, timezone: 'America/New_York' } });
  const RUN = new Date('2026-11-03T18:50:50.000Z');
  const ENTERED = '2026-11-03T18:49:02.667Z';
  const first = job({ id: 'j_first', seriesId: 'ser_w', status: JOB_STATUS.UPCOMING, startAt: '2026-11-03T14:00:00.000Z', endAt: '2026-11-03T15:30:00.000Z', createdAt: ENTERED });
  const next = job({ id: 'j_next', seriesId: 'ser_w', status: JOB_STATUS.UPCOMING, startAt: '2026-11-04T14:00:00.000Z', endAt: '2026-11-04T15:30:00.000Z', createdAt: ENTERED });
  const replay = run([first, next], { state: NY, now: RUN });
  ok('🔴 EN1 the incident replayed: no missed-visit apology for a clean entered after its start', one(replay, K.missedVisit).length === 0, replay.map((d) => d.id));
  ok('🔴 EN2 the incident replayed: no 24-hour text for tomorrow\'s clean entered today', one(replay, K.reminder24h).length === 0, replay.map((d) => d.id));
  const yesterday = '2026-11-02T15:00:00.000Z';
  const before = run([{ ...first, createdAt: yesterday }, { ...next, createdAt: yesterday }], { state: NY, now: RUN });
  ok('EN3 the same two cleans entered the day before: the apology and the 24-hour text both go (the rules still work)', one(before, K.missedVisit).length === 1 && one(before, K.reminder24h).length === 1, before.map((d) => d.id));
  const afternoon = { ...next, id: 'j_pm', startAt: '2026-11-04T19:00:00.000Z', endAt: '2026-11-04T20:00:00.000Z' };   // 2 PM Eastern tomorrow
  ok('EN4 entered today for 2 PM tomorrow: no 24-hour text today, the day-of text tomorrow morning', one(run([afternoon], { state: NY, now: RUN }), K.reminder24h).length === 0 && one(run([afternoon], { state: NY, now: new Date('2026-11-04T15:00:00.000Z') }), K.dayOfEta).length === 1);
  const tonight = job({ id: 'j_tonight', status: JOB_STATUS.UPCOMING, startAt: '2026-11-04T01:30:00.000Z', endAt: '2026-11-04T03:00:00.000Z', createdAt: '2026-11-03T23:48:48.359Z' });
  ok('🔴 EN5 entered at 6:48 PM for 8:30 PM the same evening: no day-of text', one(run([tonight], { state: NY, now: new Date('2026-11-03T23:50:49.000Z') }), K.dayOfEta).length === 0);
  const graceMs = (RS.DEFAULT_CLOCK_IN_GRACE_MINS || 120) * 60e3;
  const missed = job({ status: JOB_STATUS.UPCOMING, startAt: iso(NOW.getTime() - graceMs - 3 * HOUR), endAt: iso(NOW.getTime() - graceMs - HOUR) });
  ok('EN6 entered a minute before its start, nobody came: the apology still goes', one(run([{ ...missed, createdAt: iso(Date.parse(missed.startAt) - 60e3) }]), K.missedVisit).length === 1);
  ok('🔴 EN7 moved to a time already past (rescheduledAt after its start): no apology, the same as entering it there', one(run([{ ...missed, createdAt: ago(300), rescheduledAt: iso(Date.parse(missed.startAt) + 30 * 60e3), rescheduledFrom: ahead(24) }]), K.missedVisit).length === 0);
  const done = job({ status: JOB_STATUS.DONE, startAt: ago(4), endAt: ago(2) });
  ok('EN8 a clean entered before it ended and finished: the check-in and the summary as before', one(run([{ ...done, createdAt: ago(5) }]), K.postService).length === 1 && one(run([{ ...done, createdAt: ago(5) }]), K.visitSummary).length === 1);
  ok('🔴 EN9 a finished clean entered after it ended (the office writing down the past): no check-in, no summary', one(run([{ ...done, createdAt: ago(1) }]), K.postService).length + one(run([{ ...done, createdAt: ago(1) }]), K.visitSummary).length === 0);
  const quiet = book({ reminderTemplates: allOn().filter((t) => t.key !== K.bookingConfirmation && t.key !== K.serviceSetup) });
  const moved = job({ status: JOB_STATUS.UPCOMING, startAt: ahead(50), endAt: ahead(52), rescheduledAt: ago(1), rescheduledFrom: ahead(26) });
  ok('EN10 entered yesterday, moved today: the reschedule notice', one(run([{ ...moved, createdAt: ago(25) }], { state: quiet }), K.reschedule).length === 1);
  ok('🔴 EN11 entered and moved the same day, no entry message on: no reschedule notice (it is part of entering it)', one(run([{ ...moved, createdAt: ago(2) }], { state: quiet }), K.reschedule).length === 0);
  ok('EN12 …but with the booking confirmation on, the customer may already have the first time: the notice goes', one(run([{ ...moved, createdAt: ago(2) }]), K.reschedule).length === 1);
  const cancelled = job({ status: JOB_STATUS.CANCELLED, startAt: ahead(50), endAt: ahead(52), cancelledAt: ago(1) });
  ok('🔴 EN13 entered and cancelled the same day, no entry message on: no cancellation notice; entered yesterday: the notice', one(run([{ ...cancelled, createdAt: ago(2) }], { state: quiet }), K.cancellation).length === 0 && one(run([{ ...cancelled, createdAt: ago(25) }], { state: quiet }), K.cancellation).length === 1);
  const U = CM.UPSELL_AFTER_DAYS || 90;
  const startIso = iso(NOW.getTime() - U * 24 * HOUR);
  const up = (createdAt) => one(due({ state: book(), jobs: [], serviceStarts: [{ clientId: 'cl1', siteId: 's1', seriesId: 'ser9', startAt: startIso, createdAt }] }, NOW), K.upsell);
  ok(`🔴 EN14 a schedule entered on its upsell day (${U} days after a back-dated first visit): no upsell; entered at its start: the upsell`, up(ago(1)).length === 0 && up(startIso).length === 1 && up(undefined).length === 1);
  const tomorrow = job({ status: JOB_STATUS.UPCOMING, startAt: '2026-11-05T22:00:00.000Z', endAt: '2026-11-05T23:00:00.000Z' });
  ok('EN15 a clean with no entry time (from before the stamp) keeps the rules it had: the 24-hour text goes', one(run([tomorrow]), K.reminder24h).length === 1);
}

// ── the account: service setup, upsell, leaving ──────────────────────────────
{
  const master = job({ id: 'jm', seriesId: 'ser9', recurrence: { frequency: 'weekly', daysOfWeek: [1, 4] }, status: JOB_STATUS.UPCOMING, startAt: '2026-11-09T22:00:00.000Z', endAt: '2026-11-09T23:30:00.000Z', createdAt: ago(3) });
  const r = one(run([master]), K.serviceSetup);
  ok('SS1 a customer\'s schedule created three hours ago: the setup email, once per CUSTOMER', r.length === 1 && r[0].id === mk(K.serviceSetup, 'cl1'), r.map((d) => d.id));
  ok('SS2 …asking the cron "is it their FIRST schedule?"', r[0]?.check?.kind === 'firstSeries' && r[0].check.when === 'first' && r[0].check.seriesId === 'ser9');
  ok('SS3 its schedule and first visit in the customer\'s words, and the account manager as crew lead', /Service: Janitorial, weekly \(Mondays and Thursdays\)/.test(r[0]?.body || '') && /First visit: Monday, Nov 9/.test(r[0]?.body || '') && /Your crew lead is Renata Cruz/.test(r[0]?.body || ''), r[0]?.body);
  ok('🔴 SS4 no back-blast: a schedule created longer ago than EVENT_MAX_AGE_HOURS gets none', one(run([{ ...master, createdAt: iso(NOW.getTime() - MAX_AGE - HOUR) }]), K.serviceSetup).length === 0);
  ok('SS5 a one-off clean is not a schedule', one(run([{ ...master, recurrence: null, seriesId: null }]), K.serviceSetup).length === 0);
  const up = (daysAgo) => due({ state: book(), jobs: [], serviceStarts: [{ clientId: 'cl1', siteId: 's1', seriesId: 'ser9', startAt: iso(NOW.getTime() - daysAgo * 24 * HOUR) }] }, NOW);
  const U = CM.UPSELL_AFTER_DAYS || 90;
  ok(`UP1 ${U} days after the first visit: the upsell, once per customer, asking "their first schedule (none before it)?"`, one(up(U), K.upsell).length === 1 && one(up(U), K.upsell)[0].id === mk(K.upsell, 'cl1') && one(up(U), K.upsell)[0].check?.before);
  ok('UP2 …still within the day grace two days later', one(up(U + (CM.DAY_GRACE_DAYS || 2)), K.upsell).length === 1);
  ok('🔴 UP3 no back-blast: a customer who started long ago gets none', one(up(U + 30), K.upsell).length === 0 && one(up(400), K.upsell).length === 0);
  ok('UP4 nor one who started too recently', one(up(U - 1), K.upsell).length === 0);
  ok('UP5 the upsell is a nudge: it carries the opt-out line', /To stop these emails/.test(one(up(U), K.upsell)[0]?.body || ''));
  const archived = (hAgo) => book({ clients: [{ ...book().clients[0], statusOverride: 'archived', archivedAt: ago(hAgo) }] });
  const off = one(due({ state: archived(2), jobs: [] }, NOW), K.offboarding);
  ok('OB1 a customer archived two hours ago: the offboarding thank-you (the one message a former customer gets now)', off.length === 1 && off[0].recipient === 'ann@corp.test', off);
  ok('🔴 OB2 no back-blast: archived longer ago than EVENT_MAX_AGE_HOURS: none', one(due({ state: archived(MAX_AGE / HOUR + 1), jobs: [] }, NOW), K.offboarding).length === 0);
  const W = CM.WIN_BACK_AFTER_DAYS || 60;
  ok(`WB1 ${W} days after the archive: the win-back`, one(due({ state: archived(W * 24 + 1), jobs: [] }, NOW), K.winBack).length === 1);
  ok('🔴 WB2 no back-blast: a customer who left long ago gets none', one(due({ state: archived((W + 10) * 24), jobs: [] }, NOW), K.winBack).length === 0);
  ok('WB3 a customer restored before then gets none (not archived any more)', one(due({ state: book({ clients: [{ ...book().clients[0], archivedAt: ago(W * 24 + 1) }] }), jobs: [] }, NOW), K.winBack).length === 0);
  ok('WB4 a customer we still serve never gets a leaving message', due({ state: book(), jobs: [] }, NOW).every((d) => d.templateKey !== K.offboarding && d.templateKey !== K.winBack));
}

// ── the lead ─────────────────────────────────────────────────────────────────
{
  const lead = (hAgo, extra = {}, now = NOW) => book({ contacts: [...book().contacts, { id: 'ct9', firstName: 'Lou', email: 'lou@prospect.test', leadReceivedAt: ago(hAgo, now), ...extra }] });
  const r = one(due({ state: lead(0.1, {}, NIGHT), jobs: [] }, NIGHT), K.leadAck);
  ok('LA1 a lead from the website a few minutes ago: the acknowledgement, to the lead, at any hour', r.length === 1 && r[0].recipient === 'lou@prospect.test' && /^Hi Lou,/.test(r[0].body), r);
  ok('🔴 LA2 no back-blast: a lead stamped longer ago than EVENT_MAX_AGE_HOURS gets none', one(due({ state: lead(MAX_AGE / HOUR + 1), jobs: [] }, NOW), K.leadAck).length === 0);
  ok('LA3 a contact the office typed in (no lead stamp) is not a lead', one(due({ state: book(), jobs: [] }, NOW), K.leadAck).length === 0);
  ok('LA4 a lead with no address gets nothing', one(due({ state: lead(0.1, { email: '' }), jobs: [] }, NOW), K.leadAck).length === 0);
  const { ingestLead } = await import('../api/_lib/leads/upsert.js');
  const st = { contacts: [], clients: [], pipelines: [], tags: [] };
  const a = ingestLead(st, { firstName: 'Lou', email: 'lou@prospect.test' });
  const stamp = a.state.contacts[0]?.leadReceivedAt;
  ok('LA5 the lead webhook stamps the lead it creates', a.status === 'created' && !!stamp && Date.now() - Date.parse(stamp) < 60e3, a.status);
  const b = ingestLead(a.state, { firstName: 'Lou', email: 'lou@prospect.test' });
  ok(`LA6 the same person again within ${CM.LEAD_ACK_REPEAT_DAYS} days is not re-stamped (one inquiry, one ack)`, (b.state.contacts[0]?.leadReceivedAt ?? stamp) === stamp, b.status);
  const old = { ...a.state, contacts: [{ ...a.state.contacts[0], leadReceivedAt: iso(Date.now() - ((CM.LEAD_ACK_REPEAT_DAYS || 30) + 1) * 864e5) }] };
  const c = ingestLead(old, { firstName: 'Lou', email: 'lou@prospect.test' });
  ok('LA7 …and asking again a month on is a new lead (re-stamped)', c.status === 'updated' && Date.now() - Date.parse(c.state.contacts[0].leadReceivedAt) < 60e3, c.status);
}

// ── complaints ───────────────────────────────────────────────────────────────
{
  const p = (o) => ({ id: 'p1', client_id: 'cl1', site_id: 's1', type: 'complaint', origin: 'internal', status: 'open', created_at: ago(1), resolved_at: null, ...o });
  const go = (rows, extra = {}) => due({ state: book(), jobs: [], complaints: rows, ...extra }, NOW);
  ok('CP1 a complaint logged an hour ago: the acknowledgement, keyed by the ticket', one(go([p()]), K.complaintAck).length === 1 && one(go([p()]), K.complaintAck)[0].id === mk(K.complaintAck, 'p1'));
  ok('🔴 CP2 no back-blast: a complaint logged longer ago than EVENT_MAX_AGE_HOURS: no ack', one(go([p({ created_at: iso(NOW.getTime() - MAX_AGE - HOUR) })]), K.complaintAck).length === 0);
  ok('CP3 a visitor\'s QR report is not the customer complaining: nothing', go([p({ origin: 'visitor' })]).length === 0);
  ok('CP4 an issue or a request is not a complaint', go([p({ type: 'issue' }), p({ id: 'p2', type: 'request' })]).length === 0);
  const res = p({ status: 'resolved', created_at: ago(300), resolved_at: ago(2) });
  ok('CP5 resolved two hours ago: the resolution email', one(go([res]), K.complaintResolution).length === 1);
  ok('🔴 CP6 no back-blast: resolved long ago: none', one(go([{ ...res, resolved_at: iso(NOW.getTime() - MAX_AGE - HOUR) }]), K.complaintResolution).length === 0);
  const hub = { ...res, origin: 'portal', raised_by_client_user_id: 'cu1' };
  ok('CP7 raised from the hub by the SAME person, who gets the hub\'s request emails: no second email (HUB-11 told them)', one(go([hub], { raisers: new Map([['p1', { email: 'ANN@corp.test', receives: true }]]) }), K.complaintResolution).length === 0);
  ok('CP8 …but if that login switched request emails off, the resolution email goes', one(go([hub], { raisers: new Map([['p1', { email: 'ann@corp.test', receives: false }]]) }), K.complaintResolution).length === 1);
  ok('CP9 …and when someone else raised it, the main contact still hears', one(go([hub], { raisers: new Map([['p1', { email: 'other@corp.test', receives: true }]]) }), K.complaintResolution).length === 1);
}

// ── review requests: RETIRED with Google reviews (2026-10-20) ─────────────────
{
  const stored = ['review_request', 'review_request_sms'].map((key) => ({ id: `rt_${key}`, key, channel: key.endsWith('_sms') ? 'sms' : 'email', subject: 'x', body: 'Hi {first_name}: {review_link}', enabled: true }));
  const state = book({ company: { ...book().company, googleReviewUrl: 'https://g.page/r/clean-co/review' }, reminderTemplates: [...allOn(), ...stored] });
  const r = due({ state, jobs: [], inspections: [{ id: 'i1', client_id: 'cl1', site_id: 's1', overall_score: 100, status: 'submitted', performed_at: ago(3) }] }, NOW);
  ok('RV1 the review request templates production still stores (on), a link set and a perfect inspection: nothing is due for them', !r.some((d) => /^review_request/.test(d.templateKey)), keys(r));
}

// ── the agreement: renewal notice and offer, price increase, service change ──
{
  const contracts = await soft('../src/lib/contracts.js');
  const today = '2026-11-04';
  const plus = (n) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const on = (dates) => due({ state: book(), jobs: [], contractDates: dates }, NOW);
  const ren = (n) => [{ contractId: 'ct_a', kind: 'renewal', targetDate: plus(n), clientIds: ['cl1'], rise: false }];
  ok(`CT1 an auto-renewal ${CM.RENEWAL_NOTICE_LEAD_DAYS} days out: the renewal notice (and not the offer yet)`, one(on(ren(CM.RENEWAL_NOTICE_LEAD_DAYS)), K.renewalNotice).length === 1 && one(on(ren(CM.RENEWAL_NOTICE_LEAD_DAYS)), K.renewalOffer).length === 0);
  ok(`CT2 ${CM.RENEWAL_OFFER_LEAD_DAYS} days out: the renewal offer, a nudge with its opt-out line`, one(on(ren(CM.RENEWAL_OFFER_LEAD_DAYS)), K.renewalOffer).length === 1 && /To stop these emails/.test(one(on(ren(CM.RENEWAL_OFFER_LEAD_DAYS)), K.renewalOffer)[0].body));
  ok('CT3 two days late (the grace) still goes; three days late never', one(on(ren(CM.RENEWAL_NOTICE_LEAD_DAYS - 2)), K.renewalNotice).length === 1 && one(on(ren(CM.RENEWAL_NOTICE_LEAD_DAYS - 3)), K.renewalNotice).length === 0);
  ok('🔴 CT4 no back-blast: a renewal 10 days out (both dates long passed) sends nothing', on(ren(10)).length === 0);
  const pr = (n, rise) => [{ contractId: 'ct_a', kind: 'price_increase', targetDate: plus(n), clientIds: ['cl1', 'cl_gone'], rise }];
  ok(`CT5 a price RISE ${CM.PRICE_INCREASE_LEAD_DAYS} days out: the notice`, one(on(pr(CM.PRICE_INCREASE_LEAD_DAYS, true)), K.priceIncrease).length === 1);
  ok('CT6 a price DROP is no "increase": nothing', on(pr(CM.PRICE_INCREASE_LEAD_DAYS, false)).length === 0);
  ok('🔴 CT6b no back-blast: a price rise 10 days out (its notice day long passed) sends nothing', on(pr(10, true)).length === 0);
  const two = book({ clients: [...book().clients, { id: 'cl2', name: 'Annex', email: 'annex@corp.test', primaryContactId: null }] });
  const master = due({ state: two, jobs: [], contractDates: [{ ...ren(CM.RENEWAL_NOTICE_LEAD_DAYS)[0], clientIds: ['cl1', 'cl2'] }] }, NOW);
  ok('CT7 a master agreement over two buildings: one notice per building, each to its own contact', one(master, K.renewalNotice).map((d) => d.recipient).sort().join() === 'ann@corp.test,annex@corp.test', one(master, K.renewalNotice).map((d) => d.recipient));
  const pend = (hAgo, o = {}) => ({ id: 'service_change:ct_a:1:cl1', template_key: K.serviceChange, client_id: 'cl1', status: 'pending', created_at: ago(hAgo), payload: { contractId: 'ct_a', summary: ['New schedule: 3x per week', 'New monthly rate: $1,300.00'], effectiveDay: today }, ...o });
  const sc = one(due({ state: book(), jobs: [], pending: [pend(1)] }, NOW), K.serviceChange);
  ok('SC1 a queued service change: the confirmation, with the queued row\'s own id', sc.length === 1 && sc[0].id === 'service_change:ct_a:1:cl1', sc.map((d) => d.id));
  ok('SC2 …listing what changed and the day it took effect', /New schedule: 3x per week\nNew monthly rate: \$1,300\.00\nEffective: Wednesday, Nov 4/.test(sc[0]?.body || ''), sc[0]?.body);
  ok('🔴 SC3 no back-blast: a change queued longer ago than EVENT_MAX_AGE_HOURS is not sent', one(due({ state: book(), jobs: [], pending: [pend(MAX_AGE / HOUR + 1)] }, NOW), K.serviceChange).length === 0);
  const change = contracts.customerVisibleChange;
  const active = { status: 'active', serviceFrequency: '5x per week', lines: [{ description: 'Floor care', monthlyCents: 25000 }], years: [{ startsOn: '2026-01-01', monthlyCents: 100000 }], baseMonthlyCents: 100000 };
  ok('SC4 the rule: a frequency change is news', JSON.stringify(change?.(active, { ...active, serviceFrequency: '3x per week' }, today)) === '["New schedule: 3x per week"]');
  ok('SC5 …a scope change (the extra services) is news', /^Services: Floor care, Windows$/.test(change?.(active, { ...active, lines: [...active.lines, { description: 'Windows', monthlyCents: 0 }] }, today)?.[0] || ''));
  ok('SC6 …a price change is news, the new monthly total in dollars', (change?.(active, { ...active, years: [{ startsOn: '2026-01-01', monthlyCents: 110000 }] }, today) || []).includes('New monthly rate: $1,350.00'));
  ok('SC7 …a note, a name or a document is not; a price the saver could not see (hidden) is not', change?.(active, { ...active, notes: 'x', name: 'y' }, today) === null && change?.(active, { ...active, years: [{ startsOn: '2026-01-01', monthlyCents: null }], baseMonthlyCents: null }, today) === null);
  ok('SC8 …and a draft (or one just activated) is not a change to an agreement', change?.({ ...active, status: 'draft' }, { ...active, serviceFrequency: 'x' }, today) === null);
}

// ── billing (from QuickBooks) ────────────────────────────────────────────────
{
  const today = '2026-11-04';
  const plus = (n) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const billing = (o) => ({ invoices: [{ id: '1001', number: 'CS-1042', clientId: 'cl1', dueDay: plus(CM.UPCOMING_DUE_LEAD_DAYS), balanceCents: 116000, totalCents: 116000, payLink: 'https://connect.intuit.com/portal/app/CommerceNetwork/view/scs-v1-x', ...o }], statements: [] });
  const go = (b, now = NOW, state = book()) => due({ state, jobs: [], billing: b }, now);
  const ud = one(go(billing()), K.upcomingDue);
  ok(`BL1 an open invoice due in ${CM.UPCOMING_DUE_LEAD_DAYS} days: the upcoming-due reminder, with its number, balance and QuickBooks pay link`, ud.length === 1 && /invoice CS-1042 for \$1,160\.00 is due in 7 days/.test(ud[0].body) && ud[0].body.includes('https://connect.intuit.com/'), ud[0]?.body);
  ok('BL2 keyed by the invoice and its due day (a new due date is a new reminder)', ud[0]?.id === mk(K.upcomingDue, '1001', plus(CM.UPCOMING_DUE_LEAD_DAYS)));
  const billingContact = book({ contacts: [...book().contacts, { id: 'ct3', firstName: 'Bea', email: 'ap@corp.test', phone: '+15555550009' }], clients: [{ ...book().clients[0], billingContactId: 'ct3' }] });
  ok('BL3 it goes to the customer\'s BILLING contact', one(go(billing(), NOW, billingContact), K.upcomingDue)[0]?.recipient === 'ap@corp.test');
  ok('BL4 no pay link from QuickBooks: not sent (its words promise one)', one(go(billing({ payLink: null })), K.upcomingDue).length === 0);
  ok('🔴 BL5 no back-blast: an invoice due in three days (its day long past) gets no reminder', one(go(billing({ dueDay: plus(3) })), K.upcomingDue).length === 0);
  ok('BL6 a paid invoice gets nothing', go(billing({ balanceCents: 0 })).length === 0);
  // Billing is email only (2026-10-28): the past-due TEXT is gone, and with a stored, switched-on
  // `payment_reminder_sms` template (production holds one) nothing is due the day after.
  const stored = book({ reminderTemplates: [...book().reminderTemplates, { id: 'rt_payment_reminder_sms', key: 'payment_reminder_sms', channel: 'sms', subject: '', body: '{company}: invoice {invoice_number} is due. Pay here: {pay_link}', enabled: true }] });
  const pastDue = go(billing({ dueDay: plus(-1) }), NOW, stored);
  ok('🔴 BL7 the day after an invoice was due: nothing is texted, even with the old text template stored and on', !('paymentReminderSms' in K) && pastDue.length === 0 && !pastDue.some((d) => d.channel === 'sms'), pastDue.map((d) => d.id));
  ok('BL8 …and nothing is sent a month overdue either', go(billing({ dueDay: plus(-30) }), NOW, stored).length === 0);
  const first = new Date('2026-12-01T17:00:00.000Z');         // the 1st, 09:00 in Los Angeles
  const st = { clientId: 'cl1', month: '2026-11', periodStart: '2026-11-01', periodEnd: '2026-11-30', balanceCents: 116000, invoices: [{ number: 'CS-1042', issuedDay: '2026-11-04', totalCents: 116000, balanceCents: 116000 }], payments: [] };
  const sts = one(due({ state: book(), jobs: [], billing: { invoices: [], statements: [st] } }, first), K.statement);
  ok('BL9 the 1st: the monthly statement with the current balance, its statement carried for the PDF', sts.length === 1 && /Current balance: \$1,160\.00/.test(sts[0].body) && sts[0].payload?.statement?.customer === 'Acme Tower', sts[0]?.body);
  ok('BL10 keyed by the customer and the month', sts[0]?.id === mk(K.statement, 'cl1', '2026-11'));
  ok('🔴 BL11 no back-blast: on the 4th, no statement', one(due({ state: book(), jobs: [], billing: { invoices: [], statements: [st] } }, new Date('2026-12-04T17:00:00.000Z')), K.statement).length === 0);
  ok('BL12 a customer with nothing in the month and no balance gets no statement', one(due({ state: book(), jobs: [], billing: { invoices: [], statements: [{ ...st, invoices: [], payments: [], balanceCents: 0 }] } }, first), K.statement).length === 0);
  const B = await soft('../api/_lib/customerMessages/billing.js');
  const owner = B.customerOwners?.([{ client_id: 'cl1', entity_type: 'customer', entity_id: '1' }, { client_id: 'cl2', entity_type: 'customer', entity_id: '4' }], [{ id: '1' }, { id: '7', parentId: '1' }, { id: '4' }, { id: '8', parentId: '4' }]);
  ok('BL13 each QuickBooks customer belongs to the building linked to it or to its nearest linked parent', owner?.get('1') === 'cl1' && owner?.get('7') === 'cl1' && owner?.get('8') === 'cl2', owner && [...owner]);
  const rows = B.billingFromRows?.({ owner, openRows: [
    { Id: 1001, DocNumber: 'CS-1042', TxnDate: '2026-10-28', DueDate: '2026-11-27', TotalAmt: 1160.0, Balance: 1160.0, CustomerRef: { value: '7' }, InvoiceLink: 'https://connect.intuit.com/x' },
    { Id: 1002, DocNumber: 'CS-1043', TxnDate: '2026-10-28', DueDate: '2026-11-27', TotalAmt: '980.50', Balance: '0', CustomerRef: { value: '1' } },
    { Id: 1003, DocNumber: 'CS-1044', TxnDate: '2026-10-28', TotalAmt: 50, Balance: 50, CustomerRef: { value: '99' } },
    { Id: 1004, DocNumber: 'CS-1045', TxnDate: '2026-10-28', DueDate: '2026-11-27', TotalAmt: 50, Balance: 50, CustomerRef: { value: '4' }, InvoiceLink: 'javascript:x' },
  ] });
  ok('BL14 from Intuit\'s rows: the open ones of linked customers, in cents, with only an https pay link', rows?.invoices?.length === 2 && rows.invoices[0].balanceCents === 116000 && rows.invoices[0].clientId === 'cl1' && rows.invoices[0].payLink === 'https://connect.intuit.com/x' && rows.invoices[1].payLink === null, rows?.invoices);
  const pm = B.previousMonth?.('2026-12-02');
  ok('BL15 the statement covers the previous calendar month', pm?.month === '2026-11' && pm.periodStart === '2026-11-01' && pm.periodEnd === '2026-11-30', pm);
  const P = await soft('../api/_lib/customerMessages/statementPdf.js');
  const pdf = P.statementPdfBase64 ? Buffer.from(await P.statementPdfBase64({ ...st, customer: 'Acme Tower' }, { name: 'Clean Co' }), 'base64') : Buffer.alloc(0);
  const { PDFDocument } = await import('pdf-lib');
  const doc = pdf.length ? await PDFDocument.load(pdf) : null;
  ok('BL16 the statement PDF is a real PDF of at least one page', pdf.slice(0, 5).toString() === '%PDF-' && (doc?.getPageCount() || 0) >= 1);
}

// ── consent, the customer, the address (every visit message at once) ─────────
{
  const jobs = [
    job({ id: 'a', status: JOB_STATUS.UPCOMING, startAt: ahead(30), endAt: ahead(32), createdAt: ago(1) }),
    job({ id: 'b', status: JOB_STATUS.DONE, startAt: ago(4), endAt: ago(2) }),
  ];
  const base = run(jobs);
  ok('CN0 control: the clean book gets its booking, check-in and summary', [K.bookingConfirmation, K.postService, K.visitSummary].every((k) => one(base, k).length === 1), keys(base));
  const dnc = book(); dnc.contacts = [{ ...dnc.contacts[0], doNotContact: true }];
  ok('CN1 a contact marked Do Not Contact gets nothing at all', run(jobs, { state: dnc }).length === 0);
  const opt = book(); opt.contacts = [{ ...opt.contacts[0], reminderOptOut: true }];
  ok('CN2 a contact opted out of reminders gets nothing at all (the receipts too)', run(jobs, { state: opt }).length === 0);
  const sup = book({ marketingSuppressions: [{ email: 'ANN@corp.test' }] });
  const s = run(jobs, { state: sup });
  ok('CN3 an unsubscribed address: the nudge (check-in) is dropped, case-insensitively …', one(s, K.postService).length === 0);
  ok('CN4 …and the receipts still go (booking, summary)', one(s, K.bookingConfirmation).length === 1 && one(s, K.visitSummary).length === 1);
  const fallback = book({ clients: [{ ...book().clients[0], primaryContactId: null }], marketingSuppressions: [{ email: 'acme@corp.test' }] });
  const f = run(jobs, { state: fallback });
  ok('CN5 with no contact the customer\'s own address is used, and the suppression is matched on it', one(f, K.visitSummary)[0]?.recipient === 'acme@corp.test' && one(f, K.postService).length === 0);
  const nobody = book({ clients: [{ ...book().clients[0], email: null, phone: null, primaryContactId: null }] });
  ok('CN6 the flood guard: no address on file anywhere = no item at all', run(jobs, { state: nobody }).length === 0);
  for (const status of [{ statusOverride: 'archived', archivedAt: ago(100) }, { statusOverride: 'inactive' }, { type: 'vendor' }]) {
    ok(`CN7 a customer we no longer serve (${JSON.stringify(status)}) gets no visit message`, run(jobs, { state: book({ clients: [{ ...book().clients[0], ...status }] }) }).length === 0);
  }
  const off = book({ reminderTemplates: allOn().map((t) => ({ ...t, enabled: false })) });
  ok('CN8 every template off = nothing (approved = on, but the switch is the office\'s)', run(jobs, { state: off }).length === 0);
  const siteContact = book({ contacts: [...book().contacts, { id: 'ct2', firstName: 'Sam', email: 'sam@corp.test', phone: '+15555550003' }] });
  ok('CN9 a clean\'s own site contact is who a visit message goes to', one(run([{ ...jobs[1], siteContactId: 'ct2' }], { state: siteContact }), K.visitSummary)[0]?.recipient === 'sam@corp.test');
  ok('CN10 the org default zone is used when the company names none (never the server\'s UTC)', due({ state: book({ company: { name: 'Clean Co' } }), jobs: [jobs[1]] }, new Date('2026-11-04T12:00:00.000Z')).length === 0);
}

// ── the stamps the change notices fire on ────────────────────────────────────
const { reducer, ACTIONS, INITIAL_STATE } = await loadStore();
{
  const j = INITIAL_STATE.jobs.find((x) => x.status === JOB_STATUS.UPCOMING && !x.seriesId);
  const s0 = { ...INITIAL_STATE, jobs: INITIAL_STATE.jobs.map((x) => ({ ...x })) };
  const newStart = new Date(Date.parse(j.startAt) + 2 * HOUR).toISOString();
  const newEnd = new Date(Date.parse(j.endAt) + 2 * HOUR).toISOString();
  const s1 = reducer(s0, { type: ACTIONS.UPDATE_JOB, id: j.id, patch: { startAt: newStart, endAt: newEnd } });
  const m = s1.jobs.find((x) => x.id === j.id);
  ok('ST1 moving a clean\'s time stamps rescheduledAt and where it moved from', !!m.rescheduledAt && m.rescheduledFrom === j.startAt, m);
  const s2 = reducer(s1, { type: ACTIONS.UPDATE_JOB, id: j.id, patch: { notes: 'gate code 12' } });
  ok('ST2 a later notes edit keeps the stamp as it was (no new notice)', s2.jobs.find((x) => x.id === j.id).rescheduledAt === m.rescheduledAt);
  const other = INITIAL_STATE.users.find((u) => u.role === 'crew' && !(j.crewIds || []).includes(u.id));
  const s3 = reducer(s0, { type: ACTIONS.UPDATE_JOB, id: j.id, patch: { crewIds: [other.id] } });
  ok('ST3 a crew swap is not a reschedule (no stamp)', !s3.jobs.find((x) => x.id === j.id).rescheduledAt);
  const s4 = reducer(s0, { type: ACTIONS.SET_JOB_STATUS, id: j.id, status: JOB_STATUS.CANCELLED });
  ok('ST4 cancelling an upcoming clean stamps cancelledAt', !!s4.jobs.find((x) => x.id === j.id).cancelledAt);
  const done = INITIAL_STATE.jobs.find((x) => x.status === JOB_STATUS.DONE);
  const s5 = reducer(s0, { type: ACTIONS.SET_JOB_STATUS, id: done.id, status: JOB_STATUS.CANCELLED });
  ok('ST5 cancelling a clean that already happened stamps nothing (not news to the customer)', !s5.jobs.find((x) => x.id === done.id).cancelledAt);
  const fresh = s4.jobs.find((x) => x.id === j.id);
  const items = due({ state: { ...book(), clients: s4.clients, contacts: s4.contacts, sites: s4.sites, services: s4.services, reminderTemplates: allOn() }, jobs: [fresh] }, new Date(Date.parse(fresh.cancelledAt) + 60e3));
  ok('ST6 end to end: the reducer\'s cancellation is due as a notice (window permitting)', !(RS.isInSendWindow || (() => true))(new Date(Date.parse(fresh.cancelledAt) + 60e3), TZ) || items.some((d) => d.templateKey === K.cancellation), keys(items));
}

console.log(`test-customer-messages-engine: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
