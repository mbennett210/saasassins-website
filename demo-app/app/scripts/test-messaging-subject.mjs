// The Subject typed in Messaging stays until the email is sent (CS-961).
//
// The composer filled its Subject from the thread's last email subject in an effect that ran on
// every new `messages` array. Messaging and the dock pass `selectMessagesForConversation(...)`,
// which builds a new array on every render, and the page renders again on every sync, toast and
// keystroke. So a Subject typed for a new email was wiped back to empty before Review & Send
// (found 2026-11-02 on www.cleancorner.app: the test email went out as "(no subject)"), and an
// edited "Re: …" went back to the old one. Now the Subject is set again only when the thread, the
// channel or the last email subject changes.
//
// The REAL components/ConversationMessagePanel.jsx, bundled with the store, router, toast, i18n
// and every child component stubbed; the page is drawn again with a NEW messages array holding
// the same messages, as the parent does on every render.
//   S1 a new email: the typed Subject survives a redraw
//   S2 a reply: "Re: <last subject>" is filled in, and an edit to it survives a redraw
//   S3 another thread: the Subject is set again from that thread
//   S4 a new email with another subject arrives: the Subject follows it
//   S5 the channel switched to text and back: the Subject is set again
//
// REGRESSION (THE LAW II.3): on the tree before the fix S1 and S2's redraw checks fail.
//
//   node app/scripts/test-messaging-subject.mjs
import { R, bundle, mount, settle, unmount } from './hooks-harness.mjs';

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

const leaf = (name) => `export default function ${name}(p) { return p.children ?? null; }`;
const SHIMS = [
  { test: /^react-router-dom$/, code: 'export function Link(p) { return p.children ?? null; }' },
  { test: /^\.\.\/hooks\/useFromHere$/, code: 'export function useFromHere() { return {}; }' },
  { test: /^\.\.\/hooks\/useIsMobile$/, code: 'export function useIsMobile() { return false; }' },
  ...['Avatar', 'ChannelBadge', 'Badge', 'EmptyState', 'Icon', 'SignaturePreview', 'ThreadTitleEditor']
    .map((n) => ({ test: new RegExp(`^\\./${n}$`), code: leaf(n) })),
  { test: /^\.\/Toast$/, code: 'const toast = { success() {}, error() {}, info() {} }; export function useToast() { return toast; }' },
  { test: /^\.\.\/store$/, code: 'export function useStore() { return globalThis.__HR.state; }' },
  { test: /^\.\.\/store\/selectors$/, code: `export const selectUserById = () => null;
export const selectOtherParticipant = () => null;
export const selectSignaturePrefs = () => ({ enabled: false, text: '', imageDataUrl: null, imagePath: null, imageWidth: 240 });
export const selectThreadCreator = () => null;
export const selectCanRenameThread = () => false;` },
  { test: /^\.\.\/lib\/dates$/, code: `export const fmtTime = (x) => String(x || '');
export const fmtDate = (x) => String(x || '');
export const dayKey = (x) => String(x || '').slice(0, 10);
export const addDaysKey = (k) => k;` },
  { test: /^\.\.\/i18n\/react$/, code: `const t = (k) => k; t.rich = (k) => k;
export function useT() { return t; }` },
  { test: /^\.\.\/i18n\/relative$/, code: 'export const timeShort = (x) => String(x || "");' },
  { test: /^\.\.\/lib\/attachments$/, code: 'export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; export function formatBytes(n) { return String(n); }' },
  { test: /^\.\.\/lib\/signature$/, code: 'export const signatureHasContent = () => false; export const buildOutboundEmail = (b) => ({ text: b, html: b });' },
];

globalThis.document ||= { activeElement: null };

const OWNER = { id: 'u_o', role: 'owner', status: 'active', name: 'Matt Owner', email: 'owner@example.com' };
const CONTACT = { id: 'ct_1', name: 'Mia Bowman', email: 'mia@customer.example', phone: '+15555550100' };
const INBOX = { id: 'inbx_1', provider: 'google', email: 'alerts@cleanspaceonline.com', userId: 'u_o', status: 'active', isDefault: true };
R.state = { currentUserId: 'u_o', users: [OWNER], contacts: [CONTACT], conversations: [], messages: [] };

const conv = (id, channel = 'email') => ({ id, channel, contactId: 'ct_1', createdAt: '2026-11-01T00:00:00Z' });
const email = (id, convId, subject, at) => ({
  id, conversationId: convId, channel: 'email', direction: 'inbound', body: 'Hello', emailSubject: subject,
  fromEmail: CONTACT.email, sentAt: at, createdAt: at,
});
// Every draw gets a NEW array with the same messages, as selectMessagesForConversation gives.
const props = (conversation, msgs, extra = {}) => ({
  conversation, contact: CONTACT, messages: [...msgs], currentUser: OWNER, isSuperAdmin: true,
  onSend: () => {}, connectedInboxes: [INBOX], defaultInboxId: INBOX.id, emailBlockers: [],
  onSwitchChannel: () => {}, ...extra,
});

