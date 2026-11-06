// Ticket (work-order) alerting — Matt's WO-2, WO-3, WO-5, WO-6, WO-7 and WO-16 (2026-09-29),
// CS-195 / CS-385. Pins the WALKER (src/lib/ticketAlerts), the OFFICE-HOURS window
// (src/lib/officeHours) it is gated by, and the ROUTING the shared applier gives each kind
// (src/lib/opsAlertApply — WO-6 supervisor first, the office on an escalation).
//
// Every timing is asserted against the SOURCE-OF-TRUTH constants (TICKET_ALERT_DEFAULTS,
// SLA_HOURS, OFFICE_HOURS_DEFAULTS) and every id against the SOURCE-OF-TRUTH minter
// (ticketAlertId) — never a restated literal (THE LAW II.3). Pure + offline: no Supabase, no
// network, no timers.
//
//   node app/scripts/test-ticket-alerts.mjs
import assert from 'node:assert/strict';

const {
  getDueTicketAlerts, ticketAlertId, ticketAlertEventKey, ticketRaisedEventKey,
  TICKET_ALERT_DEFAULTS, TICKET_EVENT_URGENT, TICKET_EVENT_OPEN, TICKET_EVENT_RAISED,
  ticketAnsweredAt, ticketDueAtMs, MIN_TICKET_INTERVAL_MINS,
} = await import('../src/lib/ticketAlerts.js');
const {
  isWithinOfficeHours, officeHoursConfig, parseHhMm, fmtHhMm, OFFICE_HOURS_DEFAULTS,
} = await import('../src/lib/officeHours.js');
const { applyOpsAlert } = await import('../src/lib/opsAlertApply.js');
const { SLA_HOURS, WO_PRIORITIES, RETIRED_PRIORITY } = await import('../src/lib/workOrders.js');

