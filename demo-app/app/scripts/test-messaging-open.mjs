// Messaging opens a conversation only when someone opens it (CS-149).
//
// Landing on /messaging on a computer picked the top thread of the list and read it (Inbox 7 → 5,
// two customer messages marked read that nobody saw). A link to a thread the reader may not open —
// a cleaner's link to a customer's SMS thread — kept its id in the URL, failed the visibility
// guard, and the same auto-pick opened and read a DIFFERENT thread under that URL. And a bell's
// link to a direct message carries no `?inbox`, so the DM was swapped for the Inbox tab's top
// thread the same way. Now:
//   • landing opens nothing (the pane says "Select a conversation"), and switching tabs opens nothing;
//   • a link opens exactly that thread (and only then marks it read), with its own tab's list beside it;
//   • a link to a thread that does not exist, or that this person may not open, says so — and
//     opens and reads nothing else.
//
// The REAL pages/Messaging.jsx, bundled with a small hooks runtime (scripts/hooks-harness.mjs) and
// the REAL store selectors; the store's dispatch, the router and the child components are stubbed
// (each child records what it was drawn with).
//   M1 landing (computer): nothing opens, nothing is marked read
//   M2 a link to a thread opens exactly it, and marks it read
//   M3 a cleaner's link to a customer's SMS thread: "not available", nothing else opened or read
//   M4 a link to an id that does not exist: "not available"
//   M5 a link to a direct message with no ?inbox: that DM, beside the DMs list
//   M6 switching tabs opens nothing
//   M7 the pane's "not available" words are catalog lines, with the way back
//
// REGRESSION (THE LAW II.3): on the tree before the fix M1, M3, M4, M5, M6 and M7 fail.
//
//   node app/scripts/test-messaging-open.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { R, bundle, recorder, mount, settle, unmount, view } from './hooks-harness.mjs';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const abs = (rel) => JSON.stringify(pathToFileURL(path.join(APP, rel)).href);
const core = await import('../src/i18n/core.js');

let pass = 0;
const fails = [];
// ⚠️ ARGUMENT ORDER: ok(label, cond, detail).
const ok = (label, cond, detail = '') => {
  let v = false;
  try { v = typeof cond === 'function' ? cond() : cond; } catch (e) { v = false; detail = `${detail} threw: ${e?.message || e}`; }
  if (v) pass += 1; else fails.push(detail ? `${label} — ${detail}` : label);
};

// ── the fixture: two customer threads (unread), a DM and a channel ──────────────────────────────
const OWNER = { id: 'u_o', role: 'owner', status: 'active', name: 'Matt Owner' };
const CREW = { id: 'u_c', role: 'crew', status: 'active', name: 'Carla Crew' };
const CONVS = [
  { id: 'cv_sms1', channel: 'sms', title: 'Coral Bay', lastMessageAt: '2026-10-12T12:00:00Z', createdAt: '2026-10-01T00:00:00Z' },
  { id: 'cv_sms2', channel: 'sms', title: 'Lakeside', lastMessageAt: '2026-10-12T11:00:00Z', createdAt: '2026-10-01T00:00:00Z' },
  { id: 'cv_dm', channel: 'dm', participantUserIds: ['u_o', 'u_c'], lastMessageAt: '2026-10-12T10:00:00Z', createdAt: '2026-10-01T00:00:00Z' },
  { id: 'cv_ch', channel: 'internal', title: 'Night crew', participantUserIds: ['u_o', 'u_c'], createdByUserId: 'u_o', lastMessageAt: '2026-10-12T09:00:00Z', createdAt: '2026-10-01T00:00:00Z' },
];
const MSGS = [
  { id: 'm1', conversationId: 'cv_sms1', direction: 'in', text: 'Leak in lobby', sentAt: '2026-10-12T12:00:00Z', readByUserIds: [] },
  { id: 'm2', conversationId: 'cv_sms1', direction: 'in', text: 'Still there', sentAt: '2026-10-12T12:01:00Z', readByUserIds: [] },
  { id: 'm3', conversationId: 'cv_sms2', direction: 'in', text: 'Thanks', sentAt: '2026-10-12T11:00:00Z', readByUserIds: [] },
  { id: 'm4', conversationId: 'cv_dm', authorUserId: 'u_c', text: 'Key?', sentAt: '2026-10-12T10:00:00Z', readByUserIds: ['u_c'] },
  { id: 'm5', conversationId: 'cv_ch', authorUserId: 'u_c', text: 'Done', sentAt: '2026-10-12T09:00:00Z', readByUserIds: ['u_c'] },
];
const OFFICE_PERMS = ['messaging.use', 'messaging.startConversation', 'messaging.startInternalThread', 'messaging.bulkActions'];
const CREW_PERMS = ['messaging.use', 'messaging.bulkActions'];

