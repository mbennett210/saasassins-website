// CUSTOMER MESSAGES — the store and the logic behind the customer's branches in
// api/hub/[...path].js (messages, message, messages-read, updates, updates-seen, email-prefs) and
// the office's family api/client-messages/[...path].js (threads, thread, send, read). The client
// hub redesign, plan §3.4. Service-role only; never import client-side.
//
// THE TABLES (migration 20261008110000): client_messages (every line), client_message_threads (one
// summary per building, moved forward by GUARDED updates), client_message_reads (per reader, per
// building), and two columns on client_users (updates_seen_at, email_prefs). RLS on, no policies:
// this module is the only way in.
//
// THE RULES THIS FILE KEEPS (the routes depend on them; lib/hubMessages.js holds the pure half):
//   1. 🔴 THE BUILDING IS IN THE QUERY. Every message read is filtered by `client_id` = a building
//      the ROUTE has already checked (the customer's claim-resolved scope, or the office's book),
//      so an id from another building comes back as nothing.
//   2. 🔴 THE AUTHOR COMES FROM THE VERIFIED CLAIM — `clientUser.id` for a customer, the authority's
//      `orgUserId` for staff — never from a body field.
//   3. DECLARED COLUMN LISTS, never select(*); every list BOUNDED and ORDERED (lint:paging).
//   4. RETENTION AT THE WRITE POINT (THE LAW II.8): an insert deletes that building's lines older
//      than HUB_MESSAGE_RETENTION_YEARS (the activity log's horizon).
//   5. Side effects after a saved line — the thread summary, the prune, the activity log, the
//      office's bell, the customers' emails — are BEST-EFFORT: none of them fails the line, which
//      is already saved. A replay re-runs the summary (idempotent), so a retried post heals it.
//
// TEXTS (2026-10-28, Daniel's pick "Customer thread, texted back"): a customer's text reply lands
// here as a customer line marked as a text (`via` TEXT_VIA, `phone` the number in E.164;
// postTextMessage, called by api/_lib/sms/inbound.js), and when the office answers a thread whose
// NEWEST customer line came by text, the answer is also texted to that number (textBack, through
// the one customer-message send step: the STOP line, refused for a number that said STOP), once
// per office line (the sent log's `office_reply:<line id>` row), beside the hub-login emails.
//
// Errors THROW with the provider's words in the message, for the server log only; the routes
// answer a sentence and a code (CS-077 class).
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { exactCount, selectAll } from '../pagedSelect.js';
import { readOrgState, writeOrgState } from '../orgState.js';
import { logActivity } from '../activityLog.js';
import { emailMessageReplied } from './notify.js';
import { fanOutManagerOrAdmins, resolveAccountSupervisor, CUSTOMER_MESSAGE_EVENT } from '../../../src/lib/notifications.js';
import { mergeHubEmailPrefs, resolveHubEmailPrefs } from '../../../src/lib/hubEmailPrefs.js';
import { isArchivedCustomer } from '../../../src/lib/customerStatus.js';
import { sendCustomerMessage } from '../customerMessages/send.js';
import { MESSAGE_STATUS, insertNew, readMessages, finishMessage } from '../customerMessages/store.js';
import { readOptOut } from '../sms/optOuts.js';
import {
  TEXT_VIA, OFFICE_REPLY_TEMPLATE, officeReplyLogId, textBackOf, displayPhone,
  OPTED_OUT_REASON, SAMPLE_RECORD_REASON, NOT_SET_UP_REASON,
} from '../../../src/lib/texting.js';
import { toE164 } from '../../../src/lib/alertDelivery.js';
import { ON_THE_WAY_ACTION, ON_THE_WAY_KIND } from '../../../src/lib/crewOnTheWay.js';
import {
  HUB_MESSAGE_AUTHOR_ROLES as ROLE, HUB_MESSAGE_READER_KINDS as READER,
  HUB_THREAD_SNIPPET_MAX, HUB_UPDATES_MAX, HUB_UPDATES_TICKET_SCAN, HUB_UNREAD_COUNT_MAX,
  messageWindowStartIso, messageRetentionCutoffIso, updatesSinceIso, messageCursor, messagePageLimit, messageSnippet,
  projectHubBuildingMessage, projectHubMessageManager, projectOfficeMessage, customerMessageAlert,
  officeThreadRows, filterOfficeThreads, sortOfficeThreads, officeThreadPage, projectOfficeThread,
  customerThreadMaybeUnread, hubUpdate, finishHubUpdates,
  threadAwaitingReply, projectOfficeWaitingThread, sortWaitingThreads, waitFloorIso, waitingSinceFrom,
  HUB_MESSAGE_RETENTION_YEARS,
} from '../../../src/lib/hubMessages.js';

