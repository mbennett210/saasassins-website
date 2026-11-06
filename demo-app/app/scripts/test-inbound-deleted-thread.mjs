// CS-968 — a deleted email thread's reply never comes back.
//
// THE BUG (production, 2026-11-03). Daniel's Gmail reply to a Messaging email was buffered
// (`inbound_emails` seq 4) and filed by the ingest cron into its thread at 5:06 PM PST, and the
// server's cursor (`org_state.inboundIngestSeq`) moved to 4. The thread and its messages were
// removed at about 5:22 PM, and at 5:22:23 PM the same reply was filed AGAIN, into an older thread
// from the same address, with a "New email from …" bell row. A browser did it: the
// InboundListener polled from its own localStorage cursor (0 on a new browser), and
// RECEIVE_EMAIL skipped a reply only while a message with its Message-ID was still stored.
//
// THE FIX. The browser never files a buffered email at or below the server's cursor: the listener
// polls from the later of the two and drops what the server has threaded (lib/inboundCursor.js),
// and RECEIVE_EMAIL / RECEIVE_MARKETING_REPLY check the email's `seq` again against the state the
// action is applied to — so a tab that filed it on a stale copy drops it when its save meets the
// newer record (the sync engine's adopt + replay). No list of filed ids is kept (org_state's size).
//
// HOW. Offline, end to end: the REAL ingest cron (api/inbox/ingest.js) and the REAL browser poll
// (api/inbox/inbound.js) over the in-process fake Supabase; the listener's real decision
// (`pollFrom`, `inboundActions`); the REAL sync engine and save route (scripts/sync-harness.mjs).
//
//   node app/scripts/test-inbound-deleted-thread.mjs
import { createSyncHarness } from './sync-harness.mjs';

let pass = 0;
const fails = [];
const ok = (label, cond, detail = '') => { if (cond) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label); };
// console.log only: the harness keeps console.error / console.warn for VERBOSE runs.
const watchdog = setTimeout(() => { console.log('test-inbound-deleted-thread: timed out'); process.exit(1); }, 60000);
watchdog.unref();

const h = await createSyncHarness();
process.env.CRON_SECRET = 'cron-secret';
const { seedPermissions } = await import('../src/lib/roles.js');
const { productionInitialState } = await import('../src/data/seed.js');
const { ACTIONS } = await import('../src/store/reducer.js');
const { pollFrom, inboundActions } = await import('../src/lib/inboundCursor.js');
const ingest = (await import('../api/inbox/ingest.js')).default;
const inbound = (await import('../api/inbox/inbound.js')).default;

const ORG = '00000000-0000-0000-0000-000000000001';
const LOGINS = { 'tok-owner': { id: 'a-owner', email: 'owner@cs.co', app_metadata: { role: 'owner', org_user_id: 'u_owner', org_id: ORG } } };
const MAILBOX = 'alerts@cs.co';        // the shared login's connected (personal) mailbox
const MARKETING_BOX = 'outreach@cs.co'; // a marketing rotation mailbox (not in inbox_accounts as personal)
const DANIEL = 'daniel@example.com';
const OUT_ID = '<out-1@mail.gmail.com>';     // the Messaging email Daniel replied to
const REPLY_ID = '<CAGHoczT8-reply@mail.gmail.com>';
const OLD_AT = '2026-11-02T18:00:00.000Z';

