// CS-002 — the CREW WRITE MERGE.
//
// A crew session holds only a PROJECTION of the blob (see crewView.js), so its full-blob
// save would ERASE every slice the projection omitted. So for a crew caller the server does
// NOT commit the posted document: it MERGES only allowlisted changes from the posted
// (projected) blob into the full committed blob. Omission is never deletion.
//
// mergeCrewChanges compares `posted` against projectCrewView(full, …) — the view the caller
// was served at that version — and applies to a copy of `full` ONLY:
//   a. users[caller]: name / phone / notificationPrefs / signaturePrefs (mandatory-notification
//      policy re-applied server-side); never pay / hr / role / status / another member's row.
//   b. notifications with userId === caller: read-state (unread→read) and removals. Rows for
//      OTHER users are dropped; recipients' rows for newly-merged messages / key custody are
//      DERIVED server-side with the SAME fan-out helpers the reducer uses.
//   c. conversations the caller can see: new messages authored by the caller (author + sentAt
//      server-stamped), the caller's own read-state, delivery-status on the caller's own
//      messages, and new internal/dm conversations the caller is in. Deletes, renames,
//      star/mute and edits to others' messages are dropped.
//   d. clientActivities: new rows by the caller on in-scope accounts + text edits to the
//      caller's own rows; the client's `notes` string on an in-scope account (APPEND_CLIENT_NOTE).
//   e. keys in scope: only the CHECKOUT/CHECKIN fields (status / heldBy…), never masterCode;
//      keyEvents appended by the caller for visible keys.
//   f. Omission is never deletion: any record or slice absent from the projection stays exactly
//      as in `full` (the merge starts from a copy of `full` and never spreads `posted`).
//   g. Every other difference is DROPPED — listed in `dropped`, NOT a 403, so a harmless client
//      normalization can't wedge a crew save behind a refusal.
//
// Returns { next, dropped:[{slice,id,reason}], newMessages:[{msg,conv}], pushWorthy }.
import { jsonEq } from './jsonEq.js';
import { applyMandatoryNotificationPolicy } from '../../src/lib/roles.js';
import { fanOutMessageNotifications, fanOutKeyNotification } from '../../src/lib/notifications.js';
import { projectCrewView } from './crewView.js';

const arr = (x) => (Array.isArray(x) ? x : []);
const byId = (list) => {
  const m = new Map();
  for (const x of arr(list)) if (x && x.id != null) m.set(x.id, x);
  return m;
};

// A crew-posted message timestamp, sanity-checked: a plausible ISO time within a small window
// of `now` is kept; anything missing, unparseable, far-future or long-past is stamped `now`.
function safeSentAt(v, now) {
  const t = Date.parse(v);
  if (!Number.isFinite(t) || t > now + 5 * 60 * 1000 || t < now - 2 * 24 * 60 * 60 * 1000) {
    return new Date(now).toISOString();
  }
  return new Date(t).toISOString();
}

