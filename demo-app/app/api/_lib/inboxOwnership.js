// Per-mailbox ownership for connected inboxes — AUTHORIZATION_AUDIT.md §2026-07-20 #2.
//
// THE HOLE: /api/inbox/:id/send and /test let ANY authenticated user send arbitrary mail
// (to/cc/bcc/attachments/In-Reply-To) out of ANY connected mailbox — including a manager's
// real Gmail, from the company's real domain. The account ids are in the blob every user
// can read.
//
// WHY NOT A ROLE GATE: `messaging.use` is ALWAYS_GRANTED and Messaging.jsx calls these
// routes, so requiring owner/admin is an outage for crew who legitimately send. The only
// correct discriminator is "is this mailbox YOURS".
//
// ── 🔴 IT NOW FAILS CLOSED (CS-017, 2026-09-29) ─────────────────────────────────────
//
// This module used to be deliberately inert in three ways, and CS-017 is the finding that
// the sum of them was a gate that enforced nothing:
//
//     column absent      -> allow   (the migration was unapplied)
//     owner_user_id NULL -> allow   ("unclaimed = pre-#2 behaviour")
//     probe threw        -> allow   ("an infrastructure fault, not an attack")
//
// All three now DENY. What changed is that there is nothing left to protect by allowing:
// `inbox_accounts` held 0 rows on 2026-09-25 (CS-116, L2 verified), so no live mailbox can
// be locked out by tightening, and every mailbox connected from here on is stamped with
// its connector's `u_*` id at the OAuth callback (api/inbox/oauth/google/callback.js), so
// "unclaimed" stops being a state a real mailbox reaches. The migration that adds the
// column is 20260929120000_inbox_owner_and_system_sender.sql; until it is applied these
// two routes answer 403 and say why, which is the honest state — the alternative was a
// gate that read as closed and was open.
//
// A row-not-found still ALLOWS, and that is not a hole: there is no mailbox to act on, and
// performSend's "Connected inbox not found" is a far more useful answer than a blanket 403.
//
// NO MANAGER BYPASS, on purpose. An admin sending from another person's real Gmail is the
// same impersonation the finding is about, just by a trusted party. Ownership is ownership.
// A mailbox the OFFICE shares is owned by whoever connected it, which is the right answer
// for a company mailbox too. (`disconnect` is separately gated — that one IS an admin
// action, and it admits the mailbox's owner as well since 2026-09-29, CS-088.) The
// marketing cron is unaffected either way: it calls performSend() in-process and never
// crosses this route, and so does the system sender (api/_lib/email.js).
import { getSupabase } from './supabase.js';
import { requireAuthority, holdsPermission } from './authz.js';

// Schema probes are cached because the schema cannot change inside one instance's
// lifetime. A positive result is cached for good; a negative one is re-probed periodically
// so the gate follows the migration landing without waiting for warm instances to recycle.
const NEGATIVE_TTL_MS = 60_000;
let columnCache = { present: false, checkedAt: 0, known: false };

export async function ownerColumnExists() {
  if (columnCache.known && columnCache.present) return true;
  if (columnCache.known && Date.now() - columnCache.checkedAt < NEGATIVE_TTL_MS) return false;
  try {
    const { error } = await getSupabase().from('inbox_accounts').select('owner_user_id').limit(1);
    // 42703 = undefined_column. Anything else (network, permissions) is not evidence the
    // column is missing either — and since both directions now DENY, the distinction no
    // longer decides who gets in, only which message they see.
    const present = !error;
    columnCache = { present, checkedAt: Date.now(), known: true };
    return present;
  } catch {
    columnCache = { present: false, checkedAt: Date.now(), known: true };
    return false;
  }
}

// Decide whether `orgUserId` may act on `inboxId`, given the row's stored owner.
// Pure, so the whole decision table is unit-testable without a database.
// Returns { allow: true, reason } | { allow: false, reason }.
export function ownershipVerdict({ columnPresent, ownerUserId, orgUserId, rowFound }) {
  if (!columnPresent) return { allow: false, reason: 'not-provisioned' };  // migration not applied
  if (!rowFound) return { allow: true, reason: 'row-missing' };            // performSend 404s more usefully
  if (!ownerUserId) return { allow: false, reason: 'unclaimed' };          // nobody owns it -> nobody sends
  if (!orgUserId) return { allow: false, reason: 'no-identity' };          // claimed row, unidentifiable caller
  if (ownerUserId !== orgUserId) return { allow: false, reason: 'not-owner' };
  return { allow: true, reason: 'owner' };
}

