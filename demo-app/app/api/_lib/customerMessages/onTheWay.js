// "ON MY WAY" — the cleaner's button in the Cleaner Hub. Two branches of api/time (EP-422 /
// EP-423), both behind requireAuthority. Since Crew on the way (lib/crewOnTheWay.js; Daniel's Oct 28
// call and his picks 2026-11-03) one tap tells the building's customers three ways: a line in the
// customer hub's bell, a phone alert to the logins that turned alerts on, and Matt's approved text
// (2026-10-19) to the clean's site contact, as before.
//
//   onMyWayStatus  GET  ?jobIds=a,b   → { available, canTell: [jobId], sent: [jobId] }
//                  `canTell`: the cleans whose customers someone can be told on (a hub login that
//                  can see the building, or the text: Twilio set up, the template on, a number) —
//                  the button shows only on those (`available`: any of them). A cleaner is asked
//                  about their OWN cleans only. `sent`: which of those already told their customer.
//   onMyWaySend    POST { jobId }     → { sent: true[, already] } or a refusal with a code
//                  CREW only (the claim's role and u_* id; the office's View-as never sends), on a
//                  clean the cleaner is ON, still upcoming, on today's list in the ORG's zone. Then:
//                    1. THE BELL, which is also the claim: the activity log row for the clean, its
//                       id the clean's (onTheWayNoticeId), written at most once (two taps or two
//                       phones write one; _lib/activityLog logActivityOnce);
//                    2. THE PHONE ALERT, when this tap wrote the row: the building's hub logins'
//                       phones (clientHub/push sendClientAlert), best-effort;
//                    3. THE TEXT, as built: the walkers' own rule (lib/reminderScheduler
//                       onTheWayItem), CLAIMED in the sent log (`on_the_way:<jobId>`) and sent
//                       through THE send step (a sample record, or a number that replied STOP, is
//                       refused there). A failed text is tried again on the next tap.
//                  Told nobody (no hub login, and the text refused or failed) → the refusal, so the
//                  cleaner can try again.
// Rate: ON_MY_WAY_RATE per login (in-process). The phone number and the words never come back.
import { createHash } from 'node:crypto';
import { readOrgState } from '../orgState.js';
import { getJobById, getJobsByIds } from '../jobsTable.js';
import { smsConfigured } from '../sms/twilio.js';
import { sendCustomerMessage } from './send.js';
import { MESSAGE_STATUS, readMessages, insertNew, claimExisting, finishMessage } from './store.js';
import { hit } from '../rateLimit.js';
import { reportError } from '../monitor.js';
import { logActivityOnce, activityIdsPresent, actorNameFor } from '../activityLog.js';
import { clientUsersWhoCanSee } from '../clientHub/store.js';
import { sendClientAlert } from '../clientHub/push.js';
import { onTheWayItem, messageKey } from '../../../src/lib/reminderScheduler.js';
import { MESSAGE_KEY } from '../../../src/lib/customerMessages.js';
import { OPTED_OUT_REASON, SAMPLE_RECORD_REASON } from '../../../src/lib/texting.js';
import { JOB_STATUS } from '../../../src/lib/jobStatus.js';
import { isOnTodayList } from '../../../src/lib/clockInWindow.js';
import { dayKey } from '../../../src/lib/dates.js';
import { ON_THE_WAY_ACTION, onTheWayEta, onTheWayAlert, onTheWaySummary, canTellCustomer } from '../../../src/lib/crewOnTheWay.js';
import { idListParam, idParam } from '../queryParams.js';

export const ON_MY_WAY_RATE = { limit: 10, windowMs: 60 * 1000 };
export const ON_MY_WAY_MAX_JOBS = 30;
export const ON_MY_WAY_CODES = Object.freeze({
  crewOnly: 'crew-only', notFound: 'not-found', notYours: 'not-your-clean', notUpcoming: 'not-upcoming',
  notToday: 'not-today', notSent: 'not-sent', bad: 'bad-request', rate: 'rate-limited',
  // Nobody to tell: no customer login can see the building, and the text can't go (texting not set
  // up, the text off, or no number). The button doesn't show then (onMyWayStatus canTell).
  nobody: 'nobody',
  // The customer's number replied STOP (sms_opt_outs) and nobody is in the hub: nothing to retry.
  optedOut: 'opted-out',
});
const C = ON_MY_WAY_CODES;
const refuse = (status, code, error) => ({ status, body: { error, code } });
const optedOut = () => refuse(409, C.optedOut, 'This customer has turned off texts.');
const keyOf = (jobId) => messageKey(MESSAGE_KEY.onTheWay, jobId);
const templateOn = (state) => (state.reminderTemplates || []).some((t) => t?.key === MESSAGE_KEY.onTheWay && t.enabled === true);

