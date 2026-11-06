// THE HISTORY A DUE MESSAGE NEEDS CONFIRMED (the reminders cron, api/reminders/run.js).
//
// A walker (src/lib/reminderScheduler.js) sees the shared record and the jobs window (−7 … +45
// days); some rules need more than that. An item carries a `check`, and this module answers it
// from the database, so a message the history rules out is never sent:
//   firstClean   { clientId, jobId, startAt, when: 'first' | 'notFirst' }
//                is this the customer's FIRST finished clean? (no finished clean of theirs starts
//                before it). The check-in goes on the first; the visit summary, when the check-in
//                is on, on every other.
//   firstSeries  { clientId, seriesId, before?, when: 'first' | 'notFirst' }
//                is this the customer's first recurring schedule? (no other series of theirs
//                exists — with `before`, none that started before it). The service-setup email
//                and the upsell go on the first; a booking confirmation on every other.
//   noPunch      { jobId } — nobody clocked in to the clean (a voided or no-show punch counts
//                for no one): the missed-visit apology.
// Each answer is asked of the WINDOW first (an earlier finished clean of theirs in the last week
// already answers "not first") and of the database only when the window cannot tell, at most
// MAX_CHECK_QUERIES_PER_RUN times a run: the rest wait for the next run (their window is two
// days, a run five minutes). A read that fails leaves the item undecided (not sent this run),
// never decided — no history is not "first".
//
// → { go: [items whose check passed or that carry none], skip: [items the history rules out:
//     recorded 'skipped' so the question is never asked again], wait: [undecided] }
import { getSupabase } from '../supabase.js';
import { CLEANSPACE_ORG_ID } from '../constants.js';
import { punchedUserIdsByJob } from '../time/store.js';
import { JOB_STATUS, LEGACY_DONE_ALIAS, isCompletedJobStatus } from '../../../src/lib/jobStatus.js';

const ORG = process.env.CLEANSPACE_ORG_ID || CLEANSPACE_ORG_ID;
export const MAX_CHECK_QUERIES_PER_RUN = 60;
const DONE_STATUSES = [JOB_STATUS.DONE, LEGACY_DONE_ALIAS];

const at = (v) => { const t = Date.parse(v ?? ''); return Number.isFinite(t) ? t : NaN; };

// Did any finished clean of `clientId` start before `startAt`? true / false, or null (unread).
async function finishedBefore(clientId, startAt) {
  const { data, error } = await getSupabase().from('jobs').select('id')
    .eq('organization_id', ORG).eq('client_id', clientId)
    .in('status', DONE_STATUSES).lt('start_at', startAt)
    .order('start_at', { ascending: true }).order('id', { ascending: true })
    .range(0, 0);
  if (error) return null;
  return (data || []).length > 0;
}
// Does `clientId` have a series other than `seriesId` (one with a visit before `before`, when
// given)? true / false, or null.
async function otherSeries(clientId, seriesId, before = null) {
  let q = getSupabase().from('jobs').select('id, series_id')
    .eq('organization_id', ORG).eq('client_id', clientId)
    .not('series_id', 'is', null).neq('series_id', seriesId);
  if (before) q = q.lt('start_at', before);
  const { data, error } = await q
    .order('id', { ascending: true })
    .range(0, 0);
  if (error) return null;
  return (data || []).length > 0;
}

export async function resolveChecks(items, { jobs = [] } = {}, { maxQueries = MAX_CHECK_QUERIES_PER_RUN } = {}) {
  const go = [];
  const skip = [];
  const wait = [];
  let queries = 0;
  const cache = new Map();
  const ask = async (k, fn) => {
    if (cache.has(k)) return cache.get(k);
    if (queries >= maxQueries) return undefined;
    queries += 1;
    let v = null;
    try { v = await fn(); } catch { v = null; }
    cache.set(k, v);
    return v;
  };

  // From the window first.
  const finishedByClient = new Map();
  const seriesByClient = new Map();
  for (const j of jobs) {
    if (!j?.clientId) continue;
    if (isCompletedJobStatus(j.status)) {
      if (!finishedByClient.has(j.clientId)) finishedByClient.set(j.clientId, []);
      finishedByClient.get(j.clientId).push(at(j.startAt));
    }
    if (j.seriesId) {
      if (!seriesByClient.has(j.clientId)) seriesByClient.set(j.clientId, new Set());
      seriesByClient.get(j.clientId).add(j.seriesId);
    }
  }

  // The punches, in one batch for every noPunch item.
  const punchJobs = items.filter((d) => d.check?.kind === 'noPunch').map((d) => d.check.jobId);
  let punched = null;
  if (punchJobs.length) {
    try { punched = await punchedUserIdsByJob(punchJobs); } catch { punched = null; }
  }

  for (const d of items) {
    const c = d.check;
    if (!c) { go.push(d); continue; }
    let answer;   // true = the check passes, false = ruled out, undefined/null = undecided
    if (c.kind === 'firstClean') {
      const start = at(c.startAt);
      let first;
      if ((finishedByClient.get(c.clientId) || []).some((t) => t < start)) first = false;
      else first = await ask(`fc|${c.clientId}|${c.startAt}`, async () => { const b = await finishedBefore(c.clientId, c.startAt); return b == null ? null : !b; });
      answer = first == null ? first : (c.when === 'first' ? first : !first);
    } else if (c.kind === 'firstSeries') {
      let first;
      const startsBefore = (sid) => !c.before || jobs.some((j) => j.seriesId === sid && j.clientId === c.clientId && at(j.startAt) < at(c.before));
      if ([...(seriesByClient.get(c.clientId) || [])].some((sid) => sid !== c.seriesId && startsBefore(sid))) first = false;
      else first = await ask(`fs|${c.clientId}|${c.seriesId}|${c.before || ''}`, async () => { const o = await otherSeries(c.clientId, c.seriesId, c.before || null); return o == null ? null : !o; });
      answer = first == null ? first : (c.when === 'first' ? first : !first);
    } else if (c.kind === 'noPunch') {
      answer = punched ? !((punched.get(c.jobId)?.size || 0) > 0) : null;
    } else {
      answer = null;   // an unknown check is never a pass
    }
    if (answer === true) go.push(d);
    else if (answer === false) skip.push(d);
    else wait.push(d);
  }
  return { go, skip, wait, queries };
}
