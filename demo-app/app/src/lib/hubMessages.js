// CUSTOMER MESSAGES — the vocabulary and the pure rules (client hub redesign, plan §3.4), shared
// by the customer's routes (api/hub/[...path].js), the office's (api/client-messages/[...path].js),
// their store (api/_lib/clientHub/messages.js), the office screens and the login-free demo, so the
// five can never answer differently.
//
// ONE THREAD PER BUILDING, shared by every customer login that can see the building and every
// office user who holds `hub.messages.view`. The building is a customer row (`cl_*`); a line's
// author is a CUSTOMER login (`client_users.id`, from the verified claim) or a STAFF member (`u_*`,
// from the verified claim) — never a body field.
//
// 🔴 EVERY ANSWER IS AN ALLOWLIST (the posture lib/clientHubView.js set): a projection builds a new
// object from a declared list and copies nothing else, and the suites compare every served
// object's keys to these constants. A staff member's name reaches a customer ONLY through
// hubPersonName ("Dana K."); the office sees full names.
//
// THE HUB STAYS ENGLISH (LANG-8): the update lines and refusals here are English literals, like
// lib/clientHubView.js. The OFFICE's bell row for a customer's message is a catalog MESSAGE
// (`customerMessageAlert`), rendered in each reader's language at the write (lib/notifications
// textFor), and the customer's own words travel as written (LANG-7).
//
// PURE and node-safe (explicit .js imports, no browser globals, no backend).
import { hubPersonName } from './clientHub.js';
import { HUB_HISTORY_DAYS } from './clientHubView.js';
import { RETENTION_YEARS, retentionCutoffIso } from './activityLog.js';
import { woClientStage } from './workOrders.js';
import { resultLabel } from './inspections.js';
import { hubTicketPath, hubInspectionPath, hubMessagesPath } from './clientHubEmails.js';
import { msg } from '../i18n/core.js';
import { fmtDate } from './dates.js';
import { managerIdsMatch } from './teamScope.js';
import { TEXT_VIA } from './texting.js';
import { ON_THE_WAY_KIND, onTheWayLine, hubVisitPath } from './crewOnTheWay.js';

const DAY_MS = 86400000;

// ── the vocabulary ────────────────────────────────────────────────────────────
// `client_messages.author_role`. The migration carries no CHECK for it (the client-hub precedent):
// this is the one list, and the only writer refuses anything else.
export const HUB_MESSAGE_AUTHOR_ROLES = Object.freeze({ client: 'client', staff: 'staff' });
// `client_message_reads.reader_kind`.
export const HUB_MESSAGE_READER_KINDS = Object.freeze({ client: 'client', staff: 'staff' });

// ── bounds ────────────────────────────────────────────────────────────────────
// The body is 1–4000 characters after trimming — also the table's own CHECK (20261008110000).
export const HUB_MESSAGE_BODY_MAX = 4000;
// The newest this many lines per read; older ones page in with `before`.
export const HUB_MESSAGE_PAGE_MAX = 50;
// The hub shows a year (HUB-9's window, the same as every other hub read); the office keeps the
// retention window.
export const HUB_MESSAGE_WINDOW_DAYS = HUB_HISTORY_DAYS;
// Retention AT THE WRITE POINT (THE LAW II.8): an insert deletes that building's lines older than
// this — the activity log's horizon, read from its constant, never restated.
export const HUB_MESSAGE_RETENTION_YEARS = RETENTION_YEARS;
// The office bell's body, and a phone's lock screen (LANG-7: the customer's words, as written).
export const HUB_MESSAGE_SNIPPET_MAX = 140;
// The office list's preview of a thread's last line.
export const HUB_THREAD_SNIPPET_MAX = 200;
// Per-login / per-person send limits, per instance (api/_lib/rateLimit.js says what that does and
// does not stop). Generous for a person, tight for a loop.
export const HUB_MESSAGE_RATE = Object.freeze({ limit: 60, windowMs: 3600000 });
export const OFFICE_MESSAGE_RATE = Object.freeze({ limit: 120, windowMs: 3600000 });
// The bell: the last 30 days, at most 20 lines, across the viewer's buildings.
export const HUB_UPDATES_DAYS = 30;
export const HUB_UPDATES_MAX = 20;
// The viewer's most recent requests the bell looks at for replies and stage changes. One person's
// requests in a year are a handful; the bound keeps the id list a short query string.
export const HUB_UPDATES_TICKET_SCAN = 100;
// The office's thread list: the app's page size, and its ceiling.
export const OFFICE_THREAD_PAGE_SIZE = 20;
export const OFFICE_THREAD_PAGE_MAX = 50;
// A Messages badge counts exactly up to this many buildings per bell read (the rest still show a
// dot from their summary — see the route). A director with 200 buildings reads at most this many
// counts, never one per building.
export const HUB_UNREAD_COUNT_MAX = 20;

