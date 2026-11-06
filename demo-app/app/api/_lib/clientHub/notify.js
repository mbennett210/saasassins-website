// THE CLIENT HUB'S EMAILS — who gets one, and the sending (HUB-11). The words are pure and live
// in src/lib/clientHubEmails.js; this module decides the recipients and sends.
//
// Matt, 2026-09-29: "Which updates should clients get by email? — (a) A ticket they sent
// changes status or gets a reply; (b) A new inspection is posted." ★ So three triggers, all
// fired by the OFFICE's routes (api/qc) after their write has committed:
//
//   emailTicketStageChanged  a client ticket moved to a new client STAGE → the client user who
//                            raised it. The office's own internal tickets email nobody.
//   emailTicketReplied       a staff REPLY on a client ticket → that client user. 🔴 An internal
//                            note (WO-9) never reaches this function: the route does not call
//                            it for one, and it refuses one again here.
//   emailInspectionPosted    a FIRST submit (never an edit) → every client user who can see the
//                            building (direct or through a group), one email each, so no
//                            recipient sees another's address. 🔴 Never the internal note:
//                            nothing here reads the inspection's note column, and the copy
//                            builders take no free-text field from the inspection at all.
//   emailMessageReplied      (client hub redesign) the OFFICE wrote in a building's Messages →
//                            every client user who can see the building.
// Each customer login chooses which of these it gets (lib/hubEmailPrefs.js, plan §3.4); every
// sender asks `hubEmailEnabled` first, and a login that never chose gets them all.
//
// HOW IT SENDS. Through the Google system sender (api/_lib/email.js sendTransactional). With no
// sender connected the send is SKIPPED with a server log (fail-closed), and every function here
// is BEST-EFFORT: it never throws and never fails the write that triggered it. English only
// (LANG-8: "Documents for clients… — English only"). A disabled client user is never emailed.
//
// THE LINK comes from configuration and never from a request (DEV_PLAYBOOK 3.4.18): the app's
// public address, appPublicUrl() — APP_PUBLIC_URL, else APP_BASE_URL, else the brand pack's own
// app address (IDENTITY.appUrl). A malformed one yields no link (clientHubEmails.hubAppLink).
import { sendTransactional } from '../email.js';
import { appPublicUrl } from '../appUrl.js';
import { getClientUserById, clientUsersWhoCanSee } from './store.js';
import { clientUserHasAccess, hubPersonName } from '../../../src/lib/clientHub.js';
import { woClientStage } from '../../../src/lib/workOrders.js';
import { resultLabel } from '../../../src/lib/inspections.js';
import {
  hubTicketStatusEmail, hubTicketReplyEmail, hubInspectionEmail,
  hubAppLink, hubTicketPath, hubInspectionPath,
} from '../../../src/lib/clientHubEmails.js';
import { IDENTITY } from '../../../src/brand/identity.generated.js';
// The client hub redesign (plan §3.4): each customer login chooses its own emails. EVERY sender
// here asks this one reader before sending — null or a missing switch means ON (Matt's HUB-11
// answer stays the default). The kinds: 'requests' (stage + reply), 'inspections', 'messages'.
import { hubEmailEnabled } from '../../../src/lib/hubEmailPrefs.js';
import { hubMessageReplyEmail, hubMessagesPath } from '../../../src/lib/clientHubEmails.js';

// ── the sender, and its test seam ─────────────────────────────────────────────
// The real mailer hands the HTML version to the system sender. A suite swaps in a fake that
// records { to, subject, body (text), html }; passing null restores the real one, which with no
// mailbox connected SKIPS — exactly the production behaviour E12 holds.
const realMailer = ({ to, subject, html }) => sendTransactional({ to, subject, body: html, tags: ['client-hub'] });
let mailerOverride = null;
export function __setHubMailerForTests(fn) { mailerOverride = typeof fn === 'function' ? fn : null; }

async function send(to, message, what) {
  try {
    const mailer = mailerOverride || realMailer;
    const r = await mailer({ to, subject: message.subject, body: message.text, html: message.html });
    if (r && r.ok === false) {
      // Skipped (no sender) or refused: say so in the server log, never to the office.
      console.warn(`[hub-email] ${what} not sent${r.skipped ? ' (no system sender)' : ''}: ${r.error || 'unknown'}`);
    }
    return !!(r && r.ok);
  } catch (e) {
    console.error(`[hub-email] ${what} failed:`, e?.message || e);
    return false;
  }
}

const isClientTicket = (p) => !!p && p.origin === 'portal' && !!p.raised_by_client_user_id && !!p.client_id;