const baseState = () => ({
  ...productionInitialState(),
  permissions: seedPermissions(),
  userPermissionOverrides: [],
  users: [{ id: 'u_owner', role: 'owner', status: 'active', name: 'Olive Owner', email: 'owner@cs.co', pay: { type: 'none' } }],
  contacts: [],
  clients: [],
  connectedInboxes: [{ id: 'ci_alerts', email: MAILBOX, provider: 'google', ownerUserId: 'u_owner' }],
  // The older unlinked thread from the same address (the Nov 2 test) and the test thread with
  // the Messaging email the reply answers.
  conversations: [
    { id: 'cv_old', channel: 'email', title: DANIEL, contactId: null, createdAt: OLD_AT, lastMessageAt: OLD_AT, starredByUserIds: [], mutedByUserIds: [] },
    { id: 'cv_test', channel: 'email', title: DANIEL, contactId: null, createdAt: '2026-11-03T23:00:00.000Z', lastMessageAt: '2026-11-03T23:11:00.000Z', starredByUserIds: [], mutedByUserIds: [] },
  ],
  messages: [
    { id: 'm_old', conversationId: 'cv_old', direction: 'in', text: 'Nov 2 test', sentAt: OLD_AT, readByUserIds: ['u_owner'], emailMessageId: '<old@mail.gmail.com>', emailHeaders: { messageId: '<old@mail.gmail.com>' }, emailSubject: 'Test', fromEmail: DANIEL },
    { id: 'm_out', conversationId: 'cv_test', direction: 'out', text: 'Testing email from Messaging', sentAt: '2026-11-03T23:11:00.000Z', readByUserIds: ['u_owner'], authorUserId: 'u_owner', emailHeaders: { messageId: OUT_ID }, emailSubject: 'Testing' },
  ],
  marketingSequences: [{ id: 'seq1', name: 'Spring outreach', haltOnReply: true, notifyOnReplyUserId: 'u_owner', notifyOnReplyChannels: { inApp: true } }],
  marketingEnrollments: [{ id: 'enr1', sequenceId: 'seq1', contactId: 'ct_lead', status: 'active' }],
  marketingReplies: [],
  notifications: [],
  inboundIngestSeq: 3,
});
// ct_lead is a marketing lead (the marketing path correlates by from-email → contact).
const withLead = (s) => ({ ...s, contacts: [{ id: 'ct_lead', firstName: 'Lena', lastName: 'Lead', email: 'lena@lead.co' }] });

const buffered = (seq, over = {}) => ({
  seq, gmail_message_id: `g${seq}`, from_email: DANIEL, to_inbox_email: MAILBOX,
  subject: 'Re: Testing', body: 'Got it, thanks', rfc_message_id: REPLY_ID, in_reply_to: OUT_ID, references_header: OUT_ID, ...over,
});
function seedWorld(state, rows) {
  h.seedOrg(state, { logins: LOGINS });
  h.world.tables.inbox_accounts = [{ id: 'ia1', email: MAILBOX, status: 'active', owner_user_id: 'u_owner', last_polled_at: new Date().toISOString() }];
  h.world.tables.inbound_emails = rows.map((r) => ({ ...r }));
}
const call = (handler, req) => new Promise((resolve) => {
  const out = { status: 200, body: undefined };
  const res = {
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; resolve(out); return this; },
    setHeader() {}, end() { resolve(out); return this; },
  };
  Promise.resolve(handler(req, res)).catch((e) => resolve({ status: 500, body: { error: String(e?.message || e) } }));
});
const runCron = () => call(ingest, { method: 'GET', query: {}, headers: { authorization: 'Bearer cron-secret' } });
const poll = (since) => call(inbound, { method: 'GET', query: { since: String(since) }, headers: { authorization: 'Bearer tok-owner' } });
// One tick of the listener: where it polls from, what the route answers, what it dispatches.
async function listenerTick(tab, localCursor) {
  const since = pollFrom(localCursor, tab.state());
  const res = await poll(since);
  const actions = inboundActions(res.body, tab.state(), ACTIONS);
  for (const a of actions) tab.dispatchLocal(a);
  return { since, res, actions };
}
const committed = () => h.committed().state;
const replyCopies = (s) => (s.messages || []).filter((m) => m.emailMessageId === REPLY_ID);
const emailBells = (s) => (s.notifications || []).filter((n) => /email/i.test(n.eventKey || '') || /email/i.test(n.title || ''));

