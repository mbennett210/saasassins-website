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
//      policy re-applied server-side) / language + phoneLanguage (CS-193, each only when it is
//      exactly an allowed value — src/i18n/languages.js; anything else is dropped, never
//      repaired) / photo (UI_RULES §141: exactly `{ v }` or null — src/lib/userPhoto.js);
//      never pay / hr / role / status / avatar / another member's row.
//   b. notifications with userId === caller: read-state (unread→read) and removals. Rows for
//      OTHER users are dropped; recipients' rows for newly-merged messages / key custody / a key
//      moved to lost or unknown (the office's keyLost alert, CS-710) are DERIVED server-side with
//      the SAME fan-out helpers the reducer uses.
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
//   h. 🔴 CS-671: what one crew save may WRITE is bounded (CREW_LIMITS). The whole company shares
//      one record with one size ceiling, and a single crafted message carried 600 KB into it. A text
//      longer than its limit (a message, a note, the caller's own name and phone, a key holder's
//      name) is CLIPPED to it and reported (`clipped-to-limit`), so the phone re-reads and shows what
//      was kept; a record still too big after that (any field the crew can add) is DROPPED
//      (`too-large`); a customer note may grow by at most CREW_LIMITS.noteGrowthChars in one save;
//      a read receipt is a time. The route then measures the merged record (org-state.js).
//
// Returns { next, dropped:[{slice,id,reason}], newMessages:[{msg,conv}], pushWorthy }.
import { jsonEq } from './jsonEq.js';
import { applyMandatoryNotificationPolicy } from '../../src/lib/roles.js';
import { fanOutMessageNotifications, fanOutKeyNotification, fanOutKeyStatusAlert, KEY_ALERT_STATUSES } from '../../src/lib/notifications.js';
import { projectCrewView } from './crewView.js';
import { isLanguageChoice, LANGUAGES } from '../../src/i18n/languages.js';
import { isUserPhoto } from '../../src/lib/userPhoto.js';

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