// The Subject box: walks the drawn elements only (child components are not called).
const subjectBox = (tree) => {
  let found = null;
  const walk = (node) => {
    if (found || node == null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node.type === 'input' && /^messages\.email\.subject/.test(String(node.props?.placeholder || ''))) { found = node; return; }
    walk(node.props?.children);
  };
  walk(tree);
  return found;
};
const type = (tree, value) => subjectBox(tree).props.onChange({ target: { value } });

const { default: Panel } = await bundle('src/components/ConversationMessagePanel.jsx', SHIMS, { tag: 'subject' });

// ── S1 a new email: the typed Subject survives a redraw ──────────────────────────────────────
{
  const C = conv('cv_new');
  let tree = await mount(Panel, props(C, []));
  ok('S1 the Subject box is drawn for an email thread', Boolean(subjectBox(tree)));
  ok('S1 a new email starts with an empty Subject', subjectBox(tree)?.props.value === '', `got "${subjectBox(tree)?.props.value}"`);
  type(tree, 'Clean Corner email test');
  tree = await settle(Panel, props(C, []));
  ok('S1 the typed Subject shows', subjectBox(tree)?.props.value === 'Clean Corner email test', `got "${subjectBox(tree)?.props.value}"`);
  tree = await settle(Panel, props(C, []));
  tree = await settle(Panel, props(C, []));
  ok('S1 the typed Subject survives the page drawing again (CS-961)',
    subjectBox(tree)?.props.value === 'Clean Corner email test', `got "${subjectBox(tree)?.props.value}"`);
  unmount();
}

// ── S2 a reply: "Re: …" filled in, and an edit to it survives a redraw ────────────────────────
const THREAD = [email('m1', 'cv_reply', 'Quote for March', '2026-11-01T10:00:00Z'), email('m2', 'cv_reply', 'Re: Re: Quote for March', '2026-11-01T11:00:00Z')];
{
  const C = conv('cv_reply');
  let tree = await mount(Panel, props(C, THREAD));
  ok('S2 a reply fills in "Re: <last subject>", one Re:', subjectBox(tree)?.props.value === 'Re: Quote for March', `got "${subjectBox(tree)?.props.value}"`);
  type(tree, 'Re: Quote for March (updated)');
  tree = await settle(Panel, props(C, THREAD));
  tree = await settle(Panel, props(C, THREAD));
  ok('S2 an edited reply Subject survives the page drawing again (CS-961)',
    subjectBox(tree)?.props.value === 'Re: Quote for March (updated)', `got "${subjectBox(tree)?.props.value}"`);

  // ── S3 another thread: the Subject is set again from that thread ──
  tree = await settle(Panel, props(conv('cv_other'), [email('o1', 'cv_other', 'Window cleaning', '2026-11-01T09:00:00Z')]));
  ok('S3 opening another thread sets its own "Re:" Subject', subjectBox(tree)?.props.value === 'Re: Window cleaning', `got "${subjectBox(tree)?.props.value}"`);
  tree = await settle(Panel, props(conv('cv_blank'), []));
  ok('S3 opening a thread with no email clears the Subject', subjectBox(tree)?.props.value === '', `got "${subjectBox(tree)?.props.value}"`);
  unmount();
}

// ── S4 a new email with another subject arrives: the Subject follows it ───────────────────────
{
  const C = conv('cv_reply');
  let tree = await mount(Panel, props(C, THREAD));
  type(tree, 'Re: Quote for March (draft)');
  const NEWER = [...THREAD, email('m3', 'cv_reply', 'New schedule for April', '2026-11-02T09:00:00Z')];
  tree = await settle(Panel, props(C, NEWER));
  ok('S4 a new email with another subject sets "Re: <its subject>"', subjectBox(tree)?.props.value === 'Re: New schedule for April', `got "${subjectBox(tree)?.props.value}"`);
  unmount();
}

// ── S5 the channel switched to text and back: the Subject is set again ───────────────────────
{
  const C = conv('cv_reply');
  let tree = await mount(Panel, props(C, THREAD));
  type(tree, 'Something else');
  tree = await settle(Panel, props(C, THREAD, { composeChannelOverride: 'sms' }));
  ok('S5 no Subject box on a text', subjectBox(tree) === null);
  tree = await settle(Panel, props(C, THREAD, { composeChannelOverride: 'email' }));
  ok('S5 back on email the Subject is "Re: <last subject>" again', subjectBox(tree)?.props.value === 'Re: Quote for March', `got "${subjectBox(tree)?.props.value}"`);
  unmount();
}

console.log(`${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  ✗ ${f}`);
process.exitCode = fails.length ? 1 : 0;
