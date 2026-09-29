// Node unit test for the server-side reminder cron's PURE due-selection layer
// (getDueEmailReminders) — no Supabase / network needed. Covers the three
// guarantees the cron leans on: channel-gating (email-only), channel + email
// presence, dedup via reminderEvents, and the booking_confirmation freshness
// guard. Run: node app/scripts/test-reminder-cron.mjs  (from repo root)
import {
  getDueReminders,
  getDueEmailReminders,
  reminderEventId,
  BOOKING_CONFIRMATION_MAX_AGE_HOURS,
} from '../src/lib/reminderScheduler.js';

let pass = 0;
let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; } else { fail += 1; console.error('  ✗ ' + msg); } };

// 19:00 UTC = 12:00 America/Los_Angeles, inside POST_SERVICE_SEND_HOURS.
// This was 12:00 UTC, which is 05:00 PT — outside the civil-hour window that
// post_service now honours, so three post_service assertions started failing when
// the window landed. The fixture was encoding the OLD "any hour is fine" behaviour;
// it is corrected here rather than the guard being weakened to suit it. Every other
// time in this file is expressed relative to NOW, so the shift is inert for them.
const NOW = new Date('2026-07-12T19:00:00.000Z');
const hoursFromNow = (h) => new Date(NOW.getTime() + h * 3600 * 1000).toISOString();
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

// A template set mirroring seed: two email (booking_confirmation, post_service),
// two SMS (reminder_24h, day_of_eta). All ENABLED here so gating is what filters.
const templates = () => [
  { id: 't_bc',  key: 'booking_confirmation', channel: 'email', subject: 'Booked',   body: 'Hi {client_contact}', enabled: true },
  { id: 't_ps',  key: 'post_service',         channel: 'email', subject: 'How was it', body: 'Thanks {client_contact}', enabled: true },
  { id: 't_r24', key: 'reminder_24h',         channel: 'sms',   subject: '',          body: 'tomorrow', enabled: true },
  { id: 't_doe', key: 'day_of_eta',           channel: 'sms',   subject: '',          body: 'today',    enabled: true },
];

function baseState(overrides = {}) {
  return {
    company: { name: 'Clean Space', email: 'office@rfs.com' },
    reminderTemplates: templates(),
    reminderEvents: [],
    clients: [{ id: 'cl1', name: 'Acme', email: 'acme@corp.com', primaryContactId: 'ct1' }],
    contacts: [{ id: 'ct1', firstName: 'Ann', lastName: 'Acme', email: 'ann@corp.com', phone: '+15551234' }],
    sites: [{ id: 's1', name: 'HQ' }],
    services: [{ id: 'sv1', name: 'Janitorial' }],
    jobs: [{ id: 'j1', clientId: 'cl1', siteId: 's1', serviceId: 'sv1', status: 'upcoming', startAt: hoursFromNow(20), createdAt: hoursAgo(1) }],
    ...overrides,
  };
}

// 1. Channel-gating: only EMAIL templates are ever returned (SMS excluded).
{
  // Put the job in the 24h SMS window too — the SMS template still must NOT appear.
  const s = baseState({ jobs: [{ id: 'j1', clientId: 'cl1', siteId: 's1', status: 'upcoming', startAt: hoursFromNow(20), createdAt: hoursAgo(1) }] });
  const due = getDueEmailReminders(s, NOW);
  ok(due.every((d) => d.channel === 'email'), 'never returns an SMS-channel reminder');
  ok(due.some((d) => d.template.key === 'booking_confirmation'), 'returns booking_confirmation (email) for a fresh upcoming job');
  ok(!due.some((d) => d.template.key === 'reminder_24h'), 'excludes reminder_24h even though the job is in its 24h window');
}

// 2. Email-presence gating: a contact + client with NO email fires nothing.
{
  const s = baseState({
    contacts: [{ id: 'ct1', firstName: 'Ann', email: '', phone: '+15551234' }],
    clients: [{ id: 'cl1', name: 'Acme', email: '', primaryContactId: 'ct1' }],
  });
  const due = getDueEmailReminders(s, NOW);
  ok(due.length === 0, 'no email on contact OR client → zero reminders (the 2026-07-02 flood guard)');
}

