// Per-mailbox ownership for connected inboxes — AUTHORIZATION_AUDIT.md §2026-07-20 #2.
//
// THE HOLE: /api/inbox/:id/send and /test are requireAuth-only, so any authenticated
// user can send arbitrary mail (to/cc/bcc/attachments/In-Reply-To) out of ANY
// connected mailbox — including a manager's real Gmail, from the company's real
// domain. The account ids are in the blob every user can read.
//
// WHY NOT A ROLE GATE: `messaging.use` is ALWAYS_GRANTED and Messaging.jsx calls
// these routes, so requiring owner/admin is an outage for 37 crew who legitimately
// send. The only correct discriminator is "is this mailbox YOURS".
//
// ── INERT UNTIL THE MIGRATION LANDS, AND THEN INERT PER ROW ─────────────────────
//
// 20260720100000_inbox_owner.sql is written but NOT applied (loop rule 2). This
// module must therefore be a no-op on today's schema, and it is — in two layers:
//
//   1. COLUMN ABSENT  -> allow. Probed once and cached; a 42703 from PostgREST is
//      the signal. This is the `assignmentsInitialized()` pattern.
//   2. owner_user_id NULL -> allow. Per-ROW rather than a global "is it initialized"
//      flag, deliberately: a global flag flips the instant ONE row gets an owner,
//      which would start denying every still-unclaimed mailbox and take out sending
//      for them. Per-row means a mailbox is protected exactly when someone claims it
//      and never before.
//
// So: applying the migration alone changes no behaviour. Enforcement begins per
// mailbox, the moment that mailbox is given an owner.
//
// ⚠️ ON THIS DEPLOYMENT NOTHING CAN CLAIM THEM YET. A read-only probe found 2 live
// mailboxes, 0 matching auth.users by email, and org_state.connectedInboxes EMPTY —
// so there is no source, tamper-proof or otherwise, to derive an owner from. See
// LOOP_REVIEW.md §3; scripts/backfill-inbox-owners.mjs reports instead of guessing.
//
// NO MANAGER BYPASS, on purpose. An admin sending from another person's real Gmail
// is the same impersonation the finding is about, just by a trusted party. Ownership
// is ownership. (`disconnect` is separately requireRole'd — that one IS an admin
// action.) The marketing cron is unaffected either way: it calls performSend()
// in-process and never crosses this route.
import { getSupabase } from './supabase.js';
import { requireAuthority } from './authz.js';

// Schema probes are cached because the schema cannot change inside one instance's
// lifetime. A positive result is cached for good; a negative one is re-probed
// periodically so the gate starts working after the migration lands without waiting
// for every warm instance to recycle.
const NEGATIVE_TTL_MS = 60_000;
let columnCache = { present: false, checkedAt: 0, known: false };

export async function ownerColumnExists() {
  if (columnCache.known && columnCache.present) return true;
  if (columnCache.known && Date.now() - columnCache.checkedAt < NEGATIVE_TTL_MS) return false;
  try {
    const { error } = await getSupabase().from('inbox_accounts').select('owner_user_id').limit(1);
    // 42703 = undefined_column. Anything else (network, permissions) is NOT evidence
    // the column is missing, but it is also not evidence it is present — and this
    // module must never deny on uncertainty, so both fall through to "absent" = allow.
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
// Returns { allow: true } | { allow: false, reason }.
export function ownershipVerdict({ columnPresent, ownerUserId, orgUserId, rowFound }) {
  if (!columnPresent) return { allow: true, reason: 'column-absent' };   // migration not applied
  if (!rowFound) return { allow: true, reason: 'row-missing' };          // performSend 404s more usefully
  if (!ownerUserId) return { allow: true, reason: 'unclaimed' };         // NULL owner = pre-#2 behaviour
  if (!orgUserId) return { allow: false, reason: 'no-identity' };        // claimed row, unidentifiable caller
  if (ownerUserId !== orgUserId) return { allow: false, reason: 'not-owner' };
  return { allow: true, reason: 'owner' };
}

// requireAuthority + the ownership check. Returns the authority object when the
// caller may proceed, or null with 401/403 already written.
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
    // FAIL OPEN, and loudly. This gate is inert on the current schema, so a throw
    // here means an infrastructure fault, not an attack — denying would take out
    // Messaging for everyone to protect a check that is not yet enforcing anything.
    // Revisit once owners are actually assigned (LOOP_REVIEW §2).
    console.error('[inbox-ownership] check failed, allowing:', e?.message || e);
    return a;
  }

  if (!verdict.allow) {
    console.warn(`[inbox-ownership] denied ${a.orgUserId || '(no id)'} on ${inboxId}: ${verdict.reason}`);
    res.status(403).json({ error: 'This mailbox belongs to another user.' });
    return null;
  }
  return a;
}

// Test-only.
export function __resetInboxOwnershipCache() {
  columnCache = { present: false, checkedAt: 0, known: false };
}