const ORG = CLEANSPACE_ORG_ID;
const org = (q) => q.eq('organization_id', ORG);
const db = () => getSupabase();

function must(res, what) {
  if (res?.error) {
    const err = new Error(`${what}: ${res.error.message || res.error.code || 'failed'}`);
    err.code = res.error.code || null;
    throw err;
  }
  return res;
}
const quietly = async (what, fn) => {
  try { return await fn(); } catch (e) { console.error(`[client-messages] ${what} failed:`, e?.code || '', e?.message || e); return null; }
};

// A client hub ticket is one the CUSTOMER raised (origin 'portal') — the same word
// api/_lib/clientHub/reads.js CLIENT_TICKET_ORIGIN spells; the bell reads only those.
const PORTAL = 'portal';

// ── column lists (rule 3) ─────────────────────────────────────────────────────
export const MESSAGE_COLUMNS = 'id,client_id,author_role,author_client_user_id,author_user_id,author_name,body,created_at,via,phone';
export const THREAD_COLUMNS = 'client_id,last_message_id,last_message_at,last_author_role,last_author_name,last_author_user_id,last_author_client_user_id,last_snippet,last_client_message_at,last_staff_message_at';
const READ_COLUMNS = 'client_id,reader_kind,reader_id,last_read_at';
const UPDATE_TICKET_COLUMNS = 'id,client_id,title,created_at';
const UPDATE_REPLY_COLUMNS = 'id,problem_id,author_role,author_name,created_at';
const UPDATE_STAGE_COLUMNS = 'id,occurred_at,actor_role,entity_id,client_id,after';
const UPDATE_ON_THE_WAY_COLUMNS = 'id,occurred_at,client_id,after';
const UPDATE_INSPECTION_COLUMNS = 'id,client_id,template_name:template_snapshot->name,overall_score,result,performed_at';
// One summary and one read marker per building: the customer book bounds both reads.
const BOOK_MAX = 20000;

// ── one line ──────────────────────────────────────────────────────────────────
export async function messageById(id) {
  const { data } = must(await org(db().from('client_messages').select(MESSAGE_COLUMNS)).eq('id', id).maybeSingle(), 'message read');
  return data || null;
}

// The replay rules: a caller-minted id that already names a row is answered with that row ONLY when
// it is the caller's own line in the same building; anything else is a 409 that confirms nothing.
export const isOwnCustomerLine = (row, buildingId, clientUserId) => !!row && row.client_id === buildingId
  && row.author_role === ROLE.client && !!clientUserId && row.author_client_user_id === clientUserId;
export const isOwnStaffLine = (row, buildingId, orgUserId) => !!row && row.client_id === buildingId
  && row.author_role === ROLE.staff && !!orgUserId && row.author_user_id === orgUserId;