// ── time ──────────────────────────────────────────────────────────────────────
export const messageWindowStartIso = (now = Date.now()) => new Date(now - HUB_MESSAGE_WINDOW_DAYS * DAY_MS).toISOString();
export const messageRetentionCutoffIso = (now = Date.now()) => retentionCutoffIso(now);
export const updatesSinceIso = (now = Date.now()) => new Date(now - HUB_UPDATES_DAYS * DAY_MS).toISOString();

// A `before` cursor: an ISO instant, or null for "the newest page". Anything else is ignored.
export function messageCursor(v) {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// How many lines a read returns: 1–50, 50 when unsaid.
export function messagePageLimit(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, HUB_MESSAGE_PAGE_MAX) : HUB_MESSAGE_PAGE_MAX;
}

// A read marker: the time the reader says they read up to, never later than now; now when unsaid
// or unreadable.
export function readMarkerAt(at, now = Date.now()) {
  const t = Date.parse(at);
  return new Date(Number.isFinite(t) ? Math.min(t, now) : now).toISOString();
}

// One line of words for a list or a lock screen: whitespace folded, trimmed, cut with an ellipsis.
export function messageSnippet(text, max = HUB_MESSAGE_SNIPPET_MAX) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

// ── what a person may send ────────────────────────────────────────────────────
export const HUB_MESSAGE_REFUSALS = Object.freeze({
  'message-empty': 'Write a message first.',
  'message-too-long': `Keep it under ${HUB_MESSAGE_BODY_MAX.toLocaleString('en-US')} characters.`,
});
// Only `body` is read: an author, a role or a building id in the same body changes nothing.
export function hubMessageBodyInput(body) {
  const text = typeof body?.body === 'string' ? body.body.trim() : '';
  if (!text) return { refused: HUB_MESSAGE_REFUSALS['message-empty'], code: 'message-empty' };
  if (text.length > HUB_MESSAGE_BODY_MAX) return { refused: HUB_MESSAGE_REFUSALS['message-too-long'], code: 'message-too-long' };
  return { value: { body: text } };
}

// ── the customer's view of a line ─────────────────────────────────────────────
export const HUB_BUILDING_MESSAGE_FIELDS = Object.freeze(['id', 'body', 'createdAt', 'mine', 'authorRole', 'authorName']);
// `staffName` is the live roster's name for a staff line (preferred over the stored one, so a
// rename reads right); either way the customer sees first name + last initial.
export function projectHubBuildingMessage(row, { viewerClientUserId = null, staffName = null } = {}) {
  const staff = row?.author_role === HUB_MESSAGE_AUTHOR_ROLES.staff;
  const mine = !staff && !!viewerClientUserId && row?.author_client_user_id === viewerClientUserId;
  let authorName;
  if (mine) authorName = 'You';
  else if (staff) authorName = hubPersonName(staffName || row?.author_name) || 'Our team';
  else authorName = hubPersonName(row?.author_name) || 'Your team';
  return {
    id: row?.id ?? null,
    body: String(row?.body ?? ''),
    createdAt: row?.created_at ?? null,
    mine,
    authorRole: staff ? HUB_MESSAGE_AUTHOR_ROLES.staff : HUB_MESSAGE_AUTHOR_ROLES.client,
    authorName,
  };
}

// The account manager as the hub may name them — first name + last initial, or nobody.
export const HUB_MESSAGE_MANAGER_FIELDS = Object.freeze(['name']);
export function projectHubMessageManager(user) {
  const name = hubPersonName(user?.name);
  return name ? { name } : null;
}

