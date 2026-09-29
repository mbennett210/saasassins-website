// CS-007's media twin. The account-media offline queue (crew before/after photos and
// video) drained with exactly the same bug as the checklist queue: `flushMediaQueue`
// deleted a buffered upload on ANY non-transport error, so one 500, 429 or 403 destroyed
// a crew member's photos — and the media half had no test at all. Both queues now run the
// ONE shared drain loop (lib/offlineRetry.drainQueue), so they can never drift again.
//
// Also pinned here, because the fix depends on it: accountMediaApi's api() must attach
// err.status. It did not (qcApi has done since eaf39fc), so the media drain had nothing
// to classify a failure by.
//
//   node app/scripts/test-media-offline.mjs
import { readFileSync } from 'node:fs';
import { drainQueue, classifyQueueFailure, QUEUE_STOP_STATUSES, QUEUE_MAX_ATTEMPTS, RETRY_BASE_MS } from '../src/lib/offlineRetry.js';

let pass = 0;
const fails = [];
const ok = (n, c, d = '') => { if (c) pass += 1; else fails.push(d ? `${n} — ${d}` : n); };
const eq = (n, got, want) => ok(n, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const httpErr = (status) => Object.assign(new Error(`Request failed (${status})`), { status });
// A buffered upload: the File itself plus the meta the replay needs.
const shot = (id, p = {}) => ({
  id,
  file: { name: `${id}.jpg`, type: 'image/jpeg', size: 1024 },
  meta: { siteId: 's1', clientId: 'c1', scope: 'clean', refId: 'j1', mimeType: 'image/jpeg', sizeBytes: 1024 },
  createdAt: '2026-09-27T12:00:00.000Z',
  ...p,
});
function rig({ fail = () => null } = {}) {
  const removed = []; const marked = []; const sent = [];
  return {
    removed, marked, sent,
    send: async (it) => { sent.push(it.id); const e = fail(it); if (e) throw e; },
    remove: async (id) => { removed.push(id); return true; },
    mark: async (id, patch) => { marked.push({ id, patch }); return true; },
  };
}

// ── a clean reconnect uploads everything ────────────────────────────────────
let r = rig();
let out = await drainQueue([shot('m1'), shot('m2')], { ...r, online: true });
eq('media: a clean pass uploads both', out.flushed, 2);
eq('media: and clears them off the device', r.removed.join(','), 'm1,m2');

// ── the regression: a transient failure KEEPS the photo ─────────────────────
for (const s of [500, 502, 503, 429, 408, 401, 403]) {
  r = rig({ fail: () => httpErr(s) });
  out = await drainQueue([shot('m1')], { ...r, online: true });
  eq(`media: a ${s} KEEPS the photo (CS-007)`, r.removed.length, 0);
  eq(`media: the ${s} is deferred, not failed`, out.deferred, 1);
  ok(`media: the ${s} does not mark the photo failed`, r.marked[0]?.patch?.failed !== true);
}
r = rig({ fail: () => httpErr(500) });
await drainQueue([shot('m1')], { ...r, online: true, now: () => 1000, random: () => 1 });
eq('media: a transient failure arms a backoff', r.marked[0]?.patch?.nextAttemptAt, new Date(1000 + RETRY_BASE_MS).toISOString());
eq('media: …and counts the attempt', r.marked[0]?.patch?.attempts, 1);

// A Storage error (uploadToSignedUrl) carries no HTTP status: never a silent drop.
r = rig({ fail: () => new Error('The resource was not found') });
await drainQueue([shot('m1')], { ...r, online: true });
eq('media: a status-less Storage error KEEPS the photo', r.removed.length, 0);

// ── only a definitive validation 4xx stops the retries, and it stays visible ─
for (const s of [400, 404, 422]) {
  ok(`media: ${s} is a stop status`, QUEUE_STOP_STATUSES.has(s));
  r = rig({ fail: () => httpErr(s) });
  out = await drainQueue([shot('m1')], { ...r, online: true });
  eq(`media: ${s} stops the retries`, out.stopped, 1);
  eq(`media: ${s} does NOT delete the photo`, r.removed.length, 0);
  eq(`media: ${s} marks it failed for Retry / Discard`, r.marked[0]?.patch?.failed, true);
}
eq('media: a transport failure stops the pass', classifyQueueFailure(new TypeError('Failed to fetch'), { online: true }), 'offline');

// ── the same retry ceiling, so a photo that always 500s is eventually SHOWN ──
r = rig({ fail: () => httpErr(503) });
out = await drainQueue([shot('m1', { attempts: QUEUE_MAX_ATTEMPTS })], { ...r, online: true });
eq('media: at the ceiling a transient becomes terminal', out.stopped, 1);
eq('media: …the photo is still not deleted', r.removed.length, 0);
eq('media: …it shows with Retry / Discard', r.marked[0]?.patch?.failed, true);
r = rig({ fail: () => httpErr(503) });
out = await drainQueue([shot('m1', { attempts: QUEUE_MAX_ATTEMPTS - 1 })], { ...r, online: true });
eq('media: one attempt short of the ceiling only defers', out.deferred, 1);

// ── the wiring the fix depends on ───────────────────────────────────────────
const apiSrc = readFileSync(new URL('../src/lib/accountMediaApi.js', import.meta.url), 'utf8');
ok('accountMediaApi.api() attaches err.status (the drain has nothing to classify by without it)',
  /err\.status\s*=\s*res\.status/.test(apiSrc));
ok('flushMediaQueue runs the shared drain, not its own loop', /drainQueue\(/.test(apiSrc));
ok('the old unconditional drop is gone', !/dropping un-syncable upload/.test(apiSrc));
const queueSrc = readFileSync(new URL('../src/lib/mediaQueue.js', import.meta.url), 'utf8');
ok('mediaQueue can record a failure on an item (updateMedia)', /export async function updateMedia\b/.test(queueSrc));

for (const f of fails) console.error(`✖ ${f}`);
console.log(`\n${pass}/${pass + fails.length} media-offline cases green`);
process.exit(fails.length ? 1 : 0);
