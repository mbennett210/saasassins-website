// A reply to an email sent from Messaging comes back to Messaging.
//
// Messaging sends through the person's connected Gmail, and the app reads that mailbox every
// minute (api/inbox/ingest), threading a reply into the conversation by its In-Reply-To. But
// every send also carried a Reply-To: the company email from Settings → Company (or, for an
// inbox with the old `inboundEnabled` flag, a made-up `reply+<id>@inbound.app.local` address no
// mail server takes). In production the company email is a person's own mailbox the app does not
// read, so a customer's Reply went there and never reached the thread (found 2026-11-02: no reply
// had ever come back into Messaging). Now a Messaging email carries no Reply-To at all, so the
// customer's Reply goes to the mailbox that sent it.
//
// The REAL hooks/useMessageSender.js and the REAL store selectors, bundled with the store, the
// sign-in, the toast and the network calls stubbed (sendViaInbox records what it was asked to send).
//   R1 a new email from a mailbox the app reads: no Reply-To, though the company has an email
//   R2 a mailbox carrying the old inboundEnabled flag: no Reply-To, never an inbound.app.local address
//   R3 Retry of a failed email: no Reply-To
//   R4 the email still goes to the contact, from the chosen mailbox, with its subject and threading
//
// REGRESSION (THE LAW II.3): on the tree before the fix R1 and R2 fail.
//
//   node app/scripts/test-messaging-reply-to.mjs
import { R, bundle } from './hooks-harness.mjs';

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

const SHIMS = [
  { test: /^\.\.\/store$/, code: `const R = globalThis.__HR;
export function useStore() { return R.state; }
export function useDispatch() { return (a) => { R.calls.push(['dispatch', a]); }; }` },
  { test: /^\.\.\/store\/reducer$/, code: 'export const ACTIONS = new Proxy({}, { get: (_, k) => String(k) });' },
  { test: /^\.\/useAuth$/, code: 'export function useAuth() { return { currentUser: globalThis.__HR.user }; }' },
  { test: /^\.\.\/components\/Toast$/, code: 'const toast = { success() {}, error(m) { globalThis.__HR.calls.push(["toast", m]); }, info() {} }; export function useToast() { return toast; }' },
  { test: /^\.\.\/lib\/twilio$/, code: 'export async function sendSMS() { return { sid: "s", status: "queued" }; } export function subscribeToDelivery() { return () => {}; }' },
  { test: /^\.\.\/lib\/connectedInboxes$/, code: `export async function sendViaInbox(inboxId, payload) {
  globalThis.__HR.calls.push(['sendViaInbox', inboxId, payload]);
  return { ok: true, id: 'g_1', messageId: '<real-1@cleanspaceonline.com>', status: 'sent' };
}` },
  { test: /^\.\.\/lib\/attachments$/, code: `export const ATTACHMENT_TOTAL_MAX_BYTES = 25 * 1024 * 1024;
export async function filesToStorageAttachments() { return []; }
export function formatBytes(n) { return String(n); }` },
];

const OWNER = { id: 'u_o', role: 'owner', status: 'active', name: 'Matt Owner', email: 'owner@example.com' };
const CONTACT = { id: 'ct_1', name: 'Mia Bowman', email: 'mia@customer.example' };
const CONV = { id: 'cv_1', channel: 'email', contactId: 'ct_1', createdAt: '2026-11-01T00:00:00Z' };
const inbox = (extra = {}) => ({
  id: 'inbx_1', provider: 'google', email: 'alerts@cleanspaceonline.com', displayName: 'alerts@cleanspaceonline.com',
  userId: 'u_o', status: 'active', isDefault: true, inboundEnabled: false, inboundCapability: 'gmail_poll', ...extra,
});
const stateWith = (inboxRow) => ({
  currentUserId: 'u_o', users: [OWNER], contacts: [CONTACT], conversations: [CONV], messages: [],
  connectedInboxes: [inboxRow], company: { name: 'Clean Space', email: 'owner-mailbox@cleanspaceonline.com' },
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const sends = () => R.calls.filter(([k]) => k === 'sendViaInbox');

let useMessageSender = null;
try {
  ({ useMessageSender } = await bundle('src/hooks/useMessageSender.js', SHIMS, { tag: 'reply-to' }));
} catch (e) {
  fails.push(`the hook bundles and loads (${String(e?.message || e).split('\n')[0]})`);
}

async function send(inboxRow, opts = {}) {
  Object.assign(R, { user: OWNER, state: stateWith(inboxRow), calls: [] });
  const { sendMessage } = useMessageSender();
  sendMessage(CONV, CONTACT, [], 'Hello from the office', { channel: 'email', subject: 'Your building', ...opts });
  await tick(); await tick();
  return sends()[0] || null;
}

if (useMessageSender) {
  // R1
  const s1 = await send(inbox());
  ok('R1 the email was sent', !!s1, JSON.stringify(R.calls.filter(([k]) => k === 'toast')));
  ok('R1 no Reply-To on a Messaging email (the reply comes back to the sending mailbox)',
    () => s1 && !('replyTo' in s1[2] && s1[2].replyTo), `replyTo=${s1 && s1[2].replyTo}`);
  ok('R1 the company email is never the Reply-To', () => s1 && s1[2].replyTo !== 'owner-mailbox@cleanspaceonline.com');

  // R2
  const s2 = await send(inbox({ inboundEnabled: true }));
  ok('R2 the email was sent', !!s2);
  ok('R2 no Reply-To for an inbox with the old inboundEnabled flag', () => s2 && !s2[2].replyTo, `replyTo=${s2 && s2[2].replyTo}`);
  ok('R2 never an inbound.app.local address', () => s2 && !String(s2[2].replyTo || '').includes('inbound.app.local'));

  // R3
  Object.assign(R, { user: OWNER, state: stateWith(inbox()), calls: [] });
  const failed = {
    id: 'm_f', conversationId: 'cv_1', direction: 'out', text: 'Try again', emailSubject: 'Your building',
    emailFromInboxId: 'inbx_1', emailHeaders: { messageId: '<msg-1@app.local>', inReplyTo: null, references: null },
    deliveryStatus: 'failed',
  };
  useMessageSender().retryMessage(CONV, CONTACT, failed);
  await tick(); await tick();
  const s3 = sends()[0] || null;
  ok('R3 Retry resends the email', !!s3);
  ok('R3 no Reply-To on a retry', () => s3 && !s3[2].replyTo, `replyTo=${s3 && s3[2].replyTo}`);

  // R4
  ok('R4 sent from the chosen mailbox', () => s1[1] === 'inbx_1');
  ok('R4 to the contact', () => s1[2].to === 'mia@customer.example');
  ok('R4 with its subject', () => s1[2].subject === 'Your building');
  ok('R4 with the From address of the mailbox', () => String(s1[2].from || '').includes('alerts@cleanspaceonline.com'));
  ok('R4 with a Message-ID header the reply can thread on', () => !!s1[2].headers?.['Message-ID']);
}

if (fails.length) {
  console.error(`test-messaging-reply-to: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`test-messaging-reply-to: ${pass} passed`);
