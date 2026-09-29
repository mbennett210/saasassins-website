// The duplicate-schedule machine, pinned (2026-07-30 incident: Holistique ×5,
// Molded ×3, Harnish GMC ×8 identical series).
//
// adoptRemote replays every recorded action after ANY peer's blob write lands
// inside the save window. Creates minted ids INSIDE the reducer, so each
// replay minted a whole new series past the (org, series_id, start_at) unique
// index. The law now: ids arrive ON the action (dispatch-time mint) and every
// replayed apply is a NO-OP — pinned here by dispatching the same action
// object twice and asserting byte-stable state.
//
// Also pins: the far-future fix (a never-series STARTING beyond the 90-day
// horizon materializes its first quarter instead of exactly one row), and the
// absolute-target series move (a replayed move no-ops instead of double-
// shifting — the "it was set up correctly, then it moved" report).
//
// Offline: pure reducer. Run: node scripts/test-replay-idempotence.mjs
//
// reducer.js uses Vite-style extensionless relative imports, so this suite
// registers a resolve hook (append .js on ERR_MODULE_NOT_FOUND) before
// importing it — same trick raw Node needs for any store-module import.
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s,c,n){try{return await n(s,c)}catch(e){if(e&&e.code==="ERR_MODULE_NOT_FOUND"&&(s.startsWith("./")||s.startsWith("../")))return n(s+".js",c);throw e}}',
  import.meta.url,
);
import assert from 'node:assert/strict';
const { reducer, ACTIONS } = await import('../src/store/reducer.js');
const { dayKey, addDaysKey } = await import('../src/lib/dates.js');

let pass = 0;
const ok = (label, fn) => { fn(); pass += 1; console.log(`  ✓ ${label}`); };

const baseState = {
  jobs: [], users: [], sites: [], clients: [], notifications: [],
  permissions: {}, userPermissionOverrides: {},
};
const DAY = 86400000;
const at = (days, h = 18) => new Date(Date.UTC(2026, 7, 1 + days, h, 0, 0)).toISOString();

// ── ADD_JOB replay is a no-op ────────────────────────────────────────────────
ok('ADD_JOB with a dispatch-minted id applies once', () => {
  const action = { type: ACTIONS.ADD_JOB, job: { id: 'j_fixed1', clientId: 'c1', siteId: 's1', startAt: at(3), endAt: at(3, 20) } };
  const once = reducer(baseState, action);
  const twice = reducer(once, action);
  assert.equal(once.jobs.length, 1);
  assert.equal(twice, once); // same reference — true no-op
});

// ── ADD_JOB_SERIES replay is a no-op ─────────────────────────────────────────
ok('ADD_JOB_SERIES with a dispatch-minted seriesId applies once', () => {
  const action = {
    type: ACTIONS.ADD_JOB_SERIES, seriesId: 'ser_fixed1',
    baseJob: { clientId: 'c1', siteId: 's1', startAt: at(2), endAt: at(2, 20) },
    recurrence: { frequency: 'weekly', daysOfWeek: [1, 3], endType: 'never' },
  };
  const once = reducer(baseState, action);
  const twice = reducer(once, action);
  assert.ok(once.jobs.length > 4, `expected a materialized series, got ${once.jobs.length}`);
  assert.equal(twice, once);
  assert.equal(new Set(once.jobs.map((j) => j.seriesId)).size, 1);
});

// ── far-future never-series materializes its first quarter ───────────────────
ok('a never-series starting beyond the 90d horizon still materializes ~13 weeks', () => {
  const start = new Date(Date.now() + 120 * DAY);
  start.setUTCHours(18, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 3600000);
  const action = {
    type: ACTIONS.ADD_JOB_SERIES, seriesId: 'ser_far1',
    baseJob: { clientId: 'c1', siteId: 's1', startAt: start.toISOString(), endAt: end.toISOString() },
    recurrence: { frequency: 'weekly', daysOfWeek: [new Date(start).getUTCDay()], endType: 'never' },
  };
  const next = reducer(baseState, action);
  // Pre-fix this was exactly 1 row (the master). Now: master + ~12-13 weekly children.
  assert.ok(next.jobs.length >= 10, `far-future series materialized only ${next.jobs.length} row(s)`);
});

// ── series move: absolute target, replay no-ops ──────────────────────────────
ok('UPDATE_JOB_SERIES targetDayKey moves once; the replay is a whole-action no-op', () => {
  const seed = reducer(baseState, {
    type: ACTIONS.ADD_JOB_SERIES, seriesId: 'ser_mv1',
    baseJob: { clientId: 'c1', siteId: 's1', startAt: at(1), endAt: at(1, 20) },
    recurrence: { frequency: 'daily', endType: 'count', endCount: 5 },
  });
  const anchor = seed.jobs.filter((j) => j.seriesId === 'ser_mv1').sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
  const target = addDaysKey(dayKey(anchor.startAt), 2);
  const move = { type: ACTIONS.UPDATE_JOB_SERIES, seriesId: 'ser_mv1', fromDate: anchor.startAt, patch: {}, targetDayKey: target };
  const moved = reducer(seed, move);
  const movedDays = moved.jobs.filter((j) => j.seriesId === 'ser_mv1').map((j) => dayKey(j.startAt)).sort();
  const replayed = reducer(moved, move);
  assert.equal(replayed, moved); // anchor no longer on fromDate's day → no-op
  const replayedDays = replayed.jobs.filter((j) => j.seriesId === 'ser_mv1').map((j) => dayKey(j.startAt)).sort();
  assert.deepEqual(replayedDays, movedDays); // NOT shifted twice
  assert.equal(movedDays[0], target); // and the first move landed where asked
});

// ── legacy queued actions (no ids / relative shift) still work once ──────────
ok('legacy ADD_JOB_SERIES without seriesId still creates (reducer mints)', () => {
  const next = reducer(baseState, {
    type: ACTIONS.ADD_JOB_SERIES,
    baseJob: { clientId: 'c1', siteId: 's1', startAt: at(1), endAt: at(1, 20) },
    recurrence: { frequency: 'daily', endType: 'count', endCount: 3 },
  });
  assert.ok(next.jobs.length >= 3);
});

// ── ADD_CLIENT_REVIEW_NOTE replay is a no-op (CS-402: caller-minted noteId + reducer dedupe) ──
ok('ADD_CLIENT_REVIEW_NOTE with a dispatch-minted noteId appends once', () => {
  const action = { type: ACTIONS.ADD_CLIENT_REVIEW_NOTE, kind: 'drafts', id: 'quote-email', text: 'looks good', noteId: 'note_fixed1' };
  const once = reducer(baseState, action);
  const twice = reducer(once, action);
  assert.equal(once.clientReview.drafts['quote-email'].notes.length, 1);
  assert.equal(twice, once); // same reference — the replay after an adopt is a true no-op
});

console.log(`\nreplay idempotence: ${pass} passed`);
