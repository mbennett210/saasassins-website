// CUSTOMER MESSAGES' LOGIN-FREE DEMO — the office's Customers tab and the customer's hub thread on
// `--mode demo`, from ONE local store (data/stubKeys CLIENT_MESSAGES_STUB_KEY, seeded by
// data/demoStubs.js), so a reply typed in the office shows in the hub preview and the other way.
//
// 🔴 REACHABLE ONLY FROM A DEMO BUILD. lib/clientMessagesApi.js (the office) imports this module
// dynamically behind its static `import.meta.env.MODE === 'demo'` gate, and lib/hubDemo.js (the
// customer) is itself reachable only behind lib/clientHubApi's. `npm run build` emits no chunk for
// it; check-bundle-stubs fails a production bundle carrying the `cs-stub:client-messages` sentinel.
//
// THE SAME ANSWERS AS THE SERVER: the rows are `public.client_messages`' own snake_case shape, and
// every rule — the inputs, the projections, the thread order, the unread counts, the retention —
// is lib/hubMessages.js, which the routes run too. Only the reads differ. The one thing the demo
// does not do is ring a bell or send an email: those are server writes an API module cannot make.
import { CLIENT_MESSAGES_STUB_KEY } from '../data/stubKeys';
import { loadState } from '../store/persist';
import { INITIAL_STATE } from '../data/seed';
import { isArchivedCustomer } from './customerStatus.js';
import { TEAM, teamMemberIds, teamLeadFor } from './teamScope.js';
import {
  HUB_MESSAGE_AUTHOR_ROLES as ROLE, HUB_MESSAGE_READER_KINDS as READER, HUB_THREAD_SNIPPET_MAX,
  hubMessageBodyInput, messageCursor, messagePageLimit, messageSnippet, messageWindowStartIso, messageRetentionCutoffIso,
  readMarkerAt, projectOfficeMessage, officeThreadRows, filterOfficeThreads, sortOfficeThreads, officeThreadPage,
  projectOfficeThread, countStaffUnread,
  threadAwaitingReply, firstUnansweredAt, projectOfficeWaitingThread, sortWaitingThreads, waitFloorIso, waitingSinceFrom,
} from './hubMessages.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── the store ─────────────────────────────────────────────────────────────────
export function loadDb() {
  try {
    const db = JSON.parse(localStorage.getItem(CLIENT_MESSAGES_STUB_KEY)) || {};
    return {
      messages: Array.isArray(db.messages) ? db.messages : [],
      reads: Array.isArray(db.reads) ? db.reads : [],
      updatesSeen: db.updatesSeen && typeof db.updatesSeen === 'object' ? db.updatesSeen : {},
      emailPrefs: db.emailPrefs && typeof db.emailPrefs === 'object' ? db.emailPrefs : {},
    };
  } catch {
    return { messages: [], reads: [], updatesSeen: {}, emailPrefs: {} };
  }
}
export function saveDb(db) {
  try { localStorage.setItem(CLIENT_MESSAGES_STUB_KEY, JSON.stringify(db)); } catch { /* quota / private mode */ }
}

// The demo org's customer book and roster, as the office's store holds them.
export function demoBook() {
  let s = null;
  try { s = loadState(); } catch { s = null; }
  const state = s && Array.isArray(s.clients) ? s : INITIAL_STATE;
  return {
    clients: (state.clients || []).filter((c) => c && c.id),
    users: (state.users || []).filter((u) => u && u.id),
    currentUserId: state.currentUserId || null,
  };
}

// An error in the server's shape (status + code + sentence), so a screen handles both the same way.
export function refuse(status, code, sentence) {
  const err = new Error(sentence);
  err.status = status;
  err.code = code;
  return err;
}

// ── the rows, read the way the server reads its tables ────────────────────────
const newestFirst = (a, b) => (Date.parse(b.created_at) - Date.parse(a.created_at)) || String(b.id).localeCompare(String(a.id));