// 3. Dedup: an already-sent event blocks a refire for that (job, template).
{
  const s = baseState();
  s.reminderEvents = [{
    id: reminderEventId('booking_confirmation', 'j1'),
    templateKey: 'booking_confirmation', jobId: 'j1', status: 'sent', attempts: 1,
  }];
  const due = getDueEmailReminders(s, NOW);
  ok(!due.some((d) => d.template.key === 'booking_confirmation'), 'a sent booking_confirmation event blocks a re-fire');
}

// 4. Disabled template fires nothing.
{
  const s = baseState();
  s.reminderTemplates = s.reminderTemplates.map((t) => ({ ...t, enabled: false }));
  const due = getDueEmailReminders(s, NOW);
  ok(due.length === 0, 'all templates disabled → zero due (OFF by default is honored)');
}

// 5. booking_confirmation freshness guard: an OLD upcoming job is skipped so
//    enabling the template never back-blasts the whole existing schedule.
{
  const s = baseState({
    jobs: [{ id: 'jOld', clientId: 'cl1', siteId: 's1', status: 'upcoming', startAt: hoursFromNow(72), createdAt: hoursAgo(BOOKING_CONFIRMATION_MAX_AGE_HOURS + 5) }],
  });
  const due = getDueEmailReminders(s, NOW);
  ok(!due.some((d) => d.template.key === 'booking_confirmation'), 'stale upcoming job (created > 48h ago) does NOT get a booking confirmation');
}

// 6. booking_confirmation with a missing createdAt is treated as stale (skip).
{
  const s = baseState({
    jobs: [{ id: 'jNoCreated', clientId: 'cl1', siteId: 's1', status: 'upcoming', startAt: hoursFromNow(72) }],
  });
  const due = getDueEmailReminders(s, NOW);
  ok(!due.some((d) => d.template.key === 'booking_confirmation'), 'job with no createdAt is treated as stale (conservative skip)');
}

// 7. post_service (email) fires for a RECENTLY completed job, in civil hours.
{
  const s = baseState({
    jobs: [{ id: 'jDone', clientId: 'cl1', siteId: 's1', status: 'completed', startAt: hoursAgo(3), createdAt: hoursAgo(200) }],
  });
  const due = getDueEmailReminders(s, NOW);
  ok(due.some((d) => d.template.key === 'post_service'), 'post_service email fires on a freshly completed job');
  ok(due.find((d) => d.template.key === 'post_service')?.recipient === 'ann@corp.com', 'post_service resolves the contact email as recipient');
}

// 7b. THE BACK-BLAST. The cron feeds post_service `getJobsInWindow({backDays: 7})`
// and the template had no time bound, so enabling it made every job completed in the
// last WEEK due on one tick — a week of "how did we do?" mail to real customers in a
// single burst. hasFired() does not prevent it: none of those jobs has ever sent.
{
  const mk = (id, h) => ({ id, clientId: 'cl1', siteId: 's1', status: 'completed', startAt: hoursAgo(h), endAt: hoursAgo(h), createdAt: hoursAgo(h + 2) });
  const s = baseState({ jobs: [mk('jFresh', 2), mk('j1d', 26), mk('j3d', 72), mk('j6d', 144)] });
  const due = getDueEmailReminders(s, NOW).filter((d) => d.template.key === 'post_service');
  ok(due.length === 2, `only jobs inside the 48h window are due (got ${due.length}, expected 2)`);
  ok(due.some((d) => d.job.id === 'jFresh'), '  ...a 2h-old completion is due');
  ok(due.some((d) => d.job.id === 'j1d'), '  ...a 26h-old completion is due');
  ok(!due.some((d) => d.job.id === 'j3d'), '  ...a 3-day-old completion is NOT');
  ok(!due.some((d) => d.job.id === 'j6d'), '  ...a 6-day-old completion is NOT (the back-blast tail)');
}

// 7c. endAt is the completion proxy and wins over startAt — a long job that STARTED
// 3 days ago but ended an hour ago is a fresh completion, not a stale one.
{
  const s = baseState({
    jobs: [{ id: 'jLong', clientId: 'cl1', siteId: 's1', status: 'completed', startAt: hoursAgo(72), endAt: hoursAgo(1), createdAt: hoursAgo(100) }],
  });
  ok(getDueEmailReminders(s, NOW).some((d) => d.template.key === 'post_service'), 'endAt (not startAt) decides freshness');
}