// One building's lines, newest `limit` before `before`, returned OLDEST FIRST, plus whether older
// ones exist. `sinceIso` is the reader's window (the hub's year, the office's retention).
export async function readThread({ clientId, sinceIso = null, before = null, limit }) {
  let q = org(db().from('client_messages').select(MESSAGE_COLUMNS)).eq('client_id', clientId);
  if (sinceIso) q = q.gte('created_at', sinceIso);
  if (before) q = q.lt('created_at', before);
  const { data } = must(await q
    .order('created_at', { ascending: false }).order('id', { ascending: false })
    .limit(limit + 1), 'thread read');
  const rows = data || [];
  return { rows: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
}

async function insertMessage(row) {
  const { data, error } = await db().from('client_messages').insert(row).select(MESSAGE_COLUMNS).single();
  if (error) {
    const err = new Error(`message insert: ${error.message || error.code}`);
    err.code = error.code || null;
    throw err;
  }
  return data;
}

// ── the thread summary (rule 5: best-effort, idempotent) ──────────────────────
// Insert the building's summary if it has none; otherwise move it forward ONLY to a newer line, and
// move the writer's side ("when a customer / the office last wrote") ONLY to a newer time. Each
// guard rides on its UPDATE, so two writers racing can never move a summary backwards.
export async function touchThread(row) {
  const at = row.created_at;
  const side = row.author_role === ROLE.client ? 'last_client_message_at' : 'last_staff_message_at';
  const last = {
    last_message_id: row.id,
    last_message_at: at,
    last_author_role: row.author_role,
    last_author_name: row.author_name ?? null,
    last_author_user_id: row.author_user_id ?? null,
    last_author_client_user_id: row.author_client_user_id ?? null,
    last_snippet: messageSnippet(row.body, HUB_THREAD_SNIPPET_MAX),
    updated_at: new Date().toISOString(),
  };
  must(await db().from('client_message_threads')
    .upsert({ organization_id: ORG, client_id: row.client_id, ...last, [side]: at }, { onConflict: 'organization_id,client_id', ignoreDuplicates: true }),
  'thread summary insert');
  must(await org(db().from('client_message_threads').update(last)).eq('client_id', row.client_id).lt('last_message_at', at),
    'thread summary move');
  must(await org(db().from('client_message_threads').update({ [side]: at })).eq('client_id', row.client_id).or(`${side}.is.null,${side}.lt.${at}`),
    'thread summary side');
}

// Retention at the write point (rule 4): this building's lines past the horizon.
async function pruneBuilding(clientId, now) {
  must(await org(db().from('client_messages').delete()).eq('client_id', clientId).lt('created_at', messageRetentionCutoffIso(now)),
    'retention prune');
}

// ── read markers ──────────────────────────────────────────────────────────────
// Move a reader's marker for one building to `at` — never backwards. Returns the marker kept.
export async function markRead({ clientId, readerKind, readerId, at }) {
  const { data } = must(await org(db().from('client_message_reads').select(READ_COLUMNS))
    .eq('client_id', clientId).eq('reader_kind', readerKind).eq('reader_id', readerId).maybeSingle(), 'read marker read');
  if (data && Date.parse(data.last_read_at) >= Date.parse(at)) return data.last_read_at;
  must(await db().from('client_message_reads').upsert(
    { organization_id: ORG, client_id: clientId, reader_kind: readerKind, reader_id: readerId, last_read_at: at },
    { onConflict: 'organization_id,client_id,reader_kind,reader_id' },
  ), 'read marker write');
  return at;
}

// One reader's markers — for the given buildings, or (the office) every building.
async function readMarkers({ readerKind, readerId, clientIds = null }) {
  const filters = (q) => {
    let x = org(q).eq('reader_kind', readerKind).eq('reader_id', readerId);
    if (clientIds) x = x.in('client_id', clientIds);
    return x;
  };
  const rows = await selectAll({
    count: async () => exactCount(must(await filters(db().from('client_message_reads').select('client_id', { count: 'exact', head: true })), 'read markers count').count),
    page: async (from, to) => must(await filters(db().from('client_message_reads').select(READ_COLUMNS))
      .order('client_id', { ascending: true }).range(from, to), 'read markers read').data || [],
    keyOf: (r) => r.client_id,
    maxRows: BOOK_MAX,
  });
  return new Map(rows.map((r) => [r.client_id, r.last_read_at]));
}

// Building summaries — for the given buildings, or (the office) every one.
async function threadSummaries({ clientIds = null } = {}) {
  const filters = (q) => (clientIds ? org(q).in('client_id', clientIds) : org(q));
  return selectAll({
    count: async () => exactCount(must(await filters(db().from('client_message_threads').select('client_id', { count: 'exact', head: true })), 'thread summaries count').count),
    page: async (from, to) => must(await filters(db().from('client_message_threads').select(THREAD_COLUMNS))
      .order('last_message_at', { ascending: false }).order('client_id', { ascending: true })
      .range(from, to), 'thread summaries read').data || [],
    keyOf: (r) => r.client_id,
    maxRows: BOOK_MAX,
  });
}

const headCount = async (q, what) => exactCount(must(await q, what).count);
const countQuery = () => org(db().from('client_messages').select('id', { count: 'exact', head: true }));
const laterOf = (a, b) => (Date.parse(a) > Date.parse(b) ? a : b);

// A customer's unread lines in one building: anyone's but their own, after their marker, inside
// the hub's year. Two plain counts (all, then their own) — no OR filter, so the query stays one a
// PostgREST stand-in can answer exactly.
async function customerUnreadCount({ clientId, clientUserId, since, now }) {
  const from = since ? laterOf(since, messageWindowStartIso(now)) : messageWindowStartIso(now);
  const [all, mine] = await Promise.all([
    headCount(countQuery().eq('client_id', clientId).gt('created_at', from), 'unread count'),
    headCount(countQuery().eq('client_id', clientId).gt('created_at', from)
      .eq('author_role', ROLE.client).eq('author_client_user_id', clientUserId), 'own count'),
  ]);
  return Math.max(0, all - mine);
}
// A staff member's unread lines in one building: the customers', after their marker.
async function staffUnreadCount({ clientId, since, now }) {
  const from = since ? laterOf(since, messageRetentionCutoffIso(now)) : messageRetentionCutoffIso(now);
  return headCount(countQuery().eq('client_id', clientId).eq('author_role', ROLE.client).gt('created_at', from), 'unread count');
}

// ── the office's bell for a customer's line: Matt's routing rule, through the CAS loop ──
// Best-effort and CAS-guarded like qc/store notifyClientReplied: it never fails the saved line.
export async function notifyCustomerMessage({ building, row, tries = 4 }) {
  try {
    const alert = customerMessageAlert({ clientId: building.id, placeName: building.name, authorName: row.author_name, body: row.body });
    for (let i = 0; i < tries; i += 1) {
      const { state, version } = await readOrgState();
      const base = { ...state, notifications: state.notifications || [] };
      const notifications = fanOutManagerOrAdmins(base, {
        clientId: building.id, eventKey: CUSTOMER_MESSAGE_EVENT, ...alert, actorUserId: null,
      });
      if (notifications === base.notifications) return { sent: false, reason: 'nobody-to-ring' };
      if (await writeOrgState({ ...state, notifications }, version)) return { sent: true };
    }
    return { sent: false, reason: 'cas-exhausted' };
  } catch (e) {
    console.error('[client-messages] office bell failed:', e?.message || e);
    return { sent: false, reason: 'error' };
  }
}

// ── the customer's side ───────────────────────────────────────────────────────
// `ctx` is the hub route's request context (clients, allowedIds, userById); `building` has already
// passed the scope gate.
const rosterName = (ctx, userId) => (userId ? ctx.userById?.get(userId)?.name || null : null);

export async function hubThread({ ctx, building, clientUser, q = {}, now = Date.now() }) {
  const { rows, hasMore } = await readThread({
    clientId: building.id, sinceIso: messageWindowStartIso(now), before: messageCursor(q.before), limit: messagePageLimit(q.limit),
  });
  const manager = resolveAccountSupervisor({ clients: ctx.clients, users: [...(ctx.userById?.values() || [])] }, building.id);
  return {
    messages: rows.map((r) => projectHubBuildingMessage(r, {
      viewerClientUserId: clientUser.id,
      staffName: r.author_role === ROLE.staff ? rosterName(ctx, r.author_user_id) : null,
    })),
    hasMore,
    manager: projectHubMessageManager(manager),
  };
}

export function projectForCustomer(ctx, row, clientUser) {
  return projectHubBuildingMessage(row, {
    viewerClientUserId: clientUser.id,
    staffName: row.author_role === ROLE.staff ? rosterName(ctx, row.author_user_id) : null,
  });
}

// A customer's line: insert, then the best-effort tail (rule 5). Returns { row } for a fresh
// line or { replay } when a concurrent request with the same id won the insert.
export async function postCustomerMessage({ id, building, clientUser, body, now = Date.now() }) {
  let row;
  try {
    row = await insertMessage({
      id,
      organization_id: ORG,
      client_id: building.id,
      author_role: ROLE.client,
      author_client_user_id: clientUser.id,
      author_user_id: null,
      author_name: clientUser.name || null,
      body,
      created_at: new Date(now).toISOString(),
    });
  } catch (e) {
    if (e?.code === '23505') {
      const winner = await messageById(id);
      if (winner) return { replay: winner };
    }
    throw e;
  }
  await quietly('thread summary', () => touchThread(row));
  await quietly('retention prune', () => pruneBuilding(building.id, now));
  await logActivity({
    action: 'customer_message.received',
    summary: `Customer message from ${clientUser.name || 'a customer contact'} in the ${building.name || 'building'} thread`,
    entityId: row.id,
    clientId: building.id,
    clientName: building.name || null,
    actorUserId: null,
    actorRole: 'client',
    actorName: clientUser.name || null,
  });
  await notifyCustomerMessage({ building, row });
  return { row };
}

// A customer's TEXT (api/_lib/sms/inbound.js, after Twilio's signature was checked and the
// building matched): a customer line with no hub login behind it, marked as a text from `phone`
// (E.164), under the contact's name when one is known. The same tail as a hub line: the summary
// (so the thread waits on the office), the prune, the activity log and the office's bell. `id` is
// minted from Twilio's MessageSid by the caller, so the same text posted twice is one line.
// Returns { row } or { replay }.
export async function postTextMessage({ id, building, phone, name = null, body, now = Date.now() }) {
  const number = toE164(typeof phone === 'string' ? phone : '');
  if (!number) throw new Error('text line: the number is not one');
  let row;
  try {
    row = await insertMessage({
      id,
      organization_id: ORG,
      client_id: building.id,
      author_role: ROLE.client,
      author_client_user_id: null,
      author_user_id: null,
      author_name: name || null,
      body,
      via: TEXT_VIA,
      phone: number,
      created_at: new Date(now).toISOString(),
    });
  } catch (e) {
    if (e?.code === '23505') {
      const winner = await messageById(id);
      if (winner) return { replay: winner };
    }
    throw e;
  }
  await quietly('thread summary', () => touchThread(row));
  await quietly('retention prune', () => pruneBuilding(building.id, now));
  await logActivity({
    action: 'customer_message.received',
    summary: `Text from ${name || displayPhone(number)} in the ${building.name || 'building'} thread`,
    entityId: row.id,
    clientId: building.id,
    clientName: building.name || null,
    actorUserId: null,
    actorRole: 'client',
    actorName: name || displayPhone(number),
  });
  await notifyCustomerMessage({ building, row: { ...row, author_name: name || displayPhone(number) } });
  return { row };
}

export const healThread = (row) => quietly('thread summary (replay)', () => touchThread(row));

// The bell (`GET /api/hub/updates`): the viewer's own requests' staff replies and stage changes,
// the office's lines, new inspection reports, and a cleaner's On my way (Crew on the way: the
// activity log's row for the clean, lib/crewOnTheWay.js), across the buildings in scope; 30 days, ≤20.
export async function hubUpdates({ ctx, clientUser, now = Date.now() }) {
  const seenAt = clientUser.updates_seen_at || null;
  const ids = [...ctx.allowedIds].sort();
  if (!ids.length) return { ...finishHubUpdates([], { seenAt }), seenAt, messagesUnread: [] };
  const since = updatesSinceIso(now);
  const buildingName = (id) => ctx.clients.find((c) => c.id === id)?.name || '';

  const [tickets, staffLines, inspections, onTheWay, summaries, markers] = await Promise.all([
    // The viewer's OWN recent requests (HUB-11's audience for a request's news), in scope.
    (async () => must(await org(db().from('problem_reports').select(UPDATE_TICKET_COLUMNS))
      .eq('origin', PORTAL).eq('raised_by_client_user_id', clientUser.id).in('client_id', ids)
      .gte('created_at', messageWindowStartIso(now))
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(HUB_UPDATES_TICKET_SCAN), 'update tickets read').data || [])(),
    (async () => must(await org(db().from('client_messages').select(MESSAGE_COLUMNS))
      .in('client_id', ids).eq('author_role', ROLE.staff).gte('created_at', since)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(HUB_UPDATES_MAX), 'update lines read').data || [])(),
    (async () => must(await org(db().from('inspection_records').select(UPDATE_INSPECTION_COLUMNS))
      .in('client_id', ids).eq('status', 'submitted').gte('performed_at', since)
      .order('performed_at', { ascending: false }).order('id', { ascending: false })
      .limit(HUB_UPDATES_MAX), 'update inspections read').data || [])(),
    // Every login on the building is told the crew is on the way (not only the one who asked).
    (async () => must(await org(db().from('activity_log').select(UPDATE_ON_THE_WAY_COLUMNS))
      .eq('action', ON_THE_WAY_ACTION).in('client_id', ids).gte('occurred_at', since)
      .order('occurred_at', { ascending: false }).order('id', { ascending: false })
      .limit(HUB_UPDATES_MAX), 'update on-the-way read').data || [])(),
    threadSummaries({ clientIds: ids }),
    readMarkers({ readerKind: READER.client, readerId: clientUser.id, clientIds: ids }),
  ]);

  const ticketById = new Map(tickets.map((t) => [t.id, t]));
  const ticketIds = [...ticketById.keys()];
  const [replies, stages] = ticketIds.length ? await Promise.all([
    // 🔴 A staff reply only: `internal = false` IN THE QUERY (WO-9), and never the customer's own.
    (async () => must(await org(db().from('work_order_messages').select(UPDATE_REPLY_COLUMNS))
      .in('problem_id', ticketIds).eq('internal', false).neq('author_role', 'client').gte('created_at', since)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .limit(HUB_UPDATES_MAX), 'update replies read').data || [])(),
    (async () => must(await org(db().from('activity_log').select(UPDATE_STAGE_COLUMNS))
      .eq('action', 'ticket.status_changed').in('entity_id', ticketIds).gte('occurred_at', since)
      .order('occurred_at', { ascending: false }).order('id', { ascending: false })
      .limit(HUB_UPDATES_MAX * 2), 'update stages read').data || [])(),
  ]) : [[], []];

  const items = [];
  for (const r of replies) {
    const t = ticketById.get(r.problem_id);
    if (t) items.push(hubUpdate('reply', { buildingId: t.client_id, buildingName: buildingName(t.client_id), at: r.created_at, authorName: r.author_name, title: t.title, ticketId: t.id }));
  }
  // The customer's own reopen is not news to them.
  for (const a of stages.filter((x) => x.actor_role !== 'client')) {
    const t = ticketById.get(a.entity_id);
    if (t && a.after?.status) items.push(hubUpdate('stage', { buildingId: t.client_id, buildingName: buildingName(t.client_id), at: a.occurred_at, status: a.after.status, title: t.title, ticketId: t.id }));
  }
  for (const m of staffLines) {
    items.push(hubUpdate('message', { buildingId: m.client_id, buildingName: buildingName(m.client_id), at: m.created_at, authorName: rosterName(ctx, m.author_user_id) || m.author_name, body: m.body }));
  }
  for (const w of onTheWay) {
    items.push(hubUpdate(ON_THE_WAY_KIND, { buildingId: w.client_id, buildingName: buildingName(w.client_id), at: w.occurred_at, eta: w.after?.eta || null, tz: ctx.tz }));
  }
  for (const i of inspections) {
    items.push(hubUpdate('inspection', { buildingId: i.client_id, buildingName: buildingName(i.client_id), at: i.performed_at, name: i.template_name, result: i.result, score: Number.isFinite(i.overall_score) ? i.overall_score : null, inspectionId: i.id }));
  }

  // The Messages badges: exact counts for the buildings whose summary says something is newer
  // than the viewer's marker (bounded), never one count per building in scope.
  const candidates = summaries.filter((s) => customerThreadMaybeUnread(s, markers.get(s.client_id) || null))
    .map((s) => s.client_id).sort().slice(0, HUB_UNREAD_COUNT_MAX);
  const counts = await Promise.all(candidates.map(async (clientId) => ({
    buildingId: clientId,
    count: await customerUnreadCount({ clientId, clientUserId: clientUser.id, since: markers.get(clientId) || null, now }),
  })));

  return { ...finishHubUpdates(items, { seenAt }), seenAt, messagesUnread: counts.filter((c) => c.count > 0) };
}

export async function stampUpdatesSeen(clientUser, now = Date.now()) {
  const at = new Date(now).toISOString();
  must(await org(db().from('client_users').update({ updates_seen_at: at })).eq('id', clientUser.id), 'updates seen');
  return at;
}

// The customer's own email switches, merged with a CAS on the row's `updated_at` so two quick
// toggles in two tabs both land. The row is ALWAYS the caller's (the id from the claim).
export async function saveEmailPrefs(clientUser, patch, tries = 3) {
  let row = clientUser;
  for (let i = 0; i < tries; i += 1) {
    const next = mergeHubEmailPrefs(row.email_prefs, patch);
    let q = org(db().from('client_users').update({ email_prefs: next, updated_at: new Date().toISOString() })).eq('id', clientUser.id);
    q = row.updated_at ? q.eq('updated_at', row.updated_at) : q.is('updated_at', null);
    const { data } = must(await q.select('id,email_prefs,updated_at'), 'email prefs write');
    if (data && data.length) return resolveHubEmailPrefs(data[0].email_prefs);
    const fresh = must(await org(db().from('client_users').select('id,email_prefs,updated_at')).eq('id', clientUser.id).maybeSingle(), 'email prefs re-read').data;
    if (!fresh) throw new Error('email prefs: the login row is gone');
    row = fresh;
  }
  throw new Error('email prefs: the row kept changing underneath the save');
}

// ── the office's side ─────────────────────────────────────────────────────────
// `book` is the shared record's { clients, users } projection the office route read once.
export async function officeThreads({ book, viewerUserId, q = {}, now = Date.now() }) {
  const [summaries, markers] = await Promise.all([
    threadSummaries(),
    readMarkers({ readerKind: READER.staff, readerId: viewerUserId }),
  ]);
  const rows = sortOfficeThreads(filterOfficeThreads(
    officeThreadRows({ summaries, clients: book.clients, users: book.users, readAtByClient: markers }),
    { filter: q.filter === 'mine' ? 'mine' : 'all', viewerUserId, managerId: q.managerId || null, clientId: q.clientId || null },
  ));
  const { offset, limit } = officeThreadPage(q);
  const page = rows.slice(offset, offset + limit);
  await Promise.all(page.filter((r) => r.unread).map(async (r) => {
    r.unreadCount = await staffUnreadCount({ clientId: r.clientId, since: markers.get(r.clientId) || null, now });
  }));
  return {
    threads: page.map(projectOfficeThread),
    total: rows.length,
    offset,
    limit,
    unreadThreads: rows.filter((r) => r.unread).length,
  };
}

// EVERY thread waiting for the office's reply (a customer wrote last): Messaging → Customers'
// Waiting view, the manager Home's Customer messages count and the Messages row's pill (HUB-24 (c):
// a waiting message is NOT a client request). COMPLETE: the summaries are read whole (selectAll),
// never a page, and each waiting thread's wait start is one narrow indexed read (the first customer
// line after the office's last), a few at a time. Waiting threads are a working set, not the book.
// Narrowed by the Manager / Customer filters exactly as the thread list is. An ARCHIVED customer's
// thread waits on nobody (CS-663): its logins have lost the hub and the office cannot reply into it,
// so it stays in the thread list as history and never in this view, its count or the pill.
const WAITING_CONCURRENCY = 6;
async function firstUnansweredLineAt(clientId, afterIso) {
  const { data } = must(await org(db().from('client_messages').select('id,created_at')).eq('client_id', clientId)
    .eq('author_role', ROLE.client).gt('created_at', afterIso)
    .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(1), 'first unanswered line');
  return (data && data[0] && data[0].created_at) || null;
}
// Since when one thread has waited (lib/hubMessages waitingSinceFrom), from its summary: null when
// the office wrote last, else the first customer line after the office's last one — never a line
// past retention (waitFloorIso) — read in one narrow query.
async function waitingSinceOf(summary, now) {
  if (!threadAwaitingReply(summary)) return null;
  return waitingSinceFrom(summary, await firstUnansweredLineAt(summary.client_id, waitFloorIso(summary.last_staff_message_at, now)));
}
// One building's summary, or null when nobody has written there yet.
async function threadSummaryOf(clientId) {
  const { data } = must(await org(db().from('client_message_threads').select(THREAD_COLUMNS)).eq('client_id', clientId).maybeSingle(), 'thread summary read');
  return data || null;
}
export async function officeWaitingThreads({ book, q = {}, now = Date.now() }) {
  const summaries = (await threadSummaries()).filter(threadAwaitingReply);
  const byClient = new Map(summaries.map((s) => [s.client_id, s]));
  const rows = filterOfficeThreads(
    officeThreadRows({ summaries, clients: (book.clients || []).filter((c) => !isArchivedCustomer(c)), users: book.users }),
    { filter: 'all', managerId: q.managerId || null, clientId: q.clientId || null },
  );
  for (let i = 0; i < rows.length; i += WAITING_CONCURRENCY) {
    await Promise.all(rows.slice(i, i + WAITING_CONCURRENCY).map(async (r) => {
      r.waitingSince = await waitingSinceOf(byClient.get(r.clientId), now);
    }));
  }
  const sorted = sortWaitingThreads(rows);
  return { threads: sorted.map(projectOfficeWaitingThread), total: sorted.length };
}

// ── texts: where the office's answer goes, and how it went ────────────────────
// A building's newest CUSTOMER line (a hub line or a text), or null.
export async function newestCustomerLine(clientId) {
  const { data } = must(await org(db().from('client_messages').select(MESSAGE_COLUMNS)).eq('client_id', clientId)
    .eq('author_role', ROLE.client).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1), 'newest customer line');
  return (data && data[0]) || null;
}
// The number the office's next answer in this building will be texted to — the newest customer
// line's, when it came by text — and since when that number has had texts off (it said STOP), or
// null. An archived customer's thread takes no reply, so it names none.
export async function textBackTarget(client) {
  if (!client || isArchivedCustomer(client)) return null;
  const last = await newestCustomerLine(client.id);
  if (!last || last.via !== TEXT_VIA || !last.phone) return null;
  const stopped = await readOptOut(last.phone);
  return { phone: last.phone, optedOutAt: stopped?.opted_out_at || null };
}
// How each of these office lines' text-back went (Map line id -> { status, to }); a line never
// texted is absent. Best-effort: an unreadable sent log shows no status, never fails the thread.
export async function officeLineTexts(lineIds = []) {
  const ids = lineIds.filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await quietly('text-back statuses', () => readMessages(ids.map(officeReplyLogId)));
  const out = new Map();
  for (const id of ids) {
    const t = textBackOf(rows?.get(officeReplyLogId(id)));
    if (t) out.set(id, t);
  }
  return out;
}
// One office line's text-back: claimed in the sent log (`office_reply:<line id>`, so a retried
// reply texts once), sent through the one customer-message send step (the STOP line; a number that
// said STOP and a sample customer are refused there), and recorded. → { status, to } or null when
// the thread's newest customer line did not come by text. Never throws.
const MS_PER_YEAR = 365.25 * 864e5;
async function textBack({ client, row, now }) {
  const last = await newestCustomerLine(client.id);
  if (!last || last.via !== TEXT_VIA || !last.phone) return null;
  const to = last.phone;
  const logId = officeReplyLogId(row.id);
  const won = await insertNew([{
    id: logId, templateKey: OFFICE_REPLY_TEMPLATE, channel: 'sms', clientId: client.id, recipient: to,
    status: MESSAGE_STATUS.sending, attempts: 1, keepUntil: new Date(now + HUB_MESSAGE_RETENTION_YEARS * MS_PER_YEAR).toISOString(),
  }]);
  if (!won.has(logId)) return textBackOf((await readMessages([logId])).get(logId)) || null;
  const res = await sendCustomerMessage({ templateKey: OFFICE_REPLY_TEMPLATE, channel: 'sms', to, body: row.body, refs: { clientId: client.id } });
  let outcome;
  if (res.ok) outcome = { status: MESSAGE_STATUS.sent, providerMessageId: res.id || null };
  else if (res.optedOut) outcome = { status: MESSAGE_STATUS.refused, failureReason: OPTED_OUT_REASON };
  else if (res.refused) outcome = { status: MESSAGE_STATUS.refused, failureReason: SAMPLE_RECORD_REASON };
  else if (res.skipped === 'sms_unconfigured') outcome = { status: MESSAGE_STATUS.skipped, failureReason: NOT_SET_UP_REASON };
  else outcome = { status: MESSAGE_STATUS.failed, failureReason: res.error || res.skipped || 'Text send failed' };
  await quietly('text-back record', () => finishMessage(logId, outcome));
  return textBackOf({ status: outcome.status, failure_reason: outcome.failureReason || null, recipient: to });
}

