// CS-811 — unread messages are counted once per change of the messaging slices, not on every
// render of the Messages dock.
//
// The dock (components/MessagesDock) is always mounted on a desktop and re-renders on every
// address change (useNavigate) and every store change. Each render computed three unread totals
// — selectUnreadCountForInbox → selectUnreadForConversation per thread, a `conversations.find`
// plus a `messages.filter` each: O(threads × messages) — BEFORE its phone early return. At the
// finder's volume that was 123 of the ~155 ms every keystroke in a URL-bound search box cost on
// a desktop, enough on a slow phone for typed letters to go missing (S128, F11-01).
//
//   1. The counts equal the rule, read straight off the messages (a reference implementation
//      of the documented rule — muted threads 0; a DM counts the other person's messages, a
//      channel everyone else's, a customer thread the inbound ones — none read by the viewer).
//   2. Once per change: thousands of reads after the first scan the messages ONCE; a new
//      messages array, a new thread list or a different viewer recounts.
//   3. The dock counts after its phone early return and builds its rows only while the list
//      is open (lockstep).
//
// Offline. Run: node scripts/test-messages-unread-memo.mjs
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);
const { selectUnreadForConversation, selectUnreadCountForInbox, selectConversationsForInbox } = await import('../src/store/selectors.js');

let pass = 0;
const fails = [];
const ok = (label, cond) => { if (cond) pass += 1; else fails.push(label); };

// ── a seeded fixture: 400 threads of every kind, 6,000 messages ───────────────────────────
let x = 11;
const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const USERS = ['u_me', 'u_ana', 'u_luis', 'u_rosa', 'u_kim'];
const conversations = [];
for (let i = 0; i < 400; i++) {
  const channel = pick(['sms', 'email', 'internal', 'dm', 'sms']);
  const participants = channel === 'dm' ? ['u_me', pick(USERS.slice(1))] : (channel === 'internal' ? USERS.filter(() => rnd() < 0.6) : []);
  conversations.push({
    id: `cv${i}`, channel, participantUserIds: participants,
    mutedByUserIds: rnd() < 0.1 ? ['u_me'] : (rnd() < 0.1 ? ['u_ana'] : undefined),
    lastMessageAt: new Date(Date.UTC(2026, 9, 1) + i * 60000).toISOString(),
  });
}
conversations.push({ ...conversations[7], mutedByUserIds: ['u_me'] }); // a duplicate id: the FIRST one counts
let reads = 0;
const message = (fields) => {
  const m = { ...fields };
  let cid = m.conversationId;
  delete m.conversationId;
  Object.defineProperty(m, 'conversationId', { enumerable: true, get() { reads += 1; return cid; }, set(v) { cid = v; } });
  return m;
};
const messages = [];
for (let i = 0; i < 6000; i++) {
  const conv = pick(conversations);
  messages.push(message({
    id: `m${i}`, conversationId: rnd() < 0.01 ? 'cv_gone' : conv.id,
    authorUserId: rnd() < 0.3 ? null : pick(USERS),
    direction: pick(['in', 'out', 'internal']),
    readByUserIds: rnd() < 0.5 ? [pick(USERS)] : undefined,
    sentAt: new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString(),
  }));
}

// The documented rule, straight off the data.
function refUnread(s, id) {
  const conv = s.conversations.find((c) => c.id === id);
  if (!conv) return 0;
  const uid = s.currentUserId;
  if (Array.isArray(conv.mutedByUserIds) && conv.mutedByUserIds.includes(uid)) return 0;
  const unreadForMe = (m) => m.authorUserId !== uid && !(m.readByUserIds || []).includes(uid);
  return s.messages.filter((m) => m.conversationId === id && unreadForMe(m)
    && (conv.channel === 'dm' ? Boolean(m.authorUserId) : (conv.channel === 'internal' ? true : m.direction === 'in'))).length;
}
function refInbox(s, inbox, user) {
  const uid = user?.id;
  const list = s.conversations.filter((c) => (inbox === 'internal' ? uid && c.channel === 'internal' && (c.participantUserIds || []).includes(uid)
    : inbox === 'dm' ? uid && c.channel === 'dm' && (c.participantUserIds || []).includes(uid)
      : c.channel === 'sms' || c.channel === 'email'));
  return list.reduce((a, c) => a + refUnread(s, c.id), 0);
}

