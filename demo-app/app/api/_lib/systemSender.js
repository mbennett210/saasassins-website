// THE SYSTEM SENDER — the one connected Google mailbox the app's own email leaves
// from: staff invites and set-password links, quote and signed-copy mail, reminders,
// the Settings test send.
//
// Daniel, 2026-09-29: "Clean Space sends email through Google, NOT Resend." So there is
// no API key and no verified sending domain to configure; there is a mailbox, connected
// through the same Google OAuth client the Messaging inboxes use, and marked here. Every
// send then goes out over the Gmail API as that mailbox (api/_lib/email.js).
//
// 🔴 NO ADDRESS IS HARDCODED. Which Google account Clean Space uses is Matt's to say
// (plan §5 F18), so it is configuration in two forms, checked in this order:
//
//   1. SYSTEM_SENDER_EMAIL  — an env PIN. When set, only the mailbox at that address is
//      the system sender and the UI cannot change it. For a deployment that wants the
//      choice held outside the product.
//   2. inbox_accounts.is_system_sender — the owner's choice in Settings → Integrations,
//      written by POST /api/email/system-sender. The database allows only one
//      (a partial unique index, migration 20260929120000).
//
// NOTHING CONFIGURED = NO SEND. `getSystemSenderAccount()` answers null, every caller
// skips with a clear server log, and Settings shows "Email isn't set up" — the same shape
// as the old missing-RESEND_API_KEY behaviour (CS-012), with the hole that CS-039 named
// closed: there is no field here that swallows a pasted secret.
//
// The column is probed, not assumed: migration 20260929120000 is written and NOT applied,
// so until it lands the DB path answers "none" (a 42703 from PostgREST) and the env pin is
// the only way to configure a sender. That direction is fail-CLOSED — email is skipped —
// so it can never send as the wrong mailbox.
import { getSupabase } from './supabase.js';
import { getAccountByEmail } from './accounts.js';

// A negative column probe is re-checked periodically so the DB path starts working once
// the migration lands, without waiting for every warm instance to recycle. A positive one
// is cached for good: the schema cannot change inside an instance's lifetime.
const NEGATIVE_TTL_MS = 60_000;
let columnCache = { present: false, checkedAt: 0, known: false };

// The env pin, normalised. '' when unset.
export function pinnedSystemSenderEmail() {
  return (process.env.SYSTEM_SENDER_EMAIL || '').trim().toLowerCase();
}

export async function systemSenderColumnExists() {
  if (columnCache.known && columnCache.present) return true;
  if (columnCache.known && Date.now() - columnCache.checkedAt < NEGATIVE_TTL_MS) return false;
  try {
    const { error } = await getSupabase().from('inbox_accounts').select('is_system_sender').limit(1);
    const present = !error;
    columnCache = { present, checkedAt: Date.now(), known: true };
    return present;
  } catch {
    columnCache = { present: false, checkedAt: Date.now(), known: true };
    return false;
  }
}

// The inbox_accounts row the app sends its own mail as, or null when email isn't set up.
// Never throws: a send is best-effort at every call site, and a lookup fault must read as
// "not configured" (skip, and say so) rather than take out the action that triggered it.
export async function getSystemSenderAccount() {
  const pin = pinnedSystemSenderEmail();
  if (pin) {
    try {
      return (await getAccountByEmail(pin)) || null;
    } catch (e) {
      console.error('[system-sender] pinned mailbox lookup failed:', e?.message || e);
      return null;
    }
  }
  if (!(await systemSenderColumnExists())) return null;
  try {
    const { data, error } = await getSupabase()
      .from('inbox_accounts').select('*').eq('is_system_sender', true).maybeSingle();
    if (error) throw new Error(error.message);
    return data || null;
  } catch (e) {
    console.error('[system-sender] lookup failed:', e?.message || e);
    return null;
  }
}

// What Settings → Integrations renders, and what GET /api/email/health returns. Carries no
// token and no secret — just which mailbox, where the choice lives, and why not.
//   configured  can the app send at all
//   email       the sending address, or null
//   source      'env' (pinned) | 'inbox' (the owner's choice) | null
//   pinned      the choice is held in env; the UI must not offer to change it
//   reason      why it isn't configured: 'no-sender' | 'not-provisioned' | 'pinned-missing'
//   status      the mailbox's own OAuth health: 'active' | 'expired' | …
export async function systemSenderStatus() {
  const pin = pinnedSystemSenderEmail();
  const account = await getSystemSenderAccount();
  if (account) {
    return {
      configured: account.status === 'active',
      email: account.email || null,
      displayName: account.display_name || null,
      inboxId: account.id || null,
      source: pin ? 'env' : 'inbox',
      pinned: !!pin,
      status: account.status || null,
      lastError: account.last_error || null,
      reason: account.status === 'active' ? null : 'sender-inactive',
    };
  }
  let reason = 'no-sender';
  if (pin) reason = 'pinned-missing';
  else if (!(await systemSenderColumnExists())) reason = 'not-provisioned';
  return {
    configured: false,
    email: null,
    displayName: null,
    inboxId: null,
    source: null,
    pinned: !!pin,
    status: null,
    lastError: null,
    reason,
  };
}

// Point the system sender at `inboxId`, or clear it when `inboxId` is null. Owner-gated by
// the route; this is the write itself. Two statements rather than one because the partial
// unique index would reject an overlap: clear first, then set.
// Throws when the column is missing (the migration hasn't landed) or the id is unknown —
// the route turns each into a 409/404 the UI can explain.
export async function setSystemSender(inboxId) {
  if (pinnedSystemSenderEmail()) {
    throw Object.assign(new Error('The sending mailbox is pinned by SYSTEM_SENDER_EMAIL and cannot be changed here.'), { code: 'pinned' });
  }
  if (!(await systemSenderColumnExists())) {
    throw Object.assign(new Error('Email sending has not been provisioned on this deployment yet.'), { code: 'not-provisioned' });
  }
  const sb = getSupabase();
  const clear = await sb.from('inbox_accounts').update({ is_system_sender: false }).eq('is_system_sender', true);
  if (clear.error) throw new Error(clear.error.message);
  if (!inboxId) return { ok: true, inboxId: null };

  const { data, error } = await sb.from('inbox_accounts')
    .update({ is_system_sender: true }).eq('id', inboxId).select('id, email').maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw Object.assign(new Error('That mailbox is not connected.'), { code: 'not-found' });
  return { ok: true, inboxId: data.id, email: data.email };
}

// Test-only.
export function __resetSystemSenderCache() {
  columnCache = { present: false, checkedAt: 0, known: false };
}