let pass = 0;
const fails = [];
const ok = (label, fn) => {
  try { fn(); pass += 1; }
  catch (e) { fails.push(`${label}\n      ${e && e.message ? String(e.message).split('\n')[0] : e}`); }
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TZ = 'America/New_York';

// A Wednesday, 10:00 in New York (inside the default Mon–Fri 08:00–17:00 office window) and a
// Wednesday 02:00 (outside it). Built from an explicit UTC instant so the fixture does not
// depend on the machine's zone.
const WED_10AM = Date.parse('2026-09-30T14:00:00.000Z'); // 10:00 EDT
const WED_2AM = Date.parse('2026-09-30T06:00:00.000Z');  // 02:00 EDT
const SUN_10AM = Date.parse('2026-10-04T14:00:00.000Z'); // Sunday 10:00 EDT

const ticket = (over = {}) => ({
  id: 't1', client_id: 'cl_real', priority: 'medium', status: 'open',
  created_at: new Date(WED_10AM - 60 * MIN).toISOString(), title: 'Soap dispensers empty',
  ...over,
});
const walk = (over = {}) => getDueTicketAlerts({
  tickets: [ticket(over.ticket || {})], now: WED_10AM, settings: {}, timeZone: TZ,
  ...over.args,
});
const kinds = (due) => due.map((d) => d.kind).sort();
const byKind = (due, kind) => due.find((d) => d.kind === kind);

console.log('\n── Office hours (WO-7 · WO-17 default) ──');

ok('the default window is Mon–Fri 08:00–17:00', () => {
  assert.deepEqual(OFFICE_HOURS_DEFAULTS.officeHoursDays, [1, 2, 3, 4, 5]);
  assert.equal(OFFICE_HOURS_DEFAULTS.officeHoursStart, '08:00');
  assert.equal(OFFICE_HOURS_DEFAULTS.officeHoursEnd, '17:00');
});
ok('a weekday mid-morning is inside; 2 a.m. and Sunday are outside', () => {
  assert.equal(isWithinOfficeHours(WED_10AM, {}, TZ), true);
  assert.equal(isWithinOfficeHours(WED_2AM, {}, TZ), false);
  assert.equal(isWithinOfficeHours(SUN_10AM, {}, TZ), false);
});
ok('the window is judged in the ORG zone, not the process zone (UTC on the cron)', () => {
  // 13:00 UTC is 09:00 in New York — inside. Read as UTC it is inside too, so use a case that
  // separates them: 22:00 UTC is 18:00 EDT (CLOSED) but would read as open in a UTC+? zone.
  const tenPmUtc = Date.parse('2026-09-30T21:30:00.000Z'); // 17:30 EDT — past closing
  assert.equal(isWithinOfficeHours(tenPmUtc, {}, TZ), false);
  // …and the same instant IS inside for a zone where it is 09:30.
  assert.equal(isWithinOfficeHours(tenPmUtc, {}, 'Asia/Tokyo'), false); // 06:30 Thu — before open
  const tokyoMorning = Date.parse('2026-09-30T00:30:00.000Z');          // 09:30 Wed in Tokyo
  assert.equal(isWithinOfficeHours(tokyoMorning, {}, 'Asia/Tokyo'), true);
});
ok('closing time is exclusive, opening inclusive', () => {
  const s = { officeHoursStart: '08:00', officeHoursEnd: '17:00' };
  assert.equal(isWithinOfficeHours(Date.parse('2026-09-30T12:00:00.000Z'), s, TZ), true);  // 08:00
  assert.equal(isWithinOfficeHours(Date.parse('2026-09-30T21:00:00.000Z'), s, TZ), false); // 17:00
});
ok('an empty day list falls back to Mon–Fri rather than silencing every alert', () => {
  assert.deepEqual(officeHoursConfig({ officeHoursDays: [] }).days, [1, 2, 3, 4, 5]);
  assert.equal(isWithinOfficeHours(WED_10AM, { officeHoursDays: [] }, TZ), true);
});
ok('a malformed time pair falls back to the default window', () => {
  const c = officeHoursConfig({ officeHoursStart: '99:99', officeHoursEnd: '' });
  assert.equal(c.startMins, parseHhMm(OFFICE_HOURS_DEFAULTS.officeHoursStart));
  assert.equal(c.endMins, parseHhMm(OFFICE_HOURS_DEFAULTS.officeHoursEnd));
});
ok('start === end falls back too (a zero-width window is not an answer)', () => {
  const c = officeHoursConfig({ officeHoursStart: '09:00', officeHoursEnd: '09:00' });
  assert.equal(c.startMins, parseHhMm(OFFICE_HOURS_DEFAULTS.officeHoursStart));
});
ok('an overnight window (20:00–04:00) spans midnight', () => {
  const s = { officeHoursDays: [2, 3], officeHoursStart: '20:00', officeHoursEnd: '04:00' };
  // Wednesday 22:00 EDT — the evening half of Wednesday's shift.
  assert.equal(isWithinOfficeHours(Date.parse('2026-10-01T02:00:00.000Z'), s, TZ), true);
  // Thursday 02:00 EDT — the small hours of Wednesday's shift.
  assert.equal(isWithinOfficeHours(Date.parse('2026-10-01T06:00:00.000Z'), s, TZ), true);
  // Friday 02:00 EDT — Thursday is not an office day, so no.
  assert.equal(isWithinOfficeHours(Date.parse('2026-10-02T06:00:00.000Z'), s, TZ), false);
});
ok('parseHhMm / fmtHhMm round-trip and reject nonsense', () => {
  assert.equal(parseHhMm('08:30'), 510);
  assert.equal(fmtHhMm(510), '08:30');
  assert.equal(parseHhMm('8:05:00'), 485);   // an <input type=time> seconds tail
  assert.equal(parseHhMm('24:00'), null);
  assert.equal(parseHhMm('nope'), null);
  assert.equal(parseHhMm(null), null);
});

console.log('── WO-3 / WO-5: every new ticket repeats, every 10 minutes ──');

ok('the defaults are Matt\'s numbers: 10-minute repeat, 30-minute escalation, hourly after', () => {
  assert.equal(TICKET_ALERT_DEFAULTS.ticketRepeatMins, 10);
  assert.equal(TICKET_ALERT_DEFAULTS.ticketEscalateMins, 30);
  assert.equal(TICKET_ALERT_DEFAULTS.ticketOpenRepeatMins, 60);
});
ok('nothing fires inside the first interval (the creation ping owns slot 0)', () => {
  const created = new Date(WED_10AM - (TICKET_ALERT_DEFAULTS.ticketRepeatMins - 1) * MIN).toISOString();
  assert.deepEqual(walk({ ticket: { created_at: created } }), []);
});
ok('one repeat fires at the first whole interval, with the slot-1 id', () => {
  const created = new Date(WED_10AM - TICKET_ALERT_DEFAULTS.ticketRepeatMins * MIN).toISOString();
  const due = walk({ ticket: { created_at: created } });
  assert.deepEqual(kinds(due), ['ticketRepeat']);
  assert.equal(due[0].id, ticketAlertId('ticketRepeat', 't1', 1));
});
ok('every NEW ticket repeats, not just the urgent ones (WO-3 “differs”)', () => {
  const created = new Date(WED_10AM - 11 * MIN).toISOString();
  for (const priority of WO_PRIORITIES) {
    const due = walk({ ticket: { created_at: created, priority } });
    assert.ok(byKind(due, 'ticketRepeat'), `${priority} should repeat`);
  }
});
ok('only the CURRENT slot is emitted — a cron outage never replays the missed ones', () => {
  const created = new Date(WED_10AM - 55 * MIN).toISOString();
  const due = walk({ ticket: { created_at: created } });
  const repeats = due.filter((d) => d.kind === 'ticketRepeat');
  assert.equal(repeats.length, 1);
  assert.equal(repeats[0].id, ticketAlertId('ticketRepeat', 't1', 5));
});
ok('the slot id makes a re-run inside the same slot a no-op', () => {
  const created = new Date(WED_10AM - 11 * MIN).toISOString();
  const firedIds = new Set([ticketAlertId('ticketRepeat', 't1', 1)]);
  const due = walk({ ticket: { created_at: created }, args: { firedIds } });
  assert.equal(byKind(due, 'ticketRepeat'), undefined);
});
ok('the interval is a SETTING', () => {
  const created = new Date(WED_10AM - 6 * MIN).toISOString();
  assert.equal(byKind(walk({ ticket: { created_at: created } }), 'ticketRepeat'), undefined);
  const due = walk({ ticket: { created_at: created }, args: { settings: { ticketRepeatMins: 5 } } });
  assert.equal(byKind(due, 'ticketRepeat').id, ticketAlertId('ticketRepeat', 't1', 1));
});
ok('a 0 interval is clamped, so a typo cannot fire a marker every cron run', () => {
  const created = new Date(WED_10AM - 30 * 1000).toISOString();   // 30 s old
  const due = walk({ ticket: { created_at: created }, args: { settings: { ticketRepeatMins: 0 } } });
  // Clamped to the floor, so a 30-second-old ticket is still inside slot 0.
  assert.equal(MIN_TICKET_INTERVAL_MINS, 1);
  assert.equal(byKind(due, 'ticketRepeat'), undefined);
});

console.log('── WO-5: the office is alerted after 30 minutes, ON TOP of the repeats ──');

ok('the escalation fires once, past the escalate delay, to the OFFICE', () => {
  const created = new Date(WED_10AM - (TICKET_ALERT_DEFAULTS.ticketEscalateMins + 1) * MIN).toISOString();
  const due = walk({ ticket: { created_at: created } });
  const esc = byKind(due, 'ticketEscalate');
  assert.ok(esc);
  assert.equal(esc.id, ticketAlertId('ticketEscalate', 't1'));
  assert.equal(esc.recipientScope, 'office');
  // …and the supervisor repeat is STILL going (Matt: "you're alerted TOO").
  assert.ok(byKind(due, 'ticketRepeat'));
});
ok('the escalation does not fire before the delay', () => {
  const created = new Date(WED_10AM - (TICKET_ALERT_DEFAULTS.ticketEscalateMins - 1) * MIN).toISOString();
  assert.equal(byKind(walk({ ticket: { created_at: created } }), 'ticketEscalate'), undefined);
});
ok('the escalation is once-only (its marker has no slot)', () => {
  const created = new Date(WED_10AM - 90 * MIN).toISOString();
  const firedIds = new Set([ticketAlertId('ticketEscalate', 't1')]);
  const due = walk({ ticket: { created_at: created }, args: { firedIds } });
  assert.equal(byKind(due, 'ticketEscalate'), undefined);
});

console.log('── WO-2: the repeats stop when someone replies to the client ──');

ok('a staff reply stops the pre-reply repeat and the escalation', () => {
  const created = new Date(WED_10AM - 90 * MIN).toISOString();
  const repliedAt = { t1: new Date(WED_10AM - 80 * MIN).toISOString() };
  const due = walk({ ticket: { created_at: created }, args: { repliedAt } });
  assert.equal(byKind(due, 'ticketRepeat'), undefined);
  assert.equal(byKind(due, 'ticketEscalate'), undefined);
});
ok('a status off `open` counts as answered even with no reply row', () => {
  const t = ticket({ status: 'in_progress', created_at: new Date(WED_10AM - 90 * MIN).toISOString() });
  assert.equal(ticketAnsweredAt(t, undefined), Date.parse(t.created_at));
  const due = getDueTicketAlerts({ tickets: [t], now: WED_10AM, timeZone: TZ });
  assert.equal(byKind(due, 'ticketRepeat'), undefined);
});
ok('an unanswered OPEN ticket has no answered-at', () => {
  assert.equal(ticketAnsweredAt(ticket(), undefined), null);
});

console.log('── WO-16 ★a: after the reply, hourly until completed, then escalate ──');

ok('the post-reply reminder fires one whole hour after the reply', () => {
  const created = new Date(WED_10AM - 3 * HOUR).toISOString();
  const replied = new Date(WED_10AM - TICKET_ALERT_DEFAULTS.ticketOpenRepeatMins * MIN).toISOString();
  const due = walk({
    ticket: { created_at: created, status: 'in_progress', due_at: new Date(WED_10AM + HOUR).toISOString() },
    args: { repliedAt: { t1: replied } },
  });
  const r = byKind(due, 'ticketOpenRepeat');
  assert.ok(r);
  assert.equal(r.id, ticketAlertId('ticketOpenRepeat', 't1', 1));
  assert.equal(r.recipientScope, 'supervisor');
});
ok('…and not in the first hour after it', () => {
  const replied = new Date(WED_10AM - 30 * MIN).toISOString();
  const due = walk({
    ticket: { created_at: new Date(WED_10AM - HOUR).toISOString(), status: 'in_progress', due_at: new Date(WED_10AM + HOUR).toISOString() },
    args: { repliedAt: { t1: replied } },
  });
  assert.equal(byKind(due, 'ticketOpenRepeat'), undefined);
});
ok('the response-time escalation fires when the PRIORITY\'s clock runs out', () => {
  // lib/workOrders owns the hours; the fixture is built from SLA_HOURS, never a literal.
  const created = new Date(WED_10AM - (SLA_HOURS.urgent * HOUR + MIN)).toISOString();
  const replied = new Date(WED_10AM - 30 * MIN).toISOString();
  const due = walk({
    ticket: { created_at: created, priority: 'urgent', status: 'in_progress', due_at: null },
    args: { repliedAt: { t1: replied } },
  });
  const esc = byKind(due, 'ticketSlaEscalate');
  assert.ok(esc, 'urgent breaches at SLA_HOURS.urgent');
  assert.equal(esc.recipientScope, 'office');
  assert.equal(esc.id, ticketAlertId('ticketSlaEscalate', 't1'));
});
ok('…and not while the response time is still running', () => {
  const created = new Date(WED_10AM - (SLA_HOURS.medium * HOUR - HOUR)).toISOString();
  const replied = new Date(WED_10AM - 30 * MIN).toISOString();
  const due = walk({
    ticket: { created_at: created, priority: 'medium', status: 'in_progress', due_at: null },
    args: { repliedAt: { t1: replied } },
  });
  assert.equal(byKind(due, 'ticketSlaEscalate'), undefined);
});
ok('the deadline is DERIVED, never the row\'s stored due_at (WO-20: a ticket raised under the old rule moves too)', () => {
  const t = ticket({ due_at: '2026-01-01T00:00:00.000Z', priority: 'low' });
  assert.equal(ticketDueAtMs(t), Date.parse(ticket().created_at) + SLA_HOURS.low * HOUR);
  const derived = ticketDueAtMs(ticket({ due_at: null, priority: 'low' }));
  assert.equal(derived, Date.parse(ticket().created_at) + SLA_HOURS.low * HOUR);
  // WO-18: a ticket still carrying the retired 'high' is judged on URGENT's clock.
  assert.equal(ticketDueAtMs(ticket({ due_at: null, priority: RETIRED_PRIORITY })),
    Date.parse(ticket().created_at) + SLA_HOURS.urgent * HOUR);
});
ok('a RESOLVED ticket is never chased', () => {
  const due = walk({ ticket: { status: 'resolved', created_at: new Date(WED_10AM - 5 * HOUR).toISOString() } });
  assert.deepEqual(due, []);
});
ok('`awaiting_client` pauses the reminders (the SLA badge is paused there too)', () => {
  const due = walk({ ticket: { status: 'awaiting_client', created_at: new Date(WED_10AM - 5 * HOUR).toISOString() } });
  assert.deepEqual(due, []);
});

console.log('── WO-7: urgent any hour, the rest inside office hours ──');

ok('a non-urgent ticket raises nothing at 2 a.m.', () => {
  const created = new Date(WED_2AM - 90 * MIN).toISOString();
  const due = getDueTicketAlerts({
    tickets: [ticket({ created_at: created, priority: 'medium' })], now: WED_2AM, timeZone: TZ,
  });
  assert.deepEqual(due, []);
});
ok('an URGENT ticket raises at 2 a.m.', () => {
  const created = new Date(WED_2AM - 90 * MIN).toISOString();
  const due = getDueTicketAlerts({
    tickets: [ticket({ created_at: created, priority: 'urgent' })], now: WED_2AM, timeZone: TZ,
  });
  assert.deepEqual(kinds(due), ['ticketEscalate', 'ticketRepeat']);
});
ok('the morning\'s first slot resumes the repeat — the overnight ticket is not lost', () => {
  const created = new Date(WED_10AM - 8 * HOUR).toISOString();   // raised at 02:00
  const due = walk({ ticket: { created_at: created } });
  assert.ok(byKind(due, 'ticketRepeat'), 'the current slot fires once the office opens');
});
ok('the event key is the ticket\'s URGENCY, because only it reaches the dispatcher', () => {
  assert.equal(ticketAlertEventKey('urgent'), TICKET_EVENT_URGENT);
  assert.equal(ticketAlertEventKey('medium'), TICKET_EVENT_OPEN);
  assert.equal(ticketAlertEventKey('low'), TICKET_EVENT_OPEN);
  // WO-18: the retired 'high' normalizes UP, so a legacy ticket alerts as URGENT.
  assert.equal(ticketAlertEventKey(RETIRED_PRIORITY), TICKET_EVENT_URGENT);
  assert.equal(ticketAlertEventKey(undefined), TICKET_EVENT_OPEN);
  // The CREATION ping keeps the long-standing toggle for a non-urgent ticket.
  assert.equal(ticketRaisedEventKey('medium'), TICKET_EVENT_RAISED);
  assert.equal(ticketRaisedEventKey('urgent'), TICKET_EVENT_URGENT);
  const created = new Date(WED_10AM - 11 * MIN).toISOString();
  assert.equal(byKind(walk({ ticket: { created_at: created, priority: 'urgent' } }), 'ticketRepeat').eventKey, TICKET_EVENT_URGENT);
});

console.log('── Guards: the seed book and the back-blast look-back ──');

ok('a ticket on a SEED customer never alerts (CS-030)', () => {
  const created = new Date(WED_10AM - 90 * MIN).toISOString();
  const due = getDueTicketAlerts({
    tickets: [ticket({ created_at: created, client_id: 'cl_seed_lasolas', priority: 'urgent' })],
    now: WED_10AM, timeZone: TZ,
  });
  assert.deepEqual(due, []);
});
ok('a ticket older than the look-back is left to the queue', () => {
  const created = new Date(WED_10AM - (TICKET_ALERT_DEFAULTS.ticketAlertLookbackDays + 1) * DAY).toISOString();
  assert.deepEqual(walk({ ticket: { created_at: created } }), []);
  // …and one inside it still alerts.
  const inside = new Date(WED_10AM - (TICKET_ALERT_DEFAULTS.ticketAlertLookbackDays - 1) * DAY).toISOString();
  assert.ok(walk({ ticket: { created_at: inside } }).length);
});
ok('a ticket with no id, no created_at, or a future created_at is skipped', () => {
  assert.deepEqual(getDueTicketAlerts({ tickets: [{ client_id: 'cl_real', status: 'open' }], now: WED_10AM }), []);
  assert.deepEqual(walk({ ticket: { created_at: null } }), []);
  assert.deepEqual(walk({ ticket: { created_at: new Date(WED_10AM + HOUR).toISOString() } }), []);
});

console.log('── WO-6: routing — the supervisor first, the office on an escalation ──');

const state = (over = {}) => ({
  users: [
    { id: 'u_owner', name: 'Matt', role: 'owner', status: 'active', notificationPrefs: {} },
    { id: 'u_admin', name: 'Yolanda', role: 'admin', status: 'active', notificationPrefs: {} },
    { id: 'u_sup', name: 'Renata', role: 'manager', status: 'active', notificationPrefs: {} },
    { id: 'u_crew', name: 'Tomas', role: 'crew', status: 'active', notificationPrefs: {} },
  ],
  clients: [
    { id: 'cl_sup', name: 'Las Olas', supervisorId: 'u_sup' },
    { id: 'cl_none', name: 'No Sup Co', supervisorId: null },
  ],
  permissions: {}, userPermissionOverrides: [],
  notifications: [], opsAlertEvents: [], opsSettings: {},
  ...over,
});
const recips = (res) => new Set((res.notifications || []).map((n) => n.userId));

ok('a repeat goes to the account supervisor ALONE', () => {
  const res = applyOpsAlert(state(), {
    id: ticketAlertId('ticketRepeat', 't1', 1), kind: 'ticketRepeat', eventKey: TICKET_EVENT_OPEN,
    recipientScope: 'supervisor', clientId: 'cl_sup', refId: 't1', title: 'x', body: 'y', url: '/z',
  });
  assert.deepEqual([...recips(res)], ['u_sup']);
});
ok('with NO supervisor a repeat blankets the office bench, never nobody', () => {
  const res = applyOpsAlert(state(), {
    id: ticketAlertId('ticketRepeat', 't2', 1), kind: 'ticketRepeat', eventKey: TICKET_EVENT_OPEN,
    recipientScope: 'supervisor', clientId: 'cl_none', refId: 't2', title: 'x', body: 'y', url: '/z',
  });
  assert.deepEqual([...recips(res)].sort(), ['u_admin', 'u_owner', 'u_sup']);
});
ok('an escalation goes to the whole office bench, once each', () => {
  const res = applyOpsAlert(state(), {
    id: ticketAlertId('ticketEscalate', 't1'), kind: 'ticketEscalate', eventKey: TICKET_EVENT_OPEN,
    recipientScope: 'office', clientId: 'cl_sup', refId: 't1', title: 'x', body: 'y', url: '/z',
  });
  assert.deepEqual([...recips(res)].sort(), ['u_admin', 'u_owner', 'u_sup']);
  assert.equal(res.notifications.length, 3);
});
ok('the row carries the EVENT key, not the kind', () => {
  const res = applyOpsAlert(state(), {
    id: ticketAlertId('ticketRepeat', 't9', 1), kind: 'ticketRepeat', eventKey: TICKET_EVENT_URGENT,
    recipientScope: 'supervisor', clientId: 'cl_sup', refId: 't9', title: 'x', body: 'y', url: '/z',
  });
  assert.equal(res.notifications[0].eventKey, TICKET_EVENT_URGENT);
});
ok('crew never receive a ticket alert (the catalog gates it to the office tiers)', () => {
  const res = applyOpsAlert(state(), {
    id: ticketAlertId('ticketEscalate', 't5'), kind: 'ticketEscalate', eventKey: TICKET_EVENT_OPEN,
    recipientScope: 'office', clientId: 'cl_sup', refId: 't5', title: 'x', body: 'y', url: '/z',
  });
  assert.equal(recips(res).has('u_crew'), false);
});
ok('a supervisor who muted the event gets nothing, and is not swapped for the bench', () => {
  const muted = state();
  muted.users = muted.users.map((u) => (u.id === 'u_sup' ? { ...u, notificationPrefs: { [TICKET_EVENT_OPEN]: false } } : u));
  const res = applyOpsAlert(muted, {
    id: ticketAlertId('ticketRepeat', 't7', 1), kind: 'ticketRepeat', eventKey: TICKET_EVENT_OPEN,
    recipientScope: 'supervisor', clientId: 'cl_sup', refId: 't7', title: 'x', body: 'y', url: '/z',
  });
  assert.equal(res.notifications.length, 0);
});

console.log('── Marker retention: one row per open ticket, not one per 10 minutes ──');

ok('a newer repeat slot SUPERSEDES the older marker for the same ticket', () => {
  let st = state();
  const first = applyOpsAlert(st, {
    id: ticketAlertId('ticketRepeat', 't1', 1), kind: 'ticketRepeat', eventKey: TICKET_EVENT_OPEN,
    recipientScope: 'supervisor', clientId: 'cl_sup', refId: 't1',
  }, { now: WED_10AM });
  st = { ...st, opsAlertEvents: first.opsAlertEvents, notifications: first.notifications };
  const second = applyOpsAlert(st, {
    id: ticketAlertId('ticketRepeat', 't1', 2), kind: 'ticketRepeat', eventKey: TICKET_EVENT_OPEN,
    recipientScope: 'supervisor', clientId: 'cl_sup', refId: 't1',
  }, { now: WED_10AM + 10 * MIN });
  const repeats = second.opsAlertEvents.filter((e) => e.kind === 'ticketRepeat');
  assert.equal(repeats.length, 1, 'only the newest slot is kept');
  assert.equal(repeats[0].id, ticketAlertId('ticketRepeat', 't1', 2));
});
ok('two different tickets keep one marker each', () => {
  let st = state();
  for (const id of ['t1', 't2']) {
    const r = applyOpsAlert(st, {
      id: ticketAlertId('ticketRepeat', id, 1), kind: 'ticketRepeat', eventKey: TICKET_EVENT_OPEN,
      recipientScope: 'supervisor', clientId: 'cl_sup', refId: id,
    }, { now: WED_10AM });
    st = { ...st, opsAlertEvents: r.opsAlertEvents, notifications: r.notifications };
  }
  assert.equal(st.opsAlertEvents.filter((e) => e.kind === 'ticketRepeat').length, 2);
});
ok('the marker records the ticket as refId, so retention can group by it', () => {
  const res = applyOpsAlert(state(), {
    id: ticketAlertId('ticketRepeat', 't1', 1), kind: 'ticketRepeat', eventKey: TICKET_EVENT_OPEN,
    recipientScope: 'supervisor', clientId: 'cl_sup', refId: 't1',
  }, { now: WED_10AM });
  assert.equal(res.opsAlertEvents.at(-1).refId, 't1');
});
ok('an existing shift marker is untouched by the new grouping', () => {
  const st = state({ opsAlertEvents: [{ id: 'oa_shiftMissed_j1', kind: 'shiftMissed', clientId: 'cl_sup', jobId: 'j1', firedAt: new Date(WED_10AM - HOUR).toISOString() }] });
  const res = applyOpsAlert(st, {
    id: ticketAlertId('ticketRepeat', 't1', 1), kind: 'ticketRepeat', eventKey: TICKET_EVENT_OPEN,
    recipientScope: 'supervisor', clientId: 'cl_sup', refId: 't1',
  }, { now: WED_10AM });
  assert.ok(res.opsAlertEvents.some((e) => e.id === 'oa_shiftMissed_j1'));
});

if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  console.error(`\n${pass} passed, ${fails.length} failed`);
  process.exitCode = 1;
} else {
  console.log(`\n✓ ticket alerting: ${pass} checks passed`);
}
