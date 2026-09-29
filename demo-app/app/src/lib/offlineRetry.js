// CS-007 (Critical) — the ONE drain loop both offline write queues run.
//
// THE BUG. `flushChecklistQueue` and `flushMediaQueue` each hand-rolled the same loop and
// each deleted a buffered item whenever the failure was not a transport failure:
//
//     } catch (e) {
//       if (isOfflineError(e)) break;
//       await removeChecklist(it.id);      // ← a 500, a 429 or a 403 destroyed it
//     }
//
// So one cold-start 500, one rate limit, or one 403 from a cleaner who had been
// un-assigned and re-assigned (CS-005) permanently deleted a crew member's submitted
// checklist or their before/after photos, with nothing but a console.warn. Two copies of
// the bug, one of them untested.
//
// THE RULE NOW (THE LAW II.7 offline-queue row · DEV_PLAYBOOK 3.7.11 / 4.6):
//   · a TRANSPORT failure stops the pass and keeps everything (retry on reconnect);
//   · 5xx / 429 / 408 / 401 / 403 / a status-less error KEEP the item and back off
//     (exponential, full jitter, capped) — all of them heal on their own;
//   · only a definitive validation 4xx STOPS the retries, and even then the item stays on
//     the device marked `failed`, with Retry and Discard in the UI
//     (components/OfflineQueueFailures). Nothing is ever deleted silently;
//   · one poisoned item never head-of-line-blocks the rest, and a burst of transients
//     trips a small circuit breaker instead of hammering a backend that is down.
//
// Pure: the caller injects send/remove/mark, so both queues and the suites share the
// identical loop (scripts/test-checklist-offline.mjs, scripts/test-media-offline.mjs).
import { isOfflineError } from './netError.js';

// A 4xx that says the REQUEST is wrong. Replaying it can only fail again:
//   400 the body is invalid · 404 the template / site is gone · 422 unprocessable.
// 401 (token mid-refresh), 403 (assignment that heals — CS-005), 408, 409 and 429 are
// NOT here on purpose: each of them can succeed later.
export const QUEUE_STOP_STATUSES = new Set([400, 404, 422]);

export const RETRY_BASE_MS = 30 * 1000;
export const RETRY_CAP_MS = 30 * 60 * 1000;
// A CEILING on the retries. Without one, an item the server always refuses transiently (a
// 403 that never heals, a payload one route deterministically 500s on) retries every half
// hour for the life of the install: never delivered, never surfaced, so the crew are never
// told and can never Retry or Discard it. At this backoff 12 tries is roughly three hours,
// after which it becomes terminal — still ON the device, now visible
// (components/OfflineQueueFailures), and Retry there resets the count.
export const QUEUE_MAX_ATTEMPTS = 12;
// Transients in ONE pass before we stop: the backend or the session is down, so keep the
// rest buffered and try again on the next reconnect / interval rather than hammering.
export const TRANSIENT_BREAKER = 3;

// 'offline' (stop the pass, keep everything) · 'stop' (definitive: stop retrying this one)
// · 'retry' (keep it, back off). Unknown shapes are 'retry': never lose work on a guess.
export function classifyQueueFailure(e, { online } = {}) {
  if (isOfflineError(e, { online })) return 'offline';
  const status = e && Number.isFinite(e.status) ? e.status : null;
  if (status !== null && QUEUE_STOP_STATUSES.has(status)) return 'stop';
  return 'retry';
}

// Exponential with FULL jitter and a ceiling (DEV_PLAYBOOK 3.7.11): attempt 1 → up to
// base, 2 → up to 2×base, … capped at RETRY_CAP_MS, so a fleet of phones coming back on
// one tower does not arrive in lockstep.
export function retryDelayMs(attempts, { random = Math.random } = {}) {
  const n = Math.max(1, Math.min(20, Math.floor(attempts) || 1));
  const ceiling = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * (2 ** (n - 1)));
  return Math.round(ceiling * random());
}

// An item with no (or an unparseable) nextAttemptAt is always due — a malformed field
// must never strand a cleaner's work on the device forever.
export function queueItemDue(item, { now = Date.now() } = {}) {
  const t = item && item.nextAttemptAt ? Date.parse(item.nextAttemptAt) : NaN;
  return !Number.isFinite(t) || t <= now;
}

// Drain `items` through `send`. `remove(id)` clears a synced item; `mark(id, patch)`
// records a backoff or a terminal failure ON the item (never deleting it).
// Returns { flushed, stopped, deferred, failed, offline, breaker }.
export async function drainQueue(items, {
  send, remove, mark, online, now = Date.now, random = Math.random, breaker = TRANSIENT_BREAKER,
} = {}) {
  const out = { flushed: 0, stopped: 0, deferred: 0, failed: 0, offline: false, breaker: false };
  // Known-offline: don't spend a request per item to learn it (and don't let a stubbed
  // transport look like a success). `online` undefined reads navigator.onLine.
  if (isOfflineError(null, { online })) { out.offline = true; return out; }
  let transients = 0;
  for (const it of items || []) {
    if (!it || !it.id) continue;
    if (it.failed) { out.failed += 1; continue; }             // terminal; the UI owns it now
    if (!queueItemDue(it, { now: now() })) { out.deferred += 1; continue; }
    try {
      await send(it);
      await remove(it.id);
      out.flushed += 1;
    } catch (e) {
      const kind = classifyQueueFailure(e, { online });
      if (kind === 'offline') { out.offline = true; break; }
      const message = e?.message || String(e);
      if (kind === 'stop') {
        await mark(it.id, {
          failed: true, error: message, errorStatus: e?.status ?? null, failedAt: new Date(now()).toISOString(),
        });
        out.stopped += 1;
        continue;
      }
      const attempts = (it.attempts || 0) + 1;
      if (attempts > QUEUE_MAX_ATTEMPTS) {
        // It has had its hours. Stop retrying, keep the work, and SHOW it.
        await mark(it.id, {
          failed: true, attempts, error: message, errorStatus: e?.status ?? null,
          failedAt: new Date(now()).toISOString(), nextAttemptAt: null,
        });
        out.stopped += 1;
        continue;
      }
      await mark(it.id, {
        attempts,
        lastError: message,
        lastStatus: e?.status ?? null,
        nextAttemptAt: new Date(now() + retryDelayMs(attempts, { random })).toISOString(),
      });
      out.deferred += 1;
      transients += 1;
      // CONTINUE, not break, so one deterministically-failing item can't block the rest —
      // until the breaker says the backend itself is the problem.
      if (transients >= breaker) { out.breaker = true; break; }
    }
  }
  return out;
}
