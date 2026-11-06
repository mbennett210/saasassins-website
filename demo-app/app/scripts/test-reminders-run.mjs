// THE CUSTOMER-MESSAGE RUN, end to end (api/reminders/run.js runCustomerMessages; Matt's approved
// messages, 2026-10-19): the real cron code and supabase-js against the local fake, a working Google
// mailbox, a stubbed Twilio.
//
//   R1  🔴 SENT ONCE at Matt's size: 750 finished cleans' summaries go once, and the next runs send
//       none — the dedupe is the TABLE (customer_messages), and the shared record is never written
//       (CS-119 / S128 F8-14: the capped list in org_state re-sent the 250 it dropped every tick)
//   R2  texts while Twilio is not set up: one log line, nothing sent, nothing recorded; then sent
//       once it is
//   R3  email while no mailbox is the system sender: one log line, nothing recorded
//   R4  the mailbox's daily ceiling holds email back (the rest waits), the run's size too
//   R5  the lease: a message another run is sending right now is not sent again
//   R6  a failed send is retried; at the last attempt it stops and the office gets ONE bell
//   R7  the history checks: the check-in only on a customer's FIRST finished clean (the jobs table's
//       history), the summary instead of it otherwise; the missed-visit apology not when someone
//       clocked in
//   R8  a series' twelve moved visits: one notice, the other eleven settled, nothing more later
//   R9  the dry run claims, sends and writes nothing
//   R10 the retention delete runs once an hour
//   R11 a nudge carries the opt-out line AND the one-click List-Unsubscribe header
//   R12 service setup on a customer's FIRST schedule (its booking confirmation settled); a later
//       schedule gets the booking confirmation and no setup email
//   R13 (Google reviews removed, 2026-10-20) the review request email and text that production
//       still stores, switched on, until the retire data-op runs: nothing is sent and no row is
//       written, however good the inspection
//   R14 complaints read from the tickets: the acknowledgement; not a visitor's report; no
//       resolution email when the hub already told the same person
//   R15 the upsell 90 days after the first schedule began (read from the jobs table)
//   R16 the agreement: the renewal notice from the contract module's own dates, a price rise
//       (never a drop), and a queued service change claimed and sent once
//   R17 billing (QuickBooks' read swapped for a fixture): the upcoming-due reminder with its pay
//       link, nothing without one, and on the 1st the statement with its PDF attached
//   R18 the survey: the email carries the customer's own link, whose token's hash is the row the
//       send wrote (one per email); a link that cannot be stored means no email
//   R19 (texting, 2026-10-28) a campaign text ends with the campaign's STOP line once, and its
//       sent-log row keeps the number in E.164 and the building
//   R20 a number that replied STOP (sms_opt_outs): refused before Twilio, no failure bell, never
//       retried
//   R21 the payment reminder text (texts are the campaign's three only; billing is email):
//       production's stored, switched-on template sends nothing and writes no row
//   R22 (task 477) a clean the office is entering: the 2026-11-03 incident through the run — a
//       schedule entered 108 seconds ago, its first visit earlier that day and its next the day
//       after, sends nothing and writes no row; the same cleans entered the day before send both
// REGRESSION for R22 (THE LAW II.3): on ba2d6fc7 R22a fails (the apology and the 24-hour text go).
// REGRESSION for R19–R21 (THE LAW II.3): on e489af8f the text carries no STOP line, a STOP is
// unknown (the text goes), and the past-due text is sent.
// It replaces test-reminder-dedupe.mjs (whose list and keepUntil no longer exist).
// REGRESSION (THE LAW II.3): on 811e54eb there is no runCustomerMessages and no sent-log table:
// every check fails.
//   node app/scripts/test-reminders-run.mjs
import { startFakeSupabase } from './fake-supabase-server.mjs';

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail). Label first.
const ok = (label, cond, detail) => { if (cond) pass += 1; else fails.push(detail === undefined ? label : `${label} (got ${typeof detail === 'string' ? detail : JSON.stringify(detail)})`); };
const soft = async (rel) => { try { return await import(new URL(rel, import.meta.url).href); } catch (e) { return { __error: e?.message || String(e) }; } };

