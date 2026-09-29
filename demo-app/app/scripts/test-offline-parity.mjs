// Offline-parity pure logic (crew offline-parity, 2026-08-04). Two dependency-free
// pieces power the "keys / job status / complaints behave like clock + checklists
// offline" work:
//   1. offlineCopy.savedMsg — pick the normal confirmation online, the "saved, will
//      sync" reassurance offline. Only an explicit `false` swaps the copy (fail-safe).
//   2. mediaQueue — the ~50MB device buffer cap for offline photo/video, and the
//      device-stamped idempotency id that dedupes a replayed upload.
//
//   node scripts/test-offline-parity.mjs
import { savedMsg, SAVED_OFFLINE } from '../src/lib/offlineCopy.js';
import { OFFLINE_CAP, newMediaId } from '../src/lib/mediaQueue.js';

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass += 1; else { fail += 1; console.error(`✖ ${n}`); } };

// ── savedMsg: message selection ───────────────────────────────────────────────
ok('online=false → offline reassurance', savedMsg(false, 'Checked out') === SAVED_OFFLINE);
ok('online=true → normal message', savedMsg(true, 'Checked out') === 'Checked out');
// Fail-safe: an unknown/absent flag must NOT mis-report offline (never cry wolf).
ok('online=undefined → normal message', savedMsg(undefined, 'Checked out') === 'Checked out');
ok('online=null → normal message', savedMsg(null, 'Checked out') === 'Checked out');
ok('reassurance mentions this device', /this device/i.test(SAVED_OFFLINE));
ok('reassurance mentions syncing when back online', /back online/i.test(SAVED_OFFLINE));

// ── mediaQueue: offline buffer cap ────────────────────────────────────────────
// The cap bounds what a phone will stash for replay: images (≤10MB) and short job
// videos fit; a full 200MB clip is warned + left in the camera roll. Mirrors the
// buffer-vs-warn branch in accountMediaApi.uploadMedia.
const MB = 1024 * 1024;
ok('cap is 50MB', OFFLINE_CAP === 50 * MB);
ok('10MB image buffers offline', 10 * MB <= OFFLINE_CAP);
ok('49MB video buffers offline', 49 * MB <= OFFLINE_CAP);
ok('51MB video warns (over cap)', 51 * MB > OFFLINE_CAP);
ok('200MB video warns (over cap)', 200 * MB > OFFLINE_CAP);

// ── mediaQueue: idempotency id ────────────────────────────────────────────────
// The device stamps this id; confirmUpload dedupes the account_media row on it, so a
// replay or a partial-then-retry can't double-post a shot. Must be unique + prefixed.
const a = newMediaId(); const b = newMediaId();
ok('media id is md_-prefixed', /^md_/.test(a));
ok('media ids are unique', a !== b);

console.log(`\n${pass}/${pass + fail} offline-parity cases green`);
process.exit(fail ? 1 : 0);
