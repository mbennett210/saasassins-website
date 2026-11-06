// Shared push-dispatch core: CAS-claim the bell-inbox notification rows that have
// not been pushed yet, then send OS Web Push for the eligible ones. Used by BOTH
// the every-minute cron (api/push/dispatch) AND the authed instant-flush endpoint
// (api/push/flush), so a just-created message notification can go out in ~1s
// instead of waiting for the next cron tick.
//
// RESERVE-THEN-SEND: claim the rows (flip `pushed:true`) FIRST under CAS, then send
// OUTSIDE the retry loop. A concurrent run (cron and a flush overlapping) therefore
// never double-sends — whoever claims a row first owns its single send; the other
// finds it already pushed. The tradeoff is a rare marked-but-unsent row if the send
// crashes after a successful claim, strictly better than duplicate phone banners.
//
// Eligibility to actually SEND a claimed row: recipient active, mobilePushEnabled
// !== false (master opt-out), unread, and fresh (created within FRESH_MS so a
// dispatcher outage doesn't replay a huge historical backlog on recovery). Per-event
// opt-in / role gating already happened when the row was created (lib/notifications
// fan-out), so it is not re-checked here.
//
// 🔴 QUIET HOURS + OFFICE HOURS + TEXTS live HERE (NTF-2, WO-7, NTF-1 — Matt, 2026-09-29).
// This is the one place a bell row becomes something that buzzes in a pocket, so it is the one
// place that can decide whether it may. The POLICY is pure and shared with the settings
// screens (src/lib/alertDelivery.js); this file only enforces it:
//   • a row held for a manager's quiet hours, or a non-urgent ticket alert outside the org's
//     office hours, is CLAIMED and NOT SENT — the bell row stays, unread, and is found in the
//     morning. There is no deferred queue on purpose: reserve-then-send means a skipped row is
//     never retried, and a 2 a.m. ping arriving at 7 a.m. is still a ping about 2 a.m.
//   • a missed shift and an urgent ticket ALSO go out as a TEXT (NTF-1), to the phone on the
//     person's profile. The claim covers both channels, so a cron re-run never double-texts.
//
// LANGUAGE (CS-193, LANG-4): a row's title and body were written in its recipient's language
// (lib/notifications), so the push and the text send them as they are; the one sentence this
// file composes itself — the burst digest — is rendered in that person's language here.
import { readOrgState, writeOrgState } from '../orgState.js';
import { listSubscriptions, sendToSubscriptions } from './store.js';
import { sendSms, smsConfigured } from '../sms/twilio.js';
import { pushHoldReason, smsHoldReason, alertSmsBody } from '../../../src/lib/alertDelivery.js';
import { IDENTITY } from '../../../src/brand/identity.generated.js';
import { translate, userLanguage } from '../i18n.js';

const CAS_RETRIES = 5;
const MAX_PER_RUN = 300;
const FRESH_MS = 6 * 60 * 60 * 1000; // only push rows newer than this; older = claim-only
const MAX_INDIVIDUAL_PUSH = 3;       // above this many for one user in a run, send one digest banner

// CAS-claim all unpushed rows (mark pushed:true). Returns the rows eligible to
// actually send, plus the users list for recipient resolution.
async function claimPending() {
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const { state, version } = await readOrgState();
    const notifications = Array.isArray(state.notifications) ? state.notifications : [];
    const users = Array.isArray(state.users) ? state.users : [];

    // The quiet-hours / office-hours window and the org's zone come off the SAME read, so the
    // hour a row is judged against is the one that was committed when it was claimed.
    const opsSettings = state.opsSettings || {};
    const timeZone = state.company?.timezone || null;

    const pending = notifications.filter((n) => !n.pushed).slice(0, MAX_PER_RUN);
    if (pending.length === 0) return { toSend: [], users, opsSettings, timeZone };

    const pushedIds = new Set(pending.map((n) => n.id));
    const next = notifications.map((n) => (pushedIds.has(n.id) ? { ...n, pushed: true } : n));
    const ok = await writeOrgState({ ...state, notifications: next }, version);
    if (!ok) continue; // version moved under us — re-read and retry the claim (no sends happened)

    const cutoff = Date.now() - FRESH_MS;
    const toSend = pending.filter(
      (n) => !n.readAt && new Date(n.createdAt).getTime() >= cutoff,
    );
    return { toSend, users, claimed: pushedIds.size, opsSettings, timeZone };
  }
  throw new Error('org_state write kept conflicting (too much concurrent activity)');
}

// Stamp the people whose number has replied STOP (Twilio 21610) so nothing texts them again.
// A CAS loop of its own, AFTER the sends: it is a durable record of a carrier's decision, and
// it must not be able to fail the run it rides on — the texts are already out and the next run
// would only re-learn the same refusal. NOT a protected slice, and this is the service role, so
// no org-state guard is in play.
async function markSmsOptedOut(userIds, { now = Date.now() } = {}) {
  const ids = new Set((userIds || []).filter(Boolean));
  if (!ids.size) return 0;
  const stamp = new Date(now).toISOString();
  for (let attempt = 0; attempt < CAS_RETRIES; attempt += 1) {
    const { state, version } = await readOrgState();
    const users = Array.isArray(state.users) ? state.users : [];
    let changed = 0;
    const nextUsers = users.map((u) => {
      if (!u || !ids.has(u.id) || (u.notificationPrefs || {}).smsOptedOut === true) return u;
      changed += 1;
      return { ...u, notificationPrefs: { ...(u.notificationPrefs || {}), smsOptedOut: true, smsOptedOutAt: stamp } };
    });
    if (!changed) return 0;                 // already stamped by an earlier run
    if (await writeOrgState({ ...state, users: nextUsers }, version)) return changed;
  }
  return 0;                                  // gave up quietly; the next opt-out re-learns it
}