const ORG = '00000000-0000-0000-0000-0000000f0aaa';
const fake = await startFakeSupabase();
Object.assign(process.env, {
  SUPABASE_URL: fake.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-role', SUPABASE_ANON_KEY: 'fake-anon',
  CLEANSPACE_ORG_ID: ORG, FORMS_ORG_ID: ORG, CRON_SECRET: 'cron-run-test', APP_PUBLIC_URL: 'https://app.run.test',
  INBOX_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'),
});
for (const k of ['SYSTEM_SENDER_EMAIL', 'ALERT_WEBHOOK_URL', 'APP_BASE_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'TWILIO_MESSAGING_SERVICE_SID']) delete process.env[k];
const twilioOn = (on) => {
  if (on) Object.assign(process.env, { TWILIO_ACCOUNT_SID: 'ACfake', TWILIO_AUTH_TOKEN: 'tok', TWILIO_FROM_NUMBER: '+15550000000' });
  else for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER']) delete process.env[k];
};

const realFetch = globalThis.fetch;
const strays = [];
let gmail = [];
let twilio = [];
let gmailFails = false;
globalThis.fetch = (input, init) => {
  const u = String(typeof input === 'string' ? input : input?.url ?? input);
  if (u.startsWith(fake.url)) return realFetch(input, init);
  if (u.includes('gmail.googleapis.com') && u.includes('/messages/send')) {
    gmail.push(Buffer.from(init?.body || '').toString('utf8'));
    return Promise.resolve(gmailFails
      ? new Response(JSON.stringify({ error: { message: 'fake: Gmail refused it' } }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ id: `gm_${gmail.length}` }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  }
  if (u.startsWith('https://api.twilio.com/')) {
    twilio.push(String(init?.body || ''));
    return Promise.resolve(new Response(JSON.stringify({ sid: `SM${twilio.length}` }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
  }
  strays.push(u);
  return Promise.reject(new Error(`offline suite: refused ${u}`));
};
const logs = [];
const saved = { log: console.log, warn: console.warn, error: console.error };
console.warn = (...a) => logs.push(a.join(' '));
console.error = (...a) => logs.push(a.join(' '));

const runMod = await soft('../api/reminders/run.js');
const run = typeof runMod.runCustomerMessages === 'function' ? runMod.runCustomerMessages : async () => ({ __missing: runMod.__error });
const CM = await soft('../src/lib/customerMessages.js');
const RS = await soft('../src/lib/reminderScheduler.js');
const { encrypt } = await import('../api/_lib/crypto.js');
const { __resetSystemSenderCache } = await import('../api/_lib/systemSender.js');
ok('the run and the catalog load', !!runMod.runCustomerMessages && !!CM.MESSAGE_KEY, runMod.__error || CM.__error);
const K = CM.MESSAGE_KEY || {};
const mk = (...a) => (typeof RS.messageKey === 'function' ? RS.messageKey(...a) : '?');

const HOUR = 3600e3;
// Today, 15:30 UTC (10:30 or 11:30 in New York) — inside the window, minute 30 (no reap).
const base = new Date(); base.setUTCHours(15, 30, 0, 0);
const NOW = base;
const iso = (ms) => new Date(ms).toISOString();
const ago = (h, now = NOW) => iso(now.getTime() - h * HOUR);
const ahead = (h, now = NOW) => iso(now.getTime() + h * HOUR);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const MAILBOX = () => ({
  id: uuid(9), organization_id: ORG, email: 'alerts@run.test', display_name: 'alerts@run.test', provider: 'google', status: 'active',
  refresh_token_enc: encrypt('r'), access_token_enc: encrypt('a'), access_token_expires_at: ahead(1, new Date()), owner_user_id: null, workspace_id: null, is_system_sender: true,
});
const on = (keys) => (CM.DEFAULT_REMINDER_TEMPLATES || []).map((t) => ({ ...t, enabled: keys.includes(t.key) }));
// N real customers (newId-shaped ids), each with a contact and a location.
function book(n, templates) {
  const clients = []; const contacts = []; const sites = [];
  for (let i = 0; i < n; i += 1) {
    clients.push({ id: `cl_r${i}x`, name: `Building ${i}`, email: `b${i}@corp.test`, phone: `+1555555${String(i).padStart(4, '0')}`, primaryContactId: `ct_r${i}x` });
    contacts.push({ id: `ct_r${i}x`, firstName: `Pat${i}`, lastName: 'Lee', email: `pat${i}@corp.test`, phone: `+1666555${String(i).padStart(4, '0')}`, companyId: `cl_r${i}x` });
    sites.push({ id: `st_r${i}x`, clientId: `cl_r${i}x`, name: `Building ${i}, Lobby` });
  }
  return {
    company: { name: 'Run Co', email: 'office@run.test', phone: '555-0100', timezone: 'America/New_York' },
    reminderTemplates: templates, clients, contacts, sites, services: [{ id: 'sv_r1x', name: 'Janitorial' }],
    users: [{ id: 'u_rmgrx', name: 'Office Manager', role: 'owner', status: 'active', notificationPrefs: {} }],
    permissions: {}, userPermissionOverrides: [], notifications: [], marketingSuppressions: [],
  };
}
const jobRow = (j) => ({ id: j.id, organization_id: ORG, data: j, start_at: j.startAt, status: j.status, client_id: j.clientId, site_id: j.siteId, series_id: j.seriesId ?? null });
function world({ state, jobs = [], log = [], timeEntries = [], mailbox = true, extra = {} }) {
  gmail = []; twilio = []; logs.length = 0; gmailFails = false;
  __resetSystemSenderCache();
  fake.reset({
    orgState: { organization_id: ORG, version: 7, protected_fingerprint: null, min_client_build: null, state },
    timeEntries,
    tables: { inbox_accounts: mailbox ? [MAILBOX()] : [], sent_messages: [], customer_messages: log, sms_opt_outs: [], jobs: jobs.map(jobRow), problem_reports: [], inspection_records: [], client_users: [], contract_reminders: [], contracts: [], contract_buildings: [], contract_years: [], customer_surveys: [], ...extra },
  });
}
const table = () => fake.db.tables.get('customer_messages') || [];
// The text of a MIME message the fake Gmail received (its base64 body part, decoded).
const bodyOf = (mime) => {
  const m = /Content-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+)/.exec(String(mime || ''));
  return m ? Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8') : String(mime || '');
};
const finished = (i, { hoursAgo = 2, client = i } = {}) => ({ id: `j_r${i}x`, clientId: `cl_r${client}x`, siteId: `st_r${client}x`, serviceId: 'sv_r1x', status: 'done', startAt: ago(hoursAgo + 2), endAt: ago(hoursAgo), seriesId: null, recurrence: null, createdAt: ago(500) });
// Each customer's earlier finished clean, eight days ago: outside the window, in the table — so
// "is this their first clean?" needs the database's history.
const history = (i) => ({ ...finished(i), id: `j_r${i}old`, startAt: ago(8 * 24 + 2), endAt: ago(8 * 24) });

// ── R1 sent once at 750 ──────────────────────────────────────────────────────
{
  const N = 750;
  const jobs = Array.from({ length: N }, (_, i) => finished(i));
  world({ state: book(N, on([K.visitSummary])), jobs });
  const v0 = fake.db.orgState.version;
  let total = 0;
  for (let i = 0; i < 9; i += 1) { const r = await run({ now: new Date(NOW.getTime() + i * 5 * 60e3) }); total += r.sent || 0; }
  const sentRows = table().filter((r) => r.status === 'sent');
  ok('🔴 R1a 750 finished cleans: 750 summaries over the runs it takes (100 a run), each ONCE', total === N && gmail.length === N && sentRows.length === N, { total, gmail: gmail.length, rows: sentRows.length });
  ok('R1b …one sent-log row each, keyed by the clean', new Set(sentRows.map((r) => r.id)).size === N && sentRows.every((r) => r.id.startsWith(`${K.visitSummary}:`)));
  const again = await run({ now: new Date(NOW.getTime() + 60 * 60e3) });
  ok('🔴 R1c the next run, an hour on, sends none (the table, not a capped list, is the dedupe)', again.sent === 0 && gmail.length === N, again);
  ok('R1d the shared record is never written (no reminderEvents, the version unchanged)', fake.db.orgState.version === v0 && !('reminderEvents' in fake.db.orgState.state), fake.db.orgState.version);
  ok('R1e no run sent more than MAX_SENDS_PER_RUN', runMod.MAX_SENDS_PER_RUN === 100);
}

// ── R2 texts without Twilio ──────────────────────────────────────────────────
{
  const tomorrow = { ...finished(0), id: 'j_r0t', status: 'upcoming', startAt: ahead(26), endAt: ahead(27) };
  twilioOn(false);
  world({ state: book(1, on([K.reminder24h])), jobs: [tomorrow] });
  const r = await run({ now: NOW });
  ok('🔴 R2a Twilio not set up: the text is skipped — no Twilio call, nothing recorded, never an error', r.sent === 0 && r.failed === 0 && twilio.length === 0 && table().length === 0, { r, rows: table().length });
  ok('R2b …with ONE log line saying so', logs.filter((l) => /text\(s\) not sent: texting is not set up/.test(l)).length === 1, logs);
  twilioOn(true);
  const r2 = await run({ now: NOW });
  ok('R2c once Twilio is set up, the still-due text goes (to the contact\'s phone)', r2.sent === 1 && twilio.length === 1 && /To=%2B16665550000/.test(twilio[0]), { r2, t: twilio[0] });
  twilioOn(false);
}

// ── R3 email without a sender ────────────────────────────────────────────────
{
  world({ state: book(1, on([K.visitSummary])), jobs: [finished(0)], mailbox: false });
  const r = await run({ now: NOW });
  ok('R3 no system sender: nothing sent, nothing recorded, one log line', r.sent === 0 && table().length === 0 && logs.filter((l) => /email\(s\) not sent: no Google mailbox/.test(l)).length === 1, { r, logs });
}

// ── R4 the daily ceiling ─────────────────────────────────────────────────────
{
  const budget = runMod.CUSTOMER_EMAIL_DAILY_BUDGET;
  const startOfDay = new Date(NOW); startOfDay.setUTCHours(5, 0, 0, 0);    // 00:00 or 01:00 New York
  const today = Array.from({ length: budget - 2 }, (_, i) => ({ organization_id: ORG, id: `x:${i}`, template_key: 'visit_summary', channel: 'email', status: 'sent', attempts: 1, sent_at: iso(startOfDay.getTime() + 6 * HOUR), keep_until: ahead(500), created_at: iso(startOfDay.getTime() + 6 * HOUR), updated_at: iso(startOfDay.getTime() + 6 * HOUR) }));
  world({ state: book(5, on([K.visitSummary])), jobs: Array.from({ length: 5 }, (_, i) => finished(i)), log: today });
  const r = await run({ now: NOW });
  ok(`🔴 R4 with ${budget - 2} emails already sent today, two more go and three wait (CUSTOMER_EMAIL_DAILY_BUDGET ${budget})`, r.sent === 2 && r.deferred === 3 && gmail.length === 2, r);
}

// ── R5 the lease ─────────────────────────────────────────────────────────────
{
  const id = mk(K.visitSummary, 'j_r0x');
  world({ state: book(1, on([K.visitSummary])), jobs: [finished(0)], log: [{ organization_id: ORG, id, template_key: K.visitSummary, channel: 'email', status: 'sending', attempts: 1, created_at: ago(0.05), updated_at: ago(0.05), sent_at: null, keep_until: ahead(500) }] });
  const r = await run({ now: NOW });
  ok('🔴 R5a a message another run is sending now is NOT sent again', r.sent === 0 && gmail.length === 0, r);
  world({ state: book(1, on([K.visitSummary])), jobs: [finished(0)], log: [{ organization_id: ORG, id, template_key: K.visitSummary, channel: 'email', status: 'sending', attempts: 1, created_at: ago(1), updated_at: ago(1), sent_at: null, keep_until: ahead(500) }] });
  const r2 = await run({ now: NOW });
  ok('R5b …a claim abandoned an hour ago (the run died) is taken up and sent', r2.sent === 1 && gmail.length === 1, r2);
}

// ── R6 retries and the bell ──────────────────────────────────────────────────
{
  const id = mk(K.visitSummary, 'j_r0x');
  const max = RS.MAX_REMINDER_ATTEMPTS;
  world({ state: book(1, on([K.visitSummary])), jobs: [finished(0)], log: [{ organization_id: ORG, id, template_key: K.visitSummary, channel: 'email', status: 'failed', attempts: 1, created_at: ago(1), updated_at: ago(1), sent_at: null, keep_until: ahead(500) }] });
  const r = await run({ now: NOW });
  ok('R6a a failed message with attempts left is retried and goes', r.sent === 1 && table().find((x) => x.id === id)?.status === 'sent' && table().find((x) => x.id === id)?.attempts === 2, table());
  world({ state: book(1, on([K.visitSummary])), jobs: [finished(0)], log: [{ organization_id: ORG, id, template_key: K.visitSummary, channel: 'email', status: 'failed', attempts: max - 1, created_at: ago(1), updated_at: ago(1), sent_at: null, keep_until: ahead(500) }] });
  gmailFails = true;
  const r2 = await run({ now: NOW });
  const bells = (fake.db.orgState.state.notifications || []).filter((n) => n.eventKey === 'reminderFailed');
  ok('🔴 R6b its last attempt fails: recorded failed at the limit, and the office gets ONE reminderFailed bell', r2.failed === 1 && table().find((x) => x.id === id)?.attempts === max && bells.length === 1 && /Building 0/.test(bells[0].title), { r2, bells });
  gmailFails = false;
  const r3 = await run({ now: NOW });
  ok('R6c …and it is never tried again', r3.sent === 0 && r3.failed === 0 && gmail.length === 1, r3);
}

// ── R7 the history checks ────────────────────────────────────────────────────
{
  // Customer 0: this is their FIRST clean. Customer 1: they had one eight days ago (in the table only).
  world({ state: book(2, on([K.postService, K.visitSummary])), jobs: [finished(0), finished(1), history(1)] });
  const r = await run({ now: NOW });
  const rows = new Map(table().map((x) => [x.id, x.status]));
  ok('🔴 R7a a customer\'s first clean: the check-in goes, and the summary is settled instead (one email)', rows.get(mk(K.postService, 'cl_r0x')) === 'sent' && rows.get(mk(K.visitSummary, 'j_r0x')) === 'skipped', [...rows]);
  ok('🔴 R7b a customer whose first clean was LONG ago (outside the window, in the table): no check-in, the summary goes', rows.get(mk(K.postService, 'cl_r1x')) === 'skipped' && rows.get(mk(K.visitSummary, 'j_r1x')) === 'sent', [...rows]);
  ok('R7c two emails sent in all', r.sent === 2 && gmail.length === 2, r);
  const graceMs = (RS.DEFAULT_CLOCK_IN_GRACE_MINS || 120) * 60e3;
  const missed = (i) => ({ ...finished(i), id: `j_r${i}m`, status: 'upcoming', startAt: iso(NOW.getTime() - graceMs - 3 * HOUR), endAt: iso(NOW.getTime() - graceMs - HOUR) });
  world({ state: book(2, on([K.missedVisit])), jobs: [missed(0), missed(1)], timeEntries: [{ id: uuid(1), organization_id: ORG, job_id: 'j_r1m', user_id: 'u_crewx', status: 'pending', clock_in_at: ago(5) }] });
  const r2 = await run({ now: NOW });
  const rows2 = new Map(table().map((x) => [x.id, x.status]));
  ok('🔴 R7d the missed-visit apology: sent where nobody clocked in, settled where someone did (a lost status write is not a miss)', rows2.get(mk(K.missedVisit, 'j_r0m')) === 'sent' && rows2.get(mk(K.missedVisit, 'j_r1m')) === 'skipped' && r2.sent === 1, [...rows2]);
}

// ── R8 six moved visits (every one inside the run's 45-day window) ─────────────
{
  const moved = Array.from({ length: 6 }, (_, i) => ({ ...finished(0), id: `j_rmv${i}`, seriesId: 'ser_r1x', status: 'upcoming', startAt: ahead(50 + i * 168), endAt: ahead(52 + i * 168), rescheduledAt: ago(1), rescheduledFrom: ahead(48 + i * 168) }));
  world({ state: book(1, on([K.reschedule])), jobs: moved });
  const r = await run({ now: NOW });
  const statuses = table().map((x) => x.status).sort();
  ok('🔴 R8a six visits moved by one series edit: ONE email, about the next visit', r.sent === 1 && gmail.length === 1 && /rescheduled to/.test(bodyOf(gmail[0])), r);
  ok('R8b …and the other five are settled in the sent log', statuses.filter((s) => s === 'skipped').length === 5 && statuses.filter((s) => s === 'sent').length === 1, statuses);
  const r2 = await run({ now: new Date(NOW.getTime() + 5 * 60e3) });
  ok('R8c the next run sends nothing more', r2.sent === 0, r2);
}

// ── R9 the dry run ───────────────────────────────────────────────────────────
{
  world({ state: book(3, on([K.visitSummary])), jobs: [0, 1, 2].map((i) => finished(i)) });
  const r = await run({ now: NOW, dryRun: true });
  ok('R9 the dry run lists the three it would send, sends none and writes nothing', Array.isArray(r.due) && r.due.length === 3 && gmail.length === 0 && table().length === 0 && r.due.every((d) => d.sampleRecord === null), r);
}

// ── R10 the retention delete ─────────────────────────────────────────────────
{
  const old = { organization_id: ORG, id: 'old:1', template_key: 'visit_summary', channel: 'email', status: 'sent', attempts: 1, sent_at: ago(900), keep_until: ago(1), created_at: ago(900), updated_at: ago(900) };
  const kept = { ...old, id: 'kept:1', keep_until: ahead(100) };
  world({ state: book(1, on([])), log: [old, kept] });
  const at35 = new Date(NOW); at35.setUTCMinutes(35);
  await run({ now: at35 });
  ok('R10a minute 35: no retention delete', table().length === 2);
  const at02 = new Date(NOW); at02.setUTCMinutes(2);
  await run({ now: at02 });
  ok('R10b minute 2 (once an hour): the row past keep_until goes, the other stays', table().length === 1 && table()[0].id === 'kept:1', table().map((x) => x.id));
}

// ── R11 the nudge's opt-out ──────────────────────────────────────────────────
{
  world({ state: book(1, on([K.postService])), jobs: [finished(0)] });
  await run({ now: NOW });
  const mime = gmail[0] || '';
  ok('R11a the first-clean check-in (a nudge) carries the one-click List-Unsubscribe header', /List-Unsubscribe: <https:\/\/app\.run\.test\/api\/unsubscribe\?t=/.test(mime) && /List-Unsubscribe-Post: List-Unsubscribe=One-Click/.test(mime), mime.slice(0, 600));
  ok('R11b …and the opt-out line with the same signed link in its words', /To stop these emails, unsubscribe here: https:\/\/app\.run\.test\/api\/unsubscribe\?t=/.test(bodyOf(mime)), bodyOf(mime));
}

// ── R12 service setup and the booking confirmation ───────────────────────────
{
  const master = (i, sid, createdHoursAgo = 2) => ({ ...finished(i), id: `j_r${i}${sid}`, seriesId: `ser_${sid}x`, recurrence: { frequency: 'weekly', daysOfWeek: [2] }, status: 'upcoming', startAt: ahead(30), endAt: ahead(32), createdAt: ago(createdHoursAgo) });
  const oldVisit = (i, sid) => ({ ...finished(i), id: `j_r${i}${sid}o`, seriesId: `ser_${sid}x`, status: 'done', startAt: ago(60 * 24), endAt: ago(60 * 24 - 2) });
  // Customer 0: a first schedule. Customer 1: a new schedule beside one they have had for months.
  world({ state: book(2, on([K.serviceSetup, K.bookingConfirmation])), jobs: [master(0, 'a'), master(1, 'b'), oldVisit(1, 'old')] });
  const r = await run({ now: NOW });
  const rows = new Map(table().map((x) => [x.id, x.status]));
  ok('🔴 R12a a first schedule: the setup email goes, and its booking confirmation is settled (one email)', rows.get(mk(K.serviceSetup, 'cl_r0x')) === 'sent' && rows.get(mk(K.bookingConfirmation, 'ser_ax')) === 'skipped', [...rows]);
  ok('🔴 R12b a customer\'s SECOND schedule: the booking confirmation goes, no setup email', rows.get(mk(K.bookingConfirmation, 'ser_bx')) === 'sent' && rows.get(mk(K.serviceSetup, 'cl_r1x')) === 'skipped', [...rows]);
  ok('R12c two emails in all', r.sent === 2 && gmail.length === 2, r);
}

// ── R13 the retired review requests send nothing ─────────────────────────────
{
  const { RETIRED_MESSAGE_KEYS } = await import('./dataop-retire-google-reviews.mjs');
  const stored = RETIRED_MESSAGE_KEYS.map((key) => ({ id: `rt_${key}`, key, channel: key.endsWith('_sms') ? 'sms' : 'email', subject: 'How are we doing?', body: 'Hi {first_name}: {review_link}', enabled: true }));
  const state = book(2, [...on([]), ...stored]);
  state.company.googleReviewUrl = 'https://g.page/r/run-co/review';
  const insp = (i) => ({ id: uuid(100 + i), organization_id: ORG, client_id: `cl_r${i}x`, site_id: `st_r${i}x`, overall_score: 100, status: 'submitted', performed_at: ago(3) });
  world({ state, extra: { inspection_records: [insp(0), insp(1)] } });
  const r = await run({ now: NOW });
  ok('🔴 R13 the review request templates production still stores (on) send nothing and write no row, after a perfect inspection',
    RETIRED_MESSAGE_KEYS.length === 2 && r.sent === 0 && gmail.length === 0 && twilio.length === 0 && table().length === 0, { r, rows: table().length });
}

// ── R14 complaints ───────────────────────────────────────────────────────────
{
  const ticket = (id, o) => ({ id: uuid(id), organization_id: ORG, client_id: 'cl_r0x', site_id: 'st_r0x', type: 'complaint', origin: 'internal', status: 'open', created_at: ago(1), resolved_at: null, raised_by_client_user_id: null, ...o });
  const cu = { id: uuid(300), organization_id: ORG, email: 'pat0@corp.test', status: 'active', email_prefs: null };
  world({
    state: book(1, on([K.complaintAck, K.complaintResolution])),
    extra: {
      problem_reports: [
        ticket(201),
        ticket(202, { origin: 'visitor' }),
        ticket(203, { status: 'resolved', created_at: ago(200), resolved_at: ago(1), origin: 'portal', raised_by_client_user_id: uuid(300) }),
        ticket(204, { status: 'resolved', created_at: ago(200), resolved_at: ago(2) }),
      ],
      client_users: [cu],
    },
  });
  await run({ now: NOW });
  const rows = new Map(table().map((x) => [x.id, x.status]));
  ok('R14a a logged complaint: the acknowledgement goes', rows.get(mk(K.complaintAck, uuid(201))) === 'sent', [...rows]);
  ok('R14b a visitor\'s report: no acknowledgement to the customer', !rows.has(mk(K.complaintAck, uuid(202))), [...rows]);
  ok('🔴 R14c resolved from the hub by the main contact, who gets the hub\'s emails: no second email', !rows.has(mk(K.complaintResolution, uuid(203))), [...rows]);
  ok('R14d an office-logged complaint resolved: the resolution email goes', rows.get(mk(K.complaintResolution, uuid(204))) === 'sent', [...rows]);
}

// ── R15 the upsell ───────────────────────────────────────────────────────────
{
  const U = CM.UPSELL_AFTER_DAYS;
  const start = (i, daysAgo) => ({ ...finished(i), id: `j_r${i}up`, seriesId: `ser_up${i}x`, recurrence: { frequency: 'weekly' }, status: 'done', startAt: ago(daysAgo * 24), endAt: ago(daysAgo * 24 - 2) });
  const earlier = { ...finished(1), id: 'j_r1early', seriesId: 'ser_early1x', status: 'done', startAt: ago(400 * 24), endAt: ago(400 * 24 - 2) };
  world({ state: book(2, on([K.upsell])), jobs: [start(0, U), start(1, U), earlier] });
  await run({ now: NOW });
  const rows = new Map(table().map((x) => [x.id, x.status]));
  ok(`🔴 R15a a customer whose first schedule began ${U} days ago: the upsell`, rows.get(mk(K.upsell, 'cl_r0x')) === 'sent', [...rows]);
  ok('R15b a customer with a schedule from long before: no upsell (their service did not start then)', rows.get(mk(K.upsell, 'cl_r1x')) === 'skipped', [...rows]);
}

// ── R16 the agreement ────────────────────────────────────────────────────────
{
  const { dayKey, addDaysKey } = await import('../src/lib/dates.js');
  const today = dayKey(NOW, 'America/New_York');
  const cid = uuid(400); const cid2 = uuid(401);
  const tables = {
    contracts: [{ id: cid, organization_id: ORG, name: 'Tower agreement', status: 'active' }, { id: cid2, organization_id: ORG, name: 'Annex', status: 'active' }],
    contract_buildings: [{ id: uuid(410), organization_id: ORG, contract_id: cid, client_id: 'cl_r0x' }, { id: uuid(411), organization_id: ORG, contract_id: cid2, client_id: 'cl_r1x' }],
    contract_reminders: [
      { id: uuid(420), organization_id: ORG, contract_id: cid, kind: 'renewal', target_date: addDaysKey(today, CM.RENEWAL_NOTICE_LEAD_DAYS), status: 'pending' },
      { id: uuid(421), organization_id: ORG, contract_id: cid2, kind: 'price_increase', target_date: addDaysKey(today, CM.PRICE_INCREASE_LEAD_DAYS), status: 'pending' },
    ],
    contract_years: [
      { id: uuid(430), organization_id: ORG, contract_id: cid2, starts_on: addDaysKey(today, -335), monthly_cents: 100000 },
      { id: uuid(431), organization_id: ORG, contract_id: cid2, starts_on: addDaysKey(today, CM.PRICE_INCREASE_LEAD_DAYS), monthly_cents: 90000 },
    ],
  };
  world({ state: book(2, on([K.renewalNotice, K.priceIncrease])), extra: tables });
  await run({ now: NOW });
  const rows = new Map(table().map((x) => [x.id, x.status]));
  ok(`🔴 R16a an auto-renewal ${CM.RENEWAL_NOTICE_LEAD_DAYS} days out (the contract module's own date): the renewal notice`, rows.get(mk(K.renewalNotice, cid, addDaysKey(today, CM.RENEWAL_NOTICE_LEAD_DAYS), 'cl_r0x')) === 'sent', [...rows]);
  ok('R16b a price DROP 30 days out: no "increase" notice', ![...rows.keys()].some((k) => k.startsWith(`${K.priceIncrease}:`)), [...rows]);
  const rise = { ...tables, contract_years: [tables.contract_years[0], { ...tables.contract_years[1], monthly_cents: 110000 }] };
  world({ state: book(2, on([K.priceIncrease])), extra: rise });
  await run({ now: NOW });
  ok('R16c …and a RISE: the price-increase notice', table().some((x) => x.id === mk(K.priceIncrease, cid2, addDaysKey(today, CM.PRICE_INCREASE_LEAD_DAYS), 'cl_r1x') && x.status === 'sent'), table().map((x) => [x.id, x.status]));
  const queued = { organization_id: ORG, id: `${K.serviceChange}:${cid}:123:cl_r0x`, template_key: K.serviceChange, channel: 'email', client_id: 'cl_r0x', status: 'pending', attempts: 0, payload: { contractId: cid, summary: ['New schedule: 3x per week'], effectiveDay: today }, created_at: ago(1), updated_at: ago(1), sent_at: null, keep_until: ahead(500) };
  world({ state: book(1, on([K.serviceChange])), log: [queued] });
  const r = await run({ now: NOW });
  const row = table().find((x) => x.id === queued.id);
  ok('🔴 R16d a queued service change: claimed and sent once, its row now sent', r.sent === 1 && row?.status === 'sent' && /New schedule: 3x per week/.test(bodyOf(gmail[0])), { r, row });
  const r2 = await run({ now: new Date(NOW.getTime() + 5 * 60e3) });
  ok('R16e …and never again', r2.sent === 0 && gmail.length === 1, r2);
}

// ── R17 billing ──────────────────────────────────────────────────────────────
{
  const B = await soft('../api/_lib/customerMessages/billing.js');
  const { dayKey, addDaysKey } = await import('../src/lib/dates.js');
  const today = dayKey(NOW, 'America/New_York');
  let asked = [];
  B.__setBillingReaderForTests?.(async (q) => {
    asked.push(q);
    return {
      invoices: [
        { id: '1001', number: 'CS-1042', clientId: 'cl_r0x', dueDay: addDaysKey(today, CM.UPCOMING_DUE_LEAD_DAYS), balanceCents: 116000, totalCents: 116000, payLink: 'https://connect.intuit.com/pay/1001' },
        { id: '1002', number: 'CS-1043', clientId: 'cl_r1x', dueDay: addDaysKey(today, CM.UPCOMING_DUE_LEAD_DAYS), balanceCents: 5000, totalCents: 5000, payLink: null },
      ],
      statements: q.withStatements ? [{ clientId: 'cl_r0x', month: 'm', periodStart: addDaysKey(today, -30), periodEnd: addDaysKey(today, -1), balanceCents: 116000, invoices: [{ number: 'CS-1042', issuedDay: addDaysKey(today, -5), totalCents: 116000, balanceCents: 116000 }], payments: [] }] : [],
    };
  });
  world({ state: book(2, on([K.upcomingDue])) });
  const r = await run({ now: NOW });
  const rows = new Map(table().map((x) => [x.id, x.status]));
  ok('🔴 R17a an invoice due in 7 days with a pay link: the reminder goes, with the link', rows.get(mk(K.upcomingDue, '1001', addDaysKey(today, CM.UPCOMING_DUE_LEAD_DAYS))) === 'sent' && bodyOf(gmail[0]).includes('https://connect.intuit.com/pay/1001'), [...rows]);
  ok('R17b an invoice QuickBooks gives no pay link: nothing (and nothing recorded, so a link later still works)', !rows.has(mk(K.upcomingDue, '1002', addDaysKey(today, CM.UPCOMING_DUE_LEAD_DAYS))) && r.sent === 1, [...rows]);
  ok('R17c QuickBooks was asked once, for invoices only (not a statement day)', asked.length === 1 && asked[0].withStatements === false, asked);
  const first = new Date(NOW); first.setUTCDate(1); first.setUTCHours(15, 30, 0, 0);
  asked = [];
  world({ state: book(2, on([K.statement])) });
  const r2 = await run({ now: first });
  const mime = gmail[0] || '';
  ok('🔴 R17d on the 1st: the statement goes, with its PDF attached', r2.sent === 1 && /Content-Type: application\/pdf/i.test(mime) && /statement-/.test(mime) && /Current balance: \$1,160\.00/.test(bodyOf(mime)), { r2, head: mime.slice(0, 300) });
  ok('R17e …and QuickBooks was asked for the statement too', asked[0]?.withStatements === true, asked);
  B.__setBillingReaderForTests?.(null);
}

// ── R18 the survey's link ────────────────────────────────────────────────────
{
  const { createHash } = await import('node:crypto');
  // Find a day this customer is due (their slot in the cycle), at 11:30 New York.
  let when = null;
  for (let d = 0; d < (CM.SURVEY_EVERY_DAYS || 91) && !when; d += 1) {
    const at = new Date(NOW.getTime() + d * 864e5);
    const st = book(1, on([K.satisfactionSurvey]));
    st.clients[0].createdAt = ago(400 * 24);
    const items = (RS.getDueMessages?.({ state: st, jobs: [{ ...finished(0), status: 'upcoming', startAt: ahead(30, at), endAt: ahead(31, at) }] }, at) || []).filter((x) => x.templateKey === K.satisfactionSurvey);
    if (items.length) when = at;
  }
  ok('R18a the customer comes due on some day of the cycle', !!when);
  if (when) {
    const st = book(1, on([K.satisfactionSurvey]));
    st.clients[0].createdAt = ago(400 * 24);
    world({ state: st, jobs: [{ ...finished(0), status: 'upcoming', startAt: ahead(30, when), endAt: ahead(31, when) }] });
    const r = await run({ now: when });
    const text = bodyOf(gmail[0]);
    const m = /https:\/\/app\.run\.test\/survey\/([A-Za-z0-9_-]{43})/.exec(text);
    const rows = fake.db.tables.get('customer_surveys') || [];
    ok('🔴 R18b the survey email carries the customer\'s own link (no placeholder left)', r.sent === 1 && !!m && !text.includes('{survey_link}'), text.slice(0, 400));
    ok('🔴 R18c …and the row the send wrote holds that token\'s hash, for this customer and this message', rows.length === 1 && m && rows[0].token_hash === createHash('sha256').update(m[1]).digest('hex') && rows[0].client_id === 'cl_r0x' && rows[0].message_id.startsWith(`${K.satisfactionSurvey}:cl_r0x:`), rows);
    world({ state: st, jobs: [{ ...finished(0), status: 'upcoming', startAt: ahead(30, when), endAt: ahead(31, when) }] });
    fake.failTable('customer_surveys');
    const r2 = await run({ now: when });
    ok('R18d a link that cannot be stored: no email, the message recorded failed', r2.sent === 0 && r2.failed === 1 && gmail.length === 0, r2);
  }
}

// ── R19 the STOP line on a campaign text ─────────────────────────────────────
// ── R20 a number that replied STOP ───────────────────────────────────────────
// ── R21 the payment reminder text production still stores ────────────────────
{
  const tomorrow = { ...finished(0), id: 'j_r0t', status: 'upcoming', startAt: ahead(26), endAt: ahead(27) };
  const LINE = CM.SMS_STOP_LINE;
  twilioOn(true);
  world({ state: book(1, on([K.reminder24h])), jobs: [tomorrow] });
  await run({ now: NOW });
  const body = new URLSearchParams(twilio[0] || '').get('Body') || '';
  ok('🔴 R19 the 24-hour reminder text ends with the campaign\'s STOP line, once', typeof LINE === 'string' && body.endsWith(LINE) && body.split(LINE).length === 2, body);
  const row = table()[0];
  ok('R19 …and the sent log records the number as E.164 and the building, so a reply finds its way back', row?.recipient === '+16665550000' && row?.client_id === 'cl_r0x' && row?.channel === 'sms', row);

  world({ state: book(1, on([K.reminder24h])), jobs: [tomorrow], extra: { sms_opt_outs: [{ organization_id: ORG, phone: '+16665550000', opted_out_at: ago(24), source: 'reply', keyword: 'STOP', updated_at: ago(24) }] } });
  const r = await run({ now: NOW });
  const stopped = table()[0];
  const bells = (fake.db.orgState.state.notifications || []).filter((n) => n.eventKey === 'reminderFailed');
  ok('🔴 R20a the contact\'s number replied STOP: the text is refused — no Twilio call', twilio.length === 0 && stopped?.status === 'refused' && stopped?.failure_reason === 'opted-out', { r, stopped, twilio: twilio.length });
  ok('🔴 R20b …it is no failure: no reminderFailed bell for the office, not counted failed', bells.length === 0 && r.failed === 0, { r, bells });
  const r2 = await run({ now: new Date(NOW.getTime() + 5 * 60e3) });
  ok('R20c …and it is never tried again', r2.sent === 0 && r2.failed === 0 && twilio.length === 0 && table()[0]?.status === 'refused', r2);

  const B = await soft('../api/_lib/customerMessages/billing.js');
  const { dayKey, addDaysKey } = await import('../src/lib/dates.js');
  const today = dayKey(NOW, 'America/New_York');
  B.__setBillingReaderForTests?.(async () => ({ invoices: [{ id: '2001', number: 'CS-2001', clientId: 'cl_r0x', dueDay: addDaysKey(today, -1), balanceCents: 5000, totalCents: 5000, payLink: 'https://connect.intuit.com/pay/2001' }], statements: [] }));
  const stored = { id: 'rt_payment_sms', key: 'payment_reminder_sms', channel: 'sms', subject: '', body: 'Invoice {invoice_number} is past due: {pay_link}', enabled: true };
  world({ state: book(1, [...on([]), stored]) });
  const r3 = await run({ now: NOW });
  ok('🔴 R21 the payment reminder text production still stores (switched on), an invoice past due: nothing is texted and no row is written', r3.sent === 0 && twilio.length === 0 && gmail.length === 0 && table().length === 0 && !('paymentReminderSms' in K), { r3, rows: table().map((x) => x.id) });
  B.__setBillingReaderForTests?.(null);
  twilioOn(false);
}

// ── R22 a clean the office is entering (task 477) ────────────────────────────
{
  twilioOn(true);
  const graceMs = (RS.DEFAULT_CLOCK_IN_GRACE_MINS || 120) * 60e3;
  const visit = (id, startAt, endAt, createdAt) => ({ ...finished(0), id, seriesId: 'ser_w0x', status: 'upcoming', startAt, endAt, createdAt });
  // The first visit early this morning, its clock-in window closed; the next at 9 or 10 tomorrow.
  const first = (c) => visit('j_r0first', iso(NOW.getTime() - graceMs - 3 * HOUR), iso(NOW.getTime() - graceMs - 1.5 * HOUR), c);
  const next = (c) => visit('j_r0next', ahead(22.5), ahead(24), c);
  const visitsOn = on([K.missedVisit, K.reminder24h, K.dayOfEta]);
  world({ state: book(1, visitsOn), jobs: [first(iso(NOW.getTime() - 108e3)), next(iso(NOW.getTime() - 108e3))] });
  const r = await run({ now: NOW });
  ok('🔴 R22a a schedule entered 108 seconds ago sends nothing (no apology for its first visit earlier today, no 24-hour text for tomorrow\'s) and writes no row', r.sent === 0 && gmail.length === 0 && twilio.length === 0 && table().length === 0, { r, rows: table().map((x) => x.id) });
  world({ state: book(1, visitsOn), jobs: [first(ago(26)), next(ago(26))] });
  const r2 = await run({ now: NOW });
  const rows = new Map(table().map((x) => [x.id, x.status]));
  ok('R22b the same cleans entered the day before: the apology and the 24-hour text both go', rows.get(mk(K.missedVisit, 'j_r0first')) === 'sent' && rows.get(mk(K.reminder24h, 'j_r0next')) === 'sent' && r2.sent === 2, { r2, rows: [...rows] });
  twilioOn(false);
}

ok('Z offline: no request left this machine', strays.length === 0, strays);
await fake.close();
Object.assign(console, saved);
console.log(`test-reminders-run: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
