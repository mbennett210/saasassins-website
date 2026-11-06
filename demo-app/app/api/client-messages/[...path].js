// CUSTOMER MESSAGES — the OFFICE's side (client hub redesign, plan §3.4; D5: Messaging → Customers
// and the customer page's Messages tab).
//
//   GET  /api/client-messages/threads?filter=mine|all[&managerId&clientId&offset&limit]   (managerId=team: the caller's team, S131)
//        -> { threads[], total, offset, limit, unreadThreads }   one row per building with messages,
//           UNREAD FIRST (a customer wrote after the caller's marker), then the newest
//   GET  /api/client-messages/threads?waiting=1[&managerId&clientId]
//        -> { threads[] (+ waitingSince), total }   EVERY thread whose customer wrote last, the
//           longest wait first — complete: Messaging → Customers' Waiting view, the manager Home's
//           Customer messages count and the Messages pill (a waiting message is not a client
//           request: HUB-24 (c), Matt 2026-10-12)
//   GET  /api/client-messages/thread?clientId[&before&limit]
//        -> { client, manager, messages[], hasMore, readAt, waitingSince, textBack }   full staff
//           names (the office's view); `waitingSince` = since when it has waited for the office's
//           reply, or null; a customer's TEXTED line carries `via` 'sms' and its `phone`, an office
//           line `text` (how its text-back went, or null); `textBack` = { phone, optedOutAt } when
//           the newest customer line came by text (the next reply is texted there), else null
//   POST /api/client-messages/send  { id, clientId, body }  -> { message }   (`message.text`: the
//           reply was also texted, or why not, when the newest customer line came by text)
//   POST /api/client-messages/read  { clientId, at? }       -> { readAt }
//   GET  /api/client-messages/text-status?clientId
//        -> { optOuts: [{ phone, optedOutAt, source }] }   which of THIS customer's numbers (its
//           contacts' and its own) have texts off — replied STOP — and since when (the customer
//           page's read-only "Texts off" note; Daniel, 2026-10-28: "Yes, add the Reply STOP
//           functionality."). Never another building's numbers.
//
// AUTH STANCE: `requirePermission` on every branch — `hub.messages.view` to read and to mark read,
// `hub.messages.reply` to send, `contacts.view` for a customer's numbers' text status (the key the
// customer page's contacts gate on) — the same keys the screens gate on, read from the committed
// matrix.
// Owner / admin / manager by default; crew never. A CUSTOMER login is refused before any key is
// consulted (requireAuthority refuses role 'client': the isolation rule, api/_lib/authz.js), so a
// customer reaches their building's thread through /api/hub/* alone. An unknown branch still
// authenticates first (as `view`), so it is a 401/403 to the wrong caller and a 404 only to an
// office user.
//
// 🔴 THE AUTHOR IS THE VERIFIED CLAIM: a reply is stamped with the caller's `orgUserId` and the
// roster's name for it — never a body field. The building must be one in the live customer book.
// An ARCHIVED customer's thread stays readable (its history) but takes no reply — its hub logins
// have lost access, so nobody could read it (409 `building-archived`) — and it no longer waits
// on the office (out of the Waiting view, its count and the pill). CS-663.
// Ids are caller-minted and read back first (THE LAW II.7). Errors are a sentence and a code; the
// provider's words go to the server log only (CS-077 class). Cache-Control: private, no-store.
import { randomUUID } from 'node:crypto';
import { requirePermission } from '../_lib/authz.js';
import { withRequestCache } from '../_lib/requestCache.js';
import { readProtectedSlices } from '../_lib/orgState.js';
import { hit } from '../_lib/rateLimit.js';
import * as store from '../_lib/clientHub/messages.js';
import { hubMessageBodyInput, readMarkerAt, OFFICE_MESSAGE_RATE } from '../../src/lib/hubMessages.js';
import { isArchivedCustomer } from '../../src/lib/customerStatus.js';
import { TEAM, teamMemberIds, teamLeadFor } from '../../src/lib/teamScope.js';
import { readOptOuts } from '../_lib/sms/optOuts.js';
import { toE164 } from '../../src/lib/alertDelivery.js';

