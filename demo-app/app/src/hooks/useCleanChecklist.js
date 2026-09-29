import { useCallback, useEffect, useMemo, useState } from 'react';
import * as qcApi from '../lib/qcApi';
import { allChecklists } from '../lib/checklistQueue';
import { checklistFor, clockOutGate, GATE } from '../lib/crewChecklist';
import { readGateMemo, writeGateMemo } from '../lib/checklistGateMemo';
import { useStore } from '../store';
import { selectClientById, selectSiteById, selectUserById } from '../store/selectors';

// ONE read of a clean's checklist submissions, shared by every component on the card.
//
// WHY A MODULE-LEVEL CACHE. The checklist card (CleanChecklist) and the clock button
// (ClockControl) are SIBLINGS — on My Day and in the crew visit they sit in the same clean,
// with no common parent to hold the data. Two useEffect fetches would mean two requests per
// clean per paint on a crew phone, and worse, two answers: the card could show a finished
// checklist while the button still read it as unfinished. So the read lives here, keyed by
// job id, with one in-flight promise and every mounted consumer subscribed to it.
//
// OFFLINE. When the device is offline the read is not attempted at all (`results` stays
// null) — that is what distinguishes "nothing submitted" from "we cannot tell", and the
// gate then judges by the on-device queue and the remembered verdict. Coming back online
// re-reads. The queue projection is device-wide and refreshes on the queue's own events.
//
// The cache is BOUNDED (PERF-30): a crew member's day is a handful of cleans, and an
// un-subscribed job is evicted once the map is over its cap.
const MAX_JOBS = 20;
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

const store = {
  jobs: new Map(), // jobId -> { results, error, loading, promise }
  queued: null,    // device-wide buffered submissions; null = not read yet
  queuedPromise: null,
  subs: new Set(),
};
const bump = () => { for (const fn of [...store.subs]) fn(); };

function entryFor(jobId) {
  let e = store.jobs.get(jobId);
  if (!e) {
    e = { results: null, error: null, loading: false, promise: null, refs: 0 };
    store.jobs.set(jobId, e);
  }
  if (store.jobs.size > MAX_JOBS) {
    for (const [k, v] of store.jobs) {
      if (k !== jobId && v.refs === 0) store.jobs.delete(k);
      if (store.jobs.size <= MAX_JOBS) break;
    }
  }
  return e;
}

function readJob(jobId, { force = false } = {}) {
  const e = entryFor(jobId);
  if (e.promise && !force) return e.promise;
  if (offline()) { e.loading = false; bump(); return Promise.resolve(); }
  e.loading = true;
  bump();
  const p = qcApi.listChecklists({ jobId })
    .then((r) => { e.results = r || []; e.error = null; })
    .catch((err) => { e.error = err?.message || 'Could not read the checklist'; })
    .finally(() => { e.loading = false; if (e.promise === p) e.promise = null; bump(); });
  e.promise = p;
  return p;
}

function readQueued({ force = false } = {}) {
  if (store.queuedPromise && !force) return store.queuedPromise;
  const p = allChecklists()
    .then((rows) => { store.queued = rows || []; })
    .catch(() => { store.queued = []; })
    .finally(() => { if (store.queuedPromise === p) store.queuedPromise = null; bump(); });
  store.queuedPromise = p;
  return p;
}

// Re-read one clean (after a submit) — every subscriber on that card updates together.
export function reloadChecklistResults(jobId) {
  readQueued({ force: true });
  return jobId ? readJob(jobId, { force: true }) : Promise.resolve();
}

export function useChecklistResults(jobId) {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    store.subs.add(fn);
    return () => { store.subs.delete(fn); };
  }, []);

  useEffect(() => {
    if (!jobId) return undefined;
    const e = entryFor(jobId);
    e.refs += 1;
    readJob(jobId);
    readQueued();
    return () => { e.refs = Math.max(0, e.refs - 1); };
  }, [jobId]);

  // The queue's own events, plus a reconnect: both change the answer.
  useEffect(() => {
    const onQueue = () => { readQueued({ force: true }); };
    const onOnline = () => { readQueued({ force: true }); if (jobId) readJob(jobId, { force: true }); };
    window.addEventListener('rfs:checklist-queued', onQueue);
    window.addEventListener('rfs:checklist-flushed', onOnline);
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('rfs:checklist-queued', onQueue);
      window.removeEventListener('rfs:checklist-flushed', onOnline);
      window.removeEventListener('online', onOnline);
    };
  }, [jobId]);

  const e = jobId ? store.jobs.get(jobId) : null;
  const reload = useCallback(() => reloadChecklistResults(jobId), [jobId]);
  return {
    results: jobId ? (e?.results ?? null) : [],
    queued: store.queued,
    loading: !!e?.loading || (!!jobId && store.queued === null && !offline()),
    error: e?.error || null,
    reload,
  };
}

// The clock-out verdict for the ENTRY OWNER on this clean (R4-R6) — the rule
// (lib/crewChecklist clockOutGate) over this card's shared read, the on-device queue and,
// when neither can answer, the phone's remembered verdict (lib/checklistGateMemo).
// `entry` is the open time entry; its `user_id` is the cleaner being judged, so a manager
// closing someone else's punch is never gated here (the server isn't either).
export function useClockOutGate({ job, entry, online = true }) {
  const state = useStore();
  const { results, queued, loading, reload } = useChecklistResults(job?.id || null);

  const userId = entry?.user_id || null;
  const clientId = job?.clientId || (job?.siteId ? selectSiteById(state, job.siteId)?.clientId : null) || null;
  const client = clientId ? selectClientById(state, clientId) : null;
  // step 4b writes user.clockRules; read default-safe until then.
  const rules = userId ? (selectUserById(state, userId)?.clockRules || null) : null;
  const checklistId = useMemo(
    () => (job && userId ? checklistFor({ client, job, userId }) : null),
    [client, job, userId],
  );

  const gate = useMemo(() => {
    const live = clockOutGate({ checklistId, rules, results, queued, userId, jobId: job?.id || null });
    if (live.state !== GATE.UNKNOWN) return live;
    // Nothing to judge by right now: fall back to what this phone last knew, so a cleaner
    // who finished online and then lost signal (or restarted) is not stranded.
    const memo = readGateMemo({ jobId: job?.id || null, userId, templateId: checklistId });
    return memo ? { state: memo.state, done: memo.done, total: memo.total } : live;
  }, [checklistId, rules, results, queued, userId, job?.id]);

  // Remember a verdict we reached from real data (never an UNKNOWN, never a downgrade).
  useEffect(() => {
    if (!checklistId || !userId || !job?.id) return;
    if (gate.state !== GATE.DONE && gate.state !== GATE.BLOCKED) return;
    writeGateMemo({ jobId: job.id, userId, templateId: checklistId }, gate);
  }, [gate, checklistId, userId, job?.id]);

  return { gate, checklistId, loading, online, reload };
}