// 7d. A completion whose end is in the FUTURE is a mis-set status, not a service to
// follow up on. Firing would ask the customer how a clean went before it happened.
{
  const s = baseState({
    jobs: [{ id: 'jFuture', clientId: 'cl1', siteId: 's1', status: 'completed', startAt: hoursFromNow(2), endAt: hoursFromNow(4), createdAt: hoursAgo(1) }],
  });
  ok(!getDueEmailReminders(s, NOW).some((d) => d.template.key === 'post_service'), 'a completed job ending in the FUTURE is not due');
}

// 7e. Civil hours, in the ORG's zone — not the process zone. The cron runs TZ=UTC
// every 5 minutes, so without this a completion at the wrong moment mails the
// customer in the middle of their night.
{
  const s = baseState({
    jobs: [{ id: 'jDone', clientId: 'cl1', siteId: 's1', status: 'completed', startAt: hoursAgo(3), endAt: hoursAgo(3), createdAt: hoursAgo(5) }],
  });
  const at = (utcIso) => getDueEmailReminders(s, new Date(utcIso)).some((d) => d.template.key === 'post_service');
  // Same job, same freshness; only the wall clock in America/Los_Angeles differs.
  ok(!at('2026-07-12T10:00:00.000Z'), '03:00 PT → suppressed');
  ok(!at('2026-07-12T15:00:00.000Z'), '08:00 PT → suppressed (just before the window)');
  ok(at('2026-07-12T16:00:00.000Z'), '09:00 PT → due (window opens)');
  ok(at('2026-07-13T01:00:00.000Z'), '18:00 PT → due (last civil hour)');
  ok(!at('2026-07-13T02:00:00.000Z'), '19:00 PT → suppressed (window closes)');
  ok(!at('2026-07-13T06:00:00.000Z'), '23:00 PT → suppressed');
  // The company zone is honoured — not UTC, and not the LA default. Times here are
  // ABSOLUTE, not relative to NOW: these assertions evaluate at instants far from
  // NOW, so a fixture anchored to NOW would have its endAt in the future and be
  // rejected on freshness rather than on the hour under test. (That is exactly what
  // the first draft of this block did, and it failed for the wrong reason.)
  const manila = baseState({
    company: { name: 'Clean Space', email: 'office@rfs.com', timezone: 'Asia/Manila' },
    jobs: [{
      id: 'jDone', clientId: 'cl1', siteId: 's1', status: 'completed',
      startAt: '2026-07-11T21:00:00.000Z', endAt: '2026-07-11T22:00:00.000Z',
      createdAt: '2026-07-11T20:00:00.000Z',
    }],
  });
  const manilaAt = (utcIso) => getDueEmailReminders(manila, new Date(utcIso)).some((d) => d.template.key === 'post_service');
  // 01:00 UTC = 09:00 Manila (+8), 3h after the job ended.
  ok(manilaAt('2026-07-12T01:00:00.000Z'), 'Asia/Manila 09:00 → due (org zone, not UTC, not the LA default)');
  // 19:00 UTC = 03:00 Manila next day, 21h after the end — fresh, but the wrong hour
  // THERE, while the same instant is a perfectly civil 12:00 PT.
  ok(!manilaAt('2026-07-12T19:00:00.000Z'), 'Asia/Manila 03:00 → suppressed though the SAME instant is 12:00 PT');
}

// 8. A failed event WITH retry budget is eligible to refire (bounded retry).
{
  const s = baseState();
  s.reminderEvents = [{
    id: reminderEventId('booking_confirmation', 'j1'),
    templateKey: 'booking_confirmation', jobId: 'j1', status: 'failed', attempts: 2,
  }];
  const due = getDueEmailReminders(s, NOW);
  const bc = due.find((d) => d.template.key === 'booking_confirmation');
  ok(!!bc, 'a failed booking_confirmation with budget left is eligible to retry');
  ok(bc.attempt === 3, 'retry bumps the attempt count (2 → 3)');
}