const SHIMS = [
  { test: /^react-router-dom$/, code: `const R = globalThis.__HR;
export function useParams() { return R.convParam ? { conversationId: R.convParam } : {}; }
export function useLocation() { return { pathname: R.path, search: R.search ? '?' + R.search : '', key: R.locKey, state: null, hash: '' }; }
export function useNavigate() {
  return (to) => {
    R.calls.push(['navigate', to]);
    const [p, q = ''] = String(to).split('?');
    const m = /^\\/messaging\\/([^/]+)$/.exec(p);
    R.path = p; R.search = q; R.convParam = m ? m[1] : null; R.locKey = 'k' + R.calls.length; R.dirty = true;
  };
}
export function useSearchParams() {
  const params = new URLSearchParams(R.search || '');
  const set = (next) => { const v = typeof next === 'function' ? next(new URLSearchParams(R.search || '')) : next; const s = new URLSearchParams(v).toString(); if (s !== (R.search || '')) { R.search = s; R.dirty = true; } };
  return [params, set];
}` },
  { test: /^\.\.\/store$/, code: `const R = globalThis.__HR;
export function useStore() { return R.state; }
export function useDispatch() { return (a) => { R.calls.push(['dispatch', a]); }; }` },
  { test: /^\.\.\/store\/reducer$/, code: 'export const ACTIONS = new Proxy({}, { get: (_, k) => String(k) });' },
  { test: /hooks\/useAuth$/, code: 'export function useAuth() { return { currentUser: globalThis.__HR.user }; }' },
  { test: /hooks\/usePermission$/, code: 'export function usePermission(k) { return globalThis.__HR.perms.has(k); }' },
  { test: /hooks\/useMessageSender$/, code: 'export function useMessageSender() { return { sendMessage() {}, retryMessage() {} }; }' },
  { test: /components\/Toast$/, code: 'const toast = { success() {}, error() {}, info() {} }; export function useToast() { return toast; }' },
  { test: /i18n\/react$/, code: `import { english } from ${abs('src/i18n/core.js')};
const t = (k, p) => english(k, p); t.rich = t;
export function useT() { return t; }` },
  { test: /lib\/clientMessagesApi$/, code: 'export async function listCustomerThreads() { return { unreadThreads: 0, threads: [], total: 0 }; }' },
  { test: /components\/MessagingHeader$/, code: `${recorder('MessagingHeader', { draw: 'none' })}
export const EMPTY_FILTERS = { channels: [], tagIds: [], dateRange: 'all', logic: 'and', starredOnly: false };` },
  ...['ConversationThreadList', 'ConversationMessagePanel', 'ConversationContextPanel', 'NewConversationModal', 'NewDmModal',
    'NewInternalThreadModal', 'OrphanedThreadsModal', 'ConfirmDialog', 'CustomerMessagesInbox']
    .map((name) => ({ test: new RegExp(`components/${name}$`), code: recorder(name, { draw: 'none' }) })),
];

// The browser bits the page reads.
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.document = { visibilityState: 'visible', body: { style: {} } };
globalThis.window = globalThis.window || {};
Object.defineProperty(globalThis.window, 'location', { configurable: true, get: () => ({ search: R.search ? `?${R.search}` : '', pathname: R.path }) });
globalThis.window.matchMedia = (q) => ({ matches: /max-width/.test(q) ? !!R.narrow : !R.narrow, media: q, addEventListener() {}, removeEventListener() {} });
globalThis.window.addEventListener = () => {};
globalThis.window.removeEventListener = () => {};

let Messaging = null;
try {
  Messaging = (await bundle('src/pages/Messaging.jsx', SHIMS, { tag: 'messaging' })).default;
} catch (e) {
  fails.push(`the page bundles and loads (${String(e?.message || e).split('\n')[0]})`);
}

async function open(user, url, { narrow = false } = {}) {
  const [p, q = ''] = url.split('?');
  const m = /^\/messaging\/([^/]+)$/.exec(p);
  Object.assign(R, {
    user, perms: new Set(user.role === 'crew' ? CREW_PERMS : OFFICE_PERMS),
    state: { currentUserId: user.id, users: [OWNER, CREW], conversations: CONVS, messages: MSGS, contacts: [], connectedInboxes: [], oauthWorkspaces: [] },
    path: p, search: q, convParam: m ? m[1] : null, locKey: 'k0', narrow,
  });
  return look(await mount(Messaging, {}));
}
function look(tree) {
  view(tree);
  const last = (name) => (R.seen[name] || [])[(R.seen[name] || []).length - 1] || null;
  const panel = last('ConversationMessagePanel');
  return {
    panel,
    shown: panel?.conversation?.id || null,
    unavailable: !!panel?.unavailable,
    list: last('ConversationThreadList'),
    header: last('MessagingHeader'),
    reads: R.calls.filter(([k, a]) => k === 'dispatch' && a?.type === 'MARK_CONVERSATION_READ').map(([, a]) => a.id),
  };
}