const VIEW = 'hub.messages.view';
const REPLY = 'hub.messages.reply';
const GATES = Object.freeze({
  'GET threads': VIEW,
  'GET thread': VIEW,
  'POST send': REPLY,
  'POST read': VIEW,
  'GET text-status': 'contacts.view',
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
// A customer or staff id from the shared record: one safe token, never raw text for PostgREST.
const isRecordId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

const SENTENCES = {
  'not-found': "We couldn't find that customer. It may have been removed.",
  'read-failed': "The messages couldn't be loaded just now. Try again in a moment.",
  'save-failed': "That couldn't be saved just now. Try again in a moment.",
  'message-id': 'This message could not be sent. Refresh the page and try again.',
  'bad-filter': 'That filter is not one this list understands.',
  'no-identity': 'Your login is not linked to a team member, so it cannot read or send customer messages.',
  'too-many-requests': "That's a lot of messages in a short time. Wait a moment and try again.",
  'building-archived': 'This customer is archived, so its hub logins can no longer read messages. Restore the customer to write to them.',
};
function fail(res, status, code, sentence) {
  return res.status(status).json({ error: sentence || SENTENCES[code] || 'Something went wrong. Try again.', code });
}

export default function handler(req, res) {
  return withRequestCache(() => clientMessagesHandler(req, res));
}

async function clientMessagesHandler(req, res) {
  const path = (typeof req.query.subpath === 'string' && req.query.subpath)
    ? req.query.subpath.split('/').filter(Boolean)
    : Array.isArray(req.query.path) ? req.query.path
      : (req.query.path ? String(req.query.path).split('/').filter(Boolean) : []);
  const [action] = path;
  const key = `${req.method} ${action}`;
  const gate = GATES[key] || VIEW;

  const a = await requirePermission(req, res, gate);
  if (!a) return undefined; // 401 / 403 already written
  res.setHeader('Cache-Control', 'private, no-store');
  if (!GATES[key]) return fail(res, 404, 'not-found', 'Unknown route.');
  // Unread state and authorship are per PERSON; a login the roster cannot name holds neither.
  if (!a.orgUserId) return fail(res, 403, 'no-identity');

  const q = req.query || {};
  const body = req.body || {};
  const now = Date.now();
  try {
    // The customer book and the roster: which buildings exist, who manages them, staff names.
    const slices = await readProtectedSlices(key === 'GET text-status'
      ? 'clients:state->clients,contacts:state->contacts'
      : 'clients:state->clients,users:state->users');
    const book = {
      clients: Array.isArray(slices?.clients) ? slices.clients.filter((c) => c && c.id) : [],
      users: Array.isArray(slices?.users) ? slices.users.filter((u) => u && u.id) : [],
    };
    const clientOf = (id) => (isRecordId(id) ? book.clients.find((c) => c.id === id) || null : null);

    if (key === 'GET text-status') {
      const client = clientOf(q.clientId);
      if (!client) return fail(res, 404, 'not-found');
      // This building's numbers only: its contacts' and its own (the numbers its texts go to).
      const contacts = Array.isArray(slices?.contacts) ? slices.contacts.filter((c) => c && c.companyId === client.id) : [];
      const numbers = [...new Set([client.phone, ...contacts.map((c) => c.phone)]
        .map((p) => toE164(typeof p === 'string' ? p : '')).filter(Boolean))];
      const off = numbers.length ? await readOptOuts(numbers) : new Map();
      return res.status(200).json({
        optOuts: [...off.values()].map((r) => ({ phone: r.phone, optedOutAt: r.opted_out_at, source: r.source })),
      });
    }

    if (key === 'GET threads') {
      if ((q.filter && !['mine', 'all'].includes(q.filter))
        || (q.managerId && !isRecordId(q.managerId)) || (q.clientId && !isRecordId(q.clientId))
        || (q.om && !isRecordId(q.om))) {
        return fail(res, 400, 'bad-filter');
      }
      // `managerId=team` (S131) is the CALLER's team — an Operations Manager's managers, resolved
      // from the claim and the committed roster (lib/teamScope); for anyone else, themselves. An owner
      // or an admin, who reads every building, may name WHOSE with `om` (an active Operations
      // Manager: the owner's Operations view's tiles); a manager never widens theirs that way
      // (teamLeadFor, the one rule). Every other managerId filters as before.
      const scoped = q.managerId === TEAM
        ? { ...q, managerId: teamMemberIds(book.users, teamLeadFor({ role: a.role, selfId: a.orgUserId, users: book.users, om: q.om })) }
        : q;
      // Every thread WAITING for the office's reply, each with its wait's start — the waiting
      // messages' own view and count (HUB-24 (c)). Complete, not paged.
      if (q.waiting === '1' || q.waiting === 'true') return res.status(200).json(await store.officeWaitingThreads({ book, q: scoped, now }));
      return res.status(200).json(await store.officeThreads({ book, viewerUserId: a.orgUserId, q: scoped, now }));
    }

    if (key === 'GET thread') {
      const client = clientOf(q.clientId);
      if (!client) return fail(res, 404, 'not-found');
      return res.status(200).json(await store.officeThread({ book, client, viewerUserId: a.orgUserId, q, now }));
    }

    if (key === 'POST read') {
      const client = clientOf(body.clientId);
      if (!client) return fail(res, 404, 'not-found');
      const readAt = await store.markRead({ clientId: client.id, readerKind: 'staff', readerId: a.orgUserId, at: readMarkerAt(body.at, now) });
      return res.status(200).json({ readAt });
    }

    // POST send
    const client = clientOf(body.clientId);
    if (!client) return fail(res, 404, 'not-found');
    const input = hubMessageBodyInput(body);
    if (input.refused) return fail(res, 400, input.code, input.refused);
    if (body.id != null && !isUuid(body.id)) return fail(res, 400, 'message-id');
    const id = body.id || randomUUID();
    // A replay answers how the line's text-back went (read from the sent log), never a new send.
    const replay = async (row) => (store.isOwnStaffLine(row, client.id, a.orgUserId)
      ? res.status(200).json({ message: store.projectForOffice(book, row, a.orgUserId, (await store.officeLineTexts([row.id])).get(row.id) || null) })
      : fail(res, 409, 'message-id'));
    const existing = await store.messageById(id);
    if (existing) {
      if (store.isOwnStaffLine(existing, client.id, a.orgUserId)) await store.healThread(existing);
      return replay(existing);
    }
    // A retry of a line that already landed replays above; a NEW line to an archived customer is
    // refused before anything is written (CS-663).
    if (isArchivedCustomer(client)) return fail(res, 409, 'building-archived');
    const limit = hit(`client-messages:send:${a.orgUserId}`, OFFICE_MESSAGE_RATE);
    if (!limit.ok) {
      res.setHeader('Retry-After', String(Math.ceil((limit.retryAfterMs || 0) / 1000)));
      return fail(res, 429, 'too-many-requests');
    }
    const staffName = book.users.find((u) => u.id === a.orgUserId)?.name || null;
    const out = await store.postStaffMessage({ id, client, authority: a, staffName, body: input.value.body, now });
    if (out.replay) return replay(out.replay);
    return res.status(200).json({ message: store.projectForOffice(book, out.row, a.orgUserId, out.text || null) });
  } catch (e) {
    console.error(`[api/client-messages] ${action} failed:`, e?.name || '', e?.code || '', e?.message || e);
    if (res.headersSent) return undefined;
    return req.method === 'GET' ? fail(res, 503, 'read-failed') : fail(res, 500, 'save-failed');
  }
}