// ── the office's view of a line ───────────────────────────────────────────────
// `via` / `phone`: a customer's line that came in as a TEXT (lib/texting TEXT_VIA) and the number
// it came from; null for a hub line and every staff line. `text`: how an office line's text-back
// went ({ status: TEXT_BACK.*, to }), or null when it was not texted (the thread's newest customer
// line came from the hub). The customer's own view (above) carries none of the three.
export const OFFICE_MESSAGE_FIELDS = Object.freeze(['id', 'body', 'createdAt', 'authorRole', 'authorName', 'authorUserId', 'mine', 'via', 'phone', 'text']);
export function projectOfficeMessage(row, { viewerUserId = null, staffName = null, text = null } = {}) {
  const staff = row?.author_role === HUB_MESSAGE_AUTHOR_ROLES.staff;
  const name = staff ? (staffName || row?.author_name) : row?.author_name;
  const texted = !staff && row?.via === TEXT_VIA;
  return {
    id: row?.id ?? null,
    body: String(row?.body ?? ''),
    createdAt: row?.created_at ?? null,
    authorRole: staff ? HUB_MESSAGE_AUTHOR_ROLES.staff : HUB_MESSAGE_AUTHOR_ROLES.client,
    authorName: typeof name === 'string' && name.trim() ? name.trim() : null,
    authorUserId: staff ? (row?.author_user_id || null) : null,
    mine: staff && !!viewerUserId && row?.author_user_id === viewerUserId,
    via: texted ? TEXT_VIA : null,
    phone: texted ? (row?.phone || null) : null,
    text: staff && text && typeof text.status === 'string' ? { status: text.status, to: text.to || null } : null,
  };
}

// ── the office's thread list ──────────────────────────────────────────────────
export const OFFICE_THREAD_FIELDS = Object.freeze([
  'clientId', 'clientName', 'customerNumber', 'managerId', 'managerName',
  'lastAt', 'lastBody', 'lastAuthorRole', 'lastAuthorName', 'unread', 'unreadCount',
]);

// A thread is UNREAD for a staff member when a CUSTOMER wrote after their read marker. The
// office's own replies are not news to the office.
export function staffThreadUnread(summary, lastReadAt) {
  const t = Date.parse(summary?.last_client_message_at);
  if (!Number.isFinite(t)) return false;
  const r = Date.parse(lastReadAt);
  return !Number.isFinite(r) || t > r;
}

// A building's thread MAY hold unread lines for a customer when anything was written after their
// marker; the route then counts exactly (lines not their own). Never a false "nothing new".
export function customerThreadMaybeUnread(summary, lastReadAt) {
  const t = Date.parse(summary?.last_message_at);
  if (!Number.isFinite(t)) return false;
  const r = Date.parse(lastReadAt);
  return !Number.isFinite(r) || t > r;
}