// One building's lines inside `sinceIso`, the newest `limit` before `before`, returned oldest first.
export function threadPage(db, clientId, { sinceIso, before = null, limit }) {
  const rows = db.messages
    .filter((m) => m.client_id === clientId && Date.parse(m.created_at) >= Date.parse(sinceIso)
      && (!before || Date.parse(m.created_at) < Date.parse(before)))
    .sort(newestFirst);
  return { rows: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
}

// The client_message_threads rows the server keeps, derived from the lines.
export function summariesOf(messages) {
  const by = new Map();
  for (const m of [...messages].sort((a, b) => -newestFirst(a, b))) {
    const prev = by.get(m.client_id) || {};
    const side = m.author_role === ROLE.client ? 'last_client_message_at' : 'last_staff_message_at';
    by.set(m.client_id, {
      ...prev,
      client_id: m.client_id,
      last_message_id: m.id,
      last_message_at: m.created_at,
      last_author_role: m.author_role,
      last_author_name: m.author_name,
      last_author_user_id: m.author_user_id,
      last_author_client_user_id: m.author_client_user_id,
      last_snippet: messageSnippet(m.body, HUB_THREAD_SNIPPET_MAX),
      [side]: m.created_at,
    });
  }
  return [...by.values()];
}

export function markerOf(db, clientId, readerKind, readerId) {
  return db.reads.find((r) => r.client_id === clientId && r.reader_kind === readerKind && r.reader_id === readerId)?.last_read_at || null;
}
export function setMarker(db, clientId, readerKind, readerId, at) {
  const prev = db.reads.find((r) => r.client_id === clientId && r.reader_kind === readerKind && r.reader_id === readerId);
  if (prev) {
    if (Date.parse(prev.last_read_at) < Date.parse(at)) prev.last_read_at = at;
    return prev.last_read_at;
  }
  db.reads.push({ client_id: clientId, reader_kind: readerKind, reader_id: readerId, last_read_at: at });
  return at;
}

// A new line, through the server's input rule and replay rule. `own(row)` says whether an
// existing row with the same id is the caller's own (a replay) — anything else is a 409.
export function appendLine(db, { id, clientId, body, author, own }) {
  const input = hubMessageBodyInput({ body });
  if (input.refused) throw refuse(400, input.code, input.refused);
  if (id != null && !UUID_RE.test(String(id))) throw refuse(400, 'message-id', 'This message could not be sent. Refresh the page and try again.');
  const lineId = id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `dm_${Date.now().toString(36)}`);
  const existing = db.messages.find((m) => m.id === lineId);
  if (existing) {
    if (own(existing)) return { row: existing, replay: true };
    throw refuse(409, 'message-id', 'This message could not be sent. Refresh the page and try again.');
  }
  const row = {
    id: lineId,
    client_id: clientId,
    author_role: author.role,
    author_client_user_id: author.clientUserId || null,
    author_user_id: author.userId || null,
    author_name: author.name || null,
    body: input.value.body,
    created_at: new Date().toISOString(),
  };
  // Retention at the write point, as the server does.
  const cutoff = Date.parse(messageRetentionCutoffIso());
  db.messages = db.messages.filter((m) => m.client_id !== clientId || Date.parse(m.created_at) >= cutoff);
  db.messages.push(row);
  return { row, replay: false };
}

// ── the office's side (lib/clientMessagesApi's demo branch) ───────────────────
// `ctx.user` is the demo's signed-in teammate (the screen passes it; the real route reads the
// claim). Falls back to the demo store's current user.
const viewerOf = (book, ctx) => ctx?.user?.id || book.currentUserId || null;
const notFound = () => refuse(404, 'not-found', "We couldn't find that customer. It may have been removed.");
// CS-663, the server's 409 (api/client-messages): an archived customer's thread takes no new line.
const archivedRefusal = () => refuse(409, 'building-archived', 'This customer is archived, so its hub logins can no longer read messages. Restore the customer to write to them.');

// Since when one building's thread has waited for the office's reply (null when it is not waiting):
// the server's rule (lib/hubMessages waitingSinceFrom) over the demo's lines.
function waitingSinceIn(db, summary) {
  if (!threadAwaitingReply(summary)) return null;
  return waitingSinceFrom(summary, firstUnansweredAt(db.messages, { clientId: summary.client_id, lastStaffAt: waitFloorIso(summary.last_staff_message_at) }));
}

// The route's `managerId=team` (S131): the CALLER's team — an Operations Manager's managers — and
// for anyone else, themselves. The demo's caller is its signed-in teammate (their roster role
// stands in for the claim); any other managerId filters as it is.
function managerFilterOf(book, viewer, managerId, om = null) {
  if (managerId !== TEAM) return managerId || null;
  const me = book.users.find((u) => u.id === viewer) || null;
  // The route's rule (lib/teamScope teamLeadFor): an owner or an admin may name whose team (`om`).
  return teamMemberIds(book.users, teamLeadFor({ role: me ? me.role : null, selfId: viewer, users: book.users, om }));
}