// One building's thread for the office: its newest lines, the viewer's read marker, and since when
// it has waited for the office's reply (`waitingSince`, null when it is not waiting) — what the
// thread's header says in Messaging → Customers and on the customer page's Messages tab. Texts:
// each office line says how its text-back went (`text`), and `textBack` names the number the next
// answer will be texted to (and whether that number has texts off).
export async function officeThread({ book, client, viewerUserId, q = {}, now = Date.now() }) {
  const userById = new Map((book.users || []).filter((u) => u && u.id).map((u) => [u.id, u]));
  const [{ rows, hasMore }, markers, summary] = await Promise.all([
    readThread({ clientId: client.id, sinceIso: messageRetentionCutoffIso(now), before: messageCursor(q.before), limit: messagePageLimit(q.limit) }),
    readMarkers({ readerKind: READER.staff, readerId: viewerUserId, clientIds: [client.id] }),
    threadSummaryOf(client.id),
  ]);
  const manager = client.supervisorId ? userById.get(client.supervisorId) || null : null;
  const [texts, textTarget] = await Promise.all([
    officeLineTexts(rows.filter((r) => r.author_role === ROLE.staff).map((r) => r.id)),
    quietly('text-back target', () => textBackTarget(client)),
  ]);
  return {
    // `archived` (CS-663): the thread is history — the screen says so and offers no reply.
    client: { id: client.id, name: client.name || '', archived: isArchivedCustomer(client) },
    manager: manager ? { id: manager.id, name: manager.name || '' } : null,
    messages: rows.map((r) => projectOfficeMessage(r, {
      viewerUserId,
      staffName: r.author_role === ROLE.staff ? userById.get(r.author_user_id)?.name || null : null,
      text: texts.get(r.id) || null,
    })),
    hasMore,
    readAt: markers.get(client.id) || null,
    textBack: textTarget || null,
    // An archived customer's thread waits on nobody (CS-663): no reply can go, so no wait is told.
    waitingSince: isArchivedCustomer(client) ? null : await waitingSinceOf(summary, now),
  };
}