export function mergeCrewChanges({ full, posted, userId, scope, now = Date.now() }) {
  const dropped = [];
  const drop = (slice, id, reason) => dropped.push({ slice, id: id ?? null, reason });
  const f = full && typeof full === 'object' ? full : {};
  const p = posted && typeof posted === 'object' ? posted : {};
  const clientIds = new Set(Array.isArray(scope?.clientIds) ? scope.clientIds : []);

  const served = projectCrewView(f, { userId, scope });
  const next = { ...f };
  const newMessages = [];   // { msg, conv } for server-side fan-out + push flush
  const keyCustody = [];    // { key, holderUserId } for server-side keyCustody fan-out

  // ── a. the caller's OWN profile (users[caller]) ──────────────────────────────
  {
    const fullUsers = arr(f.users);
    const postedSelf = byId(p.users).get(userId) || null;
    const servedSelf = byId(served.users).get(userId) || null;
    let prefsPatch = null;
    const patch = {};
    if (postedSelf && servedSelf) {
      if (!jsonEq(postedSelf.name ?? null, servedSelf.name ?? null)) patch.name = postedSelf.name ?? null;
      if (!jsonEq(postedSelf.phone ?? null, servedSelf.phone ?? null)) patch.phone = postedSelf.phone ?? null;
      if (!jsonEq(postedSelf.signaturePrefs ?? null, servedSelf.signaturePrefs ?? null)) patch.signaturePrefs = postedSelf.signaturePrefs ?? null;
      if (!jsonEq(postedSelf.notificationPrefs ?? null, servedSelf.notificationPrefs ?? null)) {
        const fullSelf = fullUsers.find((u) => u && u.id === userId) || null;
        // Re-apply the mandatory-notification policy SERVER-SIDE (reducer.js does it client-only):
        // a crew member can never mute a mandatory alert by posting a crafted prefs object.
        const allowed = applyMandatoryNotificationPolicy(fullSelf, postedSelf.notificationPrefs || {});
        prefsPatch = { ...((fullSelf && fullSelf.notificationPrefs) || {}), ...allowed };
      }
    }
    if (Object.keys(patch).length || prefsPatch) {
      next.users = fullUsers.map((u) => {
        if (!u || u.id !== userId) return u;
        const merged = { ...u, ...patch };
        if (prefsPatch) merged.notificationPrefs = prefsPatch;
        return merged;
      });
    }
    // A change to ANOTHER user's row is foreign — dropped (next keeps full's row).
    const servedById = byId(served.users);
    for (const [id, pr] of byId(p.users)) {
      if (id === userId) continue;
      const sr = servedById.get(id);
      if (!sr || !jsonEq(pr, sr)) drop('users', id, 'foreign-profile-edit');
    }
  }

  // ── b. notifications (the caller's own rows) ─────────────────────────────────
  {
    const fullNotifs = arr(f.notifications);
    const postedSelf = byId(arr(p.notifications).filter((n) => n && n.userId === userId));
    const fullSelfIds = new Set(fullNotifs.filter((n) => n && n.userId === userId).map((n) => n.id));
    for (const n of arr(p.notifications)) if (n && n.userId !== userId) drop('notifications', n.id, 'foreign-notification');
    for (const [id] of postedSelf) if (!fullSelfIds.has(id)) drop('notifications', id, 'client-authored-notification');
    next.notifications = fullNotifs.flatMap((n) => {
      if (!n || n.userId !== userId) return [n];       // other users untouched
      const pr = postedSelf.get(n.id);
      if (!pr) return [];                               // removed by the caller — allowed
      if (!n.readAt && pr.readAt) return [{ ...n, readAt: pr.readAt }]; // unread → read — allowed
      return [n];                                       // any other field on a self row: keep committed
    });
  }

  // ── c. conversations + messages ──────────────────────────────────────────────
  const fullConvById = byId(f.conversations);
  const servedConvIds = new Set(arr(served.conversations).map((c) => c.id));
  const postedConvById = byId(p.conversations);
  const addedConvs = [];
  for (const c of arr(p.conversations)) {
    if (!c || c.id == null || fullConvById.has(c.id)) continue;
    const parts = Array.isArray(c.participantUserIds) ? c.participantUserIds : [];
    if ((c.channel === 'internal' || c.channel === 'dm') && parts.includes(userId)) {
      addedConvs.push({
        ...c,
        createdByUserId: userId,                          // server-stamped
        starredByUserIds: Array.isArray(c.starredByUserIds) ? c.starredByUserIds : [],
        mutedByUserIds: Array.isArray(c.mutedByUserIds) ? c.mutedByUserIds : [],
      });
    } else {
      drop('conversations', c.id, 'new-conversation-not-allowed');
    }
  }
  for (const [id, fc] of fullConvById) {
    const pc = postedConvById.get(id);
    if (!pc) { if (servedConvIds.has(id)) drop('conversations', id, 'delete-not-allowed'); continue; }
    // lastMessageAt moves with a new message (recomputed below); every other field is fixed.
    if (!jsonEq({ ...fc, lastMessageAt: null }, { ...pc, lastMessageAt: null })) drop('conversations', id, 'conversation-edit-not-allowed');
  }
  next.conversations = [...arr(f.conversations), ...addedConvs];
  const nextConvById = byId(next.conversations);
  const writableConvIds = new Set([...servedConvIds, ...addedConvs.map((c) => c.id)]);

  const fullMsgById = byId(f.messages);
  const postedMsgById = byId(p.messages);
  const addedMsgs = [];
  for (const m of arr(p.messages)) {
    if (!m || m.id == null || fullMsgById.has(m.id)) continue;
    if (m.authorUserId !== userId) { drop('messages', m.id, 'foreign-message'); continue; }
    if (!writableConvIds.has(m.conversationId)) { drop('messages', m.id, 'message-in-invisible-conversation'); continue; }
    addedMsgs.push({ ...m, authorUserId: userId, sentAt: safeSentAt(m.sentAt, now), readByUserIds: [userId] });
  }
  next.messages = arr(f.messages).map((m) => {
    if (!m) return m;
    const pm = postedMsgById.get(m.id);
    if (!pm) return m;                                    // caller "deleted" — keep (no deletes)
    // Read-state / delivery may change ONLY on a message in a thread the caller can WRITE
    // (a served thread + threads added this save). A crafted post naming a message in an
    // invisible thread — an orphaned thread, or one outside the caller's scope — is ignored:
    // never a mark-read or delivery write there (CS-002 F1; mirrors the added-message gate).
    if (!writableConvIds.has(m.conversationId)) { drop('messages', m.id, 'message-in-invisible-conversation'); return m; }
    let out = m;
    const fullHas = arr(m.readByUserIds).includes(userId);
    const postedHas = arr(pm.readByUserIds).includes(userId);
    if (fullHas !== postedHas) {                          // ONLY the caller's own read membership may flip
      const base = arr(m.readByUserIds).filter((id) => id !== userId);
      out = { ...out, readByUserIds: postedHas ? [...base, userId] : base };
    }
    if (m.authorUserId === userId) {                      // delivery status only on the caller's own messages
      const delivery = {};
      for (const k of ['deliveryStatus', 'twilioMessageSid', 'emailMessageId', 'failureReason', 'emailHeaders']) {
        if (Object.prototype.hasOwnProperty.call(pm, k) && !jsonEq(pm[k] ?? null, m[k] ?? null)) delivery[k] = pm[k];
      }
      if (Object.keys(delivery).length) out = { ...out, ...delivery };
    }
    return out;
  });
  next.messages = [...next.messages, ...addedMsgs];
  for (const msg of addedMsgs) newMessages.push({ msg, conv: nextConvById.get(msg.conversationId) || null });
  if (addedMsgs.length) {
    const latest = new Map();
    for (const msg of addedMsgs) {
      const prev = latest.get(msg.conversationId);
      if (!prev || msg.sentAt > prev) latest.set(msg.conversationId, msg.sentAt);
    }
    next.conversations = next.conversations.map((c) => {
      const t = latest.get(c.id);
      return t && (!c.lastMessageAt || t > c.lastMessageAt) ? { ...c, lastMessageAt: t } : c;
    });
  }

  // ── d. clientActivities + the client's notes string (APPEND_CLIENT_NOTE) ─────
  {
    const fullActById = byId(f.clientActivities);
    const postedActById = byId(p.clientActivities);
    const addedActs = [];
    for (const a of arr(p.clientActivities)) {
      if (!a || a.id == null || fullActById.has(a.id)) continue;
      if (!clientIds.has(a.clientId)) { drop('clientActivities', a.id, 'out-of-scope-client'); continue; }
      addedActs.push({ ...a, authorUserId: userId });     // server-stamped author
    }
    next.clientActivities = arr(f.clientActivities).map((a) => {
      if (!a) return a;
      const pa = postedActById.get(a.id);
      if (!pa) return a;                                  // no deletes
      if (a.authorUserId === userId && !jsonEq(a.body ?? null, pa.body ?? null)) return { ...a, body: pa.body };
      return a;
    });
    next.clientActivities = [...next.clientActivities, ...addedActs];

    const postedClientById = byId(p.clients);
    const fullClientById = byId(f.clients);
    next.clients = arr(f.clients).map((c) => {
      if (!c) return c;
      const pc = postedClientById.get(c.id);
      if (!pc) return c;
      const onlyNotesDiff = !jsonEq({ ...c, notes: null }, { ...pc, notes: null });
      if (clientIds.has(c.id) && !jsonEq(c.notes ?? null, pc.notes ?? null)) {
        if (onlyNotesDiff) drop('clients', c.id, 'client-field-edit-not-allowed'); // notes accepted, the rest dropped
        return { ...c, notes: pc.notes };
      }
      if (onlyNotesDiff) drop('clients', c.id, 'client-field-edit-not-allowed');
      return c;
    });
    for (const [id] of postedClientById) if (!fullClientById.has(id)) drop('clients', id, 'new-client-not-allowed');
  }

  // ── e. keys (custody only) + keyEvents (append) ──────────────────────────────
  {
    const servedKeyById = byId(served.keys);
    const postedKeyById = byId(p.keys);
    const CUSTODY = ['status', 'heldByUserId', 'heldByName', 'updatedAt'];
    next.keys = arr(f.keys).map((k) => {
      if (!k) return k;
      const pk = postedKeyById.get(k.id);
      if (!pk) return k;
      if (!servedKeyById.has(k.id)) { drop('keys', k.id, 'key-not-visible'); return k; }
      const patch = {};
      for (const field of CUSTODY) if (!jsonEq(k[field] ?? null, pk[field] ?? null)) patch[field] = pk[field];
      // Detect a tamper beyond custody (pk has masterCode stripped by the projection, so ignore it).
      const nullCustody = (o) => { const c = { ...o }; for (const field of CUSTODY) c[field] = null; delete c.masterCode; return c; };
      if (!jsonEq(nullCustody(k), nullCustody(pk))) drop('keys', k.id, 'key-field-edit-not-allowed');
      if (!Object.keys(patch).length) return k;
      const merged = { ...k, ...patch };
      if (patch.status === 'out' && patch.heldByUserId && patch.heldByUserId !== userId) {
        keyCustody.push({ key: merged, holderUserId: patch.heldByUserId });
      }
      return merged;
    });
    const fullKeyEventById = byId(f.keyEvents);
    const visibleKeyIds = new Set(servedKeyById.keys());
    const addedKeyEvents = [];
    for (const e of arr(p.keyEvents)) {
      if (!e || e.id == null || fullKeyEventById.has(e.id)) continue;
      if (!visibleKeyIds.has(e.keyId)) { drop('keyEvents', e.id, 'key-not-visible'); continue; }
      addedKeyEvents.push({ ...e, byUserId: userId });    // server-stamped actor
    }
    next.keyEvents = [...arr(f.keyEvents), ...addedKeyEvents];
  }

  // ── server-side recipient notifications (message + key custody), the SAME builders the
  //    reducer uses. Run on full data (next has the whole roster/contacts), stamping the
  //    actor as currentUserId so self-skip + actor attribution match the reducer. next itself
  //    never carries currentUserId (it is stripped from the shared blob).
  const fanoutState = { ...next, currentUserId: userId };
  let notifications = next.notifications;
  for (const { msg, conv } of newMessages) notifications = fanOutMessageNotifications({ ...fanoutState, notifications }, msg, conv);
  for (const kc of keyCustody) notifications = fanOutKeyNotification({ ...fanoutState, notifications }, kc);
  next.notifications = notifications;

  return { next, dropped, newMessages, pushWorthy: newMessages.length > 0 || keyCustody.length > 0 };
}