// Is `orgUserId` the stored owner of `inboxId`? For a caller that needs the fact without a
// 403 (the disconnect route, which admits the owner OR a messaging-inbox manager).
// FAILS CLOSED: an unreadable row, a missing column or a throw all answer false.
export async function isInboxOwner(inboxId, orgUserId) {
  if (!inboxId || !orgUserId) return false;
  try {
    if (!(await ownerColumnExists())) return false;
    const { data, error } = await getSupabase()
      .from('inbox_accounts').select('owner_user_id').eq('id', inboxId).maybeSingle();
    if (error) throw new Error(error.message);
    return !!data && data.owner_user_id === orgUserId;
  } catch (e) {
    console.error('[inbox-ownership] owner lookup failed:', e?.message || e);
    return false;
  }
}

// ADMINISTERING a mailbox (disconnect) rather than SENDING from it — CS-088.
// Its OWNER may, and so may a holder of `messaging.manageInboxes` (a visible Messaging key,
// owner/admin/manager by default) for any mailbox; `marketing.connectInbox` still passes on
// its own so the Marketing → Inboxes surface is never tightened. Unlike sending, an admin
// power here is right: disconnecting is not impersonation.
// Named requireXxx(req, res, …) so the endpoint inventory sees the real gate by shape rather
// than the requireAuthority underneath it (endpoint-lint.mjs).
// Returns the authority when allowed, or null with 401/403 written.
export async function requireInboxAdmin(req, res, inboxId) {
  const a = await requireAuthority(req, res);
  if (!a) return null; // 401 written
  const allowed = (await isInboxOwner(inboxId, a.orgUserId))
    || (await holdsPermission(a, 'messaging.manageInboxes'))
    || (await holdsPermission(a, 'marketing.connectInbox'));
  if (!allowed) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return null;
  }
  return a;
}

// The human half of a refusal. Kept next to the verdict so the route and the tests agree.
const DENIAL_MESSAGE = {
  'not-provisioned': 'Connected mailboxes are not set up on this deployment yet.',
  unclaimed: 'This mailbox has no owner yet, so nobody can send through it. Reconnect it from Settings → Connected Inboxes.',
  'no-identity': 'This mailbox belongs to another user.',
  'not-owner': 'This mailbox belongs to another user.',
  error: 'Could not verify who owns this mailbox.',
};

// requireAuthority + the ownership check. Returns the authority object when the caller may
// proceed, or null with 401/403 already written.
// Caller: `const a = await requireInboxOwner(req, res, id); if (!a) return;`
export async function requireInboxOwner(req, res, inboxId) {
  const a = await requireAuthority(req, res);
  if (!a) return null; // 401 written

  let verdict;
  try {
    if (!(await ownerColumnExists())) {
      verdict = ownershipVerdict({ columnPresent: false });
    } else {
      const { data, error } = await getSupabase()
        .from('inbox_accounts').select('owner_user_id').eq('id', inboxId).maybeSingle();
      if (error) throw new Error(error.message);
      verdict = ownershipVerdict({
        columnPresent: true,
        rowFound: !!data,
        ownerUserId: data?.owner_user_id || null,
        orgUserId: a.orgUserId,
      });
    }
  } catch (e) {
    // 🔴 FAIL CLOSED. This used to allow on a throw, reasoning that the gate was inert
    // anyway so denying would only take out Messaging. Now that it enforces, a read that
    // failed proves nothing about who owns the mailbox, and a gate that cannot read its
    // inputs must refuse — the same rule authz.js holdsOrRefuse follows.
    console.error('[inbox-ownership] check failed, denying:', e?.message || e);
    verdict = { allow: false, reason: 'error' };
  }

  if (!verdict.allow) {
    console.warn(`[inbox-ownership] denied ${a.orgUserId || '(no id)'} on ${inboxId}: ${verdict.reason}`);
    res.status(403).json({ error: DENIAL_MESSAGE[verdict.reason] || DENIAL_MESSAGE.error, code: verdict.reason });
    return null;
  }
  return a;
}

// Test-only.
export function __resetInboxOwnershipCache() {
  columnCache = { present: false, checkedAt: 0, known: false };
}