export const projectForOffice = (book, row, viewerUserId, text = null) => projectOfficeMessage(row, {
  viewerUserId,
  staffName: row.author_role === ROLE.staff ? (book.users || []).find((u) => u && u.id === row.author_user_id)?.name || null : null,
  text,
});

// The office's reply: insert (author from the claim), then the best-effort tail — the summary,
// the prune, the sender's own read marker, the activity log, the text-back (when the thread's
// newest customer line came by text) and the customers' emails. → { row, text } or { replay }.
export async function postStaffMessage({ id, client, authority, staffName, body, now = Date.now() }) {
  let row;
  try {
    row = await insertMessage({
      id,
      organization_id: ORG,
      client_id: client.id,
      author_role: ROLE.staff,
      author_client_user_id: null,
      author_user_id: authority.orgUserId,
      author_name: staffName || null,
      body,
      created_at: new Date(now).toISOString(),
    });
  } catch (e) {
    if (e?.code === '23505') {
      const winner = await messageById(id);
      if (winner) return { replay: winner };
    }
    throw e;
  }
  await quietly('thread summary', () => touchThread(row));
  await quietly('retention prune', () => pruneBuilding(client.id, now));
  await quietly('sender read marker', () => markRead({ clientId: client.id, readerKind: READER.staff, readerId: authority.orgUserId, at: row.created_at }));
  await logActivity({
    action: 'customer_message.replied',
    summary: `Replied in the ${client.name || 'building'} thread`,
    entityId: row.id,
    clientId: client.id,
    clientName: client.name || null,
    actorUserId: authority.orgUserId,
    actorRole: authority.role || null,
    actorName: staffName || null,
  });
  const text = await quietly('text back', () => textBack({ client, row, now }));
  await emailMessageReplied({ clientId: client.id, clientName: client.name || '', message: row });
  return { row, text: text || null };
}