if (Messaging) {
  const m1 = await open(OWNER, '/messaging');
  ok('🔴 M1a landing on Messaging (computer) opens nothing', () => m1.shown === null && !m1.unavailable, `shown ${m1.shown}`);
  ok('🔴 M1b …and marks nothing read (the top thread\'s two messages stay unread)', () => m1.reads.length === 0, JSON.stringify(m1.reads));

  const m2 = await open(OWNER, '/messaging/cv_sms1');
  ok('M2a a link to a thread opens exactly that thread', () => m2.shown === 'cv_sms1', `shown ${m2.shown}`);
  ok('M2b …and opening it marks it read, once', () => m2.reads.length === 1 && m2.reads[0] === 'cv_sms1', JSON.stringify(m2.reads));

  const m3 = await open(CREW, '/messaging/cv_sms1', { narrow: true });
  ok('🔴 M3a a cleaner\'s link to a customer\'s SMS thread opens nothing else under that URL', () => m3.shown === null, `shown ${m3.shown}`);
  ok('🔴 M3b …says the conversation is not available', () => m3.unavailable === true);
  ok('M3c …and reads nothing', () => m3.reads.length === 0, JSON.stringify(m3.reads));
  const m3d = await open(CREW, '/messaging/cv_sms1');
  ok('🔴 M3d …on a computer too (where the old auto-pick read the cleaner\'s top channel)', () => m3d.shown === null && m3d.unavailable && m3d.reads.length === 0, `${m3d.shown} ${JSON.stringify(m3d.reads)}`);

  const m4 = await open(OWNER, '/messaging/cv_gone');
  ok('🔴 M4 a link to a thread that no longer exists says so, opens nothing and reads nothing', () => m4.shown === null && m4.unavailable && m4.reads.length === 0,
    `${m4.shown} ${m4.unavailable} ${JSON.stringify(m4.reads)}`);

  const m5 = await open(OWNER, '/messaging/cv_dm');
  ok('🔴 M5a a bell\'s link to a direct message (no ?inbox) opens that DM, not the Inbox tab\'s top thread', () => m5.shown === 'cv_dm', `shown ${m5.shown}`);
  ok('🔴 M5b …with the DMs list beside it', () => m5.list?.selectedInbox === 'dm' && m5.header?.selectedInbox === 'dm', `${m5.list?.selectedInbox}`);
  ok('M5c …and reads nothing else', () => m5.reads.every((id) => id === 'cv_dm'), JSON.stringify(m5.reads));

  // M6 — the Channels tab, with nothing open.
  const m6 = await open(OWNER, '/messaging');
  if (m6.header?.onInboxChange) {
    m6.header.onInboxChange('internal');
    const after = look(await settle(Messaging, {}));
    ok('🔴 M6 switching tabs opens nothing, and reads nothing', () => after.shown === null && after.reads.length === 0 && after.list?.selectedInbox === 'internal',
      `${after.shown} ${JSON.stringify(after.reads)} ${after.list?.selectedInbox}`);
  } else ok('M6 the header can switch tabs', false);
}

// M7 — the pane draws the state, in the catalog's words, with the way back.
{
  const panel = fs.readFileSync(path.join(APP, 'src/components/ConversationMessagePanel.jsx'), 'utf8');
  const has = (k) => typeof core.SOURCE_CATALOG[k] === 'string' && core.SOURCE_CATALOG[k].length > 0;
  ok('🔴 M7a the "not available" words are catalog lines', () => ['messages.unavailable.title', 'messages.unavailable.body', 'messages.unavailable.back'].every(has));
  ok('🔴 M7b the message pane draws them when the page says the conversation is unavailable, with a way back to the list',
    () => /unavailable/.test(panel) && /t\('messages\.unavailable\.title'\)/.test(panel) && /t\('messages\.unavailable\.back'\)/.test(panel) && /onBack/.test(panel));
}

unmount();
console.log(`\ntest-messaging-open: ${pass}/${pass + fails.length} passed`);
if (fails.length) {
  console.error(`\n✖ ${fails.length} failed:`);
  for (const f of fails) console.error(`  - ${f}`);
  process.exitCode = 1;
}