// The clean's bell row's id: a name-based UUID (version 5) of `on_the_way:<jobId>`, so the row is
// the claim — the activity log's primary key refuses a second one.
const NOTICE_NAMESPACE = Buffer.from('3b0f6a2e5c1d4e8f9a7b6c5d4e3f2a1b', 'hex');
export function onTheWayNoticeId(jobId) {
  const h = createHash('sha1').update(NOTICE_NAMESPACE).update(`on_the_way:${jobId}`, 'utf8').digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

// The customer logins that can see a building, once per request per building.
function audienceReader() {
  const seen = new Map();
  return (clientId) => {
    if (!clientId) return Promise.resolve([]);
    if (!seen.has(clientId)) seen.set(clientId, clientUsersWhoCanSee(clientId).catch((e) => { reportError('on_my_way.audience_failed', e, { clientId }); return []; }));
    return seen.get(clientId);
  };
}

export async function onMyWayStatus(a, query = {}, { now = new Date() } = {}) {
  const ids = idListParam(query.jobIds, ON_MY_WAY_MAX_JOBS);
  if (ids === undefined) return refuse(400, C.bad, 'jobIds is malformed');
  if (!ids?.length) return { status: 200, body: { available: false, canTell: [], sent: [] } };
  const [{ state }, jobs] = await Promise.all([readOrgState(), getJobsByIds(ids)]);
  const textOn = smsConfigured() && templateOn(state);
  const audienceOf = audienceReader();
  // A cleaner is answered about the cleans they are on; anyone else's ids answer nothing.
  const asked = ids.map((id) => jobs.get(id)).filter((j) => j && (a.role !== 'crew' || (j.crewIds || []).includes(a.orgUserId)));
  const canTell = [];
  for (const job of asked) {
    const textReady = textOn && !!onTheWayItem(state, job, now).item;
    const hubLogins = textReady ? 0 : (await audienceOf(job.clientId)).length;
    if (canTellCustomer({ hubLogins, textReady })) canTell.push(job.id);
  }
  let sent = [];
  if (canTell.length) {
    const [notices, rows] = await Promise.all([
      activityIdsPresent(canTell.map(onTheWayNoticeId)),
      readMessages(canTell.map(keyOf)),
    ]);
    sent = canTell.filter((id) => notices.has(onTheWayNoticeId(id)) || rows.get(keyOf(id))?.status === MESSAGE_STATUS.sent);
  }
  return { status: 200, body: { available: canTell.length > 0, canTell, sent } };
}

// The text, as built: 'sent' | 'already' | 'opted-out' | 'refused' | 'failed'.
async function sendText(d) {
  const won = await insertNew([{
    id: d.id, templateKey: d.templateKey, channel: d.channel, clientId: d.refs.clientId, contactId: d.refs.contactId,
    jobId: d.refs.jobId, recipient: d.recipient, status: MESSAGE_STATUS.sending, attempts: 1, keepUntil: d.keepUntil,
  }]);
  if (!won.has(d.id)) {
    // Sent already (or being sent by the other tap): say so. A failed one is tried again.
    const prev = (await readMessages([d.id])).get(d.id);
    if (prev?.status === MESSAGE_STATUS.refused && prev.failure_reason === OPTED_OUT_REASON) return 'opted-out';
    if (prev?.status !== MESSAGE_STATUS.failed || !(await claimExisting(prev, new Date().toISOString()))) {
      return prev?.status === MESSAGE_STATUS.sent || prev?.status === MESSAGE_STATUS.sending ? 'already' : 'failed';
    }
  }
  const res = await sendCustomerMessage({ templateKey: d.templateKey, channel: d.channel, to: d.recipient, body: d.body, refs: d.refs });
  const at = new Date().toISOString();
  if (res.ok) {
    await finishMessage(d.id, { status: MESSAGE_STATUS.sent, providerMessageId: res.id || null }, at);
    return 'sent';
  }
  if (res.optedOut) {
    await finishMessage(d.id, { status: MESSAGE_STATUS.refused, failureReason: OPTED_OUT_REASON }, at);
    return 'opted-out';
  }
  await finishMessage(d.id, { status: res.refused ? MESSAGE_STATUS.refused : MESSAGE_STATUS.failed, failureReason: res.refused ? SAMPLE_RECORD_REASON : (res.error || res.skipped || 'Send failed') }, at);
  return res.refused ? 'refused' : 'failed';
}

export async function onMyWaySend(a, body = {}, { now = new Date() } = {}) {
  if (a.role !== 'crew' || !a.orgUserId) return refuse(403, C.crewOnly, 'Only the cleaner on the clean can send this.');
  const r = hit(`on-my-way:${a.orgUserId}`, ON_MY_WAY_RATE);
  if (!r.ok) return refuse(429, C.rate, 'Too many requests. Please try again shortly.');
  const jobId = idParam(body.jobId);
  if (!jobId) return refuse(400, C.bad, 'jobId is required');
  const job = await getJobById(jobId);
  if (!job) return refuse(404, C.notFound, 'That clean no longer exists.');
  if (!(job.crewIds || []).includes(a.orgUserId)) return refuse(403, C.notYours, 'You are not on this clean.');
  if (job.status !== JOB_STATUS.UPCOMING) return refuse(409, C.notUpcoming, 'This clean has already started or ended.');
  const { state } = await readOrgState();
  const tz = state.company?.timezone;
  if (!isOnTodayList(job, dayKey(now, tz), now.getTime(), state.opsSettings?.autoCloseGraceMins, tz)) return refuse(409, C.notToday, 'This clean is not on today’s list.');

  const textItem = smsConfigured() && templateOn(state) ? onTheWayItem(state, job, now).item || null : null;
  const logins = job.clientId ? await clientUsersWhoCanSee(job.clientId) : [];
  if (!canTellCustomer({ hubLogins: logins.length, textReady: !!textItem })) {
    return refuse(409, C.nobody, 'Nobody at this building has the app or a number to text yet.');
  }

  // 1. The bell — and the claim: one row per clean.
  const building = (state.clients || []).find((c) => c?.id === job.clientId) || null;
  const buildingName = building?.name || '';
  const eta = onTheWayEta(job, now.getTime());
  const actorName = await actorNameFor(a.orgUserId);
  const claim = await logActivityOnce(onTheWayNoticeId(job.id), {
    action: ON_THE_WAY_ACTION,
    entityId: job.id,
    clientId: job.clientId || null,
    clientName: buildingName || null,
    actorUserId: a.orgUserId,
    actorRole: a.role,
    actorName,
    summary: onTheWaySummary({ actorName, buildingName }),
    after: { eta, siteId: job.siteId || null },
    occurredAt: now.toISOString(),
  });

  // 2. The phone alert, from the tap that wrote the row (a second tap rings nobody again).
  if (claim === 'won' && logins.length) {
    try {
      await sendClientAlert(logins.map((u) => u.id), onTheWayAlert({ buildingId: job.clientId, buildingName, eta, tz, jobId: job.id }));
    } catch (e) {
      reportError('on_my_way.alert_failed', e, { jobId: job.id });
    }
  }

  // 3. The text, as built.
  const text = textItem ? await sendText(textItem) : null;

  const hubTold = logins.length > 0 && claim !== 'failed';
  if (!hubTold && text !== 'sent' && text !== 'already') {
    if (text === 'opted-out') return optedOut();
    // A sample record is refused for good (409); a failed text, or a bell that didn't land with no
    // text to send, is worth another tap.
    return refuse(text === 'refused' ? 409 : text ? 502 : 503, C.notSent, 'It didn’t go. Try again in a minute.');
  }
  const already = claim === 'already' && (text === null || text === 'already');
  return { status: 200, body: already ? { sent: true, already: true } : { sent: true } };
}
