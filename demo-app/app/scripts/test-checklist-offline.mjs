// The crew checklist offline queue (audit C1) — its two decisions:
//
//  1. SUBMIT: buffer or surface? A TRANSPORT failure (offline / a fetch that never
//     reached the server) is buffered and replayed on reconnect; a real server ANSWER
//     is surfaced to the crew there and then (netError.isOfflineError).
//  2. DRAIN (CS-007, Critical): what a failed REPLAY does to the buffered item. Until
//     this suite changed, the drain deleted the item on ANY non-transport error — a
//     single 500, 429 or 403 permanently destroyed a crew member's submitted checklist
//     with no trace, and THIS TEST PINNED IT (`'500 → do NOT buffer'` was read as
//     licence to drop). A 5xx / 429 / 408 / 401 / 403 now KEEPS the item and backs off;
//     only a definitive validation 4xx stops the retries, and even then the item stays
//     on the device, marked failed, with Retry and Discard in the UI. Never deleted
//     silently (THE LAW II.7 offline-queue row; DEV_PLAYBOOK 4.6).
//
// The drain loop is ONE pure function shared by both queues (lib/offlineRetry.drainQueue);
// the media twin is scripts/test-media-offline.mjs.
//
//   node app/scripts/test-checklist-offline.mjs
import { readFileSync } from 'node:fs';
import { isOfflineError } from '../src/lib/netError.js';
import {
  drainQueue, classifyQueueFailure, retryDelayMs, queueItemDue,
  QUEUE_STOP_STATUSES, QUEUE_MAX_ATTEMPTS, RETRY_BASE_MS, RETRY_CAP_MS, TRANSIENT_BREAKER,
} from '../src/lib/offlineRetry.js';