// `deps` is injected so the offline suite drives the whole channel matrix with no Supabase, no
// VAPID and no Twilio account (app/scripts/test-alert-sms.mjs). Production calls dispatchDue()
// with every default.
export async function dispatchDue({
  now = Date.now(),
  claim = claimPending,
  subscriptionsFor = listSubscriptions,
  pushTo = sendToSubscriptions,
  text = sendSms,
  textConfigured = smsConfigured,
  markOptedOut = markSmsOptedOut,
} = {}) {
  const { toSend, users, claimed = 0, opsSettings = {}, timeZone = null } = await claim();
  if (!toSend.length) return { claimed, sent: 0, texted: 0 };

  // Group eligible rows by recipient (active + master opt-in), and decide the TEXT channel on
  // the same pass. Push and SMS are judged SEPARATELY: `mobilePushEnabled` is a push pref, and
  // a manager who has turned their phone banners off still wants the 2 a.m. missed-shift text
  // (that is the whole of NTF-1); quiet hours never hold a text back either, because the only
  // two events that text are the two that break through quiet hours by definition.
  const byUser = new Map();
  const smsQueue = [];
  const held = { quietHours: 0, officeHours: 0 };
  for (const n of toSend) {
    const u = (users || []).find((x) => x.id === n.userId);
    if (!u || u.status !== 'active') continue;
    if (textConfigured() && !smsHoldReason({ user: u, eventKey: n.eventKey })) {
      smsQueue.push({ user: u, row: n });
    }
    if ((u.notificationPrefs || {}).mobilePushEnabled === false) continue;
    const hold = pushHoldReason({ user: u, eventKey: n.eventKey, at: now, settings: opsSettings, tz: timeZone });
    if (hold) { held[hold === 'quiet-hours' ? 'quietHours' : 'officeHours'] += 1; continue; }
    if (!byUser.has(n.userId)) byUser.set(n.userId, []);
    byUser.get(n.userId).push(n);
  }

  let sent = 0;
  for (const [userId, rows] of byUser) {
    let subs = [];
    try { subs = await subscriptionsFor(userId); } catch { subs = []; }
    if (!subs.length) continue;
    if (rows.length <= MAX_INDIVIDUAL_PUSH) {
      // Send each as its own banner (per-row unique tag — never collapse two
      // DISTINCT events into one).
      for (const n of rows) {
        const r = await pushTo(subs, {
          // a push is the app's own notification: it names the SOFTWARE (IDENTITY.product, UI_RULES §129)
          title: n.title || IDENTITY.product.wordmark,
          body: n.body || '',
          url: n.url || '/',
          tag: n.id,
        });
        sent += r.delivered;
      }
    } else {
      // Coalesce a burst (e.g. many accrued while the tab was closed) into one
      // digest banner so the phone isn't flooded — in the recipient's language.
      const lang = userLanguage((users || []).find((x) => x.id === userId));
      const r = await pushTo(subs, {
        title: translate(lang, 'push.digest.title', { count: rows.length }),
        body: translate(lang, 'push.digest.body', { brand: IDENTITY.product.wordmark }),
        url: '/',
        tag: 'cleanspace-digest',
      });
      sent += r.delivered;
    }
  }

  // ── The TEXT channel (NTF-1) ────────────────────────────────────────────────
  // One text per claimed row, in addition to the push. Never coalesced into a digest: there
  // are only ever a handful (a missed shift, an urgent ticket), and "2 new notifications" as a
  // text at 2 a.m. tells the supervisor nothing they can act on.
  let texted = 0;
  const optedOut = new Set();
  const smsErrors = [];
  for (const { user, row } of smsQueue) {
    // A text names the COMPANY (IDENTITY.wordmark): it leaves the company's own number, registered for texting
    // (A2P) under the business's name, so the sender a carrier and the reader see is the business.
    const r = await text({ to: user.phone, body: alertSmsBody({ wordmark: IDENTITY.wordmark, title: row.title, body: row.body }) });
    if (r?.ok) { texted += 1; continue; }
    if (r?.optedOut) { optedOut.add(user.id); continue; }
    // Never the credentials, never the number — just the outcome, so a misconfigured campaign
    // is diagnosable from the cron's response without leaking anything.
    if (r?.error || r?.skipped) smsErrors.push(r.code ? `${r.code}` : (r.skipped || 'send_failed'));
  }
  let smsOptedOut = 0;
  if (optedOut.size) {
    try { smsOptedOut = await markOptedOut([...optedOut], { now }); } catch { /* stamped next run */ }
  }

  return {
    claimed, sent, texted,
    ...(smsOptedOut ? { smsOptedOut } : {}),
    ...(smsErrors.length ? { smsErrors: [...new Set(smsErrors)] } : {}),
    ...(held.quietHours || held.officeHours ? { pushHeld: { ...held } } : {}),
  };
}