// ── h. CS-671: what ONE crew save may write ───────────────────────────────────────────────
// Generous for any real use — a cleaner's message is a few lines — and small beside the record's
// one ceiling (MAX_STATE_BYTES, 3.5 MB for the whole company).
export const CREW_LIMITS = Object.freeze({
  textChars: 5000,         // a message's text; a customer note's body
  nameChars: 120,          // the caller's own name; a key holder's name
  phoneChars: 40,          // the caller's own phone
  noteGrowthChars: 5400,   // what one save may add to a customer's notes: one note and its stamp line
  recordBytes: 16000,      // any ONE record a crew save adds or changes, every field counted
});
const recordBytes = (v) => Buffer.byteLength(JSON.stringify(v ?? null), 'utf8');
const tooLarge = (v) => recordBytes(v) > CREW_LIMITS.recordBytes;
// A text held to `max` characters, cut on whole characters (an emoji is never split). null passes;
// anything that is not text is not a text: { ok: false }.
function clipText(v, max) {
  if (v === null || v === undefined) return { ok: true, value: null, clipped: false };
  if (typeof v !== 'string') return { ok: false, value: null, clipped: false };
  if (v.length <= max) return { ok: true, value: v, clipped: false };
  const chars = Array.from(v);
  if (chars.length <= max) return { ok: true, value: v, clipped: false };
  return { ok: true, value: chars.slice(0, max).join(''), clipped: true };
}
// A read receipt is a time: a plausible ISO stamp is kept, anything else is stamped `now`.
const safeReadAt = (v, now) => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : new Date(now).toISOString());

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
  const keyStatus = [];     // { key, status } for the server-side keyLost alert (CS-710)

  // ── a. the caller's OWN profile (users[caller]) ──────────────────────────────
  {
    const fullUsers = arr(f.users);
    const postedSelf = byId(p.users).get(userId) || null;
    const servedSelf = byId(served.users).get(userId) || null;
    let prefsPatch = null;
    const patch = {};
    if (postedSelf && servedSelf) {
      // The caller's own name and phone are texts held to their limits (h); anything else is dropped.
      for (const [field, max] of [['name', CREW_LIMITS.nameChars], ['phone', CREW_LIMITS.phoneChars]]) {
        if (jsonEq(postedSelf[field] ?? null, servedSelf[field] ?? null)) continue;
        const c = clipText(postedSelf[field], max);
        if (!c.ok) { drop('users', userId, `invalid-${field}`); continue; }
        patch[field] = c.value;
        if (c.clipped) drop('users', userId, 'clipped-to-limit');
      }
      if (!jsonEq(postedSelf.signaturePrefs ?? null, servedSelf.signaturePrefs ?? null)) {
        if (tooLarge(postedSelf.signaturePrefs)) drop('users', userId, 'too-large');
        else patch.signaturePrefs = postedSelf.signaturePrefs ?? null;
      }
      // CS-193: the cleaner's own language switch (Settings → Account) and what their phone
      // says (components/LanguageSync). The server renders their alerts from these, so a
      // value outside the allowed set is DROPPED here exactly as the reducer ignores it.
      if (!jsonEq(postedSelf.language ?? null, servedSelf.language ?? null)) {
        if (isLanguageChoice(postedSelf.language)) patch.language = postedSelf.language;
        else drop('users', userId, 'invalid-language');
      }
      if (!jsonEq(postedSelf.phoneLanguage ?? null, servedSelf.phoneLanguage ?? null)) {
        const pl = postedSelf.phoneLanguage ?? null;
        if (pl === null || LANGUAGES.includes(pl)) patch.phoneLanguage = pl;
        else drop('users', userId, 'invalid-phone-language');
      }
      // UI_RULES §141: the cleaner's own profile photo, after their upload stored the bytes (the
      // route decides who may upload whose photo; this only records which version shows). The
      // link route signs whatever it finds here, so a value that is not exactly `{ v }` or null
      // is DROPPED, exactly as the reducer ignores it. null removes the field.
      if (!jsonEq(postedSelf.photo ?? null, servedSelf.photo ?? null)) {
        const ph = postedSelf.photo ?? null;
        if (ph === null) patch.photo = null;
        else if (isUserPhoto(ph)) patch.photo = { v: ph.v };
        else drop('users', userId, 'invalid-photo');
      }
      if (!jsonEq(postedSelf.notificationPrefs ?? null, servedSelf.notificationPrefs ?? null) && tooLarge(postedSelf.notificationPrefs)) {
        drop('users', userId, 'too-large'); // settings are a few dozen switches, never kilobytes (h)
      } else if (!jsonEq(postedSelf.notificationPrefs ?? null, servedSelf.notificationPrefs ?? null)) {
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
        if ('photo' in patch && patch.photo === null) delete merged.photo; // absent = initials
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
      if (!n.readAt && pr.readAt) {                     // unread → read — allowed, and a read receipt is a time (h)
        const readAt = safeReadAt(pr.readAt, now);
        if (readAt !== pr.readAt) drop('notifications', n.id, 'invalid-read-time');
        return [{ ...n, readAt }];
      }
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
      const conv = {
        ...c,
        createdByUserId: userId,                          // server-stamped
        starredByUserIds: Array.isArray(c.starredByUserIds) ? c.starredByUserIds : [],
        mutedByUserIds: Array.isArray(c.mutedByUserIds) ? c.mutedByUserIds : [],
      };
      if (tooLarge(conv)) drop('conversations', c.id, 'too-large'); // (h)
      else addedConvs.push(conv);
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
    let added = { ...m, authorUserId: userId, sentAt: safeSentAt(m.sentAt, now), readByUserIds: [userId] };
    // (h) The text is held to its limit; a message still too big after that is not one.
    if (m.text !== undefined && m.text !== null) {
      const c = clipText(m.text, CREW_LIMITS.textChars);
      if (!c.ok) { drop('messages', m.id, 'invalid-text'); continue; }
      if (c.clipped) { added = { ...added, text: c.value }; drop('messages', m.id, 'clipped-to-limit'); }
    }
    if (tooLarge(added)) { drop('messages', m.id, 'too-large'); continue; }
    addedMsgs.push(added);
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
    // (h) A delivery update may not make the message huge either.
    if (out !== m && tooLarge(out) && recordBytes(out) > recordBytes(m)) { drop('messages', m.id, 'too-large'); return m; }
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
      let act = { ...a, authorUserId: userId };           // server-stamped author
      // (h) A note's body is held to the text limit; a record still too big after that is dropped.
      if (a.body !== undefined && a.body !== null) {
        const c = clipText(a.body, CREW_LIMITS.textChars);
        if (!c.ok) { drop('clientActivities', a.id, 'invalid-text'); continue; }
        if (c.clipped) { act = { ...act, body: c.value }; drop('clientActivities', a.id, 'clipped-to-limit'); }
      }
      if (tooLarge(act)) { drop('clientActivities', a.id, 'too-large'); continue; }
      addedActs.push(act);
    }
    next.clientActivities = arr(f.clientActivities).map((a) => {
      if (!a) return a;
      const pa = postedActById.get(a.id);
      if (!pa) return a;                                  // no deletes
      if (a.authorUserId === userId && !jsonEq(a.body ?? null, pa.body ?? null)) {
        if (typeof pa.body !== 'string') return { ...a, body: pa.body };
        const c = clipText(pa.body, CREW_LIMITS.textChars); // (h)
        if (c.clipped) drop('clientActivities', a.id, 'clipped-to-limit');
        return { ...a, body: c.value };
      }
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
        // (h) The notes are text, and one save adds at most one note to them.
        const posted = pc.notes ?? null;
        if (posted !== null && typeof posted !== 'string') { drop('clients', c.id, 'invalid-notes'); return c; }
        if ((posted || '').length - (typeof c.notes === 'string' ? c.notes.length : 0) > CREW_LIMITS.noteGrowthChars) {
          drop('clients', c.id, 'too-large');
          return c;
        }
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
      // (h) The holder's name is a name; a key made huge by its custody fields is not committed.
      if (typeof patch.heldByName === 'string') {
        const c = clipText(patch.heldByName, CREW_LIMITS.nameChars);
        if (c.clipped) { patch.heldByName = c.value; drop('keys', k.id, 'clipped-to-limit'); }
      }
      const merged = { ...k, ...patch };
      if (tooLarge(merged) && recordBytes(merged) > recordBytes(k)) { drop('keys', k.id, 'too-large'); return k; }
      if (patch.status === 'out' && patch.heldByUserId && patch.heldByUserId !== userId) {
        keyCustody.push({ key: merged, holderUserId: patch.heldByUserId });
      }
      // CS-710: a key the cleaner reports LOST or of unknown whereabouts alerts the office — on the
      // move into that state, never again while it stays there.
      if (KEY_ALERT_STATUSES.includes(patch.status) && k.status !== patch.status) {
        keyStatus.push({ key: merged, status: patch.status });
      }
      return merged;
    });
    const fullKeyEventById = byId(f.keyEvents);
    const visibleKeyIds = new Set(servedKeyById.keys());
    const addedKeyEvents = [];
    for (const e of arr(p.keyEvents)) {
      if (!e || e.id == null || fullKeyEventById.has(e.id)) continue;
      if (!visibleKeyIds.has(e.keyId)) { drop('keyEvents', e.id, 'key-not-visible'); continue; }
      const ev = { ...e, byUserId: userId };              // server-stamped actor
      if (tooLarge(ev)) { drop('keyEvents', e.id, 'too-large'); continue; } // (h)
      addedKeyEvents.push(ev);
    }
    next.keyEvents = [...arr(f.keyEvents), ...addedKeyEvents];
  }

  // ── server-side recipient notifications (message, key custody, a key lost or unknown), the
  //    SAME builders the reducer uses. Run on full data (next has the whole roster/contacts),
  //    stamping the actor as currentUserId so self-skip + actor attribution match the reducer.
  //    next itself never carries currentUserId (it is stripped from the shared blob).
  const fanoutState = { ...next, currentUserId: userId };
  let notifications = next.notifications;
  for (const { msg, conv } of newMessages) notifications = fanOutMessageNotifications({ ...fanoutState, notifications }, msg, conv);
  for (const kc of keyCustody) notifications = fanOutKeyNotification({ ...fanoutState, notifications }, kc);
  for (const ks of keyStatus) notifications = fanOutKeyStatusAlert({ ...fanoutState, notifications }, { ...ks, actorUserId: userId });
  next.notifications = notifications;

  return { next, dropped, newMessages, pushWorthy: newMessages.length > 0 || keyCustody.length > 0 || keyStatus.length > 0 };
}