export async function officeThreads(q = {}, ctx = {}) {
  const book = demoBook();
  const db = loadDb();
  const viewer = viewerOf(book, ctx);
  const managerId = managerFilterOf(book, viewer, q.managerId, q.om);
  // The server's `?waiting=1` — every thread whose customer wrote last, by the same rules.
  if (q.waiting === 1 || q.waiting === '1' || q.waiting === true) {
    const summaries = summariesOf(db.messages).filter(threadAwaitingReply);
    const byClient = new Map(summaries.map((s) => [s.client_id, s]));
    // An ARCHIVED customer's thread waits on nobody (CS-663), as on the server.
    const rows = filterOfficeThreads(
      officeThreadRows({ summaries, clients: book.clients.filter((c) => !isArchivedCustomer(c)), users: book.users }),
      { filter: 'all', managerId, clientId: q.clientId || null },
    ).map((r) => ({ ...r, waitingSince: waitingSinceIn(db, byClient.get(r.clientId)) }));
    const sorted = sortWaitingThreads(rows);
    return { threads: sorted.map(projectOfficeWaitingThread), total: sorted.length };
  }
  const readAt = new Map(db.reads.filter((r) => r.reader_kind === READER.staff && r.reader_id === viewer).map((r) => [r.client_id, r.last_read_at]));
  const rows = sortOfficeThreads(filterOfficeThreads(
    officeThreadRows({ summaries: summariesOf(db.messages), clients: book.clients, users: book.users, readAtByClient: readAt }),
    { filter: q.filter === 'mine' ? 'mine' : 'all', viewerUserId: viewer, managerId, clientId: q.clientId || null },
  ));
  const { offset, limit } = officeThreadPage(q);
  const page = rows.slice(offset, offset + limit).map((r) => (r.unread
    ? { ...r, unreadCount: countStaffUnread(db.messages, { clientId: r.clientId, since: readAt.get(r.clientId) || null }) }
    : r));
  return { threads: page.map(projectOfficeThread), total: rows.length, offset, limit, unreadThreads: rows.filter((r) => r.unread).length };
}

export async function officeThread(clientId, q = {}, ctx = {}) {
  const book = demoBook();
  const client = book.clients.find((c) => c.id === clientId);
  if (!client) throw notFound();
  const db = loadDb();
  const viewer = viewerOf(book, ctx);
  const userById = new Map(book.users.map((u) => [u.id, u]));
  const { rows, hasMore } = threadPage(db, client.id, {
    sinceIso: messageRetentionCutoffIso(), before: messageCursor(q.before), limit: messagePageLimit(q.limit),
  });
  const manager = client.supervisorId ? userById.get(client.supervisorId) || null : null;
  const summary = summariesOf(db.messages.filter((m) => m.client_id === client.id))[0] || null;
  return {
    client: { id: client.id, name: client.name || '', archived: isArchivedCustomer(client) },
    manager: manager ? { id: manager.id, name: manager.name || '' } : null,
    messages: rows.map((r) => projectOfficeMessage(r, { viewerUserId: viewer, staffName: r.author_role === ROLE.staff ? userById.get(r.author_user_id)?.name || null : null })),
    hasMore,
    readAt: markerOf(db, client.id, READER.staff, viewer),
    waitingSince: isArchivedCustomer(client) ? null : waitingSinceIn(db, summary),
    // The demo sends and receives no texts: no line came by text, so no reply is texted.
    textBack: null,
  };
}

export async function officeSend({ id, clientId, body } = {}, ctx = {}) {
  const book = demoBook();
  const client = book.clients.find((c) => c.id === clientId);
  if (!client) throw notFound();
  const viewer = viewerOf(book, ctx);
  const me = book.users.find((u) => u.id === viewer) || null;
  const db = loadDb();
  if (isArchivedCustomer(client) && !db.messages.some((m) => m.id === id)) throw archivedRefusal();
  const { row } = appendLine(db, {
    id, clientId: client.id, body,
    author: { role: ROLE.staff, userId: viewer, name: me?.name || null },
    own: (m) => m.client_id === client.id && m.author_role === ROLE.staff && m.author_user_id === viewer,
  });
  setMarker(db, client.id, READER.staff, viewer, row.created_at);
  saveDb(db);
  return { message: projectOfficeMessage(row, { viewerUserId: viewer, staffName: me?.name || null }) };
}

export async function officeRead({ clientId, at } = {}, ctx = {}) {
  const book = demoBook();
  if (!book.clients.some((c) => c.id === clientId)) throw notFound();
  const db = loadDb();
  const readAt = setMarker(db, clientId, READER.staff, viewerOf(book, ctx), readMarkerAt(at));
  saveDb(db);
  return { readAt };
}

// Which of a customer's numbers have texts off: none in the demo (it receives no texts).
export async function textStatus(clientId) {
  if (!demoBook().clients.some((c) => c.id === clientId)) throw notFound();
  return { optOuts: [] };
}

// The hub's window for a customer's thread, re-exported for lib/hubDemo's twins.
export const hubWindowStart = () => messageWindowStartIso();