// ── 1. The incident: filed by the cron, thread deleted, then a NEW browser opens the app ─────────
seedWorld(baseState(), [buffered(4)]);
{
  const cron = await runCron();
  let s = committed();
  ok('1.0 the cron run answers 200', cron.status === 200, JSON.stringify(cron.body));
  ok('1.1 the cron files the reply into the thread it answers', replyCopies(s).length === 1 && replyCopies(s)[0].conversationId === 'cv_test', JSON.stringify(replyCopies(s)));
  ok("1.2 the server's cursor moves to 4", s.inboundIngestSeq === 4, String(s.inboundIngestSeq));
  ok('1.3 …with one bell row', emailBells(s).length === 1, JSON.stringify(s.notifications));

  // The office deletes the thread (Messaging's own delete) and clears the bell.
  const office = await h.bootTab('tok-owner');
  office.dispatchLocal({ type: ACTIONS.DELETE_CONVERSATION, id: 'cv_test' });
  office.dispatchLocal({ type: ACTIONS.CLEAR_NOTIFICATIONS, userId: 'u_owner' });
  await h.advance(600);
  s = committed();
  ok('1.4 the thread and its reply are gone from the record', !(s.conversations || []).some((c) => c.id === 'cv_test') && replyCopies(s).length === 0, JSON.stringify(replyCopies(s)));
  office.stop();
  h.clearTimers();

  // A new phone on the shared login: localStorage cursor 0, the current record.
  const phone = await h.bootTab('tok-owner');
  const tick = await listenerTick(phone, 0);
  await h.advance(600);
  s = committed();
  ok("1.5 the new browser's first poll starts at the server's cursor, not 0", tick.since === 4, `since=${tick.since}`);
  ok('1.6 it files nothing', tick.actions.length === 0, JSON.stringify(tick.actions.map((a) => [a.type, a.seq])));
  ok('1.7 the reply does not come back into the record', replyCopies(s).length === 0, JSON.stringify(replyCopies(s)));
  ok('1.8 the older thread from the same address is untouched', (s.conversations || []).find((c) => c.id === 'cv_old')?.lastMessageAt === OLD_AT
    && (s.messages || []).filter((m) => m.conversationId === 'cv_old').length === 1, JSON.stringify((s.conversations || []).find((c) => c.id === 'cv_old')));
  ok('1.9 no bell row comes back', emailBells(s).length === 0, JSON.stringify(s.notifications));
  ok('1.10 no new thread is made for it', (s.conversations || []).length === 1, JSON.stringify((s.conversations || []).map((c) => c.id)));
  // Even a browser whose local cursor is 0 and whose poll somehow returned the row (an older
  // server answering from `since=0`) files nothing: the decision drops it by its seq.
  const old = await poll(0);
  const fromOld = inboundActions(old.body, phone.state(), ACTIONS);
  ok('1.11 a poll answered from 0 still files nothing at or below the cursor', old.body?.emails?.length === 1 && fromOld.length === 0,
    `${old.body?.emails?.length} rows, ${fromOld.length} actions`);
  phone.stop();
  h.clearTimers();
}

// ── 2. A tab on a STALE copy files it, and drops it when its save meets the newer record ───────
// The tab booted before the reply came (cursor 3, the thread still there). The cron files it,
// another device deletes the thread; this tab hasn't heard yet and its listener polls.
seedWorld(baseState(), [buffered(4)]);
{
  const stale = await h.bootTab('tok-owner');
  await runCron();
  const other = await h.bootTab('tok-owner');
  other.dispatchLocal({ type: ACTIONS.DELETE_CONVERSATION, id: 'cv_test' });
  await h.advance(600);
  other.stop();
  h.clearTimers();
  const v = h.committed().version;
  ok('2.0 the record is past the stale tab (cron + delete)', v >= 3, `version ${v}`);

  const tick = await listenerTick(stale, 3);
  ok('2.1 on its stale copy the tab does file the reply (it cannot know yet)', tick.actions.length === 1 && tick.actions[0].seq === 4
    && replyCopies(stale.state()).length === 1, JSON.stringify(tick.actions.map((a) => [a.type, a.seq])));
  await h.advance(600);   // the save: 409 (stale base) → re-read → adopt → replay
  await h.advance(600);
  const s = committed();
  ok('2.2 the replay on the newer record drops it: not in the record', replyCopies(s).length === 0, JSON.stringify(replyCopies(s)));
  ok('2.3 …and not on the tab', replyCopies(stale.state()).length === 0, JSON.stringify(replyCopies(stale.state())));
  // (Messaging's delete takes the thread's bell rows with it, so the record has none left.)
  ok('2.4 no bell row comes back', emailBells(s).length === 0 && emailBells(stale.state()).length === 0,
    `${emailBells(s).length} in the record, ${emailBells(stale.state()).length} on the tab`);
  ok('2.5 the older thread is untouched', (s.conversations || []).find((c) => c.id === 'cv_old')?.lastMessageAt === OLD_AT);
  ok('2.6 nothing is left waiting on the tab', stale.pending().length === 0, `${stale.pending().length} pending`);
  stale.stop();
  h.clearTimers();
}