let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) pass += 1; else fails.push(d ? `${n} — ${d}` : n); };
const eq = (n, got, want) => ok(n, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── 1. SUBMIT: buffer or surface (unchanged) ─────────────────────────────────
ok('offline flag → buffer', isOfflineError(new Error('anything'), { online: false }) === true);
ok('offline flag + null error → buffer', isOfflineError(null, { online: false }) === true);
ok('fetch TypeError while online → buffer', isOfflineError(new TypeError('Failed to fetch'), { online: true }) === true);
ok('"Load failed" (Safari) → buffer', isOfflineError(new Error('Load failed'), { online: true }) === true);
// …but Supabase Storage's own rejections end in the same two words and are NOT transport.
ok('"Upload failed" (Storage rejection) → NOT transport', isOfflineError(new Error('Upload failed'), { online: true }) === false);
ok('"Download failed" (Storage rejection) → NOT transport', isOfflineError(new Error('Download failed'), { online: true }) === false);
ok('"NetworkError" (Firefox) → buffer', isOfflineError(new Error('NetworkError when attempting to fetch resource'), { online: true }) === true);
ok('403 "Not your account" → surface, do not buffer', isOfflineError(new Error('Not your account'), { online: true }) === false);
ok('404 "Template not found" → surface, do not buffer', isOfflineError(new Error('Template not found'), { online: true }) === false);
ok('400 publish-first → surface, do not buffer', isOfflineError(new Error('Publish the checklist template first'), { online: true }) === false);
ok('500 → surface at SUBMIT (the crew can retry); the DRAIN keeps it, see below',
  isOfflineError(new Error('Request failed (500)'), { online: true }) === false);
ok('null error while online → do NOT buffer', isOfflineError(null, { online: true }) === false);

// ── 2. DRAIN: classify a failed replay ──────────────────────────────────────
const httpErr = (status) => Object.assign(new Error(`Request failed (${status})`), { status });

for (const s of [500, 502, 503, 504, 429, 408, 401, 403]) {
  eq(`drain: ${s} → retry (item KEPT)`, classifyQueueFailure(httpErr(s), { online: true }), 'retry');
}
for (const s of [400, 404, 422]) {
  eq(`drain: ${s} → stop (definitive validation 4xx)`, classifyQueueFailure(httpErr(s), { online: true }), 'stop');
}
eq('drain: a transport failure → offline (stop the pass, keep everything)',
  classifyQueueFailure(new TypeError('Failed to fetch'), { online: true }), 'offline');
eq('drain: navigator offline → offline', classifyQueueFailure(httpErr(500), { online: false }), 'offline');
eq('drain: a status-less non-transport error → retry, never a silent drop',
  classifyQueueFailure(new Error('Upload failed'), { online: true }), 'retry');
ok('drain: 403 is NOT a stop status (an un-assigned cleaner is re-assigned — CS-005)',
  !QUEUE_STOP_STATUSES.has(403));
ok('drain: 500 is NOT a stop status', !QUEUE_STOP_STATUSES.has(500));
ok('drain: 429 is NOT a stop status', !QUEUE_STOP_STATUSES.has(429));

// Backoff: exponential, full jitter, capped.
const noJitter = { random: () => 1 };
eq('backoff: first retry is the base delay', retryDelayMs(1, noJitter), RETRY_BASE_MS);
eq('backoff: doubles', retryDelayMs(2, noJitter), RETRY_BASE_MS * 2);
ok('backoff: capped', retryDelayMs(40, noJitter) === RETRY_CAP_MS);
ok('backoff: full jitter never exceeds the ceiling',
  Array.from({ length: 200 }, () => retryDelayMs(3)).every((d) => d >= 0 && d <= RETRY_BASE_MS * 4));
ok('an item with no nextAttemptAt is due', queueItemDue({}, { now: 1000 }) === true);
ok('an item backing off is not due', queueItemDue({ nextAttemptAt: new Date(5000).toISOString() }, { now: 1000 }) === false);
ok('an item whose backoff elapsed is due', queueItemDue({ nextAttemptAt: new Date(500).toISOString() }, { now: 1000 }) === true);
ok('a garbage nextAttemptAt never strands an item', queueItemDue({ nextAttemptAt: 'soon' }, { now: 1000 }) === true);

// ── 3. DRAIN over real checklist-shaped items ───────────────────────────────
const item = (id, p = {}) => ({ id, payload: { templateId: 'it_a', jobId: 'j1', items: [] }, createdAt: '2026-09-27T12:00:00.000Z', ...p });
function rig({ fail = () => null } = {}) {
  const removed = [];
  const marked = [];
  const sent = [];
  return {
    removed, marked, sent,
    send: async (it) => { sent.push(it.id); const e = fail(it); if (e) throw e; },
    remove: async (id) => { removed.push(id); return true; },
    mark: async (id, patch) => { marked.push({ id, patch }); return true; },
  };
}

let r = rig();
let out = await drainQueue([item('a'), item('b')], { ...r, online: true });
eq('drain: a clean pass flushes both', out.flushed, 2);
eq('drain: and removes both', r.removed.join(','), 'a,b');
eq('drain: nothing marked', r.marked.length, 0);

r = rig({ fail: () => httpErr(500) });
out = await drainQueue([item('a')], { ...r, online: true, now: () => 1000, random: () => 1 });
eq('drain: a 500 KEEPS the item (CS-007 — this is the regression)', r.removed.length, 0);
eq('drain: the 500 is counted as deferred', out.deferred, 1);
eq('drain: the 500 records an attempt', r.marked[0]?.patch?.attempts, 1);
eq('drain: the 500 arms a backoff', r.marked[0]?.patch?.nextAttemptAt, new Date(1000 + RETRY_BASE_MS).toISOString());
ok('drain: the 500 does NOT mark the item failed', r.marked[0]?.patch?.failed !== true);

r = rig({ fail: () => httpErr(429) });
out = await drainQueue([item('a')], { ...r, online: true });
eq('drain: a 429 KEEPS the item', r.removed.length, 0);
eq('drain: the 429 is deferred', out.deferred, 1);

r = rig({ fail: () => httpErr(403) });
await drainQueue([item('a')], { ...r, online: true });
eq('drain: a 403 KEEPS the item (CS-005 heals on re-assignment)', r.removed.length, 0);

r = rig({ fail: () => httpErr(400) });
out = await drainQueue([item('a')], { ...r, online: true, now: () => 2000 });
eq('drain: a definitive 400 stops the retries', out.stopped, 1);
eq('drain: …but the item is NOT deleted', r.removed.length, 0);
eq('drain: …it is marked failed for the UI', r.marked[0]?.patch?.failed, true);
eq('drain: …with its status, for the copy', r.marked[0]?.patch?.errorStatus, 400);

// A ceiling on the retries. Without one, an item that always gets a 5xx or a 403 retries
// every 30 minutes for the life of the install and NEVER reaches the failed-queue card, so
// the crew are never told and can never Retry or Discard it. At this backoff, 12 tries is
// a few hours.
ok('there is a max-attempts ceiling', Number.isInteger(QUEUE_MAX_ATTEMPTS) && QUEUE_MAX_ATTEMPTS > 0);
r = rig({ fail: () => httpErr(500) });
out = await drainQueue([item('a', { attempts: QUEUE_MAX_ATTEMPTS - 1 })], { ...r, online: true, now: () => 3000 });
eq('the last attempt before the ceiling still only defers', out.deferred, 1);
eq('…and arms another backoff', typeof r.marked[0]?.patch?.nextAttemptAt, 'string');
ok('…and does not mark it failed', r.marked[0]?.patch?.failed !== true);

r = rig({ fail: () => httpErr(500) });
out = await drainQueue([item('a', { attempts: QUEUE_MAX_ATTEMPTS })], { ...r, online: true, now: () => 3000 });
eq('at the ceiling a transient becomes terminal', out.stopped, 1);
eq('…the item is STILL not deleted', r.removed.length, 0);
eq('…it is marked failed for Retry / Discard', r.marked[0]?.patch?.failed, true);
eq('…recording the attempts it took', r.marked[0]?.patch?.attempts, QUEUE_MAX_ATTEMPTS + 1);
eq('…and keeping the status that kept failing', r.marked[0]?.patch?.errorStatus, 500);
ok('…and no further backoff is armed', !r.marked[0]?.patch?.nextAttemptAt);

r = rig({ fail: () => httpErr(403) });
out = await drainQueue([item('a', { attempts: QUEUE_MAX_ATTEMPTS + 5 })], { ...r, online: true });
eq('an item already past the ceiling is terminal too', out.stopped, 1);

r = rig();
out = await drainQueue([item('a', { attempts: QUEUE_MAX_ATTEMPTS })], { ...r, online: true });
eq('the ceiling only bites on a FAILURE — a successful send at the ceiling still flushes', out.flushed, 1);

r = rig();
out = await drainQueue([item('a', { failed: true }), item('b')], { ...r, online: true });
eq('drain: an already-failed item is skipped, never re-sent', r.sent.join(','), 'b');
eq('drain: the failed item is reported', out.failed, 1);

r = rig();
out = await drainQueue([item('a', { nextAttemptAt: new Date(9e12).toISOString() }), item('b')], { ...r, online: true, now: () => 1000 });
eq('drain: an item still backing off is skipped this pass', r.sent.join(','), 'b');
eq('drain: …and counted as deferred', out.deferred, 1);

r = rig({ fail: (it) => (it.id === 'a' ? new TypeError('Failed to fetch') : null) });
out = await drainQueue([item('a'), item('b')], { ...r, online: true });
eq('drain: a transport failure stops the pass (still offline)', r.sent.join(','), 'a');
eq('drain: nothing removed while offline', r.removed.length, 0);
eq('drain: the pass reports offline', out.offline, true);

r = rig({ fail: (it) => (it.id === 'a' ? httpErr(500) : null) });
out = await drainQueue([item('a'), item('b')], { ...r, online: true });
eq('drain: one 500 never head-of-line-blocks the rest', r.removed.join(','), 'b');
eq('drain: the later item flushed', out.flushed, 1);

r = rig({ fail: () => httpErr(503) });
const manyItems = Array.from({ length: TRANSIENT_BREAKER + 4 }, (_, i) => item(`k${i}`));
out = await drainQueue(manyItems, { ...r, online: true });
eq(`drain: the circuit breaker stops after ${TRANSIENT_BREAKER} transients in one pass`, r.sent.length, TRANSIENT_BREAKER);
ok('drain: the breaker is reported', out.breaker === true);

r = rig();
out = await drainQueue([item('a')], { ...r, online: false });
eq('drain: offline before the first send — nothing is sent', r.sent.length, 0);
eq('drain: and the pass says offline', out.offline, true);

// ── 4. the queue's UI contract ───────────────────────────────────────────────
const qcSrc = readFileSync(new URL('../src/lib/qcApi.js', import.meta.url), 'utf8');
ok('flushChecklistQueue runs the shared drain, not its own loop', /drainQueue\(/.test(qcSrc));
ok('the old unconditional drop is gone',
  !/dropping un-syncable checklist/.test(qcSrc) && !/if \(isOfflineError\(e\)\) break;[\s\S]{0,400}removeChecklist/.test(qcSrc));
const queueSrc = readFileSync(new URL('../src/lib/checklistQueue.js', import.meta.url), 'utf8');
ok('checklistQueue can record a failure on an item (updateChecklist)', /export async function updateChecklist\b/.test(queueSrc));

for (const f of fails) console.error(`✖ ${f}`);
console.log(`\n${pass}/${pass + fails.length} checklist-offline cases green`);
process.exit(fails.length ? 1 : 0);