// The rows behind the office's list, before filtering and paging. `summaries` are
// client_message_threads rows; `clients` / `users` the shared record's; `readAtByClient` the
// viewer's markers. A thread whose building left the book is not listed.
export function officeThreadRows({ summaries = [], clients = [], users = [], readAtByClient = new Map() } = {}) {
  const clientById = new Map((clients || []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const userById = new Map((users || []).filter((u) => u && u.id).map((u) => [u.id, u]));
  const out = [];
  for (const s of summaries || []) {
    const client = clientById.get(s?.client_id);
    if (!client) continue;
    const manager = client.supervisorId ? userById.get(client.supervisorId) || null : null;
    const staff = s.last_author_role === HUB_MESSAGE_AUTHOR_ROLES.staff;
    const lastAuthor = staff ? (userById.get(s.last_author_user_id)?.name || s.last_author_name) : s.last_author_name;
    out.push({
      clientId: client.id,
      clientName: client.name || '',
      customerNumber: client.customerNumber ?? null,
      managerId: client.supervisorId || null,
      managerName: manager?.name || null,
      lastAt: s.last_message_at || null,
      lastBody: String(s.last_snippet ?? ''),
      lastAuthorRole: staff ? HUB_MESSAGE_AUTHOR_ROLES.staff : HUB_MESSAGE_AUTHOR_ROLES.client,
      lastAuthorName: typeof lastAuthor === 'string' && lastAuthor.trim() ? lastAuthor.trim() : null,
      unread: staffThreadUnread(s, readAtByClient.get(client.id) || null),
      unreadCount: 0,
    });
  }
  return out;
}

// "mine" = the buildings the viewer manages (`client.supervisorId`); the Manager and Customer
// filters narrow further. Never widened: an unknown filter reads as "all".
// `managerId`: one manager's id, a list of them (an Operations Manager's team, S131 — the route
// resolves `team` from the caller's claim), or null for all.
export function filterOfficeThreads(rows, { filter = 'all', viewerUserId = null, managerId = null, clientId = null } = {}) {
  return (rows || []).filter((r) => {
    if (filter === 'mine' && (!viewerUserId || r.managerId !== viewerUserId)) return false;
    if (managerId && !managerIdsMatch(managerId, r.managerId)) return false;
    if (clientId && r.clientId !== clientId) return false;
    return true;
  });
}

// UNREAD FIRST, then the newest last line, then the building id — a total order, so a page never
// skips or repeats a thread.
export function sortOfficeThreads(rows) {
  return (rows || []).slice().sort((a, b) => (Number(b.unread) - Number(a.unread))
    || ((Date.parse(b.lastAt) || 0) - (Date.parse(a.lastAt) || 0))
    || String(a.clientId).localeCompare(String(b.clientId)));
}

export function officeThreadPage(q = {}) {
  const o = Number.parseInt(q.offset, 10);
  const l = Number.parseInt(q.limit, 10);
  return {
    offset: Number.isFinite(o) && o > 0 ? Math.min(o, 100000) : 0,
    limit: Number.isFinite(l) && l > 0 ? Math.min(l, OFFICE_THREAD_PAGE_MAX) : OFFICE_THREAD_PAGE_SIZE,
  };
}

// The served row: exactly OFFICE_THREAD_FIELDS.
export function projectOfficeThread(r) {
  const out = {};
  for (const f of OFFICE_THREAD_FIELDS) out[f] = r && r[f] !== undefined ? r[f] : null;
  out.unread = !!out.unread;
  out.unreadCount = Number.isFinite(out.unreadCount) ? out.unreadCount : 0;
  return out;
}

// ── the threads WAITING for the office's reply ────────────────────────────────
// A building's thread WAITS when its CUSTOMER wrote last; the wait runs from the first line the
// office has not answered, and a reply in that same thread ends it. HUB-24 (c), Matt 2026-10-12:
// "Messages and requests should be treated separately" — so a waiting thread is NOT a client
// request (it is not in Client Requests, its counts or its clocks): it has its own place,
// Messaging → Customers' Waiting view and the customer page's Messages tab, each saying how long
// it has waited, and its own count, the manager Home's Customer messages tile and the Messages
// row's pill. These rules are the server's (GET /api/client-messages/threads?waiting=1 and the
// `waitingSince` of GET /api/client-messages/thread) and the demo's.
//
// A thread waits when a customer wrote after the office's last line (or the office never wrote).
export function threadAwaitingReply(summary) {
  const c = Date.parse(summary?.last_client_message_at);
  if (!Number.isFinite(c)) return false;
  const s = Date.parse(summary?.last_staff_message_at);
  return !Number.isFinite(s) || c > s;
}
// When the wait began: the earliest CUSTOMER line after the office's last line (`lastStaffAt`, null
// = the office never wrote). A customer writing twice does not restart the clock.
export function firstUnansweredAt(lines, { clientId, lastStaffAt = null } = {}) {
  const after = Date.parse(lastStaffAt);
  let first = null;
  for (const m of lines || []) {
    if (!m || m.client_id !== clientId || m.author_role !== HUB_MESSAGE_AUTHOR_ROLES.client) continue;
    const t = Date.parse(m.created_at);
    if (!Number.isFinite(t) || (Number.isFinite(after) && t <= after)) continue;
    if (first == null || t < Date.parse(first)) first = m.created_at;
  }
  return first;
}
// The line a wait is counted after: the office's last line, or the retention cutoff when that is
// later (or the office never wrote) — a line past retention is gone from the thread the office
// reads, so it never starts a clock.
export function waitFloorIso(lastStaffAt, now = Date.now()) {
  const cutoff = messageRetentionCutoffIso(now);
  const s = Date.parse(lastStaffAt);
  return Number.isFinite(s) && s > Date.parse(cutoff) ? new Date(s).toISOString() : cutoff;
}
// When a thread's wait began, from its summary and the first unanswered customer line the reader
// found after `waitFloorIso` (the server's one narrow read, the demo's scan): that line, else the
// customer's last line; null when the thread is not waiting (or there is no thread). How long it
// has waited is lib/dates minutesSince(waitingSince), which the screens word (components/
// CustomerThread WaitedFor) and the manager Home's count reads (lib/managerHome messageFigures).
export function waitingSinceFrom(summary, firstUnansweredLineAt) {
  if (!threadAwaitingReply(summary)) return null;
  return firstUnansweredLineAt || summary.last_client_message_at || null;
}
// The served waiting row: the thread's fields and `waitingSince`.
export const OFFICE_WAITING_FIELDS = Object.freeze([...OFFICE_THREAD_FIELDS, 'waitingSince']);
export function projectOfficeWaitingThread(r) {
  return { ...projectOfficeThread(r), waitingSince: r && r.waitingSince ? r.waitingSince : null };
}
// The longest wait first, then the building id.
export function sortWaitingThreads(rows) {
  return (rows || []).slice().sort((a, b) => ((Date.parse(a.waitingSince) || 0) - (Date.parse(b.waitingSince) || 0))
    || String(a.clientId).localeCompare(String(b.clientId)));
}

// ── the office's bell row for a customer's message ────────────────────────────
// The deep link the bell row and the Messaging tab share: Messaging → Customers, that building.
export const customerThreadUrl = (clientId) => `/messaging?inbox=customers&b=${encodeURIComponent(String(clientId ?? ''))}`;

// Title: a catalog message, rendered in each READER's language at the write (CS-193, LANG-4).
// Body: the customer's own words, as written, ≤140 characters (LANG-7).
export function customerMessageAlert({ clientId, placeName = '', authorName = '', body = '' } = {}) {
  const place = String(placeName || '').trim() || String(clientId || '');
  const name = String(authorName || '').trim();
  return {
    title: name ? msg('alerts.customerMessage.title', { place, name }) : msg('alerts.customerMessage.titleNoName', { place }),
    body: messageSnippet(body, HUB_MESSAGE_SNIPPET_MAX),
    url: customerThreadUrl(clientId),
  };
}

// ── the customer's bell (`GET /api/hub/updates`) ──────────────────────────────
export const HUB_UPDATE_KINDS = Object.freeze(['reply', 'stage', 'message', 'inspection', ON_THE_WAY_KIND]);
export const HUB_UPDATE_FIELDS = Object.freeze(['kind', 'buildingId', 'buildingName', 'text', 'at', 'url', 'unread']);

const quoted = (s) => `“${messageSnippet(s, 80)}”`;
// One update, in the hub's English, from the facts its source row gives. Returns null for a row
// that cannot be told (no time, no building), which the caller drops.
export function hubUpdate(kind, f = {}) {
  if (!f.buildingId || !Number.isFinite(Date.parse(f.at))) return null;
  const base = { kind, buildingId: f.buildingId, buildingName: f.buildingName || '', at: new Date(Date.parse(f.at)).toISOString() };
  const title = String(f.title || '').trim() || 'your request';
  switch (kind) {
    case 'reply':
      return { ...base, text: `${hubPersonName(f.authorName) || 'Our team'} replied on your request ${quoted(title)}.`, url: hubTicketPath(f.buildingId, f.ticketId) };
    case 'stage':
      return { ...base, text: `Your request ${quoted(title)} is now: ${woClientStage(f.status).label}.`, url: hubTicketPath(f.buildingId, f.ticketId) };
    case 'message':
      return { ...base, text: `${hubPersonName(f.authorName) || 'Our team'}: ${quoted(f.body)}`, url: hubMessagesPath(f.buildingId) };
    case 'inspection': {
      const score = Number.isFinite(f.score) ? ` (${f.score}%)` : '';
      const name = String(f.name || '').trim() || 'Inspection';
      return { ...base, text: `New inspection report: ${name} — ${resultLabel(f.result)}${score}.`, url: hubInspectionPath(f.buildingId, f.inspectionId) };
    }
    // Crew on the way (lib/crewOnTheWay.js): a cleaner tapped On my way; the arrival in the org's zone.
    case ON_THE_WAY_KIND:
      return { ...base, text: onTheWayLine({ buildingName: f.buildingName, eta: f.eta, tz: f.tz }), url: hubVisitPath(f.buildingId) };
    default:
      return null;
  }
}

// The bell's answer: newest first (a total order), at most 20, each EXACTLY HUB_UPDATE_FIELDS,
// unread when newer than the login's `updates_seen_at`.
export function finishHubUpdates(items, { seenAt = null, max = HUB_UPDATES_MAX } = {}) {
  const seen = Date.parse(seenAt);
  const list = (items || []).filter(Boolean)
    .sort((a, b) => (Date.parse(b.at) - Date.parse(a.at)) || String(a.url).localeCompare(String(b.url)) || String(a.text).localeCompare(String(b.text)))
    .slice(0, max)
    .map((u) => ({
      kind: u.kind,
      buildingId: u.buildingId,
      buildingName: u.buildingName,
      text: u.text,
      at: u.at,
      url: u.url,
      unread: !Number.isFinite(seen) || Date.parse(u.at) > seen,
    }));
  return { updates: list, unseen: list.filter((u) => u.unread).length };
}

// ── the demo's twins of the counts the route makes in SQL ─────────────────────
// A customer's unread lines in one building: anyone's but their own, after their marker, inside
// the hub's year.
export function countCustomerUnread(rows, { clientId, clientUserId, since = null, now = Date.now() } = {}) {
  const from = Math.max(Date.parse(since) || -Infinity, Date.parse(messageWindowStartIso(now)));
  return (rows || []).filter((m) => m && m.client_id === clientId && Date.parse(m.created_at) > from
    && !(m.author_role === HUB_MESSAGE_AUTHOR_ROLES.client && m.author_client_user_id === clientUserId)).length;
}
// A staff member's unread lines in one building: the customers', after their marker.
export function countStaffUnread(rows, { clientId, since = null, now = Date.now() } = {}) {
  const from = Math.max(Date.parse(since) || -Infinity, Date.parse(messageRetentionCutoffIso(now)));
  return (rows || []).filter((m) => m && m.client_id === clientId && m.author_role === HUB_MESSAGE_AUTHOR_ROLES.client
    && Date.parse(m.created_at) > from).length;
}

// ── the hub screens' small rules (Wave B: pages/hub/HubMessages, HubBell, the nav badge) ──────
// The Messages page re-reads its thread this often while it is visible (plan §3.4: a customer
// login has no realtime). The bell's answer is re-read on the layout's own minute.
export const HUB_MESSAGES_POLL_MS = 30000;

// The building's unread count in the bell's answer (`messagesUnread`, GET /api/hub/updates): the
// Messages badge for the building in view. Anything malformed is 0.
export function hubUnreadFor(updates, buildingId) {
  const list = Array.isArray(updates?.messagesUnread) ? updates.messagesUnread : [];
  const n = Number(list.find((x) => x && x.buildingId === buildingId)?.count);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// The bell's "when", in English (LANG-8): "Just now", "5 min ago", "3 h ago", "Yesterday",
// "3 days ago", then the day in the company's zone ("Sep 27").
export function hubAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!iso || !Number.isFinite(t)) return '';
  const ms = Math.max(0, now - t);
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} days ago`;
  return fmtDate(new Date(t).toISOString(), { month: 'short', day: 'numeric' });
}

// The thread on screen after a read: every line once (by id, the newer copy wins), oldest first,
// ties by id — so a poll, "Load earlier" and a just-sent line can arrive in any order.
export function mergeHubLines(existing, incoming) {
  const byId = new Map();
  for (const l of [...(existing || []), ...(incoming || [])]) if (l && l.id) byId.set(l.id, l);
  return [...byId.values()].sort((a, b) => (Date.parse(a.createdAt) - Date.parse(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
}