const state = { conversations, messages, currentUserId: 'u_me' };
const me = { id: 'u_me' };

// ── 1. the counts are the rule's ─────────────────────────────────────────────────────────
reads = 0;
let wrong = [];
for (const c of conversations) if (selectUnreadForConversation(state, c.id) !== refUnread(state, c.id)) wrong.push(c.id);
ok(`every thread's unread count is the rule's (${wrong.length} wrong: ${wrong.slice(0, 5).join(',')})`, wrong.length === 0);
ok('an unknown thread has none', selectUnreadForConversation(state, 'cv_nope') === 0);
for (const inbox of ['inbox', 'internal', 'dm']) {
  for (const user of [me, { id: 'u_ana' }, null]) {
    ok(`the ${inbox} total for ${user?.id || 'nobody'} is the rule's`, selectUnreadCountForInbox(state, inbox, user) === refInbox(state, inbox, user));
  }
}
ok('the muted duplicate does not hide the first thread\'s count', selectUnreadForConversation(state, 'cv7') === refUnread(state, 'cv7'));

// ── 2. once per change ───────────────────────────────────────────────────────────────────
const fresh = { conversations, messages, currentUserId: 'u_me' };
selectUnreadCountForInbox(fresh, 'inbox', me); // warm
reads = 0;
for (let i = 0; i < 200; i++) {
  for (const inbox of ['inbox', 'internal', 'dm']) selectUnreadCountForInbox(fresh, inbox, me);
  selectUnreadForConversation(fresh, `cv${i}`);
}
ok(`800 reads on unchanged slices scan no message (scanned ${reads.toLocaleString()} message fields)`, reads === 0);
ok('the same viewer and slices give the same thread list back', selectConversationsForInbox(fresh, 'dm', me) === selectConversationsForInbox(fresh, 'dm', me));

const read1 = messages.map((m) => (m.conversationId === 'cv3' ? message({ ...m, conversationId: 'cv3', readByUserIds: ['u_me'] }) : m));
const s2 = { conversations, messages: read1, currentUserId: 'u_me' };
reads = 0;
const after = selectUnreadForConversation(s2, 'cv3');
ok('a new messages array recounts: reading a thread clears it', after === 0 && refUnread(s2, 'cv3') === 0);
ok(`…in ONE pass over the messages (${reads} reads for ${read1.length} messages)`, reads <= read1.length * 2);
const s3 = { ...s2, currentUserId: 'u_ana' };
ok('a different viewer recounts', selectUnreadForConversation(s3, 'cv3') === refUnread(s3, 'cv3'));
const s4 = { ...s2, conversations: conversations.map((c) => (c.id === 'cv5' ? { ...c, mutedByUserIds: ['u_me'] } : c)) };
ok('a new thread list recounts: muting zeroes it', selectUnreadForConversation(s4, 'cv5') === 0);
ok('…and the inbox lists follow the new thread list', selectConversationsForInbox(s4, 'inbox', me) !== selectConversationsForInbox(s2, 'inbox', me));
ok('an empty store counts nothing and never throws', selectUnreadCountForInbox({ conversations: [], messages: [], currentUserId: 'u' }, 'inbox', { id: 'u' }) === 0);

// ── 3. the dock: counts after the phone return, rows only while its list is open ─────────────
{
  const dock = readFileSync(new URL('../src/components/MessagesDock.jsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const phoneReturn = dock.indexOf('if (isMobile) return null;');
  const firstCount = dock.indexOf('selectUnreadCountForInbox(state');
  ok('the dock counts unread AFTER its phone early return', phoneReturn > 0 && firstCount > phoneReturn);
  ok('the dock builds its rows only while its list is open', /const rows = open && !activeConv\s*\?/.test(dock));
}

if (fails.length) {
  console.error(`\nFAIL — ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.error(`  FAIL ${f}`);
  process.exitCode = 1;
} else {
  console.log(`\nmessages unread memo: ${pass}/${pass} passed`);
}
