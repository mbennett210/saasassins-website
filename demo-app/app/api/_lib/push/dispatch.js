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
import { readOrgState, writeOrgState } from '../orgState.js';
import { listSubscriptions, sendToSubscriptions } from './store.js';
import { IDENTITY } from '../../../src/brand/identity.generated.js';

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

    const pending = notifications.filter((n) => !n.pushed).slice(0, MAX_PER_RUN);
    if (pending.length === 0) return { toSend: [], users };

    const pushedIds = new Set(pending.map((n) => n.id));
    const next = notifications.map((n) => (pushedIds.has(n.id) ? { ...n, pushed: true } : n));
    const ok = await writeOrgState({ ...state, notifications: next }, version);
    if (!ok) continue; // version moved under us — re-read and retry the claim (no sends happened)

    const cutoff = Date.now() - FRESH_MS;
    const toSend = pending.filter(
      (n) => !n.readAt && new Date(n.createdAt).getTime() >= cutoff,
    );
    return { toSend, users, claimed: pushedIds.size };
  }
  throw new Error('org_state write kept conflicting (too much concurrent activity)');
}

export async function dispatchDue() {
  const { toSend, users, claimed = 0 } = await claimPending();
  if (!toSend.length) return { claimed, sent: 0 };

  // Group eligible rows by recipient (active + master opt-in).
  const byUser = new Map();
  for (const n of toSend) {
    const u = (users || []).find((x) => x.id === n.userId);
    if (!u || u.status !== 'active') continue;
    if ((u.notificationPrefs || {}).mobilePushEnabled === false) continue;
    if (!byUser.has(n.userId)) byUser.set(n.userId, []);
    byUser.get(n.userId).push(n);
  }

  let sent = 0;
  for (const [userId, rows] of byUser) {
    let subs = [];
    try { subs = await listSubscriptions(userId); } catch { subs = []; }
    if (!subs.length) continue;
    if (rows.length <= MAX_INDIVIDUAL_PUSH) {
      // Send each as its own banner (per-row unique tag — never collapse two
      // DISTINCT events into one).
      for (const n of rows) {
        const r = await sendToSubscriptions(subs, {
          title: n.title || IDENTITY.wordmark,
          body: n.body || '',
          url: n.url || '/',
          tag: n.id,
        });
        sent += r.delivered;
      }
    } else {
      // Coalesce a burst (e.g. many accrued while the tab was closed) into one
      // digest banner so the phone isn't flooded.
      const r = await sendToSubscriptions(subs, {
        title: `${rows.length} new notifications`,
        body: `Open ${IDENTITY.wordmark} to catch up.`,
        url: '/',
        tag: 'cleanspace-digest',
      });
      sent += r.delivered;
    }
  }
  return { claimed, sent };
}