// ── 3. The marketing path: a recorded reply removed from the record is not recorded again ──────
seedWorld(withLead(baseState()), [buffered(5, { from_email: 'lena@lead.co', to_inbox_email: MARKETING_BOX, rfc_message_id: '<lena-1@lead.co>', in_reply_to: null, references_header: null, subject: 'Re: Spring' })]);
{
  await runCron();
  let s = committed();
  ok('3.0 the cron records the marketing reply and halts the drip', (s.marketingReplies || []).length === 1
    && s.marketingEnrollments[0].status === 'replied', JSON.stringify(s.marketingReplies));
  ok('3.1 …with one bell row', (s.notifications || []).filter((n) => n.eventKey === 'marketingReplyAssigned').length === 1);
  // The reply row leaves the record (the 2000-row retention cap or a clean-up) and the bell is read.
  const row = h.committed();
  row.state = { ...row.state, marketingReplies: [], notifications: [] };
  row.version += 1;

  const phone = await h.bootTab('tok-owner');
  const tick = await listenerTick(phone, 0);
  await h.advance(600);
  s = committed();
  ok('3.2 a new browser files nothing for it', tick.actions.length === 0, JSON.stringify(tick.actions.map((a) => [a.type, a.seq])));
  ok('3.3 the reply is not recorded again', (s.marketingReplies || []).length === 0, JSON.stringify(s.marketingReplies));
  ok('3.4 no second bell row', (s.notifications || []).length === 0, JSON.stringify(s.notifications));
  // The reducer drops it by its seq even when it is dispatched (a stale tab's replay).
  const after = h.reducer(s, { type: ACTIONS.RECEIVE_MARKETING_REPLY, seq: 5, id: '<lena-1@lead.co>', fromEmail: 'lena@lead.co', subject: 'Re: Spring', body: 'x' });
  ok('3.5 RECEIVE_MARKETING_REPLY at or below the cursor changes nothing', after === s);
  phone.stop();
  h.clearTimers();
}

// ── 4. Controls: new mail still comes in ────────────────────────────────────────────────────────
// A reply buffered but not yet threaded by the cron (seq 6 > cursor 5): a browser files it, and the
// cron's run afterwards does not file it twice.
const s4 = { ...baseState(), inboundIngestSeq: 5 };
seedWorld(s4, [buffered(6, { rfc_message_id: '<new-6@mail.gmail.com>', gmail_message_id: 'g6' })]);
{
  const tab = await h.bootTab('tok-owner');
  const tick = await listenerTick(tab, 0);
  await h.advance(600);
  let s = committed();
  const copies = (st) => (st.messages || []).filter((m) => m.emailMessageId === '<new-6@mail.gmail.com>');
  ok('4.1 the browser polls from the cursor and files the new reply', tick.since === 5 && tick.actions.length === 1
    && copies(s).length === 1 && copies(s)[0].conversationId === 'cv_test', `since=${tick.since} ${JSON.stringify(copies(s))}`);
  ok('4.2 …with its bell row', emailBells(s).length === 1, JSON.stringify(s.notifications));
  tab.stop();
  h.clearTimers();
  await runCron();
  s = committed();
  ok('4.3 the cron that follows does not file it twice, and moves the cursor to 6', copies(s).length === 1 && s.inboundIngestSeq === 6,
    `${copies(s).length} copies, cursor ${s.inboundIngestSeq}`);
}
{
  // An email with no seq (Settings → Integrations' simulation) is never held back by the cursor.
  const st = { ...baseState(), inboundIngestSeq: 99 };
  const next = h.reducer(st, { type: ACTIONS.RECEIVE_EMAIL, fromEmail: DANIEL, toInboxEmail: MAILBOX, subject: 'Sim', body: 'simulated', messageId: '<sim@x>' });
  ok('4.4 a simulated email (no seq) still files', (next.messages || []).some((m) => m.emailMessageId === '<sim@x>'));
  const nextM = h.reducer(withLead(st), { type: ACTIONS.RECEIVE_MARKETING_REPLY, id: '<sim-m@x>', fromEmail: 'lena@lead.co', subject: 'Sim', body: 'simulated' });
  ok('4.5 a simulated marketing reply (no seq) still records', (nextM.marketingReplies || []).some((r) => r.id === '<sim-m@x>'));
}

clearTimeout(watchdog);
console.log(`\ntest-inbound-deleted-thread: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✖ ${f}`);
process.exitCode = fails.length ? 1 : 0;