// The client user who raised a ticket, if they still have access, an address, and this kind of
// email switched on (lib/hubEmailPrefs).
async function raiserOf(problem, kind) {
  try {
    const u = await getClientUserById(problem.raised_by_client_user_id);
    return u && clientUserHasAccess(u.status) && u.email && hubEmailEnabled(u.email_prefs, kind) ? u : null;
  } catch (e) {
    console.error('[hub-email] client user unreadable:', e?.message || e);
    return null;
  }
}

// ── the three triggers ────────────────────────────────────────────────────────

// `prevStatus` is the status before the office's change. Only a change of client STAGE is
// news (the four stages map one to one onto the statuses today, so this is "the status moved").
export async function emailTicketStageChanged(problem, prevStatus) {
  try {
    if (!isClientTicket(problem)) return false;
    const stage = woClientStage(problem.status);
    if (prevStatus != null && woClientStage(prevStatus).key === stage.key) return false;
    const to = await raiserOf(problem, 'requests');
    if (!to) return false;
    const message = hubTicketStatusEmail({
      brandName: IDENTITY.name,
      buildingName: problem.client_name || 'your building',
      ticketTitle: problem.title || 'Request',
      stageLabel: stage.label,
      link: hubAppLink(appPublicUrl(), hubTicketPath(problem.client_id, problem.id)),
    });
    return await send(to.email, message, 'ticket stage');
  } catch (e) {
    console.error('[hub-email] ticket stage failed:', e?.message || e);
    return false;
  }
}

// `message` is the stored work_order_messages row. A client's own message and an internal
// note are not replies to the client.
export async function emailTicketReplied(problem, message) {
  try {
    if (!isClientTicket(problem) || !message) return false;
    if (message.internal === true || message.author_role === 'client') return false;
    const to = await raiserOf(problem, 'requests');
    if (!to) return false;
    const mail = hubTicketReplyEmail({
      brandName: IDENTITY.name,
      buildingName: problem.client_name || 'your building',
      ticketTitle: problem.title || 'Request',
      author: hubPersonName(message.author_name),
      replyBody: message.body,
      link: hubAppLink(appPublicUrl(), hubTicketPath(problem.client_id, problem.id)),
    });
    return await send(to.email, mail, 'ticket reply');
  } catch (e) {
    console.error('[hub-email] ticket reply failed:', e?.message || e);
    return false;
  }
}

// `rec` is the stored inspection_records row; only the fields named here are read. Returns how
// many were sent.
export async function emailInspectionPosted(rec) {
  try {
    if (!rec || rec.status !== 'submitted' || !rec.client_id) return 0;
    const people = (await clientUsersWhoCanSee(rec.client_id))
      .filter((u) => u && u.email && clientUserHasAccess(u.status) && hubEmailEnabled(u.email_prefs, 'inspections'));
    if (!people.length) return 0;
    const mail = hubInspectionEmail({
      brandName: IDENTITY.name,
      buildingName: rec.client_name || 'your building',
      inspectionName: rec.template_snapshot?.name || 'Inspection',
      resultLabel: resultLabel(rec.result),
      score: Number.isFinite(rec.overall_score) ? rec.overall_score : null,
      link: hubAppLink(appPublicUrl(), hubInspectionPath(rec.client_id, rec.id)),
    });
    const sent = await Promise.all(people.map((u) => send(u.email, mail, 'inspection posted')));
    return sent.filter(Boolean).length;
  } catch (e) {
    console.error('[hub-email] inspection posted failed:', e?.message || e);
    return 0;
  }
}

// ── Builder B: the office answered in a building's Messages (client hub redesign, plan §3.4) ──
// Fired by POST /api/client-messages/send after the line is saved. Every customer login that can
// see the building (`clientUsersWhoCanSee`, the hub's own scope rule) and kept "Replies from the
// office" on (`messages`), one email each. Only a STAFF line is a reply: a customer's own line
// emails nobody. Best-effort like the three above; returns how many were sent.
export async function emailMessageReplied({ clientId, clientName = '', message } = {}) {
  try {
    if (!clientId || !message || message.author_role !== 'staff') return 0;
    const people = (await clientUsersWhoCanSee(clientId))
      .filter((u) => u && u.email && clientUserHasAccess(u.status) && hubEmailEnabled(u.email_prefs, 'messages'));
    if (!people.length) return 0;
    const mail = hubMessageReplyEmail({
      brandName: IDENTITY.name,
      buildingName: clientName || 'your building',
      author: hubPersonName(message.author_name),
      replyBody: message.body,
      link: hubAppLink(appPublicUrl(), hubMessagesPath(clientId)),
    });
    const sent = await Promise.all(people.map((u) => send(u.email, mail, 'message reply')));
    return sent.filter(Boolean).length;
  } catch (e) {
    console.error('[hub-email] message reply failed:', e?.message || e);
    return 0;
  }
}