// 9. Per-contact Do Not Contact → the contact receives NO reminders at all,
//    booking_confirmation included, across email AND sms.
{
  const s = baseState({
    contacts: [{ id: 'ct1', firstName: 'Ann', email: 'ann@corp.com', phone: '+15551234', doNotContact: true }],
    // one completed job (post_service) + one fresh upcoming (booking_confirmation)
    jobs: [
      { id: 'jUp',  clientId: 'cl1', siteId: 's1', status: 'upcoming',  startAt: hoursFromNow(20), createdAt: hoursAgo(1) },
      { id: 'jDone', clientId: 'cl1', siteId: 's1', status: 'completed', startAt: hoursAgo(3),      createdAt: hoursAgo(1) },
    ],
  });
  ok(getDueEmailReminders(s, NOW).length === 0, 'DNC contact → zero due email reminders (booking + post_service both blocked)');
  ok(getDueReminders(s, NOW).length === 0, 'DNC contact → zero due reminders across all channels (incl. SMS)');
}

// 10. Per-contact reminderOptOut → zero reminders, including the transactional
//     booking_confirmation (opt-out is a total reminder mute, not marketing-only).
{
  const s = baseState({
    contacts: [{ id: 'ct1', firstName: 'Ann', email: 'ann@corp.com', phone: '+15551234', reminderOptOut: true }],
    jobs: [{ id: 'jUp', clientId: 'cl1', siteId: 's1', status: 'upcoming', startAt: hoursFromNow(20), createdAt: hoursAgo(1) }],
  });
  const due = getDueEmailReminders(s, NOW);
  ok(due.length === 0, 'reminderOptOut contact → zero due (booking_confirmation muted too)');
}

// 11. Marketing suppression list: a suppressed recipient email drops the
//     non-transactional post_service but NOT the transactional booking_confirmation.
{
  const s = baseState({
    marketingSuppressions: [{ email: 'ANN@corp.com', source: 'reply', reason: 'unsub', createdAt: hoursAgo(50) }],
    jobs: [
      { id: 'jUp',   clientId: 'cl1', siteId: 's1', status: 'upcoming',  startAt: hoursFromNow(20), createdAt: hoursAgo(1) },
      { id: 'jDone', clientId: 'cl1', siteId: 's1', status: 'completed', startAt: hoursAgo(3),      createdAt: hoursAgo(1) },
    ],
  });
  const due = getDueEmailReminders(s, NOW);
  ok(!due.some((d) => d.template.key === 'post_service'), 'suppressed email → post_service (non-transactional) excluded (case-insensitive match)');
  ok(due.some((d) => d.template.key === 'booking_confirmation'), 'suppressed email → booking_confirmation (transactional) still fires');
}

// 12. Suppression matches the RESOLVED recipient — the client.email fallback
//     when there's no linked contact. No contact = no DNC/optOut flags to honor,
//     so only the marketing-suppression gate applies (to post_service).
{
  const s = baseState({
    clients: [{ id: 'cl1', name: 'Acme', email: 'billing@corp.com' }], // no primaryContactId
    contacts: [],
    marketingSuppressions: [{ email: 'billing@corp.com', source: 'manual', reason: 'x', createdAt: hoursAgo(50) }],
    jobs: [
      { id: 'jUp',   clientId: 'cl1', siteId: 's1', status: 'upcoming',  startAt: hoursFromNow(20), createdAt: hoursAgo(1) },
      { id: 'jDone', clientId: 'cl1', siteId: 's1', status: 'completed', startAt: hoursAgo(3),      createdAt: hoursAgo(1) },
    ],
  });
  const due = getDueEmailReminders(s, NOW);
  ok(!due.some((d) => d.template.key === 'post_service'), 'suppression matches client.email fallback recipient → post_service excluded');
  ok(due.some((d) => d.template.key === 'booking_confirmation'), 'client.email fallback: booking_confirmation still fires (transactional)');
}

// 13. Regression: a clean contact (no flags, not suppressed) still fires
//     booking_confirmation + post_service as before.
{
  const s = baseState({
    jobs: [
      { id: 'jUp',   clientId: 'cl1', siteId: 's1', status: 'upcoming',  startAt: hoursFromNow(20), createdAt: hoursAgo(1) },
      { id: 'jDone', clientId: 'cl1', siteId: 's1', status: 'completed', startAt: hoursAgo(3),      createdAt: hoursAgo(1) },
    ],
  });
  const due = getDueEmailReminders(s, NOW);
  ok(due.some((d) => d.template.key === 'booking_confirmation'), 'clean contact regression: booking_confirmation fires');
  ok(due.some((d) => d.template.key === 'post_service'), 'clean contact regression: post_service fires');
}

console.log(`\nreminder-cron due-selection: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
